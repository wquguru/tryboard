//! INA3221 3-channel current / voltage monitor (I2C 0x40..0x43), per the TI INA3221 datasheet: 16-bit big-endian registers, the
//! pointer does not auto-increment. 0x00 config (reset 0x7127, bit15 reset, bits 14:12 channel enables), 0x01 / 0x03 / 0x05 shunt and
//! 0x02 / 0x04 / 0x06 bus voltage of channels 1..3 (value << 3: shunt 40 µV / LSB, bus 8 mV / LSB), 0x0F mask / enable (bit0 CVRF
//! conversion ready, set on every read here), 0xFE manufacturer 0x5449, 0xFF die ID 0x3220, the rest storage. Disabled channels keep
//! their last value at 0. Channel values come from `set_channel` (the board / electrical model). (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use std::any::Any;

pub const MANUFACTURER_ID: u16 = 0x5449;
pub const DIE_ID: u16 = 0x3220;
const CONFIG_RESET: u16 = 0x7127;

pub struct Ina3221 {
    pub addr: u8,
    regs: [u16; 0x10],
    ptr: u8,
    expect_reg: bool,
    /// Bytes into the current 16-bit word (0 = MSB next)
    half: u8,
    word: u16,
    /// Per channel: bus mV and shunt µV
    pub bus_mv: [f64; 3],
    pub shunt_uv: [f64; 3],
}

impl Ina3221 {
    pub fn new(addr: u8) -> Self {
        let mut d = Ina3221 {
            addr,
            regs: [0; 0x10],
            ptr: 0,
            expect_reg: false,
            half: 0,
            word: 0,
            bus_mv: [0.0; 3],
            shunt_uv: [0.0; 3],
        };
        d.regs[0] = CONFIG_RESET;
        d
    }

    /// Set what channel `ch` (0..2) measures
    pub fn set_channel(&mut self, ch: usize, bus_mv: f64, shunt_uv: f64) {
        self.bus_mv[ch % 3] = bus_mv;
        self.shunt_uv[ch % 3] = shunt_uv;
    }

    fn reg(&self, p: u8) -> u16 {
        match p {
            0x01..=0x06 => {
                let ch = ((p - 1) / 2) as usize;
                if self.regs[0] & (0x4000 >> ch) == 0 {
                    return 0;
                }
                let raw = if p % 2 == 1 {
                    self.shunt_uv[ch] / 40.0
                } else {
                    self.bus_mv[ch] / 8.0
                };
                ((raw.round().clamp(-4096.0, 4095.0) as i16) << 3) as u16
            }
            0x0f => self.regs[0x0f] | 1,
            0xfe => MANUFACTURER_ID,
            0xff => DIE_ID,
            0x10..=0xfd => 0,
            _ => self.regs[p as usize],
        }
    }

    fn set_reg(&mut self, p: u8, v: u16) {
        match p {
            0x00 if v & 0x8000 != 0 => self.regs[0] = CONFIG_RESET,
            0x00 | 0x07..=0x0e => self.regs[p as usize] = v,
            0x0f => self.regs[0x0f] = v & 0x7c00 | (self.regs[0x0f] & 0x03ff),
            _ => {}
        }
    }
}

impl I2cDevice for Ina3221 {
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
            self.ptr = b;
            self.expect_reg = false;
        } else if self.half == 0 {
            self.word = (b as u16) << 8;
            self.half = 1;
        } else {
            self.set_reg(self.ptr, self.word | b as u16);
            self.half = 0;
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.reg(self.ptr);
        self.half ^= 1;
        if self.half == 1 {
            (v >> 8) as u8
        } else {
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

    fn rd16(d: &mut Ina3221, reg: u8) -> u16 {
        d.start(false);
        d.write(reg);
        d.start(true);
        (d.read() as u16) << 8 | d.read() as u16
    }

    fn wr16(d: &mut Ina3221, reg: u8, v: u16) {
        d.start(false);
        d.write(reg);
        d.write((v >> 8) as u8);
        d.write(v as u8);
        d.stop();
    }

    #[test]
    fn ids_config_and_channels() {
        let mut d = Ina3221::new(0x40);
        assert_eq!(rd16(&mut d, 0xfe), MANUFACTURER_ID);
        assert_eq!(rd16(&mut d, 0xff), DIE_ID);
        assert_eq!(rd16(&mut d, 0x00), CONFIG_RESET);
        wr16(&mut d, 0x07, 0x1234);
        assert_eq!(rd16(&mut d, 0x07), 0x1234);
        // 5 V bus, 100 mA through 0.1 Ω = 10 mV shunt; M5 reads bus raw as mV, shunt raw * 5 as µV
        d.set_channel(0, 5000.0, 10_000.0);
        d.set_channel(1, 3300.0, -400.0);
        assert_eq!(rd16(&mut d, 0x02) as i16, 5000);
        assert_eq!(rd16(&mut d, 0x01) as i16 as i32 * 5, 10_000);
        assert_eq!(rd16(&mut d, 0x04) as i16, 3304);
        assert_eq!(rd16(&mut d, 0x03) as i16 as i32 * 5, -400);
        // Channel 1 disabled reads 0; reset bit restores the config
        wr16(&mut d, 0x00, 0x3127);
        assert_eq!(rd16(&mut d, 0x02), 0);
        wr16(&mut d, 0x00, 0x8000);
        assert_eq!(rd16(&mut d, 0x00), CONFIG_RESET);
        assert_eq!(rd16(&mut d, 0x0f) & 1, 1);
    }
}
