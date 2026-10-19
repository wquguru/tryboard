//! CST816S self-capacitive touch controller (I2C 0x15), as on the Waveshare 1.28" round touch board (GC9A01 + CST816S).
//! Registers per Hynitron's CST816S notes: 0x01 GestureID, 0x02 FingerNum, 0x03/0x04 X (0x03 top 2 bits = event: 0 down, 1 up, 2 contact),
//! 0x05/0x06 Y, 0xA7 ChipID (0xB5), 0xA8 ProjID, 0xA9 FwVersion, 0xEC-0xFE config (stored, not interpreted). Auto-increment.
//! Gestures are decided on-chip: > 30 px from press = swipe (0x01 up, 0x02 down, 0x03 left, 0x04 right), held still 1 s = long press 0x0C,
//! release without moving = tap 0x05. INT (driven by Machine) is low while pressed (real chips pulse per scan; level works for both driver styles).
//! Not done: auto-sleep (real chip stops answering I2C after a few idle seconds; hardware only), double tap, TP_RST. (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

pub const CHIP_ID: u8 = 0xb5;
const SWIPE_PX: i32 = 30;

pub mod gesture {
    pub const NONE: u8 = 0x00;
    pub const UP: u8 = 0x01;
    pub const DOWN: u8 = 0x02;
    pub const LEFT: u8 = 0x03;
    pub const RIGHT: u8 = 0x04;
    pub const CLICK: u8 = 0x05;
    pub const LONG: u8 = 0x0c;
}

pub struct Cst816s {
    pub addr: u8,
    regs: [u8; 256],
    ptr: u8,
    expect_reg: bool,
    now: u64,
    /// Pressed: (current x, y)
    touch: Option<(u16, u16)>,
    /// Start point and time of this press
    down_at: (u16, u16, u64),
    moved: bool,
    /// Not yet read since press (event reports "down" once, then "contact")
    fresh: bool,
    pub presses: u64,
    pub reads: u64,
}

impl Cst816s {
    pub fn new(addr: u8) -> Self {
        let mut regs = [0u8; 256];
        regs[0xa7] = CHIP_ID;
        regs[0xa8] = 0x00;
        regs[0xa9] = 0x01;
        regs[0xec] = 0x00;
        regs[0xed] = 10; // IrqPluseWidth: 10 x 0.1 ms
        regs[0xee] = 1;
        regs[0xfa] = 0x60; // IrqCtl: EnTouch | EnChange
        regs[0xfb] = 2;
        Cst816s {
            addr,
            regs,
            ptr: 0,
            expect_reg: false,
            now: 0,
            touch: None,
            down_at: (0, 0, 0),
            moved: false,
            fresh: false,
            presses: 0,
            reads: 0,
        }
    }

    pub fn touching(&self) -> bool {
        self.touch.is_some()
    }

    /// Finger down / move (now = current CPU cycle)
    pub fn press(&mut self, x: u16, y: u16, now: u64) {
        let (x, y) = (x.min(239), y.min(239));
        if self.touch.is_none() {
            self.down_at = (x, y, now);
            self.moved = false;
            self.fresh = true;
            self.presses += 1;
            self.regs[0x01] = gesture::NONE;
        }
        self.touch = Some((x, y));
        let dx = x as i32 - self.down_at.0 as i32;
        let dy = y as i32 - self.down_at.1 as i32;
        if dx.abs() > SWIPE_PX || dy.abs() > SWIPE_PX {
            self.moved = true;
            // Screen y points down: swiping up = y decreases
            self.regs[0x01] = if dx.abs() > dy.abs() {
                if dx > 0 {
                    gesture::RIGHT
                } else {
                    gesture::LEFT
                }
            } else if dy < 0 {
                gesture::UP
            } else {
                gesture::DOWN
            };
        }
        self.latch(now);
    }

    /// Finger up
    pub fn release(&mut self, now: u64) {
        if self.touch.take().is_none() {
            return;
        }
        self.now = now;
        if !self.moved {
            self.regs[0x01] = if now.saturating_sub(self.down_at.2) >= CPU_HZ {
                gesture::LONG
            } else {
                gesture::CLICK
            };
        }
        self.regs[0x02] = 0;
        self.regs[0x03] = (self.regs[0x03] & 0x0f) | 0x40; // event = up
    }

    /// Refresh gesture (long press depends on time) and coordinate registers
    fn latch(&mut self, now: u64) {
        self.now = now;
        let Some((x, y)) = self.touch else { return };
        if !self.moved && now.saturating_sub(self.down_at.2) >= CPU_HZ {
            self.regs[0x01] = gesture::LONG;
        }
        let ev = if self.fresh { 0x00 } else { 0x80 };
        self.regs[0x02] = 1;
        self.regs[0x03] = ev | ((x >> 8) as u8 & 0x0f);
        self.regs[0x04] = x as u8;
        self.regs[0x05] = (y >> 8) as u8 & 0x0f;
        self.regs[0x06] = y as u8;
    }
}

impl I2cDevice for Cst816s {
    fn address(&self) -> u8 {
        self.addr
    }
    fn set_time(&mut self, now: u64) {
        self.latch(now);
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
            // 0x00..0x06 is the read-only report area; everything else is stored as config
            if self.ptr >= 0xec {
                self.regs[self.ptr as usize] = b;
            }
            self.ptr = self.ptr.wrapping_add(1);
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.regs[self.ptr as usize];
        if self.ptr == 0x03 && self.touch.is_some() {
            // Once the host has read "down", report "contact"
            self.fresh = false;
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

    fn rd(d: &mut Cst816s, reg: u8, n: usize, now: u64) -> Vec<u8> {
        d.set_time(now);
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    #[test]
    fn report_and_gestures() {
        let mut d = Cst816s::new(0x15);
        assert_eq!(rd(&mut d, 0xa7, 1, 0), [0xb5]);
        assert_eq!(rd(&mut d, 0x01, 6, 0), [0, 0, 0, 0, 0, 0]);
        d.press(200, 37, 100);
        assert_eq!(rd(&mut d, 0x01, 6, 200), [0, 1, 0x00, 200, 0, 37]);
        // Second read: event becomes "contact"
        assert_eq!(rd(&mut d, 0x03, 1, 300)[0] >> 6, 2);
        d.release(400);
        let r = rd(&mut d, 0x01, 3, 500);
        assert_eq!((r[0], r[1], r[2] >> 6), (gesture::CLICK, 0, 1));
        // Swipe left
        d.press(150, 120, 1000);
        d.press(90, 125, 2000);
        d.release(3000);
        assert_eq!(rd(&mut d, 0x01, 1, 3100), [gesture::LEFT]);
        // Long press, 1 s
        d.press(120, 120, 10_000);
        assert_eq!(rd(&mut d, 0x01, 1, 10_000 + CPU_HZ), [gesture::LONG]);
        d.release(20_000 + CPU_HZ);
        assert_eq!(rd(&mut d, 0x01, 1, 30_000 + CPU_HZ), [gesture::LONG]);
    }
}
