//! FT6236 self-capacitive touch controller (I2C 0x38), common on 3.5" 320x480 touch panels. Per FocalTech FT6x36 datasheet/app note:
//! 0x00 DEV_MODE, 0x01 GEST_ID, 0x02 TD_STATUS (low 4 bits = touches), 0x03 P1_XH ([7:6] event 0 down/1 up/2 contact/3 none; [3:0] X hi),
//! 0x04 P1_XL, 0x05 P1_YH ([7:4] ID; [3:0] Y hi), 0x06 P1_YL, 0x07 WEIGHT, 0x08 MISC, 0x09..0x0E point 2, 0x80 TH_GROUP, 0x86 CTRL,
//! 0x88 PERIODACTIVE, 0xA1/A2 LIB_VER, 0xA3 CIPHER (0x36), 0xA4 G_MODE, 0xA5 PWR_MODE, 0xA6 FIRMID, 0xA8 VENDOR (0x11), 0xAF. Auto-increment.
//! One finger only, 12-bit coords, GEST_ID always 0 (most module firmware doesn't report it). INT (driven by Machine) is low while
//! pressed, level-only for both G_MODE values. Not done: sleep/wake (PWR_MODE=3 stops I2C until RST), multi-touch, weight/area. (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use std::any::Any;

pub const CHIP_ID: u8 = 0x36;
pub const FOCALTECH_ID: u8 = 0x11;
/// FT6336U (M5 Core2 / CoreS3), from FocalTech's FT6x36 family table
pub const CHIP_ID_FT6336U: u8 = 0x64;
/// FT3267 (M5Dial): M5GFX only logs CIPHER and needs VENDID != 0, so this value is unverified on hardware
pub const CHIP_ID_FT3267: u8 = 0x33;

pub struct Ft6236 {
    pub addr: u8,
    regs: [u8; 256],
    ptr: u8,
    expect_reg: bool,
    /// Pressed: (current x, y)
    touch: Option<(u16, u16)>,
    /// Not yet read since press (event reports "down" once, then "contact")
    fresh: bool,
    pub presses: u64,
    pub reads: u64,
}

impl Ft6236 {
    pub fn new(addr: u8) -> Self {
        Self::with_cipher(addr, CHIP_ID)
    }

    /// Same register layout, different CIPHER (0xA3): FT6336U, FT3267
    pub fn with_cipher(addr: u8, cipher: u8) -> Self {
        let mut regs = [0u8; 256];
        // Both point slots "no event", ID 0xF (invalid)
        regs[0x03] = 0xc0;
        regs[0x05] = 0xf0;
        regs[0x09] = 0xc0;
        regs[0x0b] = 0xf0;
        regs[0x80] = 0x16; // TH_GROUP: factory touch threshold (set by module firmware; a common value)
        regs[0x88] = 0x0e; // PERIODACTIVE: scan period in active mode
        regs[0xa1] = 0x30; // LIB_VER_H / L
        regs[0xa2] = 0x03;
        regs[0xa3] = cipher;
        // G_MODE: 0 = polling (INT held low while pressed), matching the INT modelled here; factory default varies by module, to verify on hardware
        regs[0xa4] = 0x00;
        regs[0xa6] = 0x10; // FIRMID
        regs[0xa8] = FOCALTECH_ID;
        regs[0xaf] = 0x01;
        Ft6236 {
            addr,
            regs,
            ptr: 0,
            expect_reg: false,
            touch: None,
            fresh: false,
            presses: 0,
            reads: 0,
        }
    }

    pub fn touching(&self) -> bool {
        self.touch.is_some()
    }

    /// Finger down / move (12-bit coordinates)
    pub fn press(&mut self, x: u16, y: u16) {
        let (x, y) = (x.min(0xfff), y.min(0xfff));
        if self.touch.is_none() {
            self.fresh = true;
            self.presses += 1;
        }
        self.touch = Some((x, y));
        self.latch();
    }

    /// Finger up: touch count cleared, event reports "up", last coordinates kept
    pub fn release(&mut self) {
        if self.touch.take().is_none() {
            return;
        }
        self.regs[0x02] = 0;
        self.regs[0x03] = (self.regs[0x03] & 0x0f) | 0x40;
    }

    fn latch(&mut self) {
        let Some((x, y)) = self.touch else { return };
        let ev = if self.fresh { 0x00 } else { 0x80 };
        self.regs[0x02] = 1;
        self.regs[0x03] = ev | (x >> 8) as u8;
        self.regs[0x04] = x as u8;
        self.regs[0x05] = (y >> 8) as u8; // point ID 0
        self.regs[0x06] = y as u8;
        self.regs[0x07] = 0x20;
        self.regs[0x08] = 0x10;
    }
}

impl I2cDevice for Ft6236 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        if read {
            self.reads += 1;
        }
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b;
            self.expect_reg = false;
        } else {
            // Config areas at 0x00 and 0x80+ are writable; the 0x01..0x0E report area and 0xA1.. ID area are read-only
            if self.ptr == 0x00
                || (0x80..0xa0).contains(&self.ptr)
                || (0xa4..=0xa5).contains(&self.ptr)
            {
                self.regs[self.ptr as usize] = b;
            }
            self.ptr = self.ptr.wrapping_add(1);
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.regs[self.ptr as usize];
        if self.ptr == 0x03 && self.touch.is_some() && self.fresh {
            // Once the host has read "down", report "contact"
            self.fresh = false;
            self.regs[0x03] = (self.regs[0x03] & 0x0f) | 0x80;
        }
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

    fn rd(d: &mut Ft6236, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    #[test]
    fn ids_and_report() {
        let mut d = Ft6236::new(0x38);
        assert_eq!(rd(&mut d, 0xa3, 1), [0x36]);
        assert_eq!(rd(&mut d, 0xa8, 1), [0x11]);
        // Not pressed: 0 touches, event "none"
        assert_eq!(rd(&mut d, 0x02, 2), [0, 0xc0]);
        // Press at (300, 450): 12-bit coordinates split into high 4 + low 8 bits
        d.press(300, 450);
        assert_eq!(
            rd(&mut d, 0x00, 7),
            [0, 0, 1, 0x01, (300 & 0xff) as u8, 0x01, (450 & 0xff) as u8]
        );
        // Second read: event becomes "contact"
        assert_eq!(rd(&mut d, 0x03, 1)[0] >> 6, 2);
        d.press(310, 440);
        assert_eq!(
            rd(&mut d, 0x03, 4),
            [0x81, (310 & 0xff) as u8, 0x01, (440 & 0xff) as u8]
        );
        d.release();
        let r = rd(&mut d, 0x02, 2);
        assert_eq!((r[0], r[1] >> 6), (0, 1));
        // Press again: "down" again
        d.press(5, 6);
        assert_eq!(rd(&mut d, 0x03, 1)[0] >> 6, 0);
        // G_MODE / threshold writes read back; the ID area ignores writes
        d.start(false);
        d.write(0xa3);
        d.write(0x00);
        d.write(0x01);
        assert_eq!(rd(&mut d, 0xa3, 2), [0x36, 0x01]);
        d.start(false);
        d.write(0x80);
        d.write(0x28);
        assert_eq!(rd(&mut d, 0x80, 1), [0x28]);
    }

    #[test]
    fn other_ciphers() {
        let mut d = Ft6236::with_cipher(0x38, CHIP_ID_FT6336U);
        assert_eq!(rd(&mut d, 0xa3, 6), [0x64, 0x00, 0x00, 0x10, 0x00, 0x11]);
        d.press(100, 200);
        assert_eq!(rd(&mut d, 0x02, 1), [1]);
        let mut d = Ft6236::with_cipher(0x38, CHIP_ID_FT3267);
        assert_eq!(rd(&mut d, 0xa3, 1), [0x33]);
    }
}
