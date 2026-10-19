//! High-level emulation (HLE): intercept ROM function entries, apply the effect in Rust and return.
//! Only for ROM functions whose underlying hardware we don't intend to model; currently the analog front end's regi2c access.

use crate::SocBus;
use std::collections::HashMap;
use tryboard_rv32::Cpu;

#[derive(Clone, Copy, Debug)]
pub enum Hle {
    I2cReadReg,
    I2cReadRegMask,
    I2cWriteReg,
    I2cWriteRegMask,
    /// esp_rom_delay_us: observed only (timing detection), the ROM code then runs as usual
    DelayUs,
}

/// ROM symbols to intercept
pub const TABLE: &[(&str, Hle)] = &[
    ("rom_i2c_readReg", Hle::I2cReadReg),
    ("rom_i2c_readReg_Mask", Hle::I2cReadRegMask),
    ("rom_i2c_writeReg", Hle::I2cWriteReg),
    ("rom_i2c_writeReg_Mask", Hle::I2cWriteRegMask),
    ("ets_delay_us", Hle::DelayUs),
];

/// Internal registers of the analog front end (BBPLL, bias, SAR ADC, ...), accessed via regi2c.
#[derive(Default)]
pub struct Analog {
    pub regs: HashMap<(u8, u8), u8>,
}

impl Analog {
    fn read(&self, block: u8, reg: u8) -> u8 {
        let v = self.regs.get(&(block, reg)).copied().unwrap_or(0);
        match (block, reg) {
            // I2C_ULP reg3: O_DONE_FLAG (bit 0), BG_O_DONE_FLAG (bit 3) -- bias / ocode calibration completes instantly
            (0x61, 3) => v | 0x09,
            _ => v,
        }
    }
}

fn mask(msb: u32, lsb: u32) -> u8 {
    (((1u32 << (msb - lsb + 1)) - 1) << lsb) as u8
}

pub fn call(kind: Hle, cpu: &mut Cpu, bus: &mut SocBus) {
    if let Hle::DelayUs = kind {
        bus.timing.delay(cpu.cycles);
        cpu.hle_pass = cpu.pc;
        return;
    }
    let a = |i: usize| cpu.x[10 + i];
    let (block, reg) = (a(0) as u8, a(2) as u8);
    let ret = match kind {
        Hle::I2cReadReg => bus.analog.read(block, reg) as u32,
        Hle::I2cReadRegMask => {
            let (msb, lsb) = (a(3) & 7, a(4) & 7);
            ((bus.analog.read(block, reg) & mask(msb, lsb)) >> lsb) as u32
        }
        Hle::I2cWriteReg => {
            bus.analog.regs.insert((block, reg), a(3) as u8);
            0
        }
        Hle::DelayUs => unreachable!(),
        Hle::I2cWriteRegMask => {
            let (msb, lsb, data) = (a(3) & 7, a(4) & 7, a(5));
            let m = mask(msb, lsb);
            let old = bus.analog.read(block, reg);
            bus.analog
                .regs
                .insert((block, reg), (old & !m) | (((data << lsb) as u8) & m));
            0
        }
    };
    cpu.hle_return(ret);
}
