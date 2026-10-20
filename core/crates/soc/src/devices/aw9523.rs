//! AW9523B 16-bit I/O expander / LED driver (I2C 0x58..0x5B), per the Awinic AW9523B datasheet: 0x00/01 input P0/P1, 0x02/03 output,
//! 0x04/05 config (1 = input), 0x06/07 interrupt enable (0 = enabled), 0x10 ID 0x23, 0x11 CTL (bit4 P0 push-pull, bits1:0 LED Imax),
//! 0x12/13 mode (1 = GPIO, 0 = LED), 0x20..0x2F DIM (0x20..0x23 P1_0..3, 0x24..0x2B P0_0..7, 0x2C..0x2F P1_4..7), 0x7F soft reset.
//! Auto-increment. Inputs read the levels set by `set_input` (default high: pulled up); output pins read back their output. INT is
//! pending while an enabled input differs from what the host last read from its port (reading the port clears it). Board presets read
//! `pin` / `output` to map e.g. CoreS3 LCD reset or boost enable to effects. Reset values of output / config are 0 (to verify on
//! hardware: the datasheet ties output defaults to AD pins). LED current is not modelled beyond the stored DIM value. (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use std::any::Any;

pub const CHIP_ID: u8 = 0x23;

pub struct Aw9523 {
    pub addr: u8,
    regs: [u8; 128],
    ptr: u8,
    expect_reg: bool,
    /// Levels driven onto input pins from outside
    ext: [u8; 2],
    /// Port values the host last read (interrupt reference)
    seen: [u8; 2],
    pub writes: u64,
}

impl Aw9523 {
    pub fn new(addr: u8) -> Self {
        let mut d = Aw9523 {
            addr,
            regs: [0; 128],
            ptr: 0,
            expect_reg: false,
            ext: [0xff; 2],
            seen: [0xff; 2],
            writes: 0,
        };
        d.reset();
        d
    }

    fn reset(&mut self) {
        self.regs = [0; 128];
        self.regs[0x10] = CHIP_ID;
        self.regs[0x12] = 0xff;
        self.regs[0x13] = 0xff;
        self.seen = self.port_levels();
    }

    fn port_levels(&self) -> [u8; 2] {
        let lv = |p: usize| {
            let cfg = self.regs[0x04 + p];
            (self.ext[p] & cfg) | (self.regs[0x02 + p] & !cfg)
        };
        [lv(0), lv(1)]
    }

    /// Drive an input pin from outside (button, touch INT, ...)
    pub fn set_input(&mut self, port: usize, bit: u8, high: bool) {
        let m = 1u8 << (bit & 7);
        let p = port & 1;
        self.ext[p] = if high {
            self.ext[p] | m
        } else {
            self.ext[p] & !m
        };
    }

    /// Output register value of a port (bits of pins configured as GPIO outputs are meaningful)
    pub fn output(&self, port: usize) -> u8 {
        self.regs[0x02 + (port & 1)]
    }

    /// Level of a pin the chip drives: Some(level) for a GPIO-mode output, None for an input or LED pin.
    /// P0 in open-drain mode releases high (board pull-ups assumed).
    pub fn pin(&self, port: usize, bit: u8) -> Option<bool> {
        let (p, m) = (port & 1, 1u8 << (bit & 7));
        let gpio = self.regs[0x12 + p] & m != 0;
        let out = self.regs[0x04 + p] & m == 0;
        (gpio && out).then_some(self.regs[0x02 + p] & m != 0)
    }

    /// DIM value (0..255) of a pin in LED mode, None in GPIO mode
    pub fn led_dim(&self, port: usize, bit: u8) -> Option<u8> {
        let (p, b) = (port & 1, (bit & 7) as usize);
        if self.regs[0x12 + p] & (1 << b) != 0 {
            return None;
        }
        let r = match (p, b) {
            (0, b) => 0x24 + b,
            (_, b) if b < 4 => 0x20 + b,
            (_, b) => 0x2c + b - 4,
        };
        Some(self.regs[r])
    }

    /// INT pin asserted (active low on the chip)
    pub fn int_pending(&self) -> bool {
        let now = self.port_levels();
        (0..2).any(|p| {
            let watch = self.regs[0x04 + p] & !self.regs[0x06 + p] & self.regs[0x12 + p];
            (now[p] ^ self.seen[p]) & watch != 0
        })
    }

    fn read_reg(&mut self, r: u8) -> u8 {
        match r {
            0x00 | 0x01 => {
                let v = self.port_levels()[r as usize];
                self.seen[r as usize] = v;
                v
            }
            0x20..=0x2f => 0, // DIM registers are write-only
            _ => self.regs[r as usize],
        }
    }

    fn write_reg(&mut self, r: u8, v: u8) {
        self.writes += 1;
        match r {
            0x00 | 0x01 | 0x10 => {}
            0x7f => {
                if v == 0 {
                    self.reset();
                }
            }
            0x04 | 0x05 => {
                // A pin turned into an input starts from its current level, not from a change
                self.regs[r as usize] = v;
                let p = (r - 0x04) as usize;
                self.seen[p] = self.port_levels()[p];
            }
            _ => self.regs[r as usize] = v,
        }
    }
}

impl I2cDevice for Aw9523 {
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
        } else {
            self.write_reg(self.ptr, b);
            self.ptr = (self.ptr + 1) & 0x7f;
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.read_reg(self.ptr);
        self.ptr = (self.ptr + 1) & 0x7f;
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

    fn rd(d: &mut Aw9523, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    fn wr(d: &mut Aw9523, reg: u8, data: &[u8]) {
        d.start(false);
        d.write(reg);
        for b in data {
            d.write(*b);
        }
        d.stop();
    }

    #[test]
    fn id_outputs_and_inputs() {
        let mut d = Aw9523::new(0x58);
        assert_eq!(rd(&mut d, 0x10, 1), [0x23]);
        // CoreS3-style init: P0 / P1 outputs, P1 bit7 = boost enable, P1_0..1 inputs (touch INT)
        wr(&mut d, 0x02, &[0x07, 0x83, 0x18, 0x03]);
        wr(&mut d, 0x11, &[0x10]);
        assert_eq!(rd(&mut d, 0x02, 4), [0x07, 0x83, 0x18, 0x03]);
        assert_eq!(d.pin(1, 7), Some(true));
        assert_eq!(d.pin(0, 1), Some(true));
        assert_eq!(d.pin(0, 3), None); // configured as input
        assert_eq!(d.pin(1, 0), None);
        // Input follows the outside level; output pins read back their output
        assert_eq!(rd(&mut d, 0x01, 1), [0x83 & !0x03 | 0x03]);
        assert!(!d.int_pending());
        d.set_input(1, 0, false);
        assert!(d.int_pending());
        assert_eq!(rd(&mut d, 0x01, 1)[0] & 0x01, 0);
        assert!(!d.int_pending());
        // Masked pins don't interrupt
        wr(&mut d, 0x07, &[0x01]);
        d.set_input(1, 0, true);
        assert!(!d.int_pending());
        // LED mode and soft reset
        wr(&mut d, 0x12, &[0xfe]);
        wr(&mut d, 0x24, &[0x80]);
        assert_eq!(d.led_dim(0, 0), Some(0x80));
        assert_eq!(d.led_dim(0, 1), None);
        wr(&mut d, 0x7f, &[0x00]);
        assert_eq!(rd(&mut d, 0x02, 1), [0x00]);
        assert_eq!(rd(&mut d, 0x10, 1), [0x23]);
    }
}
