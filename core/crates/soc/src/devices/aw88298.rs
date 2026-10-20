//! AW88298 I2S smart amplifier shell (I2C 0x36; M5 CoreS3 speaker), per the Awinic AW88298 datasheet: 16-bit big-endian registers with
//! an auto-incrementing pointer, 0x00 ID 0x1852 (writing 0x55AA there is a soft reset), the rest storage. Enough for the driver to
//! probe and configure; audio goes through the I2S model, and the amplifier gain / mute are only exposed as stored values. (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use std::any::Any;

pub const CHIP_ID: u16 = 0x1852;

pub struct Aw88298 {
    pub addr: u8,
    regs: [u16; 0x80],
    ptr: u8,
    expect_reg: bool,
    half: u8,
    word: u16,
    pub writes: u64,
}

impl Aw88298 {
    pub fn new(addr: u8) -> Self {
        let mut d = Aw88298 {
            addr,
            regs: [0; 0x80],
            ptr: 0,
            expect_reg: false,
            half: 0,
            word: 0,
            writes: 0,
        };
        d.reset();
        d
    }

    fn reset(&mut self) {
        self.regs = [0; 0x80];
        self.regs[0] = CHIP_ID;
    }

    /// Stored value of a register (board presets: e.g. 0x04 SYSCTRL power-down / amp enable)
    pub fn reg(&self, r: u8) -> u16 {
        self.regs[(r & 0x7f) as usize]
    }
}

impl I2cDevice for Aw88298 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        self.half = 0;
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b & 0x7f;
            self.expect_reg = false;
        } else if self.half == 0 {
            self.word = (b as u16) << 8;
            self.half = 1;
        } else {
            let v = self.word | b as u16;
            self.writes += 1;
            match self.ptr {
                0x00 if v == 0x55aa => self.reset(),
                0x00 => {}
                p => self.regs[p as usize] = v,
            }
            self.half = 0;
            self.ptr = (self.ptr + 1) & 0x7f;
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.regs[self.ptr as usize];
        self.half ^= 1;
        if self.half == 1 {
            (v >> 8) as u8
        } else {
            self.ptr = (self.ptr + 1) & 0x7f;
            v as u8
        }
    }
    fn stop(&mut self) {}
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rd(d: &mut Aw88298, reg: u8, n: usize) -> Vec<u16> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n)
            .map(|_| (d.read() as u16) << 8 | d.read() as u16)
            .collect()
    }

    fn wr(d: &mut Aw88298, reg: u8, v: &[u16]) {
        d.start(false);
        d.write(reg);
        for w in v {
            d.write((w >> 8) as u8);
            d.write(*w as u8);
        }
        d.stop();
    }

    #[test]
    fn id_and_storage() {
        let mut d = Aw88298::new(0x36);
        assert_eq!(rd(&mut d, 0x00, 1), [CHIP_ID]);
        // M5Unified CoreS3 speaker setup: 0x61 boost, 0x04..0x06 sysctrl, 0x0C volume
        wr(&mut d, 0x61, &[0x0673]);
        wr(&mut d, 0x04, &[0x4040, 0x0008, 0x14c8]);
        wr(&mut d, 0x0c, &[0x0064]);
        assert_eq!(rd(&mut d, 0x04, 3), [0x4040, 0x0008, 0x14c8]);
        assert_eq!(d.reg(0x61), 0x0673);
        assert_eq!(d.reg(0x0c), 0x0064);
        wr(&mut d, 0x00, &[0x55aa]);
        assert_eq!(d.reg(0x04), 0);
        assert_eq!(rd(&mut d, 0x00, 1), [CHIP_ID]);
    }
}
