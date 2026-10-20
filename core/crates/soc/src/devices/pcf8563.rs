//! PCF8563 / BM8563 RTC (I2C 0x51), per the NXP PCF8563 datasheet (the BM8563 on M5 boards is register compatible): 0x00 Control_1
//! (bit5 STOP), 0x01 Control_2 (bit3 AF, bit2 TF, bit1 AIE, bit0 TIE; AF / TF clear on writing 0, writing 1 keeps them), 0x02..0x08
//! seconds (bit7 VL) / minutes / hours / days / weekdays / century_months (bit7 C: set = 19xx, as M5Unified reads it) / years in BCD,
//! 0x09..0x0C alarm minute / hour / day / weekday (bit7 = disabled), 0x0D CLKOUT, 0x0E timer control (bit7 TE, bits1:0 4096 / 64 / 1 /
//! 1/60 Hz), 0x0F timer countdown. Auto-increment wraps after 0x0F. Clock core shared with pcf85063.rs (follows simulated time, a
//! time write restarts it at STOP). Alarms fire once per matching minute, the timer reloads; `int_active` gives the INT pin. Not done:
//! CLKOUT output, TI_TP pulse mode, VL from supply voltage (VL is plain storage, 0 at start). (lint: allow-long-comment)

use super::pcf85063::{bcd, civil, days_from_civil, unbcd, RtcClock};
use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

const NREG: usize = 0x10;

pub struct Pcf8563 {
    pub addr: u8,
    regs: [u8; NREG],
    ptr: u8,
    expect_reg: bool,
    clock: RtcClock,
    dirty: bool,
    /// Last minute (epoch / 60) checked against the alarm
    alarm_checked: i64,
    /// Timer: cycle it was (re)started and expirations already flagged
    timer_start: u64,
    timer_fired: u64,
}

impl Pcf8563 {
    pub fn new(addr: u8) -> Self {
        let mut d = Pcf8563 {
            addr,
            regs: [0; NREG],
            ptr: 0,
            expect_reg: false,
            clock: RtcClock::new(),
            dirty: false,
            alarm_checked: 0,
            timer_start: 0,
            timer_fired: 0,
        };
        for r in 0x09..=0x0c {
            d.regs[r] = 0x80;
        }
        d.regs[0x0d] = 0x80; // CLKOUT enabled, 32.768 kHz
        d.regs[0x0e] = 0x03; // timer off, 1/60 Hz
        d.alarm_checked = d.epoch().div_euclid(60);
        d
    }

    fn stopped(&self) -> bool {
        self.regs[0] & 0x20 != 0
    }

    pub fn epoch(&self) -> i64 {
        self.clock.epoch(self.stopped())
    }

    /// Set the clock to `epoch` seconds (UTC) as of now
    pub fn set_epoch(&mut self, epoch: i64) {
        self.clock.set(epoch);
        self.alarm_checked = epoch.div_euclid(60);
    }

    /// INT pin (active low on the chip): an enabled alarm or timer flag is set
    pub fn int_active(&mut self) -> bool {
        self.update_flags();
        let c2 = self.regs[1];
        (c2 & 0x08 != 0 && c2 & 0x02 != 0) || (c2 & 0x04 != 0 && c2 & 0x01 != 0)
    }

    fn timer_period(&self) -> u64 {
        match self.regs[0x0e] & 3 {
            0 => CPU_HZ / 4096,
            1 => CPU_HZ / 64,
            2 => CPU_HZ,
            _ => CPU_HZ * 60,
        }
    }

    fn timer_ticks(&self) -> u64 {
        self.clock.now.saturating_sub(self.timer_start) / self.timer_period()
    }

    fn timer_running(&self) -> bool {
        self.regs[0x0e] & 0x80 != 0 && self.regs[0x0f] != 0
    }

    fn restart_timer(&mut self) {
        self.timer_start = self.clock.now;
        self.timer_fired = 0;
    }

    fn alarm_matches(&self, minute: i64) -> bool {
        let t = minute * 60;
        let (days, s) = (t.div_euclid(86_400), t.rem_euclid(86_400) as u32);
        let (_, _, d) = civil(days);
        let wd = (days + 4).rem_euclid(7) as u32;
        let fields = [(0x09, s / 60 % 60), (0x0a, s / 3600), (0x0b, d), (0x0c, wd)];
        let mut any = false;
        for (r, v) in fields {
            let a = self.regs[r];
            if a & 0x80 == 0 {
                any = true;
                let want = if r == 0x0c {
                    (a & 7) as u32
                } else {
                    unbcd(a & 0x7f)
                };
                if want != v {
                    return false;
                }
            }
        }
        any
    }

    /// Raise AF for alarm minutes passed since the last check, TF for timer expiries
    fn update_flags(&mut self) {
        let minute = self.epoch().div_euclid(60);
        // Bounded scan: a jump of more than ~70 days only checks its last stretch
        let from = (self.alarm_checked + 1).max(minute - 100_000);
        if (from..=minute).any(|m| self.alarm_matches(m)) {
            self.regs[1] |= 0x08;
        }
        self.alarm_checked = self.alarm_checked.max(minute);
        if self.timer_running() {
            let n = self.regs[0x0f] as u64;
            let exp = self.timer_ticks() / n;
            if exp > self.timer_fired {
                self.timer_fired = exp;
                self.regs[1] |= 0x04;
            }
        }
    }

    /// Copy the running time into the BCD registers
    fn latch(&mut self) {
        self.update_flags();
        let t = self.epoch();
        let (days, s) = (t.div_euclid(86_400), t.rem_euclid(86_400) as u32);
        let (y, mo, d) = civil(days);
        let r = &mut self.regs;
        r[2] = (r[2] & 0x80) | bcd(s % 60);
        r[3] = bcd(s / 60 % 60);
        r[4] = bcd(s / 3600);
        r[5] = bcd(d);
        r[6] = (days + 4).rem_euclid(7) as u8;
        r[7] = bcd(mo) | if y < 2000 { 0x80 } else { 0 };
        r[8] = bcd(y.rem_euclid(100) as u32);
    }

    fn rebase(&mut self) {
        let r = &self.regs;
        let century = if r[7] & 0x80 != 0 { 1900 } else { 2000 };
        let days = days_from_civil(
            century + unbcd(r[8]) as i64,
            unbcd(r[7] & 0x1f).clamp(1, 12),
            unbcd(r[5] & 0x3f).max(1),
        );
        let secs = unbcd(r[4] & 0x3f) * 3600 + unbcd(r[3] & 0x7f) * 60 + unbcd(r[2] & 0x7f);
        self.set_epoch(days * 86_400 + secs as i64);
    }

    fn read_reg(&self, p: usize) -> u8 {
        if p == 0x0f && self.timer_running() {
            let n = self.regs[0x0f] as u64;
            return (n - self.timer_ticks() % n) as u8;
        }
        self.regs[p]
    }

    fn write_reg(&mut self, p: usize, b: u8) {
        match p {
            0x00 => {
                let (was, t) = (self.stopped(), self.epoch());
                self.regs[0] = b & 0xa8;
                if was != self.stopped() {
                    self.clock.set(t);
                }
            }
            0x01 => {
                // AF / TF: writing 0 clears, writing 1 leaves the flag as is
                let keep = self.regs[1] & b & 0x0c;
                self.regs[1] = keep | (b & 0x13);
            }
            0x02..=0x08 => {
                self.regs[p] = b;
                self.dirty = true;
            }
            0x0e => {
                let was = self.regs[0x0e] & 0x80 != 0;
                self.regs[0x0e] = b & 0x83;
                if !was && b & 0x80 != 0 {
                    self.restart_timer();
                }
            }
            0x0f => {
                self.regs[0x0f] = b;
                self.restart_timer();
            }
            _ => self.regs[p] = b,
        }
    }
}

impl I2cDevice for Pcf8563 {
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
        let v = self.read_reg(self.ptr as usize);
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

    fn rd(d: &mut Pcf8563, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        let v = (0..n).map(|_| d.read()).collect();
        d.stop();
        v
    }

    fn wr(d: &mut Pcf8563, reg: u8, data: &[u8]) {
        d.start(false);
        d.write(reg);
        for b in data {
            d.write(*b);
        }
        d.stop();
    }

    #[test]
    fn runs_sets_and_century() {
        let mut d = Pcf8563::new(0x51);
        // M5Unified init
        wr(&mut d, 0x00, &[0x00]);
        wr(&mut d, 0x0e, &[0x03]);
        // 2026-10-16 04:00:00 UTC, Friday, VL clear, century bit clear
        assert_eq!(rd(&mut d, 0x02, 7), [0x00, 0x00, 0x04, 0x16, 5, 0x10, 0x26]);
        d.set_time(CPU_HZ * 61);
        assert_eq!(rd(&mut d, 0x02, 2), [0x01, 0x01]);
        // 2025-12-31 23:59:58, then 3 s later 2026-01-01 00:00:01
        wr(&mut d, 0x02, &[0x58, 0x59, 0x23, 0x31, 3, 0x12, 0x25]);
        d.set_time(CPU_HZ * 64);
        assert_eq!(rd(&mut d, 0x02, 7), [0x01, 0x00, 0x00, 0x01, 4, 0x01, 0x26]);
        // Century bit set: 1999-12-31 (M5Unified writes C for years < 2000)
        wr(&mut d, 0x02, &[0x00, 0x00, 0x00, 0x31, 5, 0x92, 0x99]);
        assert_eq!(rd(&mut d, 0x07, 2), [0x92, 0x99]);
        // STOP freezes; wraps after 0x0F
        wr(&mut d, 0x00, &[0x20]);
        d.set_time(CPU_HZ * 100);
        assert_eq!(rd(&mut d, 0x02, 1), [0x00]);
        assert_eq!(rd(&mut d, 0x0f, 2), [0x00, 0x20]);
    }

    #[test]
    fn alarm_and_timer_flags() {
        let mut d = Pcf8563::new(0x51);
        // Alarm at 04:02 (minute + hour enabled), AIE on
        wr(&mut d, 0x09, &[0x02, 0x04, 0x80, 0x80]);
        wr(&mut d, 0x01, &[0x02]);
        assert!(!d.int_active());
        d.set_time(CPU_HZ * 125);
        assert_eq!(rd(&mut d, 0x01, 1), [0x0a]);
        assert!(d.int_active());
        // Clearing AF (write 0) sticks for the rest of that minute
        wr(&mut d, 0x01, &[0x02]);
        d.set_time(CPU_HZ * 150);
        assert_eq!(rd(&mut d, 0x01, 1), [0x02]);
        // Timer: 1 Hz, 5 counts, TIE; counts down then flags TF
        wr(&mut d, 0x01, &[0x01]);
        wr(&mut d, 0x0e, &[0x82]);
        wr(&mut d, 0x0f, &[5]);
        d.set_time(CPU_HZ * 152);
        assert_eq!(rd(&mut d, 0x0f, 1), [3]);
        assert_eq!(rd(&mut d, 0x01, 1)[0] & 0x04, 0);
        d.set_time(CPU_HZ * 156);
        assert_eq!(rd(&mut d, 0x01, 1), [0x05]);
        assert!(d.int_active());
    }
}
