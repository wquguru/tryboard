//! I2S (S3 I2S0 / I2S1, C3 I2S0; identical layout; soc/esp32s3 i2s_reg.h, hal i2s_ll.h / i2s_hal.c, esp_driver_i2s/i2s_common.c). Master-mode TDM / standard
//! only (Philips, MSB, PCM short frame all as "N slots per frame") plus RX PDM2PCM at PCM level, no bit timing; data via GDMA only (as IDF i2s_std does). TX: after tx_start, take
//! descriptor blocks at the sample rate; taken at the block's first frame time (real FIFO is tiny), OUT_DONE when played (+OUT_EOF on suc_eof), so
//! i2s_channel_write is paced by playback as on silicon. RX: after rx_start, record RXEOF_NUM-byte blocks (<= descriptor size) at their due time; IN_SUC_EOF
//! per RXEOF_NUM bytes. Slots are 32-bit MSB-aligned "slot words" internally; TX samples shift up to 32 bits, RX takes the top data_bits. (lint: allow-long-comment)

use crate::gdma::{DmaMem, Gdma};
use crate::periph::CPU_HZ;

pub mod reg {
    pub const INT_RAW: u32 = 0x0c;
    pub const INT_ST: u32 = 0x10;
    pub const INT_ENA: u32 = 0x14;
    pub const INT_CLR: u32 = 0x18;
    pub const RX_CONF: u32 = 0x20;
    pub const TX_CONF: u32 = 0x24;
    pub const RX_CONF1: u32 = 0x28;
    pub const TX_CONF1: u32 = 0x2c;
    pub const RX_CLKM_CONF: u32 = 0x30;
    pub const TX_CLKM_CONF: u32 = 0x34;
    pub const RX_CLKM_DIV: u32 = 0x38;
    pub const TX_CLKM_DIV: u32 = 0x3c;
    pub const RX_TDM_CTRL: u32 = 0x50;
    pub const TX_TDM_CTRL: u32 = 0x54;
    pub const RXEOF_NUM: u32 = 0x64;
    pub const STATE: u32 = 0x6c;
    pub const DATE: u32 = 0x80;
}

/// RX_CONF / TX_CONF bits
const RESET: u32 = 1 << 0;
const START: u32 = 1 << 2;
const SLAVE: u32 = 1 << 3;
const MONO: u32 = 1 << 5;
const UPDATE: u32 = 1 << 8;
const MSB_SHIFT: u32 = 1 << 29;
const FILL24: u32 = 1 << 16;
const TDM_EN: u32 = 1 << 19;
const PDM_EN: u32 = 1 << 20;
const SKIP_MSK: u32 = 1 << 20;
/// RX_CONF PDM bits (S3 I2S0, M5-08): PDM-to-PCM filter on, and 128x instead of 64x down-sampling
const RX_PDM2PCM: u32 = 1 << 21;
const RX_PDM_DSR16: u32 = 1 << 22;

/// INT_RAW bits
pub mod int {
    pub const RX_DONE: u32 = 1 << 0;
    pub const TX_DONE: u32 = 1 << 1;
}

/// External devices (the SoC decides from pin wiring which ones sit on this I2S port)
pub trait I2sIo {
    /// TX: frames from cycle t at rate frames per second, each frame's slot words
    fn tx(&mut self, t: u64, rate: f64, frames: &[[i32; 2]]);
    /// RX: n frames from cycle t at rate per second; returns left/right slot words (0 when nothing drives the data line)
    fn rx(&mut self, t: u64, rate: f64, n: usize) -> Vec<[i32; 2]>;
}

/// Data format of one direction (derived from registers)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Format {
    /// Frame rate (= sample rate, Hz); 0 = clock not configured
    pub rate: f64,
    pub data_bits: u32,
    pub slot_bits: u32,
    pub slots: u32,
    /// Enabled slots (bit = slot number)
    pub mask: u32,
    pub mono: bool,
    /// TX: memory also holds data for disabled slots (tx_tdm_skip_msk_en)
    pub skip: bool,
    /// First bit delayed one BCK (Philips); RX with it off and a Philips device reads off by one bit
    pub msb_shift: bool,
    pub bytes: usize,
}

impl Format {
    /// Samples per frame in memory
    pub fn mem_samples(&self) -> usize {
        if self.mono {
            1
        } else if self.skip {
            self.slots as usize
        } else {
            (self.mask & ((1 << self.slots) - 1)).count_ones().max(1) as usize
        }
    }
    pub fn frame_bytes(&self) -> usize {
        self.mem_samples() * self.bytes
    }
    pub fn frame_cycles(&self) -> f64 {
        CPU_HZ as f64 / self.rate
    }
}

/// Block being processed (TX: playing; RX: recording)
#[derive(Clone, Copy, Debug)]
struct Chunk {
    ch: usize,
    desc: u32,
    eof: bool,
    last: bool,
    frames: usize,
    t0: u64,
}

#[derive(Default, Clone, Debug)]
pub struct Stream {
    pub running: bool,
    /// Next processing time (cycles, fractional to avoid drift over long runs)
    pub next: f64,
    cur: Option<Chunk>,
    /// Total frames / blocks
    pub frames: u64,
    pub chunks: u64,
    /// RX: bytes recorded since the last EOF
    eof_count: usize,
    /// Times we idled because the channel wasn't ready
    pub stalls: u64,
}

pub struct I2s {
    pub regs: [u32; 0x84 / 4],
    pub int_raw: u32,
    pub int_ena: u32,
    pub tx: Stream,
    pub rx: Stream,
    /// Number used by the GPIO matrix / GDMA
    pub port: u8,
}

impl I2s {
    /// Reset values from the field defaults in i2s_reg.h (S3 and C3 differ only in TX_CONF1 tx_bck_no_dly and DATE)
    pub fn new(port: u8, s3: bool) -> I2s {
        let mut regs = [0u32; 0x84 / 4];
        let mut set = |o: u32, v: u32| regs[(o / 4) as usize] = v;
        set(reg::RX_CONF, 0x9600);
        set(reg::TX_CONF, 0xb200);
        set(reg::RX_CONF1, 0x2f3d_e300);
        set(reg::TX_CONF1, if s3 { 0x6f3d_e300 } else { 0x2f3d_e300 });
        set(reg::RX_CLKM_CONF, 0x2);
        set(reg::TX_CLKM_CONF, 0x2);
        set(reg::RX_CLKM_DIV, 0x200);
        set(reg::TX_CLKM_DIV, 0x200);
        set(0x40, 0x004a_a004);
        set(0x44, 0x03f7_83c0);
        set(reg::RX_TDM_CTRL, 0xffff);
        set(reg::TX_TDM_CTRL, 0xffff);
        set(0x60, 0x810);
        set(reg::RXEOF_NUM, 0x40);
        set(reg::DATE, if s3 { 0x0200_9070 } else { 0x0200_3230 });
        I2s {
            regs,
            int_raw: 0,
            int_ena: 0,
            tx: Stream::default(),
            rx: Stream::default(),
            port,
        }
    }

    fn r(&self, off: u32) -> u32 {
        self.regs[(off / 4) as usize]
    }

    pub fn read(&self, off: u32) -> u32 {
        match off {
            reg::INT_RAW => self.int_raw,
            reg::INT_ST => self.int_raw & self.int_ena,
            reg::INT_ENA => self.int_ena,
            reg::INT_CLR => 0,
            // tx_idle
            reg::STATE => !self.tx.running as u32,
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    /// Write a register. now schedules the first processing time of a just-started direction
    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        match off {
            reg::INT_ENA => self.int_ena = v,
            reg::INT_CLR => self.int_raw &= !v,
            reg::INT_RAW | reg::INT_ST | reg::STATE => {}
            reg::TX_CONF | reg::RX_CONF => {
                let old = self.r(off);

                // update (sync config to the I2S clock domain) completes instantly and reads back 0
                self.regs[(off / 4) as usize] = v & !UPDATE;
                let s = if off == reg::TX_CONF {
                    &mut self.tx
                } else {
                    &mut self.rx
                };
                if v & RESET != 0 {
                    s.running = false;
                    s.cur = None;
                    s.eof_count = 0;
                }
                if v & START != 0 && old & START == 0 {
                    s.running = true;
                    s.cur = None;
                    s.eof_count = 0;
                    s.next = now as f64;
                } else if v & START == 0 {
                    s.running = false;
                    s.cur = None;
                }
            }
            _ => {
                if let Some(r) = self.regs.get_mut((off / 4) as usize) {
                    *r = v;
                }
            }
        }
    }

    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }

    /// Frame rate: MCLK = source / (N + b/a), BCK = MCLK / bck_div, rate = BCK / (bits per slot x slots)
    fn rate(&self, tx: bool) -> f64 {
        let (clkm, div, conf1, tdm) = if tx {
            (
                reg::TX_CLKM_CONF,
                reg::TX_CLKM_DIV,
                reg::TX_CONF1,
                reg::TX_TDM_CTRL,
            )
        } else {
            (
                reg::RX_CLKM_CONF,
                reg::RX_CLKM_DIV,
                reg::RX_CONF1,
                reg::RX_TDM_CTRL,
            )
        };
        let c = self.r(clkm);
        // clk_active (bit 26); clk_sel (bits 27..28): 0 XTAL 40MHz, 1 PLL_D2 240MHz (M5Unified picks it), 2 PLL_F160M,
        // 3 external MCLK (unsupported)
        if c & (1 << 26) == 0 {
            return 0.0;
        }
        let src = match (c >> 27) & 3 {
            0 => 40e6,
            1 => 240e6,
            2 => 160e6,
            _ => return 0.0,
        };
        let n = (c & 0xff) as f64;
        let d = self.r(div);
        let (z, y, x, yn1) = (
            d & 0x1ff,
            (d >> 9) & 0x1ff,
            (d >> 18) & 0x1ff,
            (d >> 27) & 1,
        );
        // Inverse of i2s_ll_tx_set_mclk: denominator = z(x+1)+y, numerator = yn1 ? denominator-z : z
        let frac = if z == 0 {
            0.0
        } else {
            let den = (z * (x + 1) + y) as f64;
            let num = if yn1 != 0 { den - z as f64 } else { z as f64 };
            num / den
        };
        let div_total = if n == 0.0 { 256.0 } else { n + frac };
        let conf1 = self.r(conf1);
        let bck_div = ((conf1 >> 7) & 0x3f) as f64 + 1.0;
        let chan_bits = ((conf1 >> 24) & 0x1f) as f64 + 1.0;
        let slots = ((self.r(tdm) >> 16) & 0xf) as f64 + 1.0;
        if let Some(osr) = self.pdm_rx_osr(tx) {
            return src / div_total / bck_div / osr;
        }
        src / div_total / bck_div / (chan_bits * slots)
    }

    /// PDM RX at PCM level (M5-08): the PDM clock is BCK and one PCM frame takes 64 / 128 of them (IDF i2s_pdm.c
    /// pdm_rx clock). Some(oversampling) when RX runs PDM through the PDM2PCM filter; raw PDM stays unsupported
    fn pdm_rx_osr(&self, tx: bool) -> Option<f64> {
        let c = self.r(reg::RX_CONF);
        (!tx && c & PDM_EN != 0 && c & RX_PDM2PCM != 0).then_some(if c & RX_PDM_DSR16 != 0 {
            128.0
        } else {
            64.0
        })
    }

    pub fn format(&self, tx: bool) -> Format {
        let (conf, conf1, tdm) = if tx {
            (reg::TX_CONF, reg::TX_CONF1, reg::TX_TDM_CTRL)
        } else {
            (reg::RX_CONF, reg::RX_CONF1, reg::RX_TDM_CTRL)
        };
        let c = self.r(conf);
        let c1 = self.r(conf1);
        let t = self.r(tdm);
        let data_bits = ((c1 >> 13) & 0x1f) + 1;
        let bytes = match data_bits {
            0..=8 => 1,
            9..=16 => 2,
            17..=24 => {
                if c & FILL24 != 0 {
                    4
                } else {
                    3
                }
            }
            _ => 4,
        };
        let pdm = self.pdm_rx_osr(tx).is_some();
        Format {
            rate: self.rate(tx),
            data_bits,
            slot_bits: ((c1 >> 24) & 0x1f) + 1,
            // PDM2PCM output: left / right slots, PCM samples with no Philips bit delay
            slots: if pdm { 2 } else { ((t >> 16) & 0xf) + 1 },
            mask: t & 0xffff,
            mono: c & MONO != 0,
            skip: tx && t & SKIP_MSK != 0,
            msb_shift: pdm || c1 & MSB_SHIFT != 0,
            bytes,
        }
    }

    /// Whether this model can run the direction: master mode, TDM (standard) or RX PDM2PCM, clock configured
    fn usable(&self, tx: bool, f: &Format) -> bool {
        let c = self.r(if tx { reg::TX_CONF } else { reg::RX_CONF });
        let mode = (c & PDM_EN == 0 && c & TDM_EN != 0) || self.pdm_rx_osr(tx).is_some();
        c & SLAVE == 0 && mode && f.rate > 1.0
    }

    /// Advance to now: TX takes blocks / reports EOF, RX writes blocks. peri = GDMA peripheral id (I2S0 = 3, S3 I2S1 = 4).
    /// Returns the next time processing is needed
    pub fn update(
        &mut self,
        now: u64,
        gdma: &mut Gdma,
        mem: &mut dyn DmaMem,
        peri: u32,
        io: &mut dyn I2sIo,
    ) -> u64 {
        let mut next = u64::MAX;
        if self.tx.running {
            next = next.min(self.update_tx(now, gdma, mem, peri, io));
        }
        if self.rx.running {
            next = next.min(self.update_rx(now, gdma, mem, peri, io));
        }
        next
    }

    fn update_tx(
        &mut self,
        now: u64,
        gdma: &mut Gdma,
        mem: &mut dyn DmaMem,
        peri: u32,
        io: &mut dyn I2sIo,
    ) -> u64 {
        let f = self.format(true);
        let mut guard = 0;
        while self.tx.next <= now as f64 && guard < 64 {
            guard += 1;
            if let Some(c) = self.tx.cur.take() {
                gdma.out_eof(c.ch, c.desc, c.eof, c.last);
                self.int_raw |= int::TX_DONE;
            }
            let ch = gdma.out_channel_for(peri);
            let got = match (self.usable(true, &f), ch) {
                (true, Some(ch)) => gdma.out_next(ch, mem).map(|x| (ch, x)),
                _ => None,
            };
            let Some((ch, (desc, data, eof, last))) = got else {
                // Channel not started / chain ended / clock unset: line idles, check again in 1 ms
                self.tx.stalls += 1;
                self.tx.next = self.tx.next.max(now as f64) + CPU_HZ as f64 / 1000.0;
                break;
            };
            let fb = f.frame_bytes();
            let n = data.len() / fb;
            let t0 = self.tx.next as u64;
            let mut frames = Vec::with_capacity(n);
            for k in 0..n {
                frames.push(decode_tx(&f, &data[k * fb..(k + 1) * fb]));
            }
            if n > 0 {
                io.tx(t0, f.rate, &frames);
            }
            self.tx.frames += n as u64;
            self.tx.chunks += 1;
            self.tx.cur = Some(Chunk {
                ch,
                desc,
                eof,
                last,
                frames: n,
                t0,
            });
            // An empty descriptor still takes one frame, so an all-empty chain doesn't spin in place
            self.tx.next += n.max(1) as f64 * f.frame_cycles();
        }
        self.tx.next.ceil() as u64
    }

    fn update_rx(
        &mut self,
        now: u64,
        gdma: &mut Gdma,
        mem: &mut dyn DmaMem,
        peri: u32,
        io: &mut dyn I2sIo,
    ) -> u64 {
        let f = self.format(false);
        let mut guard = 0;
        while self.rx.next <= now as f64 && guard < 64 {
            guard += 1;
            if let Some(c) = self.rx.cur.take() {
                let slots = io.rx(c.t0, f.rate, c.frames);
                let mut data = Vec::with_capacity(c.frames * f.frame_bytes());
                for s in &slots {
                    encode_rx(&f, s, &mut data);
                }
                if gdma.in_fill(c.ch, c.desc, &data, c.eof, mem) {
                    self.rx.frames += c.frames as u64;
                    self.rx.chunks += 1;
                    if c.eof {
                        self.int_raw |= int::RX_DONE;
                    }
                }
            }
            let ch = gdma.in_channel_for(peri);
            let got = match (self.usable(false, &f), ch) {
                (true, Some(ch)) => gdma.in_peek(ch, mem).map(|x| (ch, x)),
                _ => None,
            };
            let Some((ch, (desc, size))) = got else {
                self.rx.stalls += 1;
                self.rx.next = self.rx.next.max(now as f64) + CPU_HZ as f64 / 1000.0;
                self.rx.eof_count = 0;
                break;
            };
            let fb = f.frame_bytes();
            let eof_num = (self.r(reg::RXEOF_NUM) & 0xfff).max(1) as usize;
            let room = size.min(eof_num - self.rx.eof_count.min(eof_num - 1));
            let n = (room / fb).max(1);
            self.rx.eof_count += n * fb;
            let eof = self.rx.eof_count >= eof_num;
            if eof {
                self.rx.eof_count = 0;
            }
            let t0 = self.rx.next as u64;
            self.rx.cur = Some(Chunk {
                ch,
                desc,
                eof,
                last: false,
                frames: n,
                t0,
            });
            self.rx.next += n as f64 * f.frame_cycles();
        }
        self.rx.next.ceil() as u64
    }
}

fn sample_le(b: &[u8], bits: u32) -> i32 {
    let mut v: u32 = 0;
    for (i, x) in b.iter().enumerate() {
        v |= (*x as u32) << (8 * i);
    }
    // Take the low data_bits, sign-extend, left-align to 32 bits
    (v << (32 - bits.min(32))) as i32
}

/// One frame in memory -> left and right slot words
fn decode_tx(f: &Format, b: &[u8]) -> [i32; 2] {
    let mut out = [0i32; 2];
    let samples: Vec<i32> = b
        .chunks(f.bytes)
        .map(|c| sample_le(c, f.data_bits))
        .collect();
    if f.mono {
        // Mono duplicate: enabled and (chan_equal) disabled slots get the same sample
        return [samples[0], samples[0]];
    }
    let mut it = samples.iter();
    for (k, o) in out.iter_mut().enumerate().take(f.slots.min(2) as usize) {
        let on = f.mask >> k & 1 != 0;
        if on || f.skip {
            let v = *it.next().unwrap_or(&0);
            if on {
                *o = v;
            }
        }
    }
    out
}

/// One frame's slot words -> memory samples (top data_bits of each slot word, little-endian)
fn encode_rx(f: &Format, s: &[i32; 2], out: &mut Vec<u8>) {
    let take = |w: i32| -> u32 {
        // A Philips device's first bit lags WS by one BCK; without msb_shift the controller reads data off by one bit
        let w = if f.msb_shift { w } else { w.wrapping_shl(1) };
        ((w >> (32 - f.data_bits.min(32))) as u32)
            & if f.data_bits >= 32 {
                u32::MAX
            } else {
                (1 << f.data_bits) - 1
            }
    };
    let mut push = |v: u32| out.extend_from_slice(&v.to_le_bytes()[..f.bytes]);
    if f.mono {
        // Mono: store only the first enabled slot (mono_fst_vld)
        let k = if f.mask & 1 != 0 { 0 } else { 1 };
        push(take(s[k]));
        return;
    }
    for (k, w) in s.iter().enumerate().take(f.slots.min(2) as usize) {
        if f.mask >> k & 1 != 0 {
            push(take(*w));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gdma::{Gdma, GdmaLayout};

    struct Ram(Vec<u8>);
    const BASE: u32 = 0x3fc8_8000;
    impl DmaMem for Ram {
        fn rd8(&mut self, a: u32) -> u8 {
            self.0[(a - BASE) as usize]
        }
        fn rd32(&mut self, a: u32) -> u32 {
            let o = (a - BASE) as usize;
            u32::from_le_bytes(self.0[o..o + 4].try_into().unwrap())
        }
        fn wr8(&mut self, a: u32, v: u8) {
            self.0[(a - BASE) as usize] = v;
        }
        fn wr32(&mut self, a: u32, v: u32) {
            let o = (a - BASE) as usize;
            self.0[o..o + 4].copy_from_slice(&v.to_le_bytes());
        }
    }

    #[derive(Default)]
    struct Probe {
        tx: Vec<(u64, [i32; 2])>,
        rx_t: Vec<u64>,
    }
    impl I2sIo for Probe {
        fn tx(&mut self, t: u64, _rate: f64, frames: &[[i32; 2]]) {
            for (i, f) in frames.iter().enumerate() {
                self.tx.push((t + i as u64, *f));
            }
        }
        fn rx(&mut self, t: u64, _rate: f64, n: usize) -> Vec<[i32; 2]> {
            self.rx_t.push(t);
            (0..n)
                .map(|i| [((i as i32) << 8) << 8, 0x7fff_ff00])
                .collect()
        }
    }

    /// Configure 44.1 kHz, 16-bit, two slots like IDF (i2s_ll_tx_set_mclk: PLL 160MHz / (14 + 43/250), bck_div 8)
    fn config_44k1(i: &mut I2s, tx: bool, mono: bool) {
        let (conf, conf1, clkm, div, tdm) = if tx {
            (
                reg::TX_CONF,
                reg::TX_CONF1,
                reg::TX_CLKM_CONF,
                reg::TX_CLKM_DIV,
                reg::TX_TDM_CTRL,
            )
        } else {
            (
                reg::RX_CONF,
                reg::RX_CONF1,
                reg::RX_CLKM_CONF,
                reg::RX_CLKM_DIV,
                reg::RX_TDM_CTRL,
            )
        };
        i.write(conf, TDM_EN | if mono { MONO } else { 0 }, 0);
        // bits_mod 15, chan_bits 15, half_sample 15, bck_div 7, msb_shift
        i.write(
            conf1,
            (15 << 13) | (15 << 24) | (15 << 18) | (7 << 7) | MSB_SHIFT,
            0,
        );
        i.write(clkm, (1 << 26) | (2 << 27) | 14, 0);
        // Fraction 43/250: yn1=0, z=43, x=250/43-1=4, y=250%43=35
        i.write(div, 43 | (35 << 9) | (4 << 18), 0);
        i.write(tdm, (1 << 16) | if mono { 1 } else { 3 }, 0);
    }

    #[test]
    fn rate_from_dividers() {
        let mut i = I2s::new(0, true);
        config_44k1(&mut i, true, false);
        let r = i.format(true).rate;
        // 160e6 / 14.172 / 8 / 32
        assert!((r - 44101.04).abs() < 0.01, "{r}");
        assert_eq!(i.format(true).frame_bytes(), 4);
        // update bit self-clears
        i.write(reg::TX_CONF, TDM_EN | UPDATE, 0);
        assert_eq!(i.read(reg::TX_CONF) & UPDATE, 0);
        // clk_sel 1 = PLL_D2 240 MHz: same dividers run 1.5x faster
        i.write(reg::TX_CLKM_CONF, (1 << 26) | (1 << 27) | 14, 0);
        let r = i.format(true).rate;
        assert!((r - 44101.04 * 1.5).abs() < 0.02, "{r}");
    }

    #[test]
    fn pdm_rx_rate_and_format() {
        // Register values M5Unified's Mic_Class leaves on a Cardputer: clk_sel 1 (240 MHz), div 58 (fraction left 0), bck_div 2, DSR16
        let mut i = I2s::new(0, true);
        i.write(reg::RX_CONF1, 0x2f3d_e080, 0);
        i.write(reg::RX_CLKM_CONF, 0x2c00_003a, 0);
        i.write(reg::RX_CONF, 0x0070_9404 & !START, 0);
        let f = i.format(false);
        assert!(i.usable(false, &f));
        // DSR16 = 128 PDM clocks per PCM sample (IDF i2s_pdm.c); with the real fraction this is M5Unified's 16 kHz
        let want = 240e6 / 58.0 / 2.0 / 128.0;
        assert!((f.rate - want).abs() < 0.01, "{}", f.rate);
        assert_eq!((f.slots, f.msb_shift, f.bytes), (2, true, 2));
        // Without PDM2PCM, raw PDM is not modelled and the port stays idle
        i.write(reg::RX_CONF, 0x0050_9404 & !START, 0);
        assert!(!i.usable(false, &i.format(false)));
    }

    #[test]
    fn tx_ring_streams_at_sample_rate() {
        let mut m = Ram(vec![0; 0x2000]);
        // Two descriptors in a ring, 4 frames (16 bytes) each, both with suc_eof
        let (d0, d1, b0, b1) = (BASE, BASE + 0x10, BASE + 0x100, BASE + 0x200);
        for (d, b, n) in [(d0, b0, d1), (d1, b1, d0)] {
            m.wr32(d, (1 << 31) | (1 << 30) | (16 << 12) | 16);
            m.wr32(d + 4, b);
            m.wr32(d + 8, n);
        }
        for k in 0..4u32 {
            m.wr32(b0 + 4 * k, (k + 1) | (0x8000 << 16));
        }
        let mut g = Gdma::new(GdmaLayout::S3);
        let out0 = GdmaLayout::S3.out_off;
        g.write(out0 + 0x48, 3);
        g.write(out0 + 0x10, 0b10); // OUT_EOF interrupt enable
        g.write(out0 + 0x20, (1 << 21) | (d0 & 0xf_ffff));
        let mut i = I2s::new(0, true);
        config_44k1(&mut i, true, false);
        i.write(reg::TX_CONF, i.read(reg::TX_CONF) | START, 1000);
        let mut p = Probe::default();
        let fc = CPU_HZ as f64 / i.format(true).rate;
        let n1 = i.update(1000, &mut g, &mut m, 3, &mut p);
        assert_eq!(p.tx.len(), 4);
        assert_eq!(p.tx[0].1, [1 << 16, i32::MIN]);
        assert!(!g.out_irq(0), "first block still playing");
        assert_eq!(n1, (1000.0 + 4.0 * fc).ceil() as u64);
        i.update(n1, &mut g, &mut m, 3, &mut p);
        assert!(g.out_irq(0));
        assert_eq!(
            g.read(out0 + 0x28),
            d0,
            "OUT_EOF_DES_ADDR = block just played"
        );
        assert_eq!(p.tx.len(), 8);
        assert_eq!(i.tx.frames, 8);
    }

    #[test]
    fn rx_fills_descriptors_and_reports_eof() {
        let mut m = Ram(vec![0; 0x2000]);
        let (d0, d1, b0, b1) = (BASE, BASE + 0x10, BASE + 0x100, BASE + 0x200);
        for (d, b, n) in [(d0, b0, d1), (d1, b1, d0)] {
            m.wr32(d, (1 << 31) | 32);
            m.wr32(d + 4, b);
            m.wr32(d + 8, n);
        }
        let mut g = Gdma::new(GdmaLayout::S3);
        g.write(0x48, 3);
        g.write(0x10, 0b10); // IN_SUC_EOF
        g.write(0x20, (1 << 22) | (d0 & 0xf_ffff));
        let mut i = I2s::new(0, true);
        config_44k1(&mut i, false, true);
        // 32-bit data, mono left slot: 4 bytes per frame, 32-byte block = 8 frames
        i.write(
            reg::RX_CONF1,
            (31 << 13) | (31 << 24) | (31 << 18) | (3 << 7) | MSB_SHIFT,
            0,
        );
        i.write(reg::RXEOF_NUM, 32, 0);
        i.write(reg::RX_CONF, i.read(reg::RX_CONF) | START, 0);
        let mut p = Probe::default();
        let n1 = i.update(0, &mut g, &mut m, 3, &mut p);
        assert!(p.rx_t.is_empty(), "first block not yet full");
        i.update(n1, &mut g, &mut m, 3, &mut p);
        assert_eq!(p.rx_t, vec![0]);
        assert!(g.in_irq(0));
        assert_eq!(g.read(0x28), d0, "IN_SUC_EOF_DES_ADDR");
        let w0 = m.rd32(d0);
        assert_eq!((w0 >> 12) & 0xfff, 32);
        assert_ne!(w0 & (1 << 30), 0);
        assert_eq!(w0 >> 31, 0, "owner handed back to CPU");
        // Frame 3: ((3 << 8) << 8)
        assert_eq!(m.rd32(b0 + 12), 3 << 16);
    }
}
