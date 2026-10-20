//! Audio codec register shells so board init finds them: ES8311 DAC (I2C 0x18; chip ID 0xFD = 0x83, 0xFE = 0x11, 0xFF version) and
//! ES7210 4-ch ADC (I2C 0x40; 0x3D = 0x72, 0x3E = 0x10 ID, 0x3F version), ID values as read by the public Espressif drivers. 8-bit addresses,
//! auto-increment; everything else is plain storage. No audio path (I2S is not connected to these). Also used for the LTR-553ALS
//! light / proximity sensor shell (I2C 0x23; 0x86 PART_ID 0x92, 0x87 MANUFAC_ID 0x05, Lite-On datasheet): data registers
//! 0x88..0x8E read 0 (dark, nothing near). And for the GC0308 camera's SCCB port (I2C 0x21; 0x00 CHIP_ID 0x9B, the value
//! M5GFX checks to tell CoreS3 from CoreS3-SE); no image path. (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use std::any::Any;

pub struct Codec {
    pub addr: u8,
    pub kind: &'static str,
    regs: [u8; 256],
    /// Read-only ID registers
    ro: &'static [u8],
    ptr: u8,
    expect_reg: bool,
    pub writes: u64,
}

impl Codec {
    fn with(addr: u8, kind: &'static str, ids: &[(u8, u8)], ro: &'static [u8]) -> Self {
        let mut regs = [0u8; 256];
        for (r, v) in ids {
            regs[*r as usize] = *v;
        }
        Codec {
            addr,
            kind,
            regs,
            ro,
            ptr: 0,
            expect_reg: false,
            writes: 0,
        }
    }

    pub fn es8311(addr: u8) -> Self {
        // Reg 0x00 power-on default 0x1F per the ES8311 user guide (reset / CSM state)
        Self::with(
            addr,
            "es8311",
            &[(0x00, 0x1f), (0xfd, 0x83), (0xfe, 0x11), (0xff, 0x00)],
            &[0xfd, 0xfe, 0xff],
        )
    }

    pub fn ltr553(addr: u8) -> Self {
        // Power-on defaults: PS_LED 0x7F, PS_N_PULSES 1, PS_MEAS_RATE 0x02, ALS_MEAS_RATE 0x03
        Self::with(
            addr,
            "ltr553",
            &[
                (0x82, 0x7f),
                (0x83, 0x01),
                (0x84, 0x02),
                (0x85, 0x03),
                (0x86, 0x92),
                (0x87, 0x05),
            ],
            &[0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e],
        )
    }

    pub fn gc0308(addr: u8) -> Self {
        Self::with(addr, "gc0308", &[(0x00, 0x9b)], &[0x00])
    }

    pub fn es7210(addr: u8) -> Self {
        Self::with(
            addr,
            "es7210",
            &[(0x00, 0x32), (0x3d, 0x72), (0x3e, 0x10), (0x3f, 0x00)],
            &[0x3d, 0x3e, 0x3f],
        )
    }
}

impl I2cDevice for Codec {
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
        } else {
            if !self.ro.contains(&self.ptr) {
                self.regs[self.ptr as usize] = b;
            }
            self.writes += 1;
            self.ptr = self.ptr.wrapping_add(1);
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.regs[self.ptr as usize];
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

    fn rd(d: &mut Codec, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    #[test]
    fn ids_and_storage() {
        let mut a = Codec::es8311(0x18);
        assert_eq!(rd(&mut a, 0xfd, 2), [0x83, 0x11]);
        let mut b = Codec::es7210(0x40);
        assert_eq!(rd(&mut b, 0x3d, 2), [0x72, 0x10]);
        b.start(false);
        b.write(0x3d);
        b.write(0x00);
        b.write(0x55);
        assert_eq!(rd(&mut b, 0x3d, 3), [0x72, 0x10, 0x00]);
        a.start(false);
        a.write(0x01);
        a.write(0x3f);
        assert_eq!(rd(&mut a, 0x01, 1), [0x3f]);
    }

    #[test]
    fn ltr553_shell() {
        let mut d = Codec::ltr553(0x23);
        assert_eq!(rd(&mut d, 0x86, 2), [0x92, 0x05]);
        d.start(false);
        d.write(0x80);
        d.write(0x01); // ALS active
        d.write(0x03); // PS active
        assert_eq!(rd(&mut d, 0x80, 3), [0x01, 0x03, 0x7f]);
        assert_eq!(rd(&mut d, 0x88, 4), [0, 0, 0, 0]);
    }
}
