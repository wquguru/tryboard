//! High-level emulation (HLE): intercept ROM function entries, do the effect in Rust and return to the caller.
//! Currently regi2c access for the analog front end (rom_i2c_*) and the core 1 boot address; same as S3 but a different bus.
//! Xtensa windowed ABI: we intercept before the callee's ENTRY, so the window is still the caller's. The caller used
//! CALLn (n = PS.CALLINC): args live in caller a(4n+2..), return address in a(4n) (top 2 bits encode CALLINC),
//! and the result goes back to a(4n+2). No ENTRY / RETW runs, so the window is untouched and PC returns past the call.
//! lint: allow-long-comment

use crate::SocBus;
use tryboard_xtensa::{Cpu, PS_CALLINC_SHIFT};

#[derive(Clone, Copy, Debug)]
pub enum Hle {
    I2cReadReg,
    I2cReadRegMask,
    I2cWriteReg,
    I2cWriteRegMask,
    /// ets_set_appcpu_boot_addr(addr): record core 1's entry so the run loop can start it (on silicon core 1's ROM reset code waits for it)
    SetAppCpuBootAddr,
}

pub const TABLE: &[(&str, Hle)] = &[
    ("rom_i2c_readReg", Hle::I2cReadReg),
    ("rom_i2c_readReg_Mask", Hle::I2cReadRegMask),
    ("rom_i2c_writeReg", Hle::I2cWriteReg),
    ("rom_i2c_writeReg_Mask", Hle::I2cWriteRegMask),
    ("ets_set_appcpu_boot_addr", Hle::SetAppCpuBootAddr),
];

fn mask(msb: u32, lsb: u32) -> u8 {
    (((1u32 << (msb - lsb + 1)) - 1) << lsb) as u8
}

pub fn call(kind: Hle, cpu: &mut Cpu, bus: &mut SocBus) {
    let callinc = (cpu.ps() >> PS_CALLINC_SHIFT) & 3;
    let base = callinc * 4;
    let a = |i: u32| cpu.a(base + 2 + i);
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
        Hle::SetAppCpuBootAddr => {
            if a(0) != 0 {
                bus.appcpu_boot = Some(a(0));
            }
            0
        }
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
    let ra = cpu.a(base);
    if callinc == 0 {
        // CALL0 convention: the result goes in a2
        cpu.hle_return_call0(ret);
        return;
    }
    cpu.set_a(base + 2, ret);
    cpu.pc = (ra & 0x3fff_ffff) | (cpu.pc & 0xc000_0000);
    cpu.instret += 1;
    cpu.cycles += 1;
}
