//! BMI270 6-axis IMU (I2C 0x68 / 0x69) with a BMM150 on its AUX master, per the Bosch BMI270 datasheet: 0x00 CHIP_ID 0x24, 0x03 STATUS
//! (bit4 cmd_rdy, bit2 aux_busy = 0 since AUX ops finish at once, bits 7..5 drdy acc / gyr / aux), 0x04..0x0B AUX data, 0x0C..0x11 ACC,
//! 0x12..0x17 GYR (LE), 0x18..0x1A SENSORTIME, 0x1D INT_STATUS_1 (bits 7..5 drdy, clear on read), 0x21 INTERNAL_STATUS (0 not_init,
//! 1 init_ok, 2 init_err), 0x22/23 temperature (t - 23) * 512, 0x40..0x43 ACC / GYR conf + range, 0x44 AUX_CONF, 0x4B AUX_DEV_ID
//! (addr << 1), 0x4C AUX_IF_CONF (bit7 manual, bits 3:2 manual burst, 1:0 data-mode burst: 1 / 2 / 6 / 8 bytes), 0x4D AUX_RD_ADDR (manual:
//! read now), 0x4E AUX_WR_ADDR (manual: write 0x4F now), 0x59 INIT_CTRL, 0x5B/5C INIT_ADDR (16-bit words), 0x5E INIT_DATA (no
//! auto-increment: the 8 KB config burst lands in config RAM), 0x6B IF_CONF, 0x7C PWR_CONF (0x03 after reset), 0x7D PWR_CTRL (bit3 temp,
//! 2 acc, 1 gyr, 0 aux), 0x7E CMD (0xB6 soft reset). INIT_CTRL = 1 reports init_ok once >= 8192 config bytes arrived, else init_err (the
//! blob itself is not checked or run). Data follow the pose (imu.rs) with the same noise as mpu6050.rs; in AUX data mode the BMM150 is
//! read at each latch. Not done: FIFO (length 0), feature engine (step counter, gestures), INT pins, self-test, OIS. (lint: allow-long-comment)

use super::bmm150::Bmm150;
use super::imu::{mount, noise, to_i16, Mount, Pose, MOUNT_IDENTITY};
use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

pub const CHIP_ID: u8 = 0x24;
pub const CONFIG_SIZE: usize = 8192;

pub struct Bmi270 {
    pub addr: u8,
    pub pose: Pose,
    /// Chip axes against the board's (pose) axes
    pub mount: Mount,
    pub temp_c: f64,
    /// Magnetometer on the AUX bus (AUX_DEV_ID must name its address)
    pub aux: Option<Bmm150>,
    regs: [u8; 128],
    ptr: u8,
    expect_reg: bool,
    now: u64,
    config: Vec<u8>,
    config_pos: usize,
    pub config_bytes: usize,
    internal_status: u8,
    /// Sample numbers already reported by INT_STATUS_1 (acc, gyr, aux)
    seen: [u64; 3],
    pub reads: u64,
}

/// ODR code (bits 3:0 of ACC / GYR / AUX_CONF) -> samples per second: 100 Hz * 2^(odr - 8)
fn odr_hz(code: u8) -> f64 {
    100.0 * 2f64.powi(code.clamp(1, 13) as i32 - 8)
}

impl Bmi270 {
    pub fn new(addr: u8) -> Self {
        let mut d = Bmi270 {
            addr,
            pose: Pose::default(),
            mount: MOUNT_IDENTITY,
            temp_c: 23.5,
            aux: Some(Bmm150::new(0x10)),
            regs: [0; 128],
            ptr: 0,
            expect_reg: false,
            now: 0,
            config: vec![0; CONFIG_SIZE],
            config_pos: 0,
            config_bytes: 0,
            internal_status: 0,
            seen: [0; 3],
            reads: 0,
        };
        d.reset();
        d
    }

    fn reset(&mut self) {
        let r = &mut self.regs;
        *r = [0; 128];
        r[0x00] = CHIP_ID;
        r[0x40] = 0xa8; // ACC 100 Hz, normal averaging
        r[0x41] = 0x02; // ±8 g
        r[0x42] = 0xa9; // GYR 200 Hz
        r[0x44] = 0x46; // AUX 25 Hz
        r[0x48] = 0x02;
        r[0x49] = 0x10;
        r[0x4b] = 0x20;
        r[0x4c] = 0x83;
        r[0x4d] = 0x42;
        r[0x4e] = 0x4c;
        r[0x4f] = 0x02;
        r[0x7c] = 0x03; // adv_power_save + fifo_self_wakeup
        self.config.iter_mut().for_each(|b| *b = 0);
        self.config_pos = 0;
        self.config_bytes = 0;
        self.internal_status = 0;
        self.seen = [0; 3];
    }

    fn pwr(&self, bit: u8) -> bool {
        self.regs[0x7d] & bit != 0
    }

    fn sample(&self, conf: usize) -> u64 {
        let period = (CPU_HZ as f64 / odr_hz(self.regs[conf] & 15)) as u64;
        self.now / period.max(1) + 1
    }

    /// New-sample flags (acc, gyr, aux) for enabled sensors
    fn pending(&self) -> [(bool, u64); 3] {
        let one = |en: bool, conf: usize, i: usize| {
            let n = if en { self.sample(conf) } else { 0 };
            (en && n > self.seen[i], n)
        };
        [
            one(self.pwr(0x04), 0x40, 0),
            one(self.pwr(0x02), 0x42, 1),
            one(self.pwr(0x01) && self.regs[0x4c] & 0x80 == 0, 0x44, 2),
        ]
    }

    fn drdy_bits(&self) -> u8 {
        let p = self.pending();
        (p[0].0 as u8) << 7 | (p[1].0 as u8) << 6 | (p[2].0 as u8) << 5
    }

    fn aux_dev(&mut self) -> Option<&mut Bmm150> {
        let id = self.regs[0x4b] >> 1;
        let on = self.regs[0x6b] & 0x20 != 0;
        let (now, pose) = (self.now, self.pose);
        match self.aux.as_mut() {
            Some(m) if on && m.addr == id => {
                m.set_now(now);
                m.pose = pose;
                Some(m)
            }
            _ => None,
        }
    }

    fn burst_len(code: u8) -> usize {
        [1, 2, 6, 8][(code & 3) as usize]
    }

    /// AUX burst from the magnetometer into 0x04..; a missing device leaves the registers as they were
    fn aux_read(&mut self, reg: u8, n: usize) {
        if let Some(m) = self.aux_dev() {
            let v = m.read_burst(reg, n);
            self.regs[0x04..0x04 + n].copy_from_slice(&v);
        }
    }

    /// Latch outputs at the start of a read so a 20-byte burst is one sample
    fn latch(&mut self) {
        let afs = (self.regs[0x41] & 3) as i32;
        let gfs = (self.regs[0x43] & 7).min(4) as i32;
        if self.pwr(0x04) {
            let n = self.sample(0x40);
            let a = mount(&self.mount, self.pose.accel_g());
            for (i, ai) in a.iter().enumerate() {
                let lsb = 16384.0 / 2f64.powi(afs);
                let v = to_i16((ai + 0.003 * noise(n, i as u64)) * lsb);
                self.regs[0x0c + 2 * i..0x0e + 2 * i].copy_from_slice(&v.to_le_bytes());
            }
        }
        if self.pwr(0x02) {
            let n = self.sample(0x42);
            let g = mount(&self.mount, self.pose.gyro_dps());
            for (i, gi) in g.iter().enumerate() {
                let lsb = 16.384 * 2f64.powi(gfs);
                let v = to_i16((gi + 0.05 * noise(n, 4 + i as u64)) * lsb);
                self.regs[0x12 + 2 * i..0x14 + 2 * i].copy_from_slice(&v.to_le_bytes());
            }
        }
        if self.pwr(0x01) && self.regs[0x4c] & 0x80 == 0 {
            let (reg, n) = (self.regs[0x4d], Self::burst_len(self.regs[0x4c]));
            self.aux_read(reg, n);
        }
    }

    fn read_reg(&mut self, r: u8) -> u8 {
        let r = r & 0x7f;
        match r {
            0x03 => 0x10 | self.drdy_bits(),
            0x18..=0x1a => {
                // SENSORTIME: 24-bit counter, 39.0625 µs per tick
                let t = self.now / (CPU_HZ / 25_600);
                (t >> (8 * (r - 0x18))) as u8
            }
            0x1d => {
                let p = self.pending();
                for (i, (_, n)) in p.iter().enumerate() {
                    if p[i].0 {
                        self.seen[i] = *n;
                    }
                }
                (p[0].0 as u8) << 7 | (p[1].0 as u8) << 6 | (p[2].0 as u8) << 5
            }
            0x21 => self.internal_status,
            0x22 | 0x23 => {
                let v: i16 = if self.pwr(0x08) {
                    to_i16((self.temp_c - 23.0) * 512.0)
                } else {
                    i16::MIN // 0x8000: invalid
                };
                v.to_le_bytes()[(r - 0x22) as usize]
            }
            0x24 | 0x25 => 0,
            0x26 => 0x80, // FIFO empty
            0x5e => self.config.get(self.config_pos).copied().unwrap_or(0),
            _ => self.regs[r as usize],
        }
    }

    fn write_reg(&mut self, r: u8, v: u8) {
        let r = r & 0x7f;
        match r {
            0x00..=0x2e => {} // read-only status / data
            0x7e => {
                if v == 0xb6 {
                    self.reset();
                }
            }
            0x59 => {
                self.regs[0x59] = v;
                if v & 1 != 0 {
                    self.internal_status = if self.config_bytes >= CONFIG_SIZE {
                        1
                    } else {
                        2
                    };
                }
            }
            0x5b | 0x5c => {
                self.regs[r as usize] = v;
                let word = ((self.regs[0x5c] as usize) << 4) | (self.regs[0x5b] & 0x0f) as usize;
                self.config_pos = word * 2;
            }
            0x5e => {
                if let Some(b) = self.config.get_mut(self.config_pos) {
                    *b = v;
                    self.config_bytes += 1;
                }
                self.config_pos += 1;
            }
            0x4d => {
                self.regs[0x4d] = v;
                if self.regs[0x4c] & 0x80 != 0 {
                    let n = Self::burst_len(self.regs[0x4c] >> 2);
                    self.aux_read(v, n);
                }
            }
            0x4e => {
                self.regs[0x4e] = v;
                if self.regs[0x4c] & 0x80 != 0 {
                    let data = self.regs[0x4f];
                    if let Some(m) = self.aux_dev() {
                        m.write_reg(v, data);
                    }
                }
            }
            _ => self.regs[r as usize] = v,
        }
    }
}

impl I2cDevice for Bmi270 {
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
            if (0x04..=0x17).contains(&self.ptr) {
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
            // INIT_DATA is a port into config RAM: the burst stays on 0x5E
            if self.ptr != 0x5e {
                self.ptr = (self.ptr + 1) & 0x7f;
            }
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.read_reg(self.ptr);
        if self.ptr != 0x5e && self.ptr != 0x26 {
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

    fn rd(d: &mut Bmi270, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    fn wr(d: &mut Bmi270, reg: u8, data: &[u8]) {
        d.start(false);
        d.write(reg);
        for b in data {
            d.write(*b);
        }
        d.stop();
    }

    /// M5Unified BMI270_Class::begin up to the AUX setup; returns the 0x21 value
    fn begin(d: &mut Bmi270, blob: usize) -> u8 {
        assert_eq!(rd(d, 0x00, 1), [CHIP_ID]);
        wr(d, 0x7e, &[0xb6]);
        assert_ne!(rd(d, 0x7c, 1), [0]);
        wr(d, 0x7c, &[0x00]);
        wr(d, 0x5b, &[0, 0]);
        wr(d, 0x5e, &vec![0x5a; blob]);
        wr(d, 0x59, &[0x01]);
        wr(d, 0x58, &[0xff]);
        rd(d, 0x21, 1)[0]
    }

    fn aux_write(d: &mut Bmi270, reg: u8, v: u8) {
        wr(d, 0x4f, &[v]);
        wr(d, 0x4e, &[reg]);
        assert_eq!(rd(d, 0x03, 1)[0] & 0x04, 0);
    }

    fn aux_read(d: &mut Bmi270, reg: u8) -> u8 {
        wr(d, 0x4c, &[0x80]);
        wr(d, 0x4d, &[reg]);
        rd(d, 0x04, 1)[0]
    }

    #[test]
    fn init_status() {
        let mut d = Bmi270::new(0x68);
        assert_eq!(rd(&mut d, 0x21, 1), [0]);
        assert_eq!(begin(&mut d, 100), 2);
        assert_eq!(begin(&mut d, CONFIG_SIZE), 1);
        assert_eq!(d.config_bytes, CONFIG_SIZE);
        // Upload resumed at a word address lands where INIT_ADDR says
        wr(&mut d, 0x5b, &[0x02, 0x01]);
        wr(&mut d, 0x5e, &[0x11, 0x22]);
        assert_eq!(d.config[(0x12 * 2)..(0x12 * 2 + 2)], [0x11, 0x22]);
        // Plain register write / read back
        wr(&mut d, 0x41, &[0x01]);
        assert_eq!(rd(&mut d, 0x40, 4), [0xa8, 0x01, 0xa9, 0x00]);
    }

    #[test]
    fn m5unified_begin_and_read() {
        let mut d = Bmi270::new(0x69);
        assert_eq!(begin(&mut d, CONFIG_SIZE), 1);
        // auxSetupMode(0x10)
        wr(&mut d, 0x6b, &[0x20]);
        wr(&mut d, 0x7c, &[0x00]);
        wr(&mut d, 0x7d, &[0x0e]);
        wr(&mut d, 0x4c, &[0x80]);
        wr(&mut d, 0x4b, &[0x10 << 1]);
        aux_write(&mut d, 0x4b, 0x83);
        aux_read(&mut d, 0x40);
        assert_eq!(aux_read(&mut d, 0x40), 0x32);
        aux_write(&mut d, 0x4c, 0x38);
        wr(&mut d, 0x4c, &[0x4f]);
        wr(&mut d, 0x4d, &[0x42]);
        wr(&mut d, 0x7d, &[0x0f]);
        d.pose = Pose::new(30.0, -20.0, 0.0);
        d.temp_c = 30.0;
        d.set_time(CPU_HZ / 5);
        assert_eq!(rd(&mut d, 0x1d, 1)[0] & 0xe0, 0xe0);
        assert_eq!(rd(&mut d, 0x1d, 1)[0] & 0xe0, 0);
        let b = rd(&mut d, 0x04, 20);
        let w = |i: usize| i16::from_le_bytes([b[2 * i], b[2 * i + 1]]) as f64;
        let (ax, ay, az) = (w(4), w(5), w(6));
        assert!(((ax * ax + ay * ay + az * az).sqrt() - 4096.0).abs() < 40.0);
        let roll = ay.atan2(az).to_degrees();
        let pitch = (-ax).atan2((ay * ay + az * az).sqrt()).to_degrees();
        assert!(
            (pitch - 30.0).abs() < 0.5 && (roll + 20.0).abs() < 0.5,
            "{pitch} {roll}"
        );
        // Magnetometer through AUX data mode follows the pose: pitched 30°, X sees 25·cos + 40·sin µT
        let mx = ((w(0) as i16) >> 3) as f64 * 0.3;
        assert!((mx - 41.65).abs() < 1.5, "{mx}");
        let t = rd(&mut d, 0x22, 2);
        assert!((i16::from_le_bytes([t[0], t[1]]) as f64 / 512.0 + 23.0 - 30.0).abs() < 0.01);
        // Gyro at ±2000 °/s: 16.4 LSB per °/s
        d.pose.dyaw = 100.0;
        d.pose.pitch = 0.0;
        d.pose.roll = 0.0;
        let b = rd(&mut d, 0x12, 6);
        let gz = i16::from_le_bytes([b[4], b[5]]) as f64 / 16.384;
        assert!((gz - 100.0).abs() < 0.3, "{gz}");
    }
}
