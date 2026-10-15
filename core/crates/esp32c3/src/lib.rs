//! ESP32-C3 SoC：存储映射、外设分发、直接启动（替代二级 bootloader）、运行循环。

pub mod boot;
pub mod hle;
pub mod ledc;
pub mod periph;
pub mod spiflash;

use periph::*;
use std::collections::HashMap;
use tryboard_rv32::{Bus, BusFault, Cpu, Exit};

// 存储映射（soc/esp32c3/include/soc/soc.h）
pub const IRAM_LOW: u32 = 0x4037_C000;
pub const IRAM_HIGH: u32 = 0x403E_0000;
pub const DRAM_LOW: u32 = 0x3FC8_0000;
pub const DRAM_HIGH: u32 = 0x3FCE_0000;
/// DRAM 0x3FC80000 与 IRAM 0x40380000 是同一块 SRAM1
pub const DRAM_TO_IRAM: u32 = 0x4038_0000 - DRAM_LOW;
pub const ROM_LOW: u32 = 0x4000_0000;
pub const ROM_HIGH: u32 = 0x4006_0000;
pub const DROM_MASK_LOW: u32 = 0x3FF0_0000;
pub const DROM_MASK_HIGH: u32 = 0x3FF2_0000;
/// DROM 掩膜窗口对应 ROM 物理 0x40040000 起
pub const DROM_MASK_TO_ROM: u32 = 0x4004_0000 - DROM_MASK_LOW;
pub const IROM_LOW: u32 = 0x4200_0000;
pub const IROM_HIGH: u32 = 0x4280_0000;
pub const DROM_LOW: u32 = 0x3C00_0000;
pub const DROM_HIGH: u32 = 0x3C80_0000;
pub const RTC_LOW: u32 = 0x5000_0000;
pub const RTC_HIGH: u32 = 0x5000_2000;
pub const MMIO_LOW: u32 = 0x6000_0000;
pub const MMIO_HIGH: u32 = 0x600D_1000;

pub const MMU_BASE: u32 = 0x600C_5000;
pub const MMU_ENTRIES: usize = 128;
pub const MMU_INVALID: u32 = 1 << 8;

pub struct SocBus {
    pub sram: Vec<u8>,
    pub rtc: Vec<u8>,
    pub rom: Vec<u8>,
    pub flash: Vec<u8>,
    pub mmu: [u32; MMU_ENTRIES],
    pub now: u64,
    pub uart0: Uart,
    pub uart1: Uart,
    pub systimer: Systimer,
    pub timg0: Timg,
    pub timg1: Timg,
    pub intc: Intc,
    pub gpio: Gpio,
    pub spi1: spiflash::SpiFlash,
    pub extmem: Extmem,
    pub analog: hle::Analog,
    pub ledc: ledc::Ledc,
    pub efuse: [u32; 0x200 / 4],
    /// SYSTEM_CPU_INTR_FROM_CPU_0..3
    pub from_cpu: u32,
    pub usj_tx: Vec<u8>,
    /// 合并后的控制台输出（UART0 + USB-Serial-JTAG），供前端 / CLI 读取
    pub console: Vec<u8>,
    /// 没有模型的寄存器：写入值保存、读回
    pub regs: HashMap<u32, u32>,
    /// 访问了没有模型的寄存器：地址 → 次数
    pub unimpl: HashMap<u32, u64>,
    pub irq_dirty: bool,
    pub next_event: u64,
    /// GPIO 电平变化记录（周期, 电平），前端按此驱动 LED 等
    pub gpio_log: Vec<(u64, u32)>,
    last_gpio: u32,
}

impl Default for SocBus {
    fn default() -> Self {
        SocBus {
            sram: vec![0; (IRAM_HIGH - IRAM_LOW) as usize],
            rtc: vec![0; (RTC_HIGH - RTC_LOW) as usize],
            rom: vec![0; (ROM_HIGH - ROM_LOW) as usize],
            flash: Vec::new(),
            mmu: [MMU_INVALID; MMU_ENTRIES],
            now: 0,
            uart0: Uart::default(),
            uart1: Uart::default(),
            systimer: Systimer::default(),
            timg0: Timg::default(),
            timg1: Timg::default(),
            intc: Intc::default(),
            gpio: Gpio::default(),
            spi1: Default::default(),
            extmem: Extmem::default(),
            analog: Default::default(),
            ledc: Default::default(),
            efuse: boot::default_efuse(),
            from_cpu: 0,
            usj_tx: Vec::new(),
            console: Vec::new(),
            regs: HashMap::new(),
            unimpl: HashMap::new(),
            irq_dirty: true,
            next_event: 0,
            gpio_log: Vec::new(),
            last_gpio: 0,
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

impl SocBus {
    /// cache 映射：虚拟地址 → flash 偏移
    #[inline]
    pub fn flash_addr(&self, vaddr: u32) -> Option<usize> {
        let lin = vaddr & 0x7F_FFFF;
        let e = self.mmu[(lin >> 16) as usize];
        if e & MMU_INVALID != 0 {
            return None;
        }
        Some((((e & 0xff) << 16) | (lin & 0xffff)) as usize)
    }

    /// 物理存储（非 MMIO）读，调试器 / HLE 也用
    pub fn mem_read(&self, a: u32, size: u32) -> Option<u32> {
        if (DRAM_LOW..DRAM_HIGH).contains(&a) {
            rd(&self.sram, (a + DRAM_TO_IRAM - IRAM_LOW) as usize, size)
        } else if (IRAM_LOW..IRAM_HIGH).contains(&a) {
            rd(&self.sram, (a - IRAM_LOW) as usize, size)
        } else if (IROM_LOW..IROM_HIGH).contains(&a) || (DROM_LOW..DROM_HIGH).contains(&a) {
            let f = self.flash_addr(a)?;
            Some(rd(&self.flash, f, size).unwrap_or(0xffff_ffff))
        } else if (ROM_LOW..ROM_HIGH).contains(&a) {
            rd(&self.rom, (a - ROM_LOW) as usize, size)
        } else if (DROM_MASK_LOW..DROM_MASK_HIGH).contains(&a) {
            rd(&self.rom, (a + DROM_MASK_TO_ROM - ROM_LOW) as usize, size)
        } else if (RTC_LOW..RTC_HIGH).contains(&a) {
            rd(&self.rtc, (a - RTC_LOW) as usize, size)
        } else {
            None
        }
    }

    pub fn mem_write(&mut self, a: u32, size: u32, v: u32) -> Option<()> {
        if (DRAM_LOW..DRAM_HIGH).contains(&a) {
            wr(&mut self.sram, (a + DRAM_TO_IRAM - IRAM_LOW) as usize, size, v)
        } else if (IRAM_LOW..IRAM_HIGH).contains(&a) {
            wr(&mut self.sram, (a - IRAM_LOW) as usize, size, v)
        } else if (RTC_LOW..RTC_HIGH).contains(&a) {
            wr(&mut self.rtc, (a - RTC_LOW) as usize, size, v)
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
            0x6000_4000 => return self.gpio.read(off),
            0x6000_2000 => return self.spi1.read(off),
            0x6001_9000 => return self.ledc.read(off),
            0x6000_9000 if (4..=0x58).contains(&off) => return self.gpio.iomux[((off - 4) / 4) as usize],
            0x600C_4000 if off < 0x100 => return self.extmem.read(off),
            0x6001_F000 => return self.timg0.read(off, now),
            0x6002_0000 => return self.timg1.read(off, now),
            0x6002_3000 => return self.systimer.read(off, now),
            0x600C_2000 => {
                if off == 0x110 {
                    let lv = self.levels();
                    return self.intc.pending(lv);
                }
                if let Some(v) = self.intc.read(off) {
                    return v;
                }
            }
            0x600C_5000 if (off as usize) < MMU_ENTRIES * 4 => return self.mmu[(off / 4) as usize],
            0x6000_8000 if off >= 0x800 => return self.efuse.get(((off - 0x800) / 4) as usize).copied().unwrap_or(0),
            0x6004_3000 => match off {
                0x04 => return 0x2, // EP1_CONF：IN 端点有空位
                0x08 => return 0x8, // INT_RAW：SERIAL_IN_EMPTY
                _ => {}
            },
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
            0x6001_9000 => return self.ledc.write(off, v, now),
            0x6000_9000 if (4..=0x58).contains(&off) => {
                self.gpio.iomux[((off - 4) / 4) as usize] = v;
                self.gpio_changed(now);
                return;
            }
            0x600C_4000 if off < 0x100 => return self.extmem.write(off, v),
            0x6000_4000 => {
                self.gpio.write(off, v);
                self.gpio_changed(now);
                return;
            }
            0x6001_F000 => return self.timg0.write(off, v, now),
            0x6002_0000 => return self.timg1.write(off, v, now),
            0x6002_3000 => return self.systimer.write(off, v, now),
            0x600C_2000 => {
                if self.intc.write(off, v) {
                    return;
                }
            }
            0x600C_0000 if (0x28..=0x34).contains(&off) => {
                let bit = (off - 0x28) / 4;
                if v & 1 != 0 {
                    self.from_cpu |= 1 << bit;
                } else {
                    self.from_cpu &= !(1 << bit);
                }
                return;
            }
            0x600C_5000 if (off as usize) < MMU_ENTRIES * 4 => {
                self.mmu[(off / 4) as usize] = v & 0x1ff;
                return;
            }
            0x6004_3000 if off == 0 => {
                // USB-Serial-JTAG 是 IDF 默认的第二控制台，内容与 UART0 重复；单独存，不进主控制台
                self.usj_tx.push(v as u8);
                if self.usj_tx.len() > 1 << 16 {
                    self.usj_tx.drain(..1 << 15);
                }
                return;
            }
            _ => {}
        }
        if !boot::special_write(a, v) {
            *self.unimpl.entry(a).or_insert(0) += 1;
        }
        self.regs.insert(a, v);
    }

    /// 引脚电平可能变了：做边沿检测、记日志
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

    /// 引脚上的 PWM：经 GPIO 矩阵路由到该引脚的 LEDC 通道输出（占空比, 频率）
    pub fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)> {
        let sig = self.gpio.func_out.get(pin)? & 0xff;
        if (45..=50).contains(&sig) && self.gpio.enable & (1 << pin) != 0 {
            let (d, f) = self.ledc.output((sig - 45) as usize)?;
            let inv = self.gpio.func_out[pin] & (1 << 8) != 0;
            return Some((if inv { 1.0 - d } else { d }, f));
        }
        None
    }

    /// 所有中断源的当前电平（位 = 源编号）
    fn levels(&self) -> u64 {
        let mut l = 0u64;
        let mut set = |s: u32, on: bool| {
            if on {
                l |= 1 << s;
            }
        };
        set(src::UART0, self.uart0.irq());
        set(src::UART1, self.uart1.irq());
        set(src::GPIO, self.gpio.irq());
        set(src::LEDC, self.ledc.irq());
        set(src::SYSTIMER_TARGET0, self.systimer.irq(0));
        set(src::SYSTIMER_TARGET0 + 1, self.systimer.irq(1));
        set(src::SYSTIMER_TARGET0 + 2, self.systimer.irq(2));
        set(src::TG0_T0, self.timg0.int_raw & self.timg0.int_ena & 1 != 0);
        set(src::TG1_T0, self.timg1.int_raw & self.timg1.int_ena & 1 != 0);
        for i in 0..4 {
            set(src::FROM_CPU0 + i, self.from_cpu & (1 << i) != 0);
        }
        l
    }

    /// 推进定时器、重新裁决中断线。
    pub fn update(&mut self, cpu: &mut Cpu) {
        let now = self.now;
        let n1 = self.systimer.update(now);
        let n2 = self.timg0.update(now);
        let n3 = self.timg1.update(now);
        let n4 = self.ledc.update(now);
        self.next_event = n1.min(n2).min(n3).min(n4);
        let lv = self.levels();
        let pending = self.intc.pending(lv);
        cpu.irq_line = self.intc.select(pending);
        self.irq_dirty = false;
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
                // 子字写：读-改-写（只对没有副作用的寄存器有意义）
                let sh = (a & 3) * 8;
                let mask = if size == 2 { 0xffff } else { 0xff } << sh;
                let old = self.regs.get(&aa).copied().unwrap_or(0);
                (old & !mask) | ((v << sh) & mask)
            };
            self.mmio_write(aa, v);
            return Ok(());
        }
        // 写 ROM / flash 映射区：真机上是总线错误，这里同样报错
        Err(BusFault)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// 跑满了要求的周期数
    Budget,
    /// 固件崩溃（mtvec 未设置时的异常）
    Fault { cause: u32, pc: u32, tval: u32 },
    /// 碰到没实现的 HLE 函数
    Hle(u32),
}

pub struct Esp32c3 {
    pub cpu: Cpu,
    pub bus: SocBus,
    pub rom_symbols: HashMap<u32, String>,
    pub hle: HashMap<u32, hle::Hle>,
}

impl Esp32c3 {
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
                Exit::Normal => {}
                Exit::Wfi => {
                    // 空闲：直接快进到下一个定时器事件
                    let target = bus.next_event.min(end);
                    if target > cpu.cycles {
                        cpu.cycles = target;
                    }
                }
                Exit::Hle(pc) => match hle.get(&pc) {
                    Some(k) => hle::call(*k, cpu, bus),
                    None => return Stop::Hle(pc),
                },
                Exit::DoubleFault { cause, pc, tval } => return Stop::Fault { cause, pc, tval },
            }
        }
        Stop::Budget
    }

    /// 调试用：单步跑，记录最近的跳转目标（PC 不连续处），用于定位卡死 / 崩溃。
    pub fn run_traced(&mut self, budget: u64, ring: &mut std::collections::VecDeque<u32>, cap: usize) -> Stop {
        let end = self.cpu.cycles.saturating_add(budget);
        let mut last = self.cpu.pc;
        while self.cpu.cycles < end {
            let before = self.cpu.cycles;
            let r = self.run(1);
            let pc = self.cpu.pc;
            if pc != last.wrapping_add(2) && pc != last.wrapping_add(4) {
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
