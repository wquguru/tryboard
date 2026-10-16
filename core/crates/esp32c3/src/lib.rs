//! ESP32-C3 SoC：存储映射、外设分发、直接启动（替代二级 bootloader）、运行循环。

pub mod boot;
pub mod crypto_hw;
pub mod devices;
pub mod gdma;
pub mod gpspi;
pub mod hle;
pub mod ledc;
pub mod i2c;
pub mod iotrace;
pub mod periph;
pub mod pcnt;
pub mod rmt;
pub mod sigin;
pub mod spiflash;
pub mod wifi;

use devices::gc9a01::Gc9a01;
use gdma::{DmaMem, Gdma, GdmaLayout};
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

/// 取指缓存：直接映射，按 PC 索引，存译好的 32 位指令与长度（压缩指令已展开）。
/// 标签 1 表示无效（合法 PC 恒为偶数）。
const ICACHE_BITS: u32 = 15;
const ICACHE_MASK: usize = (1 << ICACHE_BITS) - 1;
const ICACHE_INVALID: u32 = 1;

/// 圆屏 GC9A01 在 C3 上的接线约定：SCLK / MOSI / CS 用 SPI2 的 IO_MUX 直连脚（soc/spi_pins.h），
/// DC / RST / 背光用 DevKitM-1 排针上空闲、又不是 strapping 的普通 GPIO（2、8、9 是 strapping，8 还接着板载 RGB）
pub mod lcd_pin {
    pub const SCLK: u32 = 6;
    pub const MOSI: u32 = 7;
    pub const CS: u32 = 10;
    pub const DC: u32 = 5;
    pub const RST: u32 = 4;
    pub const BL: u32 = 3;
}
/// GDMA 外设编号（soc/gdma_channel.h：SOC_GDMA_TRIG_PERIPH_SPI2）
const GDMA_PERI_SPI2: u32 = 0;
/// GPIO 矩阵输出信号 FSPICS0_OUT_IDX（gpio_sig_map.h）与 IO_MUX 功能号 FUNC_GPIO10_FSPICS0（io_mux_reg.h）
const SIG_FSPICS0: u32 = 68;
const IOMUX_FUNC_FSPICS0: u32 = 2;

pub const MMU_BASE: u32 = 0x600C_5000;
pub const MMU_ENTRIES: usize = 128;
pub const MMU_INVALID: u32 = 1 << 8;

pub struct SocBus {
    icache: Vec<(u32, u32, u32)>,
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
    pub i2c0: i2c::I2c,
    pub extmem: Extmem,
    pub analog: hle::Analog,
    pub ledc: ledc::Ledc,
    pub adc: Adc,
    pub rmt: rmt::Rmt,
    /// 挂在各引脚上的 WS2812 解码器（引脚被 GPIO 矩阵连到 RMT 输出时自动创建）
    pub ws2812: HashMap<u32, rmt::Ws2812>,
    /// 直接接在 GPIO 上、输出带时刻波形的外接器件（HC-SR04 等；C3 没有 PCNT，编码器只能靠 GPIO 中断读）
    pub pins: devices::pins::PinDevices,
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
    /// 固件请求复位（RTC_CNTL_OPTIONS0 的 SW_SYS_RST / SW_PROCPU_RST），值为下次上电的复位原因
    pub reset_request: Option<u32>,
    /// 本次上电的复位原因（RTC_CNTL_RESET_STATE 低 6 位）：1 上电、3 软件系统复位、12 软件 CPU 复位
    pub reset_reason: u32,
    pub wifi: wifi::WifiMac,
    pub sha: crypto_hw::ShaHw,
    pub aes: crypto_hw::AesHw,
    /// GP-SPI2 主机 + GDMA（3 通道）。GDMA 也给 AES / SHA 的 DMA 模式用
    pub spi2: gpspi::GpSpi,
    pub gdma: Gdma,
    /// 挂在 SPI2 上的圆屏（CLI `--spi gc9a01` / wasm `tb_lcd_attach`），引脚见 `lcd_pin`
    pub lcd: Option<Box<Gc9a01>>,
    /// 硬件随机数发生器（WDEV_RND_REG）状态：xorshift，固定种子保证可复现
    pub rng: u32,
    /// 调试：监视某个 MMIO 地址，记录访问时的 PC（watch_pc 由运行循环填写）
    pub watch: Option<(u32, u32)>,
    pub watch_pc: u32,
    /// （PC, 地址, 值, 是否写），按时间顺序
    pub watch_hits: Vec<(u32, u32, u32, bool)>,
    pub next_event: u64,
    /// GPIO 电平变化记录（周期, 电平），前端按此驱动 LED 等
    pub gpio_log: Vec<(u64, u32)>,
    last_gpio: u32,
    /// 逻辑分析仪事件（P1-05）
    pub iotrace: iotrace::IoTrace,
}

impl Default for SocBus {
    fn default() -> Self {
        SocBus {
            icache: vec![(ICACHE_INVALID, 0, 0); ICACHE_MASK + 1],
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
            i2c0: Default::default(),
            extmem: Extmem::default(),
            analog: Default::default(),
            ledc: Default::default(),
            adc: Adc::default(),
            rmt: rmt::Rmt::default(),
            ws2812: HashMap::new(),
            pins: Default::default(),
            efuse: boot::default_efuse(),
            from_cpu: 0,
            usj_tx: Vec::new(),
            console: Vec::new(),
            regs: HashMap::new(),
            unimpl: HashMap::new(),
            irq_dirty: true,
            reset_request: None,
            reset_reason: 1,
            wifi: Default::default(),
            sha: Default::default(),
            aes: Default::default(),
            spi2: Default::default(),
            gdma: Gdma::new(GdmaLayout::C3),
            lcd: None,
            rng: 0x2545_f491,
            watch: None,
            watch_pc: 0,
            watch_hits: Vec::new(),
            next_event: 0,
            gpio_log: Vec::new(),
            last_gpio: 0,
            iotrace: iotrace::IoTrace::new(0),
        }
    }
}

#[inline(always)]
fn rd(buf: &[u8], off: usize, size: u32) -> Option<u32> {
    match size {
        4 => buf
            .get(off..off + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        2 => buf
            .get(off..off + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]) as u32),
        _ => buf.get(off).map(|b| *b as u32),
    }
}

/// 定长写（避免 copy_from_slice 变长拷贝退化成 memmove 调用）
#[inline(always)]
fn wr(buf: &mut [u8], off: usize, size: u32, v: u32) -> Option<()> {
    match size {
        4 => buf.get_mut(off..off + 4)?.copy_from_slice(&v.to_le_bytes()),
        2 => buf.get_mut(off..off + 2)?.copy_from_slice(&(v as u16).to_le_bytes()),
        _ => *buf.get_mut(off)? = v as u8,
    }
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
            let ia = a + DRAM_TO_IRAM;
            self.icache_invalidate(ia);
            wr(&mut self.sram, (ia - IRAM_LOW) as usize, size, v)
        } else if (IRAM_LOW..IRAM_HIGH).contains(&a) {
            self.icache_invalidate(a);
            wr(&mut self.sram, (a - IRAM_LOW) as usize, size, v)
        } else if (RTC_LOW..RTC_HIGH).contains(&a) {
            self.icache_invalidate(a);
            wr(&mut self.rtc, (a - RTC_LOW) as usize, size, v)
        } else {
            None
        }
    }

    /// 写可执行内存：失效覆盖这个字的取指缓存项（指令最长 4 字节，可能从前一个半字开始）
    #[inline(always)]
    fn icache_invalidate(&mut self, a: u32) {
        let base = a & !1;
        for pc in [base.wrapping_sub(2), base, base + 2] {
            let e = &mut self.icache[((pc >> 1) as usize) & ICACHE_MASK];
            if e.0 == pc {
                e.0 = ICACHE_INVALID;
            }
        }
    }

    /// MMU 表或 flash 内容变了：整个取指缓存作废
    pub fn icache_flush(&mut self) {
        for e in self.icache.iter_mut() {
            e.0 = ICACHE_INVALID;
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
            0x6002_6000 if off == 0xb0 => {
                // WDEV_RND_REG：每次读都给新值（esp_random、lwIP 端口 / DNS 事务号都靠它）
                let mut x = self.rng;
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                self.rng = x;
                return x;
            }
            0x6001_9000 => return self.ledc.read(off),
            crypto_hw::SHA_BASE => return self.sha_read(off),
            crypto_hw::AES_BASE => return self.aes_read(off),
            0x6004_0000 => return self.adc.read(off),
            0x6000_9000 if (4..=0x58).contains(&off) => return self.gpio.iomux[((off - 4) / 4) as usize],
            0x6001_3000 => return self.i2c0.read(off),
            0x6002_4000 => return self.spi2.read(off),
            0x6003_F000 => return self.gdma.read(off),
            0x600C_4000 if off < 0x100 => return self.extmem.read(off),
            0x6001_F000 => return self.timg0.read(off, now),
            0x6002_0000 => return self.timg1.read(off, now),
            0x6002_3000 => return self.systimer.read(off, now),
            0x6001_6000 => return self.rmt.read(off),
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
            0x6000_8000 if off >= 0x800 => {
                return self
                    .efuse
                    .get(((off - 0x800) / 4) as usize)
                    .copied()
                    .unwrap_or(0)
            }
            0x6004_3000 => match off {
                0x04 => return 0x2, // EP1_CONF：IN 端点有空位
                0x08 => return 0x8, // INT_RAW：SERIAL_IN_EMPTY
                _ => {}
            },
            _ => {}
        }
        if (0x6003_3000..0x6003_6000).contains(&a) {
            if let Some(v) = self.wifi_read(a) {
                return v;
            }
        }
        if a == 0x6000_8038 {
            return self.reset_reason | (self.reset_reason << 6);
        }
        if let Some(v) = boot::special_read(a, now) {
            return v;
        }
        if let Some(v) = wifi::rf_read(a, self.regs.get(&a).copied().unwrap_or(0)) {
            return v;
        }
        *self.unimpl.entry(a).or_insert(0) += 1;
        self.regs.get(&a).copied().unwrap_or(0)
    }

    fn mmio_write(&mut self, a: u32, v: u32) {
        let now = self.now;
        let (base, off) = (a & !0xfff, a & 0xfff);
        self.irq_dirty = true;
        if a == 0x6000_8000 && v & (1 << 31 | 1 << 5) != 0 {
            self.reset_request = Some(if v & (1 << 31) != 0 { 3 } else { 12 });
        }
        match base {
            0x6000_0000 => {
                self.uart0.write(off, v);
                if off == 0 {
                    self.console.push(v as u8);
                }
                return;
            }
            0x6001_0000 => return self.uart1.write(off, v),
            0x6000_2000 => {
                let (e, p) = (self.spi1.erases, self.spi1.programs);
                self.spi1.write(off, v, &mut self.flash);
                if (e, p) != (self.spi1.erases, self.spi1.programs) {
                    self.icache_flush();
                }
                return;
            }
            0x6001_9000 => return self.ledc.write(off, v, now),
            crypto_hw::SHA_BASE => return self.sha_write(off, v),
            crypto_hw::AES_BASE => return self.aes_write(off, v),
            0x6004_0000 => return self.adc.write(off, v),
            0x6000_9000 if (4..=0x58).contains(&off) => {
                self.gpio.iomux[((off - 4) / 4) as usize] = v;
                self.gpio_changed(now);
                return;
            }
            0x6001_3000 => {
                self.i2c0.write(off, v, now);
                if !self.i2c0.events.is_empty() {
                    self.iotrace.extend(&mut self.i2c0.events);
                }
                return;
            }
            0x6002_4000 => {
                if self.spi2.write(off, v) {
                    self.spi2_transfer(now);
                }
                return;
            }
            0x6003_F000 => return self.gdma.write(off, v),
            0x600C_4000 if off < 0x100 => return self.extmem.write(off, v),
            0x6000_4000 => {
                self.gpio.write(off, v);
                // 使能（0x20..0x2c）和输出信号选择（FUNC_OUT_SEL 0x554 起）决定哪个引脚上有 PWM
                if (0x20..0x2c).contains(&off) || off >= 0x554 {
                    self.iotrace.pwm_dirty = true;
                }
                self.gpio_changed(now);
                return;
            }
            0x6001_F000 => return self.timg0.write(off, v, now),
            0x6002_0000 => return self.timg1.write(off, v, now),
            0x6002_3000 => return self.systimer.write(off, v, now),
            0x6001_6000 => return self.rmt.write(off, v, now),
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
                if self.mmu[(off / 4) as usize] != v & 0x1ff {
                    self.mmu[(off / 4) as usize] = v & 0x1ff;
                    self.icache_flush();
                }
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
        if (0x6003_3000..0x6003_6000).contains(&a) && self.wifi_write(a, v) {
            return;
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
        if let Some(l) = self.lcd.as_mut() {
            // RST 低有效，只在固件真的把脚驱动为低时复位（模组板上有上拉）；背光高电平亮
            let en = self.gpio.enable;
            l.set_reset(en >> lcd_pin::RST & 1 != 0 && lv >> lcd_pin::RST & 1 == 0);
            l.set_backlight(lv >> lcd_pin::BL & 1 != 0);
        }
        if lv != self.last_gpio {
            self.last_gpio = lv;
            self.iotrace.gpio(now, lv as u64);
            self.gpio_log.push((now, lv));
            if self.gpio_log.len() > 1 << 16 {
                self.gpio_log.drain(..1 << 15);
            }
            self.pins.on_level(now, lv as u64);
        }
        self.feed_rx(now, lv);
        self.irq_dirty = true;
    }

    /// RMT 接收通道的输入（GPIO 矩阵 FUNCn_IN_SEL_CFG：sel[4:0]、inv[5]、经矩阵[6]；0x1E 常 1、0x1F 常 0）
    fn feed_rx(&mut self, t: u64, lv: u32) {
        for i in 0..self.rmt.layout.nrx {
            let f = self.gpio.func_in[(rmt::SIG_OUT0 + i as u32) as usize];
            let v = f & (1 << 6) != 0
                && (match f & 0x1f {
                    0x1e => true,
                    0x1f => false,
                    p if p < 22 => lv >> p & 1 != 0,
                    _ => false,
                }) != (f & (1 << 5) != 0);
            self.rmt.rx_input(i, t, v);
        }
    }

    /// 外接引脚器件到 now 为止的驱动按时刻施加到引脚；返回下一次要问它们的时刻
    fn pins_update(&mut self, now: u64) -> u64 {
        if self.pins.is_empty() {
            return u64::MAX;
        }
        loop {
            let (drives, next) = self.pins.poll(now);
            if drives.is_empty() {
                return next;
            }
            for (t, pin, lv) in drives {
                let bit = 1u32 << pin;
                let g = &mut self.gpio;
                if lv < 0 {
                    g.ext_driven &= !bit;
                } else {
                    g.ext_driven |= bit;
                    if lv > 0 {
                        g.ext_in |= bit;
                    } else {
                        g.ext_in &= !bit;
                    }
                }
                self.gpio_changed(t);
            }
        }
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

    /// LEDC 或 GPIO 矩阵改过：把各引脚此刻的 PWM 交给事件记录（没变的引脚不记）
    fn trace_pwm(&mut self, now: u64) {
        if !self.iotrace.pwm_scan_needed(self.ledc.rev) {
            return;
        }
        self.iotrace.pwm_dirty = false;
        self.iotrace.ledc_rev = self.ledc.rev;
        for pin in 0..self.gpio.func_out.len() {
            let p = self.pin_pwm(pin);
            self.iotrace.pwm(now, pin, p);
        }
    }

    /// 所有中断源的当前电平（位 = 源编号）
    fn levels(&self) -> u64 {
        let mut l = 0u64;
        let mut set = |s: u32, on: bool| {
            if on {
                l |= 1 << s;
            }
        };
        set(src::WIFI_MAC, self.wifi.irq());
        set(src::UART0, self.uart0.irq());
        set(src::UART1, self.uart1.irq());
        set(src::GPIO, self.gpio.irq());
        set(src::LEDC, self.ledc.irq());
        set(src::RMT, self.rmt.irq());
        set(src::I2C_EXT0, self.i2c0.irq());
        set(src::SPI2, self.spi2.irq());
        for ch in 0..self.gdma.layout.nch as u32 {
            set(src::DMA_CH0 + ch, self.gdma.in_irq(ch as usize) || self.gdma.out_irq(ch as usize));
        }
        set(src::SYSTIMER_TARGET0, self.systimer.irq(0));
        set(src::SYSTIMER_TARGET0 + 1, self.systimer.irq(1));
        set(src::SYSTIMER_TARGET0 + 2, self.systimer.irq(2));
        set(
            src::TG0_T0,
            self.timg0.int_raw & self.timg0.int_ena & 1 != 0,
        );
        set(
            src::TG1_T0,
            self.timg1.int_raw & self.timg1.int_ena & 1 != 0,
        );
        for i in 0..4 {
            set(src::FROM_CPU0 + i, self.from_cpu & (1 << i) != 0);
        }
        l
    }

    /// 把 RMT 输出跳变经 GPIO 矩阵送到引脚：更新引脚电平、喂给挂在引脚上的 WS2812 解码器。
    /// 返回解码器下一次需要检查（帧结束判定）的时刻。
    fn route_rmt(&mut self, now: u64) -> u64 {
        let mut next = u64::MAX;
        let mut edges = std::mem::take(&mut self.rmt.edges);
        for pin in 0..self.gpio.func_out.len() as u32 {
            let sel = self.gpio.func_out[pin as usize] & 0xff;
            if !(rmt::SIG_OUT0..rmt::SIG_OUT0 + 2).contains(&sel) {
                continue;
            }
            let ch = (sel - rmt::SIG_OUT0) as u8;
            let dec = self.ws2812.entry(pin).or_default();
            let frames = dec.frames;
            for &(t, c, lv) in &edges {
                if c == ch {
                    dec.feed(t, lv);
                }
            }
            next = next.min(dec.finalize(now));
            if dec.frames != frames {
                self.iotrace.ws2812(now, pin, &dec.rgb);
            }
            self.gpio.set_periph_level(pin, self.rmt.level[ch as usize]);
        }
        if !edges.is_empty() {
            let lv = self.gpio.level();
            self.feed_rx(now, lv);
        }
        edges.clear();
        self.rmt.edges = edges;
        next
    }

    /// 推进定时器、重新裁决中断线。
    pub fn update(&mut self, cpu: &mut Cpu) {
        let now = self.now;
        let n1 = self.systimer.update(now);
        let n2 = self.timg0.update(now);
        let n3 = self.timg1.update(now);
        let n4 = self.ledc.update(now);
        let n5 = self.rmt.update(now);
        let n6 = self.route_rmt(now);
        let n7 = self.i2c0.update(now);
        let n8 = self.wifi_update(now);
        let n10 = self.pins_update(now);
        self.trace_pwm(now);
        let (n9, spi_done) = self.spi2.update(now);
        if spi_done {
            if let Some(ch) = self.spi2.dma_out_ch.take() {
                self.gdma.out_done(ch);
            }
        }
        self.next_event = n1.min(n2).min(n3).min(n4).min(n5).min(n6).min(n7).min(n8).min(n9).min(n10);
        let lv = self.levels();
        let pending = self.intc.pending(lv);
        cpu.irq_line = self.intc.select(pending);
        self.irq_dirty = false;
    }
}

impl SocBus {
    /// 在 SPI2 上接一块 GC9A01 圆屏（引脚见 `lcd_pin`）
    pub fn attach_lcd(&mut self) {
        self.lcd = Some(Box::default());
        let now = self.now;
        self.gpio_changed(now);
    }

    /// 圆屏的片选：CS 脚经 IO_MUX / GPIO 矩阵接到 SPI2 的 CS0 时由控制器在传输期间拉低；
    /// 否则当普通 GPIO 看，固件驱动为低才算选中
    fn lcd_selected(&self) -> bool {
        let pin = lcd_pin::CS as usize;
        let via_iomux = (self.gpio.iomux[pin] >> 12) & 7 == IOMUX_FUNC_FSPICS0;
        let via_matrix = self.gpio.func_out[pin] & 0xff == SIG_FSPICS0;
        if via_iomux || via_matrix {
            self.spi2.cs0_enabled()
        } else {
            self.gpio.enable >> pin & 1 != 0 && self.gpio.level() >> pin & 1 == 0
        }
    }

    /// 固件写了 SPI2 CMD.USR：取数据（W 寄存器或 GDMA 描述符链）、交给圆屏，再按 SPI 时钟计时。
    /// 与 S3 的同名函数逻辑相同（模型共用，只有引脚与信号号不同）
    fn spi2_transfer(&mut self, now: u64) {
        let p = self.spi2.plan();
        let mut bytes = p.head.clone();
        let mut out_ch = None;
        // 把 GDMA 临时取出来，借总线读写内存
        let mut g = std::mem::replace(&mut self.gdma, Gdma::placeholder());
        if p.mosi_bits > 0 {
            let n = p.mosi_bits.div_ceil(8) as usize;
            let mut data = if p.dma_tx {
                match g.out_channel_for(GDMA_PERI_SPI2) {
                    Some(ch) => {
                        out_ch = Some(ch);
                        g.take_out(ch, n, self)
                    }
                    None => Vec::new(),
                }
            } else {
                self.spi2.tx_buffer(n)
            };
            // DMA 给的数据不够：移位寄存器里是 0
            data.resize(n, 0);
            bytes.extend_from_slice(&data);
        }
        if p.miso_bits > 0 {
            // 没有会应答的从机，MISO 上拉读到全 1
            let rx = vec![0xffu8; p.miso_bits.div_ceil(8) as usize];
            if p.dma_rx {
                if let Some(ch) = g.in_channel_for(GDMA_PERI_SPI2) {
                    g.put_in(ch, &rx, self);
                }
            } else {
                self.spi2.rx_fill(&rx);
            }
        }
        self.gdma = g;
        let selected = self.lcd_selected();
        let dc = self.gpio.level() >> lcd_pin::DC & 1 != 0;
        if let (Some(l), true) = (self.lcd.as_mut(), selected) {
            for b in bytes {
                l.byte(dc, b);
            }
        }
        self.spi2.begin(now, &p, out_ch);
    }
}

impl DmaMem for SocBus {
    fn rd8(&mut self, a: u32) -> u8 {
        self.mem_read(a, 1).unwrap_or(0) as u8
    }
    fn rd32(&mut self, a: u32) -> u32 {
        self.mem_read(a, 4).unwrap_or(0)
    }
    fn wr32(&mut self, a: u32, v: u32) {
        self.mem_write(a, 4, v);
    }
}

impl Bus for SocBus {
    #[inline(always)]
    fn fetch_decoded(&mut self, addr: u32) -> Result<(u32, u32), BusFault> {
        let idx = ((addr >> 1) as usize) & ICACHE_MASK;
        let e = self.icache[idx];
        if e.0 == addr {
            return Ok((e.1, e.2));
        }
        let lo = self.mem_read(addr, 2).ok_or(BusFault)?;
        let raw = if lo & 3 != 3 { lo } else { lo | (self.mem_read(addr + 2, 2).ok_or(BusFault)? << 16) };
        let (insn, len) = tryboard_rv32::decode_raw(raw);
        self.icache[idx] = (addr, insn, len);
        Ok((insn, len))
    }

    #[inline]
    fn load(&mut self, a: u32, size: u32) -> Result<u32, BusFault> {
        if let Some(v) = self.mem_read(a, size) {
            return Ok(v);
        }
        if (MMIO_LOW..MMIO_HIGH).contains(&a) {
            let v = self.mmio_read(a & !3);
            if let Some((lo, hi)) = self.watch {
                if (lo..hi).contains(&a) && self.watch_hits.len() < 400_000 {
                    self.watch_hits.push((self.watch_pc, a & !3, v, false));
                }
            }
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
                // 子字写（编译器对位域常用 sb/sh）：先读外设当前值再合并。
                // UART FIFO 读有出队副作用，不能拿来做读-改-写
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
            if let Some((lo, hi)) = self.watch {
                if (lo..hi).contains(&aa) && self.watch_hits.len() < 400_000 {
                    self.watch_hits.push((self.watch_pc, aa, v, true));
                }
            }
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
    /// 固件请求复位（esp_restart、看门狗、panic 后重启）；调用 reboot() 重新上电
    Reset(u32),
}

pub struct Esp32c3 {
    pub cpu: Cpu,
    pub bus: SocBus,
    pub rom_symbols: HashMap<u32, String>,
    pub hle: HashMap<u32, hle::Hle>,
    /// 留一份 ROM，复位重新上电时用
    pub rom_elf: Vec<u8>,
}

impl Esp32c3 {
    pub fn run(&mut self, budget: u64) -> Stop {
        let end = self.cpu.cycles.saturating_add(budget);
        let cpu = &mut self.cpu;
        let bus = &mut self.bus;
        let hle = &self.hle;
        while cpu.cycles < end {
            bus.now = cpu.cycles;
            bus.watch_pc = cpu.pc;
            if bus.irq_dirty || cpu.cycles >= bus.next_event {
                bus.update(cpu);
            }
            if let Some(r) = bus.reset_request.take() {
                return Stop::Reset(r);
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
    pub fn run_traced(
        &mut self,
        budget: u64,
        ring: &mut std::collections::VecDeque<u32>,
        cap: usize,
    ) -> Stop {
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

    /// 复位后重新上电：flash 内容（含 NVS）保留，RAM 与外设清零，CPU 周期继续累计
    pub fn reboot(&mut self, reason: u32) -> Result<(), String> {
        let flash = std::mem::take(&mut self.bus.flash);
        let (mut m, _) = Esp32c3::boot(&self.rom_elf, flash)?;
        m.bus.reset_reason = reason;
        m.bus.gpio.ext_in = self.bus.gpio.ext_in;
        m.bus.gpio.ext_driven = self.bus.gpio.ext_driven;
        m.bus.adc.pin_mv = self.bus.adc.pin_mv;
        // 外接器件、引脚记录、灯带解码是外部世界的一部分，复位后还在（与 S3 的 reboot 一致）
        m.bus.i2c0.devices = std::mem::take(&mut self.bus.i2c0.devices);
        m.bus.ws2812 = std::mem::take(&mut self.bus.ws2812);
        m.bus.pins = std::mem::take(&mut self.bus.pins);
        m.bus.gpio_log = std::mem::take(&mut self.bus.gpio_log);
        m.bus.iotrace = self.bus.iotrace.carry();
        // 外接屏不随芯片复位消失（它的复位脚由固件重新驱动）
        m.bus.lcd = self.bus.lcd.take();
        let t = self.cpu.cycles;
        m.cpu.cycles = t;
        m.bus.now = t;
        m.bus.next_event = 0;
        *self = m;
        Ok(())
    }

    pub fn console_take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.bus.console)
    }

    pub fn symbol_at(&self, pc: u32) -> Option<&str> {
        self.rom_symbols.get(&pc).map(|s| s.as_str())
    }
}
