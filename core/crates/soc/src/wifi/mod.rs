//! Wi-Fi: behaviour model of the RF / baseband / MAC hardware (reverse-engineering notes in docs/WIFI.md). lint: allow-long-comment
//! The closed-source drivers (libpp / libnet80211) run unchanged; the simulator plays the MAC at the register + DMA
//! descriptor level, hands TX 802.11 frames to [`world::World`] (virtual AP), and writes its replies into RX descriptors
//! followed by a MAC interrupt.

pub mod crypto;
pub mod frame;
pub mod net;
pub mod netcond;
pub mod phone;
pub mod tcp;
pub mod world;
pub mod wpa;
pub mod ws;

use crate::Mem;
use std::collections::HashMap;

/// Register layout and clock per chip. C3 and S3 share the same Wi-Fi MAC IP (registers, descriptors, 12-word wifi_pkt_rx_ctrl_t);
/// they differ in the RF calibration poll addresses and the hardware RNG register (docs/WIFI.md "S3")
#[derive(Clone, Copy, Debug)]
pub struct WifiLayout {
    pub chip: &'static str,
    /// Simulated time base (CPU cycles / s)
    pub cpu_hz: u64,
    /// RF / baseband / MAC 'wait for hardware' polls: (address, how it becomes ready)
    pub rf_polls: &'static [(u32, RfReady)],
    pub mac: MacRegs,
}

/// How a polled register reports ready
#[derive(Clone, Copy, Debug)]
pub enum RfReady {
    /// Read back = last written value | mask
    Or(u32),
    /// Read back = last written | (last written >> 1 & 1): write bit 1 to start, wait for bit 0
    StartBit1Done0,
}

impl WifiLayout {
    pub const C3: WifiLayout = WifiLayout {
        chip: "esp32c3",
        cpu_hz: 160_000_000,
        rf_polls: &[
            // SAR / peak detect status: bits 26..24 == 7 means idle (polled by rom_pkdet_vol_start, rom1_read_sar2_code)
            (0x6000_e050, RfReady::Or(7 << 24)),
            // TX DC calibration comparator: bit 24 = conversion done (txdc_cal_v70 polls); bit 30 is the result, keep the written value
            (0x6000_e04c, RfReady::Or(1 << 24)),
            // FE: IQ estimation done (bit 16, polled by rom_iq_est_enable)
            (0x6000_6174, RfReady::Or(1 << 16)),
            // MAC: hal_init writes bit 1 then waits for bit 0
            (0x6003_3d14, RfReady::StartBit1Done0),
        ],
        mac: MacRegs::C3,
    };
    pub const S3: WifiLayout = WifiLayout {
        chip: "esp32s3",
        ..WifiLayout::C3
    };
    /// Classic ESP32: the MAC is the previous IP generation (registers around 0x3FF73000, see [`MacRegs::ESP32`])
    pub const ESP32: WifiLayout = WifiLayout {
        chip: "esp32",
        cpu_hz: 160_000_000,
        // RF calibration polls use the same PHY as C3: same peripheral offsets, APB base 0x3FF40000 (C3: 0x60000000)
        rf_polls: &[
            // 0x3FF4E050 omitted: ESP32's ram_get_fm_sar_dout waits for bits 26..24 == 0 (opposite of C3), so plain read-back works
            (0x3ff4_e04c, RfReady::Or(1 << 24)),
            // FE: IQ estimation done is bit 31 (polled by ram_iq_est_enable; C3 uses 0x6174 bit 16)
            (0x3ff4_607c, RfReady::Or(1 << 31)),
            // ESP32 only: set_chan_freq_sw_start sets bit 8 to start the PLL retune, waits for bit 31
            (0x3ff4_e0c4, RfReady::Or(1 << 31)),
            // MAC: hal_init writes bit 1, waits for bit 0 (C3 at +0xD14, ESP32 at +0xD24)
            (0x3ff7_3d24, RfReady::StartBit1Done0),
        ],
        mac: MacRegs::ESP32,
    };
}

/// MAC register map (see docs/WIFI.md). C3 / S3 share one IP generation; classic ESP32 is the previous one:
/// same HAL functions, descriptors and TX result codes, but different offsets and a 7-word RX header
#[derive(Clone, Copy, Debug)]
pub struct MacRegs {
    /// MAC / power-management address range this module handles
    pub range: (u32, u32),
    pub int_ena: u32,
    pub int_st: u32,
    pub int_clr: u32,
    pub rx_first: u32,
    /// RX control: bit 0 = reload the descriptor chain, self-clearing (ESP32 driver polls it; C3 doesn't, 0)
    pub rx_ctrl: u32,
    /// Read: last filled descriptor; `rx_last_full` = full address (ESP32), else low 20 bits only (C3)
    pub rx_last: u32,
    pub rx_last_full: bool,
    /// Read: next descriptor the hardware will fill (ESP32 driver reads it when recycling; C3 doesn't, 0)
    pub rx_next: u32,
    pub txq_done: u32,
    pub txq_done_clr: u32,
    /// TX queue q config register = txq0 - 8q; bits 19..0 descriptor address low 20 bits, bits 31/30 start
    pub txq0: u32,
    /// TX result = txq_result0 - stride*q: bits 15..12 result code (0 ok, 5 ACK timeout)
    pub txq_result0: u32,
    pub txq_result_stride: u32,
    /// Status registers that always read 0 (TX status, power-management interrupt status)
    pub zero: [u32; 2],
    /// TSF timer (us) low / high 32 bits
    pub tsf_lo: u32,
    pub tsf_hi: u32,
    /// Descriptor address registers keep only the low 20 bits; high bits are fixed (C3 / S3 DRAM 0x3FCxxxxx, ESP32 0x3FFxxxxx)
    pub desc_hi: u32,
    /// RX interrupt event bit (wDev_ProcessFiq mask)
    pub ev_rx: u32,
    /// HW key table (hal_crypto_set_key_entry): valid bitmap + 40 bytes/entry
    pub key_valid: u32,
    pub key_table: u32,
    /// RX metadata header length in words; words holding noise floor (low byte) and length (bits 11..0)
    pub rx_hdr_words: u32,
    pub rx_noise_word: usize,
    pub rx_len_word: usize,
    /// How much the header RSSI exceeds real dBm: ESP32's wDev_ProcessRxSucData subtracts wDevCtrl+46
    /// (96 at run time) before reporting; C3 doesn't
    pub rx_rssi_bias: i32,
}

impl MacRegs {
    pub const C3: MacRegs = MacRegs {
        range: (0x6003_3000, 0x6003_6000),
        int_ena: 0x6003_3c34,
        int_st: 0x6003_3c3c,
        int_clr: 0x6003_3c40,
        rx_first: 0x6003_3088,
        rx_ctrl: 0,
        rx_last: 0x6003_3090,
        rx_last_full: false,
        rx_next: 0,
        txq_done: 0x6003_3cb0,
        txq_done_clr: 0x6003_3cac,
        txq0: 0x6003_3d08,
        txq_result0: 0x6003_4320,
        txq_result_stride: 76,
        zero: [0x6003_3ca8, 0x6003_5118],
        tsf_lo: 0x6003_5018,
        tsf_hi: 0x6003_501c,
        desc_hi: 0x3fc0_0000,
        ev_rx: 1 << 14,
        key_valid: 0x6003_3814,
        key_table: 0x6003_4400,
        rx_hdr_words: 12,
        rx_noise_word: 5,
        rx_len_word: 11,
        rx_rssi_bias: 0,
    };
    /// Classic ESP32 (derived from libpp / libnet80211 disassembly, see docs/WIFI.md)
    pub const ESP32: MacRegs = MacRegs {
        range: (0x3ff7_3000, 0x3ff7_6000),
        int_ena: 0x3ff7_3c40,
        int_st: 0x3ff7_3c48,
        int_clr: 0x3ff7_3c4c,
        rx_first: 0x3ff7_3088,
        rx_ctrl: 0x3ff7_3084,
        rx_last: 0x3ff7_3090,
        rx_last_full: true,
        rx_next: 0x3ff7_308c,
        txq_done: 0x3ff7_3cc8,
        txq_done_clr: 0x3ff7_3cc4,
        txq0: 0x3ff7_3d20,
        txq_result0: 0x3ff7_4270,
        txq_result_stride: 60,
        zero: [0x3ff7_3cc0, 0x3ff7_3cc0],
        tsf_lo: 0x3ff7_5014,
        tsf_hi: 0x3ff7_5018,
        desc_hi: 0x3ff0_0000,
        // In RX mask 0x1000024, bit 24 is "frame received" (bits 2 / 5 are overflow)
        ev_rx: 1 << 24,
        key_valid: 0x3ff7_3814,
        key_table: 0x3ff7_4400,
        rx_hdr_words: 7,
        rx_noise_word: 2,
        rx_len_word: 6,
        rx_rssi_bias: 96,
    };

    pub fn contains(&self, a: u32) -> bool {
        (self.range.0..self.range.1).contains(&a)
    }
}

/// C3 / S3 MAC address range (for bus dispatch)
pub const MAC_RANGE: std::ops::Range<u32> = MacRegs::C3.range.0..MacRegs::C3.range.1;
const TXQ_NUM: u32 = 5;

// MAC interrupt event bits (wDev_ProcessFiq); TX-done is the same in both generations
const EV_TX_DONE: u32 = 1 << 7;

/// Each HW key entry: word 0 = peer MAC 0..3, word 1 low 16 = MAC 4..5, bit 30 = group, word 2.. = key.
/// Other word-1 fields (cipher, slot class) are unused: IDF was observed to put the GTK in slot 0, the PTK in slot 4, both with peer = BSSID
const KEY_GROUP: u32 = 1 << 30;
const KEY_ENTRY: u32 = 40;
const KEY_SLOTS: u32 = 32;

enum Ev {
    TxDone { q: usize, code: u32 },
    Rx(world::Air),
}

pub struct WifiMac {
    pub layout: WifiLayout,
    pub int_raw: u32,
    pub int_ena: u32,
    tx_done: u32,
    tx_result: [u32; TXQ_NUM as usize],
    /// Next RX descriptor to fill; None until configured
    rx_cur: Option<u32>,
    /// Last filled descriptor (continue from its next when the chain ran out)
    rx_last: u32,
    events: Vec<(u64, Ev)>,
    next_beacon: u64,
    /// Copy of the key table registers (valid bitmap + slots); writes also go to the generic register table
    keys: HashMap<u32, u32>,
    pub world: world::World,
    /// Air log for the CLI / web
    pub log: Vec<String>,
    pub rx_dropped: u64,
    pub tx_frames: u64,
    pub rx_frames: u64,
}

impl Default for WifiMac {
    fn default() -> Self {
        WifiMac::new(WifiLayout::C3)
    }
}

/// Data frame with the Protected bit set
fn is_protected_data(f: &[u8]) -> bool {
    f.len() >= 24 && f[0] & 0x0c == 0x08 && f[1] & 0x40 != 0
}

fn read_bytes(mem: &mut dyn Mem, a: u32, n: u32) -> Vec<u8> {
    (0..n).map(|i| mem.rd8(a + i)).collect()
}

impl WifiMac {
    pub fn new(layout: WifiLayout) -> Self {
        WifiMac {
            layout,
            int_raw: 0,
            int_ena: 0,
            tx_done: 0,
            tx_result: [0; TXQ_NUM as usize],
            rx_cur: None,
            rx_last: 0,
            events: Vec::new(),
            next_beacon: 0,
            keys: HashMap::new(),
            world: world::World::default(),
            log: Vec::new(),
            rx_dropped: 0,
            tx_frames: 0,
            rx_frames: 0,
        }
    }

    /// RF is up once the driver has handed the MAC its RX descriptors (esp_wifi_start); it then owns the ADC2 arbiter
    pub fn is_on(&self) -> bool {
        self.rx_cur.is_some()
    }

    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }

    fn schedule(&mut self, at: u64, ev: Ev) {
        self.events.push((at, ev));
    }

    fn us_to_cycles(&self, us: u64) -> u64 {
        us * (self.layout.cpu_hz / 1_000_000)
    }

    fn tsf_us(&self, now: u64) -> u64 {
        now / (self.layout.cpu_hz / 1_000_000)
    }

    fn ms(&self, now: u64) -> f64 {
        now as f64 / (self.layout.cpu_hz / 1000) as f64
    }

    /// Read of RF-related registers: Some means this module supplies the value (stored = last value written there)
    pub fn rf_read(&self, a: u32, stored: u32) -> Option<u32> {
        let (_, r) = self.layout.rf_polls.iter().find(|(x, _)| *x == a)?;
        Some(match *r {
            RfReady::Or(m) => stored | m,
            RfReady::StartBit1Done0 => stored | ((stored >> 1) & 1),
        })
    }

    /// MAC register read; None falls back to generic read-back
    pub fn read(&mut self, a: u32, now: u64) -> Option<u32> {
        let m = self.layout.mac;
        let res = |a: u32| {
            a <= m.txq_result0
                && (m.txq_result0 - a).is_multiple_of(m.txq_result_stride)
                && (m.txq_result0 - a) / m.txq_result_stride < TXQ_NUM
        };
        Some(match a {
            a if a == m.int_st => self.int_raw & self.int_ena,
            a if a == m.int_ena => self.int_ena,
            a if a == m.txq_done => self.tx_done,
            a if m.zero.contains(&a) => 0,
            a if a == m.rx_last => {
                if m.rx_last_full {
                    self.rx_last
                } else {
                    self.rx_last & 0xf_ffff
                }
            }
            // End of chain reads 0x3FF00000 (high bits | null); the driver uses it to decide whether to reset the head
            a if m.rx_next != 0 && a == m.rx_next => {
                m.desc_hi | (self.rx_cur.unwrap_or(0) & 0xf_ffff)
            }
            a if res(a) => self.tx_result[((m.txq_result0 - a) / m.txq_result_stride) as usize],
            a if a == m.tsf_lo => self.tsf_us(now) as u32,
            a if a == m.tsf_hi => (self.tsf_us(now) >> 32) as u32,
            _ => return None,
        })
    }

    /// MAC register write. Some(v) tells the caller to store v in the generic register table for read-back; None = handled, don't store
    pub fn write(&mut self, a: u32, v: u32, now: u64, mem: &mut dyn Mem) -> Option<u32> {
        let m = self.layout.mac;
        match a {
            a if a == m.int_ena => self.int_ena = v,
            a if a == m.int_clr => self.int_raw &= !v,
            a if a == m.txq_done_clr => self.tx_done &= !v,
            a if a == m.rx_first => {
                self.rx_cur = Some(v);
                return Some(v);
            }
            // Reload: rx() already follows the last descriptor's next at end of chain, so just clear bit 0
            a if m.rx_ctrl != 0 && a == m.rx_ctrl => return Some(v & !1),
            a if a == m.key_valid
                || (m.key_table..m.key_table + KEY_ENTRY * KEY_SLOTS).contains(&a) =>
            {
                self.keys.insert(a, v);
                return Some(v);
            }
            a if a <= m.txq0 && (m.txq0 - a).is_multiple_of(8) && (m.txq0 - a) / 8 < TXQ_NUM => {
                let q = ((m.txq0 - a) / 8) as usize;
                if v & 0x8000_0000 != 0 {
                    self.tx(q, v, now, mem);
                    // Hardware clears the start bit when TX ends; clear it now, the driver doesn't read it back
                    return Some(v & !0xc000_0000);
                }
                return Some(v);
            }
            _ => return Some(v),
        }
        None
    }

    /// TX queue start: walk the descriptor chain for the whole frame, hand it to the world, schedule TX done and replies by airtime
    fn tx(&mut self, q: usize, reg: u32, now: u64, mem: &mut dyn Mem) {
        let mut d = self.layout.mac.desc_hi | (reg & 0xf_ffff);
        let mut f = Vec::new();
        for _ in 0..16 {
            let w0 = mem.rd32(d);
            let buf = mem.rd32(d + 4);
            let len = (w0 >> 12) & 0xfff;
            f.extend(read_bytes(mem, buf, len));
            let next = mem.rd32(d + 8);
            if w0 & (1 << 30) != 0 || next == 0 {
                break;
            }
            d = next;
        }
        // Descriptor length includes the 4-byte FCS (hardware-generated) that the frame content lacks
        f.truncate(f.len().saturating_sub(4));
        if is_protected_data(&f) {
            // The driver already wrote the CCMP header (with PN) and left 8 bytes for the MIC; hardware does the encryption
            match self.hw_ccmp(&f, true) {
                Some(e) => f = e,
                None => self.push_log("    (protected frame without a key, sent as is)".into()),
            }
        }
        let tsf = self.tsf_us(now);
        let (desc, replies, acked) = self.world.on_tx(&f, tsf);
        let unicast = f.len() >= 10 && f[4] & 1 == 0;
        let code = if unicast && !acked { 5 } else { 0 };
        // Airtime at 1 Mbps (basic rate for management frames) plus preamble and SIFS/ACK
        let air = 192 + f.len() as u64 * 8 + if unicast { 50 } else { 0 };
        let at = now + self.us_to_cycles(air);
        self.schedule(at, Ev::TxDone { q, code });
        for r in replies {
            let at = now + self.us_to_cycles(air + r.delay_us);
            self.schedule(at, Ev::Rx(r));
        }
        self.tx_frames += 1;
        let line = format!("{:>9.3}ms TX q{q} {}B {}", self.ms(now), f.len(), desc);
        self.push_log(line);
    }

    fn push_log(&mut self, s: String) {
        if self.log.len() < 10_000 {
            self.log.push(s);
        }
    }

    /// Write a frame into the next free RX descriptor: metadata header (C3 48 bytes / ESP32 28 bytes) + frame + FCS
    fn rx(&mut self, air: world::Air, now: u64, mem: &mut dyn Mem) {
        let mut d = match self.rx_cur {
            Some(d) if d != 0 => d,
            _ => {
                // End of chain: check whether the driver linked a new descriptor after the last one
                let next = if self.rx_last != 0 {
                    mem.rd32(self.rx_last + 8)
                } else {
                    0
                };
                if next == 0 {
                    self.rx_dropped += 1;
                    return;
                }
                next
            }
        };
        let w0 = mem.rd32(d);
        if w0 & (1 << 31) == 0 {
            // Not owned by hardware: the driver hasn't recycled it, so drop (real hardware also drops on buffer shortage)
            self.rx_dropped += 1;
            return;
        }
        let size = w0 & 0xfff;
        let mut f = air.frame.clone();
        if is_protected_data(&f) {
            // Hardware decrypts via the key table: keeps the CCMP header, MIC slot and Protected bit (ccmp_decap strips them)
            match self.hw_ccmp(&f, false) {
                Some(p) => f = p,
                None => {
                    self.rx_dropped += 1;
                    self.push_log("    (protected frame failed to decrypt, dropped)".into());
                    return;
                }
            }
        }
        let fcs = frame::crc32(&f);
        f.extend_from_slice(&fcs.to_le_bytes());
        let m = self.layout.mac;
        let hdr_len = 4 * m.rx_hdr_words;
        let total = hdr_len + f.len() as u32;
        if total > size {
            self.rx_dropped += 1;
            return;
        }
        let buf = mem.rd32(d + 4);
        let mut hdr = [0u32; 12];
        // RSSI and matched interface: bit 28 = interface 0 (STA), bit 29 = interface 1 (firmware SoftAP)
        let iface = if air.ap_if { 1 << 29 } else { 1 << 28 };
        hdr[0] = ((air.rssi as i32 + m.rx_rssi_bias) as u8 as u32) | iface;
        hdr[2] = (air.channel as u32 & 0xf) << 16;
        hdr[3] = self.tsf_us(now) as u32;
        hdr[m.rx_noise_word] |= (-96i8) as u8 as u32; // Noise floor
        hdr[m.rx_len_word] |= f.len() as u32 & 0xfff; // sig_len (incl. FCS), rx_state = 0
        for (i, w) in hdr[..m.rx_hdr_words as usize].iter().enumerate() {
            mem.wr32(buf + 4 * i as u32, *w);
        }
        for (i, b) in f.iter().enumerate() {
            mem.wr8(buf + hdr_len + i as u32, *b);
        }
        // Length, EOF, ownership back to software
        let w0n = (w0 & 0xfff) | (total << 12) | (1 << 30);
        mem.wr32(d, w0n);
        self.rx_last = d;
        d = mem.rd32(d + 8);
        self.rx_cur = Some(d);
        self.int_raw |= m.ev_rx;
        self.rx_frames += 1;
        let desc = match frame::parse(&air.frame) {
            Some(h) => format!("FC=0x{:02x} from {}", h.fc0, frame::mac_str(&h.a2)),
            None => "?".into(),
        };
        let line = format!(
            "{:>9.3}ms RX {}B ch{} {}dBm {}",
            self.ms(now),
            air.frame.len(),
            air.channel,
            air.rssi,
            desc
        );
        self.push_log(line);
    }

    /// Find the pairwise (group = false) or group key for the peer MAC in the HW key table
    fn hw_key(&self, peer: &frame::Mac, group: bool) -> Option<[u8; 16]> {
        self.hw_key_exact(Some(peer), group)
    }

    /// peer = None: any group-key slot (as an AP the firmware's GTK slot peer MAC need not match the frame)
    fn hw_key_exact(&self, peer: Option<&frame::Mac>, group: bool) -> Option<[u8; 16]> {
        let reg = |a: u32| self.keys.get(&a).copied().unwrap_or(0);
        let valid = reg(self.layout.mac.key_valid);
        (0..KEY_SLOTS)
            .filter(|i| valid & (1 << i) != 0)
            .find_map(|i| {
                let e = self.layout.mac.key_table + KEY_ENTRY * i;
                let (w0, w1) = (reg(e), reg(e + 4));
                let mut mac = [0u8; 6];
                mac[..4].copy_from_slice(&w0.to_le_bytes());
                mac[4..].copy_from_slice(&(w1 as u16).to_le_bytes());
                if peer.is_some_and(|p| mac != *p) || (w1 & KEY_GROUP != 0) != group {
                    return None;
                }
                let mut key = [0u8; 16];
                for j in 0..4 {
                    key[4 * j as usize..4 * j as usize + 4]
                        .copy_from_slice(&reg(e + 8 + 4 * j).to_le_bytes());
                }
                Some(key)
            })
    }

    /// Hardware CCMP: enc = TX (plaintext + reserved MIC -> ciphertext), else RX (ciphertext -> plaintext, header / trailer kept)
    fn hw_ccmp(&self, f: &[u8], enc: bool) -> Option<Vec<u8>> {
        let hl = frame::parse(f)?.body;
        if f.len() < hl + 16 {
            return None;
        }
        let key_id = f[hl + 3] >> 6;
        let unicast = f[4] & 1 == 0;
        // Unicast: TX uses the receiver's (a1) pairwise key, RX the sender's (a2); multicast can only use the group key
        // Infallible: f.len() >= hl + 16 and hl >= 10, so 4..16 is in range.
        let peer: frame::Mac = if enc {
            f[4..10].try_into().unwrap()
        } else {
            f[10..16].try_into().unwrap()
        };
        let tk = if unicast {
            self.hw_key(&peer, false)?
        } else {
            // Multicast: look up by peer (BSSID as STA), then by sender, finally any group-key slot
            // Infallible: f.len() >= hl + 16 >= 26 (checked above).
            let a2: frame::Mac = f[10..16].try_into().unwrap();
            self.hw_key(&peer, true)
                .or_else(|| self.hw_key(&a2, true))
                .or_else(|| self.hw_key_exact(None, true))?
        };
        let h = &f[hl..hl + 8];
        let pn = u64::from_le_bytes([h[0], h[1], h[4], h[5], h[6], h[7], 0, 0]);
        if enc {
            let mut plain = f[..hl].to_vec();
            plain[1] &= !0x40;
            plain.extend_from_slice(&f[hl + 8..f.len() - 8]);
            Some(crypto::ccmp_encrypt(&tk, &plain, pn, key_id))
        } else {
            let (p, _) = crypto::ccmp_decrypt(&tk, f)?;
            let mut out = f[..hl + 8].to_vec();
            out.extend_from_slice(&p[hl..]);
            out.extend_from_slice(&f[f.len() - 8..]);
            Some(out)
        }
    }

    /// Advance Wi-Fi events; returns the next event time
    pub fn update(&mut self, now: u64, mem: &mut dyn Mem) -> u64 {
        let beacon = self.us_to_cycles(102_400);
        // Associated: the AP sends a beacon every 102.4 ms
        if let Some(i) = self.world.associated() {
            if self.next_beacon == 0 {
                self.next_beacon = now + beacon;
            }
            while now >= self.next_beacon {
                let tsf = self.tsf_us(now);
                let b = self.world.beacon(i, tsf);
                let at = self.next_beacon;
                self.schedule(at, Ev::Rx(b));
                self.next_beacon += beacon;
            }
        } else {
            self.next_beacon = 0;
        }
        // Virtual AP's own timers (WPA2 4-way handshake retransmit / timeout)
        let tsf = self.tsf_us(now);
        if self.world.next_timer().is_some_and(|t| t <= tsf) {
            let (airs, notes) = self.world.poll(tsf);
            for a in airs {
                let at = now + self.us_to_cycles(a.delay_us);
                self.schedule(at, Ev::Rx(a));
            }
            for n in notes {
                let line = format!("{:>9.3}ms AP {}", self.ms(now), n);
                self.push_log(line);
            }
        }
        let timer = self
            .world
            .next_timer()
            .map_or(u64::MAX, |t| self.us_to_cycles(t));
        if self.events.is_empty() {
            return if self.next_beacon != 0 {
                self.next_beacon.min(timer)
            } else {
                timer
            };
        }
        let mut due = Vec::new();
        let mut i = 0;
        while i < self.events.len() {
            if self.events[i].0 <= now {
                due.push(self.events.swap_remove(i));
            } else {
                i += 1;
            }
        }
        due.sort_by_key(|e| e.0);
        for (_, ev) in due {
            match ev {
                Ev::TxDone { q, code } => {
                    self.tx_result[q] = code << 12;
                    self.tx_done |= 1 << q;
                    self.int_raw |= EV_TX_DONE;
                }
                Ev::Rx(air) => self.rx(air, now, mem),
            }
        }
        let mut next = self.events.iter().map(|e| e.0).min().unwrap_or(u64::MAX);
        if self.next_beacon != 0 {
            next = next.min(self.next_beacon);
        }
        next.min(timer)
    }
}

#[cfg(test)]
mod tests;
