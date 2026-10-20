//! Maxim DS3231 RTC with temperature sensor (I2C 0x68), per the DS3231 datasheet: 0x00..0x06 seconds / minutes / hours (bit6
//! 12-hour mode, bit5 PM) / day (1..7, user-defined start) / date / month (bit7 century) / year in BCD; 0x07..0x0A alarm 1
//! (bit7 A1Mx masks, 0x0A bit6 DY/DT), 0x0B..0x0D alarm 2; 0x0E control (reset 0x1C: INTCN, A2IE bit1, A1IE bit0; CONV completes
//! at once); 0x0F status (reset 0x88: OSF bit7 set at power-on, EN32kHz bit3; OSF / A2F / A1F only clear on writing 0);
//! 0x10 aging offset (storage); 0x11 / 0x12 temperature, signed 0.25 C steps, from `temp_c`. The pointer auto-increments and
//! wraps after 0x12. Clock core shared with pcf85063.rs; reads latch at START and at a pointer write. Not done: 32 kHz / SQW
//! output, EOSC (the clock runs on VCC regardless), aging effect on the rate. (lint: allow-long-comment)

use super::pcf85063::{bcd, civil, days_from_civil, unbcd, RtcClock};
use crate::i2c::I2cDevice;
use std::any::Any;

const NREG: usize = 0x13;
const A1F: u8 = 0x01;
const A2F: u8 = 0x02;

pub struct Ds3231 {
    pub addr: u8,
    pub temp_c: f64,
    regs: [u8; NREG],
    ptr: u8,
    expect_reg: bool,
    clock: RtcClock,
    dirty: bool,
    /// Day-of-week register = (days since epoch + offset) % 7 + 1, so the firmware's choice of start day carries on
    dow_offset: i64,
    /// Last epoch second checked against the alarms
    alarm_checked: i64,
}

/// Hours register (24 h or 12 h form) -> 0..23
fn hour24(r: u8) -> u32 {
    if r & 0x40 == 0 {
        return unbcd(r & 0x3f);
    }
    let h = unbcd(r & 0x1f) % 12;
    h + if r & 0x20 != 0 { 12 } else { 0 }
}

impl Ds3231 {
    pub fn new(addr: u8) -> Self {
        let mut d = Ds3231 {
            addr,
            temp_c: 23.5,
            regs: [0; NREG],
            ptr: 0,
            expect_reg: false,
            clock: RtcClock::new(),
            dirty: false,
            dow_offset: 0,
            alarm_checked: 0,
        };
        d.regs[0x0e] = 0x1c;
        d.regs[0x0f] = 0x88;
        // 1 = Sunday, the convention of Arduino RTClib (1970-01-01 was a Thursday)
        d.dow_offset = 4;
        d.alarm_checked = d.epoch();
        d
    }

    pub fn epoch(&self) -> i64 {
        self.clock.epoch(false)
    }

    /// Set the clock to `epoch` seconds (UTC) as of now
    pub fn set_epoch(&mut self, epoch: i64) {
        self.clock.set(epoch);
        self.alarm_checked = epoch;
    }

    /// INT/SQW pin (active low on the chip): INTCN set and an enabled alarm flag raised
    pub fn int_active(&mut self) -> bool {
        self.update_flags();
        let (c, s) = (self.regs[0x0e], self.regs[0x0f]);
        c & 0x04 != 0 && c & s & (A1F | A2F) != 0
    }

    fn dow(&self, days: i64) -> u32 {
        (days + self.dow_offset).rem_euclid(7) as u32 + 1
    }

    /// Whether alarm fields `regs[r0..]` (seconds first for alarm 1) match epoch second `t`
    fn alarm_matches(&self, t: i64, alarm1: bool) -> bool {
        let (days, s) = (t.div_euclid(86_400), t.rem_euclid(86_400) as u32);
        let (r0, sec) = if alarm1 { (0x07, s % 60) } else { (0x0a, 0) };
        // Alarm 2 has no seconds register: it fires at second 0 of a matching minute
        if !alarm1 && s % 60 != 0 {
            return false;
        }
        let r = &self.regs;
        if alarm1 && r[0x07] & 0x80 == 0 && unbcd(r[0x07] & 0x7f) != sec {
            return false;
        }
        let (m, h, dd) = (r[r0 + 1], r[r0 + 2], r[r0 + 3]);
        if m & 0x80 == 0 && unbcd(m & 0x7f) != s / 60 % 60 {
            return false;
        }
        if h & 0x80 == 0 && hour24(h) != s / 3600 {
            return false;
        }
        if dd & 0x80 == 0 {
            let want = if dd & 0x40 != 0 {
                (dd & 0x0f) as u32 == self.dow(days)
            } else {
                unbcd(dd & 0x3f) == civil(days).2
            };
            if !want {
                return false;
            }
        }
        true
    }

    fn update_flags(&mut self) {
        let now = self.epoch();
        // Bounded scan: after a jump of more than ~1 day only its last stretch is checked
        let from = (self.alarm_checked + 1).max(now - 100_000);
        for t in from..=now {
            if self.regs[0x0f] & (A1F | A2F) == A1F | A2F {
                break;
            }
            if self.alarm_matches(t, true) {
                self.regs[0x0f] |= A1F;
            }
            if self.alarm_matches(t, false) {
                self.regs[0x0f] |= A2F;
            }
        }
        self.alarm_checked = self.alarm_checked.max(now);
    }

    /// Copy the running time and temperature into the registers
    fn latch(&mut self) {
        self.update_flags();
        let t = self.epoch();
        let (days, s) = (t.div_euclid(86_400), t.rem_euclid(86_400) as u32);
        let (y, mo, d) = civil(days);
        let dow = self.dow(days);
        let r = &mut self.regs;
        r[0] = bcd(s % 60);
        r[1] = bcd(s / 60 % 60);
        let h = s / 3600;
        r[2] = if r[2] & 0x40 != 0 {
            let h12 = if h % 12 == 0 { 12 } else { h % 12 };
            0x40 | if h >= 12 { 0x20 } else { 0 } | bcd(h12)
        } else {
            bcd(h)
        };
        r[3] = dow as u8;
        r[4] = bcd(d);
        r[5] = bcd(mo) | if y >= 2100 { 0x80 } else { 0 };
        r[6] = bcd(y.rem_euclid(100) as u32);
        let q = (self.temp_c * 4.0).round().clamp(-512.0, 511.0) as i32;
        r[0x11] = (q >> 2) as u8;
        r[0x12] = ((q & 3) << 6) as u8;
    }

    fn rebase(&mut self) {
        let r = &self.regs;
        let century = if r[5] & 0x80 != 0 { 2100 } else { 2000 };
        let days = days_from_civil(
            century + unbcd(r[6]) as i64,
            unbcd(r[5] & 0x1f).clamp(1, 12),
            unbcd(r[4] & 0x3f).max(1),
        );
        let secs = hour24(r[2]) * 3600 + unbcd(r[1] & 0x7f) * 60 + unbcd(r[0] & 0x7f);
        let dow = (r[3] & 7).max(1) as i64;
        self.dow_offset = (dow - 1 - days).rem_euclid(7);
        self.set_epoch(days * 86_400 + secs as i64);
    }

    fn write_reg(&mut self, p: usize, b: u8) {
        match p {
            0x00..=0x06 => {
                self.regs[p] = b;
                self.dirty = true;
            }
            // CONV and BSY: the conversion finishes at once
            0x0e => self.regs[p] = b & !0x20,
            0x0f => {
                let keep = self.regs[p] & b & 0x83;
                self.regs[p] = keep | (b & 0x08);
            }
            0x11 | 0x12 => {}
            _ => self.regs[p] = b,
        }
    }
}

impl I2cDevice for Ds3231 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        if read {
            self.latch();
        }
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b % NREG as u8;
            self.expect_reg = false;
            self.latch();
            return true;
        }
        self.write_reg(self.ptr as usize, b);
        self.ptr = ((self.ptr as usize + 1) % NREG) as u8;
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.regs[self.ptr as usize];
        self.ptr = ((self.ptr as usize + 1) % NREG) as u8;
        v
    }
    fn stop(&mut self) {
        if self.dirty {
            self.dirty = false;
            self.rebase();
        }
    }
    fn set_time(&mut self, now: u64) {
        self.clock.now = now;
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::periph::CPU_HZ;

    fn rd(d: &mut Ds3231, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        let v = (0..n).map(|_| d.read()).collect();
        d.stop();
        v
    }

    fn wr(d: &mut Ds3231, reg: u8, data: &[u8]) {
        d.start(false);
        d.write(reg);
        for &b in data {
            d.write(b);
        }
        d.stop();
    }

    #[test]
    fn set_time_runs_and_rolls_over() {
        let mut d = Ds3231::new(0x68);
        assert_eq!(rd(&mut d, 0x0f, 1)[0] & 0x80, 0x80);
        // 2026-10-20 23:59:58, day register 3 (Tuesday, Sunday = 1)
        wr(&mut d, 0x00, &[0x58, 0x59, 0x23, 0x03, 0x20, 0x10, 0x26]);
        assert_eq!(
            rd(&mut d, 0x00, 7),
            vec![0x58, 0x59, 0x23, 3, 0x20, 0x10, 0x26]
        );
        d.set_time(3 * CPU_HZ);
        assert_eq!(
            rd(&mut d, 0x00, 7),
            vec![0x01, 0x00, 0x00, 4, 0x21, 0x10, 0x26]
        );
        // 12-hour mode: 00:00 reads 12 AM; OSF clears on writing 0, EN32kHz kept as written
        wr(&mut d, 0x02, &[0x52]);
        assert_eq!(rd(&mut d, 0x02, 1)[0], 0x52);
        d.set_time(3 * CPU_HZ + 13 * 3600 * CPU_HZ);
        assert_eq!(rd(&mut d, 0x02, 1)[0], 0x40 | 0x20 | 0x01);
        wr(&mut d, 0x0f, &[0x08]);
        assert_eq!(rd(&mut d, 0x0f, 1)[0], 0x08);
        // Pointer wraps after 0x12
        assert_eq!(rd(&mut d, 0x12, 2)[1], rd(&mut d, 0x00, 1)[0]);
    }

    #[test]
    fn temperature_quarter_degrees() {
        let mut d = Ds3231::new(0x68);
        d.temp_c = 21.5;
        assert_eq!(rd(&mut d, 0x11, 2), vec![21, 0x80]);
        d.temp_c = -0.25;
        assert_eq!(rd(&mut d, 0x11, 2), vec![0xff, 0xc0]);
        d.temp_c = -7.3;
        assert_eq!(rd(&mut d, 0x11, 2), vec![0xf8, 0xc0]);
    }

    #[test]
    fn alarms_raise_flags_and_int() {
        let mut d = Ds3231::new(0x68);
        d.set_epoch(1_792_123_200);
        // Alarm 1 on seconds = 05, alarm 2 every minute; INTCN + A1IE
        wr(&mut d, 0x07, &[0x05, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
        wr(&mut d, 0x0e, &[0x05]);
        wr(&mut d, 0x0f, &[0x00]);
        d.set_time(4 * CPU_HZ);
        assert!(!d.int_active());
        d.set_time(5 * CPU_HZ);
        assert!(d.int_active());
        assert_eq!(rd(&mut d, 0x0f, 1)[0] & 3, A1F);
        wr(&mut d, 0x0f, &[0x00]);
        assert!(!d.int_active());
        d.set_time(60 * CPU_HZ);
        assert_eq!(rd(&mut d, 0x0f, 1)[0] & 3, A2F);
        assert!(!d.int_active());
    }
}
