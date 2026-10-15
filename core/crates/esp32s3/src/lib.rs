//! ESP32-S3 SoC：存储映射（含 PSRAM）、外设分发、直接启动、运行循环。单核启动（核 1 保持停住）。
//!
//! 与 C3 同族、寄存器布局一致的外设（UART、SYSTIMER、TIMG、SPI1 flash、LEDC）复用 tryboard-esp32c3 的模型；
//! S3 特有的中断矩阵、EXTMEM、49 脚 GPIO 在 periph.rs。

pub mod boot;
pub mod hle;
pub mod periph;
mod shim;

use periph::*;
use std::collections::HashMap;
use tryboard_esp32c3::ledc::Ledc;
use tryboard_esp32c3::periph::{Systimer, Timg, Uart};
use tryboard_esp32c3::spiflash::SpiFlash;
use tryboard_xtensa::{sr, Bus, BusFault, Cpu, Exit};

pub const CPU_HZ: u64 = tryboard_esp32c3::periph::CPU_HZ;

// 存储映射（soc/esp32s3/include/soc/soc.h）
/// SRAM0（32KB，只有 I 总线）+ SRAM1（416KB，I/D 双映射）
pub const IRAM_LOW: u32 = 0x4037_0000;
pub const IRAM_HIGH: u32 = 0x403E_0000;
/// SRAM1 的 D 总线别名 + SRAM2（64KB，只有 D 总线）
pub const DRAM_LOW: u32 = 0x3FC8_8000;
pub const DRAM_HIGH: u32 = 0x3FD0_0000;
/// D 0x3FC88000 与 I 0x40378000 是同一块 SRAM1
pub const DRAM_TO_IRAM: u32 = 0x4037_8000 - DRAM_LOW;
/// SRAM 缓冲：SRAM0 + SRAM1 + SRAM2 = 512KB，按 IRAM 地址 0x40370000 起排
pub const SRAM_SIZE: usize = 512 << 10;
pub const ROM_LOW: u32 = 0x4000_0000;
pub const ROM_HIGH: u32 = 0x4006_0000;
pub const DROM_MASK_LOW: u32 = 0x3FF0_0000;
pub const DROM_MASK_HIGH: u32 = 0x3FF2_0000;
pub const DROM_MASK_TO_ROM: u32 = 0x4004_0000 - DROM_MASK_LOW;
/// cache 窗口各 32MB，I/D 共用一张 MMU 表（线性地址 = vaddr & 0x1FFFFFF）
pub const IROM_LOW: u32 = 0x4200_0000;
pub const IROM_HIGH: u32 = 0x4400_0000;
pub const DROM_LOW: u32 = 0x3C00_0000;
pub const DROM_HIGH: u32 = 0x3E00_0000;
/// RTC 慢速内存（8KB）与 RTC 快速内存（8KB，I/D 同址）
pub const RTC_SLOW_LOW: u32 = 0x5000_0000;
pub const RTC_SLOW_HIGH: u32 = 0x5000_2000;
pub const RTC_FAST_LOW: u32 = 0x600F_E000;
pub const RTC_FAST_HIGH: u32 = 0x6010_0000;
pub const MMIO_LOW: u32 = 0x6000_0000;
pub const MMIO_HIGH: u32 = 0x600D_1000;

pub const MMU_BASE: u32 = 0x600C_5000;
pub const MMU_ENTRIES: usize = 512;
/// MMU 表项：位 13..0 物理页号，位 14 无效，位 15 类型（0 flash，1 PSRAM）
pub const MMU_INVALID: u32 = 1 << 14;
pub const MMU_PSRAM: u32 = 1 << 15;

/// N16R8：16MB flash + 8MB 八线 PSRAM（最常见的 S3 开发板配置）
pub const PSRAM_SIZE: usize = 8 << 20;

pub struct SocBus {
    pub sram: Vec<u8>,
    pub rtc_slow: Vec<u8>,
    pub rtc_fast: Vec<u8>,
    pub rom: Vec<u8>,
    pub flash: Vec<u8>,
    pub psram: Vec<u8>,
    pub mmu: Vec<u32>,
    pub now: u64,
    pub uart0: Uart,
    pub uart1: Uart,
    pub systimer: Systimer,
    pub timg0: Timg,
    pub timg1: Timg,
    pub intm: Intmatrix,
    pub gpio: Gpio,
    pub spi1: SpiFlash,
    pub extmem: Extmem,
    pub ledc: Ledc,
    pub analog: Analog,
    pub efuse: [u32; 0x200 / 4],
    /// SYSTEM_CPU_INTR_FROM_CPU_0..3
    pub from_cpu: u32,
    pub usj_tx: Vec<u8>,
    pub console: Vec<u8>,
    pub regs: HashMap<u32, u32>,
    pub unimpl: HashMap<u32, u64>,
    pub irq_dirty: bool,
    pub next_event: u64,
    pub gpio_log: Vec<(u64, u64)>,
    last_gpio: u64,
}

impl Default for SocBus {
    fn default() -> Self {
        let mut spi1 = SpiFlash::default();
        // GD25Q128：16MB
        spi1.jedec = 0x18_40_c8;
        SocBus {
            sram: vec![0; SRAM_SIZE],
            rtc_slow: vec![0; (RTC_SLOW_HIGH - RTC_SLOW_LOW) as usize],
            rtc_fast: vec![0; (RTC_FAST_HIGH - RTC_FAST_LOW) as usize],
            rom: vec![0; (ROM_HIGH - ROM_LOW) as usize],
            flash: Vec::new(),
            psram: vec![0; PSRAM_SIZE],
            mmu: vec![MMU_INVALID; MMU_ENTRIES],
            now: 0,
            uart0: Uart::default(),
            uart1: Uart::default(),
            systimer: Systimer::default(),
            timg0: Timg::default(),
            timg1: Timg::default(),
            intm: Intmatrix::default(),
            gpio: Gpio::default(),
            spi1,
            extmem: Extmem::default(),
            ledc: Ledc::default(),
            analog: Analog::default(),
            efuse: boot::default_efuse(),
            from_cpu: 0,
            usj_tx: Vec::new(),
            console: Vec::new(),
            regs: HashMap::new(),
            unimpl: HashMap::new(),
            irq_dirty: true,
            next_event: 0,
            gpio_log: Vec::new(),
            last_gpio: 1,
        }
    }
}

#[inline(always)]
fn rd(buf: &[u8], off: usize, size: u32) -> Option<u32> {
    match size {
        4 => buf.get(off..off + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        2 => buf.get(off..off + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as u32),
        _ => buf.get(off).map(|b| *b as u32),
    }
}

#[inline(always)]
fn wr(buf: &mut [u8], off: usize, size: u32, v: u32) -> Option<()> {
    let b = buf.get_mut(off..off + size as usize)?;
    b.copy_from_slice(&v.to_le_bytes()[..size as usize]);
    Some(())
}

/// cache 窗口翻译结果
enum Ext {
    Flash(usize),
    Psram(usize),
}

impl SocBus {
    #[inline]
    fn ext_addr(&self, vaddr: u32) -> Option<Ext> {
        let lin = vaddr & 0x1FF_FFFF;
        let e = self.mmu[(lin >> 16) as usize];
        if e & MMU_INVALID != 0 {
            return None;
        }
        let pa = (((e & 0x3fff) << 16) | (lin & 0xffff)) as usize;
        Some(if e & MMU_PSRAM != 0 { Ext::Psram(pa) } else { Ext::Flash(pa) })
    }

    /// SRAM 偏移（以 IRAM 0x40370000 为 0）
    #[inline]
    fn sram_off(a: u32) -> Option<usize> {
        if (DRAM_LOW..DRAM_HIGH).contains(&a) {
            Some((a + DRAM_TO_IRAM - IRAM_LOW) as usize)
        } else if (IRAM_LOW..IRAM_HIGH).contains(&a) {
            Some((a - IRAM_LOW) as usize)
        } else {
            None
        }
    }

    pub fn mem_read(&self, a: u32, size: u32) -> Option<u32> {
        if let Some(o) = Self::sram_off(a) {
            rd(&self.sram, o, size)
        } else if (IROM_LOW..IROM_HIGH).contains(&a) || (DROM_LOW..DROM_HIGH).contains(&a) {
            match self.ext_addr(a)? {
                Ext::Flash(f) => Some(rd(&self.flash, f, size).unwrap_or(0xffff_ffff)),
                Ext::Psram(p) => rd(&self.psram, p, size),
            }
        } else if (ROM_LOW..ROM_HIGH).contains(&a) {
            rd(&self.rom, (a - ROM_LOW) as usize, size)
        } else if (DROM_MASK_LOW..DROM_MASK_HIGH).contains(&a) {
            rd(&self.rom, (a + DROM_MASK_TO_ROM - ROM_LOW) as usize, size)
        } else if (RTC_FAST_LOW..RTC_FAST_HIGH).contains(&a) {
            rd(&self.rtc_fast, (a - RTC_FAST_LOW) as usize, size)
        } else if (RTC_SLOW_LOW..RTC_SLOW_HIGH).contains(&a) {
            rd(&self.rtc_slow, (a - RTC_SLOW_LOW) as usize, size)
        } else {
            None
        }
    }

    pub fn mem_write(&mut self, a: u32, size: u32, v: u32) -> Option<()> {
        if let Some(o) = Self::sram_off(a) {
            wr(&mut self.sram, o, size, v)
        } else if (DROM_LOW..DROM_HIGH).contains(&a) {
            // D 总线 cache 窗口只有映射到 PSRAM 的页可写
            match self.ext_addr(a)? {
                Ext::Psram(p) => wr(&mut self.psram, p, size, v),
                Ext::Flash(_) => None,
            }
        } else if (RTC_FAST_LOW..RTC_FAST_HIGH).contains(&a) {
            wr(&mut self.rtc_fast, (a - RTC_FAST_LOW) as usize, size, v)
        } else if (RTC_SLOW_LOW..RTC_SLOW_HIGH).contains(&a) {
            wr(&mut self.rtc_slow, (a - RTC_SLOW_LOW) as usize, size, v)
        } else {
            None
        }
    }

    fn mmio_read(&mut self, a: u32) -> u32 {
        let now = self.now;
        let (base, off) = (a & !0xfff, a & 0xfff);
        match base {
            0x6000_0000 => return self.uart0.read(off),
            0x6001_0000 => return self.uart1.read(off),
            0x6000_2000 => return self.spi1.read(off),
            0x6000_4000 => return self.gpio.read(off),
            0x6000_7000 if off < 0x200 => return self.efuse[(off / 4) as usize],
            0x6000_9000 if (4..=0xc4).contains(&off) => return self.gpio.iomux[((off - 4) / 4) as usize],
            0x6001_9000 => return self.ledc.read(off),
            0x6001_F000 => return self.timg0.read(off, now),
            0x6002_0000 => return self.timg1.read(off, now),
            0x6002_3000 => return self.systimer.read(off, now),
            0x6003_8000 => match off {
                0x04 => return 0x2, // EP1_CONF：IN 端点有空位
                0x08 => return 0x8, // INT_RAW：SERIAL_IN_EMPTY
                _ => {}
            },
            // I2C_MST_ANA_CONF0（regi2c_defs.h）：BBPLL 校准完成位（bit 24）——PLL 校准瞬间完成
            0x6000_E000 if off == 0x40 => return self.regs.get(&a).copied().unwrap_or(0) | (1 << 24),
            0x600C_2000 => {
                let lv = self.levels();
                if let Some(v) = self.intm.read(off, &lv) {
                    return v;
                }
            }
            0x600C_4000 if off < 0x400 => return self.extmem.read(off),
            0x600C_5000 if (off as usize) < MMU_ENTRIES * 4 => return self.mmu[(off / 4) as usize],
            _ => {}
        }
        if let Some(v) = boot::special_read(a, now) {
            return v;
        }
        *self.unimpl.entry(a).or_insert(0) += 1;
        self.regs.get(&a).copied().unwrap_or(0)
    }

    fn mmio_write(&mut self, a: u32, v: u32) {
        let now = self.now;
        let (base, off) = (a & !0xfff, a & 0xfff);
        self.irq_dirty = true;
        match base {
            0x6000_0000 => {
                self.uart0.write(off, v);
                if off == 0 {
                    self.console.push(v as u8);
                }
                return;
            }
            0x6001_0000 => return self.uart1.write(off, v),
            0x6000_2000 => return self.spi1.write(off, v, &mut self.flash),
            0x6000_4000 => {
                self.gpio.write(off, v);
                self.gpio_changed(now);
                return;
            }
            // eFuse 读寄存器只读；CMD 等写入不保存，读回 0（"命令已完成"）
            0x6000_7000 if off < 0x200 => return,
            0x6000_9000 if (4..=0xc4).contains(&off) => {
                self.gpio.iomux[((off - 4) / 4) as usize] = v;
                self.gpio_changed(now);
                return;
            }
            0x6001_9000 => return self.ledc.write(off, v, now),
            0x6001_F000 => return self.timg0.write(off, v, now),
            0x6002_0000 => return self.timg1.write(off, v, now),
            0x6002_3000 => return self.systimer.write(off, v, now),
            0x6003_8000 if off == 0 => {
                // USB-Serial-JTAG 第二控制台，内容与 UART0 重复，单独存
                self.usj_tx.push(v as u8);
                if self.usj_tx.len() > 1 << 16 {
                    self.usj_tx.drain(..1 << 15);
                }
                return;
            }
            0x600C_0000 if (0x30..=0x3c).contains(&off) => {
                let bit = (off - 0x30) / 4;
                if v & 1 != 0 {
                    self.from_cpu |= 1 << bit;
                } else {
                    self.from_cpu &= !(1 << bit);
                }
                return;
            }
            0x600C_2000 => {
                if self.intm.write(off, v) {
                    return;
                }
            }
            0x600C_4000 if off < 0x400 => return self.extmem.write(off, v),
            0x600C_5000 if (off as usize) < MMU_ENTRIES * 4 => {
                self.mmu[(off / 4) as usize] = v & 0xffff;
                return;
            }
            _ => {}
        }
        *self.unimpl.entry(a).or_insert(0) += 1;
        self.regs.insert(a, v);
    }

    pub fn gpio_changed(&mut self, now: u64) {
        self.gpio.sense();
        let lv = self.gpio.level();
        if lv != self.last_gpio {
            self.last_gpio = lv;
            self.gpio_log.push((now, lv));
            if self.gpio_log.len() > 1 << 16 {
                self.gpio_log.drain(..1 << 15);
            }
        }
        self.irq_dirty = true;
    }

    /// 所有中断源的当前电平（99 个源，两个 64 位字）
    pub fn levels(&self) -> [u64; 2] {
        let mut l = [0u64; 2];
        let mut set = |s: u32, on: bool| {
            if on {
                l[(s / 64) as usize] |= 1 << (s % 64);
            }
        };
        set(src::UART0, self.uart0.irq());
        set(src::UART1, self.uart1.irq());
        set(src::GPIO, self.gpio.irq());
        set(src::LEDC, self.ledc.irq());
        for i in 0..3 {
            set(src::SYSTIMER_TARGET0 + i, self.systimer.irq(i as usize));
        }
        set(src::TG0_T0, self.timg0.int_raw & self.timg0.int_ena & 1 != 0);
        set(src::TG1_T0, self.timg1.int_raw & self.timg1.int_ena & 1 != 0);
        for i in 0..4 {
            set(src::FROM_CPU0 + i, self.from_cpu & (1 << i) != 0);
        }
        l
    }

    /// 推进定时器、把外部中断线送进 CPU
    pub fn update<C: IrqCpu>(&mut self, cpu: &mut C) {
        let now = self.now;
        let n1 = self.systimer.update(now);
        let n2 = self.timg0.update(now);
        let n3 = self.timg1.update(now);
        let n4 = self.ledc.update(now);
        self.next_event = n1.min(n2).min(n3).min(n4);
        let lv = self.levels();
        let (level, rising) = self.intm.lines(&lv);
        cpu.set_extern_lines(level, rising);
        self.irq_dirty = false;
    }
}

/// SoC → CPU 的中断接口。
///
/// TODO(合并 Xtensa 中断切片后)：中断裁决（INTENABLE、PS.INTLEVEL、level 向量）应在 tryboard-xtensa 的
/// `Cpu::step` 里完成，届时这个 trait 的实现改成调用核提供的接口即可。现在的实现只把外部线写进
/// INTERRUPT 特殊寄存器，并在有可响应的中断时让 WAITI 醒来；核还不会真正进入中断向量。
pub trait IrqCpu {
    /// level：外部电平线当前输入（替换 INTERRUPT 中对应位）；rising：本次新出现的边沿线（置位，等 INTCLEAR 清）
    fn set_extern_lines(&mut self, level: u32, rising: u32);
}

impl IrqCpu for Cpu {
    fn set_extern_lines(&mut self, level: u32, rising: u32) {
        let i = sr::INTERRUPT as usize;
        let ext = EXTERN_LEVEL_LINES | NMI_LINE;
        self.sr[i] = (self.sr[i] & !ext) | (level & ext) | rising;
        // WAITI 唤醒：有使能的挂起中断，且其级别高于 PS.INTLEVEL
        let pend = self.sr[i] & self.sr[sr::INTENABLE as usize];
        let lvl = self.ps() & 0xf;
        if self.waiting && (0..32).any(|n| pend & (1 << n) != 0 && LINE_LEVEL[n] as u32 > lvl) {
            self.waiting = false;
        }
    }
}

impl Bus for SocBus {
    #[inline]
    fn load(&mut self, a: u32, size: u32) -> Result<u32, BusFault> {
        if let Some(v) = self.mem_read(a, size) {
            return Ok(v);
        }
        if (MMIO_LOW..MMIO_HIGH).contains(&a) {
            let v = self.mmio_read(a & !3);
            let sh = (a & 3) * 8;
            return Ok(match size {
                4 => v,
                2 => (v >> sh) & 0xffff,
                _ => (v >> sh) & 0xff,
            });
        }
        Err(BusFault)
    }

    #[inline]
    fn store(&mut self, a: u32, size: u32, v: u32) -> Result<(), BusFault> {
        if self.mem_write(a, size, v).is_some() {
            return Ok(());
        }
        if (MMIO_LOW..MMIO_HIGH).contains(&a) {
            let aa = a & !3;
            let v = if size == 4 {
                v
            } else {
                // 子字写：与外设当前值合并（UART FIFO 读有出队副作用，不参与）
                let sh = (a & 3) * 8;
                let mask = if size == 2 { 0xffff } else { 0xff } << sh;
                let old = if aa == 0x6000_0000 || aa == 0x6001_0000 {
                    0
                } else {
                    let before = self.unimpl.get(&aa).copied();
                    let v = self.mmio_read(aa);
                    match before {
                        Some(n) => {
                            self.unimpl.insert(aa, n);
                        }
                        None => {
                            self.unimpl.remove(&aa);
                        }
                    }
                    v
                };
                (old & !mask) | ((v << sh) & mask)
            };
            self.mmio_write(aa, v);
            return Ok(());
        }
        Err(BusFault)
    }

    #[inline]
    fn fetch(&mut self, a: u32) -> Result<u32, BusFault> {
        // 快路径：一次读 4 字节（指令最长 3 字节）；跨区域边界时退回逐字节
        if let Some(v) = self.mem_read(a, 4) {
            return Ok(v & 0xff_ffff);
        }
        let b0 = self.load(a, 1)?;
        let b1 = self.load(a.wrapping_add(1), 1)?;
        let b2 = self.load(a.wrapping_add(2), 1).unwrap_or(0);
        Ok(b0 | (b1 << 8) | (b2 << 16))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    Budget,
    /// 进入了 ROM 的异常向量（app 还没装自己的 VECBASE，或异常发生在 app 接管之前）
    Fault { cause: u32, epc: u32, vaddr: u32 },
    /// BREAK / BREAK.N
    Break(u32),
    /// 碰到没实现的 HLE 函数
    Hle(u32),
}

pub struct Esp32s3 {
    pub cpu: Cpu,
    pub bus: SocBus,
    pub rom_symbols: HashMap<u32, String>,
    pub hle: HashMap<u32, hle::Hle>,
}

impl Esp32s3 {
    pub fn run(&mut self, budget: u64) -> Stop {
        let end = self.cpu.cycles.saturating_add(budget);
        let cpu = &mut self.cpu;
        let bus = &mut self.bus;
        let hle = &self.hle;
        while cpu.cycles < end {
            bus.now = cpu.cycles;
            if bus.irq_dirty || cpu.cycles >= bus.next_event {
                bus.update(cpu);
            }
            match cpu.step(bus) {
                Exit::Normal => {
                    if shim::fixup_illegal(cpu, bus) {
                        continue;
                    }
                    // ROM 异常向量（0x40000300 Kernel / 0x40000340 User / 0x400003C0 Double）：
                    // app 正常运行时 VECBASE 指向 IRAM，落到这里说明出事了
                    let pc = cpu.pc;
                    if (0x4000_0300..0x4000_0400).contains(&pc) && cpu.read_sr(sr::VECBASE) == ROM_LOW {
                        return Stop::Fault {
                            cause: cpu.read_sr(sr::EXCCAUSE),
                            epc: cpu.read_sr(sr::EPC1),
                            vaddr: cpu.read_sr(sr::EXCVADDR),
                        };
                    }
                }
                Exit::Waiti => {
                    let target = bus.next_event.min(end);
                    if target > cpu.cycles {
                        cpu.cycles = target;
                    }
                }
                Exit::Hle(pc) => match hle.get(&pc) {
                    Some(k) => hle::call(*k, cpu, bus),
                    None => return Stop::Hle(pc),
                },
                Exit::Break(v) => return Stop::Break(v),
            }
        }
        Stop::Budget
    }

    /// 调试用：单步跑，记录 PC 不连续处（跳转目标）
    pub fn run_traced(&mut self, budget: u64, ring: &mut std::collections::VecDeque<u32>, cap: usize) -> Stop {
        let end = self.cpu.cycles.saturating_add(budget);
        let mut last = self.cpu.pc;
        while self.cpu.cycles < end {
            let before = self.cpu.cycles;
            let r = self.run(1);
            let pc = self.cpu.pc;
            let d = pc.wrapping_sub(last);
            if d != 2 && d != 3 {
                if ring.len() == cap {
                    ring.pop_front();
                }
                ring.push_back(pc);
            }
            last = pc;
            if r != Stop::Budget {
                return r;
            }
            if self.cpu.cycles == before {
                self.cpu.cycles += 1;
            }
        }
        Stop::Budget
    }

    pub fn console_take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.bus.console)
    }

    pub fn symbol_at(&self, pc: u32) -> Option<&str> {
        self.rom_symbols.get(&pc).map(|s| s.as_str())
    }
}
