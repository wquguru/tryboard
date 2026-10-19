//! LEDC (LED PWM controller): 4 low-speed timers + 6 (C3) / 8 (S3) channels, with hardware fade and interrupts.
//! Registers in soc/esp32c3|esp32s3/register/soc/ledc_reg.h (same layout). PWM is not simulated per period; duty is computed lazily from time.

use crate::periph::CPU_HZ;

#[derive(Default, Clone, Copy)]
pub struct Timer {
    pub conf: u32,
    /// Active config (updated on para_up)
    pub res: u32,
    pub div: u32, // 10.8 fixed point
    pub paused: bool,
}

#[derive(Default, Clone, Copy)]
pub struct Channel {
    pub conf0: u32,
    pub hpoint: u32,
    pub duty_reg: u32,
    pub conf1: u32,
    /// Active duty (with 4 fractional bits)
    pub duty: u32,
    pub out_en: bool,
    pub idle_lv: bool,
    pub timer: usize,
    // Fade
    pub fading: bool,
    pub fade_inc: bool,
    pub fade_left: u32,
    pub fade_cycle: u32,
    pub fade_scale: u32,
    pub fade_next: u64,
}

#[derive(Default)]
pub struct Ledc {
    pub timers: [Timer; 4],
    /// Room for 8 channels (S3 has 8, C3 only the first 6; C3 firmware never touches the last two)
    pub ch: [Channel; 8],
    pub conf: u32,
    pub int_raw: u32,
    pub int_ena: u32,
    /// Bumped whenever output may have changed (params applied, timer reconfigured, fade step): tells the event log to re-check pin PWM
    pub rev: u64,
}

impl Ledc {
    fn src_hz(&self) -> f64 {
        match self.conf & 3 {
            1 => 80e6,
            2 => 17.5e6,
            3 => 40e6,
            _ => 0.0,
        }
    }

    /// PWM frequency (Hz) and full scale of the channel's timer
    pub fn timer_freq(&self, t: usize) -> (f64, u32) {
        let tm = &self.timers[t];
        let div = tm.div as f64 / 256.0;
        let full = 1u32 << tm.res;
        if div <= 0.0 || tm.paused || tm.res == 0 {
            return (0.0, full);
        }
        (self.src_hz() / div / full as f64, full)
    }

    fn period_cycles(&self, t: usize) -> u64 {
        let (f, _) = self.timer_freq(t);
        if f <= 0.0 {
            u64::MAX / 4
        } else {
            ((CPU_HZ as f64 / f) as u64).max(1)
        }
    }

    /// Output of channel n: (duty 0..1, frequency Hz); None when disabled
    pub fn output(&self, n: usize) -> Option<(f32, f32)> {
        let c = &self.ch[n];
        if !c.out_en {
            return None;
        }
        let (f, full) = self.timer_freq(c.timer);
        let d = (c.duty >> 4) as f32 / full as f32;
        Some((d.clamp(0.0, 1.0), f as f32))
    }

    pub fn read(&self, off: u32) -> u32 {
        match off {
            0x00..=0x9c => {
                let (n, r) = ((off / 0x14) as usize, off % 0x14);
                let c = &self.ch[n];
                match r {
                    0x00 => c.conf0 & !(1 << 4),
                    0x04 => c.hpoint,
                    0x08 => c.duty_reg,
                    0x0c => c.conf1 & !(1 << 31),
                    _ => c.duty,
                }
            }
            0xa0..=0xbc => {
                let t = ((off - 0xa0) / 8) as usize;
                if off.is_multiple_of(8) {
                    self.timers[t].conf & !(1 << 25)
                } else {
                    0
                }
            }
            0xc0 => self.int_raw,
            0xc4 => self.int_raw & self.int_ena,
            0xc8 => self.int_ena,
            0xd0 => self.conf,
            0xfc => 0x1907040,
            _ => 0,
        }
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        match off {
            0x00..=0x9c => {
                let (n, r) = ((off / 0x14) as usize, off % 0x14);
                match r {
                    0x00 => {
                        self.ch[n].conf0 = v;
                        if v & (1 << 4) != 0 {
                            self.para_up(n, now);
                        }
                    }
                    0x04 => self.ch[n].hpoint = v,
                    0x08 => self.ch[n].duty_reg = v & 0x7_ffff,
                    0x0c => self.ch[n].conf1 = v,
                    _ => {}
                }
            }
            0xa0..=0xbc if off.is_multiple_of(8) => {
                let t = ((off - 0xa0) / 8) as usize;
                self.rev += 1;
                let tm = &mut self.timers[t];
                tm.conf = v;
                tm.paused = v & (1 << 22) != 0;
                if v & (1 << 25) != 0 || tm.div == 0 {
                    tm.res = v & 0xf;
                    tm.div = (v >> 4) & 0x3_ffff;
                }
            }
            0xc8 => self.int_ena = v,
            0xcc => self.int_raw &= !v,
            0xd0 => {
                self.conf = v;
                self.rev += 1;
            }
            _ => {}
        }
    }

    /// Apply channel params: duty, output enable, fade start
    fn para_up(&mut self, n: usize, now: u64) {
        self.rev += 1;
        let conf0 = self.ch[n].conf0;
        let conf1 = self.ch[n].conf1;
        let timer = (conf0 & 3) as usize;
        let period = self.period_cycles(timer);
        let c = &mut self.ch[n];
        c.timer = timer;
        c.out_en = conf0 & (1 << 2) != 0;
        c.idle_lv = conf0 & (1 << 3) != 0;
        c.duty = c.duty_reg;
        if conf1 & (1 << 31) != 0 {
            let num = (conf1 >> 20) & 0x3ff;
            c.fade_inc = conf1 & (1 << 30) != 0;
            c.fade_cycle = ((conf1 >> 10) & 0x3ff).max(1);
            c.fade_scale = conf1 & 0x3ff;
            c.fade_left = num;
            c.fading = num > 0;
            // A stopped timer has a near-infinite period: saturate so the fade just never fires
            c.fade_next = now.saturating_add(period.saturating_mul(c.fade_cycle as u64));
            if !c.fading {
                self.int_raw |= 1 << (4 + n);
            }
        }
    }

    /// Advance fades; returns the next event time
    pub fn update(&mut self, now: u64) -> u64 {
        let mut next = u64::MAX;
        for n in 0..8 {
            if !self.ch[n].fading {
                continue;
            }
            let period = self.period_cycles(self.ch[n].timer);
            let full = 1u32 << self.timers[self.ch[n].timer].res;
            let c = &mut self.ch[n];
            if c.fading && now >= c.fade_next {
                self.rev += 1;
            }
            while c.fading && now >= c.fade_next {
                let step = c.fade_scale << 4;
                c.duty = if c.fade_inc {
                    (c.duty + step).min(full << 4)
                } else {
                    c.duty.saturating_sub(step)
                };
                c.fade_left -= 1;
                c.fade_next = c
                    .fade_next
                    .saturating_add(period.saturating_mul(c.fade_cycle as u64));
                if c.fade_left == 0 {
                    c.fading = false;
                    self.int_raw |= 1 << (4 + n);
                }
            }
            if c.fading {
                next = next.min(c.fade_next);
            }
        }
        next
    }

    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }
}
