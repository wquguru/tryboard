//! PCNT pulse counter (S3 only; kept beside its sibling peripherals for reuse). Registers: IDF `soc/esp32s3/register/soc/pcnt_reg.h` (base 0x60017000);
//! behaviour per the S3 TRM: 4 units x 2 channels, each with an edge input and a level input.
//! - CONFn0: filter_thres[9:0] (APB cycles), filter_en[10], zero/h_lim/l_lim/thres0/thres1 enables [15:11], ch0 neg[17:16] pos[19:18]
//!   hctrl[21:20] lctrl[23:22], ch1 likewise [31:24]; CONFn1: thres0[15:0] thres1[31:16]; CONFn2: h_lim[15:0] l_lim[31:16] (signed 16)
//! - CNTn (0x30+), INT_RAW/ST/ENA/CLR 0x40..0x4C (one bit per unit), STATUSn (0x50+): zero_mode[1:0], latched events [6:2]; CTRL (0x60): cnt_rst = bit 2n, cnt_pause = 2n+1
//! - Edge action 1 inc, 2 dec, 0/3 none; level action 0 keep, 1 invert, 2/3 inhibit; h_lim / l_lim fire and clear (IDF accum_count relies on it), thres0/thres1/0 fire.
//!   Inputs via GPIO matrix (PCNT_SIG_CH0_IN0_IDX = 33, unit u: 33+4u..36+4u), fed by the SoC on pin changes; filter in `sigin`. (lint: allow-long-comment)

use crate::sigin::Deglitch;

pub const UNITS: usize = 4;
/// GPIO matrix input signals (gpio_sig_map.h): unit u's [pulse ch0, pulse ch1, ctrl ch0, ctrl ch1] = SIG0 + 4u + 0..3
pub const SIG0: u32 = 33;
pub const NSIG: usize = 4 * UNITS;

/// STATUS latch bits (bit order after status >> 2, matching IDF pcnt_ll's PCNT_LL_WATCH_EVENT_*)
const EV_THRES1: u32 = 1 << 0;
const EV_THRES0: u32 = 1 << 1;
const EV_L_LIM: u32 = 1 << 2;
const EV_H_LIM: u32 = 1 << 3;
const EV_ZERO: u32 = 1 << 4;

pub struct Pcnt {
    pub conf: [[u32; 3]; UNITS],
    cnt: [i16; UNITS],
    /// Latched bits of the latest event (already shifted left by 2)
    lat: [u32; UNITS],
    zmode: [u32; UNITS],
    pub ctrl: u32,
    pub int_raw: u32,
    pub int_ena: u32,
    /// Filter state of each unit's four inputs (same order as SIG0 + 4u + k)
    inp: [[Deglitch; 4]; UNITS],
    /// Count changes (debug / acceptance stats)
    pub steps: u64,
}

impl Default for Pcnt {
    fn default() -> Self {
        // Reset values: filter_thres=16, filter_en, zero / h_lim / l_lim enabled; CTRL cnt_rst set for all four units
        Pcnt {
            conf: [[0x3c10, 0, 0]; UNITS],
            cnt: [0; UNITS],
            lat: [0; UNITS],
            zmode: [0; UNITS],
            ctrl: 0x55,
            int_raw: 0,
            int_ena: 0,
            inp: [[Deglitch::default(); 4]; UNITS],
            steps: 0,
        }
    }
}

impl Pcnt {
    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }

    pub fn count(&self, u: usize) -> i16 {
        self.cnt[u]
    }

    pub fn read(&self, off: u32) -> u32 {
        match off {
            0x00..=0x2c => self.conf[(off / 12) as usize][((off % 12) / 4) as usize],
            0x30..=0x3c => self.cnt[((off - 0x30) / 4) as usize] as u16 as u32,
            0x40 => self.int_raw,
            0x44 => self.int_raw & self.int_ena,
            0x48 => self.int_ena,
            0x50..=0x5c => {
                let u = ((off - 0x50) / 4) as usize;
                self.zmode[u] | self.lat[u]
            }
            0x60 => self.ctrl,
            0xfc => 0x1907_0200,
            _ => 0,
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        match off {
            0x00..=0x2c => self.conf[(off / 12) as usize][((off % 12) / 4) as usize] = v,
            0x48 => self.int_ena = v & 0xf,
            0x4c => self.int_raw &= !v,
            0x60 => {
                self.ctrl = v;
                for u in 0..UNITS {
                    if v & (1 << (2 * u)) != 0 {
                        self.cnt[u] = 0;
                    }
                }
            }
            _ => {}
        }
    }

    /// Unit u's filter threshold (CPU cycles; 0 when off). APB 80MHz = half the CPU clock
    fn thres(&self, u: usize) -> u64 {
        let c = self.conf[u][0];
        if c & (1 << 10) != 0 {
            (c & 0x3ff) as u64 * 2
        } else {
            0
        }
    }

    /// When the next pending filtered edge takes effect (u64::MAX if none)
    pub fn next_event(&self) -> u64 {
        let mut n = u64::MAX;
        for u in 0..UNITS {
            let th = self.thres(u);
            for d in &self.inp[u] {
                if let Some(t) = d.due(th) {
                    n = n.min(t);
                }
            }
        }
        n
    }

    /// Raw levels of each input signal (index = signal - SIG0) at time t. Edges due before t commit in order first, then new edges are seen
    pub fn feed(&mut self, t: u64, levels: &[bool; NSIG]) {
        self.update(t);
        for u in 0..UNITS {
            let th = self.thres(u);
            for k in 0..4 {
                if let Some((_, lv)) = self.inp[u][k].input(t, levels[4 * u + k], th) {
                    self.edge(u, k, lv);
                }
            }
        }
    }

    /// Advance to now: due filtered edges commit one by one (in time order within a unit so control levels and pulse edges interleave right)
    pub fn update(&mut self, now: u64) {
        for u in 0..UNITS {
            let th = self.thres(u);
            loop {
                let mut first: Option<(u64, usize)> = None;
                for k in 0..4 {
                    if let Some(d) = self.inp[u][k].due(th) {
                        if d <= now && first.is_none_or(|f| d < f.0) {
                            first = Some((d, k));
                        }
                    }
                }
                let Some((_, k)) = first else { break };
                if let Some((_, lv)) = self.inp[u][k].flush(now, th) {
                    self.edge(u, k, lv);
                }
            }
        }
    }

    /// Unit u's input k (filtered) changed to lv
    fn edge(&mut self, u: usize, k: usize, lv: bool) {
        // Control inputs only change level, they don't count
        if k >= 2 {
            return;
        }
        let c = self.conf[u][0];
        let sh = 16 + 8 * k as u32;
        let act = if lv {
            (c >> (sh + 2)) & 3
        } else {
            (c >> sh) & 3
        };
        let ctrl_high = self.inp[u][k + 2].level;
        let lmode = if ctrl_high {
            (c >> (sh + 4)) & 3
        } else {
            (c >> (sh + 6)) & 3
        };
        let mut d: i32 = match act {
            1 => 1,
            2 => -1,
            _ => 0,
        };
        match lmode {
            0 => {}
            1 => d = -d,
            _ => d = 0,
        }
        if d == 0 || self.ctrl & (3 << (2 * u)) != 0 {
            return;
        }
        self.step(u, d);
    }

    fn step(&mut self, u: usize, d: i32) {
        self.steps += 1;
        let old = self.cnt[u];
        let v = old.wrapping_add(d as i16);
        let c = self.conf[u][0];
        let (h_lim, l_lim) = (
            self.conf[u][2] as u16 as i16,
            (self.conf[u][2] >> 16) as u16 as i16,
        );
        let (th0, th1) = (
            self.conf[u][1] as u16 as i16,
            (self.conf[u][1] >> 16) as u16 as i16,
        );
        let mut ev = 0;
        let mut now = v;
        if c & (1 << 12) != 0 && h_lim > 0 && v == h_lim {
            ev |= EV_H_LIM;
            now = 0;
        } else if c & (1 << 13) != 0 && l_lim < 0 && v == l_lim {
            ev |= EV_L_LIM;
            now = 0;
        } else {
            if c & (1 << 14) != 0 && v == th0 {
                ev |= EV_THRES0;
            }
            if c & (1 << 15) != 0 && v == th1 {
                ev |= EV_THRES1;
            }
            if c & (1 << 11) != 0 && v == 0 {
                ev |= EV_ZERO;
            }
        }
        self.cnt[u] = now;
        // zero_mode: 0 positive down to 0, 1 negative up to 0, 2 negative, 3 positive
        self.zmode[u] = match now {
            0 if old > 0 && ev & (EV_H_LIM | EV_L_LIM) == 0 => 0,
            0 if old < 0 && ev & (EV_H_LIM | EV_L_LIM) == 0 => 1,
            0 => self.zmode[u],
            x if x < 0 => 2,
            _ => 3,
        };
        if ev != 0 {
            self.lat[u] = ev << 2;
            self.int_raw |= 1 << u;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same 4x quadrature config as the IDF rotary_encoder example (register values written by the pulse_cnt driver)
    fn quad(p: &mut Pcnt, h: i16, l: i16) {
        // ch0: edge = A, level = B; pos dec, neg inc; keep on high, invert on low
        // ch1: edge = B, level = A; pos inc, neg dec; keep on high, invert on low
        let ch0 = 1 | (2 << 2) | (1 << 6); // hctrl = 0 (keep)
        let ch1 = 2 | (1 << 2) | (1 << 6);
        p.conf[0][0] =
            (1 << 10) | 100 | (1 << 11) | (1 << 12) | (1 << 13) | (ch0 << 16) | (ch1 << 24);
        p.conf[0][2] = (h as u16 as u32) | ((l as u16 as u32) << 16);
        p.write(0x60, 0);
    }

    /// One clockwise step: A falls, B falls, A rises, B rises
    fn turn(p: &mut Pcnt, t0: &mut u64, cw: bool) {
        let seq: [(bool, bool); 4] = if cw {
            [(false, true), (false, false), (true, false), (true, true)]
        } else {
            [(true, false), (false, false), (false, true), (true, true)]
        };
        for (a, b) in seq {
            *t0 += 10_000;
            let mut lv = [false; NSIG];
            // Input order: pulse ch0 = A, pulse ch1 = B, control ch0 = B, control ch1 = A
            lv[0] = a;
            lv[1] = b;
            lv[2] = b;
            lv[3] = a;
            p.feed(*t0, &lv);
        }
    }

    #[test]
    fn quadrature_4x_and_limits() {
        let mut p = Pcnt::default();
        let mut t = 0;
        // At rest A and B are both high (pull-ups)
        p.feed(
            0,
            &[
                true, true, true, true, false, false, false, false, false, false, false, false,
                false, false, false, false,
            ],
        );
        p.update(1000);
        quad(&mut p, 8, -8);
        turn(&mut p, &mut t, true);
        p.update(t + 1000);
        assert_eq!(p.count(0), 4);
        turn(&mut p, &mut t, false);
        p.update(t + 1000);
        assert_eq!(p.count(0), 0);
        assert_eq!(p.read(0x50) & 3, 0, "positive down to 0");
        assert!(p.int_raw & 1 != 0, "zero-crossing event");
        assert_eq!(p.read(0x50) >> 2 & 0x1f, EV_ZERO);
        p.write(0x4c, 1);
        // Two steps to h_lim=8: clear and latch h_lim
        turn(&mut p, &mut t, true);
        turn(&mut p, &mut t, true);
        p.update(t + 1000);
        assert_eq!(p.count(0), 0);
        assert_eq!(p.read(0x50) >> 2 & 0x1f, EV_H_LIM);
        // No counting while paused
        p.write(0x60, 2);
        turn(&mut p, &mut t, true);
        p.update(t + 1000);
        assert_eq!(p.count(0), 0);
        p.write(0x60, 0);
        turn(&mut p, &mut t, false);
        p.update(t + 1000);
        assert_eq!(p.count(0) as u16 as u32, p.read(0x30));
        assert_eq!(p.count(0), -4);
        assert_eq!(p.read(0x50) & 3, 2);
    }

    #[test]
    fn glitch_filter() {
        let mut p = Pcnt::default();
        // Unit 0 ch0: +1 on rising edge, filter 100 APB cycles = 200 CPU cycles
        p.conf[0][0] = (1 << 10) | 100 | (1 << 18);
        p.write(0x60, 0);
        let mut lv = [false; NSIG];
        p.feed(0, &lv);
        lv[0] = true;
        p.feed(1000, &lv);
        lv[0] = false;
        p.feed(1150, &lv); // 150-cycle glitch
        p.update(5000);
        assert_eq!(p.count(0), 0);
        lv[0] = true;
        p.feed(6000, &lv);
        assert_eq!(p.next_event(), 6200);
        p.update(6200);
        assert_eq!(p.count(0), 1);
    }
}
