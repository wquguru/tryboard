//! QMI8658 六轴 IMU（I2C 0x6B / SA0 接地 0x6A）。寄存器按 QST《QMI8658C Datasheet》Rev 0.9：
//! WHO_AM_I（0x00 = 0x05）、REVISION_ID（0x01）、CTRL1（地址自增 ADDR_AI、SensorDisable）、CTRL2 / CTRL3
//! （加速度 / 陀螺量程与输出率）、CTRL7（aEN / gEN）、CTRL9 命令（STATUSINT.CmdDone 握手）、STATUS0（aDA / gDA）、
//! TIMESTAMP（24 位样本计数）、TEMP（/256 °C）、0x35..0x40 加速度 / 陀螺输出（小端）、RESET（0x60 写 0xB0）。
//!
//! 与真机的差别（写进 DECISIONS）：CTRL1.BE（大端）在 I2C 下不改变字节序——常见驱动（微雪示例、SensorLib）
//! 设了 0x60 仍按小端拼数，按它们的实际表现建模，未经真机标定；没做 FIFO、AttitudeEngine、运动检测、INT1/INT2 引脚。
//! CTRL1.ADDR_AI=0 时地址不自增（突发读一直读同一个寄存器），这是真机上常见的坑，照样复现。

use super::imu::{noise, to_i16, Pose};
use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

pub const WHO_AM_I: u8 = 0x05;
pub const REVISION: u8 = 0x7c;

pub struct Qmi8658 {
    pub addr: u8,
    pub pose: Pose,
    pub temp_c: f64,
    regs: [u8; 128],
    ptr: u8,
    expect_reg: bool,
    now: u64,
    /// 打开传感器（CTRL7 从 0 变非 0）的时刻
    on_at: u64,
    status_seen: u64,
    /// 读事务开始时锁存的 0x30..0x40（时间戳、温度、加速度、陀螺）
    latched: [u8; 17],
    pub reads: u64,
}

impl Qmi8658 {
    pub fn new(addr: u8) -> Self {
        let mut d = Qmi8658 {
            addr,
            pose: Pose::default(),
            temp_c: 23.5,
            regs: [0; 128],
            ptr: 0,
            expect_reg: false,
            now: 0,
            on_at: 0,
            status_seen: 0,
            latched: [0; 17],
            reads: 0,
        };
        d.reset();
        d
    }

    fn reset(&mut self) {
        self.regs = [0; 128];
        self.regs[0x00] = WHO_AM_I;
        self.regs[0x01] = REVISION;
        self.regs[0x02] = 0x20; // CTRL1 复位值
                                // 复位完成标志（新版数据手册 0x4D = 0x80；SensorLib 复位后查它）
        self.regs[0x4d] = 0x80;
        self.latched = [0; 17];
        self.status_seen = 0;
        self.on_at = self.now;
    }

    fn acc_on(&self) -> bool {
        self.regs[0x08] & 1 != 0 && self.regs[0x02] & 1 == 0
    }
    fn gyr_on(&self) -> bool {
        self.regs[0x08] & 2 != 0 && self.regs[0x02] & 1 == 0
    }

    /// 输出率（Hz）：陀螺开着时按陀螺的 7174.4 Hz 系列，只开加速度时按名义 8000 Hz 系列；12..15 是低功耗档
    fn odr(&self) -> f64 {
        if self.gyr_on() {
            let c = (self.regs[0x04] & 0xf).min(8);
            return 7174.4 / (1u32 << c) as f64;
        }
        match self.regs[0x03] & 0xf {
            c @ 0..=8 => 8000.0 / (1u32 << c) as f64,
            12 => 128.0,
            13 => 21.0,
            14 => 11.0,
            _ => 3.0,
        }
    }

    fn sample(&self) -> u64 {
        if !self.acc_on() && !self.gyr_on() {
            return 0;
        }
        let per = (CPU_HZ as f64 / self.odr()) as u64;
        self.now.saturating_sub(self.on_at) / per.max(1) + 1
    }

    fn compute(&self, n: u64) -> [u8; 17] {
        let mut out = [0u8; 17];
        out[0] = n as u8;
        out[1] = (n >> 8) as u8;
        out[2] = (n >> 16) as u8;
        let mut put = |i: usize, v: i16| {
            out[3 + 2 * i] = v as u8;
            out[4 + 2 * i] = (v >> 8) as u8;
        };
        // 温度：有符号 16 位，LSB = 1/256 °C
        put(0, to_i16(self.temp_c * 256.0));
        if self.acc_on() {
            let fs = 2u32 << ((self.regs[0x03] >> 4) & 7).min(3);
            let lsb = 32768.0 / fs as f64;
            let a = self.pose.accel_g();
            for (i, v) in a.iter().enumerate() {
                put(1 + i, to_i16((v + 0.003 * noise(n, i as u64)) * lsb));
            }
        }
        if self.gyr_on() {
            let fs = 16u32 << ((self.regs[0x04] >> 4) & 7);
            let lsb = 32768.0 / fs as f64;
            let g = self.pose.gyro_dps();
            for (i, v) in g.iter().enumerate() {
                put(4 + i, to_i16((v + 0.05 * noise(n, 4 + i as u64)) * lsb));
            }
        }
        out
    }

    fn write_reg(&mut self, r: u8, v: u8) {
        let r = r & 0x7f;
        match r {
            0x00 | 0x01 | 0x2d..=0x40 => {}
            0x08 => {
                let was = self.acc_on() || self.gyr_on();
                self.regs[0x08] = v;
                if !was && (self.acc_on() || self.gyr_on()) {
                    self.on_at = self.now;
                    self.status_seen = 0;
                }
            }
            0x0a => {
                // CTRL9 命令：执行完置 STATUSINT.CmdDone；主机写 CTRL_CMD_ACK（0x00）后清掉
                self.regs[0x0a] = v;
                if v == 0 {
                    self.regs[0x2d] &= !0x80;
                } else {
                    self.regs[0x2d] |= 0x80;
                }
            }
            0x60 => {
                if v == 0xb0 {
                    self.reset();
                }
            }
            _ => self.regs[r as usize] = v,
        }
    }

    fn read_reg(&mut self, r: u8) -> u8 {
        let r = r & 0x7f;
        match r {
            0x2e => {
                // STATUS0：有新样本就置 aDA / gDA，读一次清
                let n = self.sample();
                let fresh = n > self.status_seen;
                self.status_seen = n;
                if fresh {
                    self.acc_on() as u8 | (self.gyr_on() as u8) << 1
                } else {
                    0
                }
            }
            0x30..=0x40 => self.latched[(r - 0x30) as usize],
            _ => self.regs[r as usize],
        }
    }

    fn auto_inc(&self) -> bool {
        self.regs[0x02] & 0x40 != 0
    }
}

impl I2cDevice for Qmi8658 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn set_time(&mut self, now: u64) {
        self.now = now;
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        if read {
            self.reads += 1;
            if self.acc_on() || self.gyr_on() {
                self.latched = self.compute(self.sample());
            }
        }
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b & 0x7f;
            self.expect_reg = false;
        } else {
            self.write_reg(self.ptr, b);
            if self.auto_inc() {
                self.ptr = (self.ptr + 1) & 0x7f;
            }
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.read_reg(self.ptr);
        if self.auto_inc() {
            self.ptr = (self.ptr + 1) & 0x7f;
        }
        v
    }
    fn stop(&mut self) {}
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rd(d: &mut Qmi8658, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }
    fn wr(d: &mut Qmi8658, reg: u8, v: u8) {
        d.start(false);
        d.write(reg);
        d.write(v);
    }

    #[test]
    fn id_autoinc_and_readout() {
        let mut d = Qmi8658::new(0x6b);
        // 复位后 ADDR_AI=0：突发读停在同一个寄存器
        assert_eq!(rd(&mut d, 0x00, 2), [0x05, 0x05]);
        wr(&mut d, 0x02, 0x40);
        assert_eq!(rd(&mut d, 0x00, 2), [0x05, REVISION]);
        wr(&mut d, 0x03, 0x15); // ±4 g
        wr(&mut d, 0x04, 0x55); // ±512 °/s
        wr(&mut d, 0x08, 0x03);
        d.pose = Pose {
            pitch: -25.0,
            roll: 40.0,
            droll: 50.0,
            ..Pose::default()
        };
        d.set_time(CPU_HZ / 50);
        assert_eq!(rd(&mut d, 0x2e, 1), [3]);
        assert_eq!(rd(&mut d, 0x2e, 1), [0]);
        let b = rd(&mut d, 0x33, 14);
        let w = |i: usize| i16::from_le_bytes([b[2 * i], b[2 * i + 1]]) as f64;
        assert!((w(0) / 256.0 - 23.5).abs() < 0.01);
        let (ax, ay, az) = (w(1), w(2), w(3));
        assert!(((ax * ax + ay * ay + az * az).sqrt() - 8192.0).abs() < 60.0);
        let roll = ay.atan2(az).to_degrees();
        let pitch = (-ax).atan2((ay * ay + az * az).sqrt()).to_degrees();
        assert!(
            (pitch + 25.0).abs() < 0.5 && (roll - 40.0).abs() < 0.5,
            "{pitch} {roll}"
        );
        assert!((w(4) / 64.0 - 50.0).abs() < 0.2, "gx {}", w(4) / 64.0);
        // CTRL9 握手
        wr(&mut d, 0x0a, 0x01);
        assert_eq!(rd(&mut d, 0x2d, 1)[0] & 0x80, 0x80);
        wr(&mut d, 0x0a, 0x00);
        assert_eq!(rd(&mut d, 0x2d, 1)[0] & 0x80, 0);
        // 软复位：回到不自增、传感器关
        wr(&mut d, 0x60, 0xb0);
        assert_eq!(rd(&mut d, 0x02, 1), [0x20]);
        assert_eq!(rd(&mut d, 0x4d, 1), [0x80]);
    }
}
