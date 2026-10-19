//! MPU-6050 6-axis IMU (I2C 0x68 / 0x69 with AD0 high), registers per InvenSense "MPU-6000/MPU-6050 Register Map" Rev 4.2:
//! WHO_AM_I (0x75 = 0x68 regardless of AD0), PWR_MGMT_1 (reset 0x40 = sleep), SMPLRT_DIV / CONFIG (rate), GYRO/ACCEL_CONFIG
//! (range), INT_STATUS (DATA_RDY), 0x3B..0x48 accel/temp/gyro (BE). Reads and writes auto-increment.
//! Output comes from the pose (imu.rs) plus deterministic noise (~±3 mg, ~±0.05 °/s from datasheet noise density x bandwidth,
//! not calibrated on hardware). All outputs latch at the start of a read so a 14-byte burst is one sample, like the real
//! shadow registers. Not done: FIFO (FIFO_COUNT always 0), DMP, self-test, aux I2C, INT pin. (lint: allow-long-comment)

use super::imu::{noise, to_i16, Pose};
use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

pub const WHO_AM_I: u8 = 0x68;

pub struct Mpu6050 {
    pub addr: u8,
    pub pose: Pose,
    /// Die temperature (°C): uses ambient temperature
    pub temp_c: f64,
    regs: [u8; 128],
    ptr: u8,
    expect_reg: bool,
    now: u64,
    /// Time of the last wake from sleep (or reset): sample numbers count from here
    wake_at: u64,
    /// Sample number at the last INT_STATUS read (DATA_RDY clears on read)
    status_seen: u64,
    /// 0x3B..0x48 latched at the start of a read
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

    /// Sample period (CPU cycles): gyro output rate 8 kHz (DLPF off) or 1 kHz, / (1 + SMPLRT_DIV)
    fn sample_cycles(&self) -> u64 {
        let dlpf = self.regs[0x1a] & 7;
        let base = if dlpf == 0 || dlpf == 7 { 8000 } else { 1000 };
        CPU_HZ * (1 + self.regs[0x19] as u64) / base
    }

    /// Current sample number (counted from 1 while awake)
    fn sample(&self) -> u64 {
        if self.sleeping() {
            return 0;
        }
        (self.now.saturating_sub(self.wake_at)) / self.sample_cycles() + 1
    }

    /// Compute one set of outputs from the pose (BE: AX AY AZ T GX GY GZ)
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
        // Datasheet: Temperature in °C = TEMP_OUT / 340 + 36.53
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
            0x75 | 0x3a | 0x3b..=0x48 | 0x72 | 0x73 => {} // read-only
            0x68 => {} // SIGNAL_PATH_RESET: only clears filters, output unaffected
            _ => self.regs[r as usize] = v,
        }
    }

    fn read_reg(&mut self, r: u8) -> u8 {
        let r = r & 0x7f;
        match r {
            0x3a => {
                // INT_STATUS: DATA_RDY set on a new sample, cleared by one read (INT_RD_CLEAR=0 behaviour)
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
            // Output registers hold their last value while asleep
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
        // Asleep: outputs all zero
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
        // DATA_RDY clears on read; at 1 kHz it sets again after 1 ms
        wr(&mut d, 0x1a, 0x03);
        assert_eq!(rd(&mut d, 0x3a, 1), [1]);
        assert_eq!(rd(&mut d, 0x3a, 1), [0]);
        d.set_time(CPU_HZ / 1000 + 1);
        assert_eq!(rd(&mut d, 0x3a, 1), [1]);
        // Reset goes back to sleep
        wr(&mut d, 0x6b, 0x80);
        assert_eq!(rd(&mut d, 0x6b, 1), [0x40]);
    }
}
