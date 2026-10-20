//! QST QMP6988 barometer (I2C, M5 ENV III). Registers and the fixed-point compensation follow the QMP6988 datasheet and
//! QST's reference driver (as used by M5Unit-ENV, MIT); raw ADC values are found by bisection like the BME280 model.

use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

pub const CHIP_ID: u8 = 0x5c;
const SUBTRACTOR: i32 = 1 << 23;

/// OTP coefficients (raw OTP words; a0 / b00 are 20-bit, the rest 16-bit, all signed). Chosen so the
/// raw ADC ranges stay sane and both compensation polynomials are monotonic over -40..85 °C
#[derive(Clone, Copy)]
pub struct Otp {
    pub a0: i32,
    pub b00: i32,
    pub a1: i16,
    pub a2: i16,
    pub bt1: i16,
    pub bt2: i16,
    pub bp1: i16,
    pub b11: i16,
    pub bp2: i16,
    pub b12: i16,
    pub b21: i16,
    pub bp3: i16,
}

pub const OTP: Otp = Otp {
    a0: -20000,
    b00: 400000,
    a1: 1234,
    a2: -2345,
    bt1: 3000,
    bt2: -1500,
    bp1: 2000,
    b11: 500,
    bp2: -800,
    b12: 300,
    b21: -200,
    bp3: 100,
};

impl Otp {
    /// 25 bytes at 0xA0: 16-bit words big-endian, the low nibbles of b00 / a0 packed into the last byte
    pub fn bytes(&self) -> [u8; 25] {
        let mut b = [0u8; 25];
        let w = [
            self.bt1, self.bt2, self.bp1, self.b11, self.bp2, self.b12, self.b21, self.bp3,
        ];
        b[0] = (self.b00 >> 12) as u8;
        b[1] = (self.b00 >> 4) as u8;
        for (i, v) in w.iter().enumerate() {
            b[2 + 2 * i..4 + 2 * i].copy_from_slice(&v.to_be_bytes());
        }
        b[18] = (self.a0 >> 12) as u8;
        b[19] = (self.a0 >> 4) as u8;
        b[20..22].copy_from_slice(&self.a1.to_be_bytes());
        b[22..24].copy_from_slice(&self.a2.to_be_bytes());
        b[24] = (((self.b00 & 0xf) << 4) | (self.a0 & 0xf)) as u8;
        b
    }
}

/// Fixed-point coefficients: OTP word scaled by the datasheet's A + S * OTP / 32767 table, kept in Q formats
pub struct Ik {
    a0: i64,
    b00: i64,
    a1: i64,
    a2: i64,
    bt1: i64,
    bt2: i64,
    bp1: i64,
    b11: i64,
    bp2: i64,
    b12: i64,
    b21: i64,
    bp3: i64,
}

impl Ik {
    pub fn new(o: &Otp) -> Ik {
        let s = |m: i64, v: i16, off: i64| m * v as i64 + off;
        Ik {
            a0: o.a0 as i64,
            b00: o.b00 as i64,
            a1: s(3608, o.a1, -1731677965),
            a2: s(16889, o.a2, -87619360),
            bt1: s(2982, o.bt1, 107370906),
            bt2: s(329854, o.bt2, 108083093),
            bp1: s(19923, o.bp1, 1133836764),
            b11: s(2406, o.b11, 118215883),
            bp2: s(3079, o.bp2, -181579595),
            b12: s(6846, o.b12, 85590281),
            b21: s(13836, o.b21, 79333336),
            bp3: s(2915, o.bp3, 157155561),
        }
    }

    /// Temperature in 1/256 °C from the offset-removed raw value (the driver keeps it in an i16)
    pub fn temp(&self, dt: i32) -> i16 {
        let dt = dt as i64;
        let lin = self.a1 * dt;
        let quad = (((self.a2 * dt) >> 14) * dt) >> 10;
        let v = ((lin + quad) / 32767) >> 19;
        ((self.a0 + v) >> 4) as i16
    }

    /// Pressure in 1/16 Pa
    pub fn pressure(&self, dp: i32, tx: i16) -> i32 {
        let (dp, tx) = (dp as i64, tx as i64);
        let mut w1 = self.bt1 * tx + ((self.bp1 * dp) >> 5);
        // Second-order terms in Q29
        let tt = (((self.bt2 * tx) >> 1) * tx) >> 8;
        let tp = (((self.b11 * tx) >> 4) * dp) >> 1;
        let pp = (((self.bp2 * dp) >> 13) * dp) >> 1;
        w1 += (tt + tp + pp) >> 14;
        // Third-order terms in Q30
        let ttp = (((self.b12 * tx * tx) >> 22) * dp) >> 1;
        let tpp = (((((self.b21 * tx) >> 6) * dp) >> 23) * dp) >> 1;
        let ppp = ((((self.bp3 * dp) >> 12) * dp) >> 23) * dp;
        w1 += (ttp + tpp + ppp) >> 15;
        (((w1 / 32767) >> 11) + self.b00) as i32
    }
}

/// Bisection over a monotonic function, like `bme280::invert` but with an empirical direction
fn invert(lo: i32, hi: i32, target: i64, f: impl Fn(i32) -> i64) -> i32 {
    let increasing = f(hi) > f(lo);
    let (mut a, mut b) = (lo, hi);
    while b - a > 1 {
        let m = a + (b - a) / 2;
        if (f(m) < target) == increasing {
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

/// Raw temperature range where the i16 result does not wrap with `OTP` (about -79..103 °C)
const DT_RANGE: (i32, i32) = (-4_500_000, 3_000_000);

pub struct Qmp6988 {
    pub addr: u8,
    pub temp_c: f64,
    pub pressure_pa: f64,
    regs: [u8; 256],
    ptr: u8,
    expect_reg: bool,
    now: u64,
    meas_done: Option<u64>,
    pub measurements: u64,
}

impl Qmp6988 {
    pub fn new(addr: u8) -> Self {
        let mut d = Qmp6988 {
            addr,
            temp_c: 23.5,
            pressure_pa: 101_325.0,
            regs: [0; 256],
            ptr: 0,
            expect_reg: false,
            now: 0,
            meas_done: None,
            measurements: 0,
        };
        d.reset();
        d
    }

    fn reset(&mut self) {
        self.regs = [0; 256];
        self.regs[0xd1] = CHIP_ID;
        self.regs[0xa0..0xa0 + 25].copy_from_slice(&OTP.bytes());
        // Data registers read as mid-scale (raw 0) until the first conversion
        self.regs[0xf7] = 0x80;
        self.regs[0xfa] = 0x80;
        self.meas_done = None;
    }

    /// Conversion time: approximate (datasheet gives per-setting typicals), scales with the averaging counts
    fn t_meas_ms(&self) -> f64 {
        let n = |o: u8| {
            if o == 0 {
                0.0
            } else {
                (1u32 << (o - 1)) as f64
            }
        };
        let m = self.regs[0xf4];
        1.0 + 0.6 * (n(m >> 5) + n((m >> 2) & 7))
    }

    fn standby_ms(&self) -> f64 {
        [1.0, 5.0, 50.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0][(self.regs[0xf5] >> 5) as usize]
    }

    fn ms(ms: f64) -> u64 {
        (ms * CPU_HZ as f64 / 1000.0) as u64
    }

    /// Raw (offset-removed) ADC values that compensate to the current environment; IIR filter not modelled
    pub fn raw(&self) -> (i32, i32) {
        let ik = Ik::new(&OTP);
        let tt = (self.temp_c * 256.0).round() as i64;
        let dt = invert(DT_RANGE.0, DT_RANGE.1, tt, |x| ik.temp(x) as i64);
        let tx = ik.temp(dt);
        let pt = (self.pressure_pa * 16.0).round() as i64;
        let dp = invert(-SUBTRACTOR, SUBTRACTOR - 1, pt, |x| {
            ik.pressure(x, tx) as i64
        });
        (dt, dp)
    }

    fn latch(&mut self) {
        let m = self.regs[0xf4];
        let (dt, dp) = self.raw();
        let put = |regs: &mut [u8; 256], a: usize, v: i32| {
            let u = (v + SUBTRACTOR) as u32;
            regs[a..a + 3].copy_from_slice(&u.to_be_bytes()[1..]);
        };
        // Skipped channels (average 0) keep their last value
        if m >> 5 != 0 {
            put(&mut self.regs, 0xfa, dt);
        }
        if (m >> 2) & 7 != 0 {
            put(&mut self.regs, 0xf7, dp);
        }
        self.measurements += 1;
    }

    fn advance(&mut self) {
        while let Some(t) = self.meas_done {
            if self.now < t {
                break;
            }
            self.latch();
            if self.regs[0xf4] & 3 == 3 {
                self.meas_done = Some(t + Self::ms(self.t_meas_ms() + self.standby_ms()));
            } else {
                self.meas_done = None;
                self.regs[0xf4] &= !3;
            }
        }
    }

    fn write_reg(&mut self, r: u8, v: u8) {
        match r {
            0xe0 => {
                if v == 0xe6 {
                    self.reset();
                }
            }
            0xf1 | 0xf5 => self.regs[r as usize] = v,
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

impl I2cDevice for Qmp6988 {
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
            self.ptr = self.ptr.wrapping_add(1);
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = if self.ptr == 0xf3 {
            // Bit 3: conversion in progress
            let busy = self.meas_done.is_some_and(|t| self.now < t);
            (busy as u8) << 3
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

    /// Datasheet floating-point form: coefficient = A + S * OTP / 32767
    fn float_comp(o: &Otp, dt: f64, dp: f64) -> (f64, f64) {
        let k = |a: f64, s: f64, v: i16| a + s * v as f64 / 32767.0;
        let a1 = k(-6.3e-3, 4.3e-4, o.a1);
        let a2 = k(-1.9e-11, 1.2e-10, o.a2);
        let bt1 = k(1.0e-1, 9.1e-2, o.bt1);
        let bt2 = k(1.2e-8, 1.2e-6, o.bt2);
        let bp1 = k(3.3e-2, 1.9e-2, o.bp1);
        let b11 = k(2.1e-7, 1.4e-7, o.b11);
        let bp2 = k(-6.3e-10, 3.5e-10, o.bp2);
        let b12 = k(2.9e-13, 7.6e-13, o.b12);
        let b21 = k(2.1e-15, 1.2e-14, o.b21);
        let bp3 = k(1.3e-16, 7.9e-17, o.bp3);
        let tr = o.a0 as f64 / 16.0 + a1 * dt + a2 * dt * dt;
        let p = o.b00 as f64 / 16.0
            + bt1 * tr
            + bp1 * dp
            + b11 * dp * tr
            + bt2 * tr * tr
            + bp2 * dp * dp
            + b12 * dp * tr * tr
            + b21 * dp * dp * tr
            + bp3 * dp * dp * dp;
        (tr / 256.0, p)
    }

    /// Driver-side OTP decode (20-bit fields sign-extended)
    fn decode(b: &[u8]) -> Otp {
        let w = |i: usize| i16::from_be_bytes([b[i], b[i + 1]]);
        let s20 = |v: i32| (v << 12) >> 12;
        Otp {
            b00: s20(((b[0] as i32) << 12) | ((b[1] as i32) << 4) | (b[24] as i32 >> 4)),
            a0: s20(((b[18] as i32) << 12) | ((b[19] as i32) << 4) | (b[24] as i32 & 0xf)),
            bt1: w(2),
            bt2: w(4),
            bp1: w(6),
            b11: w(8),
            bp2: w(10),
            b12: w(12),
            b21: w(14),
            bp3: w(16),
            a1: w(20),
            a2: w(22),
        }
    }

    fn rd(d: &mut Qmp6988, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        let v = (0..n).map(|_| d.read()).collect();
        d.stop();
        v
    }

    fn wr(d: &mut Qmp6988, reg: u8, v: u8) {
        d.start(false);
        d.write(reg);
        d.write(v);
        d.stop();
    }

    #[test]
    fn otp_roundtrip_and_float_agreement() {
        let mut d = Qmp6988::new(0x70);
        assert_eq!(rd(&mut d, 0xd1, 1), vec![CHIP_ID]);
        let o = decode(&rd(&mut d, 0xa0, 25));
        assert_eq!(
            (o.a0, o.b00, o.a1, o.bp3),
            (OTP.a0, OTP.b00, OTP.a1, OTP.bp3)
        );
        let ik = Ik::new(&o);
        for (dt, dp) in [
            (-1_000_000, 2_300_000),
            (2_000_000, 500_000),
            (-3_000_000, 3_000_000),
        ] {
            let t = ik.temp(dt);
            let (ft, fp) = float_comp(&o, dt as f64, dp as f64);
            assert!((t as f64 / 256.0 - ft).abs() < 0.01, "temp {t} vs {ft}");
            let p = ik.pressure(dp, t) as f64 / 16.0;
            assert!((p - fp).abs() < 1.0, "pressure {p} vs {fp}");
        }
    }

    #[test]
    fn forced_and_normal_roundtrip() {
        for (t, p) in [
            (23.5, 101_325.0),
            (-12.3, 95_000.0),
            (41.7, 104_000.0),
            (25.0, 30_000.0),
        ] {
            let mut d = Qmp6988::new(0x70);
            d.temp_c = t;
            d.pressure_pa = p;
            wr(&mut d, 0xf4, 0x31); // T x1, P x4, forced
            assert_eq!(rd(&mut d, 0xf3, 1), vec![0x08], "converting");
            d.set_time(Qmp6988::ms(50.0));
            assert_eq!(rd(&mut d, 0xf3, 1), vec![0]);
            assert_eq!(rd(&mut d, 0xf4, 1)[0] & 3, 0, "forced returns to sleep");
            let r = rd(&mut d, 0xf7, 6);
            let raw =
                |i: usize| (u32::from_be_bytes([0, r[i], r[i + 1], r[i + 2]]) as i32) - SUBTRACTOR;
            let (dp, dt) = (raw(0), raw(3));
            let (ft, fp) = float_comp(&OTP, dt as f64, dp as f64);
            assert!((ft - t).abs() < 0.01, "temp {ft}");
            assert!((fp - p).abs() < 1.0, "pressure {fp}");
        }
        // Normal mode keeps converting and follows the environment
        let mut d = Qmp6988::new(0x70);
        wr(&mut d, 0xf5, 0x20); // 5 ms standby
        wr(&mut d, 0xf4, 0x27); // T x1, P x1, normal
        d.set_time(Qmp6988::ms(10.0));
        let n = d.measurements;
        d.pressure_pa = 90_000.0;
        d.set_time(Qmp6988::ms(100.0));
        assert!(d.measurements > n + 5);
        assert_eq!(d.raw().1 + SUBTRACTOR, {
            let r = rd(&mut d, 0xf7, 3);
            u32::from_be_bytes([0, r[0], r[1], r[2]]) as i32
        });
        wr(&mut d, 0xe0, 0xe6);
        assert_eq!(rd(&mut d, 0xf4, 1), vec![0], "reset");
    }
}
