//! 高层模拟（HLE）：在 ROM 函数入口拦截，用 Rust 实现效果后直接返回调用者。
//! 目前只有模拟前端的 regi2c 访问（rom_i2c_*）。
//!
//! Xtensa 窗口 ABI：拦截点在被调函数的 ENTRY 之前，此时窗口仍是调用者的。调用者用 CALLn
//! （n = PS.CALLINC）调用：参数在调用者的 a(4n+2..)，返回地址在 a(4n)（高 2 位是 CALLINC 编码），
//! 返回值写回 a(4n+2)。不执行 ENTRY / RETW，窗口不变，PC 直接回到调用点之后。

use crate::SocBus;
use tryboard_xtensa::{Cpu, PS_CALLINC_SHIFT};

#[derive(Clone, Copy, Debug)]
pub enum Hle {
    I2cReadReg,
    I2cReadRegMask,
    I2cWriteReg,
    I2cWriteRegMask,
    /// ets_set_appcpu_boot_addr(addr)：记下核 1 入口，由运行循环启动核 1（真机上是 ROM 里核 1 的复位代码在等这个地址）
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
            bus.analog.regs.insert((block, reg), (old & !m) | (((data << lsb) as u8) & m));
            0
        }
    };
    let ra = cpu.a(base);
    if callinc == 0 {
        // CALL0 约定：返回值在 a2
        cpu.hle_return_call0(ret);
        return;
    }
    cpu.set_a(base + 2, ret);
    cpu.pc = (ra & 0x3fff_ffff) | (cpu.pc & 0xc000_0000);
    cpu.instret += 1;
    cpu.cycles += 1;
}
