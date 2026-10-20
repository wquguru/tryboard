//! AXP2101 PMIC (I2C 0x34), per the X-Powers AXP2101 datasheet and XPowersLib (MIT): 0x00 status 1 (bit5 VBUS good, bit3 battery present),
//! 0x01 status 2 (bits 6:5 current direction 0 standby / 1 charge / 2 discharge, bits 2:0 charger state), 0x03 chip ID 0x4A, ADC 0x34/35 VBAT
//! (14 bit mV), 0x38/39 VBUS, 0x3A/3B VSYS, 0xA4 battery percent; IRQ enable 0x40..0x42, status 0x48..0x4A (write 1 to clear; 0x49 bit3 PWRON
//! short, bit2 long, bit1 / bit0 falling / rising edge, bit7 / bit6 VBUS in / out; 0x4A bit3 / bit4 charge start / done). Status bits latch
//! only when enabled. DCDC / LDO enables and voltages are plain storage. Battery level is static (no charge model), ADC values ignore the
//! 0x30 channel enables, the IRQ pin is not driven. Other registers read back what was written and count as unmodelled. (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use std::any::Any;
use std::collections::BTreeMap;

pub const CHIP_ID: u8 = 0x4A;

pub struct Axp2101 {
    pub addr: u8,
    regs: [u8; 256],
    ptr: u8,
    expect_reg: bool,
    pub percent: u8,
    pub usb: bool,
    /// Accesses to registers without a model (register -> count)
    pub unimpl: BTreeMap<u8, u64>,
    pub pwrkeys: u64,
}

/// Registers the model knows (behaviour or datasheet storage)
fn modelled(r: u8) -> bool {
    matches!(r,
        0x00..=0x01 | 0x03 | 0x04..=0x07 | 0x10 | 0x12 | 0x13..=0x1a | 0x22..=0x27
        | 0x30 | 0x34..=0x3d | 0x40..=0x42 | 0x48..=0x4a | 0x50..=0x54 | 0x61..=0x64
        | 0x69 | 0x80..=0x87 | 0x90..=0x9a | 0xa2 | 0xa4)
}

/// Rough open-circuit voltage curve for a 1-cell Li-ion (mV), estimate
pub fn ocv_mv(pct: u8) -> u16 {
    const T: [(u8, u16); 6] = [
        (0, 3300),
        (10, 3600),
        (50, 3800),
        (80, 3950),
        (90, 4050),
        (100, 4150),
    ];
    let p = pct.min(100);
    let i = T.iter().position(|e| e.0 >= p).unwrap_or(5).max(1);
    let ((p0, v0), (p1, v1)) = (T[i - 1], T[i]);
    v0 + ((v1 - v0) as u32 * (p - p0) as u32 / (p1 - p0) as u32) as u16
}

impl Axp2101 {
    pub fn new(addr: u8) -> Self {
        let mut regs = [0u8; 256];
        regs[0x03] = CHIP_ID;
        // Board default rails: DCDC1 3.3 V on (ESP32-S3), ALDO1..4 / BLDO1..2 on (sensors, display, audio), estimate
        regs[0x80] = 0x01;
        regs[0x82] = 18; // DCDC1: 1.5 V + 18 * 0.1 V = 3.3 V
        regs[0x90] = 0x3f;
        for r in regs.iter_mut().take(0x98).skip(0x92) {
            *r = 28; // 0.5 V + 28 * 0.1 V = 3.3 V
        }
        regs[0x30] = 0x0b;
        regs[0x27] = 0x00;
        let mut d = Axp2101 {
            addr,
            regs,
            ptr: 0,
            expect_reg: false,
            percent: 80,
            usb: true,
            unimpl: BTreeMap::new(),
            pwrkeys: 0,
        };
        d.update();
        d
    }

    fn latch_irq(&mut self, reg: usize, bits: u8) {
        self.regs[reg] |= bits & self.regs[reg - 8];
    }

    /// Battery level and USB plug: action `bat=pct[,usb]`; raises VBUS in/out and charge start/done IRQs on change
    pub fn set_battery(&mut self, percent: u8, usb: bool) {
        let (was_usb, was_charging) = (self.usb, self.charging());
        self.percent = percent.min(100);
        self.usb = usb;
        if usb != was_usb {
            self.latch_irq(0x49, if usb { 0x80 } else { 0x40 });
        }
        if self.charging() && !was_charging {
            self.latch_irq(0x4a, 0x08);
        }
        if usb && self.percent == 100 && was_charging {
            self.latch_irq(0x4a, 0x10);
        }
        self.update();
    }

    /// PWRON key: short or long press (a full press: falling then rising edge)
    pub fn pwrkey(&mut self, long: bool) {
        self.pwrkeys += 1;
        self.latch_irq(0x49, if long { 0x04 } else { 0x08 } | 0x03);
    }

    fn charging(&self) -> bool {
        self.usb && self.percent < 100
    }

    fn update(&mut self) {
        let charging = self.charging();
        let r = &mut self.regs;
        r[0x00] = if self.usb { 0x20 } else { 0 } | 0x18; // BATFET on, battery present
        r[0x01] = if charging {
            0x20 | 0x10 | 2 // charging, system on, constant current
        } else if self.usb {
            0x10 | 4 // standby, done
        } else {
            0x40 | 0x10 | 5 // discharging, not charging
        };
        let vbat = ocv_mv(self.percent) + if charging { 50 } else { 0 };
        let vbus = if self.usb { 5000 } else { 0 };
        let vsys = if self.usb { 4900 } else { vbat };
        for (reg, v) in [(0x34, vbat), (0x38, vbus), (0x3a, vsys)] {
            r[reg] = (v >> 8) as u8 & 0x3f;
            r[reg + 1] = v as u8;
        }
        r[0x3c] = 0x08; // die temperature: placeholder raw value
        r[0xa4] = self.percent;
    }

    fn note(&mut self, reg: u8) {
        if !modelled(reg) {
            *self.unimpl.entry(reg).or_insert(0) += 1;
        }
    }
}

impl I2cDevice for Axp2101 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b;
            self.expect_reg = false;
            return true;
        }
        let p = self.ptr;
        self.note(p);
        match p {
            // Status, chip ID, ADC results and fuel gauge are read-only
            0x00 | 0x01 | 0x03 | 0x34..=0x3d | 0xa4 => {}
            0x48..=0x4a => self.regs[p as usize] &= !b,
            _ => self.regs[p as usize] = b,
        }
        self.ptr = p.wrapping_add(1);
        true
    }
    fn read(&mut self) -> u8 {
        let p = self.ptr;
        self.note(p);
        self.ptr = p.wrapping_add(1);
        self.regs[p as usize]
    }
    fn stop(&mut self) {}
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rd(d: &mut Axp2101, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    fn wr(d: &mut Axp2101, reg: u8, v: &[u8]) {
        d.start(false);
        d.write(reg);
        for b in v {
            d.write(*b);
        }
    }

    fn h6l8(r: &[u8]) -> u16 {
        ((r[0] & 0x3f) as u16) << 8 | r[1] as u16
    }

    #[test]
    fn status_and_adc() {
        let mut d = Axp2101::new(0x34);
        assert_eq!(rd(&mut d, 0x03, 1), [CHIP_ID]);
        d.set_battery(98, true);
        let s = rd(&mut d, 0x00, 2);
        assert_eq!((s[0] >> 5 & 1, s[1] >> 5 & 3, s[1] & 7), (1, 1, 2));
        assert_eq!(rd(&mut d, 0xa4, 1), [98]);
        let a = rd(&mut d, 0x34, 8);
        assert!((4100..4250).contains(&h6l8(&a[0..2])));
        assert_eq!(h6l8(&a[4..6]), 5000);
        d.set_battery(40, false);
        let s = rd(&mut d, 0x00, 2);
        assert_eq!((s[0] >> 5 & 1, s[1] >> 5 & 3, s[1] & 7), (0, 2, 5));
        assert_eq!(h6l8(&rd(&mut d, 0x38, 2)), 0);
        assert!((3700..3800).contains(&h6l8(&rd(&mut d, 0x34, 2))));
        // Read-only: writes to the gauge are ignored
        wr(&mut d, 0xa4, &[7]);
        assert_eq!(rd(&mut d, 0xa4, 1), [40]);
        assert!(d.unimpl.is_empty());
    }

    #[test]
    fn irq_latch_and_clear() {
        let mut d = Axp2101::new(0x34);
        // Not enabled: nothing latches
        d.pwrkey(false);
        assert_eq!(rd(&mut d, 0x49, 1), [0]);
        wr(&mut d, 0x41, &[0xcf]);
        d.pwrkey(false);
        assert_eq!(rd(&mut d, 0x49, 1), [0x0b]);
        d.pwrkey(true);
        assert_eq!(rd(&mut d, 0x49, 1), [0x0f]);
        wr(&mut d, 0x49, &[0x08]);
        assert_eq!(rd(&mut d, 0x49, 1), [0x07]);
        wr(&mut d, 0x48, &[0xff, 0xff, 0xff]);
        assert_eq!(rd(&mut d, 0x48, 3), [0, 0, 0]);
        d.set_battery(50, false);
        assert_eq!(rd(&mut d, 0x49, 1), [0x40]);
    }

    #[test]
    fn rails_store_and_unimpl() {
        let mut d = Axp2101::new(0x34);
        wr(&mut d, 0x92, &[0x0d]);
        assert_eq!(rd(&mut d, 0x92, 1), [0x0d]);
        wr(&mut d, 0xe0, &[0x5a]);
        assert_eq!(rd(&mut d, 0xe0, 1), [0x5a]);
        assert_eq!(d.unimpl.get(&0xe0), Some(&2));
    }
}
