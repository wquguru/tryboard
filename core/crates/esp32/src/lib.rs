//! Classic ESP32 (dual-core Xtensa LX6) SoC. The core is tryboard-xtensa shared with S3 (LX6 parameters); peripherals
//! matching C3 / S3 reuse their models, offset-shifted ones (TIMG, SPI1, LEDC) get a shim in periph.rs. Run loop as S3.

pub mod boot;
mod chip;
pub mod crypto;
pub mod hle;
pub mod i2s;
pub mod periph;
pub mod psram;
pub mod sens;
mod spi_lcd;
mod spi_touch;

use periph::*;
use std::collections::HashMap;
use tryboard_soc::devices::audio::Audio;
use tryboard_soc::devices::lcd::{Lcd, LcdPins};
use tryboard_soc::devices::pins::PinDevices;
use tryboard_soc::gpspi_classic::ClassicSpi;
use tryboard_soc::i2c::{I2c, I2cLayout};
use tryboard_soc::i2cpins::PinBuses;
use tryboard_soc::iotrace::IoTrace;
use tryboard_soc::periph::Uart;
use tryboard_soc::rmt::{Rmt, RmtLayout, Ws2812};
use tryboard_soc::tasktrace::TaskTrace;
use tryboard_soc::wifi::{MacRegs, WifiLayout, WifiMac};
use tryboard_soc::Mem as DmaMem;
use tryboard_xtensa::{sr, Bus, BusFault, Cpu, Exit};

pub const CPU_HZ: u64 = tryboard_soc::periph::CPU_HZ;

// Memory map (soc/esp32/include/soc/soc.h, TRM chapter 1)
/// D-bus view of SRAM2 + SRAM1 (0x3FFAE000..0x40000000, 328KB)
pub const DRAM_LOW: u32 = 0x3FFA_E000;
pub const DRAM_HIGH: u32 = 0x4000_0000;
/// I-bus view of SRAM0 (192KB)
pub const IRAM_LOW: u32 = 0x4007_0000;
pub const IRAM_HIGH: u32 = 0x400A_0000;
/// I-bus view of SRAM1: same memory as D 0x3FFE0000..0x40000000 but word-reversed (SOC_DIRAM_INVERTED)
pub const IRAM1_LOW: u32 = 0x400A_0000;
pub const IRAM1_HIGH: u32 = 0x400C_0000;
/// SRAM buffer: the 328KB D view first, then SRAM0's 192KB, 520KB total
const SRAM0_OFF: usize = (DRAM_HIGH - DRAM_LOW) as usize;
pub const SRAM_SIZE: usize = 520 << 10;
pub const ROM_LOW: u32 = 0x4000_0000;
pub const ROM_HIGH: u32 = 0x4007_0000;
/// ROM1 read-only data (64KB on the D bus), stored after ROM0 in the rom buffer
pub const DROM1_LOW: u32 = 0x3FF9_0000;
pub const DROM1_HIGH: u32 = 0x3FFA_0000;
const DROM1_OFF: usize = (ROM_HIGH - ROM_LOW) as usize;
/// Cache windows: DROM0 4MB, IROM0 (from 0x400D0000; 0x400C0000..0x400D0000 below it is unusable)
pub const DROM_LOW: u32 = 0x3F40_0000;
pub const DROM_HIGH: u32 = 0x3F80_0000;
pub const IROM_LOW: u32 = 0x400D_0000;
pub const IROM_HIGH: u32 = 0x40C0_0000;
/// RTC fast memory (8KB, D 0x3FF80000 and I 0x400C0000 are the same block) and slow memory (8KB)
pub const RTC_FAST_D: u32 = 0x3FF8_0000;
pub const RTC_FAST_I: u32 = 0x400C_0000;
pub const RTC_FAST_SIZE: u32 = 0x2000;
pub const RTC_SLOW_LOW: u32 = 0x5000_0000;
pub const RTC_SLOW_HIGH: u32 = 0x5000_2000;
pub const MMIO_LOW: u32 = 0x3FF0_0000;
pub const MMIO_HIGH: u32 = 0x3FF8_0000;
/// AHB alias of peripherals (used for UART / I2C FIFOs): 0x60000000 + x = 0x3FF40000 + x
pub const AHB_LOW: u32 = 0x6000_0000;
pub const AHB_HIGH: u32 = 0x6004_0000;
const AHB_TO_APB: u32 = 0x3FF4_0000;

/// Cache MMU (DPORT_PRO_FLASH_MMU_TABLE): 256 entries of 64KB pages; 0x100 = invalid.
/// Entries 0..63 map DROM0 (from 0x3F400000), entries 64.. map IROM0 (counted in 64KB from 0x40000000)
pub const MMU_PRO: u32 = 0x3FF1_0000;
pub const MMU_APP: u32 = 0x3FF1_2000;
pub const MMU_ENTRIES: usize = 256;
pub const MMU_INVALID: u32 = 0x100;
/// 4KB pages holding the PSRAM entries (1152 * 4 = 0x1200 into each table)
const PSRAM_MMU_PRO: u32 = MMU_PRO + 0x1000;
const PSRAM_MMU_APP: u32 = MMU_APP + 0x1000;
const PSRAM_MMU_OFF: u32 = (psram::MMU_FIRST * 4) as u32 - 0x1000;
const PSRAM_MMU_END: u32 = PSRAM_MMU_OFF + (psram::MMU_COUNT * 4) as u32;

const UART0: u32 = 0x3FF4_0000;
/// RMT registers; RMTMEM (8 x 64 words) at +0x800 in the same page
const RMT_BASE: u32 = 0x3FF5_6000;

/// RMT accesses the model doesn't cover, counted as unimpl: APB FIFO data / address registers (RX and carrier: F-10c)
fn rmt_unmodelled(off: u32) -> bool {
    off < 0x20 || (0x80..0xa0).contains(&off)
}
const UART1: u32 = 0x3FF5_0000;
const UART2: u32 = 0x3FF6_E000;
const RTC_CNTL: u32 = 0x3FF4_8000;
/// Software reset bits of RTC_CNTL_OPTIONS0 (rtc_cntl_reg.h, same positions as S3)
const RST_SYS: u32 = 1 << 31;
const RST_PROCPU: u32 = 1 << 5;
const RST_APPCPU: u32 = 1 << 4;
pub const RTC_CNTL_RESET_STATE: u32 = RTC_CNTL + 0x34;
/// RTC_CNTL_STORE0..3 (0x4C..0x58) and STORE6..7 (0xB8..0xBC) survive reset; ROM rewrites STORE4 / 5
const RTC_STORE_KEEP: [u32; 6] = [
    RTC_CNTL + 0x4c,
    RTC_CNTL + 0x50,
    RTC_CNTL + 0x54,
    RTC_CNTL + 0x58,
    RTC_CNTL + 0xb8,
    RTC_CNTL + 0xbc,
];
/// Hardware RNG (wdev_reg.h: WDEV_RND_REG)
pub const WDEV_RND_REG: u32 = 0x3FF7_5144;
/// APB_CTRL_DATE_REG: bit 31 is the third version bit for chip revision v3 (efuse_hal_get_major_chip_version)
const APB_CTRL_DATE: u32 = 0x3FF6_607C;

pub struct SocBus {
    pub sram: Vec<u8>,
    pub rtc_slow: Vec<u8>,
    pub rtc_fast: Vec<u8>,
    pub rom: Vec<u8>,
    pub flash: Vec<u8>,
    pub mmu: Vec<u32>,
    pub mmu_app: Vec<u32>,
    /// PSRAM entries 1152..1279 of both MMU tables (32KB pages of the DRAM1 window, M5-14)
    pub psram_mmu: Vec<u32>,
    pub psram_mmu_app: Vec<u32>,
    /// Fetch page cache (as S3): 64KB page, backing store and page base of the last fetch; invalidated on MMU writes
    fetch_page: u32,
    fetch_src: FetchSrc,
    fetch_base: usize,
    pub now: u64,
    pub uart0: Uart,
    pub uart1: Uart,
    pub uart2: Uart,
    pub timg0: Esp32Timg,
    pub timg1: Esp32Timg,
    /// DPORT: both interrupt matrices, cross-core interrupts, cache control
    pub dport: Dport,
    pub lines: [u32; 2],
    pub appcpu_boot: Option<u32>,
    pub gpio: Gpio,
    pub spi1: Spi1,
    pub ledc: Esp32Ledc,
    pub analog: Analog,
    pub sha: crypto::ShaHw,
    pub aes: crypto::AesHw,
    /// RMT TX (M5-11): shared model with the classic register map; RX / carrier / APB FIFO count as unimpl
    pub rmt: Rmt,
    /// HSPI (SPI2) / VSPI (SPI3) masters with their in-block DMA (M5-10)
    pub hspi: ClassicSpi,
    pub vspi: ClassicSpi,
    /// SPI screen and the GPIOs it is wired to
    pub lcd: Option<Box<Lcd>>,
    pub lcd_pins: LcdPins,
    /// WS2812 decoders on pins routed to an RMT output
    pub ws2812: HashMap<u32, Ws2812>,
    pub pins: PinDevices,
    pub i2c0: I2c,
    /// Buses on fixed SDA / SCL pads (M5-02): reached by the routed controller or by bit-banged GPIO
    pub i2c_pins: PinBuses,
    /// APB_CTRL_DATE bit 31 (revision v3 marker); cleared for PICO-D4 parts, which M5GFX reads as V3-02 otherwise
    pub chip_v3: bool,
    pub i2c1: I2c,
    pub adc: Adc,
    /// I2S0 / I2S1 (M5-12): classic lldesc DMA, PDM RX on I2S0
    pub i2s: [i2s::I2s; 2],
    pub audio: Audio,
    /// ESP32's Wi-Fi MAC is an older IP and not modelled (see DECISIONS); an unmapped instance keeps the common interface
    pub wifi: Option<Box<WifiMac>>,
    pub rng: u32,
    pub efuse: [u32; 0x200 / 4],
    pub console: Vec<u8>,
    pub regs: HashMap<u32, u32>,
    pub unimpl: HashMap<u32, u64>,
    pub irq_dirty: bool,
    pub next_event: u64,
    pub gpio_log: Vec<(u64, u64)>,
    last_gpio: u64,
    pub iotrace: IoTrace,
    /// FreeRTOS task timeline (C-04); word 2 of an Xtensa stack frame is the PC
    pub tasks: TaskTrace,
    pub reset_request: Option<u32>,
    pub appcpu_reset: bool,
    pub reset_reason: u32,
}

pub use sens::Adc;

impl Default for SocBus {
    fn default() -> Self {
        let mut spi1 = Spi1::default();
        // DevKitC V4's WROOM-32 module: 4MB
        spi1.inner.jedec = 0x16_40_c8;
        SocBus {
            sram: vec![0; SRAM_SIZE],
            rtc_slow: vec![0; (RTC_SLOW_HIGH - RTC_SLOW_LOW) as usize],
            rtc_fast: vec![0; RTC_FAST_SIZE as usize],
            rom: vec![0; 0x80000],
            flash: Vec::new(),
            mmu: vec![MMU_INVALID; MMU_ENTRIES],
            mmu_app: vec![MMU_INVALID; MMU_ENTRIES],
            // Reset contents are undocumented and IDF never invalidates them; identity keeps IDF's low/high
            // write-back loop (reads 2MB past the mapped part on 2MB chips) working as on a real StickC Plus2
            psram_mmu: (0..psram::MMU_COUNT as u32).collect(),
            psram_mmu_app: (0..psram::MMU_COUNT as u32).collect(),
            fetch_page: u32::MAX,
            fetch_src: FetchSrc::Sram,
            fetch_base: 0,
            now: 0,
            uart0: Uart::default(),
            uart1: Uart::default(),
            uart2: Uart::default(),
            timg0: Esp32Timg::new(0),
            timg1: Esp32Timg::new(1),
            dport: Dport::default(),
            lines: [0; 2],
            appcpu_boot: None,
            gpio: Gpio::default(),
            spi1,
            ledc: Esp32Ledc::default(),
            analog: Analog::default(),
            sha: Default::default(),
            aes: Default::default(),
            rmt: Rmt::new(RmtLayout::ESP32),
            hspi: ClassicSpi::default(),
            vspi: ClassicSpi::default(),
            lcd: None,
            lcd_pins: LcdPins::ESP32_DEFAULT,
            ws2812: HashMap::new(),
            pins: PinDevices::default(),
            i2c0: I2c::with_layout(I2cLayout::ESP32, 0),
            i2c_pins: PinBuses::default(),
            chip_v3: true,
            i2c1: I2c::with_layout(I2cLayout::ESP32, tryboard_soc::iotrace::i2cbit::PORT1),
            adc: Adc::default(),
            i2s: [i2s::I2s::new(0), i2s::I2s::new(1)],
            audio: Audio::default(),
            wifi: Some(Box::new(WifiMac::new(WifiLayout::ESP32))),
            rng: 0x2545_f491,
            efuse: default_efuse(),
            console: Vec::new(),
            regs: HashMap::new(),
            unimpl: HashMap::new(),
            irq_dirty: true,
            next_event: 0,
            gpio_log: Vec::new(),
            last_gpio: 1,
            iotrace: IoTrace::new(1),
            tasks: TaskTrace::new(4),
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

#[derive(Clone, Copy)]
enum FetchSrc {
    Sram,
    Flash,
    Rom,
}

impl SocBus {
    /// Cache window address -> flash offset
    #[inline]
    fn flash_addr(&self, vaddr: u32) -> Option<usize> {
        let idx = if (DROM_LOW..DROM_HIGH).contains(&vaddr) {
            ((vaddr - DROM_LOW) >> 16) as usize
        } else if (IROM_LOW..IROM_HIGH).contains(&vaddr) {
            64 + ((vaddr - ROM_LOW) >> 16) as usize
        } else {
            return None;
        };
        let e = *self.mmu.get(idx)?;
        if e & MMU_INVALID != 0 {
            return None;
        }
        Some((((e & 0xff) << 16) | (vaddr & 0xffff)) as usize)
    }

    /// DRAM1 window address -> PSRAM offset. IDF always uses 32KB SRAM pages (CMMU_SRAM_PAGE_MODE 0), and writes
    /// both cores' tables alike, so the low/high split between the two caches needs no modelling
    #[inline]
    fn psram_addr(&self, vaddr: u32) -> Option<usize> {
        if !(psram::DRAM1_LOW..psram::DRAM1_HIGH).contains(&vaddr) {
            return None;
        }
        let e = self.psram_mmu[((vaddr - psram::DRAM1_LOW) >> 15) as usize];
        let n = self.spi1.psram.mem.len();
        if e & MMU_INVALID != 0 || n == 0 {
            return None;
        }
        // A smaller chip ignores the high address bits
        Some(((((e & 0xff) << 15) | (vaddr & 0x7fff)) as usize) % n)
    }

    /// SRAM buffer offset; SRAM1's word-reversed I view needs flipping, so only accesses within one word are allowed
    #[inline]
    fn sram_off(a: u32) -> Option<usize> {
        if (DRAM_LOW..DRAM_HIGH).contains(&a) {
            Some((a - DRAM_LOW) as usize)
        } else if (IRAM_LOW..IRAM_HIGH).contains(&a) {
            Some(SRAM0_OFF + (a - IRAM_LOW) as usize)
        } else if (IRAM1_LOW..IRAM1_HIGH).contains(&a) {
            let o = a - IRAM1_LOW;
            let d = DRAM_HIGH - 4 - (o & !3) + (o & 3);
            Some((d - DRAM_LOW) as usize)
        } else {
            None
        }
    }

    fn rtc_fast_off(a: u32) -> Option<usize> {
        if (RTC_FAST_D..RTC_FAST_D + RTC_FAST_SIZE).contains(&a) {
            Some((a - RTC_FAST_D) as usize)
        } else if (RTC_FAST_I..RTC_FAST_I + RTC_FAST_SIZE).contains(&a) {
            Some((a - RTC_FAST_I) as usize)
        } else {
            None
        }
    }

    pub fn mem_read(&self, a: u32, size: u32) -> Option<u32> {
        if let Some(o) = Self::sram_off(a) {
            rd(&self.sram, o, size)
        } else if (IROM_LOW..IROM_HIGH).contains(&a) || (DROM_LOW..DROM_HIGH).contains(&a) {
            let f = self.flash_addr(a)?;
            Some(rd(&self.flash, f, size).unwrap_or(0xffff_ffff))
        } else if (ROM_LOW..ROM_HIGH).contains(&a) {
            rd(&self.rom, (a - ROM_LOW) as usize, size)
        } else if let Some(p) = self.psram_addr(a) {
            rd(&self.spi1.psram.mem, p, size)
        } else if (DROM1_LOW..DROM1_HIGH).contains(&a) {
            rd(&self.rom, DROM1_OFF + (a - DROM1_LOW) as usize, size)
        } else if let Some(o) = Self::rtc_fast_off(a) {
            rd(&self.rtc_fast, o, size)
        } else if (RTC_SLOW_LOW..RTC_SLOW_HIGH).contains(&a) {
            rd(&self.rtc_slow, (a - RTC_SLOW_LOW) as usize, size)
        } else {
            None
        }
    }

    pub fn mem_write(&mut self, a: u32, size: u32, v: u32) -> Option<()> {
        if let Some(o) = Self::sram_off(a) {
            wr(&mut self.sram, o, size, v)
        } else if let Some(o) = Self::rtc_fast_off(a) {
            wr(&mut self.rtc_fast, o, size, v)
        } else if (RTC_SLOW_LOW..RTC_SLOW_HIGH).contains(&a) {
            wr(&mut self.rtc_slow, (a - RTC_SLOW_LOW) as usize, size, v)
        } else if let Some(p) = self.psram_addr(a) {
            wr(&mut self.spi1.psram.mem, p, size, v)
        } else {
            None
        }
    }

    /// Map the AHB alias to the APB address; None if the address is in neither range
    #[inline]
    fn mmio_addr(a: u32) -> Option<u32> {
        if (MMIO_LOW..MMIO_HIGH).contains(&a) {
            Some(a)
        } else if (AHB_LOW..AHB_HIGH).contains(&a) {
            Some(a - AHB_LOW + AHB_TO_APB)
        } else {
            None
        }
    }

    fn mmio_read(&mut self, a: u32) -> u32 {
        let now = self.now;
        let (base, off) = (a & !0xfff, a & 0xfff);
        match base {
            0x3FF0_0000 => {
                let lv = self.levels();
                return self.dport.read(off, &lv);
            }
            crypto::AES_BASE => return self.aes.read(off),
            crypto::SHA_BASE => return self.sha.read(off),
            MMU_PRO if (off as usize) < MMU_ENTRIES * 4 => return self.mmu[(off / 4) as usize],
            MMU_APP if (off as usize) < MMU_ENTRIES * 4 => return self.mmu_app[(off / 4) as usize],
            PSRAM_MMU_PRO if (PSRAM_MMU_OFF..PSRAM_MMU_END).contains(&off) => {
                return self.psram_mmu[((off - PSRAM_MMU_OFF) / 4) as usize]
            }
            PSRAM_MMU_APP if (PSRAM_MMU_OFF..PSRAM_MMU_END).contains(&off) => {
                return self.psram_mmu_app[((off - PSRAM_MMU_OFF) / 4) as usize]
            }
            UART0 => return self.uart0.read(off),
            UART1 => return self.uart1.read(off),
            UART2 => return self.uart2.read(off),
            0x3FF4_2000 => return self.spi1.read(off),
            0x3FF4_4000 => return self.gpio.read(off),
            0x3FF4_9000 => {
                if let Some(p) = Gpio::iomux_pin(off) {
                    return self.gpio.iomux[p];
                }
            }
            0x3FF5_3000 => return self.i2c0.read(off),
            0x3FF6_7000 => return self.i2c1.read(off),
            0x3FF6_4000 => return self.spi_read(spi_lcd::Host::Hspi, off),
            0x3FF6_5000 => return self.spi_read(spi_lcd::Host::Vspi, off),
            0x3FF5_9000 => return self.ledc.read(off),
            RMT_BASE => {
                if rmt_unmodelled(off) {
                    *self.unimpl.entry(a).or_insert(0) += 1;
                }
                return self.rmt.read(off);
            }
            0x3FF5_A000 if off < 0x200 => return self.efuse[(off / 4) as usize],
            0x3FF5_F000 => return self.timg0.read(off, now),
            0x3FF6_0000 => return self.timg1.read(off, now),
            RTC_CNTL => match off {
                // TIME_UPDATE: bit 30 TIME_VALID is set immediately
                0x0c => return self.regs.get(&a).copied().unwrap_or(0) | (1 << 30),
                // RTC slow clock counter (RC slow clock ~150kHz; only needs to agree with TIMG's RTC calibration)
                0x10 => return (now * 136_000 / CPU_HZ) as u32,
                0x14 => return ((now * 136_000 / CPU_HZ) >> 32) as u32,
                0x34 => return self.reset_reason | (self.reset_reason << 6),
                o if o >= sens::OFFSET && Adc::owns(o - sens::OFFSET) => {
                    return self.adc.read(o - sens::OFFSET)
                }
                _ => {}
            },
            b if i2s::BASE.contains(&b) => {
                let k = (b == i2s::BASE[1]) as usize;
                if !i2s::modelled(off) {
                    *self.unimpl.entry(a).or_insert(0) += 1;
                }
                return self.i2s[k].read(off);
            }
            _ => {}
        }
        if a == WDEV_RND_REG {
            let mut x = self.rng;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            self.rng = x;
            return x;
        }
        if a == APB_CTRL_DATE {
            return (self.chip_v3 as u32) << 31 | 0x1605_1900;
        }
        // The RNG register also falls inside the MAC range; check it first
        if MacRegs::ESP32.contains(a) {
            if let Some(v) = self.wifi_mut().read(a, now) {
                return v;
            }
        }
        if let Some(v) = self
            .wifi()
            .rf_read(a, self.regs.get(&a).copied().unwrap_or(0))
        {
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
            0x3FF0_0000 => return self.dport.write(off, v),
            crypto::AES_BASE => return self.aes.write(off, v),
            crypto::SHA_BASE => return self.sha.write(off, v),
            MMU_PRO if (off as usize) < MMU_ENTRIES * 4 => {
                self.mmu[(off / 4) as usize] = v & 0x1ff;
                self.fetch_page = u32::MAX;
                return;
            }
            // Core 1's MMU table: IDF always writes both identically, so fetch only uses core 0's
            MMU_APP if (off as usize) < MMU_ENTRIES * 4 => {
                self.mmu_app[(off / 4) as usize] = v & 0x1ff;
                return;
            }
            PSRAM_MMU_PRO if (PSRAM_MMU_OFF..PSRAM_MMU_END).contains(&off) => {
                self.psram_mmu[((off - PSRAM_MMU_OFF) / 4) as usize] = v & 0x1ff;
                return;
            }
            PSRAM_MMU_APP if (PSRAM_MMU_OFF..PSRAM_MMU_END).contains(&off) => {
                self.psram_mmu_app[((off - PSRAM_MMU_OFF) / 4) as usize] = v & 0x1ff;
                return;
            }
            UART0 => {
                self.uart0.write(off, v);
                if off == 0 {
                    self.console.push(v as u8);
                }
                return;
            }
            UART1 => return self.uart1.write(off, v),
            UART2 => return self.uart2.write(off, v),
            0x3FF4_2000 => return self.spi1.write(off, v, &mut self.flash),
            0x3FF4_4000 => {
                self.gpio.write(off, v);
                if (0x20..0x38).contains(&off) || off >= 0x530 {
                    self.iotrace.pwm_dirty = true;
                }
                self.gpio_changed(now);
                return;
            }
            0x3FF4_9000 => {
                if let Some(p) = Gpio::iomux_pin(off) {
                    self.gpio.iomux[p] = v;
                    self.gpio_changed(now);
                    return;
                }
            }
            0x3FF6_4000 => return self.spi_write(spi_lcd::Host::Hspi, off, v, now),
            0x3FF6_5000 => return self.spi_write(spi_lcd::Host::Vspi, off, v, now),
            0x3FF5_3000 | 0x3FF6_7000 => {
                // I2CEXT0 SDA/SCL out = 30/29, I2CEXT1 = 96/95 (gpio_sig_map.h)
                let (bus, sda, scl) = if base == 0x3FF5_3000 {
                    (&mut self.i2c0, 30, 29)
                } else {
                    (&mut self.i2c1, 96, 95)
                };
                let routed = self.i2c_pins.routed(&self.gpio.func_out, 0x1ff, sda, scl);
                let extra = routed.map(|i| &mut self.i2c_pins.buses[i].devices);
                bus.write_with(off, v, now, extra);
                if !bus.events.is_empty() {
                    self.iotrace.extend(&mut bus.events);
                }
                return;
            }
            0x3FF5_9000 => return self.ledc.write(off, v, now),
            RMT_BASE => {
                if rmt_unmodelled(off) {
                    *self.unimpl.entry(a).or_insert(0) += 1;
                }
                return self.rmt.write(off, v, now);
            }
            // eFuse read registers are read-only; CMD and other writes are dropped and read back 0 ("command done")
            0x3FF5_A000 if off < 0x200 => return,
            0x3FF5_F000 => return self.timg0.write(off, v, now),
            0x3FF6_0000 => return self.timg1.write(off, v, now),
            // Reset bits are pulses: record the request and store the value without them
            RTC_CNTL if off == 0 => {
                if v & (RST_SYS | RST_PROCPU) != 0 {
                    self.reset_request = Some(if v & RST_SYS != 0 { 3 } else { 12 });
                } else if v & RST_APPCPU != 0 {
                    self.appcpu_reset = true;
                }
                self.regs
                    .insert(a, v & !(RST_SYS | RST_PROCPU | RST_APPCPU));
                return;
            }
            RTC_CNTL if off >= sens::OFFSET && Adc::owns(off - sens::OFFSET) => {
                return self.adc.write(off - sens::OFFSET, v)
            }
            b if i2s::BASE.contains(&b) => {
                let k = (b == i2s::BASE[1]) as usize;
                if !i2s::modelled(off) {
                    *self.unimpl.entry(a).or_insert(0) += 1;
                }
                return self.i2s[k].write(off, v, now);
            }
            _ => {}
        }
        let mut v = v;
        if MacRegs::ESP32.contains(a) {
            // Infallible: wifi is set at construction and only taken around write/update,
            // whose Mem callbacks reach RAM only (never this register path).
            let mut w = self.wifi.take().expect("wifi");
            let keep = w.write(a, v, now, self);
            self.wifi = Some(w);
            // None = fully handled by the MAC model; otherwise store as a generic register (still counted as unimpl)
            match keep {
                Some(x) => v = x,
                None => return,
            }
        }
        *self.unimpl.entry(a).or_insert(0) += 1;
        self.regs.insert(a, v);
    }

    // Infallible: wifi is set at construction and only taken around write/update,
    // whose Mem callbacks reach RAM only (never this register path).
    pub fn wifi(&self) -> &WifiMac {
        self.wifi.as_deref().expect("wifi")
    }
    pub fn wifi_mut(&mut self) -> &mut WifiMac {
        self.wifi.as_deref_mut().expect("wifi")
    }

    /// Let bit-banged pin buses see the pads; a device's SDA drive changes only while SCL is low, so this settles
    fn i2c_pins_settle(&mut self, now: u64) {
        if self.i2c_pins.is_empty() {
            return;
        }
        for _ in 0..4 {
            let lv = self.gpio.level();
            let fo = &self.gpio.func_out;
            let gpio = |p: u32| {
                fo.get(p as usize)
                    .is_some_and(|f| f & 0x1ff == SIG_GPIO_OUT)
            };
            let drives = self.i2c_pins.on_level(now, lv, gpio);
            if drives.is_empty() {
                return;
            }
            for (pin, low) in drives {
                let bit = 1 << pin;
                if low {
                    self.gpio.ext_driven |= bit;
                    self.gpio.ext_in &= !bit;
                } else {
                    self.gpio.ext_driven &= !bit;
                }
            }
        }
    }

    pub fn gpio_changed(&mut self, now: u64) {
        self.i2c_pins_settle(now);
        self.gpio.sense();
        let lv = self.gpio.level();
        if lv != self.last_gpio {
            self.last_gpio = lv;
            self.iotrace.gpio(now, lv);
            self.gpio_log.push((now, lv));
            if self.gpio_log.len() > 1 << 16 {
                self.gpio_log.drain(..1 << 15);
            }
            self.pins.on_level(now, lv);
            self.lcd_pins_changed(lv);
        }
        self.feed_rmt_rx(now, lv);
        self.irq_dirty = true;
    }

    /// RMT RX inputs RMT_SIG_IN0..7 = 83..90 (FUNCn_IN_SEL_CFG: pin [5:0], inv [6], via matrix [7]; 0x38 = 1, 0x30 = 0)
    fn feed_rmt_rx(&mut self, t: u64, lv: u64) {
        for i in 0..self.rmt.rx_count() {
            let f = self.gpio.func_in[83 + i];
            if f & (1 << 7) == 0 {
                continue;
            }
            let v = match f & 0x3f {
                0x38 => true,
                p if (p as usize) < NPINS => lv >> p & 1 != 0,
                _ => false,
            };
            self.rmt.rx_input(i, t, v != (f & (1 << 6) != 0));
        }
    }

    /// Apply external pin devices' drive up to now, in time order; returns when to poll them next
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
                let bit = 1u64 << pin;
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

    /// Current level of every interrupt source (69 sources)
    pub fn levels(&self) -> [u64; 2] {
        let mut l = [0u64; 2];
        let mut set = |s: u32, on: bool| {
            if on {
                l[(s / 64) as usize] |= 1 << (s % 64);
            }
        };
        set(src::UART0, self.uart0.irq());
        set(src::UART1, self.uart1.irq());
        set(src::UART2, self.uart2.irq());
        set(src::GPIO, self.gpio.irq());
        set(src::LEDC, self.ledc.irq());
        set(src::RMT, self.rmt.irq());
        set(src::I2C_EXT0, self.i2c0.irq());
        set(src::I2C_EXT1, self.i2c1.irq());
        set(src::SPI2, self.hspi.irq());
        set(src::SPI3, self.vspi.irq());
        set(src::SPI2_DMA, self.hspi.dma_irq());
        set(src::SPI3_DMA, self.vspi.dma_irq());
        set(src::TG0_T0, self.timg0.irq(0));
        set(src::TG0_T1, self.timg0.irq(1));
        set(src::TG0_LACT, self.timg0.irq(2));
        set(src::TG1_T0, self.timg1.irq(0));
        set(src::TG1_T1, self.timg1.irq(1));
        set(src::TG1_LACT, self.timg1.irq(2));
        set(src::TG0_WDT, self.timg0.wdt_irq());
        set(src::TG1_WDT, self.timg1.wdt_irq());
        set(src::WIFI_MAC, self.wifi().irq());
        set(i2s::SRC[0], self.i2s[0].irq());
        set(i2s::SRC[1], self.i2s[1].irq());
        for i in 0..4 {
            set(src::FROM_CPU0 + i, self.dport.from_cpu & (1 << i) != 0);
        }
        l
    }

    /// Route RMT output edges through the GPIO matrix to pins and their WS2812 decoders (as C3 / S3);
    /// returns when a decoder next needs checking (end-of-frame detection)
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
            if self.pins.rmt_ir(&self.rmt, pin, ch, &edges) {
                self.gpio.set_periph_level(pin, self.rmt.level[ch as usize]);
                continue;
            }
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

    fn trace_pwm(&mut self, now: u64) {
        let rev = self.ledc.rev();
        if !self.iotrace.pwm_scan_needed(rev) {
            return;
        }
        self.iotrace.pwm_dirty = false;
        self.iotrace.ledc_rev = rev;
        for pin in 0..NPINS {
            let p = self.pin_pwm(pin);
            self.iotrace.pwm(now, pin, p);
        }
    }

    /// PWM on a pin: the LEDC channel routed to it through the GPIO matrix, as (duty, frequency)
    pub fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)> {
        let f = *self.gpio.func_out.get(pin)?;
        if self.gpio.enable & (1 << pin) == 0 {
            return None;
        }
        let (d, hz) = self.ledc.output(f & 0x1ff)?;
        let inv = f & (1 << 9) != 0;
        Some((if inv { 1.0 - d } else { d }, hz))
    }

    pub fn update(&mut self) {
        let now = self.now;
        let n1 = self.timg0.update(now).min(self.timg1.update(now));
        if let Some(r) = self.timg0.t[0]
            .wdt_reset
            .take()
            .or_else(|| self.timg1.t[0].wdt_reset.take())
        {
            self.reset_request = Some(r);
        }
        let n2 = self.ledc.update(now);
        // Sync RX inputs to the pin level (a channel routed after the pin's last change still sees its idle level)
        self.feed_rmt_rx(now, self.last_gpio);
        let n2 = n2.min(self.rmt.update(now)).min(self.route_rmt(now));
        let n3 = self.i2c0.update(now).min(self.i2c1.update(now));
        let n3 = n3.min(self.hspi.update(now)).min(self.vspi.update(now));
        let n4 = self.pins_update(now);
        let n5 = {
            // Infallible: wifi is set at construction and only taken around write/update,
            // whose Mem callbacks reach RAM only (never this register path).
            let mut w = self.wifi.take().expect("wifi");
            let n = w.update(now, self);
            self.wifi = Some(w);
            n
        };
        let n6 = self.i2s_update(now, 0).min(self.i2s_update(now, 1));
        self.trace_pwm(now);
        self.lcd_pwm_backlight();
        self.next_event = n1.min(n2).min(n3).min(n4).min(n5).min(n6);
        let lv = self.levels();
        let (l0, r0) = self.dport.pro.lines(&lv);
        let (l1, r1) = self.dport.app.lines(&lv);
        self.lines = [l0 | r0, l1 | r1];
        self.irq_dirty = false;
    }
}

impl DmaMem for SocBus {
    fn rd8(&mut self, a: u32) -> u8 {
        self.mem_read(a, 1).unwrap_or(0) as u8
    }
    fn rd32(&mut self, a: u32) -> u32 {
        self.mem_read(a, 4).unwrap_or(0)
    }
    fn wr8(&mut self, a: u32, v: u8) {
        self.mem_write(a, 1, v as u32);
    }
    fn wr32(&mut self, a: u32, v: u32) {
        self.mem_write(a, 4, v);
    }
}

impl Bus for SocBus {
    fn sp_loaded(&mut self, core: u32, base: u32, cycles: u64) {
        if self.tasks.cap == 0 {
            return;
        }
        let mut t = std::mem::replace(&mut self.tasks, TaskTrace::new(4));
        t.on_sp_load(core, base, cycles, true, &|a| self.mem_read(a, 4));
        self.tasks = t;
    }
    #[inline]
    fn load(&mut self, a: u32, size: u32) -> Result<u32, BusFault> {
        if let Some(o) = Self::sram_off(a) {
            if let Some(v) = rd(&self.sram, o, size) {
                return Ok(v);
            }
        }
        if let Some(v) = self.mem_read(a, size) {
            return Ok(v);
        }
        if let Some(m) = Self::mmio_addr(a) {
            let v = self.mmio_read(m & !3);
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
        if let Some(o) = Self::sram_off(a) {
            if wr(&mut self.sram, o, size, v).is_some() {
                return Ok(());
            }
        }
        if self.mem_write(a, size, v).is_some() {
            return Ok(());
        }
        if let Some(m) = Self::mmio_addr(a) {
            let aa = m & !3;
            let v = if size == 4 {
                v
            } else {
                // Sub-word write: merge with the current value (not for UART FIFO, whose read pops)
                let sh = (a & 3) * 8;
                let mask = if size == 2 { 0xffff } else { 0xff } << sh;
                let old = if aa == UART0 || aa == UART1 || aa == UART2 {
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
        let o = (a & 0xffff) as usize;
        if a >> 16 == self.fetch_page && o <= 0xfffc {
            let buf = match self.fetch_src {
                FetchSrc::Sram => &self.sram,
                FetchSrc::Flash => &self.flash,
                FetchSrc::Rom => &self.rom,
            };
            let i = self.fetch_base + o;
            if let Some(b) = buf.get(i..i + 4) {
                return Ok(u32::from_le_bytes([b[0], b[1], b[2], 0]));
            }
        }
        self.fetch_slow(a)
    }

    #[inline(always)]
    fn attention(&mut self, cycles: u64) -> bool {
        if self.irq_dirty {
            return true;
        }
        if cycles > self.now {
            self.now = cycles;
        }
        self.now >= self.next_event
    }
}

impl SocBus {
    /// Fetch slow path; also fills the fetch page cache (only page-contiguous SRAM0, ROM, IROM; not SRAM1's reversed view)
    #[inline(never)]
    fn fetch_slow(&mut self, a: u32) -> Result<u32, BusFault> {
        self.fetch_page = u32::MAX;
        let page = a & !0xffff;
        if (IRAM_LOW..IRAM_HIGH).contains(&page) {
            self.fetch_page = a >> 16;
            self.fetch_src = FetchSrc::Sram;
            self.fetch_base = SRAM0_OFF + (page - IRAM_LOW) as usize;
        } else if (ROM_LOW..ROM_HIGH).contains(&page) {
            self.fetch_page = a >> 16;
            self.fetch_src = FetchSrc::Rom;
            self.fetch_base = (page - ROM_LOW) as usize;
        } else if (IROM_LOW..IROM_HIGH).contains(&page) {
            if let Some(f) = self.flash_addr(page) {
                self.fetch_page = a >> 16;
                self.fetch_src = FetchSrc::Flash;
                self.fetch_base = f;
            }
        }
        if !(IRAM1_LOW..IRAM1_HIGH).contains(&a) {
            if let Some(v) = self.mem_read(a, 4) {
                return Ok(v & 0xff_ffff);
            }
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
    Fault { cause: u32, epc: u32, vaddr: u32 },
    Break(u32),
    Hle(u32),
    Reset(u32),
}

pub struct Esp32 {
    pub cpu: Cpu,
    pub cpu1: Cpu,
    pub cpu1_on: bool,
    pub bus: SocBus,
    pub rom_symbols: HashMap<u32, String>,
    pub hle: HashMap<u32, hle::Hle>,
    pub rom_elf: Vec<u8>,
}

const QUANTUM: u64 = 256;

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
        if cpu.cycles > bus.now {
            bus.now = cpu.cycles;
        }
        if bus.irq_dirty || bus.now >= bus.next_event {
            bus.update();
            // A watchdog stage timeout can request a reset from a timer event, not only from an RTC_CNTL write
            if let Some(r) = bus.reset_request.take() {
                return Some(Stop::Reset(r));
            }
            cpu.set_irq_lines(bus.lines[k]);
        }
        match cpu.run_batch(bus, until, 0x4000_0300, 0x4000_0400) {
            Exit::Normal => {
                let pc = cpu.pc;
                if (0x4000_0300..0x4000_0400).contains(&pc) && cpu.read_sr(sr::VECBASE) == ROM_LOW {
                    return Some(Stop::Fault {
                        cause: cpu.read_sr(sr::EXCCAUSE),
                        epc: cpu.read_sr(sr::EPC1),
                        vaddr: cpu.read_sr(sr::EXCVADDR),
                    });
                }
                if bus.irq_dirty {
                    if let Some(r) = bus.reset_request.take() {
                        return Some(Stop::Reset(r));
                    }
                    bus.update();
                    cpu.set_irq_lines(bus.lines[k]);
                }
            }
            Exit::Waiti => {
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
            Exit::Simcall => {}
        }
    }
    None
}

impl Esp32 {
    pub fn run(&mut self, budget: u64) -> Stop {
        let end = self.cpu.cycles.saturating_add(budget);
        while self.cpu.cycles < end {
            let q_end = (self.cpu.cycles + QUANTUM).min(end);
            let both_idle = !self.cpu1_on || self.cpu1.waiting;
            let idle0 = if both_idle { end } else { q_end };
            if let Some(s) = run_core(0, &mut self.cpu, &mut self.bus, &self.hle, q_end, idle0) {
                return s;
            }
            if std::mem::take(&mut self.bus.appcpu_reset) {
                self.cpu1_on = false;
            }
            if self.cpu1_on {
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
    fn mmu_windows() {
        let mut b = SocBus {
            flash: vec![0; 1 << 20],
            ..Default::default()
        };
        b.flash[0x2_0004] = 0xab;
        b.flash[0x3_0008] = 0xcd;
        // DROM 0x3F410000 -> entry 1; IROM 0x400D0000 -> entry 64 + 13
        b.mmu[1] = 2;
        b.mmu[77] = 3;
        assert_eq!(b.mem_read(0x3F41_0004, 1), Some(0xab));
        assert_eq!(b.mem_read(0x400D_0008, 1), Some(0xcd));
        assert_eq!(Bus::fetch(&mut b, 0x400D_0008).unwrap() & 0xff, 0xcd);
        assert_eq!(b.mem_read(0x3F42_0000, 4), None);
        // MMU written through its DPORT address
        Bus::store(&mut b, MMU_PRO + 4 * 2, 4, 2).unwrap();
        assert_eq!(b.mem_read(0x3F42_0004, 1), Some(0xab));
    }

    #[test]
    fn psram_mmu_window() {
        let mut b = SocBus::default();
        b.spi1.psram = psram::QuadPsram::with_size(8 << 20);
        // Entry 1152 + 1 (0x3F808000) -> PSRAM page 5, written through the PRO table like cache_sram_mmu_set
        Bus::store(&mut b, MMU_PRO + 4 * 1153, 4, 5).unwrap();
        Bus::store(&mut b, MMU_APP + 4 * 1153, 4, 5).unwrap();
        assert_eq!(Bus::load(&mut b, MMU_PRO + 4 * 1153, 4).unwrap(), 5);
        Bus::store(&mut b, 0x3F80_8010, 4, 0xdead_beef).unwrap();
        assert_eq!(b.spi1.psram.mem[5 * 0x8000 + 0x10], 0xef);
        assert_eq!(Bus::load(&mut b, 0x3F80_8012, 2).unwrap(), 0xdead);
        // Invalid entry faults; a smaller chip wraps high pages
        Bus::store(&mut b, MMU_PRO + 4 * 1154, 4, MMU_INVALID).unwrap();
        assert!(Bus::load(&mut b, 0x3F81_0000, 4).is_err());
        b.spi1.psram = psram::QuadPsram::with_size(2 << 20);
        Bus::store(&mut b, 0x3FA0_0000, 1, 0x77).unwrap();
        assert_eq!(b.spi1.psram.mem[0], 0x77);
        // No chip: the window faults
        b.spi1.psram = psram::QuadPsram::default();
        assert!(Bus::load(&mut b, 0x3F80_0000, 4).is_err());
    }

    /// psram_read_id as IDF issues it: SPI1 user command with CS1 selected, 8-byte MISO
    fn psram_id(b: &mut SocBus, short_cmd: bool) -> u32 {
        let spi = 0x3FF4_2000;
        Bus::store(b, spi + 0x34, 4, 1).unwrap();
        let (user1, user2, addr) = if short_cmd {
            (31 << 26, 1 << 28, 0x9f00_0000)
        } else {
            (23 << 26, (7 << 28) | 0x9f, 0)
        };
        Bus::store(b, spi + 0x1c, 4, (1 << 31) | (1 << 30) | (1 << 28)).unwrap();
        Bus::store(b, spi + 0x20, 4, user1).unwrap();
        Bus::store(b, spi + 0x24, 4, user2).unwrap();
        Bus::store(b, spi + 0x2c, 4, 63).unwrap();
        Bus::store(b, spi + 0x04, 4, addr).unwrap();
        Bus::store(b, spi, 4, 1 << 18).unwrap();
        Bus::store(b, spi + 0x34, 4, 2).unwrap();
        Bus::load(b, spi + 0x80, 4).unwrap()
    }

    #[test]
    fn psram_id_via_spi1_cs1() {
        let mut b = SocBus::default();
        // Without a chip MISO floats high, as on a PSRAM-less module
        assert_eq!(psram_id(&mut b, false), 0xffff_ffff);
        b.spi1.psram = psram::QuadPsram::with_size(8 << 20);
        assert_eq!(psram_id(&mut b, false) & 0xff_ffff, 0x52_5d0d);
        b.spi1.psram = psram::QuadPsram::with_size(2 << 20);
        assert_eq!(psram_id(&mut b, true) & 0xff_ffff, 0x12_5d0d);
        assert_eq!(b.spi1.psram.commands, 1);
        // CS0 again: the same command reaches the flash
        let spi = 0x3FF4_2000;
        Bus::store(&mut b, spi + 0x24, 4, (7 << 28) | 0x9f).unwrap();
        Bus::store(&mut b, spi, 4, 1 << 18).unwrap();
        assert_eq!(
            Bus::load(&mut b, spi + 0x80, 4).unwrap() & 0xff_ffff,
            0x16_40c8
        );
    }

    #[test]
    fn flash_id_follows_header_size() {
        assert_eq!(boot::jedec_for_size(0x16_40c8, 2 << 20), 0x16_40c8);
        assert_eq!(boot::jedec_for_size(0x16_40c8, 8 << 20), 0x17_40c8);
        assert_eq!(boot::jedec_for_size(0x16_40c8, 16 << 20), 0x18_40c8);
    }

    #[test]
    fn sram_views() {
        let mut b = SocBus::default();
        // SRAM1: word at D 0x3FFFFFFC == word at I 0x400A0000 (word-reversed)
        b.mem_write(0x3FFF_FFFC, 4, 0x1122_3344).unwrap();
        assert_eq!(b.mem_read(0x400A_0000, 4), Some(0x1122_3344));
        assert_eq!(b.mem_read(0x400A_0001, 1), Some(0x33));
        b.mem_write(0x400A_0004, 4, 7).unwrap();
        assert_eq!(b.mem_read(0x3FFF_FFF8, 4), Some(7));
        // RTC fast memory: I and D are the same block
        b.mem_write(0x3FF8_0010, 4, 9).unwrap();
        assert_eq!(b.mem_read(0x400C_0010, 4), Some(9));
    }

    #[test]
    fn ahb_alias_and_reset_bits() {
        let mut b = SocBus::default();
        Bus::store(&mut b, 0x6000_0000, 4, b'A' as u32).unwrap();
        assert_eq!(b.console, b"A");
        Bus::store(&mut b, RTC_CNTL, 4, 0x10 | 0x4).unwrap();
        assert!(b.appcpu_reset && b.reset_request.is_none());
        assert_eq!(Bus::load(&mut b, RTC_CNTL, 4).unwrap(), 0x4);
        Bus::store(&mut b, RTC_CNTL, 4, 1 << 31).unwrap();
        assert_eq!(b.reset_request, Some(3));
        b.reset_reason = 12;
        assert_eq!(
            Bus::load(&mut b, RTC_CNTL_RESET_STATE, 4).unwrap() & 0xfff,
            12 | (12 << 6)
        );
    }

    #[test]
    fn dport_intmatrix_routes_timer() {
        let mut b = SocBus::default();
        // TG0 LACT -> core 0 line 3 (level-triggered)
        Bus::store(&mut b, 0x3FF0_0000 + 0x104 + 4 * src::TG0_LACT, 4, 3).unwrap();
        b.timg0.int_ena = 8;
        b.timg0.t[2].int_raw = 1;
        b.update();
        assert_eq!(b.lines[0], 1 << 3);
        assert_eq!(b.lines[1], 0);
    }
}
