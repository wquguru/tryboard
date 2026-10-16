//! Xtensa LX7 解释器核，按 ESP32-S3 的配置（ESP-IDF `xtensa/esp32s3/include/xtensa/config/core-isa.h`）：
//! 64 个物理 AR + 窗口 ABI、16 位密度指令、零开销循环、MUL16/MUL32/DIV32、NSA/MIN/MAX/SEXT/CLAMPS、
//! 布尔寄存器、S32C1I、硬件非对齐访存、VECBASE 复位值 0x40000000。
//!
//! 中断：32 条线，类型 / 级别按 core-isa.h 的 XCHAL_INTn_TYPE / LEVEL；外部线由 SoC 经 `set_irq_lines` 驱动，
//! 定时器中断来自 CCOMPARE0..2（线 6 / 15 / 16）。FPU（单精度，CP0，受 CPENABLE 门控）与 MAC16 见 fpu.rs / mac16.rs。
//! 未实现：PIE（EE.*）指令，按非法指令（EXCCAUSE 0）进异常。

mod fpu;
mod mac16;
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
    /// RER：读外部寄存器（ESP32-S3 上没有挂外部寄存器的外设时读 0）
    fn rer(&mut self, _addr: u32) -> u32 {
        0
    }
    /// WER：写外部寄存器
    fn wer(&mut self, _addr: u32, _val: u32) {}
    /// `Cpu::run_batch` 每条指令之后问一次：SoC 是否要先处理事情（外设事件到点、中断线要重算）。
    /// `cycles` 是这个核当前的周期数。返回 true 时批量执行停下，交回 SoC
    #[inline(always)]
    fn attention(&mut self, _cycles: u64) -> bool {
        false
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
    pub const LEVEL1_INTERRUPT: u32 = 4;
    /// Coprocessor n Disabled = 32 + n
    pub const COPROCESSOR0_DISABLED: u32 = 32;
}

/// 中断配置（ESP32-S3 core-isa.h）
pub mod irq {
    /// XCHAL_INTn_LEVEL
    pub const LEVEL: [u8; 32] = [
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 7, 3, 5, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 3, 4, 3, 4, 5,
    ];
    /// 外部电平型
    pub const EXT_LEVEL: u32 = !(EXT_EDGE | NMI | SOFTWARE | TIMER | PROFILING);
    /// 外部边沿型（10、22、28、30）
    pub const EXT_EDGE: u32 = 1 << 10 | 1 << 22 | 1 << 28 | 1 << 30;
    /// NMI（14，边沿）
    pub const NMI: u32 = 1 << 14;
    /// 软件中断（7、29），INTSET 置位、INTCLEAR 清除
    pub const SOFTWARE: u32 = 1 << 7 | 1 << 29;
    /// 定时器（CCOMPARE0/1/2 → 6/15/16），写对应 CCOMPARE 清除
    pub const TIMER: u32 = 1 << 6 | 1 << 15 | 1 << 16;
    pub const TIMER_LINE: [u32; 3] = [6, 15, 16];
    /// 性能计数溢出（11），模拟器不产生
    pub const PROFILING: u32 = 1 << 11;
    pub const EXCM_LEVEL: u32 = 3;
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
    /// level 2..=7 的中断向量（7 为 NMI）
    pub const LEVEL: [u32; 8] = [0, 0, 0x180, 0x1c0, 0x200, 0x240, 0x280, 0x2c0];
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
    /// SIMCALL（模拟器调用，a2 为功能号）。PC 已越过该指令；不关心的 SoC 当作空操作即可
    Simcall,
}

const B4CONST: [u32; 16] = [
    0xffff_ffff,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    10,
    12,
    16,
    32,
    64,
    128,
    256,
];
const B4CONSTU: [u32; 16] = [
    32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256,
];

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
    /// SoC 驱动的外部中断线电平（位 = CPU 中断号）
    irq_ext: u32,
    /// 锁存的挂起位：边沿、NMI、软件、定时器
    irq_latched: u32,
    /// 上次检查 CCOMPARE 时的周期数
    last_cc: u64,
    /// 最早可能触发 CCOMPARE 的周期（绝对值）；cycles 没到它时 tick_timers 什么都不用做。写 CCOMPARE / CCOUNT 时清 0 强制重算
    cc_next: u64,
    /// CCOUNT = cycles + ccount_off（取低 32 位）。固件写 CCOUNT（如 IDF 换 CPU 频率时按比例改写）
    /// 只改这个偏移，不动 `cycles`：`cycles` 是整机的模拟时间，跳变会让外设时间和另一个核错乱
    ccount_off: u32,
    /// 区域保护（ESP32-S3 无 MMU）：8 个 512MB 区域的指令 / 数据属性，WITLB / WDTLB 写、RITLB1 / RDTLB1 读
    pub itlb_attr: [u32; 8],
    pub dtlb_attr: [u32; 8],
    /// FPU 寄存器 f0..f15（位模式）与 FCR / FSR
    pub fr: [u32; 16],
    pub fcr: u32,
    pub fsr: u32,
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
            irq_ext: 0,
            irq_latched: 0,
            last_cc: 0,
            cc_next: 0,
            ccount_off: 0,
            // 复位属性 2（可读写执行、旁路），与 QEMU 对照
            itlb_attr: [2; 8],
            dtlb_attr: [2; 8],
            fr: [0; 16],
            fcr: 0,
            fsr: 0,
        };
        // 复位：PS.INTLEVEL=15、EXCM=1；VECBASE 复位值
        c.sr[sr::PS as usize] = 0x1f;
        c.sr[sr::VECBASE as usize] = 0x4000_0000;
        // ATOMCTL 复位值（core 配置）。S32C1I 不按它区分内存属性：S3 内部 SRAM 上原子操作总能成功
        c.sr[sr::ATOMCTL as usize] = 0x28;
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
            sr::CCOUNT => self.ccount(),
            sr::PRID => self.prid,
            sr::SAR => self.sar(),
            sr::LITBASE => self.sr[n as usize] & 0xffff_f001,
            sr::INTERRUPT => self.pending(),
            // INTCLEAR 只写
            sr::INTCLEAR => 0,
            _ => self.sr[n as usize & 0xff],
        }
    }

    pub fn write_sr(&mut self, n: u32, v: u32) {
        match n {
            sr::WINDOWBASE => self.windowbase = v & 15,
            sr::WINDOWSTART => self.windowstart = v & 0xffff,
            sr::CCOUNT => {
                // 先按旧计数结算定时器，写入本身不触发 CCOMPARE
                self.tick_timers();
                self.ccount_off = v.wrapping_sub(self.cycles as u32);
                self.cc_next = 0;
            }
            sr::PRID => {}
            sr::SAR => self.sr[n as usize] = v & 0x3f,
            // 写 INTERRUPT 即 INTSET：只能置软件中断位
            sr::INTERRUPT => self.irq_latched |= v & irq::SOFTWARE,
            sr::INTCLEAR => self.irq_latched &= !(v & (irq::SOFTWARE | irq::EXT_EDGE | irq::NMI)),
            sr::CCOMPARE0..=sr::CCOMPARE2 => {
                self.tick_timers();
                self.sr[n as usize] = v;
                self.irq_latched &= !(1 << irq::TIMER_LINE[(n - sr::CCOMPARE0) as usize]);
                self.cc_next = 0;
            }
            _ => self.sr[n as usize & 0xff] = v,
        }
    }

    pub fn read_ur(&self, n: u32) -> u32 {
        match n {
            sr::UR_THREADPTR => self.threadptr,
            sr::UR_FCR => self.fcr,
            sr::UR_FSR => self.fsr,
            _ => 0,
        }
    }

    pub fn write_ur(&mut self, n: u32, v: u32) {
        match n {
            sr::UR_THREADPTR => self.threadptr = v,
            sr::UR_FCR => self.fcr = v & fpu::FCR_MASK,
            sr::UR_FSR => self.fsr = v & fpu::FSR_MASK,
            _ => {}
        }
    }

    // ------------------------------------------------------------ 中断
    /// SoC 驱动外部中断线（位 = CPU 中断号）。边沿型 / NMI 线在上升沿锁存
    pub fn set_irq_lines(&mut self, mask: u32) {
        let rising = mask & !self.irq_ext;
        self.irq_latched |= rising & (irq::EXT_EDGE | irq::NMI);
        self.irq_ext = mask;
    }

    /// INTERRUPT 寄存器：挂起的中断
    pub fn pending(&self) -> u32 {
        self.irq_latched | (self.irq_ext & irq::EXT_LEVEL)
    }

    /// CCOUNT 寄存器的当前值
    #[inline]
    pub fn ccount(&self) -> u32 {
        (self.cycles as u32).wrapping_add(self.ccount_off)
    }

    /// 检查 CCOUNT 自上次以来是否越过了某个 CCOMPARE，越过则挂起对应定时器中断。
    /// SoC 直接改 `cycles`（WAITI 快进）也没关系：下次 step 会补检。
    #[inline(always)]
    fn tick_timers(&mut self) {
        // 快路径：每条指令都会调到，绝大多数时候离最近的 CCOMPARE 还远
        if self.cycles < self.cc_next {
            return;
        }
        self.tick_timers_slow();
    }

    fn tick_timers_slow(&mut self) {
        let (last, now) = (self.last_cc, self.cycles);
        let span = now.wrapping_sub(last);
        let mut next = u64::MAX;
        for i in 0..3 {
            let c = self.sr[(sr::CCOMPARE0 + i as u32) as usize];
            // 从 last 往后第一次 CCOUNT == c 的距离（1..=2^32）
            let d = match c.wrapping_sub((last as u32).wrapping_add(self.ccount_off)) {
                0 => 1u64 << 32,
                d => d as u64,
            };
            if d <= span {
                self.irq_latched |= 1 << irq::TIMER_LINE[i];
            }
            // 从 now 往后的下一次（与下次调用时按 last = now 重算的结果相同）
            let dn = match c.wrapping_sub((now as u32).wrapping_add(self.ccount_off)) {
                0 => 1u64 << 32,
                d => d as u64,
            };
            next = next.min(now + dn);
        }
        self.last_cc = now;
        self.cc_next = next;
    }

    /// 下一个能唤醒 CPU 的定时器事件（绝对周期数），供 SoC 在 WAITI 时快进
    pub fn next_timer_event(&self) -> Option<u64> {
        let en = self.sr[sr::INTENABLE as usize];
        (0..3)
            .filter(|&i| en & (1 << irq::TIMER_LINE[i]) != 0)
            .map(|i| {
                let c = self.sr[(sr::CCOMPARE0 + i as u32) as usize];
                let d = match c.wrapping_sub(self.ccount()) {
                    0 => 1u64 << 32,
                    d => d as u64,
                };
                self.cycles + d
            })
            .min()
    }

    /// 当前允许响应的最高级别挂起中断（1..=7），没有则 0
    fn irq_to_take(&self) -> u32 {
        let p = self.pending() & self.sr[sr::INTENABLE as usize];
        if p == 0 {
            return 0;
        }
        let ps = self.ps();
        let mut min = ps & PS_INTLEVEL;
        if ps & PS_EXCM != 0 {
            min = min.max(irq::EXCM_LEVEL);
        }
        let mut best = 0u32;
        let mut m = p;
        while m != 0 {
            let i = m.trailing_zeros();
            m &= m - 1;
            best = best.max(irq::LEVEL[i as usize] as u32);
        }
        if best > min {
            best
        } else {
            0
        }
    }

    /// 进入中断：level 1 走 User / Kernel 一般异常向量（EXCCAUSE=4），level ≥2 走各自向量
    fn take_interrupt(&mut self, level: u32) {
        let ps = self.ps();
        if level == 1 {
            self.sr[sr::EXCCAUSE as usize] = cause::LEVEL1_INTERRUPT;
            self.sr[sr::EPC1 as usize] = self.pc;
            self.set_ps(ps | PS_EXCM);
            self.pc = self.vecbase() + if ps & PS_UM != 0 { vec::USER } else { vec::KERNEL };
        } else {
            self.sr[(sr::EPC1 + level - 1) as usize] = self.pc;
            self.sr[(sr::EPS2 + level - 2) as usize] = ps;
            self.set_ps((ps & !PS_INTLEVEL) | level | PS_EXCM);
            self.pc = self.vecbase() + vec::LEVEL[level as usize];
        }
        self.waiting = false;
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
            self.pc = self.vecbase()
                + if ps & PS_UM != 0 {
                    vec::USER
                } else {
                    vec::KERNEL
                };
        }
        self.waiting = false;
    }

    /// 窗口溢出检查：指令要用到当前窗口的第 max_quad 个四元组（0..=3）。
    /// 若中间某个四元组属于别的活帧（WINDOWSTART 位为 1），先把其中最老的帧溢出到栈上。
    /// 返回 true 表示已进入溢出处理程序（本条指令稍后重新执行）。
    #[inline(always)]
    fn window_check(&mut self, insn: u32, narrow: bool) -> bool {
        let ps = self.ps();
        if ps & PS_WOE == 0 || ps & PS_EXCM != 0 {
            return false;
        }
        let wb = self.windowbase;
        // 快路径：当前窗口往上 3 个四元组都不属于别的活帧时，不论指令用到哪个都不会溢出
        let ws = self.windowstart | (self.windowstart << 16);
        if (ws >> (wb + 1)) & 7 == 0 {
            return false;
        }
        let max_quad = max_quad(insn, narrow, ps);
        if max_quad == 0 {
            return false;
        }
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
    #[inline(always)]
    pub fn step<B: Bus>(&mut self, bus: &mut B) -> Exit {
        self.tick_timers();
        let level = self.irq_to_take();
        if level != 0 {
            self.take_interrupt(level);
            return Exit::Normal;
        }
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
        if self.window_check(insn, narrow) {
            return Exit::Normal;
        }
        let flow = if narrow {
            self.exec_narrow(bus, insn)
        } else {
            self.exec(bus, insn)
        };
        match flow {
            Ok(Flow::Next) => {
                let mut next = pc.wrapping_add(len);
                // 零开销循环：顺序执行到 LEND 且 LCOUNT≠0 时回到 LBEG
                if next == self.sr[sr::LEND as usize]
                    && self.sr[sr::LCOUNT as usize] != 0
                    && self.ps() & PS_EXCM == 0
                {
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

    /// 连续执行指令，直到：cycles 到 `until`、指令返回 Normal 以外的结果、PC 落进 [`vec_lo`, `vec_hi`)
    /// （SoC 要检查的异常向量区）、或 `bus.attention()` 为 true。至少执行一步。
    /// 与逐条调 `step` 并在每步之间做同样检查的结果完全相同，只是省掉每条指令的调用和返回开销
    #[inline(never)]
    pub fn run_batch<B: Bus>(&mut self, bus: &mut B, until: u64, vec_lo: u32, vec_hi: u32) -> Exit {
        loop {
            let e = self.step(bus);
            if !matches!(e, Exit::Normal) {
                return e;
            }
            let in_vec = self.pc.wrapping_sub(vec_lo) < vec_hi.wrapping_sub(vec_lo);
            if in_vec || self.cycles >= until || bus.attention(self.cycles) {
                return Exit::Normal;
            }
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
                let Some(v) = self.load(bus, a, 4) else {
                    return Ok(Flow::Done);
                };
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
                    let v = if imm >= 96 {
                        imm.wrapping_sub(128)
                    } else {
                        imm
                    };
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
                let base = if lb & 1 != 0 {
                    lb & 0xffff_f000
                } else {
                    pc.wrapping_add(3) & !3
                };
                let a = base.wrapping_add(imm);
                let Some(v) = self.load(bus, a, 4) else {
                    return Ok(Flow::Done);
                };
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
                        let Some(mut v) = self.load(bus, a, size) else {
                            return Ok(Flow::Done);
                        };
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
                        let Some(old) = self.load(bus, a, 4) else {
                            return Ok(Flow::Done);
                        };
                        if old == self.sr[sr::SCOMPARE1 as usize]
                            && !self.store(bus, a, 4, self.a(t))
                        {
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
                    0 => {
                        return Ok(Flow::Jump(
                            pc.wrapping_add(4).wrapping_add(sext(insn >> 6, 18)),
                        ))
                    }
                    1 => {
                        let v = self.a(s) as i32;
                        let taken = match m {
                            0 => v == 0,
                            1 => v != 0,
                            2 => v < 0,
                            _ => v >= 0,
                        };
                        if taken {
                            return Ok(Flow::Jump(
                                pc.wrapping_add(4).wrapping_add(sext(insn >> 12, 12)),
                            ));
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
                                    return Ok(Flow::Jump(
                                        pc.wrapping_add(4).wrapping_add(sext(imm8, 8)),
                                    ));
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
                                return Ok(Flow::Jump(
                                    pc.wrapping_add(4).wrapping_add(sext(imm8, 8)),
                                ));
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
            3 => return self.exec_lsci(bus, t, s, r, imm8),
            4 => return self.exec_mac16(bus, t, s, r, op1, op2),
            _ => return self.illegal(),
        }
        Ok(Flow::Next)
    }

    #[allow(clippy::too_many_arguments)]
    fn exec_qrst<B: Bus>(
        &mut self,
        bus: &mut B,
        insn: u32,
        t: u32,
        s: u32,
        r: u32,
        op1: u32,
        op2: u32,
    ) -> Result<Flow, Exit> {
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
                        // MOVSP at, as：前 3 个四元组里都没有活帧起点（调用者已溢出到栈上，
                        // 它的基本保存区在旧 sp 下方）→ Alloca 异常，由处理程序搬保存区；否则直接传送
                        let wb = self.windowbase;
                        if !(1..=3).any(|k| self.ws_bit(wb + 16 - k)) {
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
                        // SIMCALL：交给外层（测试里实现半主机输出 / 退出），PC 先越过
                        self.pc = pc.wrapping_add(3);
                        self.instret += 1;
                        return Err(Exit::Simcall);
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
                        let v = if r & 1 == 0 {
                            bits != 0
                        } else {
                            bits == (1 << n) - 1
                        };
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
                    6 => {
                        let v = bus.rer(as_);
                        self.set_a(t, v);
                    }
                    7 => bus.wer(as_, at),
                    8 => self.windowbase = self.windowbase.wrapping_add(sext(t, 4)) & 15,
                    14 => {
                        let v = if as_ as i32 >= 0 { as_ } else { !as_ };
                        self.set_a(t, v.leading_zeros().saturating_sub(1).min(31));
                    }
                    15 => self.set_a(t, as_.leading_zeros()),
                    _ => return self.illegal(),
                },
                5 => {
                    // TLB 类（S3 只有区域保护）：按 vaddr 高 3 位选区域
                    let region = (as_ >> 29) as usize;
                    match r {
                        // RxTLB0：区域基址；RxTLB1：基址 | 属性；PxTLB：基址 | 1（命中）。均与 QEMU 对照
                        3 | 11 => self.set_a(t, as_ & 0xe000_0000),
                        7 => self.set_a(t, (as_ & 0xe000_0000) | self.itlb_attr[region]),
                        15 => self.set_a(t, (as_ & 0xe000_0000) | self.dtlb_attr[region]),
                        5 | 13 => self.set_a(t, (as_ & 0xe000_0000) | 1),
                        6 => self.itlb_attr[region] = at & 0xf,
                        14 => self.dtlb_attr[region] = at & 0xf,
                        4 | 12 => {}
                        _ => return self.illegal(),
                    }
                }
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
                6 => self.set_a(r, (as_ < at) as u32),
                7 => self.set_a(r, ((as_ as i32) < at as i32) as u32),
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
                    let n = (s << 4) | t;
                    if fpu::is_fp_ur(n) && !self.cp0_enabled() {
                        return self.cp0_disabled();
                    }
                    let v = self.read_ur(n);
                    self.set_a(r, v);
                }
                _ => {
                    let n = (r << 4) | s;
                    if fpu::is_fp_ur(n) && !self.cp0_enabled() {
                        return self.cp0_disabled();
                    }
                    self.write_ur(n, at)
                }
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
                        let Some(v) = self.load(bus, a, 4) else {
                            return Ok(Flow::Done);
                        };
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
            8 => return self.exec_lscx(bus, t, s, r, op2),
            10 => return self.exec_fp0(t, s, r, op2),
            11 => return self.exec_fp1(t, s, r, op2),
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
                6 | 7 | 14 | 15 => q(&[s, t]),
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
