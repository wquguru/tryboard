//! MPU-6050 六轴 IMU（I2C 0x68 / AD0 接高 0x69）。寄存器按 InvenSense《MPU-6000/MPU-6050 Register Map and
//! Descriptions》Rev 4.2：WHO_AM_I（0x75 恒为 0x68，与 AD0 无关）、PWR_MGMT_1（复位值 0x40 = 睡眠）、
//! SMPLRT_DIV / CONFIG（采样率）、GYRO_CONFIG / ACCEL_CONFIG（量程）、INT_STATUS（DATA_RDY）、
//! 0x3B..0x48 加速度 / 温度 / 陀螺输出（大端）。读写都自动递增寄存器地址。
//!
//! 输出由姿态算出（见 imu.rs），叠一点确定性噪声（加速度约 ±3 mg、陀螺约 ±0.05 °/s，量级取数据手册
//! 噪声密度 × 带宽的估算，未经真机标定）。一次读事务开始时锁存全部输出，突发读到的 14 字节属于同一个样本，
//! 与真机的影子寄存器一致。没做：FIFO（FIFO_COUNT 恒为 0）、DMP、自检、辅助 I2C、INT 引脚。

use super::imu::{noise, to_i16, Pose};
use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

pub const WHO_AM_I: u8 = 0x68;

pub struct Mpu6050 {
    pub addr: u8,
    pub pose: Pose,
    /// 芯片温度（°C）：取环境温度
    pub temp_c: f64,
    regs: [u8; 128],
    ptr: u8,
    expect_reg: bool,
    now: u64,
    /// 最近一次从睡眠醒来（或复位）的时刻：样本序号从这里数
    wake_at: u64,
    /// 上次读 INT_STATUS 时的样本序号（DATA_RDY 读清）
    status_seen: u64,
    /// 读事务开始时锁存的 0x3B..0x48
    latched: [u8; 14],
    pub reads: u64,
}

impl Mpu6050 {
    pub fn new(addr: u8) -> Self {
        let mut d = Mpu6050 {
            addr,
            pose: Pose::default(),
            temp_c: 23.5,
            regs: [0; 128],
            ptr: 0,
            expect_reg: false,
            now: 0,
            wake_at: 0,
            status_seen: 0,
            latched: [0; 14],
            reads: 0,
        };
        d.reset();
        d
    }

    fn reset(&mut self) {
        self.regs = [0; 128];
        self.regs[0x6b] = 0x40; // SLEEP
        self.regs[0x75] = WHO_AM_I;
        self.latched = [0; 14];
        self.wake_at = self.now;
        self.status_seen = 0;
    }

    fn sleeping(&self) -> bool {
        self.regs[0x6b] & 0x40 != 0
    }

    /// 采样周期（CPU 周期）：陀螺输出率 8 kHz（DLPF 关）或 1 kHz，÷ (1 + SMPLRT_DIV)
    fn sample_cycles(&self) -> u64 {
        let dlpf = self.regs[0x1a] & 7;
        let base = if dlpf == 0 || dlpf == 7 { 8000 } else { 1000 };
        CPU_HZ * (1 + self.regs[0x19] as u64) / base
    }

    /// 当前样本序号（醒着时从 1 开始数）
    fn sample(&self) -> u64 {
        if self.sleeping() {
            return 0;
        }
        (self.now.saturating_sub(self.wake_at)) / self.sample_cycles() + 1
    }

    /// 按姿态算一组输出（大端：AX AY AZ T GX GY GZ）
    fn compute(&self, n: u64) -> [u8; 14] {
        let afs = (self.regs[0x1c] >> 3) & 3;
        let gfs = (self.regs[0x1b] >> 3) & 3;
        let a_lsb = 16384.0 / (1u32 << afs) as f64;
        let g_lsb = 131.0 / (1u32 << gfs) as f64;
        let a = self.pose.accel_g();
        let g = self.pose.gyro_dps();
        let mut v = [0i16; 7];
        for i in 0..3 {
            v[i] = to_i16((a[i] + 0.003 * noise(n, i as u64)) * a_lsb);
            v[4 + i] = to_i16((g[i] + 0.05 * noise(n, 4 + i as u64)) * g_lsb);
        }
        // 数据手册：Temperature in °C = TEMP_OUT / 340 + 36.53
        v[3] = to_i16((self.temp_c - 36.53) * 340.0);
        let mut out = [0u8; 14];
        for (i, x) in v.iter().enumerate() {
            out[2 * i] = (*x >> 8) as u8;
            out[2 * i + 1] = *x as u8;
        }
        out
    }

    fn write_reg(&mut self, r: u8, v: u8) {
        let r = r & 0x7f;
        match r {
            0x6b => {
                if v & 0x80 != 0 {
                    self.reset();
                    return;
                }
                let was = self.sleeping();
                self.regs[0x6b] = v & 0x7f;
                if was && !self.sleeping() {
                    self.wake_at = self.now;
                    self.status_seen = 0;
                }
            }
            0x75 | 0x3a | 0x3b..=0x48 | 0x72 | 0x73 => {} // 只读
            0x68 => {}                                    // SIGNAL_PATH_RESET：只清滤波器，输出照常
            _ => self.regs[r as usize] = v,
        }
    }

    fn read_reg(&mut self, r: u8) -> u8 {
        let r = r & 0x7f;
        match r {
            0x3a => {
                // INT_STATUS：DATA_RDY 在有新样本时置位，读一次就清（INT_RD_CLEAR=0 的行为）
                let n = self.sample();
                let rdy = n > self.status_seen;
                self.status_seen = n;
                rdy as u8
            }
            0x3b..=0x48 => self.latched[(r - 0x3b) as usize],
            _ => self.regs[r as usize],
        }
    }
}

impl I2cDevice for Mpu6050 {
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
            // 睡眠时输出寄存器保持最后一次的值
            if !self.sleeping() {
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
            self.ptr = (self.ptr + 1) & 0x7f;
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.read_reg(self.ptr);
        self.ptr = (self.ptr + 1) & 0x7f;
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

    fn rd(d: &mut Mpu6050, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    fn wr(d: &mut Mpu6050, reg: u8, v: u8) {
        d.start(false);
        d.write(reg);
        d.write(v);
        d.stop();
    }

    #[test]
    fn who_am_i_and_wake() {
        let mut d = Mpu6050::new(0x69);
        assert_eq!(rd(&mut d, 0x75, 1), [0x68]);
        assert_eq!(rd(&mut d, 0x6b, 1), [0x40]);
        // 睡眠时输出全 0
        assert!(rd(&mut d, 0x3b, 14).iter().all(|b| *b == 0));
        wr(&mut d, 0x6b, 0x01);
        d.set_time(CPU_HZ / 100);
        d.pose = Pose::new(30.0, -20.0, 0.0);
        let b = rd(&mut d, 0x3b, 14);
        let w = |i: usize| i16::from_be_bytes([b[2 * i], b[2 * i + 1]]) as f64;
        let (ax, ay, az) = (w(0), w(1), w(2));
        let roll = ay.atan2(az).to_degrees();
        let pitch = (-ax).atan2((ay * ay + az * az).sqrt()).to_degrees();
        assert!(
            (pitch - 30.0).abs() < 0.5 && (roll + 20.0).abs() < 0.5,
            "{pitch} {roll}"
        );
        let t = w(3) / 340.0 + 36.53;
        assert!((t - 23.5).abs() < 0.01);
    }

    #[test]
    fn ranges_and_data_ready() {
        let mut d = Mpu6050::new(0x68);
        wr(&mut d, 0x6b, 0x00);
        wr(&mut d, 0x1c, 0x08); // ±4 g
        wr(&mut d, 0x1b, 0x18); // ±2000 °/s
        d.pose = Pose {
            dyaw: 100.0,
            ..Pose::default()
        };
        let b = rd(&mut d, 0x3b, 14);
        assert!((i16::from_be_bytes([b[4], b[5]]) as f64 - 8192.0).abs() < 40.0);
        assert!((i16::from_be_bytes([b[12], b[13]]) as f64 / 16.4 - 100.0).abs() < 0.2);
        // DATA_RDY 读清；1 kHz 下 1 ms 后再置位
        wr(&mut d, 0x1a, 0x03);
        assert_eq!(rd(&mut d, 0x3a, 1), [1]);
        assert_eq!(rd(&mut d, 0x3a, 1), [0]);
        d.set_time(CPU_HZ / 1000 + 1);
        assert_eq!(rd(&mut d, 0x3a, 1), [1]);
        // 复位回到睡眠
        wr(&mut d, 0x6b, 0x80);
        assert_eq!(rd(&mut d, 0x6b, 1), [0x40]);
    }
}
