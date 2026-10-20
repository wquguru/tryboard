//! BMM150 3-axis magnetometer (I2C 0x10..0x13; on M5 AtomS3R / CoreS3 it sits behind the BMI270 AUX interface, see bmi270.rs), per the
//! Bosch BMM150 datasheet: 0x40 chip ID 0x32 (reads 0 in suspend), 0x42..0x49 DATAX / DATAY (13 bit, bits 15:3), DATAZ (15 bit, bits 15:1),
//! RHALL (14 bit, bits 15:2; bit0 data ready), 0x4B power control (bit0 power, bits 7 + 1 soft reset), 0x4C opmode bits 2:1 (normal /
//! forced / sleep) + ODR bits 5:3, the rest storage. Suspend (power bit 0) reads 0 everywhere but 0x4B. Output is the pose-rotated world
//! field (`field_ut`, X north, Y west, Z up) at ~0.3 µT / LSB X/Y and ~0.15 µT / LSB Z, **uncompensated** (trim registers read 0, so
//! Bosch's compensation formula does not apply; M5Unified uses the raw values). Estimate, not calibrated on hardware. (lint: allow-long-comment)

use super::imu::{mount, noise, Mount, Pose, MOUNT_IDENTITY};
use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

pub const CHIP_ID: u8 = 0x32;
/// Default world field: ~25 µT horizontal towards north, ~40 µT downwards (mid northern latitude, estimate)
pub const EARTH_FIELD_UT: [f64; 3] = [25.0, 0.0, -40.0];
const RHALL: i16 = 6000;

pub struct Bmm150 {
    pub addr: u8,
    pub pose: Pose,
    /// Chip axes against the board's (pose) axes
    pub mount: Mount,
    pub field_ut: [f64; 3],
    regs: [u8; 128],
    ptr: u8,
    expect_reg: bool,
    now: u64,
    /// Sample number of the last data latch (data-ready clears once the data is read)
    latched_n: u64,
    latched: [u8; 8],
    /// Forced mode: one measurement pending
    forced: bool,
    pub reads: u64,
}

impl Bmm150 {
    pub fn new(addr: u8) -> Self {
        let mut d = Bmm150 {
            addr,
            pose: Pose::default(),
            mount: MOUNT_IDENTITY,
            field_ut: EARTH_FIELD_UT,
            regs: [0; 128],
            ptr: 0,
            expect_reg: false,
            now: 0,
            latched_n: 0,
            latched: [0; 8],
            forced: false,
            reads: 0,
        };
        d.reset(false);
        d
    }

    fn reset(&mut self, powered: bool) {
        self.regs = [0; 128];
        self.regs[0x4b] = powered as u8;
        self.regs[0x4c] = 0x06; // sleep, 10 Hz
        self.regs[0x4e] = 0x07;
        self.latched = [0; 8];
        self.latched_n = 0;
        self.forced = false;
    }

    pub fn set_now(&mut self, now: u64) {
        self.now = now;
    }

    fn powered(&self) -> bool {
        self.regs[0x4b] & 1 != 0
    }

    fn normal(&self) -> bool {
        self.powered() && self.regs[0x4c] & 0x06 == 0
    }

    fn sample(&self) -> u64 {
        const ODR: [u64; 8] = [10, 2, 6, 8, 15, 20, 25, 30];
        if !self.normal() {
            return self.latched_n + self.forced as u64;
        }
        self.now / (CPU_HZ / ODR[((self.regs[0x4c] >> 3) & 7) as usize]) + 1
    }

    fn compute(&self, n: u64) -> [u8; 8] {
        let b = mount(&self.mount, self.pose.world_to_sensor(self.field_ut));
        let q = |v: f64, lsb: f64, max: f64, ch: u64| {
            ((v + 0.3 * noise(n, 20 + ch)) / lsb)
                .round()
                .clamp(-max, max) as i16
        };
        let x = q(b[0], 0.3, 4095.0, 0) << 3;
        let y = q(b[1], 0.3, 4095.0, 1) << 3;
        let z = q(b[2], 0.15, 16383.0, 2) << 1;
        let mut out = [0u8; 8];
        for (i, v) in [x, y, z, RHALL << 2].iter().enumerate() {
            out[2 * i..2 * i + 2].copy_from_slice(&v.to_le_bytes());
        }
        out
    }

    /// Start of a data read (0x42..0x49): latch one sample so a burst is coherent
    fn latch(&mut self) {
        let n = self.sample();
        if n > self.latched_n {
            self.latched = self.compute(n);
            self.latched_n = n;
            self.forced = false;
        }
    }

    pub fn read_reg(&mut self, r: u8) -> u8 {
        let r = r & 0x7f;
        if r == 0x4b {
            return self.regs[0x4b];
        }
        if !self.powered() {
            return 0;
        }
        match r {
            0x40 => CHIP_ID,
            0x42..=0x47 => self.latched[(r - 0x42) as usize],
            0x48 => self.latched[6] | (self.sample() > self.latched_n) as u8,
            0x49 => self.latched[7],
            _ => self.regs[r as usize],
        }
    }

    pub fn write_reg(&mut self, r: u8, v: u8) {
        let r = r & 0x7f;
        if r == 0x4b {
            if v & 0x82 != 0 {
                self.reset(v & 1 != 0);
            } else {
                self.regs[0x4b] = v & 0x01;
                if v & 1 == 0 {
                    self.reset(false);
                }
            }
            return;
        }
        if !self.powered() || matches!(r, 0x40..=0x4a) {
            return;
        }
        if r == 0x4c && (v >> 1) & 3 == 1 {
            // Forced: one measurement, then back to sleep
            self.forced = true;
            self.regs[0x4c] = (v & !0x06) | 0x06;
            return;
        }
        self.regs[r as usize] = v;
    }

    /// Burst read as a bus master sees it (address auto-increments); latches first when it touches the data block
    pub fn read_burst(&mut self, reg: u8, n: usize) -> Vec<u8> {
        if (0x42..=0x49).contains(&reg) && self.powered() {
            self.latch();
        }
        (0..n)
            .map(|i| self.read_reg(reg.wrapping_add(i as u8)))
            .collect()
    }
}

impl I2cDevice for Bmm150 {
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
            if (0x42..=0x49).contains(&self.ptr) && self.powered() {
                self.latch();
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

    /// Decode a 0x42 burst into µT (X / Y 13 bit, Z 15 bit)
    fn decode(b: &[u8]) -> [f64; 3] {
        let w = |i: usize| i16::from_le_bytes([b[2 * i], b[2 * i + 1]]);
        [
            (w(0) >> 3) as f64 * 0.3,
            (w(1) >> 3) as f64 * 0.3,
            (w(2) >> 1) as f64 * 0.15,
        ]
    }

    #[test]
    fn suspend_id_and_heading() {
        let mut d = Bmm150::new(0x10);
        assert_eq!(d.read_burst(0x40, 1), [0x00]);
        // M5Unified: soft reset + power on, then normal mode 30 Hz
        d.write_reg(0x4b, 0x83);
        assert_eq!(d.read_burst(0x40, 1), [CHIP_ID]);
        assert_eq!(d.read_burst(0x4b, 1), [0x01]);
        d.write_reg(0x4c, 0x38);
        assert_eq!(d.read_burst(0x4c, 1), [0x38]);
        d.set_now(CPU_HZ / 10);
        assert_eq!(d.read_reg(0x48) & 1, 1);
        let m = decode(&d.read_burst(0x42, 8));
        assert!(
            (m[0] - 25.0).abs() < 1.0 && m[1].abs() < 1.0 && (m[2] + 40.0).abs() < 1.0,
            "{m:?}"
        );
        assert_eq!(d.read_reg(0x48) & 1, 0);
        // Turn 90° to the west: north now along sensor -Y
        d.pose = Pose::new(0.0, 0.0, 90.0);
        d.set_now(CPU_HZ / 5);
        let m = decode(&d.read_burst(0x42, 6));
        assert!(m[0].abs() < 1.0 && (m[1] + 25.0).abs() < 1.0, "{m:?}");
    }
}
