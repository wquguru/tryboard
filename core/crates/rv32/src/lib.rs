//! RV32IMC + Zicsr + Zifencei 解释器核，只实现机器模式（ESP32-C3 固件只跑 M 模式）。
//!
//! SoC 通过 [`Bus`] 提供存储访问，通过 `irq_line` 告诉核当前该响应的中断线
//! （ESP32-C3 的中断优先级 / 阈值在 SoC 侧的中断控制器里裁决）。

mod compressed;
pub mod csr;
pub mod elf;

pub use compressed::expand;

/// 访存失败时由总线返回，核据此进入异常。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BusFault;

pub trait Bus {
    fn load(&mut self, addr: u32, size: u32) -> Result<u32, BusFault>;
    fn store(&mut self, addr: u32, size: u32, val: u32) -> Result<(), BusFault>;
    /// 取指：返回 addr 处的 32 位（可能跨越到下一个半字，压缩指令只用低 16 位）。
    fn fetch(&mut self, addr: u32) -> Result<u32, BusFault> {
        let lo = self.load(addr, 2)?;
        if lo & 3 != 3 {
            return Ok(lo);
        }
        let hi = self.load(addr.wrapping_add(2), 2)?;
        Ok(lo | (hi << 16))
    }
}

pub mod cause {
    pub const INSN_MISALIGNED: u32 = 0;
    pub const INSN_FAULT: u32 = 1;
    pub const ILLEGAL: u32 = 2;
    pub const BREAKPOINT: u32 = 3;
    pub const LOAD_MISALIGNED: u32 = 4;
    pub const LOAD_FAULT: u32 = 5;
    pub const STORE_MISALIGNED: u32 = 6;
    pub const STORE_FAULT: u32 = 7;
    pub const ECALL_U: u32 = 8;
    pub const ECALL_M: u32 = 11;
}

/// 一步执行之后需要外部关心的事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    /// 正常执行了一条指令（或进入了异常 / 中断）。
    Normal,
    /// PC 落在 HLE 区间内，由 SoC 接管（模拟 ROM 函数）。
    Hle(u32),
    /// 执行了 WFI，CPU 进入等待，直到有中断。
    Wfi,
    /// 发生异常且 mtvec 尚未设置（固件跑飞），SoC 应停机报告。
    DoubleFault { cause: u32, pc: u32, tval: u32 },
}

pub struct Cpu {
    pub x: [u32; 32],
    pub pc: u32,
    pub csr: csr::Csrs,
    /// SoC 写入：当前要求响应的中断线号（1..=31），0 表示无。
    pub irq_line: u32,
    /// [hle_lo, hle_hi) 内且在 hle_addrs（升序）里的 PC 交给 SoC。
    pub hle_lo: u32,
    pub hle_hi: u32,
    pub hle_addrs: Vec<u32>,
    pub cycles: u64,
    pub instret: u64,
    pub waiting: bool,
    /// LR/SC 预约（C3 没有 A 扩展，这里保留给以后的芯片）。
    reservation: Option<u32>,
}

impl Default for Cpu {
    fn default() -> Self {
        Self::new()
    }
}

#[inline(always)]
fn sext(v: u32, bits: u32) -> u32 {
    let s = 32 - bits;
    (((v << s) as i32) >> s) as u32
}

impl Cpu {
    pub fn new() -> Self {
        Cpu {
            x: [0; 32],
            pc: 0,
            csr: csr::Csrs::default(),
            irq_line: 0,
            hle_lo: 0,
            hle_hi: 0,
            hle_addrs: Vec::new(),
            cycles: 0,
            instret: 0,
            waiting: false,
            reservation: None,
        }
    }

    #[inline(always)]
    fn set(&mut self, rd: usize, v: u32) {
        if rd != 0 {
            self.x[rd] = v;
        }
    }

    /// 进入异常或中断。返回 DoubleFault 表示 mtvec 未初始化。
    pub fn trap(&mut self, cause: u32, tval: u32, is_irq: bool) -> Exit {
        let epc = self.pc;
        if self.csr.mtvec == 0 && !is_irq {
            return Exit::DoubleFault { cause, pc: epc, tval };
        }
        self.csr.mepc = epc;
        self.csr.mcause = if is_irq { 0x8000_0000 | cause } else { cause };
        self.csr.mtval = tval;
        // MPIE <- MIE, MIE <- 0, MPP <- M
        let mie = (self.csr.mstatus >> 3) & 1;
        self.csr.mstatus = (self.csr.mstatus & !(1 << 7 | 1 << 3)) | (mie << 7) | (3 << 11);
        let base = self.csr.mtvec & !3;
        self.pc = if is_irq && self.csr.mtvec & 3 == 1 {
            base.wrapping_add(4 * cause)
        } else {
            base
        };
        self.waiting = false;
        Exit::Normal
    }

    #[inline]
    pub fn irq_enabled(&self) -> bool {
        self.csr.mstatus & (1 << 3) != 0
    }

    /// 执行一条指令。
    pub fn step<B: Bus>(&mut self, bus: &mut B) -> Exit {
        if self.irq_line != 0 && self.irq_enabled() {
            return self.trap(self.irq_line, 0, true);
        }
        if self.waiting {
            // WFI 在没有中断（即使全局关中断）时保持等待；有挂起的线就醒来继续。
            if self.irq_line != 0 {
                self.waiting = false;
            } else {
                self.cycles += 1;
                return Exit::Wfi;
            }
        }
        let pc = self.pc;
        if pc >= self.hle_lo && pc < self.hle_hi && self.hle_addrs.binary_search(&pc).is_ok() {
            return Exit::Hle(pc);
        }
        if pc & 1 != 0 {
            return self.trap(cause::INSN_MISALIGNED, pc, false);
        }
        let raw = match bus.fetch(pc) {
            Ok(v) => v,
            Err(_) => return self.trap(cause::INSN_FAULT, pc, false),
        };
        self.cycles += 1;
        let (insn, len) = if raw & 3 != 3 {
            match expand(raw as u16) {
                Some(i) => (i, 2),
                None => return self.trap(cause::ILLEGAL, raw & 0xffff, false),
            }
        } else {
            (raw, 4)
        };
        self.exec(bus, insn, len)
    }

    #[inline(always)]
    fn exec<B: Bus>(&mut self, bus: &mut B, insn: u32, len: u32) -> Exit {
        let opcode = insn & 0x7f;
        let rd = ((insn >> 7) & 31) as usize;
        let f3 = (insn >> 12) & 7;
        let rs1 = ((insn >> 15) & 31) as usize;
        let rs2 = ((insn >> 20) & 31) as usize;
        let f7 = insn >> 25;
        let a = self.x[rs1];
        let b = self.x[rs2];
        let pc = self.pc;
        let mut next = pc.wrapping_add(len);
        let imm_i = sext(insn >> 20, 12);
        macro_rules! illegal {
            () => {
                return self.trap(cause::ILLEGAL, insn, false)
            };
        }
        match opcode {
            0x37 => self.set(rd, insn & 0xffff_f000),
            0x17 => self.set(rd, pc.wrapping_add(insn & 0xffff_f000)),
            0x6f => {
                let imm = sext(
                    ((insn >> 31) << 20)
                        | (((insn >> 21) & 0x3ff) << 1)
                        | (((insn >> 20) & 1) << 11)
                        | (((insn >> 12) & 0xff) << 12),
                    21,
                );
                self.set(rd, next);
                next = pc.wrapping_add(imm);
            }
            0x67 => {
                if f3 != 0 {
                    illegal!();
                }
                let t = a.wrapping_add(imm_i) & !1;
                self.set(rd, next);
                next = t;
            }
            0x63 => {
                let imm = sext(
                    ((insn >> 31) << 12)
                        | (((insn >> 25) & 0x3f) << 5)
                        | (((insn >> 8) & 0xf) << 1)
                        | (((insn >> 7) & 1) << 11),
                    13,
                );
                let taken = match f3 {
                    0 => a == b,
                    1 => a != b,
                    4 => (a as i32) < (b as i32),
                    5 => (a as i32) >= (b as i32),
                    6 => a < b,
                    7 => a >= b,
                    _ => illegal!(),
                };
                if taken {
                    next = pc.wrapping_add(imm);
                }
            }
            0x03 => {
                let addr = a.wrapping_add(imm_i);
                let size = match f3 & 3 {
                    0 => 1,
                    1 => 2,
                    2 => 4,
                    _ => illegal!(),
                };
                if f3 == 3 || f3 > 5 {
                    illegal!();
                }
                if addr & (size - 1) != 0 {
                    return self.trap(cause::LOAD_MISALIGNED, addr, false);
                }
                let v = match bus.load(addr, size) {
                    Ok(v) => v,
                    Err(_) => return self.trap(cause::LOAD_FAULT, addr, false),
                };
                let v = match f3 {
                    0 => sext(v, 8),
                    1 => sext(v, 16),
                    _ => v,
                };
                self.set(rd, v);
            }
            0x23 => {
                let imm = sext(((insn >> 25) << 5) | ((insn >> 7) & 31), 12);
                let addr = a.wrapping_add(imm);
                let size = match f3 {
                    0 => 1,
                    1 => 2,
                    2 => 4,
                    _ => illegal!(),
                };
                if addr & (size - 1) != 0 {
                    return self.trap(cause::STORE_MISALIGNED, addr, false);
                }
                if bus.store(addr, size, b).is_err() {
                    return self.trap(cause::STORE_FAULT, addr, false);
                }
                if let Some(r) = self.reservation {
                    if r == addr & !3 {
                        self.reservation = None;
                    }
                }
            }
            0x13 => {
                let shamt = (insn >> 20) & 31;
                let v = match f3 {
                    0 => a.wrapping_add(imm_i),
                    2 => ((a as i32) < (imm_i as i32)) as u32,
                    3 => (a < imm_i) as u32,
                    4 => a ^ imm_i,
                    6 => a | imm_i,
                    7 => a & imm_i,
                    1 => {
                        if f7 != 0 {
                            illegal!();
                        }
                        a << shamt
                    }
                    5 => match f7 {
                        0 => a >> shamt,
                        0x20 => ((a as i32) >> shamt) as u32,
                        _ => illegal!(),
                    },
                    _ => unreachable!(),
                };
                self.set(rd, v);
            }
            0x33 => {
                let v = match (f7, f3) {
                    (0, 0) => a.wrapping_add(b),
                    (0x20, 0) => a.wrapping_sub(b),
                    (0, 1) => a << (b & 31),
                    (0, 2) => ((a as i32) < (b as i32)) as u32,
                    (0, 3) => (a < b) as u32,
                    (0, 4) => a ^ b,
                    (0, 5) => a >> (b & 31),
                    (0x20, 5) => ((a as i32) >> (b & 31)) as u32,
                    (0, 6) => a | b,
                    (0, 7) => a & b,
                    (1, 0) => a.wrapping_mul(b),
                    (1, 1) => (((a as i32 as i64) * (b as i32 as i64)) >> 32) as u32,
                    (1, 2) => (((a as i32 as i64) * (b as u64 as i64)) >> 32) as u32,
                    (1, 3) => (((a as u64) * (b as u64)) >> 32) as u32,
                    (1, 4) => {
                        if b == 0 {
                            u32::MAX
                        } else if a == 0x8000_0000 && b == u32::MAX {
                            a
                        } else {
                            ((a as i32) / (b as i32)) as u32
                        }
                    }
                    (1, 5) => {
                        if b == 0 {
                            u32::MAX
                        } else {
                            a / b
                        }
                    }
                    (1, 6) => {
                        if b == 0 {
                            a
                        } else if a == 0x8000_0000 && b == u32::MAX {
                            0
                        } else {
                            ((a as i32) % (b as i32)) as u32
                        }
                    }
                    (1, 7) => {
                        if b == 0 {
                            a
                        } else {
                            a % b
                        }
                    }
                    _ => illegal!(),
                };
                self.set(rd, v);
            }
            0x0f => {
                // FENCE / FENCE.I：单核解释器下无需动作（SoC 若有取指缓存需自行失效）。
            }
            0x2f => {
                // A 扩展（ESP32-C6 等以后的芯片会用到；C3 固件不会发出）。
                if f3 != 2 {
                    illegal!();
                }
                let f5 = insn >> 27;
                if a & 3 != 0 {
                    return self.trap(cause::STORE_MISALIGNED, a, false);
                }
                match f5 {
                    0b00010 => match bus.load(a, 4) {
                        Ok(v) => {
                            self.reservation = Some(a);
                            self.set(rd, v);
                        }
                        Err(_) => return self.trap(cause::LOAD_FAULT, a, false),
                    },
                    0b00011 => {
                        if self.reservation == Some(a) {
                            if bus.store(a, 4, b).is_err() {
                                return self.trap(cause::STORE_FAULT, a, false);
                            }
                            self.set(rd, 0);
                        } else {
                            self.set(rd, 1);
                        }
                        self.reservation = None;
                    }
                    _ => {
                        let old = match bus.load(a, 4) {
                            Ok(v) => v,
                            Err(_) => return self.trap(cause::STORE_FAULT, a, false),
                        };
                        let new = match f5 {
                            0b00001 => b,
                            0b00000 => old.wrapping_add(b),
                            0b00100 => old ^ b,
                            0b01100 => old & b,
                            0b01000 => old | b,
                            0b10000 => (old as i32).min(b as i32) as u32,
                            0b10100 => (old as i32).max(b as i32) as u32,
                            0b11000 => old.min(b),
                            0b11100 => old.max(b),
                            _ => illegal!(),
                        };
                        if bus.store(a, 4, new).is_err() {
                            return self.trap(cause::STORE_FAULT, a, false);
                        }
                        self.set(rd, old);
                    }
                }
            }
            0x73 => {
                if f3 == 0 {
                    match insn {
                        0x0000_0073 => return self.trap(cause::ECALL_M, 0, false),
                        0x0010_0073 => return self.trap(cause::BREAKPOINT, pc, false),
                        0x3020_0073 => {
                            // MRET：MIE <- MPIE, MPIE <- 1
                            let mpie = (self.csr.mstatus >> 7) & 1;
                            self.csr.mstatus = (self.csr.mstatus & !(1 << 3)) | (mpie << 3) | (1 << 7);
                            self.pc = self.csr.mepc;
                            self.instret += 1;
                            return Exit::Normal;
                        }
                        0x1050_0073 => {
                            self.pc = next;
                            self.instret += 1;
                            if self.irq_line == 0 {
                                self.waiting = true;
                                return Exit::Wfi;
                            }
                            return Exit::Normal;
                        }
                        _ => {
                            if insn >> 25 == 0x09 {
                                // SFENCE.VMA：无 MMU，忽略
                            } else {
                                illegal!();
                            }
                        }
                    }
                } else {
                    let addr = insn >> 20;
                    let src = if f3 & 4 != 0 { rs1 as u32 } else { a };
                    let write = !(matches!(f3 & 3, 2 | 3) && rs1 == 0);
                    let old = match self.csr_read(addr) {
                        Some(v) => v,
                        None => illegal!(),
                    };
                    if write {
                        let new = match f3 & 3 {
                            1 => src,
                            2 => old | src,
                            3 => old & !src,
                            _ => illegal!(),
                        };
                        self.csr_write(addr, new);
                    }
                    self.set(rd, old);
                }
            }
            _ => illegal!(),
        }
        self.pc = next;
        self.instret += 1;
        Exit::Normal
    }

    fn csr_read(&self, addr: u32) -> Option<u32> {
        use csr::*;
        Some(match addr {
            MCYCLE | CYCLE | MPCCR => self.cycles as u32,
            MCYCLEH | CYCLEH => (self.cycles >> 32) as u32,
            MINSTRET | INSTRET => self.instret as u32,
            MINSTRETH | INSTRETH => (self.instret >> 32) as u32,
            TIME => self.cycles as u32,
            TIMEH => (self.cycles >> 32) as u32,
            _ => return self.csr.read(addr),
        })
    }

    fn csr_write(&mut self, addr: u32, v: u32) {
        use csr::*;
        match addr {
            MCYCLE | MPCCR => self.cycles = (self.cycles & !0xffff_ffff) | v as u64,
            MCYCLEH => self.cycles = (self.cycles & 0xffff_ffff) | ((v as u64) << 32),
            MINSTRET => self.instret = (self.instret & !0xffff_ffff) | v as u64,
            MINSTRETH => self.instret = (self.instret & 0xffff_ffff) | ((v as u64) << 32),
            _ => self.csr.write(addr, v),
        }
    }

    /// HLE 函数返回：a0 = ret，跳回 ra。
    pub fn hle_return(&mut self, ret: u32) {
        self.x[10] = ret;
        self.pc = self.x[1];
        self.instret += 1;
        self.cycles += 1;
    }
}

#[cfg(test)]
mod tests;
