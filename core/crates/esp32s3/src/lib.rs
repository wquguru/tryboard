//! ESP32-S3 SoC：存储映射（含 PSRAM）、外设分发、直接启动、双核运行循环。
//! 核 1 在固件调用 ROM 的 ets_set_appcpu_boot_addr 时启动（HLE），两核按固定量子交替执行（确定性）。
//!
//! 与 C3 同族、寄存器布局一致的外设（UART、SYSTIMER、TIMG、SPI1 flash、LEDC、I2C、RMT、GP-SPI2、GDMA）复用 tryboard-esp32c3 的模型；
//! S3 特有的中断矩阵、EXTMEM、49 脚 GPIO 在 periph.rs。

pub mod boot;
pub mod hle;
pub mod periph;
pub mod psram;
pub mod usb;

use periph::*;
use std::collections::HashMap;
use tryboard_esp32c3::devices::audio::{self, Audio, PortIo};
use tryboard_esp32c3::devices::gc9a01::Gc9a01;
use tryboard_esp32c3::gdma::{DmaMem, Gdma, GdmaLayout};
use tryboard_esp32c3::gpspi::GpSpi;
use tryboard_esp32c3::i2c::I2c;
use tryboard_esp32c3::i2s::I2s;
use tryboard_esp32c3::iotrace::IoTrace;
use tryboard_esp32c3::ledc::Ledc;
use tryboard_esp32c3::periph::{Systimer, Timg, Uart};
use tryboard_esp32c3::rmt::{Rmt, RmtLayout, Ws2812};
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

/// RTC_CNTL_OPTIONS0 的软件复位位（rtc_cntl_reg.h）：系统复位、核 0 复位、核 1 复位
const RST_SYS: u32 = 1 << 31;
const RST_PROCPU: u32 = 1 << 5;
const RST_APPCPU: u32 = 1 << 4;
pub const RTC_CNTL_RESET_STATE: u32 = 0x6000_8038;
/// RTC_CNTL_STORE0..7：在 RTC 域，CPU / 系统复位后保持（复位原因提示、启动时间、RTC 慢时钟校准值等）。
/// STORE4 / STORE5（晶振 / APB 频率）由 ROM 每次启动重写，不必保留
const RTC_STORE_KEEP: [u32; 6] = [
    0x6000_8050,
    0x6000_8054,
    0x6000_8058,
    0x6000_805C,
    0x6000_80C8,
    0x6000_80CC,
];
/// 圆屏 GC9A01 的接线约定（SPI2 的 IO_MUX 直连脚 + 三根 GPIO）
pub mod lcd_pin {
    pub const SCLK: u32 = 12;
    pub const MOSI: u32 = 11;
    pub const CS: u32 = 10;
    pub const DC: u32 = 14;
    pub const RST: u32 = 13;
    pub const BL: u32 = 15;
}
/// GDMA 的外设编号（soc/gdma_channel.h：SOC_GDMA_TRIG_PERIPH_SPI2 / _I2S0 / _I2S1）
const GDMA_PERI_SPI2: u32 = 0;
const GDMA_PERI_I2S: [u32; 2] = [3, 4];
/// GPIO 矩阵信号（gpio_sig_map.h）：I2S0O_SD_OUT_IDX = I2S0I_SD_IN_IDX = 25，I2S1 为 30
const SIG_I2S_SD: [usize; 2] = [25, 30];
/// I2S 音频器件的接线约定：喇叭（MAX98357A）用 16/17/18，麦克风（INMP441）用 39/40/41——
/// 避开圆屏（10..15）、I2C（8/9）、舵机 / LED（4/5）、WS2812（48）、USB（19/20）和八线 PSRAM（33..37）
pub mod i2s_pin {
    pub const SPK_BCLK: u32 = 16;
    pub const SPK_LRC: u32 = 17;
    pub const SPK_DIN: u32 = 18;
    pub const MIC_SCK: u32 = 39;
    pub const MIC_WS: u32 = 40;
    pub const MIC_SD: u32 = 41;
}
/// GPIO 矩阵输出信号 FSPICS0_OUT_IDX（gpio_sig_map.h）与 IO_MUX 功能号 FUNC_GPIO10_FSPICS0
const SIG_FSPICS0: u32 = 110;
const IOMUX_FUNC_FSPICS0: u32 = 4;

pub struct SocBus {
    pub sram: Vec<u8>,
    pub rtc_slow: Vec<u8>,
    pub rtc_fast: Vec<u8>,
    pub rom: Vec<u8>,
    pub flash: Vec<u8>,
    pub psram: Vec<u8>,
    /// PSRAM 芯片的命令接口（模式寄存器）；存储体是 `psram`
    pub psram_chip: psram::OctalPsram,
    pub mmu: Vec<u32>,
    pub now: u64,
    pub uart0: Uart,
    pub uart1: Uart,
    pub systimer: Systimer,
    pub timg0: Timg,
    pub timg1: Timg,
    pub intm: Intmatrix,
    /// 核 1 的中断矩阵（INTERRUPT_CORE1_*，在核 0 那张表之后 0x800）
    pub intm1: Intmatrix,
    /// 每个核当前的外部中断线（update 时算出，轮到该核执行前交给它）
    pub lines: [u32; 2],
    /// 固件请求启动核 1 的入口（ets_set_appcpu_boot_addr，HLE 里设置）
    pub appcpu_boot: Option<u32>,
    pub gpio: Gpio,
    pub spi1: SpiFlash,
    pub extmem: Extmem,
    pub ledc: Ledc,
    pub analog: Analog,
    /// 原生 USB OTG（Option 只为在推进时临时拿出来，让控制器 DMA 能借用总线访问内存；平时恒为 Some）
    pub usb: Option<Box<usb::Usb>>,
    /// RMT（4 发送 + 4 接收）与挂在引脚上的 WS2812 解码器
    pub rmt: Rmt,
    pub ws2812: HashMap<u32, Ws2812>,
    /// I2C0（0x60013000）/ I2C1（0x60027000），模型与 C3 相同
    pub i2c0: I2c,
    pub i2c1: I2c,
    /// GP-SPI2 主机 + GDMA（5 通道），模型与 C3 同族共用
    pub spi2: GpSpi,
    pub gdma: Gdma,
    /// 挂在 SPI2 上的圆屏（CLI `--spi gc9a01` / wasm `tb_lcd_attach`）
    pub lcd: Option<Box<Gc9a01>>,
    /// I2S0（0x6000F000）/ I2S1（0x6002D000），模型与 C3 相同；挂在上面的音频器件（引脚见 `i2s_pin`）
    pub i2s: [I2s; 2],
    pub audio: Audio,
    /// SAR ADC 单次采样（SENS）
    pub adc: SensAdc,
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
    /// 逻辑分析仪事件（P1-05，模型与格式见 tryboard_esp32c3::iotrace）
    pub iotrace: IoTrace,
    /// 固件请求复位（RTC_CNTL_OPTIONS0 的 SW_SYS_RST / SW_PROCPU_RST），值为下次上电的复位原因
    pub reset_request: Option<u32>,
    /// 固件单独复位了核 1（SW_APPCPU_RST）：esp_restart 先复位并停住另一个核
    pub appcpu_reset: bool,
    /// 本次上电的复位原因（RTC_CNTL_RESET_STATE 每核 6 位）：1 上电、3 软件系统复位、12 软件 CPU 复位
    pub reset_reason: u32,
}

impl Default for SocBus {
    fn default() -> Self {
        // GD25Q128：16MB
        let spi1 = SpiFlash {
            jedec: 0x18_40_c8,
            ..Default::default()
        };
        SocBus {
            sram: vec![0; SRAM_SIZE],
            rtc_slow: vec![0; (RTC_SLOW_HIGH - RTC_SLOW_LOW) as usize],
            rtc_fast: vec![0; (RTC_FAST_HIGH - RTC_FAST_LOW) as usize],
            rom: vec![0; (ROM_HIGH - ROM_LOW) as usize],
            flash: Vec::new(),
            psram: vec![0; PSRAM_SIZE],
            psram_chip: psram::OctalPsram::default(),
            mmu: vec![MMU_INVALID; MMU_ENTRIES],
            now: 0,
            uart0: Uart::default(),
            uart1: Uart::default(),
            systimer: Systimer::default(),
            timg0: Timg::default(),
            timg1: Timg::default(),
            intm: Intmatrix::default(),
            intm1: Intmatrix::default(),
            lines: [0; 2],
            appcpu_boot: None,
            gpio: Gpio::default(),
            spi1,
            extmem: Extmem::default(),
            ledc: Ledc::default(),
            analog: Analog::default(),
            usb: Some(Box::default()),
            rmt: Rmt::new(RmtLayout::S3),
            ws2812: HashMap::new(),
            i2c0: I2c::default(),
            i2c1: I2c::with_port(tryboard_esp32c3::iotrace::i2cbit::PORT1),
            spi2: GpSpi::default(),
            gdma: Gdma::new(GdmaLayout::S3),
            lcd: None,
            i2s: [I2s::new(0, true), I2s::new(1, true)],
            audio: Audio::default(),
            adc: SensAdc::default(),
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
            iotrace: IoTrace::new(1),
            reset_request: None,
            appcpu_reset: false,
            reset_reason: 1,
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
        Some(if e & MMU_PSRAM != 0 {
            Ext::Psram(pa)
        } else {
            Ext::Flash(pa)
        })
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
        if usb::Usb::contains(a) {
            return self.usb.as_mut().map(|u| u.read(a)).unwrap_or(0);
        }
        let (base, off) = (a & !0xfff, a & 0xfff);
        match base {
            0x6000_0000 => return self.uart0.read(off),
            0x6001_0000 => return self.uart1.read(off),
            0x6000_2000 => return self.spi1.read(off),
            0x6000_4000 => return self.gpio.read(off),
            0x6000_7000 if off < 0x200 => return self.efuse[(off / 4) as usize],
            0x6000_9000 if (4..=0xc4).contains(&off) => {
                return self.gpio.iomux[((off - 4) / 4) as usize]
            }
            0x6001_9000 => return self.ledc.read(off),
            0x6001_6000 => return self.rmt.read(off),
            0x6001_3000 => return self.i2c0.read(off),
            0x6002_7000 => return self.i2c1.read(off),
            0x6002_4000 => return self.spi2.read(off),
            0x6003_F000 => return self.gdma.read(off),
            0x6000_F000 => return self.i2s[0].read(off),
            0x6002_D000 => return self.i2s[1].read(off),
            0x6000_8000 if off >= 0x800 => {
                if let Some(v) = self.adc.read(off - 0x800) {
                    return v;
                }
            }
            0x6001_F000 => return self.timg0.read(off, now),
            0x6002_0000 => return self.timg1.read(off, now),
            0x6002_3000 => return self.systimer.read(off, now),
            0x6003_8000 => match off {
                0x04 => return 0x2, // EP1_CONF：IN 端点有空位
                0x08 => return 0x8, // INT_RAW：SERIAL_IN_EMPTY
                _ => {}
            },
            // I2C_MST_ANA_CONF0（regi2c_defs.h）：BBPLL 校准完成位（bit 24）——PLL 校准瞬间完成
            0x6000_E000 if off == 0x40 => {
                return self.regs.get(&a).copied().unwrap_or(0) | (1 << 24)
            }
            0x600C_2000 => {
                let lv = self.levels();
                let r = if off >= 0x800 {
                    self.intm1.read(off - 0x800, &lv)
                } else {
                    self.intm.read(off, &lv)
                };
                if let Some(v) = r {
                    return v;
                }
            }
            0x600C_4000 if off < 0x400 => return self.extmem.read(off),
            0x600C_5000 if (off as usize) < MMU_ENTRIES * 4 => return self.mmu[(off / 4) as usize],
            _ => {}
        }
        if a == RTC_CNTL_RESET_STATE {
            return self.reset_reason | (self.reset_reason << 6);
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
        if usb::Usb::contains(a) {
            if let Some(u) = self.usb.as_mut() {
                u.write(a, v);
                u.kick(now);
            }
            return;
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
            // SPI1 用户命令：片选 CS1 时发给 PSRAM，否则发给 flash
            0x6000_2000
                if off == 0
                    && v & (1 << 18) != 0
                    && psram::OctalPsram::selected(&self.spi1.regs) =>
            {
                return self
                    .psram_chip
                    .user_transaction(&mut self.spi1.regs, &mut self.psram);
            }
            0x6000_2000 => return self.spi1.write(off, v, &mut self.flash),
            // 复位位是脉冲（硬件自清零）：只记请求，存回去的值去掉它们，免得后续读改写再触发
            0x6000_8000 if off == 0 => {
                if v & (RST_SYS | RST_PROCPU) != 0 {
                    self.reset_request = Some(if v & RST_SYS != 0 { 3 } else { 12 });
                } else if v & RST_APPCPU != 0 {
                    self.appcpu_reset = true;
                }
                self.regs
                    .insert(a, v & !(RST_SYS | RST_PROCPU | RST_APPCPU));
                return;
            }
            0x6000_4000 => {
                self.gpio.write(off, v);
                // 使能（0x20..0x38，含 GPIO32 以上）和输出信号选择（FUNC_OUT_SEL 0x554 起）决定哪个引脚上有 PWM
                if (0x20..0x38).contains(&off) || off >= 0x554 {
                    self.iotrace.pwm_dirty = true;
                }
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
            0x6001_6000 => return self.rmt.write(off, v, now),
            0x6001_3000 | 0x6002_7000 => {
                let bus = if base == 0x6001_3000 {
                    &mut self.i2c0
                } else {
                    &mut self.i2c1
                };
                bus.write(off, v, now);
                if !bus.events.is_empty() {
                    self.iotrace.extend(&mut bus.events);
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
            0x6000_F000 => return self.i2s[0].write(off, v, now),
            0x6002_D000 => return self.i2s[1].write(off, v, now),
            0x6000_8000 if off >= 0x800 => {
                if self.adc.write(off - 0x800, v) {
                    return;
                }
            }
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
                let done = if off >= 0x800 {
                    self.intm1.write(off - 0x800, v)
                } else {
                    self.intm.write(off, v)
                };
                if done {
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
        if let Some(l) = self.lcd.as_mut() {
            // RST 低有效，只在固件真的把脚驱动为低时复位（模组板上有上拉）；背光高电平亮
            let en = self.gpio.enable;
            l.set_reset(en >> lcd_pin::RST & 1 != 0 && lv >> lcd_pin::RST & 1 == 0);
            l.set_backlight(lv >> lcd_pin::BL & 1 != 0);
        }
        if lv != self.last_gpio {
            self.last_gpio = lv;
            self.iotrace.gpio(now, lv);
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
        set(usb::SRC_USB, self.usb.as_ref().is_some_and(|u| u.irq()));
        set(src::RMT, self.rmt.irq());
        set(src::I2C_EXT0, self.i2c0.irq());
        set(src::I2C_EXT1, self.i2c1.irq());
        set(src::SPI2, self.spi2.irq());
        set(src::I2S0, self.i2s[0].irq());
        set(src::I2S1, self.i2s[1].irq());
        for ch in 0..self.gdma.layout.nch as u32 {
            set(src::DMA_IN_CH0 + ch, self.gdma.in_irq(ch as usize));
            set(src::DMA_OUT_CH0 + ch, self.gdma.out_irq(ch as usize));
        }
        for i in 0..3 {
            set(src::SYSTIMER_TARGET0 + i, self.systimer.irq(i as usize));
        }
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
        let l = self.rmt.layout;
        let mut next = u64::MAX;
        let mut edges = std::mem::take(&mut self.rmt.edges);
        for pin in 0..NPINS as u32 {
            let sel = self.gpio.func_out[pin as usize] & 0x1ff;
            if !(l.sig_out0..l.sig_out0 + l.ntx as u32).contains(&sel) {
                continue;
            }
            let ch = (sel - l.sig_out0) as u8;
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
        edges.clear();
        self.rmt.edges = edges;
        next
    }

    /// 圆屏的片选：CS 脚经 IO_MUX / GPIO 矩阵接到 SPI2 的 CS0 时由控制器在传输期间拉低；
    /// 否则当普通 GPIO 看，固件驱动为低才算选中
    fn lcd_selected(&self) -> bool {
        let pin = lcd_pin::CS as usize;
        let via_iomux = (self.gpio.iomux[pin] >> 12) & 7 == IOMUX_FUNC_FSPICS0;
        let via_matrix = self.gpio.func_out[pin] & 0x1ff == SIG_FSPICS0;
        if via_iomux || via_matrix {
            self.spi2.cs0_enabled()
        } else {
            self.gpio.enable >> pin & 1 != 0 && self.gpio.level() >> pin & 1 == 0
        }
    }

    /// 固件写了 SPI2 CMD.USR：取数据（W 寄存器或 GDMA 描述符链）、交给圆屏，再按 SPI 时钟计时
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

    /// LEDC 或 GPIO 矩阵改过：把各引脚此刻的 PWM 交给事件记录（没变的引脚不记）
    fn trace_pwm(&mut self, now: u64) {
        if !self.iotrace.pwm_scan_needed(self.ledc.rev) {
            return;
        }
        self.iotrace.pwm_dirty = false;
        self.iotrace.ledc_rev = self.ledc.rev;
        for pin in 0..NPINS {
            let p = self.pin_pwm(pin);
            self.iotrace.pwm(now, pin, p);
        }
    }

    /// 引脚上的 PWM：经 GPIO 矩阵路由到该引脚的 LEDC 通道输出（占空比, 频率）。
    /// S3 的 LEDC 输出信号是 73..=80（LEDC_LS_SIG_OUT0..7_IDX）
    pub fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)> {
        let f = *self.gpio.func_out.get(pin)?;
        let sig = f & 0x1ff;
        if (73..=80).contains(&sig) && self.gpio.enable & (1 << pin) != 0 {
            let (d, hz) = self.ledc.output((sig - 73) as usize)?;
            let inv = f & (1 << 9) != 0;
            return Some((if inv { 1.0 - d } else { d }, hz));
        }
        None
    }

    /// 推进定时器、按两个核各自的中断矩阵算出外部中断线（存进 lines，轮到该核时交给它）
    pub fn update(&mut self) {
        let now = self.now;
        let n1 = self.systimer.update(now);
        let n2 = self.timg0.update(now);
        let n3 = self.timg1.update(now);
        let n4 = self.ledc.update(now);
        let n5 = self.rmt.update(now);
        let n6 = self.route_rmt(now);
        let n7 = self.i2c0.update(now).min(self.i2c1.update(now));
        let (n9, spi_done) = self.spi2.update(now);
        self.trace_pwm(now);
        if spi_done {
            if let Some(ch) = self.spi2.dma_out_ch.take() {
                self.gdma.out_done(ch);
            }
        }
        let n10 = self.i2s_update(now, 0).min(self.i2s_update(now, 1));
        let n8 = match self.usb.take() {
            Some(mut u) => {
                let n = u.update(now, self);
                self.usb = Some(u);
                n
            }
            None => u64::MAX,
        };
        self.next_event = n1
            .min(n2)
            .min(n3)
            .min(n4)
            .min(n5)
            .min(n6)
            .min(n7)
            .min(n8)
            .min(n9)
            .min(n10);
        let lv = self.levels();
        // 边沿型线由核自己检测上升沿，这里把电平和本次上升沿一起给出
        let (l0, r0) = self.intm.lines(&lv);
        let (l1, r1) = self.intm1.lines(&lv);
        self.lines = [l0 | r0, l1 | r1];
        self.irq_dirty = false;
    }
}

impl SocBus {
    /// I2S 口 k 收发推进：按 GPIO 矩阵判断喇叭 DIN / 麦克风 SD 是不是接在这个口的数据线上，再借总线让 GDMA 搬数据
    fn i2s_update(&mut self, now: u64, k: usize) -> u64 {
        if !self.i2s[k].tx.running && !self.i2s[k].rx.running {
            return u64::MAX;
        }
        let sig = SIG_I2S_SD[k];
        let speaker = self.audio.speaker.as_ref().is_some_and(|s| {
            self.gpio
                .func_out
                .get(s.pins.data as usize)
                .is_some_and(|f| (f & 0x1ff) as usize == sig)
        });
        // FUNCn_IN_SEL_CFG：位 5..0 引脚、位 7 经 GPIO 矩阵
        let f = self.gpio.func_in[sig];
        let mic = self
            .audio
            .mic
            .as_ref()
            .is_some_and(|m| f & (1 << 7) != 0 && f & 0x3f == m.pins.data);
        let mut g = std::mem::replace(&mut self.gdma, Gdma::placeholder());
        let mut au = std::mem::take(&mut self.audio);
        let mut i2s = std::mem::replace(&mut self.i2s[k], I2s::new(k as u8, true));
        let mut io = PortIo {
            audio: &mut au,
            speaker,
            mic,
        };
        let n = i2s.update(now, &mut g, self, GDMA_PERI_I2S[k], &mut io);
        self.i2s[k] = i2s;
        self.audio = au;
        self.gdma = g;
        n
    }

    /// 接 MAX98357A 喇叭 / INMP441 麦克风（引脚见 `i2s_pin`）
    pub fn attach_speaker(&mut self) {
        use i2s_pin::*;
        let p = audio::Pins {
            bclk: SPK_BCLK,
            ws: SPK_LRC,
            data: SPK_DIN,
        };
        self.audio.speaker = Some(Box::new(audio::Max98357a::new(p)));
    }
    pub fn attach_mic(&mut self) {
        use i2s_pin::*;
        let p = audio::Pins {
            bclk: MIC_SCK,
            ws: MIC_WS,
            data: MIC_SD,
        };
        self.audio.mic = Some(Box::new(audio::Inmp441::new(p)));
    }
}

impl usb::dwc2::Mem for SocBus {
    fn rd8(&mut self, a: u32) -> u8 {
        self.mem_read(a, 1).unwrap_or(0) as u8
    }
    fn wr8(&mut self, a: u32, v: u8) {
        self.mem_write(a, 1, v as u32);
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

impl SocBus {
    /// 在 SPI2 上接一块 GC9A01 圆屏（引脚见 `lcd_pin`）
    pub fn attach_lcd(&mut self) {
        self.lcd = Some(Box::default());
        let now = self.now;
        self.gpio_changed(now);
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
    Fault {
        cause: u32,
        epc: u32,
        vaddr: u32,
    },
    /// BREAK / BREAK.N
    Break(u32),
    /// 碰到没实现的 HLE 函数
    Hle(u32),
    /// 固件请求复位（esp_restart、panic 后重启）；调用 reboot() 重新上电
    Reset(u32),
}

pub struct Esp32s3 {
    /// 核 0（PRO CPU）
    pub cpu: Cpu,
    /// 核 1（APP CPU），cpu1_on 之前不执行
    pub cpu1: Cpu,
    pub cpu1_on: bool,
    pub bus: SocBus,
    pub rom_symbols: HashMap<u32, String>,
    pub hle: HashMap<u32, hle::Hle>,
    /// 留一份 ROM，复位重新上电时用
    pub rom_elf: Vec<u8>,
}

/// 两核交替执行的量子（周期）：小到让核间中断、自旋锁及时生效，大到切换开销可忽略
const QUANTUM: u64 = 256;

/// 跑一个核直到它的周期数到 `until`。`idle_until`：这个核进入 WAITI 时允许快进到的最远时刻。
fn run_core(
    k: usize,
    cpu: &mut Cpu,
    bus: &mut SocBus,
    hle: &HashMap<u32, hle::Hle>,
    until: u64,
    idle_until: u64,
) -> Option<Stop> {
    cpu.set_irq_lines(bus.lines[k]);
    while cpu.cycles < until {
        // 外设时间取两核中走得最远的那个，保证单调
        if cpu.cycles > bus.now {
            bus.now = cpu.cycles;
        }
        if bus.irq_dirty || bus.now >= bus.next_event {
            bus.update();
            cpu.set_irq_lines(bus.lines[k]);
        }
        match cpu.step(bus) {
            Exit::Normal => {
                // ROM 异常向量（0x40000300 Kernel / 0x40000340 User / 0x400003C0 Double）：
                // app 正常运行时 VECBASE 指向 IRAM，落到这里说明出事了
                let pc = cpu.pc;
                if (0x4000_0300..0x4000_0400).contains(&pc) && cpu.read_sr(sr::VECBASE) == ROM_LOW {
                    return Some(Stop::Fault {
                        cause: cpu.read_sr(sr::EXCCAUSE),
                        epc: cpu.read_sr(sr::EPC1),
                        vaddr: cpu.read_sr(sr::EXCVADDR),
                    });
                }
                if bus.irq_dirty {
                    // 写了 RTC_CNTL 复位位：本核到此为止，由外层重新上电
                    if let Some(r) = bus.reset_request.take() {
                        return Some(Stop::Reset(r));
                    }
                    // 本核写了外设（可能清掉 / 触发了中断）：马上重算
                    bus.update();
                    cpu.set_irq_lines(bus.lines[k]);
                }
            }
            Exit::Waiti => {
                // 空闲：快进到下一个外设事件或 CCOMPARE 定时器中断
                let target = bus
                    .next_event
                    .min(cpu.next_timer_event().unwrap_or(u64::MAX))
                    .min(idle_until);
                if target > cpu.cycles {
                    cpu.cycles = target;
                } else {
                    cpu.cycles += 1;
                }
            }
            Exit::Hle(pc) => match hle.get(&pc) {
                Some(kind) => hle::call(*kind, cpu, bus),
                None => return Some(Stop::Hle(pc)),
            },
            Exit::Break(v) => return Some(Stop::Break(v)),
            // 半主机调用：固件只在 QEMU 测试里用，这里忽略
            Exit::Simcall => {}
        }
    }
    None
}

impl Esp32s3 {
    pub fn run(&mut self, budget: u64) -> Stop {
        let end = self.cpu.cycles.saturating_add(budget);
        while self.cpu.cycles < end {
            let q_end = (self.cpu.cycles + QUANTUM).min(end);
            // 两核都空闲时可以一起快进到下一个事件；否则核 0 的快进不能越过本量子（核 1 可能马上给它发核间中断）
            let both_idle = !self.cpu1_on || self.cpu1.waiting;
            let idle0 = if both_idle { end } else { q_end };
            if let Some(s) = run_core(0, &mut self.cpu, &mut self.bus, &self.hle, q_end, idle0) {
                return s;
            }
            if std::mem::take(&mut self.bus.appcpu_reset) {
                // 核 1 被复位：真机上它回到 ROM 等新的启动地址（随后还会被 stall），这里直接停掉
                self.cpu1_on = false;
            }
            if self.cpu1_on {
                // 核 1 追到核 0 的时间，不超过它
                let t = self.cpu.cycles;
                if let Some(s) = run_core(1, &mut self.cpu1, &mut self.bus, &self.hle, t, t) {
                    return s;
                }
            }
            if let Some(entry) = self.bus.appcpu_boot.take() {
                self.start_app_cpu(entry);
            }
        }
        Stop::Budget
    }

    /// 调试用：单步跑，记录 PC 不连续处（跳转目标）
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mmu_flash_and_psram() {
        let mut b = SocBus {
            flash: vec![0; 1 << 20],
            ..Default::default()
        };
        b.flash[0x2_0004] = 0xab;
        b.psram[0x1_0008] = 0xcd;
        // DROM 0x3C010000 → flash 页 2；DROM 0x3C800000（线性页 128）→ PSRAM 页 1
        b.mmu[1] = 2;
        b.mmu[128] = MMU_PSRAM | 1;
        assert_eq!(b.mem_read(0x3C01_0004, 1), Some(0xab));
        assert_eq!(b.mem_read(0x3C80_0008, 1), Some(0xcd));
        // PSRAM 可写、flash 映射不可写
        assert!(b.mem_write(0x3C80_0000, 4, 0x1234_5678).is_some());
        assert!(b.mem_write(0x3C01_0000, 4, 1).is_none());
        // 无效页
        assert_eq!(b.mem_read(0x3C02_0000, 4), None);
    }

    #[test]
    fn software_reset_bits() {
        let mut b = SocBus::default();
        // 核 1 复位：只记标志，存回的值不带复位位（读改写不会再触发）
        Bus::store(&mut b, 0x6000_8000, 4, 0x10 | 0x4).unwrap();
        assert!(b.appcpu_reset && b.reset_request.is_none());
        assert_eq!(Bus::load(&mut b, 0x6000_8000, 4).unwrap(), 0x4);
        // 核 0 复位 = 整机重新上电，原因 12（RTC_SW_CPU_RST）；系统复位原因 3
        Bus::store(&mut b, 0x6000_8000, 4, 0x20).unwrap();
        assert_eq!(b.reset_request, Some(12));
        Bus::store(&mut b, 0x6000_8000, 4, 1 << 31).unwrap();
        assert_eq!(b.reset_request, Some(3));
        b.reset_reason = 12;
        assert_eq!(
            Bus::load(&mut b, RTC_CNTL_RESET_STATE, 4).unwrap() & 0xfff,
            12 | (12 << 6)
        );
    }

    #[test]
    fn psram_via_spi1_cs1() {
        let mut b = SocBus::default();
        // MISC：CS0 关、CS1 开；读 MR1（厂商 ID）
        Bus::store(&mut b, 0x6000_2034, 4, 1).unwrap();
        Bus::store(&mut b, 0x6000_2018, 4, (1 << 31) | (1 << 30) | (1 << 28)).unwrap();
        Bus::store(&mut b, 0x6000_2020, 4, (15 << 28) | 0x4040).unwrap();
        Bus::store(&mut b, 0x6000_2004, 4, 0).unwrap();
        Bus::store(&mut b, 0x6000_2028, 4, 15).unwrap();
        Bus::store(&mut b, 0x6000_2000, 4, 1 << 18).unwrap();
        assert_eq!(
            (Bus::load(&mut b, 0x6000_2058, 4).unwrap() >> 8) & 0xff,
            0x0d
        );
        // 片选回 CS0：同一命令发给 flash，不碰 PSRAM
        let n = b.psram_chip.commands;
        Bus::store(&mut b, 0x6000_2034, 4, 2).unwrap();
        Bus::store(&mut b, 0x6000_2000, 4, 1 << 18).unwrap();
        assert_eq!(b.psram_chip.commands, n);
    }

    #[test]
    fn sram_aliases() {
        let mut b = SocBus::default();
        b.mem_write(0x3FC8_8000, 4, 0xdead_beef).unwrap();
        assert_eq!(b.mem_read(0x4037_8000, 4), Some(0xdead_beef));
        // SRAM2 只在 D 总线
        b.mem_write(0x3FCF_0000, 4, 7).unwrap();
        assert_eq!(b.mem_read(0x3FCF_0000, 4), Some(7));
    }

    #[test]
    fn intmatrix_routes_level_and_edge() {
        let mut m = Intmatrix::default();
        let mut lv = [0u64; 2];
        lv[(src::SYSTIMER_TARGET0 / 64) as usize] |= 1 << (src::SYSTIMER_TARGET0 % 64);
        // 映射到电平线 9
        m.map[src::SYSTIMER_TARGET0 as usize] = 9;
        assert_eq!(m.lines(&lv), (1 << 9, 0));
        // 映射到边沿线 10：只在第一次出现时给出上升沿
        m.map[src::SYSTIMER_TARGET0 as usize] = 10;
        assert_eq!(m.lines(&lv), (0, 1 << 10));
        assert_eq!(m.lines(&lv), (0, 0));
        // 复位值映射到线 16（定时器线）等于不连接
        assert_eq!(Intmatrix::default().lines(&lv), (0, 0));
    }
}
