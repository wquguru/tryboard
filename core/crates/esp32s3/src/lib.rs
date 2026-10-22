//! ESP32-S3 SoC: memory map (incl. PSRAM), peripheral dispatch, direct boot, dual-core run loop.
//! Core 1 starts when firmware calls ROM's ets_set_appcpu_boot_addr (HLE); the cores alternate in fixed quanta (deterministic).
//! Peripherals shared with C3 with identical layout (UART, SYSTIMER, TIMG, SPI1 flash, LEDC, I2C, RMT, GP-SPI2, GDMA)
//! reuse tryboard-soc models; S3-only interrupt matrix, EXTMEM and 49-pin GPIO live in periph.rs. Wi-Fi MAC and
//! the virtual world are in tryboard-soc (shared with C3, wired up with the S3 layout). lint: allow-long-comment

pub mod ble;
pub mod boot;
mod chip;
pub mod hle;
pub mod periph;
pub mod psram;
mod spi_lcd;
mod spi_rc522;
mod usj_console;
/// USB OTG model lives in tryboard-soc (R-06); re-exported for `usb::` paths in this crate
pub use tryboard_soc::usb;

use periph::*;
use std::collections::HashMap;
use tryboard_soc::crypto_hw::{self, AesHw, ShaHw};
use tryboard_soc::devices::audio::{self, Audio, PortIo};
use tryboard_soc::devices::lcd::{Lcd, LcdPins};
use tryboard_soc::devices::pins::PinDevices;
use tryboard_soc::gdma::{DmaMem, Gdma, GdmaLayout};
use tryboard_soc::i2cpins::PinBuses;
use tryboard_soc::pcnt::{self as pcnt_mod, Pcnt};
use tryboard_soc::periph::{Systimer, Timg, Uart};
use tryboard_soc::rmt::{Rmt, RmtLayout, Ws2812};
use tryboard_soc::spiflash::SpiFlash;
use tryboard_soc::tasktrace::TaskTrace;
use tryboard_soc::usj::Usj;
use tryboard_soc::wifi::{self, WifiLayout, WifiMac};
use tryboard_soc::{gpspi::GpSpi, i2c::I2c, i2s::I2s, iotrace::IoTrace, ledc::Ledc};
use tryboard_xtensa::{sr, Bus, BusFault, Cpu, Exit};

pub const CPU_HZ: u64 = tryboard_soc::periph::CPU_HZ;

// Memory map (soc/esp32s3/include/soc/soc.h)
/// SRAM0 (32KB, I bus only) + SRAM1 (416KB, mapped on both I and D)
pub const IRAM_LOW: u32 = 0x4037_0000;
pub const IRAM_HIGH: u32 = 0x403E_0000;
/// D-bus alias of SRAM1 + SRAM2 (64KB, D bus only)
pub const DRAM_LOW: u32 = 0x3FC8_8000;
pub const DRAM_HIGH: u32 = 0x3FD0_0000;
/// D 0x3FC88000 and I 0x40378000 are the same SRAM1
pub const DRAM_TO_IRAM: u32 = 0x4037_8000 - DRAM_LOW;
/// SRAM buffer: SRAM0 + SRAM1 + SRAM2 = 512KB, laid out from IRAM address 0x40370000
pub const SRAM_SIZE: usize = 512 << 10;
pub const ROM_LOW: u32 = 0x4000_0000;
pub const ROM_HIGH: u32 = 0x4006_0000;
pub const DROM_MASK_LOW: u32 = 0x3FF0_0000;
pub const DROM_MASK_HIGH: u32 = 0x3FF2_0000;
pub const DROM_MASK_TO_ROM: u32 = 0x4004_0000 - DROM_MASK_LOW;
/// Cache windows are 32MB each; I/D share one MMU table (linear address = vaddr & 0x1FFFFFF)
pub const IROM_LOW: u32 = 0x4200_0000;
pub const IROM_HIGH: u32 = 0x4400_0000;
pub const DROM_LOW: u32 = 0x3C00_0000;
pub const DROM_HIGH: u32 = 0x3E00_0000;
/// RTC slow memory (8KB) and RTC fast memory (8KB, same address on I/D)
pub const RTC_SLOW_LOW: u32 = 0x5000_0000;
pub const RTC_SLOW_HIGH: u32 = 0x5000_2000;
pub const RTC_FAST_LOW: u32 = 0x600F_E000;
pub const RTC_FAST_HIGH: u32 = 0x6010_0000;
pub const MMIO_LOW: u32 = 0x6000_0000;
pub const MMIO_HIGH: u32 = 0x600D_1000;

pub const MMU_BASE: u32 = 0x600C_5000;
pub const MMU_ENTRIES: usize = 512;
/// MMU entry: bits 13..0 physical page, bit 14 invalid, bit 15 type (0 flash, 1 PSRAM)
pub const MMU_INVALID: u32 = 1 << 14;
pub const MMU_PSRAM: u32 = 1 << 15;

/// N16R8: 16MB flash + 8MB octal PSRAM (the most common S3 dev board configuration)
pub const PSRAM_SIZE: usize = 8 << 20;

/// Software reset bits of RTC_CNTL_OPTIONS0 (rtc_cntl_reg.h): system reset, core 0 reset, core 1 reset
const RST_SYS: u32 = 1 << 31;
const RST_PROCPU: u32 = 1 << 5;
const RST_APPCPU: u32 = 1 << 4;
pub const RTC_CNTL_RESET_STATE: u32 = 0x6000_8038;
/// Hardware RNG (soc/esp32s3/include/soc/wdev_reg.h: WDEV_RND_REG); on C3 it's at 0x600260B0
pub const WDEV_RND_REG: u32 = 0x6003_507C;
/// RTC_CNTL_STORE0..7: in the RTC domain, kept across CPU / system reset (reset-reason hints, boot time, RTC slow clock
/// calibration, etc.). STORE4 / STORE5 (crystal / APB frequency) are rewritten by ROM every boot, so need not be kept
const RTC_STORE_KEEP: [u32; 6] = [
    0x6000_8050,
    0x6000_8054,
    0x6000_8058,
    0x6000_805C,
    0x6000_80C8,
    0x6000_80CC,
];
pub use spi_lcd::{co5300_pin, lcd_pin};
/// GDMA peripheral IDs (soc/gdma_channel.h: SOC_GDMA_TRIG_PERIPH_SPI2 / _I2S0 / _I2S1)
pub(crate) const GDMA_PERI_SPI2: u32 = 0;
pub(crate) const GDMA_PERI_SPI3: u32 = 1;
const GDMA_PERI_I2S: [u32; 2] = [3, 4];
/// GPIO matrix signals (gpio_sig_map.h): I2S0O_SD_OUT_IDX = I2S0I_SD_IN_IDX = 25, I2S1 is 30
const SIG_I2S_SD: [usize; 2] = [25, 30];
/// I2S audio wiring convention: speaker (MAX98357A) on 16/17/18, mic (INMP441) on 39/40/41 -- avoiding the round
/// display (10..15), I2C (8/9), servo / LED (4/5), WS2812 (48), USB (19/20) and octal PSRAM (33..37)
pub mod i2s_pin {
    pub const SPK_BCLK: u32 = 16;
    pub const SPK_LRC: u32 = 17;
    pub const SPK_DIN: u32 = 18;
    pub const MIC_SCK: u32 = 39;
    pub const MIC_WS: u32 = 40;
    pub const MIC_SD: u32 = 41;
}

const SIG_FSPICS0: u32 = 110;

pub struct SocBus {
    pub sram: Vec<u8>,
    pub rtc_slow: Vec<u8>,
    pub rtc_fast: Vec<u8>,
    pub rom: Vec<u8>,
    pub flash: Vec<u8>,
    pub psram: Vec<u8>,
    /// Command interface of the PSRAM chip (mode registers); storage is `psram`
    pub psram_chip: psram::Psram,
    pub mmu: Vec<u32>,
    /// Fetch page cache: the 64KB page of the last fetch (vaddr >> 16, u32::MAX = invalid), which storage it's in
    /// (`FetchSrc`) and the page start's offset there. Invalidated on MMU writes
    fetch_page: u32,
    fetch_src: FetchSrc,
    fetch_base: usize,
    pub now: u64,
    pub uart0: Uart,
    pub uart1: Uart,
    pub systimer: Systimer,
    pub timg0: Timg,
    pub timg1: Timg,
    pub intm: Intmatrix,
    /// Core 1 interrupt matrix (INTERRUPT_CORE1_*, 0x800 after core 0's table)
    pub intm1: Intmatrix,
    /// Each core's current external interrupt lines (computed in update, handed over before that core runs)
    pub lines: [u32; 2],
    /// Core 1 entry requested by firmware (ets_set_appcpu_boot_addr, set in HLE)
    pub appcpu_boot: Option<u32>,
    pub ble: ble::Slot,
    pub gpio: Gpio,
    pub spi1: SpiFlash,
    pub extmem: Extmem,
    pub ledc: Ledc,
    pub analog: Analog,
    /// Native USB OTG (Option only so it can be taken out while advancing, letting controller DMA borrow the bus; always Some otherwise)
    pub usb: Option<Box<usb::Usb>>,
    /// RMT (4 TX + 4 RX) and WS2812 decoders hanging on pins
    pub rmt: Rmt,
    pub ws2812: HashMap<u32, Ws2812>,
    /// Pulse counter (4 units, P2-01)
    pub pcnt: Pcnt,
    /// External devices wired straight to GPIO that output timed waveforms (rotary encoder, HC-SR04)
    pub pins: PinDevices,
    /// I2C0 (0x60013000) / I2C1 (0x60027000), same model as C3
    pub i2c0: I2c,
    pub i2c1: I2c,
    /// Buses on fixed SDA / SCL pads (M5-02): reached by the routed controller or by bit-banged GPIO
    pub i2c_pins: PinBuses,
    /// Board key matrix scanned through GPIO (M5-08 Cardputer)
    pub keymatrix: Option<tryboard_soc::devices::keymatrix::KeyMatrix>,
    /// GP-SPI2 master + GDMA (5 channels), model shared with the C3 family
    pub spi2: GpSpi,
    /// GP-SPI3 (0x60025000), same model; M5GFX re-inits AtomS3 / Cardputer panels on it after probing on SPI2
    pub spi3: GpSpi,
    pub gdma: Gdma,
    /// Screen on SPI2 / SPI3 (CLI `--spi gc9a01|co5300|...[@pins]` / wasm `tb_lcd_attach`)
    pub lcd: Option<Box<Lcd>>,
    /// GPIOs of a DCS panel (`LcdPins::S3_DEFAULT` unless attached with pins)
    pub lcd_pins: LcdPins,
    /// I2S0 (0x6000F000) / I2S1 (0x6002D000), same model as C3; plus the audio devices on them (pins: see `i2s_pin`)
    pub i2s: [I2s; 2],
    pub audio: Audio,
    /// SAR ADC one-shot sampling (SENS)
    pub adc: SensAdc,
    /// Wi-Fi MAC + virtual world (Option only so it can be taken out to borrow the bus while advancing / sending; always Some otherwise)
    pub wifi: Option<Box<WifiMac>>,
    /// SHA / AES accelerators (WPA2 PBKDF2, MIC and key unwrap go through them via mbedTLS)
    pub sha: ShaHw,
    pub aes: AesHw,
    /// WDEV_RND_REG state (xorshift, fixed seed, reproducible)
    pub rng: u32,
    pub efuse: [u32; 0x200 / 4],
    /// SYSTEM_CPU_INTR_FROM_CPU_0..3
    pub from_cpu: u32,
    /// USB-Serial-JTAG serial port (virtual host attached by default)
    pub usj: Usj,
    /// Cycle of the last UART0 TX byte and the recent UART0 bytes, to spot IDF's secondary-console mirror on USJ
    last_uart0_tx: Option<u64>,
    uart0_recent: Vec<u8>,
    pub console: Vec<u8>,
    pub regs: HashMap<u32, u32>,
    pub unimpl: HashMap<u32, u64>,
    /// Instruction cost from the CPU clock registers, copied into both cores (`Cpu::cpi3`)
    pub cpi3: u32,
    pub irq_dirty: bool,
    pub next_event: u64,
    pub gpio_log: Vec<(u64, u64)>,
    last_gpio: u64,
    /// Logic analyzer events (P1-05; model and format in tryboard_soc::iotrace)
    pub iotrace: IoTrace,
    /// FreeRTOS task switches (C-04; model in tryboard_soc::tasktrace)
    pub tasks: TaskTrace,
    /// Firmware requested a reset (RTC_CNTL_OPTIONS0 SW_SYS_RST / SW_PROCPU_RST); value is the next boot's reset reason
    pub reset_request: Option<u32>,
    /// Firmware reset core 1 alone (SW_APPCPU_RST): esp_restart first resets and stalls the other core
    pub appcpu_reset: bool,
    /// This boot's reset reason (RTC_CNTL_RESET_STATE, 6 bits per core): 1 power-on, 3 software system reset, 12 software CPU reset
    pub reset_reason: u32,
}

impl Default for SocBus {
    fn default() -> Self {
        // GD25Q128: 16MB
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
            psram_chip: psram::Psram::default(),
            mmu: vec![MMU_INVALID; MMU_ENTRIES],
            fetch_page: u32::MAX,
            fetch_src: FetchSrc::Sram,
            fetch_base: 0,
            now: 0,
            uart0: Uart::default(),
            uart1: Uart::default(),
            systimer: Systimer::default(),
            timg0: Timg::apb_wdt(0),
            timg1: Timg::apb_wdt(1),
            intm: Intmatrix::default(),
            intm1: Intmatrix::default(),
            lines: [0; 2],
            appcpu_boot: None,
            ble: ble::Slot::default(),
            gpio: Gpio::default(),
            spi1,
            extmem: Extmem::default(),
            ledc: Ledc::default(),
            analog: Analog::default(),
            usb: Some(Box::default()),
            rmt: Rmt::new(RmtLayout::S3),
            ws2812: HashMap::new(),
            pcnt: Pcnt::default(),
            pins: PinDevices::default(),
            i2c0: I2c::default(),
            i2c1: I2c::with_port(tryboard_soc::iotrace::i2cbit::PORT1),
            i2c_pins: PinBuses::default(),
            keymatrix: None,
            spi2: GpSpi::default(),
            spi3: GpSpi::default(),
            gdma: Gdma::new(GdmaLayout::S3),
            lcd: None,
            lcd_pins: LcdPins::S3_DEFAULT,
            i2s: [I2s::new(0, true), I2s::new(1, true)],
            audio: Audio::default(),
            adc: SensAdc::default(),
            wifi: Some(Box::new(WifiMac::new(WifiLayout::S3))),
            sha: ShaHw::default(),
            aes: AesHw::default(),
            rng: 0x2545_f491,
            efuse: boot::default_efuse(),
            from_cpu: 0,
            usj: Usj::default(),
            last_uart0_tx: None,
            uart0_recent: Vec::new(),
            console: Vec::new(),
            regs: HashMap::new(),
            unimpl: HashMap::new(),
            cpi3: 3,
            irq_dirty: true,
            next_event: 0,
            gpio_log: Vec::new(),
            last_gpio: 1,
            iotrace: IoTrace::new(1),
            // Xtensa stack frame: PC follows XT_STK_EXIT / XT_SOL_EXIT
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

/// Storage the fetch page cache points to
#[derive(Clone, Copy)]
enum FetchSrc {
    Sram,
    Flash,
    Psram,
    Rom,
}

/// Cache window translation result
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

    /// SRAM offset (IRAM 0x40370000 = 0)
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
            // On the D-bus cache window only pages mapped to PSRAM are writable
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
            0x6001_7000 => return self.pcnt.read(off),
            0x6001_3000 => return self.i2c0.read(off),
            0x6002_7000 => return self.i2c1.read(off),
            0x6002_4000 => return self.spi2.read(off),
            0x6002_5000 => return self.spi3.read(off),
            0x6003_F000 => return self.gdma.read(off),
            crypto_hw::SHA_BASE => return self.sha.read(off),
            crypto_hw::AES_BASE => return self.aes.read(off),
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
            0x6003_8000 => {
                if let Some(v) = self.usj.read(off, now) {
                    if off == 0 {
                        // Popping OUT data can clear DATA_AVAIL / the pending packet interrupt
                        self.irq_dirty = true;
                    }
                    return v;
                }
            }
            // I2C_MST_ANA_CONF0 (regi2c_defs.h): BBPLL calibration done bit (bit 24) -- PLL calibration completes instantly
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
        if a == WDEV_RND_REG {
            // Every read yields a new value (esp_random, lwIP ports / DNS transaction IDs depend on it)
            let mut x = self.rng;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            self.rng = x;
            return x;
        }
        if wifi::MAC_RANGE.contains(&a) {
            if let Some(v) = self.wifi_mut().read(a, now) {
                return v;
            }
        }
        if let Some(v) = boot::special_read(a, now) {
            return v;
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
                    self.last_uart0_tx = Some(now);
                    // Line ends dropped: the USJ copy of a line can be flushed before UART0 gets its CR LF
                    if !matches!(v as u8, b'\r' | b'\n') {
                        self.uart0_recent.push(v as u8);
                    }
                    if self.uart0_recent.len() > 8192 {
                        self.uart0_recent.drain(..4096);
                    }
                }
                return;
            }
            0x6001_0000 => return self.uart1.write(off, v),
            // SPI1 user command: goes to PSRAM when CS1 is selected, otherwise to flash
            0x6000_2000
                if off == 0 && v & (1 << 18) != 0 && psram::Psram::selected(&self.spi1.regs) =>
            {
                // A command the die ignores is reported against the SPI1 CMD register
                if !self
                    .psram_chip
                    .user_transaction(&mut self.spi1.regs, &mut self.psram)
                {
                    *self.unimpl.entry(0x6000_2000).or_insert(0) += 1;
                }
                return;
            }
            0x6000_2000 => return self.spi1.write(off, v, &mut self.flash),
            // Reset bits are pulses (self-clearing in hardware): only record the request and store the value without them, so later read-modify-writes don't retrigger
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
                // Enable (0x20..0x38, incl. GPIO32+) and output signal select (FUNC_OUT_SEL from 0x554) decide which pin carries PWM
                if (0x20..0x38).contains(&off) || off >= 0x554 {
                    self.iotrace.pwm_dirty = true;
                }
                self.gpio_changed(now);
                return;
            }
            // eFuse read registers are read-only; writes to CMD etc. aren't stored and read back 0 ("command done")
            0x6000_7000 if off < 0x200 => return,
            0x6000_9000 if (4..=0xc4).contains(&off) => {
                self.gpio.iomux[((off - 4) / 4) as usize] = v;
                self.gpio_changed(now);
                return;
            }
            0x6001_9000 => return self.ledc.write(off, v, now),
            0x6001_6000 => return self.rmt.write(off, v, now),
            0x6001_7000 => {
                self.pcnt.update(now);
                return self.pcnt.write(off, v);
            }
            0x6001_3000 | 0x6002_7000 => {
                // I2CEXT0 SDA/SCL out = 90/89, I2CEXT1 = 92/91 (gpio_sig_map.h)
                let (bus, p, sda, scl) = if base == 0x6001_3000 {
                    (&mut self.i2c0, 0, 90, 89)
                } else {
                    (&mut self.i2c1, 1, 92, 91)
                };
                let routed = self.i2c_pins.route(p, &self.gpio.func_out, 0x1ff, sda, scl);
                let extra = routed.map(|i| &mut self.i2c_pins.buses[i].devices);
                bus.write_with(off, v, now, extra);
                if !bus.events.is_empty() {
                    self.iotrace.extend(&mut bus.events);
                }
                return;
            }
            0x6002_4000 => return self.spi_write(spi_lcd::Host::Spi2, off, v, now),
            0x6002_5000 => return self.spi_write(spi_lcd::Host::Spi3, off, v, now),
            0x6003_F000 => return self.gdma.write(off, v),
            crypto_hw::SHA_BASE => {
                let link = crypto_hw::sha_link(&self.gdma);
                let mut s = std::mem::take(&mut self.sha);
                s.write(off, v, link, self);
                self.sha = s;
                return;
            }
            crypto_hw::AES_BASE => {
                let links = crypto_hw::aes_links(&self.gdma);
                let mut x = std::mem::take(&mut self.aes);
                x.write(off, v, links, self);
                self.aes = x;
                return;
            }
            0x6000_F000 => return self.i2s[0].write(off, v, now),
            0x6002_D000 => return self.i2s[1].write(off, v, now),
            0x6000_8000 if off >= 0x800 => {
                self.adc.wifi_busy = self.wifi.as_deref().is_some_and(|w| w.is_on());
                if self.adc.write(off - 0x800, v) {
                    return;
                }
            }
            0x6001_F000 => return self.timg0.write(off, v, now),
            0x6002_0000 => return self.timg1.write(off, v, now),
            0x6002_3000 => return self.systimer.write(off, v, now),
            0x6003_8000 => {
                if self.usj.write(off, v, now) {
                    self.usj_route();
                    return;
                }
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
                self.fetch_page = u32::MAX;
                return;
            }
            _ => {}
        }
        let mut v = v;
        if wifi::MAC_RANGE.contains(&a) {
            // Infallible: wifi is set at construction and only taken around write/update,
            // whose Mem callbacks reach RAM only (never this register path).
            let mut w = self.wifi.take().expect("wifi");
            let keep = w.write(a, v, now, self);
            self.wifi = Some(w);
            // None = MAC model fully handled it; otherwise store as a generic register (still counted as unimpl)
            match keep {
                Some(x) => v = x,
                None => return,
            }
        }
        *self.unimpl.entry(a).or_insert(0) += 1;
        self.regs.insert(a, v);
        if a == 0x600C_0010 || a == 0x600C_0060 {
            let r = |a| self.regs.get(&a).copied().unwrap_or(0);
            self.cpi3 = tryboard_xtensa::cpi3_for((r(0x600C_0060) >> 10) & 3 == 1, r(0x600C_0010));
        }
    }

    // Infallible: wifi is set at construction and only taken around write/update,
    // whose Mem callbacks reach RAM only (never this register path).
    pub fn wifi(&self) -> &WifiMac {
        self.wifi.as_deref().expect("wifi")
    }
    pub fn wifi_mut(&mut self) -> &mut WifiMac {
        self.wifi.as_deref_mut().expect("wifi")
    }

    pub fn gpio_changed(&mut self, now: u64) {
        self.i2c_pins_settle(now);
        self.gpio.key_matrix_settle(self.keymatrix.as_ref());
        self.gpio.sense();
        let lv = self.gpio.level();
        self.lcd_pins_changed(lv);
        if lv != self.last_gpio {
            self.last_gpio = lv;
            self.iotrace.gpio(now, lv);
            self.gpio_log.push((now, lv));
            if self.gpio_log.len() > 1 << 16 {
                self.gpio_log.drain(..1 << 15);
            }
            self.pins.on_level(now, lv);
        }
        // Pin levels or GPIO matrix input selects may have changed: resample PCNT / RMT RX inputs now
        self.feed_inputs(now, lv);
        self.irq_dirty = true;
    }

    /// Let bit-banged pin buses see the pads; a device's SDA drive changes only while SCL is low, so this settles
    fn i2c_pins_settle(&mut self, now: u64) {
        if self.i2c_pins.is_empty() {
            return;
        }
        for _ in 0..4 {
            let lv = self.gpio.level();
            let fo = &self.gpio.func_out;
            let gpio = |p: u32| fo[p as usize] & 0x1ff == 0x100;
            let drives = self.i2c_pins.on_level(now, lv, gpio);
            if drives.is_empty() {
                return;
            }
            for (pin, low) in drives {
                let bit = 1u64 << pin;
                if low {
                    self.gpio.ext_driven |= bit;
                    self.gpio.ext_in &= !bit;
                } else {
                    self.gpio.ext_driven &= !bit;
                }
            }
        }
    }

    /// Current level of GPIO matrix input signal sig (FUNCn_IN_SEL_CFG: sel[5:0], inv[6], via matrix[7]; 0x38 constant 1, 0x3C constant 0)
    fn sig_level(&self, lv: u64, sig: u32) -> bool {
        let f = self.gpio.func_in[sig as usize];
        if f & (1 << 7) == 0 {
            return false;
        }
        let v = match f & 0x3f {
            0x38 => true,
            0x3c => false,
            p if (p as usize) < NPINS => lv >> p & 1 != 0,
            _ => false,
        };
        v ^ (f & (1 << 6) != 0)
    }

    fn feed_inputs(&mut self, t: u64, lv: u64) {
        let mut sig = [false; pcnt_mod::NSIG];
        for (k, s) in sig.iter_mut().enumerate() {
            *s = self.sig_level(lv, pcnt_mod::SIG0 + k as u32);
        }
        self.pcnt.feed(t, &sig);
        let l = self.rmt.layout;
        for i in 0..l.nrx {
            let s = self.sig_level(lv, l.sig_out0 + i as u32);
            self.rmt.rx_input(i, t, s);
        }
    }

    /// Apply external pin devices' drives up to now at their timestamps; returns when to query them next
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

    /// Current level of all interrupt sources (99 sources, two 64-bit words)
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
        set(src::WIFI_MAC, self.wifi().irq());
        set(src::LEDC, self.ledc.irq());
        set(src::USB, self.usb.as_ref().is_some_and(|u| u.irq()));
        set(src::USB_SERIAL_JTAG, self.usj.irq(self.now));
        set(src::RMT, self.rmt.irq());
        set(src::PCNT, self.pcnt.irq());
        set(src::I2C_EXT0, self.i2c0.irq());
        set(src::I2C_EXT1, self.i2c1.irq());
        set(src::SPI2, self.spi2.irq());
        set(src::SPI3, self.spi3.irq());
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
        set(src::TG0_WDT, self.timg0.wdt_irq());
        set(src::TG1_WDT, self.timg1.wdt_irq());
        for i in 0..4 {
            set(src::FROM_CPU0 + i, self.from_cpu & (1 << i) != 0);
        }
        l
    }

    /// Route RMT edges to pins (levels, IR eyes, WS2812 decoders); returns when a decoder next needs a check (frame end)
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
            self.gpio.set_periph_level(pin, self.rmt.level[ch as usize]);
            if self.pins.rmt_ir(&self.rmt, pin, ch, &edges) {
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
        }
        if !edges.is_empty() {
            // Pins driven by RMT TX may also feed PCNT / RMT RX (loopback)
            self.feed_inputs(now, self.gpio.level());
        }
        edges.clear();
        self.rmt.edges = edges;
        next
    }

    /// LEDC or GPIO matrix changed: hand each pin's current PWM to the event log (unchanged pins aren't logged)
    fn trace_pwm(&mut self, now: u64) {
        if !self.iotrace.pwm_scan_needed(self.ledc.rev) {
            return;
        }
        self.iotrace.pwm_dirty = false;
        self.iotrace.ledc_rev = self.ledc.rev;
        for pin in 0..NPINS {
            let p = self.pin_pwm(pin);
            self.iotrace.pwm(now, pin, p);
            self.pins.ledc_ir(now, pin as u32, p);
        }
    }

    /// PWM on a pin: the LEDC channel output routed to it via the GPIO matrix (duty, frequency).
    /// S3 LEDC output signals are 73..=80 (LEDC_LS_SIG_OUT0..7_IDX)
    pub fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)> {
        let f = *self.gpio.func_out.get(pin)?;
        let sig = f & 0x1ff;
        if (73..=80).contains(&sig) && self.gpio.enable & (1 << pin) != 0 {
            let (d, hz) = self.ledc.output((sig - 73) as usize)?;
            return Some((if f & (1 << 9) != 0 { 1.0 - d } else { d }, hz));
        }
        None
    }

    /// Advance timers and compute external lines from each core's interrupt matrix (stored in lines, handed over on that core's turn)
    pub fn update(&mut self) {
        let now = self.now;
        let n1 = self.systimer.update(now);
        let n2 = self.timg0.update(now);
        let n3 = self.timg1.update(now);
        if let Some(r) = self
            .timg0
            .wdt_reset
            .take()
            .or_else(|| self.timg1.wdt_reset.take())
        {
            self.reset_request = Some(r);
        }
        let n4 = self.ledc.update(now);
        let n5 = self.rmt.update(now);
        let n6 = self.route_rmt(now);
        let n7 = self.i2c0.update(now).min(self.i2c1.update(now));
        let n11 = self.pins_update(now);
        self.pcnt.update(now);
        let n12 = self.pcnt.next_event();
        let (n9, spi_done) = self.spi2.update(now);
        let (n9b, spi3_done) = self.spi3.update(now);
        let n9 = n9.min(n9b);
        self.trace_pwm(now);
        self.lcd_pwm_backlight();
        if spi_done {
            if let Some(ch) = self.spi2.dma_out_ch.take() {
                self.gdma.out_done(ch);
            }
        }
        if spi3_done {
            if let Some(ch) = self.spi3.dma_out_ch.take() {
                self.gdma.out_done(ch);
            }
        }
        let n10 = {
            // Infallible: wifi is set at construction and only taken around write/update,
            // whose Mem callbacks reach RAM only (never this register path).
            let mut w = self.wifi.take().expect("wifi");
            let n = w.update(now, self);
            self.wifi = Some(w);
            n
        };
        let n13 = self.i2s_update(now, 0).min(self.i2s_update(now, 1));
        let n8 = match self.usb.take() {
            Some(mut u) => {
                let n = u.update(now, self);
                self.usb = Some(u);
                n
            }
            None => u64::MAX,
        };
        let n14 = self.usj.next_event(now);
        self.next_event = n1
            .min(n2)
            .min(n3)
            .min(n4)
            .min(n5)
            .min(n6)
            .min(n7)
            .min(n8)
            .min(n9)
            .min(n10)
            .min(n11)
            .min(n12)
            .min(n13)
            .min(n14);
        let lv = self.levels();
        // Edge lines get rising-edge detection in the core itself, so pass both the level and this round's rising edges
        let (l0, r0) = self.intm.lines(&lv);
        let (l1, r1) = self.intm1.lines(&lv);
        self.lines = [l0 | r0, l1 | r1];
        self.irq_dirty = false;
    }
}

impl SocBus {
    /// Advance I2S port k: check via GPIO matrix whether speaker DIN / mic SD sit on this port's data line, then let GDMA borrow the bus to move data
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
        // FUNCn_IN_SEL_CFG: bits 5..0 pin, bit 7 via GPIO matrix
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

    /// Attach a MAX98357A speaker / INMP441 mic (pins: see `i2s_pin`)
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
    fn wr8(&mut self, a: u32, v: u8) {
        self.mem_write(a, 1, v as u32);
    }
    fn wr32(&mut self, a: u32, v: u32) {
        self.mem_write(a, 4, v);
    }
}

impl Bus for SocBus {
    #[inline]
    fn load(&mut self, a: u32, size: u32) -> Result<u32, BusFault> {
        // Fast path: SRAM (same as mem_read's first branch, inlined to save a call)
        if let Some(o) = Self::sram_off(a) {
            if let Some(v) = rd(&self.sram, o, size) {
                return Ok(v);
            }
        }
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
        if let Some(o) = Self::sram_off(a) {
            if wr(&mut self.sram, o, size, v).is_some() {
                return Ok(());
            }
        }
        if self.mem_write(a, size, v).is_some() {
            return Ok(());
        }
        if (MMIO_LOW..MMIO_HIGH).contains(&a) {
            let aa = a & !3;
            let v = if size == 4 {
                v
            } else {
                // Sub-word write: merge with the peripheral's current value (UART FIFO reads have dequeue side effects, so excluded)
                let sh = (a & 3) * 8;
                let mask = if size == 2 { 0xffff } else { 0xff } << sh;
                let old = if aa == 0x6000_0000 || aa == 0x6001_0000 || aa == 0x6003_8000 {
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
        // Fastest path: same 64KB page as the previous instruction, and the 4 bytes don't cross the page
        let o = (a & 0xffff) as usize;
        if a >> 16 == self.fetch_page && o <= 0xfffc {
            let buf = match self.fetch_src {
                FetchSrc::Sram => &self.sram,
                FetchSrc::Flash => &self.flash,
                FetchSrc::Psram => &self.psram,
                FetchSrc::Rom => &self.rom,
            };
            let i = self.fetch_base + o;
            if let Some(b) = buf.get(i..i + 4) {
                return Ok(u32::from_le_bytes([b[0], b[1], b[2], 0]));
            }
        }
        self.fetch_slow(a)
    }

    fn sp_loaded(&mut self, core: u32, base: u32, cycles: u64) {
        if self.tasks.cap == 0 {
            return;
        }
        let mut t = std::mem::replace(&mut self.tasks, TaskTrace::new(4));
        t.on_sp_load(core, base, cycles, true, &|a| self.mem_read(a, 4));
        self.tasks = t;
    }

    #[inline(always)]
    fn attention(&mut self, cycles: u64) -> bool {
        // Same as the top of the run_core loop: peripheral time follows the faster core; with irq_dirty don't advance now yet (run_core updates with the old time first)
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
    /// Fetch slow path: read 4 bytes at once (instructions are at most 3 bytes); fall back to bytewise across region
    /// boundaries. Also fills the fetch page cache (only pages wholly in one storage: IRAM, ROM, MMU-translated IROM pages)
    #[inline(never)]
    fn fetch_slow(&mut self, a: u32) -> Result<u32, BusFault> {
        self.fetch_page = u32::MAX;
        let page = a & !0xffff;
        if (IRAM_LOW..IRAM_HIGH).contains(&page) {
            self.fetch_page = a >> 16;
            self.fetch_src = FetchSrc::Sram;
            self.fetch_base = (page - IRAM_LOW) as usize;
        } else if (ROM_LOW..ROM_HIGH).contains(&page) {
            self.fetch_page = a >> 16;
            self.fetch_src = FetchSrc::Rom;
            self.fetch_base = (page - ROM_LOW) as usize;
        } else if (IROM_LOW..IROM_HIGH).contains(&page) {
            match self.ext_addr(page) {
                Some(Ext::Flash(f)) => {
                    self.fetch_page = a >> 16;
                    self.fetch_src = FetchSrc::Flash;
                    self.fetch_base = f;
                }
                Some(Ext::Psram(p)) => {
                    self.fetch_page = a >> 16;
                    self.fetch_src = FetchSrc::Psram;
                    self.fetch_base = p;
                }
                None => {}
            }
        }
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
    /// Entered a ROM exception vector (app hasn't installed its own VECBASE yet, or the exception came before the app took over)
    Fault {
        cause: u32,
        epc: u32,
        vaddr: u32,
    },
    /// BREAK / BREAK.N
    Break(u32),
    /// Hit an unimplemented HLE function
    Hle(u32),
    /// Firmware requested a reset (esp_restart, restart after panic); call reboot() to power back up
    Reset(u32),
}

pub struct Esp32s3 {
    /// Core 0 (PRO CPU)
    pub cpu: Cpu,
    /// Core 1 (APP CPU), not run until cpu1_on
    pub cpu1: Cpu,
    pub cpu1_on: bool,
    pub bus: SocBus,
    pub rom_symbols: HashMap<u32, String>,
    pub hle: HashMap<u32, hle::Hle>,
    /// Keep a copy of the ROM for power-up after reset
    pub rom_elf: Vec<u8>,
}

/// Quantum (cycles) for alternating cores: small enough for IPIs and spinlocks to take effect promptly, large enough that switching cost is negligible
const QUANTUM: u64 = 256;

/// Run one core until its cycle count reaches `until`. `idle_until`: the furthest time this core may skip ahead to on WAITI.
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
        // Peripheral time follows whichever core is furthest ahead, keeping it monotonic
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
        // Batch-run to the next point needing SoC attention (peripheral event, line change, exception vector); per-instruction checks match the old step-by-step loop
        match cpu.run_batch(bus, until, 0x4000_0300, 0x4000_0400) {
            Exit::Normal => {
                // ROM exception vectors (0x40000300 Kernel / 0x40000340 User / 0x400003C0 Double): in normal app operation
                // VECBASE points into IRAM, so landing here means something went wrong
                let pc = cpu.pc;
                if (0x4000_0300..0x4000_0400).contains(&pc) && cpu.read_sr(sr::VECBASE) == ROM_LOW {
                    return Some(Stop::Fault {
                        cause: cpu.read_sr(sr::EXCCAUSE),
                        epc: cpu.read_sr(sr::EPC1),
                        vaddr: cpu.read_sr(sr::EXCVADDR),
                    });
                }
                if bus.irq_dirty {
                    // Wrote an RTC_CNTL reset bit: this core stops here and the outer loop powers back up
                    if let Some(r) = bus.reset_request.take() {
                        return Some(Stop::Reset(r));
                    }
                    // This core wrote a peripheral (may have cleared / raised an interrupt): recompute now
                    bus.update();
                    cpu.set_irq_lines(bus.lines[k]);
                }
            }
            Exit::Waiti => {
                // Idle: skip ahead to the next peripheral event or CCOMPARE timer interrupt
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
                None if ble::call_at(pc, cpu, bus) => {}
                None => return Some(Stop::Hle(pc)),
            },
            Exit::Break(v) => return Some(Stop::Break(v)),
            // Semihosting call: firmware only uses it in QEMU tests, ignored here
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
            (self.cpu.cpi3, self.cpu1.cpi3) = (self.bus.cpi3, self.bus.cpi3);
            // When both cores are idle they can skip ahead together; otherwise core 0 can't skip past this quantum (core 1 may send it an IPI right away)
            let both_idle = !self.cpu1_on || self.cpu1.waiting;
            let idle0 = if both_idle { end } else { q_end };
            if let Some(s) = run_core(0, &mut self.cpu, &mut self.bus, &self.hle, q_end, idle0) {
                return s;
            }
            if std::mem::take(&mut self.bus.appcpu_reset) {
                // Core 1 was reset: on silicon it returns to ROM awaiting a new boot address (and gets stalled); here we just stop it
                self.cpu1_on = false;
            }
            if self.cpu1_on {
                // Core 1 catches up to core 0's time without passing it
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

    /// Debug: single-step and record PC discontinuities (jump targets)
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
mod tests;
