//! 引脚 / 总线事件记录（逻辑分析仪，P1-05）：有上限的环形缓冲，按 CPU 周期盖戳。
//! C3 / S3 两颗芯片的 SocBus 各有一份；CLI `--trace-io` 与 wasm `tb_io_take` 读同一份事件序列。
//!
//! 记录什么、为什么这样记（格式与上限见 docs/DECISIONS.md「事件缓冲」）：
//! - GPIO 电平变化：只记被观察（watch 掩码）的引脚。固件逐位翻转的引脚每秒可达上百万次变化，全记会拖慢模拟、塞满缓冲
//! - LEDC：引脚上的 PWM（占空比、频率）变了才记一条，不逐周期出波形（与 LEDC 模型的约定一致）
//! - RMT：挂在引脚上的 WS2812 解码器每提交一帧记一条（灯珠数 + 第一颗颜色），不记 800kHz 的逐位跳变
//! - I2C：来自主机模型的事务层（起始 / 地址 + 读写 / 每字节 + ACK/NACK / 停止），时刻按 SCL 位时序推算，不逐 SCL 边沿
//!
//! 所有字段都是整数（频率记毫赫、占空比记 1/65535），文本格式在 Rust 和 TS 两边逐字相同，才能对拍。

use std::collections::VecDeque;

/// 默认上限：65536 条 × 16 字节 = 1MB。网页 worker 每个时间片批次（≤ 20ms）取走一次，正常用不满
pub const DEFAULT_CAP: usize = 1 << 16;

pub mod kind {
    pub const GPIO: u8 = 1;
    pub const PWM: u8 = 2;
    pub const WS2812: u8 = 3;
    pub const I2C_START: u8 = 10;
    pub const I2C_ADDR: u8 = 11;
    pub const I2C_DATA: u8 = 12;
    pub const I2C_STOP: u8 = 13;
}

/// I2C 事件 b 字段的位
pub mod i2cbit {
    /// 地址字节的 R/W 位；数据字节的方向（1 = 从机发、主机读）
    pub const READ: u16 = 1;
    /// 这个字节之后的第 9 位是 NACK（地址 / 写：从机没应答；读：主机不再要）
    pub const NACK: u16 = 2;
    /// START 事件：重复起始
    pub const RESTART: u16 = 4;
    /// 第几个 I2C 控制器（S3 有 I2C1）
    pub const PORT1: u16 = 1 << 15;
}

/// 一条事件，16 字节小端：t u64 | kind u8 | a u8 | b u16 | v u32
/// - GPIO：a = 引脚，b = 电平
/// - PWM：a = 引脚，b = 占空比 × 65535（四舍五入），v = 频率（毫赫，0 = 不再输出 PWM）
/// - WS2812：a = 引脚，b = 灯珠数，v = 第一颗 0xRRGGBB
/// - I2C_START：b = RESTART / PORT1 位，v = 一个 SCL 位折合多少 CPU 周期（前端按它画 SDA/SCL）
/// - I2C_ADDR：a = 7 位地址，b = READ / NACK / PORT1
/// - I2C_DATA：a = 字节，b = READ（方向）/ NACK / PORT1
/// - I2C_STOP：b = PORT1
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct IoEvent {
    pub t: u64,
    pub kind: u8,
    pub a: u8,
    pub b: u16,
    pub v: u32,
}

impl IoEvent {
    pub const BYTES: usize = 16;

    pub fn to_bytes(&self) -> [u8; 16] {
        let mut o = [0u8; 16];
        o[..8].copy_from_slice(&self.t.to_le_bytes());
        o[8] = self.kind;
        o[9] = self.a;
        o[10..12].copy_from_slice(&self.b.to_le_bytes());
        o[12..16].copy_from_slice(&self.v.to_le_bytes());
        o
    }

    /// 一行文本（CLI `--trace-io` 文件与网页 `web/src/app/iotrace.ts` 的 `eventLine` 逐字相同）
    pub fn line(&self) -> String {
        use i2cbit::*;
        let port = if self.b & PORT1 != 0 { "I2C1" } else { "I2C0" };
        let dir = |b: u16| if b & READ != 0 { "R" } else { "W" };
        let ack = |b: u16| if b & NACK != 0 { "NACK" } else { "ACK" };
        match self.kind {
            kind::GPIO => format!("{} GPIO {} {}", self.t, self.a, self.b),
            kind::PWM => format!("{} PWM {} {} {}", self.t, self.a, self.b, self.v),
            kind::WS2812 => format!("{} WS2812 {} {} {:06x}", self.t, self.a, self.b, self.v),
            kind::I2C_START => format!(
                "{} {port} {} {}",
                self.t,
                if self.b & RESTART != 0 {
                    "RESTART"
                } else {
                    "START"
                },
                self.v
            ),
            kind::I2C_ADDR => format!(
                "{} {port} ADDR {:02x} {} {}",
                self.t,
                self.a,
                dir(self.b),
                ack(self.b)
            ),
            kind::I2C_DATA => format!(
                "{} {port} DATA {:02x} {} {}",
                self.t,
                self.a,
                dir(self.b),
                ack(self.b)
            ),
            kind::I2C_STOP => format!("{} {port} STOP", self.t),
            k => format!("{} ? {k} {} {} {}", self.t, self.a, self.b, self.v),
        }
    }
}

pub struct IoTrace {
    pub buf: VecDeque<IoEvent>,
    pub cap: usize,
    /// 缓冲满了被挤掉的条数（最老的先丢）
    pub dropped: u64,
    /// 被观察的 GPIO（位 = 引脚号）；PWM / WS2812 / I2C 不受它限制（变化本来就少）
    pub watch: u64,
    gpio_last: u64,
    /// 各引脚上次记下的 PWM（占空比 u16, 频率 mHz）；频率 0 = 没有 PWM
    pwm_last: [(u16, u32); 64],
    /// GPIO 矩阵 / 使能改过：下次 update 重新扫一遍各引脚的 PWM
    pub pwm_dirty: bool,
    /// 上次扫描时 LEDC 的修改计数
    pub ledc_rev: u64,
}

impl IoTrace {
    /// reset_level：上电时引脚电平（与 SocBus 的 gpio_log 起点一致）
    pub fn new(reset_level: u64) -> Self {
        IoTrace {
            buf: VecDeque::new(),
            cap: DEFAULT_CAP,
            dropped: 0,
            watch: 0,
            gpio_last: reset_level,
            pwm_last: [(0, 0); 64],
            pwm_dirty: true,
            ledc_rev: u64::MAX,
        }
    }

    #[inline]
    pub fn push(&mut self, e: IoEvent) {
        if self.cap == 0 {
            return;
        }
        if self.buf.len() >= self.cap {
            self.buf.pop_front();
            self.dropped += 1;
        }
        self.buf.push_back(e);
    }

    pub fn extend(&mut self, v: &mut Vec<IoEvent>) {
        for e in v.drain(..) {
            self.push(e);
        }
    }

    /// 引脚电平（全部引脚）可能变了：只给被观察且确实变了的引脚记事件
    #[inline]
    pub fn gpio(&mut self, now: u64, level: u64) {
        let diff = (level ^ self.gpio_last) & self.watch;
        self.gpio_last = level;
        if diff == 0 {
            return;
        }
        let mut d = diff;
        while d != 0 {
            let pin = d.trailing_zeros();
            d &= d - 1;
            self.push(IoEvent {
                t: now,
                kind: kind::GPIO,
                a: pin as u8,
                b: (level >> pin & 1) as u16,
                v: 0,
            });
        }
    }

    /// 要不要重新扫 PWM：LEDC 改过（rev 变了）或 GPIO 矩阵 / 使能改过
    #[inline]
    pub fn pwm_scan_needed(&self, ledc_rev: u64) -> bool {
        self.pwm_dirty || ledc_rev != self.ledc_rev
    }

    /// 一个引脚此刻的 PWM（None = 没有）；与上次记下的不同就记一条
    pub fn pwm(&mut self, now: u64, pin: usize, p: Option<(f32, f32)>) {
        let cur = match p {
            Some((d, f)) if f > 0.0 => (
                ((d as f64).clamp(0.0, 1.0) * 65535.0).round() as u16,
                ((f as f64) * 1000.0).round().min(u32::MAX as f64) as u32,
            ),
            _ => (0, 0),
        };
        if pin >= 64 || self.pwm_last[pin] == cur {
            return;
        }
        self.pwm_last[pin] = cur;
        self.push(IoEvent {
            t: now,
            kind: kind::PWM,
            a: pin as u8,
            b: cur.0,
            v: cur.1,
        });
    }

    pub fn ws2812(&mut self, now: u64, pin: u32, rgb: &[[u8; 3]]) {
        let first = rgb
            .first()
            .map(|c| (c[0] as u32) << 16 | (c[1] as u32) << 8 | c[2] as u32)
            .unwrap_or(0);
        self.push(IoEvent {
            t: now,
            kind: kind::WS2812,
            a: pin as u8,
            b: rgb.len().min(u16::MAX as usize) as u16,
            v: first,
        });
    }

    /// 取走缓冲里的全部事件（按记录先后）
    pub fn take(&mut self) -> Vec<IoEvent> {
        self.buf.drain(..).collect()
    }

    /// 软件复位后搬到新总线：缓冲、观察设置、已记下的 PWM 状态都保留（模拟时间继续）
    pub fn carry(&mut self) -> IoTrace {
        let mut t = IoTrace::new(self.gpio_last);
        std::mem::swap(&mut t.buf, &mut self.buf);
        t.cap = self.cap;
        t.dropped = self.dropped;
        t.watch = self.watch;
        t.pwm_last = self.pwm_last;
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_cap_and_gpio_watch() {
        let mut t = IoTrace::new(0);
        t.cap = 3;
        t.watch = 1 << 4;
        t.gpio(10, 1 << 4 | 1 << 5); // 只记 GPIO4
        t.gpio(20, 1 << 5);
        t.gpio(30, 1 << 4);
        t.gpio(40, 0);
        assert_eq!(t.buf.len(), 3);
        assert_eq!(t.dropped, 1);
        let v = t.take();
        assert_eq!(
            v.iter().map(|e| (e.t, e.a, e.b)).collect::<Vec<_>>(),
            vec![(20, 4, 0), (30, 4, 1), (40, 4, 0)]
        );
    }

    #[test]
    fn pwm_dedup_and_lines() {
        let mut t = IoTrace::new(0);
        t.pwm(1, 4, Some((0.08375, 50.0)));
        t.pwm(2, 4, Some((0.08375, 50.0)));
        t.pwm(3, 4, None);
        let v = t.take();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].line(), "1 PWM 4 5489 50000");
        assert_eq!(v[1].line(), "3 PWM 4 0 0");
        let e = IoEvent {
            t: 5,
            kind: kind::I2C_ADDR,
            a: 0x76,
            b: i2cbit::READ,
            v: 0,
        };
        assert_eq!(e.line(), "5 I2C0 ADDR 76 R ACK");
        let b = e.to_bytes();
        assert_eq!(b[8], kind::I2C_ADDR);
        assert_eq!(b[9], 0x76);
    }
}
