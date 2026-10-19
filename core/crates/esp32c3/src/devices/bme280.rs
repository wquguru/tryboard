//! BME280 temperature/humidity/pressure sensor (I2C). Register map and compensation per the Bosch BME280 datasheet.
//! Raw ADC values are inverted: binary-search the ADC range so the datasheet's integer compensation yields exactly the set environment.

use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

/// Calibration constants: temperature / pressure from the datasheet example, humidity from typical production parts
#[derive(Clone, Copy)]
pub struct Calib {
    pub t1: u16,
    pub t2: i16,
    pub t3: i16,
    pub p: [i64; 9],
    pub h1: u8,
    pub h2: i16,
    pub h3: u8,
    pub h4: i16,
    pub h5: i16,
    pub h6: i8,
}

pub const CALIB: Calib = Calib {
    t1: 27504,
    t2: 26435,
    t3: -1000,
    p: [36477, -10685, 3024, 2855, 140, -7, 15500, -14600, 6000],
    h1: 75,
    h2: 362,
    h3: 0,
    h4: 313,
    h5: 50,
    h6: 30,
};

/// Datasheet 4.2.3: returns (temperature in 0.01°C, t_fine)
pub fn comp_t(c: &Calib, adc_t: i32) -> (i32, i32) {
    let t1 = c.t1 as i32;
    let var1 = (((adc_t >> 3) - (t1 << 1)) * c.t2 as i32) >> 11;
    let d = (adc_t >> 4) - t1;
    let var2 = (((d * d) >> 12) * c.t3 as i32) >> 14;
    let t_fine = var1 + var2;
    ((t_fine * 5 + 128) >> 8, t_fine)
}

/// Returns Q24.8 Pa
pub fn comp_p(c: &Calib, adc_p: i32, t_fine: i32) -> u32 {
    let p = &c.p;
    let mut var1 = t_fine as i64 - 128000;
    let mut var2 = var1 * var1 * p[5];
    var2 += (var1 * p[4]) << 17;
    var2 += p[3] << 35;
    var1 = ((var1 * var1 * p[2]) >> 8) + ((var1 * p[1]) << 12);
    var1 = (((1i64 << 47) + var1) * p[0]) >> 33;
    if var1 == 0 {
        return 0;
    }
    let mut pp: i64 = 1048576 - adc_p as i64;
    pp = (((pp << 31) - var2) * 3125) / var1;
    var1 = (p[8] * (pp >> 13) * (pp >> 13)) >> 25;
    var2 = (p[7] * pp) >> 19;
    pp = ((pp + var1 + var2) >> 8) + (p[6] << 4);
    pp as u32
}

/// Returns Q22.10 %RH
pub fn comp_h(c: &Calib, adc_h: i32, t_fine: i32) -> u32 {
    let mut v: i32 = t_fine - 76800;
    v = ((((adc_h << 14) - ((c.h4 as i32) << 20) - (c.h5 as i32 * v)) + 16384) >> 15)
        * (((((((v * c.h6 as i32) >> 10) * (((v * c.h3 as i32) >> 11) + 32768)) >> 10) + 2097152)
            * c.h2 as i32
            + 8192)
            >> 14);
    v -= ((((v >> 15) * (v >> 15)) >> 7) * c.h1 as i32) >> 4;
    v = v.clamp(0, 419430400);
    (v >> 12) as u32
}

/// Invert a monotonic function: find x in [lo, hi] with f(x) closest to target
fn invert(lo: i32, hi: i32, increasing: bool, target: i64, f: impl Fn(i32) -> i64) -> i32 {
    let (mut a, mut b) = (lo, hi);
    while b - a > 1 {
        let m = a + (b - a) / 2;
        let v = f(m);
        if (v < target) == increasing {
            a = m;
        } else {
            b = m;
        }
    }
    if (f(a) - target).abs() <= (f(b) - target).abs() {
        a
    } else {
        b
    }
}

pub struct Env {
    pub temp_c: f64,
    pub humidity: f64,
    pub pressure_pa: f64,
}

pub struct Bme280 {
    pub addr: u8,
    pub env: Env,
    regs: [u8; 256],
    ptr: u8,
    /// In a write transaction: next byte is the register address
    expect_reg: bool,
    now: u64,
    /// Measurement completion time (forced mode / next one in normal mode)
    meas_done: Option<u64>,
    pub measurements: u64,
}

impl Bme280 {
    pub fn new(addr: u8) -> Self {
        let mut b = Bme280 {
            addr,
            env: Env {
                temp_c: 23.5,
                humidity: 45.0,
                pressure_pa: 101_325.0,
            },
            regs: [0; 256],
            ptr: 0,
            expect_reg: false,
            now: 0,
            meas_done: None,
            measurements: 0,
        };
        b.reset();
        b
    }

    fn reset(&mut self) {
        self.regs = [0; 256];
        self.regs[0xd0] = 0x60;
        let c = CALIB;
        let mut put16 = |a: usize, v: u16| {
            self.regs[a] = v as u8;
            self.regs[a + 1] = (v >> 8) as u8;
        };
        put16(0x88, c.t1);
        put16(0x8a, c.t2 as u16);
        put16(0x8c, c.t3 as u16);
        for (i, p) in c.p.iter().enumerate() {
            put16(0x8e + 2 * i, *p as i16 as u16);
        }
        put16(0xe1, c.h2 as u16);
        self.regs[0xa1] = c.h1;
        self.regs[0xe3] = c.h3;
        // H4 = E4[7:0]<<4 | E5[3:0]; H5 = E6[7:0]<<4 | E5[7:4]
        self.regs[0xe4] = (c.h4 >> 4) as u8;
        self.regs[0xe5] = ((c.h4 & 0xf) as u8) | (((c.h5 & 0xf) as u8) << 4);
        self.regs[0xe6] = (c.h5 >> 4) as u8;
        self.regs[0xe7] = c.h6 as u8;
        // Data register defaults after reset
        for a in [0xf7, 0xfa] {
            self.regs[a] = 0x80;
        }
        self.regs[0xfd] = 0x80;
    }

    fn osrs(&self) -> (u8, u8, u8) {
        let m = self.regs[0xf4];
        (m >> 5, (m >> 2) & 7, self.regs[0xf2] & 7)
    }

    /// Datasheet 9.1 typical measurement time (ms)
    fn t_meas_ms(&self) -> f64 {
        let n = |o: u8| {
            if o == 0 {
                0.0
            } else {
                (1u32 << (o.min(5) - 1)) as f64
            }
        };
        let (t, p, h) = self.osrs();
        1.0 + 2.0 * n(t)
            + if p > 0 { 2.0 * n(p) + 0.5 } else { 0.0 }
            + if h > 0 { 2.0 * n(h) + 0.5 } else { 0.0 }
    }

    fn standby_ms(&self) -> f64 {
        [0.5, 62.5, 125.0, 250.0, 500.0, 1000.0, 10.0, 20.0][(self.regs[0xf5] >> 5) as usize]
    }

    fn ms(ms: f64) -> u64 {
        (ms * CPU_HZ as f64 / 1000.0) as u64
    }

    /// Quantize the current environment into raw ADC values in the data registers
    fn latch(&mut self) {
        let c = CALIB;
        let (ot, op, oh) = self.osrs();
        let target_t = (self.env.temp_c * 100.0).round() as i64;
        let adc_t = invert(0, (1 << 20) - 1, true, target_t, |x| comp_t(&c, x).0 as i64);
        let t_fine = comp_t(&c, adc_t).1;
        let target_p = (self.env.pressure_pa * 256.0).round() as i64;
        let adc_p = invert(0, (1 << 20) - 1, false, target_p, |x| {
            comp_p(&c, x, t_fine) as i64
        });
        let target_h = (self.env.humidity.clamp(0.0, 100.0) * 1024.0).round() as i64;
        let adc_h = invert(0, 65535, true, target_h, |x| comp_h(&c, x, t_fine) as i64);
        let put20 = |regs: &mut [u8; 256], a: usize, v: i32| {
            regs[a] = (v >> 12) as u8;
            regs[a + 1] = (v >> 4) as u8;
            regs[a + 2] = ((v & 0xf) << 4) as u8;
        };
        // Skipped channels (osrs=0) output 0x80000 / 0x8000
        put20(&mut self.regs, 0xfa, if ot > 0 { adc_t } else { 0x80000 });
        put20(&mut self.regs, 0xf7, if op > 0 { adc_p } else { 0x80000 });
        let h = if oh > 0 { adc_h } else { 0x8000 };
        self.regs[0xfd] = (h >> 8) as u8;
        self.regs[0xfe] = h as u8;
        self.measurements += 1;
    }

    fn advance(&mut self) {
        let mode = self.regs[0xf4] & 3;
        while let Some(t) = self.meas_done {
            if self.now < t {
                break;
            }
            self.latch();
            if mode == 3 {
                self.meas_done = Some(t + Self::ms(self.t_meas_ms() + self.standby_ms()));
            } else {
                self.meas_done = None;
                self.regs[0xf4] &= !3; // Forced mode returns to sleep after measuring
            }
        }
    }

    fn write_reg(&mut self, r: u8, v: u8) {
        match r {
            0xe0 => {
                if v == 0xb6 {
                    self.reset();
                    self.meas_done = None;
                }
            }
            0xf2 => self.regs[0xf2] = v & 7,
            0xf5 => self.regs[0xf5] = v,
            0xf4 => {
                self.regs[0xf4] = v;
                self.meas_done = match v & 3 {
                    0 => None,
                    _ => Some(self.now + Self::ms(self.t_meas_ms())),
                };
            }
            _ => {}
        }
    }
}

impl I2cDevice for Bme280 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn set_time(&mut self, now: u64) {
        self.now = now;
        self.advance();
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b;
            self.expect_reg = false;
        } else {
            self.write_reg(self.ptr, b);
            // Writes come in "address, data" pairs; BME280 does not auto-increment
            self.expect_reg = true;
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = if self.ptr == 0xf3 {
            let measuring =
                self.meas_done.is_some_and(|t| self.now < t) && self.regs[0xf4] & 3 == 1;
            if measuring {
                0x08
            } else {
                0
            }
        } else {
            self.regs[self.ptr as usize]
        };
        self.ptr = self.ptr.wrapping_add(1);
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

    #[test]
    fn inverse_roundtrip() {
        for (t, h, p) in [
            (23.5, 45.0, 101325.0),
            (-5.0, 90.0, 95000.0),
            (38.2, 12.5, 104000.0),
        ] {
            let mut b = Bme280::new(0x76);
            b.env = Env {
                temp_c: t,
                humidity: h,
                pressure_pa: p,
            };
            b.write_reg(0xf2, 1);
            b.write_reg(0xf4, 0x25); // Forced mode, all x1
            b.now = u64::MAX / 2;
            b.advance();
            let r = &b.regs;
            let adc_p = ((r[0xf7] as i32) << 12) | ((r[0xf8] as i32) << 4) | (r[0xf9] as i32 >> 4);
            let adc_t = ((r[0xfa] as i32) << 12) | ((r[0xfb] as i32) << 4) | (r[0xfc] as i32 >> 4);
            let adc_h = ((r[0xfd] as i32) << 8) | r[0xfe] as i32;
            let (tt, tf) = comp_t(&CALIB, adc_t);
            assert!((tt as f64 / 100.0 - t).abs() <= 0.01, "temperature {tt}");
            assert!((comp_p(&CALIB, adc_p, tf) as f64 / 256.0 - p).abs() <= 1.0);
            assert!(
                (comp_h(&CALIB, adc_h, tf) as f64 / 1024.0 - h).abs() <= 0.1,
                "humidity {}",
                comp_h(&CALIB, adc_h, tf)
            );
            assert_eq!(
                b.regs[0xf4] & 3,
                0,
                "forced mode back to sleep after measuring"
            );
        }
    }
}
