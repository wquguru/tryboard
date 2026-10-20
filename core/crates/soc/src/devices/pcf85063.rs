//! PCF85063 RTC (I2C 0x51), per the NXP PCF85063A datasheet: 0x00 Control_1 (bit5 STOP, bit1 12_24, 0x58 = software reset), 0x01 Control_2, 0x02 Offset,
//! 0x03 RAM, 0x04..0x0A seconds (bit7 OS) / minutes / hours / days / weekdays / months / years in BCD, 0x0B..0x0F alarms, 0x10 / 0x11 timer.
//! Address auto-increments and wraps after 0x11. The clock follows simulated time (set_time); a time write restarts it from the written value
//! at that cycle. Reads latch the time at START. Held as UTC. Only storage: offset, alarms, timer, 12-hour mode, interrupts. (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

/// Default start: the virtual network's /api/time (2026-10-16 04:00:00 UTC)
pub const DEFAULT_EPOCH: i64 = 1_792_123_200;
const NREG: usize = 0x12;

pub struct Pcf85063 {
    pub addr: u8,
    regs: [u8; NREG],
    ptr: u8,
    expect_reg: bool,
    clock: RtcClock,
    /// A time register was written in this transaction: re-base at STOP
    dirty: bool,
}

/// Clock core shared by the RTC models: epoch seconds `base` at cycle `base_cycle`, advancing with simulated time
pub(crate) struct RtcClock {
    pub now: u64,
    base: i64,
    base_cycle: u64,
}

impl RtcClock {
    pub fn new() -> Self {
        RtcClock {
            now: 0,
            base: DEFAULT_EPOCH,
            base_cycle: 0,
        }
    }

    /// Restart from `epoch` as of now
    pub fn set(&mut self, epoch: i64) {
        self.base = epoch;
        self.base_cycle = self.now;
    }

    /// Current time; while stopped the clock is frozen at its base
    pub fn epoch(&self, stopped: bool) -> i64 {
        if stopped {
            return self.base;
        }
        self.base + (self.now.saturating_sub(self.base_cycle) / CPU_HZ) as i64
    }
}

/// Days since 1970-01-01 -> (year, month, day) (proleptic Gregorian, era-based)
pub(crate) fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// (year, month, day) -> days since 1970-01-01
pub(crate) fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub(crate) fn bcd(v: u32) -> u8 {
    (((v / 10) << 4) | (v % 10)) as u8
}

pub(crate) fn unbcd(b: u8) -> u32 {
    (b >> 4) as u32 * 10 + (b & 15) as u32
}

impl Pcf85063 {
    pub fn new(addr: u8) -> Self {
        let mut d = Pcf85063 {
            addr,
            regs: [0; NREG],
            ptr: 0,
            expect_reg: false,
            clock: RtcClock::new(),
            dirty: false,
        };
        d.reset_regs();
        d
    }

    fn reset_regs(&mut self) {
        self.regs = [0; NREG];
        // Alarm enables are active low: all disabled after reset
        for r in 0x0b..=0x0f {
            self.regs[r] = 0x80;
        }
        self.regs[0x11] = 0x18;
    }

    /// Set the clock to `epoch` seconds (UTC) as of now
    pub fn set_epoch(&mut self, epoch: i64) {
        self.clock.set(epoch);
    }

    fn stopped(&self) -> bool {
        self.regs[0] & 0x20 != 0
    }

    pub fn epoch(&self) -> i64 {
        self.clock.epoch(self.stopped())
    }

    /// Copy the running time into the BCD registers
    fn latch(&mut self) {
        let t = self.epoch();
        let (days, s) = (t.div_euclid(86_400), t.rem_euclid(86_400) as u32);
        let (y, mo, d) = civil(days);
        let os = self.regs[4] & 0x80;
        self.regs[4] = os | bcd(s % 60);
        self.regs[5] = bcd(s / 60 % 60);
        self.regs[6] = bcd(s / 3600);
        self.regs[7] = bcd(d);
        // 1970-01-01 was a Thursday (weekday 4, Sunday = 0)
        self.regs[8] = (days + 4).rem_euclid(7) as u8;
        self.regs[9] = bcd(mo);
        self.regs[10] = bcd(y.rem_euclid(100) as u32);
    }

    /// Time registers written: restart the clock from them (years 2000..2099)
    fn rebase(&mut self) {
        let r = &self.regs;
        let days = days_from_civil(
            2000 + unbcd(r[10]) as i64,
            unbcd(r[9] & 0x1f).clamp(1, 12),
            unbcd(r[7] & 0x3f).max(1),
        );
        let secs = unbcd(r[6] & 0x3f) * 3600 + unbcd(r[5] & 0x7f) * 60 + unbcd(r[4] & 0x7f);
        self.clock.set(days * 86_400 + secs as i64);
    }
}

impl I2cDevice for Pcf85063 {
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
        let p = self.ptr as usize;
        if p == 0 {
            if b == 0x58 {
                self.reset_regs();
                self.ptr = 1;
                return true;
            }
            // STOP set: freeze at the current time; cleared: resume from it
            let was = self.stopped();
            let t = self.epoch();
            self.regs[0] = b;
            if was != self.stopped() {
                self.set_epoch(t);
            }
        } else {
            self.regs[p] = b;
            if (4..=10).contains(&p) {
                self.dirty = true;
            }
        }
        self.ptr = ((p + 1) % NREG) as u8;
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

    fn rd(d: &mut Pcf85063, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        let v = (0..n).map(|_| d.read()).collect();
        d.stop();
        v
    }

    #[test]
    fn calendar() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(DEFAULT_EPOCH / 86_400), (2026, 10, 16));
        assert_eq!(days_from_civil(2024, 2, 29), 19_782);
        assert_eq!(civil(19_782), (2024, 2, 29));
    }

    #[test]
    fn runs_and_sets() {
        let mut d = Pcf85063::new(0x51);
        // 2026-10-16 04:00:00 UTC, Friday (5)
        assert_eq!(rd(&mut d, 0x04, 7), [0x00, 0x00, 0x04, 0x16, 5, 0x10, 0x26]);
        d.set_time(CPU_HZ * 61);
        assert_eq!(rd(&mut d, 0x04, 2), [0x01, 0x01]);
        // Write 2025-12-31 23:59:58 (weekday 3), then 3 s later it is 2026-01-01 00:00:01
        d.start(false);
        for b in [0x04, 0x58, 0x59, 0x23, 0x31, 3, 0x12, 0x25] {
            d.write(b);
        }
        d.stop();
        d.set_time(CPU_HZ * 64);
        assert_eq!(rd(&mut d, 0x04, 7), [0x01, 0x00, 0x00, 0x01, 4, 0x01, 0x26]);
        // STOP freezes the clock
        d.start(false);
        d.write(0x00);
        d.write(0x20);
        d.stop();
        d.set_time(CPU_HZ * 100);
        assert_eq!(rd(&mut d, 0x04, 1), [0x01]);
        // Plain storage, wraps after 0x11
        d.start(false);
        d.write(0x03);
        d.write(0xa5);
        d.stop();
        assert_eq!(rd(&mut d, 0x03, 1), [0xa5]);
        assert_eq!(rd(&mut d, 0x11, 2), [0x18, 0x20]);
    }
}
