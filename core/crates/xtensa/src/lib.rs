//! Xtensa interpreter core configured as ESP32-S3 (LX7) / ESP32 (LX6) per ESP-IDF `xtensa/<chip>/include/xtensa/config/core-isa.h`:
//! 64 physical ARs + windowed ABI, 16-bit density ops, zero-overhead loops, MUL16/MUL32/DIV32, NSA/MIN/MAX/SEXT/CLAMPS,
//! booleans, S32C1I, unaligned access, VECBASE reset 0x40000000. 32 IRQ lines typed per XCHAL_INTn_TYPE / LEVEL; the SoC
//! drives external lines via `set_irq_lines`, CCOMPARE0..2 are lines 6 / 15 / 16. FPU and MAC16: see fpu.rs / mac16.rs.
//! PIE (EE.*) is unimplemented and raises illegal instruction (EXCCAUSE 0). Both chips' core-isa.h agree on every option
//! implemented here, differing only in HW version / CONFIGID (and PIE), hence one `Variant` param, not two copies. lint: allow-long-comment

/// Core configuration (core-isa.h)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Variant {
    /// ESP32-S3: Xtensa LX7 (XCHAL_HW_VERSION 270012)
    #[default]
    Lx7Esp32s3,
    /// ESP32: Xtensa LX6 (XCHAL_HW_VERSION 260003)
    Lx6Esp32,
}

impl Variant {
    /// XCHAL_HW_CONFIGID0 / 1 (SR 176 / 208, read-only): debuggers / gdbstub identify the core by these
    pub fn config_id(self) -> (u32, u32) {
        match self {
            Variant::Lx7Esp32s3 => (0xC2F0_FFFE, 0x2309_0F1F),
            Variant::Lx6Esp32 => (0xC2BC_FFFE, 0x1CC5_FE96),
        }
    }
}

mod fast;
mod fpu;
mod mac16;
pub mod sr;

/// Returned by the bus on a failed access; the core raises an exception from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BusFault;

pub trait Bus {
    fn load(&mut self, addr: u32, size: u32) -> Result<u32, BusFault>;
    fn store(&mut self, addr: u32, size: u32, val: u32) -> Result<(), BusFault>;
    /// Fetch: 3 bytes from addr (little-endian into 24 bits; 16-bit ops use the low 16).
    fn fetch(&mut self, addr: u32) -> Result<u32, BusFault> {
        let b0 = self.load(addr, 1)?;
        let b1 = self.load(addr.wrapping_add(1), 1)?;
        if is_narrow(b0) {
            return Ok(b0 | (b1 << 8));
        }
        let b2 = self.load(addr.wrapping_add(2), 1)?;
        Ok(b0 | (b1 << 8) | (b2 << 16))
    }
    /// RER: read external register (reads 0 on ESP32-S3 when no peripheral is attached)
    fn rer(&mut self, _addr: u32) -> u32 {
        0
    }
    /// WER: write external register
    fn wer(&mut self, _addr: u32, _val: u32) {}
    /// Asked by `Cpu::run_batch` after every instruction: does the SoC need to act first (peripheral event due, IRQ lines to
    /// recompute)? `cycles` is this core's cycle count; true stops the batch and returns to the SoC
    #[inline(always)]
    fn attention(&mut self, _cycles: u64) -> bool {
        false
    }
    /// Ran `L32I a1, as, 0` (`SP = pxCurrentTCBs[core]->pxTopOfStack` in `_frxt_dispatch` / `_frxt_int_exit`): a FreeRTOS
    /// task switch. `base` = as (maybe a TCB), `core` = 0 / 1, `cycles` = that core's cycles. Used by the task timeline (C-04)
    fn sp_loaded(&mut self, _core: u32, _base: u32, _cycles: u64) {}
}

/// op0 8..=13 are 16-bit density instructions
#[inline(always)]
pub fn is_narrow(b0: u32) -> bool {
    matches!(b0 & 0xf, 8..=13)
}

/// EXCCAUSE codes (Xtensa ISA RM table 4-64)
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

/// Interrupt configuration (ESP32-S3 core-isa.h)
pub mod irq {
    /// XCHAL_INTn_LEVEL
    pub const LEVEL: [u8; 32] = [
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 7, 3, 5, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 3, 4, 3,
        4, 5,
    ];
    /// External level-triggered
    pub const EXT_LEVEL: u32 = !(EXT_EDGE | NMI | SOFTWARE | TIMER | PROFILING);
    /// External edge-triggered (10, 22, 28, 30)
    pub const EXT_EDGE: u32 = 1 << 10 | 1 << 22 | 1 << 28 | 1 << 30;
    /// NMI (14, edge)
    pub const NMI: u32 = 1 << 14;
    /// Software interrupts (7, 29): set by INTSET, cleared by INTCLEAR
    pub const SOFTWARE: u32 = 1 << 7 | 1 << 29;
    /// Timers (CCOMPARE0/1/2 -> 6/15/16), cleared by writing the matching CCOMPARE
    pub const TIMER: u32 = 1 << 6 | 1 << 15 | 1 << 16;
    pub const TIMER_LINE: [u32; 3] = [6, 15, 16];
    /// Performance counter overflow (11), never raised by the simulator
    pub const PROFILING: u32 = 1 << 11;
    pub const EXCM_LEVEL: u32 = 3;
}

/// Vector offsets from VECBASE (core-isa.h)
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
    /// Interrupt vectors for level 2..=7 (7 is NMI)
    pub const LEVEL: [u32; 8] = [0, 0, 0x180, 0x1c0, 0x200, 0x240, 0x280, 0x2c0];
}

// PS fields
pub const PS_INTLEVEL: u32 = 0xf;
pub const PS_EXCM: u32 = 1 << 4;
pub const PS_UM: u32 = 1 << 5;
pub const PS_OWB_SHIFT: u32 = 8;
pub const PS_CALLINC_SHIFT: u32 = 16;
pub const PS_WOE: u32 = 1 << 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Normal,
    /// PC is inside the HLE range and in hle_addrs: the SoC takes over
    Hle(u32),
    /// WAITI: wait for interrupt
    Waiti,
    /// BREAK / BREAK.N (debugger breakpoint; tests treat it as "program end")
    Break(u32),
    /// SIMCALL (simulator call, a2 = function number). PC is already past it; a SoC that doesn't care treats it as a no-op
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

/// Result of one instruction: continue sequentially, jump, or take an exception
enum Flow {
    Next,
    Jump(u32),
    /// PC already handled (exception, RFE, window exception, ...)
    Done,
}

pub struct Cpu {
    /// 64 physical address registers
    pub ar: [u32; 64],
    pub pc: u32,
    /// Special registers indexed by SR number; WINDOWBASE / WINDOWSTART / CCOUNT have their own fields
    pub sr: [u32; 256],
    pub windowbase: u32,
    pub windowstart: u32,
    pub threadptr: u32,
    pub cycles: u64,
    pub instret: u64,
    /// Time-base cycles per instruction x3 (3 = 160 MHz, 2 = 240, 6 = 80); the SoC sets it from its CPU clock registers
    pub cpi3: u32,
    /// Leftover thirds of a cycle while cpi3 != 3
    cpi_frac: u32,
    pub waiting: bool,
    pub hle_lo: u32,
    pub hle_hi: u32,
    pub hle_addrs: Vec<u32>,
    /// Processor ID (same on ESP32-S3 / ESP32: core 0 = 0xCDCD, core 1 = 0xABAB)
    pub prid: u32,
    /// Core configuration (LX7 / LX6)
    pub variant: Variant,
    /// External IRQ line levels driven by the SoC (bit = CPU interrupt number)
    irq_ext: u32,
    /// Latched pending bits: edge, NMI, software, timer
    irq_latched: u32,
    /// See refresh_irq
    irq_maybe: bool,
    /// Cycle count at the last CCOMPARE check
    last_cc: u64,
    /// Earliest cycle (absolute) a CCOMPARE can fire; below it tick_timers has nothing to do. Writing CCOMPARE / CCOUNT zeroes it to force a recompute
    cc_next: u64,
    /// CCOUNT = low 32 bits of cycles + ccount_off. Firmware writes to CCOUNT (IDF rescales it on CPU frequency change) only move
    /// this offset, never `cycles`: that is whole-system simulated time, and a jump would desync peripherals and the other core
    ccount_off: u32,
    /// Region protection (ESP32-S3 has no MMU): I / D attributes of 8 x 512MB regions, written by WITLB / WDTLB, read by RITLB1 / RDTLB1
    pub itlb_attr: [u32; 8],
    pub dtlb_attr: [u32; 8],
    /// FPU registers f0..f15 (bit patterns) and FCR / FSR
    pub fr: [u32; 16],
    pub fcr: u32,
    pub fsr: u32,
    /// Predecode cache (see fast.rs). Hits require identical PC and raw bytes, so code changes need not notify it
    dcache: Box<[fast::Dec; fast::DCACHE_SIZE]>,
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
            cpi3: 3,
            cpi_frac: 0,
            waiting: false,
            hle_lo: 0,
            hle_hi: 0,
            hle_addrs: Vec::new(),
            prid: 0xcdcd,
            variant: Variant::default(),
            irq_ext: 0,
            irq_latched: 0,
            irq_maybe: false,
            last_cc: 0,
            cc_next: 0,
            ccount_off: 0,
            // Reset attribute 2 (RWX, bypass), matched against QEMU
            itlb_attr: [2; 8],
            dtlb_attr: [2; 8],
            fr: [0; 16],
            fcr: 0,
            fsr: 0,
            dcache: fast::new_cache(),
        };
        // Reset: PS.INTLEVEL=15, EXCM=1; VECBASE reset value
        c.sr[sr::PS as usize] = 0x1f;
        c.sr[sr::VECBASE as usize] = 0x4000_0000;
        // ATOMCTL reset value (core config). S32C1I ignores it for memory attributes: atomics always succeed on S3 internal SRAM
        c.sr[sr::ATOMCTL as usize] = 0x28;
        c
    }

    /// New core with the given configuration (ESP32 uses `Variant::Lx6Esp32`)
    pub fn with_variant(variant: Variant) -> Self {
        let mut c = Self::new();
        c.variant = variant;
        c
    }

    // ------------------------------------------------------------ registers
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
            sr::CONFIGID0 => self.variant.config_id().0,
            sr::CONFIGID1 => self.variant.config_id().1,
            sr::SAR => self.sar(),
            sr::LITBASE => self.sr[n as usize] & 0xffff_f001,
            sr::INTERRUPT => self.pending(),
            // INTCLEAR is write-only
            sr::INTCLEAR => 0,
            _ => self.sr[n as usize & 0xff],
        }
    }

    pub fn write_sr(&mut self, n: u32, v: u32) {
        match n {
            sr::WINDOWBASE => self.windowbase = v & 15,
            sr::WINDOWSTART => self.windowstart = v & 0xffff,
            sr::CCOUNT => {
                // Settle timers at the old count first; the write itself never fires CCOMPARE
                self.tick_timers();
                self.ccount_off = v.wrapping_sub(self.cycles as u32);
                self.cc_next = 0;
            }
            sr::PRID | sr::CONFIGID0 | sr::CONFIGID1 => {}
            sr::SAR => self.sr[n as usize] = v & 0x3f,
            // Writing INTERRUPT means INTSET: it can only set software interrupt bits
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
        self.refresh_irq();
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

    // ------------------------------------------------------------ interrupts
    /// SoC drives the external IRQ lines (bit = CPU interrupt number). Edge / NMI lines latch on the rising edge
    pub fn set_irq_lines(&mut self, mask: u32) {
        let rising = mask & !self.irq_ext;
        self.irq_latched |= rising & (irq::EXT_EDGE | irq::NMI);
        self.irq_ext = mask;
        self.refresh_irq();
    }

    /// INTERRUPT register: pending interrupts
    pub fn pending(&self) -> u32 {
        self.irq_latched | (self.irq_ext & irq::EXT_LEVEL)
    }

    /// Current CCOUNT value
    #[inline]
    pub fn ccount(&self) -> u32 {
        (self.cycles as u32).wrapping_add(self.ccount_off)
    }

    /// Pends the timer interrupt for any CCOMPARE that CCOUNT crossed since last time. SoC edits to `cycles`
    /// (WAITI fast-forward) are fine: the next step catches up.
    #[inline(always)]
    fn tick_timers(&mut self) {
        // Fast path: called every instruction, and the nearest CCOMPARE is almost always far away
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
            // Distance from last to the first CCOUNT == c after it (1..=2^32)
            let d = match c.wrapping_sub((last as u32).wrapping_add(self.ccount_off)) {
                0 => 1u64 << 32,
                d => d as u64,
            };
            if d <= span {
                self.irq_latched |= 1 << irq::TIMER_LINE[i];
            }
            // The next one after now (same as recomputing with last = now on the next call)
            let dn = match c.wrapping_sub((now as u32).wrapping_add(self.ccount_off)) {
                0 => 1u64 << 32,
                d => d as u64,
            };
            next = next.min(now + dn);
        }
        self.last_cc = now;
        self.cc_next = next;
        self.refresh_irq();
    }

    /// Next timer event that can wake the CPU (absolute cycles), so the SoC can fast-forward during WAITI
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

    /// Highest pending interrupt level currently allowed (1..=7), or 0
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

    /// Take an interrupt: level 1 uses the User / Kernel general exception vector (EXCCAUSE=4), level >= 2 its own vector
    fn take_interrupt(&mut self, level: u32) {
        let ps = self.ps();
        if level == 1 {
            self.sr[sr::EXCCAUSE as usize] = cause::LEVEL1_INTERRUPT;
            self.sr[sr::EPC1 as usize] = self.pc;
            self.set_ps(ps | PS_EXCM);
            self.pc = self.vecbase()
                + if ps & PS_UM != 0 {
                    vec::USER
                } else {
                    vec::KERNEL
                };
        } else {
            self.sr[(sr::EPC1 + level - 1) as usize] = self.pc;
            self.sr[(sr::EPS2 + level - 2) as usize] = ps;
            self.set_ps((ps & !PS_INTLEVEL) | level | PS_EXCM);
            self.pc = self.vecbase() + vec::LEVEL[level as usize];
        }
        self.waiting = false;
    }

    // ------------------------------------------------------------ exceptions
    /// General exception: EPC1/EXCCAUSE/EXCVADDR, User / Kernel vector by PS.UM; double exception if already in one
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

    /// Window overflow: the op uses quad max_quad (0..=3) of the current window; if a quad in between belongs to another live
    /// frame (WINDOWSTART bit set), spill the oldest first. True = handler entered, op re-executes (fast path: fast.rs window_check_dec)
    #[inline(never)]
    fn window_spill(&mut self, max_quad: u32, ps: u32) -> bool {
        let wb = self.windowbase;
        if max_quad == 0 {
            return false;
        }
        let Some(k) = (1..=max_quad).find(|k| self.ws_bit(wb + k)) else {
            return false;
        };
        // The spilled frame is at wb+k; its size is the distance to the next (newer) frame
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

    // ------------------------------------------------------------ execution
    /// Single-step one instruction (or take an interrupt, or wait for one)
    pub fn step<B: Bus>(&mut self, bus: &mut B) -> Exit {
        // Outside code may have changed pub fields (sr, cycles) directly, so recompute IRQ flags from the current state
        self.refresh_irq();
        let mut cycles = self.cycles;
        let mut retired = 0;
        let e = self.step_inner(bus, &mut cycles, &mut retired);
        self.cycles = cycles;
        self.instret += retired;
        e
    }

    /// `self.irq_maybe` = an enabled interrupt is pending (ignoring PS level, so a superset of irq_to_take != 0).
    /// Call it wherever pending bits / INTENABLE change
    #[inline(always)]
    fn refresh_irq(&mut self) {
        self.irq_maybe = (self.irq_latched | self.irq_ext) & self.sr[sr::INTENABLE as usize] != 0;
    }

    /// Body of step. Cycle and retired counts live in the caller's locals (registers in batch mode, no per-op memory traffic);
    /// they are synced around paths that read `self.cycles` (timer settling, special ops on the generic decoder)
    #[inline(always)]
    fn step_inner<B: Bus>(&mut self, bus: &mut B, cycles: &mut u64, retired: &mut u64) -> Exit {
        if *cycles >= self.cc_next {
            self.cycles = *cycles;
            self.tick_timers_slow();
        }
        if self.irq_maybe {
            let level = self.irq_to_take();
            if level != 0 {
                self.take_interrupt(level);
                return Exit::Normal;
            }
        }
        if self.waiting {
            *cycles += 1;
            return Exit::Waiti;
        }
        let pc = self.pc;
        if pc >= self.hle_lo && pc < self.hle_hi && self.hle_addrs.binary_search(&pc).is_ok() {
            return Exit::Hle(pc);
        }
        let d = match self.fetch_dec(bus, pc) {
            Ok(d) => d,
            Err(_) => {
                self.exception(cause::INSN_FETCH_ERROR, pc);
                return Exit::Normal;
            }
        };
        if self.cpi3 == 3 {
            *cycles += 1;
        } else {
            self.cpi_frac += self.cpi3;
            *cycles += (self.cpi_frac / 3) as u64;
            self.cpi_frac %= 3;
        }
        let len = d.len as u32;
        if self.window_check_dec(&d) {
            return Exit::Normal;
        }
        let flow = if d.op == fast::Op::Generic {
            // Special register access (CCOUNT, CCOMPARE...) needs the exact cycle count
            self.cycles = *cycles;
            let f = if d.len == 2 {
                self.exec_narrow(bus, d.raw)
            } else {
                self.exec(bus, d.raw)
            };
            *cycles = self.cycles;
            f
        } else {
            self.exec_dec(bus, &d)
        };
        match flow {
            Ok(Flow::Next) => {
                let mut next = pc.wrapping_add(len);
                // Zero-overhead loop: falling through to LEND with LCOUNT != 0 jumps back to LBEG
                if next == self.sr[sr::LEND as usize]
                    && self.sr[sr::LCOUNT as usize] != 0
                    && self.ps() & PS_EXCM == 0
                {
                    self.sr[sr::LCOUNT as usize] -= 1;
                    next = self.sr[sr::LBEG as usize];
                }
                self.pc = next;
                *retired += 1;
                Exit::Normal
            }
            Ok(Flow::Jump(t)) => {
                self.pc = t;
                *retired += 1;
                Exit::Normal
            }
            Ok(Flow::Done) => Exit::Normal,
            Err(e) => e,
        }
    }

    /// Runs until cycles reach `until`, an op returns non-Normal, PC enters [`vec_lo`, `vec_hi`) (vectors the SoC checks),
    /// or `bus.attention()` is true; at least one step. Same result as calling `step` with those checks, minus per-op call overhead
    #[inline(never)]
    pub fn run_batch<B: Bus>(&mut self, bus: &mut B, until: u64, vec_lo: u32, vec_hi: u32) -> Exit {
        self.refresh_irq();
        let mut cycles = self.cycles;
        let mut retired = 0;
        let e = loop {
            let e = self.step_inner(bus, &mut cycles, &mut retired);
            if !matches!(e, Exit::Normal) {
                break e;
            }
            let in_vec = self.pc.wrapping_sub(vec_lo) < vec_hi.wrapping_sub(vec_lo);
            if in_vec || cycles >= until || bus.attention(cycles) {
                break Exit::Normal;
            }
        };
        self.cycles = cycles;
        self.instret += retired;
        e
    }

    /// Core number: PRID 0xABAB is APP_CPU (core 1), anything else is core 0
    #[inline]
    pub fn core_index(&self) -> u32 {
        (self.prid == 0xabab) as u32
    }

    fn illegal(&mut self) -> Result<Flow, Exit> {
        self.exception(cause::ILLEGAL, 0);
        Ok(Flow::Done)
    }

    // One op in four is a memory access: inline the call, keep the error path separate (cold)
    #[inline(always)]
    fn load<B: Bus>(&mut self, bus: &mut B, addr: u32, size: u32) -> Option<u32> {
        match bus.load(addr, size) {
            Ok(v) => Some(v),
            Err(_) => {
                self.access_fault(addr);
                None
            }
        }
    }

    #[inline(always)]
    fn store<B: Bus>(&mut self, bus: &mut B, addr: u32, size: u32, v: u32) -> bool {
        if bus.store(addr, size, v).is_err() {
            self.access_fault(addr);
            return false;
        }
        true
    }

    #[cold]
    #[inline(never)]
    fn access_fault(&mut self, addr: u32) {
        self.exception(cause::LOAD_STORE_ERROR, addr);
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
                if t == 1 && r == 0 {
                    bus.sp_loaded(self.core_index(), a, self.cycles);
                }
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
                    // MOVI.N as, imm7 (-32..95)
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
            // The caller's frame was spilled to the stack: window underflow; the handler restores it and RETW re-executes
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
                // L32R: address = ((PC+3) aligned to 4) + one-extended imm16<<2; LITBASE, when enabled, is the base instead
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
                        if r == 2 && t == 1 && imm8 == 0 {
                            bus.sp_loaded(self.core_index(), a, self.cycles);
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
                    7 => {} // CACHE ops: the simulator has no cache, no-op
                    10 => self.set_a(t, sext((s << 8) | imm8, 12)),
                    12 => self.set_a(t, base.wrapping_add(sext(imm8, 8))),
                    13 => self.set_a(t, base.wrapping_add(sext(imm8, 8) << 8)),
                    14 => {
                        // S32C1I: store only if equal to SCOMPARE1; at always gets the old value
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
                        // MOVSP at, as: if none of the first 3 quads starts a live frame (caller spilled, its base save area is below the
                        // old sp), raise Alloca so the handler moves the save area; otherwise a plain move
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
                        // SIMCALL: hand to the outer layer (tests implement semihosting output / exit there), PC already advanced
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
                        // ANY4 / ALL4 / ANY8 / ALL8: bt = OR / AND of bs..bs+n
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
                    // TLB ops (S3 has region protection only): region chosen by the top 3 bits of vaddr
                    let region = (as_ >> 29) as usize;
                    match r {
                        // RxTLB0: region base; RxTLB1: base | attributes; PxTLB: base | 1 (hit). All matched against QEMU
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
                        // SLLI: the encoding stores 32-shift
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
                // L32E / S32E: offset = r*4 - 64, window exception handlers only
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

    /// HLE function return (windowed calls outside the CALL0 convention are the SoC's job)
    pub fn hle_return_call0(&mut self, ret: u32) {
        self.set_a(2, ret);
        self.pc = self.a(0);
        self.instret += 1;
        self.cycles += 1;
    }
}

/// `Cpu::cpi3` for a CPU clock: PLL-derived CPUPERIOD_SEL 0 / 1 / 2 = 80 / 160 / 240 MHz on the 160 MHz time base.
/// XTAL / RC phases keep the old 1 instruction per cycle (not modelled, see ARCH)
pub fn cpi3_for(pll: bool, period_sel: u32) -> u32 {
    match (pll, period_sel & 3) {
        (true, 0) => 6,
        (true, 2) => 2,
        _ => 3,
    }
}

/// Highest quad (0..=3) of the current window the instruction uses, for the overflow check. Overestimating is safe: it only spills earlier.
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
            (9, _) => 0, // L32E/S32E are only used in EXCM=1 window handlers
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

/// Halt state of a dual-core Xtensa chip (debug output shared by S3 and ESP32); sym maps addresses to symbols
pub fn halt_state(c0: &Cpu, c1: Option<&Cpu>, sym: &dyn Fn(u32) -> String) -> String {
    let core = |c: &Cpu, k: usize| {
        format!(
            "core{k} pc {}  PS=0x{:08x} WB={} WS=0x{:04x} INTENABLE=0x{:08x} INTERRUPT=0x{:08x} EXCCAUSE={} EPC1={}",
            sym(c.pc),
            c.ps(),
            c.windowbase,
            c.windowstart,
            c.read_sr(sr::INTENABLE),
            c.read_sr(sr::INTERRUPT),
            c.read_sr(sr::EXCCAUSE),
            sym(c.read_sr(sr::EPC1)),
        )
    };
    let mut s = core(c0, 0);
    if let Some(c1) = c1 {
        s += "\n[tryboard] ";
        s += &core(c1, 1);
    }
    s
}

#[cfg(test)]
mod tests;
