//! LP5562 4-channel LED driver (I2C 0x30..0x33; M5 AtomS3R LCD backlight on the W channel), per the TI LP5562 datasheet: 0x00 ENABLE
//! (bit6 CHIP_EN), 0x02 / 0x03 / 0x04 B / G / R PWM, 0x05..0x07 B / G / R current (reset 0xAF), 0x08 CONFIG, 0x0D reset (write 0xFF),
//! 0x0E W PWM, 0x0F W current, 0x70 LED_MAP (2 bits per channel, 0 = I2C PWM register; W bits 7:6, R 5:4, G 3:2, B 1:0). Auto-increment.
//! `pwm(ch)` gives the effective duty 0..255 of channel B / G / R / W (0 while CHIP_EN is off or the channel is mapped to an engine:
//! the program engines are not modelled and their accesses are counted in `unimpl`). (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use std::any::Any;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    B,
    G,
    R,
    W,
}

pub struct Lp5562 {
    pub addr: u8,
    regs: [u8; 128],
    ptr: u8,
    expect_reg: bool,
    pub unimpl: BTreeMap<u8, u64>,
}

impl Lp5562 {
    pub fn new(addr: u8) -> Self {
        let mut d = Lp5562 {
            addr,
            regs: [0; 128],
            ptr: 0,
            expect_reg: false,
            unimpl: BTreeMap::new(),
        };
        d.reset();
        d
    }

    fn reset(&mut self) {
        self.regs = [0; 128];
        for r in [0x05, 0x06, 0x07, 0x0f] {
            self.regs[r] = 0xaf;
        }
        self.regs[0x70] = 0x39; // reset map: B / G / R to engines 1..3, W to I2C (datasheet default)
    }

    /// Effective PWM duty (0..255) of a channel
    pub fn pwm(&self, ch: Channel) -> u8 {
        if self.regs[0x00] & 0x40 == 0 {
            return 0;
        }
        let (reg, shift) = match ch {
            Channel::B => (0x02, 0),
            Channel::G => (0x03, 2),
            Channel::R => (0x04, 4),
            Channel::W => (0x0e, 6),
        };
        if (self.regs[0x70] >> shift) & 3 != 0 {
            return 0;
        }
        self.regs[reg]
    }

    /// Current setting of a channel in 0.1 mA steps
    pub fn current(&self, ch: Channel) -> u8 {
        self.regs[match ch {
            Channel::B => 0x05,
            Channel::G => 0x06,
            Channel::R => 0x07,
            Channel::W => 0x0f,
        }]
    }

    fn note(&mut self, r: u8) {
        if !matches!(r, 0x00 | 0x02..=0x08 | 0x0c..=0x0f | 0x70) {
            *self.unimpl.entry(r).or_insert(0) += 1;
        }
    }
}

impl I2cDevice for Lp5562 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b & 0x7f;
            self.expect_reg = false;
            return true;
        }
        let p = self.ptr;
        self.note(p);
        match p {
            0x0d => {
                if b == 0xff {
                    self.reset();
                }
            }
            0x0c => {} // STATUS is read-only
            _ => self.regs[p as usize] = b,
        }
        self.ptr = (p + 1) & 0x7f;
        true
    }
    fn read(&mut self) -> u8 {
        let p = self.ptr;
        self.note(p);
        self.ptr = (p + 1) & 0x7f;
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

    fn wr(d: &mut Lp5562, reg: u8, data: &[u8]) {
        d.start(false);
        d.write(reg);
        for b in data {
            d.write(*b);
        }
        d.stop();
    }

    fn rd(d: &mut Lp5562, reg: u8) -> u8 {
        d.start(false);
        d.write(reg);
        d.start(true);
        d.read()
    }

    #[test]
    fn atoms3r_backlight() {
        let mut d = Lp5562::new(0x30);
        assert_eq!(rd(&mut d, 0x05), 0xaf);
        // M5GFX AtomS3R init: CHIP_EN, CONFIG, all channels to I2C, then brightness on W
        wr(&mut d, 0x0e, &[200]);
        assert_eq!(d.pwm(Channel::W), 0);
        wr(&mut d, 0x00, &[0x40]);
        wr(&mut d, 0x08, &[0x01]);
        wr(&mut d, 0x70, &[0x00]);
        assert_eq!(d.pwm(Channel::W), 200);
        assert_eq!(rd(&mut d, 0x0e), 200);
        wr(&mut d, 0x02, &[1, 2, 3]);
        assert_eq!(
            [d.pwm(Channel::B), d.pwm(Channel::G), d.pwm(Channel::R)],
            [1, 2, 3]
        );
        // R to an engine: not driven by its PWM register
        wr(&mut d, 0x70, &[0x30]);
        assert_eq!(d.pwm(Channel::R), 0);
        assert!(d.unimpl.is_empty());
        wr(&mut d, 0x0d, &[0xff]);
        assert_eq!(d.pwm(Channel::W), 0);
        assert_eq!(rd(&mut d, 0x0e), 0);
    }
}
