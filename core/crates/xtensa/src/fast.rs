//! Predecoded instruction cache (P2-07), direct-mapped by PC. An entry hits only when both PC and the fetched raw bytes
//! match, and decoding depends on nothing else, so rewritten code (IRAM load, MMU change, new flash) just redecodes with
//! no invalidation logic. Common ops execute in one match here; the rest (SRs, FPU, MAC16, divide, atomics, LOOP...)
//! fall back to `exec` / `exec_narrow` with identical semantics. lint: allow-long-comment

use crate::{is_narrow, max_quad, sext, sr, Bus, Cpu, Exit, Flow, B4CONST, B4CONSTU};

/// Entry count (power of two). Direct-mapped on low PC bits, so 64KB of contiguous code never conflicts
pub(crate) const DCACHE_SIZE: usize = 1 << 15;
const DCACHE_MASK: u32 = DCACHE_SIZE as u32 - 1;

/// Special `Dec::mq` value: the quads ENTRY touches depend on the runtime PS.CALLINC, so compute them at execution
const MQ_DYNAMIC: u8 = 0xff;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub(crate) enum Op {
    /// No fast path: run the raw bytes through exec / exec_narrow
    Generic,
    // 16-bit
    L32iN,
    S32iN,
    AddN,
    AddiN,
    MoviN,
    BeqzN,
    BnezN,
    MovN,
    RetN,
    RetwN,
    Nop,
    // 24-bit
    L32r,
    L8ui,
    L16ui,
    L16si,
    L32i,
    S8i,
    S16i,
    S32i,
    Movi,
    Addi,
    Call0,
    CallN,
    J,
    Beqz,
    Bnez,
    Bltz,
    Bgez,
    Beqi,
    Bnei,
    Blti,
    Bgei,
    Bltui,
    Bgeui,
    Entry,
    Bnone,
    Beq,
    Blt,
    Bltu,
    Ball,
    Bbc,
    Bbci,
    Bany,
    Bne,
    Bge,
    Bgeu,
    Bnall,
    Bbs,
    Bbsi,
    Ret,
    Retw,
    Jx,
    Callx0,
    CallxN,
    And,
    Or,
    Xor,
    Add,
    Addx2,
    Addx4,
    Addx8,
    Sub,
    Subx2,
    Subx4,
    Subx8,
    Ssr,
    Ssl,
    Ssa8l,
    Ssa8b,
    Ssai,
    Nsa,
    Nsau,
    Neg,
    Abs,
    Slli,
    Srai,
    Srli,
    Src,
    Srl,
    Sll,
    Sra,
    Mul16u,
    Mul16s,
    Saltu,
    Salt,
    Mull,
    Muluh,
    Mulsh,
    Sext,
    Clamps,
    Min,
    Max,
    Minu,
    Maxu,
    Moveqz,
    Movnez,
    Movltz,
    Movgez,
    Extui,
}

/// One decoded instruction
#[derive(Clone, Copy, Debug)]
pub(crate) struct Dec {
    pub pc: u32,
    /// Raw fetched bytes for the hit check; u32::MAX = empty entry (fetches are at most 24 bits, so never equal it)
    pub raw: u32,
    /// Immediate: offset, constant, branch target etc., meaning depends on op
    pub imm: u32,
    pub op: Op,
    pub r: u8,
    pub s: u8,
    pub t: u8,
    /// 2 or 3
    pub len: u8,
    /// Highest quad number (0..=3) the window-overflow check needs, or MQ_DYNAMIC
    pub mq: u8,
}

impl Dec {
    pub(crate) const EMPTY: Dec = Dec {
        pc: 0,
        raw: u32::MAX,
        imm: 0,
        op: Op::Generic,
        r: 0,
        s: 0,
        t: 0,
        len: 3,
        mq: 0,
    };
}

pub(crate) fn new_cache() -> Box<[Dec; DCACHE_SIZE]> {
    // Fixed-size array so PC-masked indexing lets the compiler drop bounds checks
    vec![Dec::EMPTY; DCACHE_SIZE]
        .into_boxed_slice()
        .try_into()
        .expect("fixed length")
}

/// Decodes using only pc and the raw bytes
pub(crate) fn decode(pc: u32, insn: u32) -> Dec {
    let narrow = is_narrow(insn);
    let t = (insn >> 4) & 0xf;
    let s = (insn >> 8) & 0xf;
    let r = (insn >> 12) & 0xf;
    let mut d = Dec {
        pc,
        raw: insn,
        imm: 0,
        op: Op::Generic,
        r: r as u8,
        s: s as u8,
        t: t as u8,
        len: if narrow { 2 } else { 3 },
        mq: 0,
    };
    let op0 = insn & 0xf;
    let dynamic = op0 == 6 && (insn >> 4) & 3 == 3 && (insn >> 6) & 3 == 0;
    d.mq = if dynamic {
        MQ_DYNAMIC
    } else {
        max_quad(insn, narrow, 0) as u8
    };
    let (op, imm) = if narrow {
        decode_narrow(pc, op0, t, r)
    } else {
        decode_wide(pc, insn, op0, t, s, r)
    };
    d.op = op;
    d.imm = imm;
    if op == Op::Bbci || op == Op::Bbsi {
        // bit number = low bit of r << 4 | t
        d.t = (((r & 1) << 4) | t) as u8;
    }
    d
}

fn decode_narrow(pc: u32, op0: u32, t: u32, r: u32) -> (Op, u32) {
    match op0 {
        // L32I.N a1, as, 0 takes the generic path: exec_narrow reports the stack switch (task switch) there; keeps the fast path one compare shorter
        8 if t == 1 && r == 0 => (Op::Generic, 0),
        8 => (Op::L32iN, r << 2),
        9 => (Op::S32iN, r << 2),
        10 => (Op::AddN, 0),
        11 => (Op::AddiN, if t == 0 { 0xffff_ffff } else { t }),
        12 => {
            if t & 8 == 0 {
                let imm = ((t & 7) << 4) | r;
                let v = if imm >= 96 {
                    imm.wrapping_sub(128)
                } else {
                    imm
                };
                (Op::MoviN, v)
            } else {
                let imm = ((t & 3) << 4) | r;
                let target = pc.wrapping_add(4 + imm);
                (if t & 4 == 0 { Op::BeqzN } else { Op::BnezN }, target)
            }
        }
        13 => match (r, t) {
            (0, _) => (Op::MovN, 0),
            (15, 0) => (Op::RetN, 0),
            (15, 1) => (Op::RetwN, 0),
            (15, 3) => (Op::Nop, 0),
            _ => (Op::Generic, 0),
        },
        _ => (Op::Generic, 0),
    }
}

fn decode_wide(pc: u32, insn: u32, op0: u32, t: u32, s: u32, r: u32) -> (Op, u32) {
    let op1 = (insn >> 16) & 0xf;
    let op2 = (insn >> 20) & 0xf;
    let imm8 = insn >> 16;
    let br8 = pc.wrapping_add(4).wrapping_add(sext(imm8, 8));
    match op0 {
        0 => match op1 {
            0 => match op2 {
                0 => match r {
                    0 => match (t >> 2, t & 3) {
                        (2, 0) => (Op::Ret, 0),
                        (2, 1) => (Op::Retw, 0),
                        (2, 2) => (Op::Jx, 0),
                        (3, 0) => (Op::Callx0, 0),
                        (3, n) => (Op::CallxN, n),
                        _ => (Op::Generic, 0),
                    },
                    2 => (Op::Nop, 0),
                    _ => (Op::Generic, 0),
                },
                1 => (Op::And, 0),
                2 => (Op::Or, 0),
                3 => (Op::Xor, 0),
                4 => match r {
                    0 => (Op::Ssr, 0),
                    1 => (Op::Ssl, 0),
                    2 => (Op::Ssa8l, 0),
                    3 => (Op::Ssa8b, 0),
                    4 => (Op::Ssai, s | ((t & 1) << 4)),
                    14 => (Op::Nsa, 0),
                    15 => (Op::Nsau, 0),
                    _ => (Op::Generic, 0),
                },
                6 => match s {
                    0 => (Op::Neg, 0),
                    1 => (Op::Abs, 0),
                    _ => (Op::Generic, 0),
                },
                8 => (Op::Add, 0),
                9 => (Op::Addx2, 0),
                10 => (Op::Addx4, 0),
                11 => (Op::Addx8, 0),
                12 => (Op::Sub, 0),
                13 => (Op::Subx2, 0),
                14 => (Op::Subx4, 0),
                15 => (Op::Subx8, 0),
                _ => (Op::Generic, 0),
            },
            1 => match op2 {
                0 | 1 => (Op::Slli, ((op2 & 1) << 4) | t),
                2 | 3 => (Op::Srai, ((op2 & 1) << 4) | s),
                4 => (Op::Srli, s),
                8 => (Op::Src, 0),
                9 => (Op::Srl, 0),
                10 => (Op::Sll, 0),
                11 => (Op::Sra, 0),
                12 => (Op::Mul16u, 0),
                13 => (Op::Mul16s, 0),
                _ => (Op::Generic, 0),
            },
            2 => match op2 {
                6 => (Op::Saltu, 0),
                7 => (Op::Salt, 0),
                8 => (Op::Mull, 0),
                10 => (Op::Muluh, 0),
                11 => (Op::Mulsh, 0),
                _ => (Op::Generic, 0),
            },
            3 => match op2 {
                2 => (Op::Sext, t + 8),
                3 => (Op::Clamps, t + 7),
                4 => (Op::Min, 0),
                5 => (Op::Max, 0),
                6 => (Op::Minu, 0),
                7 => (Op::Maxu, 0),
                8 => (Op::Moveqz, 0),
                9 => (Op::Movnez, 0),
                10 => (Op::Movltz, 0),
                11 => (Op::Movgez, 0),
                _ => (Op::Generic, 0),
            },
            // EXTUI: the s field holds the shift amount, imm holds the mask
            4 | 5 => (Op::Extui, (((op1 & 1) << 4) | s) << 8 | (op2 + 1)),
            _ => (Op::Generic, 0),
        },
        1 => {
            // Address with LITBASE off; with it on, execution falls back to exec
            let imm = 0xfffc_0000 | ((insn >> 8) << 2);
            (Op::L32r, (pc.wrapping_add(3) & !3).wrapping_add(imm))
        }
        2 => match r {
            0 => (Op::L8ui, imm8),
            1 => (Op::L16ui, imm8 << 1),
            9 => (Op::L16si, imm8 << 1),
            2 if t == 1 && imm8 == 0 => (Op::Generic, 0),
            2 => (Op::L32i, imm8 << 2),
            4 => (Op::S8i, imm8),
            5 => (Op::S16i, imm8 << 1),
            6 => (Op::S32i, imm8 << 2),
            10 => (Op::Movi, sext((s << 8) | imm8, 12)),
            12 => (Op::Addi, sext(imm8, 8)),
            13 => (Op::Addi, sext(imm8, 8) << 8),
            _ => (Op::Generic, 0),
        },
        5 => {
            let n = (insn >> 4) & 3;
            let off = sext(insn >> 6, 18) << 2;
            let target = (pc & !3).wrapping_add(off).wrapping_add(4);
            (if n == 0 { Op::Call0 } else { Op::CallN }, target)
        }
        6 => {
            let n = (insn >> 4) & 3;
            let m = (insn >> 6) & 3;
            match n {
                0 => (Op::J, pc.wrapping_add(4).wrapping_add(sext(insn >> 6, 18))),
                1 => {
                    let target = pc.wrapping_add(4).wrapping_add(sext(insn >> 12, 12));
                    let op = match m {
                        0 => Op::Beqz,
                        1 => Op::Bnez,
                        2 => Op::Bltz,
                        _ => Op::Bgez,
                    };
                    (op, target)
                }
                2 => {
                    let op = match m {
                        0 => Op::Beqi,
                        1 => Op::Bnei,
                        2 => Op::Blti,
                        _ => Op::Bgei,
                    };
                    (op, br8)
                }
                _ => match m {
                    0 => (Op::Entry, (insn >> 12) << 3),
                    1 => (Op::Generic, 0),
                    2 => (Op::Bltui, br8),
                    _ => (Op::Bgeui, br8),
                },
            }
        }
        7 => {
            let op = match r {
                0 => Op::Bnone,
                1 => Op::Beq,
                2 => Op::Blt,
                3 => Op::Bltu,
                4 => Op::Ball,
                5 => Op::Bbc,
                6 | 7 => Op::Bbci,
                8 => Op::Bany,
                9 => Op::Bne,
                10 => Op::Bge,
                11 => Op::Bgeu,
                12 => Op::Bnall,
                13 => Op::Bbs,
                _ => Op::Bbsi,
            };
            (op, br8)
        }
        _ => (Op::Generic, 0),
    }
}

impl Cpu {
    /// Fetch + predecode cache lookup
    #[inline(always)]
    pub(crate) fn fetch_dec<B: Bus>(
        &mut self,
        bus: &mut B,
        pc: u32,
    ) -> Result<Dec, crate::BusFault> {
        let raw = bus.fetch(pc)?;
        let e = &mut self.dcache[(pc & DCACHE_MASK) as usize];
        if e.pc == pc && e.raw == raw {
            return Ok(*e);
        }
        *e = decode(pc, raw);
        Ok(*e)
    }

    /// Window-overflow fast path: if the 3 quads above the current window belong to no other live frame, no register
    /// can overflow. The highest quad comes from the predecode (ENTRY depends on PS.CALLINC, computed live)
    #[inline(always)]
    pub(crate) fn window_check_dec(&mut self, d: &Dec) -> bool {
        let ps = self.ps();
        if ps & crate::PS_WOE == 0 || ps & crate::PS_EXCM != 0 {
            return false;
        }
        let wb = self.windowbase;
        let ws = self.windowstart | (self.windowstart << 16);
        if (ws >> (wb + 1)) & 7 == 0 {
            return false;
        }
        let max_quad = if d.mq == MQ_DYNAMIC {
            max_quad(d.raw, d.len == 2, ps)
        } else {
            d.mq as u32
        };
        self.window_spill(max_quad, ps)
    }

    /// Executes one predecoded instruction. Branch targets are precomputed; results match exec / exec_narrow
    #[inline(always)]
    pub(crate) fn exec_dec<B: Bus>(&mut self, bus: &mut B, d: &Dec) -> Result<Flow, Exit> {
        let (r, s, t) = (d.r as u32, d.s as u32, d.t as u32);
        let imm = d.imm;
        // Read the window base into a local once: every arm uses it (ENTRY is done with registers before changing it)
        let wb = self.windowbase * 4;
        macro_rules! a {
            ($i:expr) => {
                self.ar[((wb + $i) & 63) as usize]
            };
        }
        macro_rules! set_a {
            ($i:expr, $v:expr) => {{
                let v = $v;
                self.ar[((wb + $i) & 63) as usize] = v;
            }};
        }
        macro_rules! br {
            ($c:expr) => {
                if $c {
                    return Ok(Flow::Jump(imm));
                }
            };
        }
        macro_rules! load {
            ($dst:expr, $addr:expr, $size:expr) => {{
                let Some(v) = self.load(bus, $addr, $size) else {
                    return Ok(Flow::Done);
                };
                v
            }};
        }
        macro_rules! store {
            ($addr:expr, $size:expr, $v:expr) => {
                if !self.store(bus, $addr, $size, $v) {
                    return Ok(Flow::Done);
                }
            };
        }
        match d.op {
            Op::Generic => {
                return if d.len == 2 {
                    self.exec_narrow(bus, d.raw)
                } else {
                    self.exec(bus, d.raw)
                }
            }
            Op::L32iN => {
                let v = load!(t, a!(s).wrapping_add(imm), 4);
                set_a!(t, v);
            }
            Op::S32iN => store!(a!(s).wrapping_add(imm), 4, a!(t)),
            Op::AddN => set_a!(r, a!(s).wrapping_add(a!(t))),
            Op::AddiN => set_a!(r, a!(s).wrapping_add(imm)),
            Op::MoviN => set_a!(s, imm),
            Op::BeqzN => br!(a!(s) == 0),
            Op::BnezN => br!(a!(s) != 0),
            Op::MovN => set_a!(t, a!(s)),
            Op::RetN | Op::Ret => return Ok(Flow::Jump(a!(0))),
            Op::RetwN | Op::Retw => return self.retw(),
            Op::Nop => {}
            Op::L32r => {
                if self.sr[sr::LITBASE as usize] & 1 != 0 {
                    return self.exec(bus, d.raw);
                }
                let v = load!(t, imm, 4);
                set_a!(t, v);
            }
            Op::L8ui => {
                let v = load!(t, a!(s).wrapping_add(imm), 1);
                set_a!(t, v);
            }
            Op::L16ui => {
                let v = load!(t, a!(s).wrapping_add(imm), 2);
                set_a!(t, v);
            }
            Op::L16si => {
                let v = load!(t, a!(s).wrapping_add(imm), 2);
                set_a!(t, sext(v, 16));
            }
            Op::L32i => {
                let v = load!(t, a!(s).wrapping_add(imm), 4);
                set_a!(t, v);
            }
            Op::S8i => store!(a!(s).wrapping_add(imm), 1, a!(t)),
            Op::S16i => store!(a!(s).wrapping_add(imm), 2, a!(t)),
            Op::S32i => store!(a!(s).wrapping_add(imm), 4, a!(t)),
            Op::Movi => set_a!(t, imm),
            Op::Addi => set_a!(t, a!(s).wrapping_add(imm)),
            Op::Call0 => {
                set_a!(0, d.pc.wrapping_add(3));
                return Ok(Flow::Jump(imm));
            }
            Op::CallN => return Ok(self.call_windowed((d.raw >> 4) & 3, imm)),
            Op::J => return Ok(Flow::Jump(imm)),
            Op::Beqz => br!(a!(s) == 0),
            Op::Bnez => br!(a!(s) != 0),
            Op::Bltz => br!((a!(s) as i32) < 0),
            Op::Bgez => br!((a!(s) as i32) >= 0),
            Op::Beqi => br!(a!(s) == B4CONST[r as usize]),
            Op::Bnei => br!(a!(s) != B4CONST[r as usize]),
            Op::Blti => br!((a!(s) as i32) < B4CONST[r as usize] as i32),
            Op::Bgei => br!((a!(s) as i32) >= B4CONST[r as usize] as i32),
            Op::Bltui => br!(a!(s) < B4CONSTU[r as usize]),
            Op::Bgeui => br!(a!(s) >= B4CONSTU[r as usize]),
            Op::Entry => {
                let callinc = (self.ps() >> crate::PS_CALLINC_SHIFT) & 3;
                let sp = a!(s).wrapping_sub(imm);
                set_a!(callinc * 4 + s, sp);
                self.windowbase = (self.windowbase + callinc) & 15;
                self.windowstart |= 1 << self.windowbase;
            }
            Op::Bnone => br!(a!(s) & a!(t) == 0),
            Op::Beq => br!(a!(s) == a!(t)),
            Op::Blt => br!((a!(s) as i32) < a!(t) as i32),
            Op::Bltu => br!(a!(s) < a!(t)),
            Op::Ball => br!(!a!(s) & a!(t) == 0),
            Op::Bbc => br!(a!(s) >> (a!(t) & 31) & 1 == 0),
            Op::Bbci => br!(a!(s) >> t & 1 == 0),
            Op::Bany => br!(a!(s) & a!(t) != 0),
            Op::Bne => br!(a!(s) != a!(t)),
            Op::Bge => br!(a!(s) as i32 >= a!(t) as i32),
            Op::Bgeu => br!(a!(s) >= a!(t)),
            Op::Bnall => br!(!a!(s) & a!(t) != 0),
            Op::Bbs => br!(a!(s) >> (a!(t) & 31) & 1 != 0),
            Op::Bbsi => br!(a!(s) >> t & 1 != 0),
            Op::Jx => return Ok(Flow::Jump(a!(s))),
            Op::Callx0 => {
                let target = a!(s);
                set_a!(0, d.pc.wrapping_add(3));
                return Ok(Flow::Jump(target));
            }
            Op::CallxN => {
                let target = a!(s);
                return Ok(self.call_windowed(imm, target));
            }
            Op::And => set_a!(r, a!(s) & a!(t)),
            Op::Or => set_a!(r, a!(s) | a!(t)),
            Op::Xor => set_a!(r, a!(s) ^ a!(t)),
            Op::Add => set_a!(r, a!(s).wrapping_add(a!(t))),
            Op::Addx2 => set_a!(r, (a!(s) << 1).wrapping_add(a!(t))),
            Op::Addx4 => set_a!(r, (a!(s) << 2).wrapping_add(a!(t))),
            Op::Addx8 => set_a!(r, (a!(s) << 3).wrapping_add(a!(t))),
            Op::Sub => set_a!(r, a!(s).wrapping_sub(a!(t))),
            Op::Subx2 => set_a!(r, (a!(s) << 1).wrapping_sub(a!(t))),
            Op::Subx4 => set_a!(r, (a!(s) << 2).wrapping_sub(a!(t))),
            Op::Subx8 => set_a!(r, (a!(s) << 3).wrapping_sub(a!(t))),
            Op::Ssr => self.sr[sr::SAR as usize] = a!(s) & 31,
            Op::Ssl => self.sr[sr::SAR as usize] = 32 - (a!(s) & 31),
            Op::Ssa8l => self.sr[sr::SAR as usize] = (a!(s) & 3) << 3,
            Op::Ssa8b => self.sr[sr::SAR as usize] = 32 - ((a!(s) & 3) << 3),
            Op::Ssai => self.sr[sr::SAR as usize] = imm,
            Op::Nsa => {
                let a = a!(s);
                let v = if a as i32 >= 0 { a } else { !a };
                set_a!(t, v.leading_zeros().saturating_sub(1).min(31));
            }
            Op::Nsau => set_a!(t, a!(s).leading_zeros()),
            Op::Neg => set_a!(r, a!(t).wrapping_neg()),
            Op::Abs => set_a!(r, (a!(t) as i32).unsigned_abs()),
            Op::Slli => set_a!(r, (((a!(s) as u64) << 32) >> imm) as u32),
            Op::Srai => set_a!(r, ((a!(t) as i32) >> imm) as u32),
            Op::Srli => set_a!(r, a!(t) >> imm),
            Op::Src => {
                let sar = self.sr[sr::SAR as usize] & 0x3f;
                let v = (((a!(s) as u64) << 32) | a!(t) as u64) >> sar;
                set_a!(r, v as u32);
            }
            Op::Srl => {
                let sar = self.sr[sr::SAR as usize] & 0x3f;
                set_a!(r, ((a!(t) as u64) >> sar) as u32);
            }
            Op::Sll => {
                let sar = self.sr[sr::SAR as usize] & 0x3f;
                set_a!(r, (((a!(s) as u64) << 32) >> sar) as u32);
            }
            Op::Sra => {
                let sar = self.sr[sr::SAR as usize] & 0x3f;
                set_a!(r, ((a!(t) as i32 as i64) >> sar.min(63)) as u32);
            }
            Op::Mul16u => set_a!(r, (a!(s) & 0xffff) * (a!(t) & 0xffff)),
            Op::Mul16s => {
                let v = (a!(s) as i16 as i32) * (a!(t) as i16 as i32);
                set_a!(r, v as u32);
            }
            Op::Saltu => set_a!(r, (a!(s) < a!(t)) as u32),
            Op::Salt => set_a!(r, ((a!(s) as i32) < a!(t) as i32) as u32),
            Op::Mull => set_a!(r, a!(s).wrapping_mul(a!(t))),
            Op::Muluh => {
                let v = (a!(s) as u64 * a!(t) as u64) >> 32;
                set_a!(r, v as u32);
            }
            Op::Mulsh => {
                let v = (a!(s) as i32 as i64 * a!(t) as i32 as i64) >> 32;
                set_a!(r, v as u32);
            }
            Op::Sext => set_a!(r, sext(a!(s), imm)),
            Op::Clamps => {
                let (lo, hi) = (-(1i64 << imm), (1i64 << imm) - 1);
                set_a!(r, (a!(s) as i32 as i64).clamp(lo, hi) as u32);
            }
            Op::Min => set_a!(r, (a!(s) as i32).min(a!(t) as i32) as u32),
            Op::Max => set_a!(r, (a!(s) as i32).max(a!(t) as i32) as u32),
            Op::Minu => set_a!(r, a!(s).min(a!(t))),
            Op::Maxu => set_a!(r, a!(s).max(a!(t))),
            Op::Moveqz => {
                if a!(t) == 0 {
                    set_a!(r, a!(s));
                }
            }
            Op::Movnez => {
                if a!(t) != 0 {
                    set_a!(r, a!(s));
                }
            }
            Op::Movltz => {
                if (a!(t) as i32) < 0 {
                    set_a!(r, a!(s));
                }
            }
            Op::Movgez => {
                if a!(t) as i32 >= 0 {
                    set_a!(r, a!(s));
                }
            }
            Op::Extui => {
                let shift = imm >> 8;
                let bits = imm & 0xff;
                set_a!(r, (a!(t) >> shift) & ((1u32 << bits) - 1));
            }
        }
        Ok(Flow::Next)
    }
}
