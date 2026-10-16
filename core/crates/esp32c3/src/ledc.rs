//! LEDC（LED PWM 控制器）：4 个低速定时器 + 6（C3）/ 8（S3）个通道，含硬件渐变（fade）与中断。
//! 寄存器见 soc/esp32c3|esp32s3/register/soc/ledc_reg.h（两者布局相同）。PWM 波形不逐周期模拟，按时间惰性计算占空比。

use crate::periph::CPU_HZ;

#[derive(Default, Clone, Copy)]
pub struct Timer {
    pub conf: u32,
    /// 生效中的配置（para_up 时更新）
    pub res: u32,
    pub div: u32, // 10.8 定点
    pub paused: bool,
}

#[derive(Default, Clone, Copy)]
pub struct Channel {
    pub conf0: u32,
    pub hpoint: u32,
    pub duty_reg: u32,
    pub conf1: u32,
    /// 生效中的占空比（含 4 位小数）
    pub duty: u32,
    pub out_en: bool,
    pub idle_lv: bool,
    pub timer: usize,
    // 渐变
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
    /// 8 个通道的空间（S3 有 8 个、C3 只有前 6 个；C3 固件不会碰后两个）
    pub ch: [Channel; 8],
    pub conf: u32,
    pub int_raw: u32,
    pub int_ena: u32,
    /// 输出可能变了就 +1（参数生效、定时器改配置、渐变走一步）：事件记录据此决定要不要重新看各引脚的 PWM
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

    /// 通道所用定时器的 PWM 频率（Hz）与满量程
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

    /// 通道 n 的输出：(占空比 0..1, 频率 Hz)；未启用时 None
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

    /// 通道参数生效：占空比、输出使能、渐变启动
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
            c.fade_next = now + period * c.fade_cycle as u64;
            if !c.fading {
                self.int_raw |= 1 << (4 + n);
            }
        }
    }

    /// 推进渐变；返回下一个事件时刻
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
                c.fade_next += period * c.fade_cycle as u64;
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
