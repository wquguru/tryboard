//! Classic ESP32 I2S0 / I2S1 (M5-12): own register map, one CLKM, lldesc DMA inside the block (no GDMA); shares only I2sIo.
//! PDM RX is modelled at PCM level (decimated 16-bit samples, no 1-bit stream); see docs/ARCH.md, classic ESP32 SoC section.

use crate::CPU_HZ;
use tryboard_soc::devices::audio::{self, PortIo};
use tryboard_soc::i2s::I2sIo;
use tryboard_soc::Mem as DmaMem;

pub const BASE: [u32; 2] = [0x3FF4_F000, 0x3FF6_D000];
/// Interrupt sources ETS_I2S0_INTR_SOURCE / ETS_I2S1_INTR_SOURCE
pub const SRC: [u32; 2] = [32, 33];
/// GPIO matrix: I2SnO_DATA_OUT23 (serial data out) and I2SnI_DATA_IN15 (serial / PDM data in)
pub const SIG_DATA_OUT: [usize; 2] = [163, 189];
pub const SIG_DATA_IN: [usize; 2] = [155, 181];

mod reg {
    pub const CONF: u32 = 0x08;
    pub const INT_RAW: u32 = 0x0c;
    pub const INT_ST: u32 = 0x10;
    pub const INT_ENA: u32 = 0x14;
    pub const INT_CLR: u32 = 0x18;
    pub const FIFO_CONF: u32 = 0x20;
    pub const RX_EOF_NUM: u32 = 0x24;
    pub const CONF_SINGLE: u32 = 0x28;
    pub const CONF_CHAN: u32 = 0x2c;
    pub const OUT_LINK: u32 = 0x30;
    pub const IN_LINK: u32 = 0x34;
    pub const OUT_EOF_DES: u32 = 0x38;
    pub const IN_EOF_DES: u32 = 0x3c;
    pub const LC_CONF: u32 = 0x60;
    pub const CLKM: u32 = 0xac;
    pub const SRATE: u32 = 0xb0;
    pub const PDM_CONF: u32 = 0xb4;
}

mod int {
    pub const IN_DONE: u32 = 1 << 8;
    pub const IN_SUC_EOF: u32 = 1 << 9;
    pub const OUT_DONE: u32 = 1 << 11;
    pub const OUT_EOF: u32 = 1 << 12;
    pub const IN_DSCR_EMPTY: u32 = 1 << 15;
    pub const OUT_TOTAL_EOF: u32 = 1 << 16;
}

// CONF bits
const TX_RESET: u32 = 1 << 0;
const RX_RESET: u32 = 1 << 1;
const TX_START: u32 = 1 << 4;
const RX_START: u32 = 1 << 5;
const TX_SLAVE: u32 = 1 << 6;
const RX_SLAVE: u32 = 1 << 7;
const RX_MSB_SHIFT: u32 = 1 << 11;
const TX_MSB_RIGHT: u32 = 1 << 16;
const RX_MSB_RIGHT: u32 = 1 << 17;
// OUT_LINK / IN_LINK bits
const LINK_STOP: u32 = 1 << 28;
const LINK_START: u32 = 1 << 29;
const LINK_RESTART: u32 = 1 << 30;
// PDM_CONF bits
const TX_PDM_EN: u32 = 1 << 0;
const RX_PDM_EN: u32 = 1 << 1;
const RX_DSR16: u32 = 1 << 24;
/// Source clock without APLL (I2S_CLK_SRC_PLL_160M)
const SRC_HZ: f64 = 160_000_000.0;

/// Offsets the model gives meaning to; the rest only read back (counted as unimpl by the bus)
pub fn modelled(off: u32) -> bool {
    matches!(off, 0x08..=0x3c | 0x60 | 0xa0..=0xbc | 0xfc)
}

#[derive(Clone, Copy, Debug)]
struct Chunk {
    desc: u32,
    t0: u64,
    frames: usize,
    bytes: usize,
    eof: bool,
}

#[derive(Default, Clone, Debug)]
pub struct Dir {
    /// Link started (OUT_LINK / IN_LINK start, not yet stopped)
    linked: bool,
    /// Current descriptor (0 = chain ended)
    desc: u32,
    /// Next processing time in cycles (fractional so long runs don't drift)
    next: f64,
    cur: Option<Chunk>,
    /// RX: bytes since the last EOF
    eof_count: usize,
    pub frames: u64,
    pub chunks: u64,
    /// Times the direction idled for 1 ms because clock / mode / chain was unusable
    pub stalls: u64,
}

pub struct I2s {
    regs: [u32; 0x100 / 4],
    pub tx: Dir,
    pub rx: Dir,
    pub port: usize,
}

/// lldesc addresses are 20-bit offsets into the 0x3FF00000 window (DMA-capable internal SRAM)
fn phys(a: u32) -> u32 {
    if a & 0xf_ffff == 0 {
        0
    } else {
        0x3FF0_0000 | (a & 0xf_ffff)
    }
}

impl I2s {
    /// Reset values from i2s_reg.h field defaults
    pub fn new(port: usize) -> I2s {
        let mut regs = [0u32; 0x100 / 4];
        let mut set = |o: u32, v: u32| regs[(o / 4) as usize] = v;
        set(reg::CONF, 0x3_0300);
        set(reg::FIFO_CONF, 0x1820);
        set(reg::RX_EOF_NUM, 64);
        set(reg::LC_CONF, 0x100);
        set(0xa0, 0x89);
        set(0xa4, 0x2);
        set(reg::CLKM, 4);
        set(reg::SRATE, 16 << 18 | 16 << 12 | 6 << 6 | 6);
        set(reg::PDM_CONF, 0x0155_0020);
        set(0xb8, 960 << 10 | 480);
        set(0xbc, 0x7);
        set(0xfc, 0x0160_4201);
        I2s {
            regs,
            tx: Dir::default(),
            rx: Dir::default(),
            port,
        }
    }

    fn r(&self, off: u32) -> u32 {
        self.regs[(off / 4) as usize]
    }

    pub fn read(&self, off: u32) -> u32 {
        match off {
            reg::INT_ST => self.r(reg::INT_RAW) & self.r(reg::INT_ENA),
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        let Some(slot) = self.regs.get_mut((off / 4) as usize) else {
            return;
        };
        let old = *slot;
        *slot = v;
        match off {
            reg::INT_RAW | reg::INT_ST => self.regs[(off / 4) as usize] = old,
            reg::INT_CLR => {
                self.regs[(reg::INT_RAW / 4) as usize] &= !v;
                self.regs[(reg::INT_CLR / 4) as usize] = 0;
            }
            reg::CONF => {
                if v & TX_RESET != 0 {
                    self.tx.cur = None;
                }
                if v & RX_RESET != 0 {
                    self.rx.cur = None;
                    self.rx.eof_count = 0;
                }
                if v & TX_START != 0 && old & TX_START == 0 {
                    self.tx.next = self.tx.next.max(now as f64);
                }
                if v & RX_START != 0 && old & RX_START == 0 {
                    self.rx.next = self.rx.next.max(now as f64);
                }
            }
            reg::LC_CONF => {
                // in_rst / out_rst: drop the DMA state machine
                if v & 1 != 0 {
                    self.rx = Dir {
                        next: self.rx.next,
                        ..Dir::default()
                    };
                }
                if v & 2 != 0 {
                    self.tx = Dir {
                        next: self.tx.next,
                        ..Dir::default()
                    };
                }
            }
            reg::OUT_LINK | reg::IN_LINK => {
                let d = if off == reg::OUT_LINK {
                    &mut self.tx
                } else {
                    &mut self.rx
                };
                if v & LINK_STOP != 0 {
                    d.linked = false;
                    d.cur = None;
                }
                if v & LINK_START != 0 {
                    d.linked = true;
                    d.desc = phys(v);
                    d.cur = None;
                    d.eof_count = 0;
                    d.next = d.next.max(now as f64);
                }
                if v & LINK_RESTART != 0 && d.desc == 0 {
                    d.desc = phys(v);
                }
                // Start / stop / restart are self-clearing pulses
                self.regs[(off / 4) as usize] = v & 0xf_ffff;
            }
            _ => {}
        }
    }

    pub fn irq(&self) -> bool {
        self.r(reg::INT_RAW) & self.r(reg::INT_ENA) != 0
    }

    fn raise(&mut self, bits: u32) {
        self.regs[(reg::INT_RAW / 4) as usize] |= bits;
    }

    pub fn running(&self, tx: bool) -> bool {
        if tx {
            self.tx.linked && self.r(reg::CONF) & TX_START != 0
        } else {
            self.rx.linked && self.r(reg::CONF) & RX_START != 0
        }
    }

    pub fn pdm_rx(&self) -> bool {
        self.r(reg::PDM_CONF) & RX_PDM_EN != 0
    }

    /// Sample rate from CLKM (N + b/a of the 160 MHz PLL), the BCK divider and the slot width (PDM: 64x OSR, 128x for DSR16)
    pub fn rate(&self, tx: bool) -> f64 {
        let c = self.r(reg::CLKM);
        if c & (1 << 21) != 0 {
            return 0.0; // APLL source is not modelled
        }
        let (n, b, a) = (c & 0xff, (c >> 8) & 0x3f, (c >> 14) & 0x3f);
        let mdiv = n as f64 + if a != 0 { b as f64 / a as f64 } else { 0.0 };
        let s = self.r(reg::SRATE);
        let (bck, bits) = if tx {
            (s & 0x3f, (s >> 12) & 0x3f)
        } else {
            ((s >> 6) & 0x3f, (s >> 18) & 0x3f)
        };
        if mdiv < 2.0 || bck == 0 || bits == 0 {
            return 0.0;
        }
        let bclk = SRC_HZ / mdiv / bck as f64;
        if !tx && self.pdm_rx() {
            let osr = if self.r(reg::PDM_CONF) & RX_DSR16 != 0 {
                128.0
            } else {
                64.0
            };
            bclk / osr
        } else {
            bclk / (2 * bits) as f64
        }
    }

    /// (16-bit samples, mono) from tx_fifo_mod / rx_fifo_mod: 0 = 16 dual, 1 = 16 mono, 2 = 32 dual, 3 = 32 mono
    fn mode(&self, tx: bool) -> (bool, bool) {
        let f = self.r(reg::FIFO_CONF);
        let m = if tx { (f >> 13) & 7 } else { (f >> 16) & 7 };
        (m < 2, m & 1 != 0 && m < 4)
    }

    fn frame_bytes(&self, tx: bool) -> usize {
        match self.mode(tx) {
            (true, true) => 2,
            (true, false) | (false, true) => 4,
            (false, false) => 8,
        }
    }

    fn usable(&self, tx: bool, rate: f64) -> bool {
        let c = self.r(reg::CONF);
        let p = self.r(reg::PDM_CONF);
        let blocked = if tx {
            c & TX_SLAVE != 0 || p & TX_PDM_EN != 0
        } else {
            c & RX_SLAVE != 0 || (p & RX_PDM_EN != 0 && self.port != 0)
        };
        !blocked && rate > 1.0
    }

    /// Advance to `now`; returns when processing is next needed
    pub fn update(&mut self, now: u64, mem: &mut dyn DmaMem, io: &mut dyn I2sIo) -> u64 {
        let mut next = u64::MAX;
        if self.running(true) {
            next = next.min(self.update_tx(now, mem, io));
        }
        if self.running(false) {
            next = next.min(self.update_rx(now, mem, io));
        }
        next
    }

    fn stall(d: &mut Dir, now: u64) {
        d.stalls += 1;
        d.next = d.next.max(now as f64) + CPU_HZ as f64 / 1000.0;
    }

    fn update_tx(&mut self, now: u64, mem: &mut dyn DmaMem, io: &mut dyn I2sIo) -> u64 {
        let rate = self.rate(true);
        let fb = self.frame_bytes(true);
        let mut guard = 0;
        while self.tx.next <= now as f64 && guard < 64 {
            guard += 1;
            if let Some(c) = self.tx.cur.take() {
                let mut bits = int::OUT_DONE;
                if c.eof {
                    bits |= int::OUT_EOF;
                    self.regs[(reg::OUT_EOF_DES / 4) as usize] = c.desc;
                }
                self.tx.desc = phys(mem.rd32(c.desc + 8));
                if self.tx.desc == 0 {
                    bits |= int::OUT_TOTAL_EOF;
                }
                self.raise(bits);
            }
            if !self.usable(true, rate) || self.tx.desc == 0 {
                Self::stall(&mut self.tx, now);
                break;
            }
            let d = self.tx.desc;
            let w0 = mem.rd32(d);
            let buf = mem.rd32(d + 4);
            let len = ((w0 >> 12) & 0xfff) as usize;
            let data: Vec<u8> = (0..len as u32).map(|i| mem.rd8(buf + i)).collect();
            let frames = self.decode_tx(&data);
            let t0 = self.tx.next as u64;
            if !frames.is_empty() {
                io.tx(t0, rate, &frames);
            }
            self.tx.frames += frames.len() as u64;
            self.tx.chunks += 1;
            self.tx.cur = Some(Chunk {
                desc: d,
                t0,
                frames: frames.len(),
                bytes: len,
                eof: w0 & (1 << 30) != 0,
            });
            // An empty descriptor still takes one frame, so an all-empty ring doesn't spin in place
            self.tx.next += (len / fb).max(1) as f64 * CPU_HZ as f64 / rate;
        }
        self.tx.next.ceil() as u64
    }

    fn update_rx(&mut self, now: u64, mem: &mut dyn DmaMem, io: &mut dyn I2sIo) -> u64 {
        let rate = self.rate(false);
        let fb = self.frame_bytes(false);
        let mut guard = 0;
        while self.rx.next <= now as f64 && guard < 64 {
            guard += 1;
            if let Some(c) = self.rx.cur.take() {
                let slots = io.rx(c.t0, rate, c.frames);
                let data = self.encode_rx(&slots);
                let buf = mem.rd32(c.desc + 4);
                for (i, b) in data.iter().take(c.bytes).enumerate() {
                    mem.wr8(buf + i as u32, *b);
                }
                // Write back length / EOF and hand the descriptor to the CPU (owner = 0)
                let w0 = mem.rd32(c.desc);
                let w0 = (w0 & 0xfff) | (c.bytes as u32) << 12 | (c.eof as u32) << 30;
                mem.wr32(c.desc, w0);
                let mut bits = int::IN_DONE;
                if c.eof {
                    bits |= int::IN_SUC_EOF;
                    self.regs[(reg::IN_EOF_DES / 4) as usize] = c.desc;
                }
                self.rx.desc = phys(mem.rd32(c.desc + 8));
                if self.rx.desc == 0 {
                    bits |= int::IN_DSCR_EMPTY;
                }
                self.raise(bits);
                self.rx.frames += c.frames as u64;
                self.rx.chunks += 1;
            }
            if !self.usable(false, rate) || self.rx.desc == 0 {
                Self::stall(&mut self.rx, now);
                self.rx.eof_count = 0;
                break;
            }
            let d = self.rx.desc;
            let size = (mem.rd32(d) & 0xfff) as usize;
            let eof_bytes = ((self.r(reg::RX_EOF_NUM) & 0x3fffff) as usize * 4).max(fb);
            let room = size.min(eof_bytes - self.rx.eof_count.min(eof_bytes - fb));
            let n = room / fb;
            let bytes = n * fb;
            self.rx.eof_count += bytes;
            let eof = self.rx.eof_count >= eof_bytes;
            if eof {
                self.rx.eof_count = 0;
            }
            let t0 = self.rx.next as u64;
            self.rx.cur = Some(Chunk {
                desc: d,
                t0,
                frames: n,
                bytes,
                eof,
            });
            self.rx.next += n.max(1) as f64 * CPU_HZ as f64 / rate;
        }
        self.rx.next.ceil() as u64
    }

    /// FIFO words -> [left, right] slots, left-aligned i32. 16-bit: msb_right = 1 (IDF default) puts the lower
    /// halfword of each word on the left / first. Mono tx_chan_mod 3 / 4 sends CONF_SINGLE_DATA on the other slot
    fn decode_tx(&self, b: &[u8]) -> Vec<[i32; 2]> {
        let (b16, mono) = self.mode(true);
        let swap = self.r(reg::CONF) & TX_MSB_RIGHT == 0;
        let chan = self.r(reg::CONF_CHAN) & 7;
        let single = self.r(reg::CONF_SINGLE) as i32;
        let h = |i: usize| -> i32 {
            let i = if swap { i ^ 1 } else { i };
            match b.get(2 * i..2 * i + 2) {
                Some(x) => (i16::from_le_bytes([x[0], x[1]]) as i32) << 16,
                None => 0,
            }
        };
        let w = |i: usize| -> i32 {
            b.get(4 * i..4 * i + 4)
                .map_or(0, |x| i32::from_le_bytes([x[0], x[1], x[2], x[3]]))
        };
        let place = |s: i32| match chan {
            3 => [single, s],
            4 => [s, single],
            _ => [s, s],
        };
        match (b16, mono) {
            (true, false) => (0..b.len() / 4).map(|k| [h(2 * k), h(2 * k + 1)]).collect(),
            (true, true) => (0..b.len() / 2).map(|k| place(h(k))).collect(),
            (false, false) => (0..b.len() / 8).map(|k| [w(2 * k), w(2 * k + 1)]).collect(),
            (false, true) => (0..b.len() / 4).map(|k| place(w(k))).collect(),
        }
    }

    /// [left, right] slots -> FIFO bytes. PDM: rx_chan_mod 1 = right, 2 = left (I2S_PDM_SLOT_*), decimated PCM is 16-bit.
    /// Standard mono: the left slot is taken when (rx_chan_mod == 2) == msb_right (i2s_ll_rx_select_std_slot)
    fn encode_rx(&self, slots: &[[i32; 2]]) -> Vec<u8> {
        let (b16, mono) = self.mode(false);
        let conf = self.r(reg::CONF);
        let msb_right = conf & RX_MSB_RIGHT != 0;
        let chan = (self.r(reg::CONF_CHAN) >> 3) & 3;
        let pdm = self.pdm_rx();
        // Without msb_shift a Philips source arrives one BCK late: the MSB is lost into the previous slot
        let late = !pdm && conf & RX_MSB_SHIFT == 0;
        let adj = |v: i32| if late { v >> 1 } else { v };
        let left = if pdm {
            chan != 1
        } else {
            (chan == 2) == msb_right
        };
        let mut out = Vec::new();
        if b16 {
            let mut hw: Vec<u16> = Vec::new();
            for s in slots {
                let (l, r) = (adj(s[0]) >> 16, adj(s[1]) >> 16);
                if mono {
                    hw.push(if left { l } else { r } as u16);
                } else {
                    hw.push(l as u16);
                    hw.push(r as u16);
                }
            }
            // rx_msb_right = 0 swaps each FIFO halfword pair, PDM included (IDF's PDM / ADC paths clear it,
            // M5Unified un-swaps on classic ESP32; DECISIONS G-12)
            if !msb_right {
                for p in hw.chunks_mut(2) {
                    p.reverse();
                }
            }
            for x in hw {
                out.extend_from_slice(&x.to_le_bytes());
            }
        } else {
            for s in slots {
                let (l, r) = (adj(s[0]), adj(s[1]));
                if mono {
                    out.extend_from_slice(&if left { l } else { r }.to_le_bytes());
                } else {
                    out.extend_from_slice(&l.to_le_bytes());
                    out.extend_from_slice(&r.to_le_bytes());
                }
            }
        }
        out
    }

    /// Short status for the run report
    pub fn report(&self) -> Option<String> {
        if self.tx.chunks == 0 && self.rx.chunks == 0 && self.tx.stalls == 0 && self.rx.stalls == 0
        {
            return None;
        }
        Some(format!(
            "[tryboard] I2S{}: TX {} frames, RX {} frames{} (rate {:.1} / {:.1} Hz)\n",
            self.port,
            self.tx.frames,
            self.rx.frames,
            if self.pdm_rx() { " PDM->PCM" } else { "" },
            self.rate(true),
            self.rate(false)
        ))
    }
}

/// Default wiring (M5Stack Core2): NS4168-style amp BCLK 12 / LRCK 0 / DOUT 2; SPM1423 PDM mic CLK 0 / DATA 34 (also StickC Plus2)
pub mod pin {
    pub const SPK_BCLK: u32 = 12;
    pub const SPK_LRC: u32 = 0;
    pub const SPK_DIN: u32 = 2;
    pub const MIC_CLK: u32 = 0;
    pub const MIC_DATA: u32 = 34;
}

impl crate::SocBus {
    /// Advance port k: the GPIO matrix decides whether speaker DIN / mic data sit on this port's data lines
    pub(crate) fn i2s_update(&mut self, now: u64, k: usize) -> u64 {
        if !self.i2s[k].running(true) && !self.i2s[k].running(false) {
            return u64::MAX;
        }
        let speaker = self.audio.speaker.as_ref().is_some_and(|s| {
            self.gpio
                .func_out
                .get(s.pins.data as usize)
                .is_some_and(|f| (f & 0x1ff) as usize == SIG_DATA_OUT[k])
        });
        // FUNCn_IN_SEL_CFG: bits 5..0 pin, bit 7 routes through the matrix
        let f = self.gpio.func_in[SIG_DATA_IN[k]];
        let mic = self
            .audio
            .mic
            .as_ref()
            .is_some_and(|m| f & (1 << 7) != 0 && f & 0x3f == m.pins.data);
        let mut au = std::mem::take(&mut self.audio);
        let mut i2s = std::mem::replace(&mut self.i2s[k], I2s::new(k));
        let mut io = PortIo {
            audio: &mut au,
            speaker,
            mic,
        };
        let n = i2s.update(now, self, &mut io);
        self.i2s[k] = i2s;
        self.audio = au;
        n
    }

    pub fn attach_speaker(&mut self) {
        use pin::*;
        let p = audio::Pins {
            bclk: SPK_BCLK,
            ws: SPK_LRC,
            data: SPK_DIN,
        };
        self.audio.speaker = Some(Box::new(audio::Max98357a::new(p)));
    }

    pub fn attach_mic(&mut self) {
        use pin::*;
        let p = audio::Pins {
            bclk: MIC_CLK,
            ws: MIC_CLK,
            data: MIC_DATA,
        };
        let mut m = audio::Inmp441::new(p);
        m.pdm = true;
        self.audio.mic = Some(Box::new(m));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Ram(Vec<u8>);
    const RAM: u32 = 0x3FFB_0000;
    impl DmaMem for Ram {
        fn rd8(&mut self, a: u32) -> u8 {
            self.0[(a - RAM) as usize]
        }
        fn rd32(&mut self, a: u32) -> u32 {
            let i = (a - RAM) as usize;
            u32::from_le_bytes(self.0[i..i + 4].try_into().unwrap())
        }
        fn wr8(&mut self, a: u32, v: u8) {
            self.0[(a - RAM) as usize] = v;
        }
        fn wr32(&mut self, a: u32, v: u32) {
            let i = (a - RAM) as usize;
            self.0[i..i + 4].copy_from_slice(&v.to_le_bytes());
        }
    }

    #[derive(Default)]
    struct Probe {
        tx: Vec<[i32; 2]>,
        rx_n: usize,
    }
    impl I2sIo for Probe {
        fn tx(&mut self, _t: u64, _rate: f64, frames: &[[i32; 2]]) {
            self.tx.extend_from_slice(frames);
        }
        fn rx(&mut self, _t: u64, _rate: f64, n: usize) -> Vec<[i32; 2]> {
            self.rx_n += n;
            (0..n).map(|i| [(i as i32 + 1) << 16, -(1 << 16)]).collect()
        }
    }

    /// Two-descriptor ring of `bytes` each at RAM+0x100 / +0x110, buffers at +0x200 / +0x600
    fn ring(m: &mut Ram, bytes: u32) {
        for (k, (d, b)) in [(0x100u32, 0x200u32), (0x110, 0x600)].iter().enumerate() {
            let next = if k == 0 { RAM + 0x110 } else { RAM + 0x100 };
            m.wr32(RAM + d, 1 << 31 | 1 << 30 | bytes << 12 | bytes);
            m.wr32(RAM + d + 4, RAM + b);
            m.wr32(RAM + d + 8, next);
        }
    }

    /// IDF values for 44.1 kHz / 16-bit: mclk = 256 fs -> N = 14, b/a = 11/63; bck_div = 8
    fn clk_44k1(i: &mut I2s) {
        i.write(reg::CLKM, 14 | 11 << 8 | 63 << 14 | 1 << 20, 0);
        i.write(reg::SRATE, 16 << 18 | 16 << 12 | 8 << 6 | 8, 0);
    }

    #[test]
    fn rate_from_dividers() {
        let mut i = I2s::new(0);
        clk_44k1(&mut i);
        assert!((i.rate(true) - 44100.0).abs() < 10.0, "{}", i.rate(true));
        // PDM RX 16 kHz, DSR 8S: bclk = 64 fs, IDF bck_div = 8 -> mdiv = 160e6 / (16e3 * 64 * 8) = 19.53
        i.write(reg::PDM_CONF, 0x0055_0020 | RX_PDM_EN, 0);
        i.write(reg::CLKM, 19 | 17 << 8 | 32 << 14, 0);
        let r = i.rate(false);
        assert!((r - 16000.0).abs() < 2.0, "{r}");
    }

    #[test]
    fn tx_ring_plays_and_reports_eof() {
        let mut m = Ram(vec![0; 0x1000]);
        ring(&mut m, 400);
        for k in 0..200u32 {
            m.wr8(RAM + 0x200 + 2 * k, k as u8);
        }
        let mut i = I2s::new(0);
        clk_44k1(&mut i);
        i.write(reg::FIFO_CONF, 0x1820 | 1 << 13, 0); // 16-bit mono
        i.write(reg::CONF_CHAN, 1, 0);
        i.write(reg::INT_ENA, int::OUT_EOF, 0);
        i.write(reg::OUT_LINK, (RAM + 0x100) & 0xf_ffff | LINK_START, 0);
        i.write(reg::CONF, 0x3_0300 | TX_START, 0);
        let mut io = Probe::default();
        let mut now = 0;
        while now < CPU_HZ / 100 {
            now = i.update(now, &mut m, &mut io).max(now + 1);
        }
        // 10 ms at 44.1 kHz = 441 frames, descriptors of 200 frames each
        assert!(io.tx.len() >= 441 && io.tx.len() <= 800, "{}", io.tx.len());
        assert_eq!(io.tx[3], [3 << 16, 3 << 16]);
        assert!(i.irq());
        assert!([RAM + 0x100, RAM + 0x110].contains(&i.read(reg::OUT_EOF_DES)));
        assert_eq!(i.read(reg::OUT_LINK) & LINK_START, 0);
    }

    fn pdm_run(conf: u32) -> (Ram, I2s, Probe) {
        let mut m = Ram(vec![0; 0x1000]);
        ring(&mut m, 64);
        let mut i = I2s::new(0);
        i.write(reg::PDM_CONF, 0x0055_0020 | RX_PDM_EN, 0);
        i.write(reg::CLKM, 19 | 17 << 8 | 32 << 14, 0);
        i.write(reg::FIFO_CONF, 0x1820 | 1 << 16, 0); // 16-bit mono
        i.write(reg::CONF_CHAN, 2 << 3, 0); // I2S_PDM_SLOT_LEFT
        i.write(reg::RX_EOF_NUM, 16, 0);
        i.write(reg::INT_ENA, int::IN_SUC_EOF, 0);
        i.write(reg::IN_LINK, (RAM + 0x100) & 0xf_ffff | LINK_START, 0);
        i.write(reg::CONF, RX_START | conf, 0);
        let mut io = Probe::default();
        let mut now = 0;
        while now < CPU_HZ / 200 {
            now = i.update(now, &mut m, &mut io).max(now + 1);
        }
        (m, i, io)
    }

    #[test]
    fn pdm_rx_writes_mono_pcm_and_eof() {
        // IDF's PDM RX setup: rx_msb_right = 0, so samples 1, 2, 3, 4 (left slot) land as 2, 1, 4, 3
        let (mut m, i, io) = pdm_run(0);
        assert!(io.rx_n >= 64, "{}", io.rx_n);
        assert!(i.irq());
        // First descriptor: 32 samples, length 64, EOF, owner cleared
        assert_eq!(m.rd32(RAM + 0x100) >> 12, 1 << 18 | 64);
        let first: Vec<u8> = (0..4).map(|k| m.rd8(RAM + 0x200 + 2 * k)).collect();
        assert_eq!(first, [2, 1, 4, 3]);
        let (mut m, _, _) = pdm_run(RX_MSB_RIGHT);
        let first: Vec<u8> = (0..4).map(|k| m.rd8(RAM + 0x200 + 2 * k)).collect();
        assert_eq!(first, [1, 2, 3, 4]);
    }
}
