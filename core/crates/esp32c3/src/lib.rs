//! ESP32-C3 SoC: memory map, peripheral dispatch, direct boot (replaces the 2nd-stage bootloader), run loop.

pub mod ble;
pub mod boot;
mod chip;
#[cfg(test)]
mod crypto_hw_tests;
pub mod hle;
pub mod periph;
pub mod timing;
/// The Wi-Fi model lives in tryboard-soc (shared by C3 / S3); wired here with the C3 layout
pub(crate) use tryboard_soc::wifi;
/// Shared models moved to tryboard-soc (R-05); crate-internal aliases so `crate::x` paths stay valid (R-06 pruned unused)
pub(crate) use tryboard_soc::{
    crypto_hw, devices, gdma, gpspi, i2c, i2s, iotrace, ledc, rmt, spiflash, tasktrace,
};

use devices::audio::{Audio, PortIo};
use devices::lcd::{Lcd, LcdKind};
use gdma::{Gdma, GdmaLayout};
use periph::*;
use std::collections::HashMap;
use tryboard_rv32::{Bus, BusFault, Cpu, Exit};

// Memory map (soc/esp32c3/include/soc/soc.h)
pub const IRAM_LOW: u32 = 0x4037_C000;
pub const IRAM_HIGH: u32 = 0x403E_0000;
pub const DRAM_LOW: u32 = 0x3FC8_0000;
pub const DRAM_HIGH: u32 = 0x3FCE_0000;
/// DRAM 0x3FC80000 and IRAM 0x40380000 are the same SRAM1
pub const DRAM_TO_IRAM: u32 = 0x4038_0000 - DRAM_LOW;
pub const ROM_LOW: u32 = 0x4000_0000;
pub const ROM_HIGH: u32 = 0x4006_0000;
pub const DROM_MASK_LOW: u32 = 0x3FF0_0000;
pub const DROM_MASK_HIGH: u32 = 0x3FF2_0000;
/// The DROM mask window maps to ROM physical 0x40040000 onward
pub const DROM_MASK_TO_ROM: u32 = 0x4004_0000 - DROM_MASK_LOW;
pub const IROM_LOW: u32 = 0x4200_0000;
pub const IROM_HIGH: u32 = 0x4280_0000;
pub const DROM_LOW: u32 = 0x3C00_0000;
pub const DROM_HIGH: u32 = 0x3C80_0000;
pub const RTC_LOW: u32 = 0x5000_0000;
pub const RTC_HIGH: u32 = 0x5000_2000;
pub const MMIO_LOW: u32 = 0x6000_0000;
pub const MMIO_HIGH: u32 = 0x600D_1000;

/// Fetch cache: direct-mapped by PC, holds the decoded 32-bit instruction and length (compressed already expanded).
/// Tag 1 means invalid (valid PCs are always even).
const ICACHE_BITS: u32 = 15;
const ICACHE_MASK: usize = (1 << ICACHE_BITS) - 1;
const ICACHE_INVALID: u32 = 1;

/// GC9A01 round LCD wiring on C3: SCLK / MOSI / CS on SPI2's IO_MUX direct pins (soc/spi_pins.h); DC / RST / backlight on free
/// DevKitM-1 header GPIOs that aren't strapping pins (2, 8, 9 are strapping; 8 also drives the onboard RGB)
pub mod lcd_pin {
    pub const SCLK: u32 = 6;
    pub const MOSI: u32 = 7;
    pub const CS: u32 = 10;
    pub const DC: u32 = 5;
    pub const RST: u32 = 4;
    pub const BL: u32 = 3;
}
/// GDMA peripheral ids (soc/gdma_channel.h: SOC_GDMA_TRIG_PERIPH_SPI2 / _I2S0)
const GDMA_PERI_SPI2: u32 = 0;
const GDMA_PERI_I2S0: u32 = 3;
/// I2S audio wiring on C3. With one I2S, speaker and mic share BCK / WS (full duplex), so their clock pins match;
/// data pins use free non-strapping pins, except GPIO2, which is strapping but usable as output after boot
pub mod i2s_pin {
    pub const SPK_BCLK: u32 = 0;
    pub const SPK_LRC: u32 = 1;
    pub const SPK_DIN: u32 = 2;
    pub const MIC_SCK: u32 = 0;
    pub const MIC_WS: u32 = 1;
    pub const MIC_SD: u32 = 3;
}
/// GPIO matrix signals (gpio_sig_map.h): I2SO_SD_OUT_IDX / I2SI_SD_IN_IDX are both 15
const SIG_I2S_SD: usize = 15;
/// GPIO matrix output signal FSPICS0_OUT_IDX (gpio_sig_map.h) and IO_MUX function FUNC_GPIO10_FSPICS0 (io_mux_reg.h)
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
    /// WS2812 decoders per pin (created when the GPIO matrix routes a pin to an RMT output)
    pub ws2812: HashMap<u32, rmt::Ws2812>,
    /// Devices wired straight to GPIOs that drive timed waveforms (HC-SR04 etc.; C3 has no PCNT, encoders need GPIO IRQs)
    pub pins: devices::pins::PinDevices,
    pub efuse: [u32; 0x200 / 4],
    /// SYSTEM_CPU_INTR_FROM_CPU_0..3
    pub from_cpu: u32,
    pub usj_tx: Vec<u8>,
    /// Merged console output (UART0 + USB-Serial-JTAG) for the frontend / CLI
    pub console: Vec<u8>,
    /// Registers without a model: writes are stored and read back
    pub regs: HashMap<u32, u32>,
    /// Accesses to unmodelled registers: address -> count
    pub unimpl: HashMap<u32, u64>,
    pub irq_dirty: bool,
    /// Firmware requested reset (RTC_CNTL_OPTIONS0 SW_SYS_RST / SW_PROCPU_RST); value is the next boot's reset reason
    pub reset_request: Option<u32>,
    /// This boot's reset reason (RTC_CNTL_RESET_STATE low 6 bits): 1 power-on, 3 software system reset, 12 software CPU reset
    pub reset_reason: u32,
    /// Option only so it can be taken out while stepping / sending so the MAC can borrow the bus for descriptors; always Some otherwise
    pub wifi: Option<Box<wifi::WifiMac>>,
    pub sha: crypto_hw::ShaHw,
    pub aes: crypto_hw::AesHw,
    /// GP-SPI2 master + GDMA (3 channels). GDMA also serves AES / SHA DMA mode
    pub spi2: gpspi::GpSpi,
    pub gdma: Gdma,
    /// Round LCD on SPI2 (CLI `--spi gc9a01` / wasm `tb_lcd_attach`), pins in `lcd_pin`
    pub lcd: Option<Box<Lcd>>,
    /// I2S0 (0x6002D000) and the audio devices on it (pins in `i2s_pin`)
    pub i2s0: i2s::I2s,
    pub audio: Audio,
    /// Hardware RNG (WDEV_RND_REG) state: xorshift with a fixed seed for reproducibility
    pub rng: u32,
    /// Debug: watch one MMIO address and record the PC of each access (watch_pc filled by the run loop)
    pub watch: Option<(u32, u32)>,
    pub watch_pc: u32,
    /// (PC, address, value, is write), in time order
    pub watch_hits: Vec<(u32, u32, u32, bool)>,
    pub next_event: u64,
    /// GPIO level changes (cycle, levels); the frontend drives LEDs etc. from it
    pub gpio_log: Vec<(u64, u32)>,
    last_gpio: u32,
    /// Logic analyzer events (P1-05)
    pub iotrace: iotrace::IoTrace,
    /// FreeRTOS task switches (C-04)
    pub tasks: tasktrace::TaskTrace,
    /// Timing-sensitive code detection (D-03)
    pub timing: timing::Timing,
    /// BLE (C-01): present only when the VHCI boundary was found in firmware; Option only to take it out during HLE
    pub ble: Option<Box<ble::BleHle>>,
    /// Why BLE is used but the VHCI boundary wasn't found (web suggests dropping in an app.elf)
    pub ble_error: Option<String>,
    /// Fetch overrides (address, halfword), ascending: BLE entry trampolines without modifying flash
    pub code_patch: Vec<(u32, u16)>,
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
            timg0: Timg::c3(0),
            timg1: Timg::c3(1),
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
            wifi: Some(Box::new(wifi::WifiMac::new(wifi::WifiLayout::C3))),
            sha: Default::default(),
            aes: Default::default(),
            spi2: Default::default(),
            gdma: Gdma::new(GdmaLayout::C3),
            lcd: None,
            i2s0: i2s::I2s::new(0, false),
            audio: Audio::default(),
            rng: 0x2545_f491,
            watch: None,
            watch_pc: 0,
            watch_hits: Vec::new(),
            next_event: 0,
            gpio_log: Vec::new(),
            last_gpio: 0,
            iotrace: iotrace::IoTrace::new(0),
            // First word of a RISC-V stack frame is RV_STK_MEPC
            tasks: tasktrace::TaskTrace::new(0),
            timing: Default::default(),
            ble: None,
            ble_error: None,
            code_patch: Vec::new(),
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

/// Fixed-length write (so copy_from_slice doesn't degrade into a memmove call)
#[inline(always)]
fn wr(buf: &mut [u8], off: usize, size: u32, v: u32) -> Option<()> {
    match size {
        4 => buf.get_mut(off..off + 4)?.copy_from_slice(&v.to_le_bytes()),
        2 => buf
            .get_mut(off..off + 2)?
            .copy_from_slice(&(v as u16).to_le_bytes()),
        _ => *buf.get_mut(off)? = v as u8,
    }
    Some(())
}

impl SocBus {
    /// Fetch halfword: check overrides first (only reached on fetch-cache miss; usually empty, so just one emptiness test)
    #[inline]
    fn fetch16(&self, a: u32) -> Option<u32> {
        if !self.code_patch.is_empty() {
            if let Ok(i) = self.code_patch.binary_search_by_key(&a, |x| x.0) {
                return Some(self.code_patch[i].1 as u32);
            }
        }
        self.mem_read(a, 2)
    }

    /// Cache mapping: virtual address -> flash offset
    #[inline]
    pub fn flash_addr(&self, vaddr: u32) -> Option<usize> {
        let lin = vaddr & 0x7F_FFFF;
        let e = self.mmu[(lin >> 16) as usize];
        if e & MMU_INVALID != 0 {
            return None;
        }
        Some((((e & 0xff) << 16) | (lin & 0xffff)) as usize)
    }

    /// Physical memory (non-MMIO) read, also used by the debugger / HLE
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

    /// Write to executable memory: invalidate fetch-cache entries over this word (instructions up to 4 bytes may start a halfword earlier)
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

    /// MMU table or flash contents changed: drop the whole fetch cache
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
            0x6000_4000 => {
                let v = self.gpio.read(off);
                if off == 0x3c {
                    let inputs = !self.gpio.enable | self.gpio.open_drain();
                    self.timing.in_read(now, v as u64, inputs as u64);
                }
                return v;
            }
            0x6000_2000 => return self.spi1.read(off),
            0x6002_6000 if off == 0xb0 => {
                // WDEV_RND_REG: a new value on every read (esp_random, lwIP ports / DNS ids rely on it)
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
            0x6000_9000 if (4..=0x58).contains(&off) => {
                return self.gpio.iomux[((off - 4) / 4) as usize]
            }
            0x6001_3000 => return self.i2c0.read(off),
            0x6002_4000 => return self.spi2.read(off),
            0x6003_F000 => return self.gdma.read(off),
            0x6002_D000 => return self.i2s0.read(off),
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
                0x04 => return 0x2, // EP1_CONF: IN endpoint has room
                0x08 => return 0x8, // INT_RAW: SERIAL_IN_EMPTY
                _ => {}
            },
            _ => {}
        }
        if wifi::MAC_RANGE.contains(&a) {
            if let Some(v) = self.wifi_mut().read(a, now) {
                return v;
            }
        }
        if a == 0x6000_8038 {
            return self.reset_reason | (self.reset_reason << 6);
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
            0x6004_0000 => {
                self.adc.wifi_busy = self.wifi.as_deref().is_some_and(|w| w.is_on());
                return self.adc.write(off, v);
            }
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
            0x6002_D000 => return self.i2s0.write(off, v, now),
            0x600C_4000 if off < 0x100 => return self.extmem.write(off, v),
            0x6000_4000 => {
                let before = self.gpio.level();
                self.gpio.write(off, v);
                let changed = before ^ self.gpio.level();
                if changed != 0 {
                    self.timing.cpu_edges(now, changed as u64);
                }
                // Enables (0x20..0x2c) and output signal select (FUNC_OUT_SEL from 0x554) decide which pins carry PWM
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
                // USB-Serial-JTAG is IDF's default second console duplicating UART0; kept separately, not in the main console
                self.usj_tx.push(v as u8);
                if self.usj_tx.len() > 1 << 16 {
                    self.usj_tx.drain(..1 << 15);
                }
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
            // None = fully handled by the MAC model; else store as a generic register (still counted in unimpl to show bits touched)
            match keep {
                Some(x) => v = x,
                None => return,
            }
        }
        if !boot::special_write(a, v) {
            *self.unimpl.entry(a).or_insert(0) += 1;
        }
        self.regs.insert(a, v);
    }

    /// Pin levels may have changed: detect edges, log
    pub fn gpio_changed(&mut self, now: u64) {
        self.gpio.sense();
        let lv = self.gpio.level();
        if let Some(l) = self.lcd.as_mut() {
            // RST is active low and only resets when firmware actually drives it low (module has a pull-up); backlight on when high
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

    /// RMT RX input (GPIO matrix FUNCn_IN_SEL_CFG: sel[4:0], inv[5], via matrix[6]; 0x1E constant 1, 0x1F constant 0)
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

    /// Apply external pin devices' drive up to now at their times; returns the next time to poll them
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

    /// PWM on a pin: the LEDC channel output routed to it through the GPIO matrix (duty, frequency)
    pub fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)> {
        let sig = self.gpio.func_out.get(pin)? & 0xff;
        if (45..=50).contains(&sig) && self.gpio.enable & (1 << pin) != 0 {
            let (d, f) = self.ledc.output((sig - 45) as usize)?;
            let inv = self.gpio.func_out[pin] & (1 << 8) != 0;
            return Some((if inv { 1.0 - d } else { d }, f));
        }
        None
    }

    /// LEDC or GPIO matrix changed: hand each pin's current PWM to the event log (unchanged pins aren't logged)
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

    /// Current level of every interrupt source (bit = source number)
    fn levels(&self) -> u64 {
        let mut l = 0u64;
        let mut set = |s: u32, on: bool| {
            if on {
                l |= 1 << s;
            }
        };
        set(src::WIFI_MAC, self.wifi().irq());
        set(src::UART0, self.uart0.irq());
        set(src::UART1, self.uart1.irq());
        set(src::GPIO, self.gpio.irq());
        set(src::LEDC, self.ledc.irq());
        set(src::RMT, self.rmt.irq());
        set(src::I2C_EXT0, self.i2c0.irq());
        set(src::SPI2, self.spi2.irq());
        set(src::I2S0, self.i2s0.irq());
        for ch in 0..self.gdma.layout.nch as u32 {
            set(
                src::DMA_CH0 + ch,
                self.gdma.in_irq(ch as usize) || self.gdma.out_irq(ch as usize),
            );
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
        set(src::TG0_WDT, self.timg0.wdt_irq());
        set(src::TG1_WDT, self.timg1.wdt_irq());
        for i in 0..4 {
            set(src::FROM_CPU0 + i, self.from_cpu & (1 << i) != 0);
        }
        l
    }

    /// Route RMT output edges through the GPIO matrix to pins: update levels and feed pin WS2812 decoders.
    /// Returns when the decoders next need checking (end-of-frame detection).
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

    /// Advance timers and re-arbitrate interrupt lines.
    pub fn update(&mut self, cpu: &mut Cpu) {
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
        let n7 = self.i2c0.update(now);
        let n8 = {
            // Infallible: wifi is set at construction and only taken around write/update,
            // whose Mem callbacks reach RAM only (never this register path).
            let mut w = self.wifi.take().expect("wifi");
            let n = w.update(now, self);
            self.wifi = Some(w);
            n
        };
        let n10 = self.pins_update(now);
        self.trace_pwm(now);
        let (n9, spi_done) = self.spi2.update(now);
        if spi_done {
            if let Some(ch) = self.spi2.dma_out_ch.take() {
                self.gdma.out_done(ch);
            }
        }
        let n11 = self.i2s_update(now);
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
            .min(n11);
        let lv = self.levels();
        let pending = self.intc.pending(lv);
        cpu.irq_line = self.intc.select(pending);
        self.irq_dirty = false;
    }
}

impl SocBus {
    /// Advance I2S0: check via the GPIO matrix whether speaker DIN / mic SD sit on the I2S data line, then lend the bus to GDMA
    fn i2s_update(&mut self, now: u64) -> u64 {
        if !self.i2s0.tx.running && !self.i2s0.rx.running {
            return u64::MAX;
        }
        let speaker = self.audio.speaker.as_ref().is_some_and(|s| {
            self.gpio
                .func_out
                .get(s.pins.data as usize)
                .is_some_and(|f| (f & 0xff) as usize == SIG_I2S_SD)
        });
        // FUNCn_IN_SEL_CFG: bits 4..0 pin, bit 6 via GPIO matrix
        let f = self.gpio.func_in[SIG_I2S_SD];
        let mic = self
            .audio
            .mic
            .as_ref()
            .is_some_and(|m| f & (1 << 6) != 0 && f & 0x1f == m.pins.data);
        let mut g = std::mem::replace(&mut self.gdma, Gdma::placeholder());
        let mut audio = std::mem::take(&mut self.audio);
        let mut i2s = std::mem::replace(&mut self.i2s0, i2s::I2s::new(0, false));
        let mut io = PortIo {
            audio: &mut audio,
            speaker,
            mic,
        };
        let n = i2s.update(now, &mut g, self, GDMA_PERI_I2S0, &mut io);
        self.i2s0 = i2s;
        self.audio = audio;
        self.gdma = g;
        n
    }

    /// Attach a MAX98357A speaker / INMP441 mic (pins in `i2s_pin`)
    pub fn attach_speaker(&mut self) {
        use i2s_pin::*;
        let p = devices::audio::Pins {
            bclk: SPK_BCLK,
            ws: SPK_LRC,
            data: SPK_DIN,
        };
        self.audio.speaker = Some(Box::new(devices::audio::Max98357a::new(p)));
    }
    pub fn attach_mic(&mut self) {
        use i2s_pin::*;
        let p = devices::audio::Pins {
            bclk: MIC_SCK,
            ws: MIC_WS,
            data: MIC_SD,
        };
        self.audio.mic = Some(Box::new(devices::audio::Inmp441::new(p)));
    }

    /// Attach a GC9A01 round LCD on SPI2 (pins in `lcd_pin`)
    pub fn attach_lcd(&mut self) {
        self.lcd = Some(Box::new(Lcd::new(LcdKind::Gc9a01)));
        let now = self.now;
        self.gpio_changed(now);
    }

    /// LCD chip select: if CS is routed via IO_MUX / GPIO matrix to SPI2 CS0, the controller pulls it low during transfers;
    /// otherwise treat it as plain GPIO, selected only when firmware drives it low
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

    /// Firmware wrote SPI2 CMD.USR: fetch data (W registers or GDMA chain), hand it to the LCD, then time it by SPI clock.
    /// Same logic as the S3 function of this name (shared model; only pins and signal ids differ)
    fn spi2_transfer(&mut self, now: u64) {
        let p = self.spi2.plan();
        let mut bytes = p.head.clone();
        let mut out_ch = None;
        // Take GDMA out temporarily to borrow the bus for memory access
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
            // DMA supplied too little data: the shift register holds 0
            data.resize(n, 0);
            bytes.extend_from_slice(&data);
        }
        if p.miso_bits > 0 {
            // No slave answers, MISO pull-up reads all ones
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
        if let (Some(Lcd::Dcs(l)), true) = (self.lcd.as_deref_mut(), selected) {
            for b in bytes {
                l.byte(dc, b);
            }
        }
        self.spi2.begin(now, &p, out_ch);
    }
}

impl SocBus {
    pub fn sha_read(&self, off: u32) -> u32 {
        self.sha.read(off)
    }
    pub fn aes_read(&self, off: u32) -> u32 {
        self.aes.read(off)
    }
    /// SHA / AES register write: fetch the chain head, then take the accelerator out and lend the bus to DMA
    pub fn sha_write(&mut self, off: u32, v: u32) {
        let link = crypto_hw::sha_link(&self.gdma);
        let mut s = std::mem::take(&mut self.sha);
        s.write(off, v, link, self);
        self.sha = s;
    }
    pub fn aes_write(&mut self, off: u32, v: u32) {
        let links = crypto_hw::aes_links(&self.gdma);
        let mut a = std::mem::take(&mut self.aes);
        a.write(off, v, links, self);
        self.aes = a;
    }
    // Infallible: wifi is set at construction and only taken around write/update,
    // whose Mem callbacks reach RAM only (never this register path).
    pub fn wifi(&self) -> &wifi::WifiMac {
        self.wifi.as_deref().expect("wifi")
    }
    pub fn wifi_mut(&mut self) -> &mut wifi::WifiMac {
        self.wifi.as_deref_mut().expect("wifi")
    }
}

impl tryboard_soc::Mem for SocBus {
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
    #[inline(always)]
    fn fetch_decoded(&mut self, addr: u32) -> Result<(u32, u32), BusFault> {
        let idx = ((addr >> 1) as usize) & ICACHE_MASK;
        let e = self.icache[idx];
        if e.0 == addr {
            return Ok((e.1, e.2));
        }
        let lo = self.fetch16(addr).ok_or(BusFault)?;
        let raw = if lo & 3 != 3 {
            lo
        } else {
            lo | (self.fetch16(addr + 2).ok_or(BusFault)? << 16)
        };
        let (insn, len) = tryboard_rv32::decode_raw(raw);
        self.icache[idx] = (addr, insn, len);
        Ok((insn, len))
    }

    fn cycle_read(&mut self, pc: u32, cycles: u64) {
        // ROM reads are esp_rom_delay_us's own loop, already counted at its entry
        if !(ROM_LOW..ROM_HIGH).contains(&pc) {
            self.timing.cycle_read(cycles);
        }
    }

    fn sp_loaded(&mut self, base: u32, cycles: u64) {
        if self.tasks.cap == 0 {
            return;
        }
        let mut t = std::mem::replace(&mut self.tasks, tasktrace::TaskTrace::new(0));
        t.on_sp_load(0, base, cycles, false, &|a| self.mem_read(a, 4));
        self.tasks = t;
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
                // Sub-word write (compilers use sb/sh for bitfields): read the peripheral's current value and merge.
                // UART FIFO reads dequeue, so they can't be used for read-modify-write
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
        // Writing ROM / flash-mapped regions is a bus error on silicon; report it here too
        Err(BusFault)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// Ran the requested number of cycles
    Budget,
    /// Firmware crashed (exception with mtvec unset)
    Fault { cause: u32, pc: u32, tval: u32 },
    /// Hit an unimplemented HLE function
    Hle(u32),
    /// Firmware requested reset (esp_restart, watchdog, reboot after panic); call reboot() to power up again
    Reset(u32),
}

pub struct Esp32c3 {
    pub cpu: Cpu,
    pub bus: SocBus,
    pub rom_symbols: HashMap<u32, String>,
    pub hle: HashMap<u32, hle::Hle>,
    /// Keep a copy of the ROM for power-up after reset
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
                    // Idle: fast-forward to the next timer event
                    let target = bus.next_event.min(end);
                    if target > cpu.cycles {
                        cpu.cycles = target;
                    }
                }
                Exit::Hle(pc) => match hle.get(&pc) {
                    Some(k) => hle::call(*k, cpu, bus),
                    None if (ble::MAGIC..ble::MAGIC_END).contains(&pc) && bus.ble.is_some() => {
                        ble::call_slot(pc, cpu, bus)
                    }
                    None => return Stop::Hle(pc),
                },
                Exit::DoubleFault { cause, pc, tval } => return Stop::Fault { cause, pc, tval },
            }
        }
        Stop::Budget
    }

    /// Debug: single-step, recording recent jump targets (PC discontinuities) to locate hangs / crashes.
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

    /// Power up after reset: flash (incl. NVS) kept, RAM and peripherals cleared, CPU cycles keep counting
    pub fn reboot(&mut self, reason: u32) -> Result<(), String> {
        let flash = std::mem::take(&mut self.bus.flash);
        let (mut m, _) = Esp32c3::boot(&self.rom_elf, flash)?;
        m.bus.reset_reason = reason;
        m.bus.gpio.ext_in = self.bus.gpio.ext_in;
        m.bus.gpio.ext_driven = self.bus.gpio.ext_driven;
        m.bus.adc.pin_mv = self.bus.adc.pin_mv;
        m.bus.adc.model = self.bus.adc.model.clone();
        // External devices, pin logs and LED strip decoders are part of the outside world and survive reset (as in S3 reboot)
        m.bus.i2c0.devices = std::mem::take(&mut self.bus.i2c0.devices);
        m.bus.ws2812 = std::mem::take(&mut self.bus.ws2812);
        m.bus.pins = std::mem::take(&mut self.bus.pins);
        m.bus.gpio_log = std::mem::take(&mut self.bus.gpio_log);
        m.bus.iotrace = self.bus.iotrace.carry();
        m.bus.tasks = self.bus.tasks.carry(self.cpu.cycles);
        m.bus.timing = std::mem::take(&mut self.bus.timing);
        // An external LCD doesn't vanish on chip reset (firmware re-drives its reset pin)
        m.bus.lcd = self.bus.lcd.take();
        m.bus.audio = std::mem::take(&mut self.bus.audio);
        // The virtual phone is outside world: survives reset (connection drops with the chip), air log continues
        if let (Some(old), Some(new)) = (self.bus.ble.as_mut(), m.bus.ble.as_mut()) {
            std::mem::swap(&mut old.world, &mut new.world);
            new.world.chip_reset(ble::now_us(&self.cpu));
        }
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
