//! PCNT 脉冲计数器（ESP32-S3 有，C3 没有；放在这个 crate 里与其它同族外设一起，S3 直接复用）。
//! 寄存器按 ESP-IDF `soc/esp32s3/register/soc/pcnt_reg.h`（基址 0x60017000），行为按 S3 TRM「脉冲计数控制器」：
//! 4 个单元，每单元 2 个通道；每通道一个脉冲输入（边沿计数）和一个控制输入（电平改写计数方向 / 禁止计数）。
//!
//! - CONFn0：filter_thres[9:0]（APB 周期）、filter_en[10]、zero / h_lim / l_lim / thres0 / thres1 比较使能 [15:11]、
//!   ch0 neg[17:16] pos[19:18] hctrl[21:20] lctrl[23:22]、ch1 同样排在 [31:24]
//! - CONFn1：thres0[15:0]、thres1[31:16]；CONFn2：h_lim[15:0]、l_lim[31:16]（有符号 16 位）
//! - CNTn（0x30 起）：当前计数；INT_RAW/ST/ENA/CLR 0x40..0x4C，每单元一位（任一比较事件）
//! - STATUSn（0x50 起）：zero_mode[1:0]、thres1 / thres0 / l_lim / h_lim / zero 锁存 [6:2]（最近一次事件）
//! - CTRL（0x60）：单元 n 的 cnt_rst = 位 2n（置 1 期间计数清零并保持）、cnt_pause = 位 2n+1
//!
//! 边沿动作：1 加、2 减、0/3 不动；电平动作：0 不改、1 反向、2/3 禁止。计数到 h_lim / l_lim 时触发事件并清零
//! （IDF 的 accum_count 靠这个把溢出累加到软件里）；到 thres0 / thres1 / 0 时触发对应事件。
//! 输入信号经 GPIO 矩阵进来（PCNT_SIG_CH0_IN0_IDX = 33，单元 u 的四路依次为 33+4u … 36+4u），
//! 由 SoC 在引脚电平变化时按时刻喂进来；滤波器见 `sigin`。

use crate::sigin::Deglitch;

pub const UNITS: usize = 4;
/// GPIO 矩阵输入信号号（gpio_sig_map.h）：单元 u 的 [脉冲 ch0, 脉冲 ch1, 控制 ch0, 控制 ch1] = SIG0 + 4u + 0..3
pub const SIG0: u32 = 33;
pub const NSIG: usize = 4 * UNITS;

/// STATUS 锁存位（status >> 2 之后的位序，与 IDF pcnt_ll 的 PCNT_LL_WATCH_EVENT_* 一致）
const EV_THRES1: u32 = 1 << 0;
const EV_THRES0: u32 = 1 << 1;
const EV_L_LIM: u32 = 1 << 2;
const EV_H_LIM: u32 = 1 << 3;
const EV_ZERO: u32 = 1 << 4;

pub struct Pcnt {
    pub conf: [[u32; 3]; UNITS],
    cnt: [i16; UNITS],
    /// 最近一次事件的锁存位（已左移 2）
    lat: [u32; UNITS],
    zmode: [u32; UNITS],
    pub ctrl: u32,
    pub int_raw: u32,
    pub int_ena: u32,
    /// 每单元四路输入的滤波状态（顺序同 SIG0 + 4u + k）
    inp: [[Deglitch; 4]; UNITS],
    /// 计数变化次数（调试 / 验收统计）
    pub steps: u64,
}

impl Default for Pcnt {
    fn default() -> Self {
        // 复位值：filter_thres=16、filter_en、zero / h_lim / l_lim 使能；CTRL 四个单元的 cnt_rst 置位
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

    /// 单元 u 的滤波门限（CPU 周期；没开滤波为 0）。APB 80MHz = CPU 的一半
    fn thres(&self, u: usize) -> u64 {
        let c = self.conf[u][0];
        if c & (1 << 10) != 0 {
            (c & 0x3ff) as u64 * 2
        } else {
            0
        }
    }

    /// 下一个挂起的滤波跳变生效的时刻（没有为 u64::MAX）
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

    /// 时刻 t 各输入信号（下标 = 信号号 - SIG0）的原始电平。先把 t 之前到期的滤波跳变按时间顺序生效，再看新跳变
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

    /// 推进到 now：到期的滤波跳变逐个生效（同一单元内按生效时刻先后，控制电平与脉冲沿的先后关系才对）
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

    /// 单元 u 的第 k 路输入滤波后跳变到 lv
    fn edge(&mut self, u: usize, k: usize, lv: bool) {
        // 控制输入只改电平，不计数
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
        // zero_mode：0 由正数减到 0、1 由负数加到 0、2 负数、3 正数
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

    /// 与 IDF rotary_encoder 示例相同的正交 4 倍频配置（pulse_cnt 驱动写出的寄存器值）
    fn quad(p: &mut Pcnt, h: i16, l: i16) {
        // ch0：沿 = A，电平 = B；pos 减、neg 加；高电平保持、低电平反向
        // ch1：沿 = B，电平 = A；pos 加、neg 减；高电平保持、低电平反向
        let ch0 = 1 | (2 << 2) | (1 << 6); // hctrl = 0（保持）
        let ch1 = 2 | (1 << 2) | (1 << 6);
        p.conf[0][0] =
            (1 << 10) | 100 | (1 << 11) | (1 << 12) | (1 << 13) | (ch0 << 16) | (ch1 << 24);
        p.conf[0][2] = (h as u16 as u32) | ((l as u16 as u32) << 16);
        p.write(0x60, 0);
    }

    /// 顺时针一格：A 先落、B 再落、A 起、B 起
    fn turn(p: &mut Pcnt, t0: &mut u64, cw: bool) {
        let seq: [(bool, bool); 4] = if cw {
            [(false, true), (false, false), (true, false), (true, true)]
        } else {
            [(true, false), (false, false), (false, true), (true, true)]
        };
        for (a, b) in seq {
            *t0 += 10_000;
            let mut lv = [false; NSIG];
            // 输入顺序：脉冲 ch0 = A、脉冲 ch1 = B、控制 ch0 = B、控制 ch1 = A
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
        // 静止时 A、B 都是高（上拉）
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
        assert_eq!(p.read(0x50) & 3, 0, "从正数减到 0");
        assert!(p.int_raw & 1 != 0, "过零事件");
        assert_eq!(p.read(0x50) >> 2 & 0x1f, EV_ZERO);
        p.write(0x4c, 1);
        // 两格到 h_lim=8：清零并锁存 h_lim
        turn(&mut p, &mut t, true);
        turn(&mut p, &mut t, true);
        p.update(t + 1000);
        assert_eq!(p.count(0), 0);
        assert_eq!(p.read(0x50) >> 2 & 0x1f, EV_H_LIM);
        // 暂停时不计数
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
        // 单元 0 ch0：上升沿加 1，滤波 100 APB 周期 = 200 CPU 周期
        p.conf[0][0] = (1 << 10) | 100 | (1 << 18);
        p.write(0x60, 0);
        let mut lv = [false; NSIG];
        p.feed(0, &lv);
        lv[0] = true;
        p.feed(1000, &lv);
        lv[0] = false;
        p.feed(1150, &lv); // 150 周期的毛刺
        p.update(5000);
        assert_eq!(p.count(0), 0);
        lv[0] = true;
        p.feed(6000, &lv);
        assert_eq!(p.next_event(), 6200);
        p.update(6200);
        assert_eq!(p.count(0), 1);
    }
}
