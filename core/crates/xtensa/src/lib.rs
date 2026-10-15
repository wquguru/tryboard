//! Xtensa LX7 解释器核，按 ESP32-S3 的配置（ESP-IDF `xtensa/esp32s3/include/xtensa/config/core-isa.h`）：
//! 64 个物理 AR + 窗口 ABI、16 位密度指令、零开销循环、MUL16/MUL32/DIV32、NSA/MIN/MAX/SEXT/CLAMPS、
//! 布尔寄存器、S32C1I、硬件非对齐访存、VECBASE 复位值 0x40000000。
//!
//! 本切片未实现：中断（INTERRUPT/INTENABLE 的裁决与 level 向量）、FPU、MAC16、PIE（EE.*）。
//! 这些指令目前一律按非法指令（EXCCAUSE 0）进异常，见各处 TODO。

pub mod sr;

/// 访存失败时由总线返回，核据此进入异常。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BusFault;

pub trait Bus {
    fn load(&mut self, addr: u32, size: u32) -> Result<u32, BusFault>;
    fn store(&mut self, addr: u32, size: u32, val: u32) -> Result<(), BusFault>;
    /// 取指：返回 addr 起的 3 个字节（小端拼成 24 位，16 位指令只用低 16 位）。
    fn fetch(&mut self, addr: u32) -> Result<u32, BusFault> {
        let b0 = self.load(addr, 1)?;
        let b1 = self.load(addr.wrapping_add(1), 1)?;
        if is_narrow(b0) {
            return Ok(b0 | (b1 << 8));
        }
        let b2 = self.load(addr.wrapping_add(2), 1)?;
        Ok(b0 | (b1 << 8) | (b2 << 16))
    }
}

/// op0 为 8..=13 的是 16 位密度指令
#[inline(always)]
pub fn is_narrow(b0: u32) -> bool {
    matches!(b0 & 0xf, 8..=13)
}

/// EXCCAUSE 编码（Xtensa ISA RM 表 4-64）
pub mod cause {
    pub const ILLEGAL: u32 = 0;
    pub const SYSCALL: u32 = 1;
    pub const INSN_FETCH_ERROR: u32 = 2;
    pub const LOAD_STORE_ERROR: u32 = 3;
    pub const ALLOCA: u32 = 5;
    pub const DIVIDE_BY_ZERO: u32 = 6;
}

/// 相对 VECBASE 的向量偏移（core-isa.h）
pub mod vec {
    pub const OVERFLOW4: u32 = 0x000;
    pub const UNDERFLOW4: u32 = 0x040;
    pub const OVERFLOW8: u32 = 0x080;
    pub const UNDERFLOW8: u32 = 0x0c0;
    pub const OVERFLOW12: u32 = 0x100;
    pub const UNDERFLOW12: u32 = 0x140;
    pub const KERNEL: u32 = 0x300;
    pub const USER: u32 = 0x340;
    pub const DOUBLE: u32 = 0x3c0;
}

// PS 字段
pub const PS_INTLEVEL: u32 = 0xf;
pub const PS_EXCM: u32 = 1 << 4;
pub const PS_UM: u32 = 1 << 5;
pub const PS_OWB_SHIFT: u32 = 8;
pub const PS_CALLINC_SHIFT: u32 = 16;
pub const PS_WOE: u32 = 1 << 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Normal,
    /// PC 落在 HLE 区间内且在 hle_addrs 中，由 SoC 接管
    Hle(u32),
    /// WAITI：等中断
    Waiti,
    /// BREAK / BREAK.N（调试器断点；测试里当作"程序结束"）
    Break(u32),
}

const B4CONST: [u32; 16] = [0xffff_ffff, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];
const B4CONSTU: [u32; 16] = [32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];

#[inline(always)]
fn sext(v: u32, bits: u32) -> u32 {
    let s = 32 - bits;
    (((v << s) as i32) >> s) as u32
}

/// 执行一条指令的结果：继续顺序执行、跳转、或进入异常
enum Flow {
    Next,
    Jump(u32),
    /// 已经自行处理了 PC（异常、RFE、窗口异常等）
    Done,
}

pub struct Cpu {
    /// 64 个物理地址寄存器
    pub ar: [u32; 64],
    pub pc: u32,
    /// 特殊寄存器（按 SR 编号存）；WINDOWBASE / WINDOWSTART / CCOUNT 另有字段
    pub sr: [u32; 256],
    pub windowbase: u32,
    pub windowstart: u32,
    pub threadptr: u32,
    pub cycles: u64,
    pub instret: u64,
    pub waiting: bool,
    pub hle_lo: u32,
    pub hle_hi: u32,
    pub hle_addrs: Vec<u32>,
    /// 处理器 ID（ESP32-S3：核 0 为 0xCDCD，核 1 为 0xABAB）
    pub prid: u32,
}

impl Default for Cpu {
    fn default() -> Self {
        Self::new()
    }
}

impl Cpu {
    pub fn new() -> Self {
        let mut c = Cpu {
            ar: [0; 64],
            pc: 0x4000_0400,
            sr: [0; 256],
            windowbase: 0,
            windowstart: 1,
            threadptr: 0,
            cycles: 0,
            instret: 0,
            waiting: false,
            hle_lo: 0,
            hle_hi: 0,
            hle_addrs: Vec::new(),
            prid: 0xcdcd,
        };
        // 复位：PS.INTLEVEL=15、EXCM=1；VECBASE 复位值
        c.sr[sr::PS as usize] = 0x1f;
        c.sr[sr::VECBASE as usize] = 0x4000_0000;
        c
    }

    // ------------------------------------------------------------ 寄存器
    #[inline(always)]
    pub fn a(&self, i: u32) -> u32 {
        self.ar[((self.windowbase * 4 + i) & 63) as usize]
    }
    #[inline(always)]
    pub fn set_a(&mut self, i: u32, v: u32) {
        self.ar[((self.windowbase * 4 + i) & 63) as usize] = v;
    }
    #[inline(always)]
    pub fn ps(&self) -> u32 {
        self.sr[sr::PS as usize]
    }
    #[inline(always)]
    fn set_ps(&mut self, v: u32) {
        self.sr[sr::PS as usize] = v;
    }
    fn vecbase(&self) -> u32 {
        self.sr[sr::VECBASE as usize]
    }
    fn sar(&self) -> u32 {
        self.sr[sr::SAR as usize] & 0x3f
    }
    fn br(&self, b: u32) -> bool {
        self.sr[sr::BR as usize] >> b & 1 != 0
    }
    fn set_br(&mut self, b: u32, v: bool) {
        let r = &mut self.sr[sr::BR as usize];
        *r = (*r & !(1 << b)) | ((v as u32) << b);
    }
    fn ws_bit(&self, q: u32) -> bool {
        self.windowstart >> (q & 15) & 1 != 0
    }

    pub fn read_sr(&self, n: u32) -> u32 {
        match n {
            sr::WINDOWBASE => self.windowbase,
            sr::WINDOWSTART => self.windowstart,
            sr::CCOUNT => self.cycles as u32,
            sr::PRID => self.prid,
            sr::SAR => self.sar(),
            sr::LITBASE => self.sr[n as usize] & 0xffff_f001,
            // TODO(中断切片)：INTERRUPT 读回挂起位
            _ => self.sr[n as usize & 0xff],
        }
    }

    pub fn write_sr(&mut self, n: u32, v: u32) {
        match n {
            sr::WINDOWBASE => self.windowbase = v & 15,
            sr::WINDOWSTART => self.windowstart = v & 0xffff,
            sr::CCOUNT => self.cycles = (self.cycles & !0xffff_ffff) | v as u64,
            sr::PRID => {}
            sr::SAR => self.sr[n as usize] = v & 0x3f,
            // TODO(中断切片)：INTSET / INTCLEAR 改挂起位，CCOMPAREn 写清定时器中断
            _ => self.sr[n as usize & 0xff] = v,
        }
    }

    pub fn read_ur(&self, n: u32) -> u32 {
        match n {
            sr::UR_THREADPTR => self.threadptr,
            // TODO(FPU 切片)：FCR / FSR
            _ => 0,
        }
    }

    pub fn write_ur(&mut self, n: u32, v: u32) {
        if n == sr::UR_THREADPTR {
            self.threadptr = v;
        }
    }

    // ------------------------------------------------------------ 异常
    /// 一般异常：EPC1/EXCCAUSE/EXCVADDR，按 PS.UM 选 User / Kernel 向量；已在异常中则走双重异常
    pub fn exception(&mut self, cause: u32, vaddr: u32) {
        let ps = self.ps();
        self.sr[sr::EXCCAUSE as usize] = cause;
        self.sr[sr::EXCVADDR as usize] = vaddr;
        if ps & PS_EXCM != 0 {
            self.sr[sr::DEPC as usize] = self.pc;
            self.pc = self.vecbase() + vec::DOUBLE;
        } else {
            self.sr[sr::EPC1 as usize] = self.pc;
            self.set_ps(ps | PS_EXCM);
            self.pc = self.vecbase() + if ps & PS_UM != 0 { vec::USER } else { vec::KERNEL };
        }
        self.waiting = false;
    }

    /// 窗口溢出检查：指令要用到当前窗口的第 max_quad 个四元组（0..=3）。
    /// 若中间某个四元组属于别的活帧（WINDOWSTART 位为 1），先把其中最老的帧溢出到栈上。
    /// 返回 true 表示已进入溢出处理程序（本条指令稍后重新执行）。
    fn window_check(&mut self, max_quad: u32) -> bool {
        let ps = self.ps();
        if max_quad == 0 || ps & PS_WOE == 0 || ps & PS_EXCM != 0 {
            return false;
        }
        let wb = self.windowbase;
        let Some(k) = (1..=max_quad).find(|k| self.ws_bit(wb + k)) else {
            return false;
        };
        // 被溢出的帧位于 wb+k，它的大小 = 到下一个（更新的）帧的距离
        let size = (1..=3).find(|j| self.ws_bit(wb + k + j)).unwrap_or(3);
        let off = match size {
            1 => vec::OVERFLOW4,
            2 => vec::OVERFLOW8,
            _ => vec::OVERFLOW12,
        };
        self.sr[sr::EPC1 as usize] = self.pc;
        self.set_ps((ps & !(0xf << PS_OWB_SHIFT)) | (wb << PS_OWB_SHIFT) | PS_EXCM);
        self.windowbase = (wb + k) & 15;
        self.pc = self.vecbase() + off;
        true
    }

    // ------------------------------------------------------------ 执行
    pub fn step<B: Bus>(&mut self, bus: &mut B) -> Exit {
        // TODO(中断切片)：在这里按 PS.INTLEVEL / INTENABLE 裁决挂起中断
        if self.waiting {
            self.cycles += 1;
            return Exit::Waiti;
        }
        let pc = self.pc;
        if pc >= self.hle_lo && pc < self.hle_hi && self.hle_addrs.binary_search(&pc).is_ok() {
            return Exit::Hle(pc);
        }
        let insn = match bus.fetch(pc) {
            Ok(v) => v,
            Err(_) => {
                self.exception(cause::INSN_FETCH_ERROR, pc);
                return Exit::Normal;
            }
        };
        self.cycles += 1;
        let narrow = is_narrow(insn);
        let len = if narrow { 2 } else { 3 };
        if self.window_check(max_quad(insn, narrow, self.ps())) {
            return Exit::Normal;
        }
        let flow = if narrow { self.exec_narrow(bus, insn) } else { self.exec(bus, insn) };
        match flow {
            Ok(Flow::Next) => {
                let mut next = pc.wrapping_add(len);
                // 零开销循环：顺序执行到 LEND 且 LCOUNT≠0 时回到 LBEG
                if next == self.sr[sr::LEND as usize] && self.sr[sr::LCOUNT as usize] != 0 && self.ps() & PS_EXCM == 0 {
                    self.sr[sr::LCOUNT as usize] -= 1;
                    next = self.sr[sr::LBEG as usize];
                }
                self.pc = next;
                self.instret += 1;
                Exit::Normal
            }
            Ok(Flow::Jump(t)) => {
                self.pc = t;
                self.instret += 1;
                Exit::Normal
            }
            Ok(Flow::Done) => Exit::Normal,
            Err(e) => e,
        }
    }

    fn illegal(&mut self) -> Result<Flow, Exit> {
        self.exception(cause::ILLEGAL, 0);
        Ok(Flow::Done)
    }

    fn load<B: Bus>(&mut self, bus: &mut B, addr: u32, size: u32) -> Option<u32> {
        match bus.load(addr, size) {
            Ok(v) => Some(v),
            Err(_) => {
                self.exception(cause::LOAD_STORE_ERROR, addr);
                None
            }
        }
    }

    fn store<B: Bus>(&mut self, bus: &mut B, addr: u32, size: u32, v: u32) -> bool {
        if bus.store(addr, size, v).is_err() {
            self.exception(cause::LOAD_STORE_ERROR, addr);
            return false;
        }
        true
    }

    fn exec_narrow<B: Bus>(&mut self, bus: &mut B, insn: u32) -> Result<Flow, Exit> {
        let op0 = insn & 0xf;
        let t = (insn >> 4) & 0xf;
        let s = (insn >> 8) & 0xf;
        let r = (insn >> 12) & 0xf;
        let pc = self.pc;
        match op0 {
            8 => {
                // L32I.N at, as, r*4
                let a = self.a(s).wrapping_add(r << 2);
                let Some(v) = self.load(bus, a, 4) else { return Ok(Flow::Done) };
                self.set_a(t, v);
            }
            9 => {
                let a = self.a(s).wrapping_add(r << 2);
                if !self.store(bus, a, 4, self.a(t)) {
                    return Ok(Flow::Done);
                }
            }
            10 => self.set_a(r, self.a(s).wrapping_add(self.a(t))),
            11 => {
                let imm = if t == 0 { 0xffff_ffff } else { t };
                self.set_a(r, self.a(s).wrapping_add(imm));
            }
            12 => {
                if t & 8 == 0 {
                    // MOVI.N as, imm7（-32..95）
                    let imm = ((t & 7) << 4) | r;
                    let v = if imm >= 96 { imm.wrapping_sub(128) } else { imm };
                    self.set_a(s, v);
                } else {
                    // BEQZ.N / BNEZ.N as, pc+4+imm6
                    let imm = ((t & 3) << 4) | r;
                    let z = self.a(s) == 0;
                    let taken = if t & 4 == 0 { z } else { !z };
                    if taken {
                        return Ok(Flow::Jump(pc.wrapping_add(4 + imm)));
                    }
                }
            }
            13 => match r {
                0 => self.set_a(t, self.a(s)),
                15 => match t {
                    0 => return Ok(Flow::Jump(self.a(0))),
                    1 => return self.retw(),
                    2 => return Err(Exit::Break(pc)),
                    3 => {}
                    _ => return self.illegal(),
                },
                _ => return self.illegal(),
            },
            _ => return self.illegal(),
        }
        Ok(Flow::Next)
    }

    fn retw(&mut self) -> Result<Flow, Exit> {
        let a0 = self.a(0);
        let n = a0 >> 30;
        if n == 0 {
            return self.illegal();
        }
        let wb = self.windowbase;
        let caller = (wb + 16 - n) & 15;
        let target = (self.pc & 0xc000_0000) | (a0 & 0x3fff_ffff);
        if !self.ws_bit(caller) {
            // 调用者的帧已被溢出到栈上：窗口下溢，处理程序恢复后重新执行 RETW
            let ps = self.ps();
            self.sr[sr::EPC1 as usize] = self.pc;
            self.set_ps((ps & !(0xf << PS_OWB_SHIFT)) | (wb << PS_OWB_SHIFT) | PS_EXCM);
            self.windowbase = caller;
            self.pc = self.vecbase()
                + match n {
                    1 => vec::UNDERFLOW4,
                    2 => vec::UNDERFLOW8,
                    _ => vec::UNDERFLOW12,
                };
            return Ok(Flow::Done);
        }
        self.windowstart &= !(1 << wb);
        self.windowbase = caller;
        Ok(Flow::Jump(target))
    }

    fn call_windowed(&mut self, n: u32, target: u32) -> Flow {
        let ret = (n << 30) | (self.pc.wrapping_add(3) & 0x3fff_ffff);
        self.set_a(n * 4, ret);
        let ps = self.ps();
        self.set_ps((ps & !(3 << PS_CALLINC_SHIFT)) | (n << PS_CALLINC_SHIFT));
        Flow::Jump(target)
    }

    fn exec<B: Bus>(&mut self, bus: &mut B, insn: u32) -> Result<Flow, Exit> {
        let op0 = insn & 0xf;
        let t = (insn >> 4) & 0xf;
        let s = (insn >> 8) & 0xf;
        let r = (insn >> 12) & 0xf;
        let op1 = (insn >> 16) & 0xf;
        let op2 = (insn >> 20) & 0xf;
        let imm8 = insn >> 16;
        let pc = self.pc;
        match op0 {
            0 => return self.exec_qrst(bus, insn, t, s, r, op1, op2),
            1 => {
                // L32R：地址 = ((PC+3) 对齐到 4) + 1 扩展的 imm16<<2；LITBASE 打开时以它为基址
                let imm = 0xfffc_0000 | ((insn >> 8) << 2);
                let lb = self.sr[sr::LITBASE as usize];
                let base = if lb & 1 != 0 { lb & 0xffff_f000 } else { pc.wrapping_add(3) & !3 };
                let a = base.wrapping_add(imm);
                let Some(v) = self.load(bus, a, 4) else { return Ok(Flow::Done) };
                self.set_a(t, v);
            }
            2 => {
                let base = self.a(s);
                match r {
                    0 | 1 | 2 | 9 | 11 => {
                        let (size, sh) = match r {
                            0 => (1, 0),
                            1 | 9 => (2, 1),
                            _ => (4, 2),
                        };
                        let a = base.wrapping_add(imm8 << sh);
                        let Some(mut v) = self.load(bus, a, size) else { return Ok(Flow::Done) };
                        if r == 9 {
                            v = sext(v, 16);
                        }
                        self.set_a(t, v);
                    }
                    4 | 5 | 6 | 15 => {
                        let (size, sh) = match r {
                            4 => (1, 0),
                            5 => (2, 1),
                            _ => (4, 2),
                        };
                        let a = base.wrapping_add(imm8 << sh);
                        if !self.store(bus, a, size, self.a(t)) {
                            return Ok(Flow::Done);
                        }
                    }
                    7 => {} // CACHE 类：模拟器没有 cache，空操作
                    10 => self.set_a(t, sext((s << 8) | imm8, 12)),
                    12 => self.set_a(t, base.wrapping_add(sext(imm8, 8))),
                    13 => self.set_a(t, base.wrapping_add(sext(imm8, 8) << 8)),
                    14 => {
                        // S32C1I：与 SCOMPARE1 相等才写入；at 总是得到旧值
                        let a = base.wrapping_add(imm8 << 2);
                        let Some(old) = self.load(bus, a, 4) else { return Ok(Flow::Done) };
                        if old == self.sr[sr::SCOMPARE1 as usize] && !self.store(bus, a, 4, self.a(t)) {
                            return Ok(Flow::Done);
                        }
                        self.set_a(t, old);
                    }
                    _ => return self.illegal(),
                }
            }
            5 => {
                let n = (insn >> 4) & 3;
                let off = sext(insn >> 6, 18) << 2;
                let target = (pc & !3).wrapping_add(off).wrapping_add(4);
                if n == 0 {
                    self.set_a(0, pc.wrapping_add(3));
                    return Ok(Flow::Jump(target));
                }
                return Ok(self.call_windowed(n, target));
            }
            6 => {
                let n = (insn >> 4) & 3;
                let m = (insn >> 6) & 3;
                match n {
                    0 => return Ok(Flow::Jump(pc.wrapping_add(4).wrapping_add(sext(insn >> 6, 18)))),
                    1 => {
                        let v = self.a(s) as i32;
                        let taken = match m {
                            0 => v == 0,
                            1 => v != 0,
                            2 => v < 0,
                            _ => v >= 0,
                        };
                        if taken {
                            return Ok(Flow::Jump(pc.wrapping_add(4).wrapping_add(sext(insn >> 12, 12))));
                        }
                    }
                    2 => {
                        let v = self.a(s);
                        let c = B4CONST[r as usize];
                        let taken = match m {
                            0 => v == c,
                            1 => v != c,
                            2 => (v as i32) < c as i32,
                            _ => v as i32 >= c as i32,
                        };
                        if taken {
                            return Ok(Flow::Jump(pc.wrapping_add(4).wrapping_add(sext(imm8, 8))));
                        }
                    }
                    _ => match m {
                        0 => {
                            // ENTRY as, imm12<<3
                            let callinc = (self.ps() >> PS_CALLINC_SHIFT) & 3;
                            let sp = self.a(s).wrapping_sub((insn >> 12) << 3);
                            self.set_a(callinc * 4 + s, sp);
                            self.windowbase = (self.windowbase + callinc) & 15;
                            self.windowstart |= 1 << self.windowbase;
                        }
                        1 => match r {
                            0 | 1 => {
                                let taken = self.br(s) == (r == 1);
                                if taken {
                                    return Ok(Flow::Jump(pc.wrapping_add(4).wrapping_add(sext(imm8, 8))));
                                }
                            }
                            8..=10 => {
                                let v = self.a(s);
                                let lend = pc.wrapping_add(4).wrapping_add(imm8);
                                let skip = match r {
                                    9 => v == 0,
                                    10 => (v as i32) <= 0,
                                    _ => false,
                                };
                                self.sr[sr::LBEG as usize] = pc.wrapping_add(3);
                                self.sr[sr::LEND as usize] = lend;
                                self.sr[sr::LCOUNT as usize] = v.wrapping_sub(1);
                                if skip {
                                    return Ok(Flow::Jump(lend));
                                }
                            }
                            _ => return self.illegal(),
                        },
                        _ => {
                            let v = self.a(s);
                            let c = B4CONSTU[r as usize];
                            let taken = if m == 2 { v < c } else { v >= c };
                            if taken {
                                return Ok(Flow::Jump(pc.wrapping_add(4).wrapping_add(sext(imm8, 8))));
                            }
                        }
                    },
                }
            }
            7 => {
                let (a, b) = (self.a(s), self.a(t));
                let bit = |n: u32| a >> (n & 31) & 1 != 0;
                let taken = match r {
                    0 => a & b == 0,
                    1 => a == b,
                    2 => (a as i32) < b as i32,
                    3 => a < b,
                    4 => !a & b == 0,
                    5 => !bit(b),
                    6 | 7 => !bit(((r & 1) << 4) | t),
                    8 => a & b != 0,
                    9 => a != b,
                    10 => a as i32 >= b as i32,
                    11 => a >= b,
                    12 => !a & b != 0,
                    13 => bit(b),
                    _ => bit(((r & 1) << 4) | t),
                };
                if taken {
                    return Ok(Flow::Jump(pc.wrapping_add(4).wrapping_add(sext(imm8, 8))));
                }
            }
            // TODO(FPU 切片)：op0=3 LSCI（LSI/SSI/LSIU/SSIU）；TODO(MAC16)：op0=4
            _ => return self.illegal(),
        }
        Ok(Flow::Next)
    }

    #[allow(clippy::too_many_arguments)]
    fn exec_qrst<B: Bus>(&mut self, bus: &mut B, insn: u32, t: u32, s: u32, r: u32, op1: u32, op2: u32) -> Result<Flow, Exit> {
        let pc = self.pc;
        let (as_, at) = (self.a(s), self.a(t));
        match op1 {
            0 => match op2 {
                0 => match r {
                    0 => {
                        let m = t >> 2;
                        let n = t & 3;
                        match (m, n) {
                            (2, 0) => return Ok(Flow::Jump(self.a(0))),
                            (2, 1) => return self.retw(),
                            (2, 2) => return Ok(Flow::Jump(as_)),
                            (3, 0) => {
                                self.set_a(0, pc.wrapping_add(3));
                                return Ok(Flow::Jump(as_));
                            }
                            (3, n) => return Ok(self.call_windowed(n, as_)),
                            _ => return self.illegal(),
                        }
                    }
                    1 => {
                        // MOVSP at, as：调用者的帧都已在栈上才允许挪栈，否则 Alloca 异常让处理程序先溢出
                        let wb = self.windowbase;
                        if (1..=3).any(|k| self.ws_bit(wb + 16 - k)) && self.ps() & PS_WOE != 0 {
                            self.exception(cause::ALLOCA, 0);
                            return Ok(Flow::Done);
                        }
                        self.set_a(t, as_);
                    }
                    2 => {} // ISYNC/RSYNC/ESYNC/DSYNC/EXCW/MEMW/EXTW/NOP
                    3 => {
                        if t == 0 {
                            let ps = self.ps();
                            match s {
                                0 | 1 => {
                                    self.set_ps(ps & !PS_EXCM);
                                    self.pc = self.sr[sr::EPC1 as usize];
                                }
                                2 => {
                                    self.set_ps(ps & !PS_EXCM);
                                    self.pc = self.sr[sr::DEPC as usize];
                                }
                                4 | 5 => {
                                    // RFWO / RFWU
                                    if s == 4 {
                                        self.windowstart &= !(1 << self.windowbase);
                                    } else {
                                        self.windowstart |= 1 << self.windowbase;
                                    }
                                    self.windowbase = (ps >> PS_OWB_SHIFT) & 15;
                                    self.set_ps(ps & !PS_EXCM);
                                    self.pc = self.sr[sr::EPC1 as usize];
                                }
                                _ => return self.illegal(),
                            }
                            self.instret += 1;
                            return Ok(Flow::Done);
                        } else if t == 1 && (2..=7).contains(&s) {
                            // RFI level
                            self.set_ps(self.sr[(sr::EPS2 + s - 2) as usize]);
                            self.pc = self.sr[(sr::EPC1 + s - 1) as usize];
                            self.instret += 1;
                            return Ok(Flow::Done);
                        }
                        return self.illegal();
                    }
                    4 => return Err(Exit::Break(pc)),
                    5 => {
                        if s == 0 {
                            self.exception(cause::SYSCALL, 0);
                            return Ok(Flow::Done);
                        }
                        // SIMCALL：当作空操作
                    }
                    6 => {
                        let ps = self.ps();
                        self.set_a(t, ps);
                        self.set_ps((ps & !PS_INTLEVEL) | s);
                    }
                    7 => {
                        let ps = self.ps();
                        self.set_ps((ps & !PS_INTLEVEL) | s);
                        self.pc = pc.wrapping_add(3);
                        self.waiting = true;
                        self.instret += 1;
                        return Err(Exit::Waiti);
                    }
                    8..=11 => {
                        // ANY4 / ALL4 / ANY8 / ALL8：bt ← bs..bs+n 的或 / 与
                        let n = if r < 10 { 4 } else { 8 };
                        let bits = (self.sr[sr::BR as usize] >> s) & ((1 << n) - 1);
                        let v = if r & 1 == 0 { bits != 0 } else { bits == (1 << n) - 1 };
                        self.set_br(t, v);
                    }
                    _ => return self.illegal(),
                },
                1 => self.set_a(r, as_ & at),
                2 => self.set_a(r, as_ | at),
                3 => self.set_a(r, as_ ^ at),
                4 => match r {
                    0 => self.sr[sr::SAR as usize] = as_ & 31,
                    1 => self.sr[sr::SAR as usize] = 32 - (as_ & 31),
                    2 => self.sr[sr::SAR as usize] = (as_ & 3) << 3,
                    3 => self.sr[sr::SAR as usize] = 32 - ((as_ & 3) << 3),
                    4 => self.sr[sr::SAR as usize] = s | ((t & 1) << 4),
                    6 | 7 => {} // RER / WER：外部寄存器，未建模
                    8 => self.windowbase = (self.windowbase + sext(t, 4)) & 15,
                    14 => {
                        let v = if as_ as i32 >= 0 { as_ } else { !as_ };
                        self.set_a(t, v.leading_zeros().saturating_sub(1).min(31));
                    }
                    15 => self.set_a(t, as_.leading_zeros()),
                    _ => return self.illegal(),
                },
                6 => match s {
                    0 => self.set_a(r, at.wrapping_neg()),
                    1 => self.set_a(r, (at as i32).unsigned_abs()),
                    _ => return self.illegal(),
                },
                8 => self.set_a(r, as_.wrapping_add(at)),
                9 => self.set_a(r, (as_ << 1).wrapping_add(at)),
                10 => self.set_a(r, (as_ << 2).wrapping_add(at)),
                11 => self.set_a(r, (as_ << 3).wrapping_add(at)),
                12 => self.set_a(r, as_.wrapping_sub(at)),
                13 => self.set_a(r, (as_ << 1).wrapping_sub(at)),
                14 => self.set_a(r, (as_ << 2).wrapping_sub(at)),
                15 => self.set_a(r, (as_ << 3).wrapping_sub(at)),
                _ => return self.illegal(),
            },
            1 => {
                let sar = self.sar();
                match op2 {
                    0 | 1 => {
                        // SLLI：编码里存的是 32-shift
                        let f = ((op2 & 1) << 4) | t;
                        self.set_a(r, (((as_ as u64) << 32) >> f) as u32);
                    }
                    2 | 3 => self.set_a(r, ((at as i32) >> (((op2 & 1) << 4) | s)) as u32),
                    4 => self.set_a(r, at >> s),
                    6 => {
                        let n = (r << 4) | s;
                        let old = self.read_sr(n);
                        self.write_sr(n, at);
                        self.set_a(t, old);
                    }
                    8 => self.set_a(r, ((((as_ as u64) << 32) | at as u64) >> sar) as u32),
                    9 => self.set_a(r, ((at as u64) >> sar) as u32),
                    10 => self.set_a(r, (((as_ as u64) << 32) >> sar) as u32),
                    11 => self.set_a(r, ((at as i32 as i64) >> sar.min(63)) as u32),
                    12 => self.set_a(r, (as_ & 0xffff) * (at & 0xffff)),
                    13 => self.set_a(r, ((as_ as i16 as i32) * (at as i16 as i32)) as u32),
                    _ => return self.illegal(),
                }
            }
            2 => match op2 {
                0..=4 => {
                    let (a, b) = (self.br(s), self.br(t));
                    let v = match op2 {
                        0 => a && b,
                        1 => a && !b,
                        2 => a || b,
                        3 => a || !b,
                        _ => a != b,
                    };
                    self.set_br(r, v);
                }
                8 => self.set_a(r, as_.wrapping_mul(at)),
                10 => self.set_a(r, ((as_ as u64 * at as u64) >> 32) as u32),
                11 => self.set_a(r, ((as_ as i32 as i64 * at as i32 as i64) >> 32) as u32),
                12..=15 => {
                    if at == 0 {
                        self.exception(cause::DIVIDE_BY_ZERO, 0);
                        return Ok(Flow::Done);
                    }
                    let (a, b) = (as_ as i32, at as i32);
                    let v = match op2 {
                        12 => as_ / at,
                        13 => a.wrapping_div(b) as u32,
                        14 => as_ % at,
                        _ => a.wrapping_rem(b) as u32,
                    };
                    self.set_a(r, v);
                }
                _ => return self.illegal(),
            },
            3 => match op2 {
                0 => {
                    let v = self.read_sr((r << 4) | s);
                    self.set_a(t, v);
                }
                1 => self.write_sr((r << 4) | s, at),
                2 => self.set_a(r, sext(as_, t + 8)),
                3 => {
                    let b = t + 7;
                    let (lo, hi) = (-(1i64 << b), (1i64 << b) - 1);
                    self.set_a(r, (as_ as i32 as i64).clamp(lo, hi) as u32);
                }
                4 => self.set_a(r, (as_ as i32).min(at as i32) as u32),
                5 => self.set_a(r, (as_ as i32).max(at as i32) as u32),
                6 => self.set_a(r, as_.min(at)),
                7 => self.set_a(r, as_.max(at)),
                8..=11 => {
                    let cond = match op2 {
                        8 => at == 0,
                        9 => at != 0,
                        10 => (at as i32) < 0,
                        _ => at as i32 >= 0,
                    };
                    if cond {
                        self.set_a(r, as_);
                    }
                }
                12 | 13 => {
                    if self.br(t) == (op2 == 13) {
                        self.set_a(r, as_);
                    }
                }
                14 => {
                    let v = self.read_ur((s << 4) | t);
                    self.set_a(r, v);
                }
                _ => self.write_ur((r << 4) | s, at),
            },
            4 | 5 => {
                // EXTUI ar, at, shift, mask
                let shift = ((op1 & 1) << 4) | s;
                let bits = op2 + 1;
                self.set_a(r, (at >> shift) & ((1u32 << bits) - 1));
            }
            9 => {
                // L32E / S32E：offset = r*4 - 64，窗口异常处理程序专用
                let a = as_.wrapping_add((r << 2).wrapping_sub(64));
                match op2 {
                    0 => {
                        let Some(v) = self.load(bus, a, 4) else { return Ok(Flow::Done) };
                        self.set_a(t, v);
                    }
                    4 => {
                        if !self.store(bus, a, 4, at) {
                            return Ok(Flow::Done);
                        }
                    }
                    _ => return self.illegal(),
                }
            }
            // TODO(FPU 切片)：op1=8 LSCX、10 FP0、11 FP1
            _ => {
                let _ = insn;
                return self.illegal();
            }
        }
        Ok(Flow::Next)
    }

    /// HLE 函数返回（CALL0 约定以外的窗口调用由 SoC 自行处理）
    pub fn hle_return_call0(&mut self, ret: u32) {
        self.set_a(2, ret);
        self.pc = self.a(0);
        self.instret += 1;
        self.cycles += 1;
    }
}

/// 指令会用到当前窗口里的最高四元组号（0..=3），给窗口溢出检查用。宁可多估：多估只会提早溢出，不影响正确性。
fn max_quad(insn: u32, narrow: bool, ps: u32) -> u32 {
    let t = (insn >> 4) & 0xf;
    let s = (insn >> 8) & 0xf;
    let r = (insn >> 12) & 0xf;
    let q = |regs: &[u32]| regs.iter().copied().max().unwrap_or(0) >> 2;
    if narrow {
        return match insn & 0xf {
            12 => q(&[s]),
            13 if r == 15 => 0,
            _ => q(&[r, s, t]),
        };
    }
    let op1 = (insn >> 16) & 0xf;
    let op2 = (insn >> 20) & 0xf;
    match insn & 0xf {
        0 => match (op1, op2) {
            (0, 0) => match r {
                0 if t >> 2 == 3 => q(&[s, (t & 3) * 4]),
                0 => q(&[s]),
                1 => q(&[s, t]),
                6 => q(&[t]),
                _ => 0,
            },
            (0, 4) => match r {
                0..=3 => q(&[s]),
                14 | 15 => q(&[s, t]),
                _ => 0,
            },
            (0, 6) => q(&[r, t]),
            (1, 6) | (3, 0) | (3, 1) | (3, 15) => q(&[t]),
            (2, 0..=4) => 0,
            (3, 14) => q(&[r]),
            (4 | 5, _) => q(&[r, t]),
            (9, _) => 0, // L32E/S32E 只在 EXCM=1 的窗口处理程序里用
            _ => q(&[r, s, t]),
        },
        1 => q(&[t]),
        2 if r == 10 => q(&[t]),
        5 => (insn >> 4) & 3,
        6 => {
            let n = (insn >> 4) & 3;
            let m = (insn >> 6) & 3;
            match (n, m) {
                (0, _) => 0,
                (3, 0) => {
                    let callinc = (ps >> PS_CALLINC_SHIFT) & 3;
                    (callinc * 4 + s) >> 2
                }
                (3, 1) if r < 2 => 0,
                _ => q(&[s]),
            }
        }
        _ => q(&[s, t]),
    }
}

#[cfg(test)]
mod tests;
