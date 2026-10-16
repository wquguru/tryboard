//! 直接驱动 / 观察 GPIO 的外接器件：旋转编码器（P2-01）、HC-SR04 超声波（P2-04）。
//!
//! 和 I2C 器件不同，它们的输出是带精确时刻的电平波形（正交相位、Echo 脉宽），不能只在 1ms 时间片之间施加。
//! 所以放在 SoC 里：`poll(now)` 给出到 now 为止该发生的引脚驱动（时刻, 引脚, 电平），SoC 按时刻施加到 GPIO
//! （照常触发 GPIO 中断、PCNT / RMT 接收、逻辑分析仪记录）；`on_level` 让器件看到芯片输出的电平（Trig）。
//! 外部输入（转几格、按下、距离）由 CLI 脚本 / 网页输入日志在时间片之间交给器件，器件自己排出后面的波形。

use std::collections::VecDeque;

use crate::periph::CPU_HZ;

/// 一次引脚驱动：(周期, 引脚, 电平)，电平 -1 = 松开（高阻）
pub type Drive = (u64, u32, i8);

/// 编码器转一格里相邻两个沿的间隔：0.5 ms（一格四个沿 2 ms，约每秒 500 格的手速上限，远快于真实拧动）
pub const ENC_EDGE_CYCLES: u64 = CPU_HZ / 2000;

/// EC11 类旋转编码器模块（KY-040）：A（CLK）/ B（DT）两相正交，模块上 10 kΩ 上拉，触点闭合接地；
/// 每格一个完整周期（四个沿）。按键 SW 按下接地、松开悬空（固件开内部上拉）。
/// 顺时针：A 先落（A 领先 B 90°）。不模拟触点抖动（见 DECISIONS）。
#[derive(Clone, Debug)]
pub struct Encoder {
    pub a: u32,
    pub b: u32,
    pub sw: Option<u32>,
    /// 已经转完的格数（顺时针为正）
    pub position: i64,
    pub pressed: bool,
    /// 还没转的格（每项 ±1）
    queue: VecDeque<i8>,
    /// 当前这一格的方向与已经走了几个沿
    dir: i8,
    phase: u8,
    next_t: u64,
    /// 要施加的驱动（attach / 按键立即生效的那些）
    out: Vec<Drive>,
}

impl Encoder {
    pub fn new(a: u32, b: u32, sw: Option<u32>, now: u64) -> Encoder {
        // 上电：两相都开路（上拉为高），按键松开
        let mut out = vec![(now, a, 1), (now, b, 1)];
        if let Some(s) = sw {
            out.push((now, s, -1));
        }
        Encoder { a, b, sw, position: 0, pressed: false, queue: VecDeque::new(), dir: 0, phase: 0, next_t: now, out }
    }

    /// 转 steps 格（正 = 顺时针），排在已经排着的后面
    pub fn turn(&mut self, now: u64, steps: i32) {
        if self.dir == 0 && self.queue.is_empty() {
            self.next_t = self.next_t.max(now);
        }
        let s = steps.signum() as i8;
        for _ in 0..steps.unsigned_abs().min(10_000) {
            self.queue.push_back(s);
        }
    }

    pub fn press(&mut self, now: u64, down: bool) {
        self.pressed = down;
        if let Some(s) = self.sw {
            self.out.push((now, s, if down { 0 } else { -1 }));
        }
    }

    /// (A, B) 在一格里第 k 个沿之后的电平
    fn levels(dir: i8, k: u8) -> (bool, bool) {
        const CW: [(bool, bool); 4] = [(false, true), (false, false), (true, false), (true, true)];
        const CCW: [(bool, bool); 4] = [(true, false), (false, false), (false, true), (true, true)];
        if dir > 0 {
            CW[k as usize]
        } else {
            CCW[k as usize]
        }
    }

    pub fn poll(&mut self, now: u64, out: &mut Vec<Drive>) -> u64 {
        out.append(&mut self.out);
        loop {
            if self.dir == 0 {
                match self.queue.pop_front() {
                    Some(d) => {
                        self.dir = d;
                        self.phase = 0;
                    }
                    None => return u64::MAX,
                }
            }
            if self.next_t > now {
                return self.next_t;
            }
            let t = self.next_t;
            let (pa, pb) = if self.phase == 0 { (true, true) } else { Self::levels(self.dir, self.phase - 1) };
            let (a, b) = Self::levels(self.dir, self.phase);
            if a != pa {
                out.push((t, self.a, a as i8));
            }
            if b != pb {
                out.push((t, self.b, b as i8));
            }
            self.phase += 1;
            self.next_t = t + ENC_EDGE_CYCLES;
            if self.phase == 4 {
                self.position += self.dir as i64;
                self.dir = 0;
            }
        }
    }
}

/// 声速（m/s）：20 ℃ 干燥空气。真实声速随温度变（约 +0.6 m/s/℃），这里固定，见 DECISIONS
pub const SOUND_MPS: f64 = 343.0;
/// Trig 下降沿到 Echo 上升沿：模块先发 8 个 40 kHz 脉冲（200 µs），再拉高 Echo。手册没给这个数，取常见实测量级
pub const ECHO_DELAY_US: f64 = 250.0;
/// 测不到（超出量程）时 Echo 的高电平宽度（规格书：约 38 ms）
pub const ECHO_TIMEOUT_US: f64 = 38_000.0;
/// 量程（规格书 2–400 cm）
pub const RANGE_CM: (f64, f64) = (2.0, 400.0);

/// HC-SR04：Trig 收到 ≥ 10 µs 高电平，下降沿后 ECHO_DELAY_US 拉高 Echo，宽度 = 往返时间 = 2 × 距离 / 声速。
/// Echo 是 5 V 推挽输出（模块 5 V 供电）：电平风险由网页接线检查 / 选型规则提示，这里只给逻辑电平。
#[derive(Clone, Debug)]
pub struct Hcsr04 {
    pub trig: u32,
    pub echo: u32,
    /// 探头到障碍物的距离（cm）；None = 前方什么都没有（超量程）
    pub distance_cm: Option<f64>,
    trig_high: Option<u64>,
    /// 一次测量的 Echo 上升 / 下降时刻（排着还没发生）
    pulse: Option<(u64, u64)>,
    echo_high: bool,
    /// 触发次数、发出的回波次数（统计）
    pub pings: u64,
    pub echoes: u64,
    /// 最近一次 Echo 宽度（µs）
    pub last_us: f64,
    out: Vec<Drive>,
}

impl Hcsr04 {
    pub fn new(trig: u32, echo: u32, now: u64) -> Hcsr04 {
        Hcsr04 { trig, echo, distance_cm: Some(100.0), trig_high: None, pulse: None, echo_high: false, pings: 0, echoes: 0, last_us: 0.0, out: vec![(now, echo, 0)] }
    }

    /// 这个距离对应的 Echo 高电平宽度（µs）
    pub fn echo_us(d: Option<f64>) -> f64 {
        match d {
            Some(cm) if (RANGE_CM.0..=RANGE_CM.1).contains(&cm) => 2.0 * cm / 100.0 / SOUND_MPS * 1e6,
            Some(cm) if cm < RANGE_CM.0 => 2.0 * RANGE_CM.0 / 100.0 / SOUND_MPS * 1e6,
            _ => ECHO_TIMEOUT_US,
        }
    }

    /// 芯片侧引脚电平变了（位 = 引脚号）
    pub fn on_level(&mut self, t: u64, level: u64) {
        let hi = level >> self.trig & 1 != 0;
        match (hi, self.trig_high) {
            (true, None) => self.trig_high = Some(t),
            (false, Some(t0)) => {
                self.trig_high = None;
                // 正在测（回波没结束）时的触发不理
                if t - t0 >= CPU_HZ / 100_000 && self.pulse.is_none() {
                    self.pings += 1;
                    let us = Self::echo_us(self.distance_cm);
                    let rise = t + (ECHO_DELAY_US * CPU_HZ as f64 / 1e6) as u64;
                    let fall = rise + (us * CPU_HZ as f64 / 1e6).round() as u64;
                    self.pulse = Some((rise, fall));
                    self.last_us = us;
                }
            }
            _ => {}
        }
    }

    pub fn poll(&mut self, now: u64, out: &mut Vec<Drive>) -> u64 {
        out.append(&mut self.out);
        let Some((rise, fall)) = self.pulse else { return u64::MAX };
        if !self.echo_high {
            if rise > now {
                return rise;
            }
            out.push((rise, self.echo, 1));
            self.echo_high = true;
        }
        if fall > now {
            return fall;
        }
        out.push((fall, self.echo, 0));
        self.echo_high = false;
        self.pulse = None;
        self.echoes += 1;
        u64::MAX
    }
}

/// SoC 里挂的这类器件
#[derive(Clone, Debug, Default)]
pub struct PinDevices {
    pub encoders: Vec<Encoder>,
    pub sonars: Vec<Hcsr04>,
}

impl PinDevices {
    pub fn is_empty(&self) -> bool {
        self.encoders.is_empty() && self.sonars.is_empty()
    }

    pub fn on_level(&mut self, t: u64, level: u64) {
        for s in &mut self.sonars {
            s.on_level(t, level);
        }
    }

    /// 到 now 为止的驱动（按时刻排好）与下一次需要再问的时刻
    pub fn poll(&mut self, now: u64) -> (Vec<Drive>, u64) {
        let mut out = Vec::new();
        let mut next = u64::MAX;
        for e in &mut self.encoders {
            next = next.min(e.poll(now, &mut out));
        }
        for s in &mut self.sonars {
            next = next.min(s.poll(now, &mut out));
        }
        out.sort_by_key(|d| d.0);
        (out, next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoder_quadrature_cw_then_ccw() {
        let mut e = Encoder::new(6, 7, Some(15), 0);
        let (d, _) = (e.poll(0, &mut Vec::new()), ());
        assert_eq!(d, u64::MAX);
        e.turn(1000, 1);
        e.turn(1000, -1);
        let mut out = Vec::new();
        let mut now = 1000;
        while now != u64::MAX {
            now = e.poll(now, &mut out);
        }
        // 顺时针：A 落、B 落、A 起、B 起；逆时针：B 落、A 落、B 起、A 起
        let seq: Vec<(u32, i8)> = out.iter().map(|d| (d.1, d.2)).collect();
        assert_eq!(seq, vec![(6, 0), (7, 0), (6, 1), (7, 1), (7, 0), (6, 0), (7, 1), (6, 1)]);
        assert_eq!(out[1].0 - out[0].0, ENC_EDGE_CYCLES);
        assert_eq!(e.position, 0);
    }

    #[test]
    fn sonar_echo_width() {
        let mut s = Hcsr04::new(17, 18, 0);
        s.distance_cm = Some(50.0);
        let us = CPU_HZ / 1_000_000;
        s.on_level(100 * us, 1 << 17);
        s.on_level(112 * us, 0);
        let mut out = Vec::new();
        let mut now = 0;
        loop {
            let n = s.poll(now, &mut out);
            if n == u64::MAX {
                break;
            }
            now = n;
        }
        let rise = out.iter().find(|d| d.2 == 1).unwrap().0;
        let fall = out.iter().rev().find(|d| d.2 == 0).unwrap().0;
        // 50 cm → 2 × 0.5 / 343 = 2915.5 µs
        assert!(((fall - rise) as f64 / us as f64 - 2915.45).abs() < 0.1);
        assert_eq!(rise, 112 * us + 250 * us);
        // 太短的触发（5 µs）不响应
        s.on_level(10_000 * us, 1 << 17);
        s.on_level(10_005 * us, 0);
        assert_eq!(s.pings, 1);
    }
}
