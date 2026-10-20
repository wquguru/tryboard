//! Classic-ESP32 peripheral models and shims; offsets from ESP-IDF `components/soc/esp32/register/soc/*.h` and `components/hal/esp32/include/hal/*_ll.h` (Apache-2.0).
//! C3 / S3 models (TIMG timer, SPI1 flash commands, LEDC channels / timers, interrupt matrix lines) are reused; ESP32 mostly moves registers, so we only translate offsets.

use crate::psram::{QuadPsram, SPI_PIN};
pub use tryboard_esp32s3::periph::{Analog, Intmatrix};
use tryboard_soc::ledc::Ledc;
use tryboard_soc::periph::Timg;
use tryboard_soc::spiflash::SpiFlash;

/// Interrupt source numbers (soc/esp32/include/soc/interrupts.h)
pub mod src {
    pub const WIFI_MAC: u32 = 0;
    pub const TG0_T0: u32 = 14;
    pub const TG0_T1: u32 = 15;
    pub const TG0_WDT: u32 = 16;
    pub const TG0_LACT: u32 = 17;
    pub const TG1_T0: u32 = 18;
    pub const TG1_T1: u32 = 19;
    pub const TG1_WDT: u32 = 20;
    pub const TG1_LACT: u32 = 21;
    pub const GPIO: u32 = 22;
    pub const FROM_CPU0: u32 = 24;
    pub const UART0: u32 = 34;
    pub const UART1: u32 = 35;
    pub const UART2: u32 = 36;
    pub const LEDC: u32 = 43;
    pub const I2C_EXT0: u32 = 49;
    pub const I2C_EXT1: u32 = 50;
    pub const MAX: usize = 69;
}

// ---------------------------------------------------------------- DPORT (interrupt matrix, cross-core interrupts, cache control)
/// DPORT_PRO_MAC_INTR_MAP_REG / DPORT_APP_MAC_INTR_MAP_REG: one map register per interrupt source
const PRO_MAP: u32 = 0x104;
const APP_MAP: u32 = 0x218;
/// DPORT_PRO_CACHE_CTRL / DPORT_APP_CACHE_CTRL: FLUSH_ENA bit 4, FLUSH_DONE bit 5, CACHE_ENABLE bit 3
const PRO_CACHE_CTRL: u32 = 0x40;
const APP_CACHE_CTRL: u32 = 0x58;
const CACHE_FLUSH_DONE: u32 = 1 << 5;
const CACHE_ENABLE: u32 = 1 << 3;

pub struct Dport {
    /// Per-core interrupt matrices (line logic reused from S3: both are LX cores with the same external line type table)
    pub pro: Intmatrix,
    pub app: Intmatrix,
    /// DPORT_CPU_INTR_FROM_CPU_0..3 (bit 0)
    pub from_cpu: u32,
    pub regs: Vec<u32>,
}

impl Default for Dport {
    fn default() -> Self {
        let mut regs = vec![0u32; 0x1000 / 4];
        // The 2nd-stage bootloader already enabled core 0's cache (spi_flash_cache_enabled checks this bit)
        regs[(PRO_CACHE_CTRL / 4) as usize] = CACHE_ENABLE;
        Dport {
            pro: Intmatrix::default(),
            app: Intmatrix::default(),
            from_cpu: 0,
            regs,
        }
    }
}

impl Dport {
    fn status(levels: &[u64; 2], k: u32) -> u32 {
        let mut v = 0u32;
        for b in 0..32 {
            let s = (k * 32 + b) as usize;
            if s < src::MAX && (levels[s / 64] >> (s % 64)) & 1 != 0 {
                v |= 1 << b;
            }
        }
        v
    }

    pub fn read(&self, off: u32, levels: &[u64; 2]) -> u32 {
        let max = src::MAX as u32 * 4;
        match off {
            0xdc..=0xe8 => (self.from_cpu >> ((off - 0xdc) / 4)) & 1,
            // PRO_INTR_STATUS_0..2 / APP_INTR_STATUS_0..2: current interrupt source levels
            0xec..=0xf4 => Self::status(levels, (off - 0xec) / 4),
            0xf8..=0x100 => Self::status(levels, (off - 0xf8) / 4),
            _ if (PRO_MAP..PRO_MAP + max).contains(&off) => {
                self.pro.map[((off - PRO_MAP) / 4) as usize] as u32
            }
            _ if (APP_MAP..APP_MAP + max).contains(&off) => {
                self.app.map[((off - APP_MAP) / 4) as usize] as u32
            }
            // Cache operations complete instantly: the flush-done bit always reads 1
            PRO_CACHE_CTRL | APP_CACHE_CTRL => self.regs[(off / 4) as usize] | CACHE_FLUSH_DONE,
            // PRO_DCACHE_DBUG0 / APP_DCACHE_DBUG0: CACHE_STATE (bits 18..7) = 1 is idle; ROM's Cache_Read_Enable/Disable polls it
            0x3f0 | 0x418 => 1 << 7,
            0xffc => 0x0160_5190,
            _ => self.regs[(off / 4) as usize],
        }
    }

    /// Register write; may change the cross-core interrupt lines
    pub fn write(&mut self, off: u32, v: u32) {
        let max = src::MAX as u32 * 4;
        match off {
            0xdc..=0xe8 => {
                let bit = 1 << ((off - 0xdc) / 4);
                if v & 1 != 0 {
                    self.from_cpu |= bit;
                } else {
                    self.from_cpu &= !bit;
                }
            }
            _ if (PRO_MAP..PRO_MAP + max).contains(&off) => {
                self.pro.map[((off - PRO_MAP) / 4) as usize] = (v & 31) as u8
            }
            _ if (APP_MAP..APP_MAP + max).contains(&off) => {
                self.app.map[((off - APP_MAP) / 4) as usize] = (v & 31) as u8
            }
            _ => self.regs[(off / 4) as usize] = v,
        }
    }
}

// ---------------------------------------------------------------- GPIO (40 pins) + IO_MUX
pub const NPINS: usize = 40;
const MASK: u64 = (1 << NPINS) - 1;

/// GPIO number of each IO_MUX register in order, from 0x3FF49000 + 0x04 (io_mux_reg.h: PERIPHS_IO_MUX_*_U)
pub const IOMUX_ORDER: [u8; 36] = [
    36, 37, 38, 39, 34, 35, 32, 33, 25, 26, 27, 14, 12, 13, 15, 2, 0, 4, 16, 17, 9, 10, 11, 6, 7,
    8, 5, 18, 19, 20, 21, 22, 3, 1, 23, 24,
];

/// Constant sources for GPIO matrix inputs (gpio_pins.h: GPIO_MATRIX_CONST_ONE_INPUT / _ZERO_INPUT)
pub const IN_CONST_ONE: u32 = 0x38;
pub const IN_CONST_ZERO: u32 = 0x30;
/// FUNCn_OUT_SEL signal number meaning "plain GPIO output"
pub const SIG_GPIO_OUT: u32 = 0x100;

pub struct Gpio {
    pub out: u64,
    pub enable: u64,
    pub ext_in: u64,
    pub ext_driven: u64,
    pub status: u64,
    /// GPIO_PINn_REG: interrupt type [9:7], interrupt enable [17:13] (bit 13 APP CPU, bit 15 PRO CPU)
    pub pin: [u32; NPINS],
    pub func_out: [u32; NPINS],
    pub func_in: [u32; 256],
    /// IO_MUX registers indexed by GPIO number (pull-up bit 8, pull-down bit 7, function [14:12])
    pub iomux: [u32; NPINS],
    /// Fixed pull-ups on the board (BOOT button on GPIO0)
    pub board_pullup: u64,
    pub last_level: u64,
    pub strap: u32,
    pub periph_mask: u64,
    pub periph_level: u64,
}

impl Default for Gpio {
    fn default() -> Self {
        Gpio {
            out: 0,
            enable: 0,
            ext_in: 0,
            ext_driven: 0,
            status: 0,
            pin: [0; NPINS],
            func_out: [SIG_GPIO_OUT; NPINS],
            func_in: [0; 256],
            iomux: [0; NPINS],
            board_pullup: 1,
            last_level: 1,
            // GPIO0, GPIO5 high, MTDI low -> SPI boot, 3.3V flash (GPIO_STRAP_REG)
            strap: 0x13,
            periph_mask: 0,
            periph_level: 0,
        }
    }
}

impl Gpio {
    pub fn level(&self) -> u64 {
        let driven = self.enable & MASK;
        let mut pull = self.board_pullup;
        for (i, r) in self.iomux.iter().enumerate() {
            if r & (1 << 8) != 0 {
                pull |= 1 << i;
            }
            if r & (1 << 7) != 0 && self.board_pullup & (1 << i) == 0 {
                pull &= !(1 << i);
            }
        }
        let out = (self.out & !self.periph_mask) | (self.periph_level & self.periph_mask);
        // Open drain writing 1 releases the line to an attached device (DHT11); see the C3 Gpio::level (D-03)
        let mut od = 0u64;
        for (i, r) in self.pin.iter().enumerate() {
            od |= ((r >> 2) as u64 & 1) << i;
        }
        let driven = driven & !(driven & out & od & self.ext_driven);
        let undriven = !driven & !self.ext_driven;
        (out & driven) | (self.ext_in & self.ext_driven & !driven) | (pull & undriven & MASK)
    }

    pub fn set_periph_level(&mut self, pin: u32, on: bool) {
        self.periph_mask |= 1 << pin;
        if on {
            self.periph_level |= 1 << pin;
        } else {
            self.periph_level &= !(1 << pin);
        }
    }

    pub fn sense(&mut self) {
        let lv = self.level();
        let rise = lv & !self.last_level;
        let fall = !lv & self.last_level;
        for i in 0..NPINS {
            let ty = (self.pin[i] >> 7) & 7;
            let b = 1u64 << i;
            let hit = match ty {
                1 => rise & b != 0,
                2 => fall & b != 0,
                3 => (rise | fall) & b != 0,
                4 => lv & b == 0,
                5 => lv & b != 0,
                _ => false,
            };
            if hit {
                self.status |= b;
            }
        }
        self.last_level = lv;
    }

    /// One core's interrupt status (PCPU_INT / ACPU_INT): only pins with interrupts enabled for that core
    fn cpu_status(&self, pro: bool) -> u64 {
        let ena = if pro { 0b11 << 2 } else { 0b11 };
        let mut v = 0;
        for i in 0..NPINS {
            if (self.pin[i] >> 13) & ena != 0 {
                v |= 1 << i;
            }
        }
        self.status & v
    }

    pub fn irq(&self) -> bool {
        (0..NPINS).any(|i| self.status & (1 << i) != 0 && (self.pin[i] >> 13) & 0x1f != 0)
    }

    fn lo(v: u64) -> u32 {
        v as u32
    }
    fn hi(v: u64) -> u32 {
        (v >> 32) as u32 & 0xff
    }

    pub fn read(&self, off: u32) -> u32 {
        match off {
            0x04 => Self::lo(self.out),
            0x10 => Self::hi(self.out),
            0x20 => Self::lo(self.enable),
            0x2c => Self::hi(self.enable),
            0x38 => self.strap,
            0x3c => Self::lo(self.level()),
            0x40 => Self::hi(self.level()),
            0x44 => Self::lo(self.status),
            0x50 => Self::hi(self.status),
            0x60 => Self::lo(self.cpu_status(false)),
            0x68 => Self::lo(self.cpu_status(true)),
            0x74 => Self::hi(self.cpu_status(false)),
            0x7c => Self::hi(self.cpu_status(true)),
            0x88..=0x124 => self.pin[((off - 0x88) / 4) as usize],
            0x130..=0x52c => self.func_in[((off - 0x130) / 4) as usize],
            0x530..=0x5cc => self.func_out[((off - 0x530) / 4) as usize],
            _ => 0,
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let (lo, hi) = (v as u64, (v as u64 & 0xff) << 32);
        match off {
            0x04 => self.out = (self.out & !0xffff_ffff) | lo,
            0x08 => self.out |= lo,
            0x0c => self.out &= !lo,
            0x10 => self.out = (self.out & 0xffff_ffff) | hi,
            0x14 => self.out |= hi,
            0x18 => self.out &= !hi,
            0x20 => self.enable = (self.enable & !0xffff_ffff) | lo,
            0x24 => self.enable |= lo,
            0x28 => self.enable &= !lo,
            0x2c => self.enable = (self.enable & 0xffff_ffff) | hi,
            0x30 => self.enable |= hi,
            0x34 => self.enable &= !hi,
            0x44 => self.status = (self.status & !0xffff_ffff) | lo,
            0x48 => self.status |= lo,
            0x4c => self.status &= !lo,
            0x50 => self.status = (self.status & 0xffff_ffff) | hi,
            0x54 => self.status |= hi,
            0x58 => self.status &= !hi,
            0x88..=0x124 => self.pin[((off - 0x88) / 4) as usize] = v,
            0x130..=0x52c => self.func_in[((off - 0x130) / 4) as usize] = v,
            0x530..=0x5cc => {
                let pin = ((off - 0x530) / 4) as usize;
                self.func_out[pin] = v;
                if v & 0x1ff == SIG_GPIO_OUT {
                    self.periph_mask &= !(1 << pin);
                }
            }
            _ => {}
        }
    }

    /// IO_MUX register offset -> GPIO number
    pub fn iomux_pin(off: u32) -> Option<usize> {
        if off < 4 || !off.is_multiple_of(4) {
            return None;
        }
        IOMUX_ORDER
            .get(((off - 4) / 4) as usize)
            .map(|p| *p as usize)
            .filter(|p| *p < NPINS)
    }
}

// ---------------------------------------------------------------- TIMG (two general timers + LACT)

/// ESP32 timer group: T0 (0x00..0x20), T1 (0x24..0x44), WDT + RTC cal (0x48..0x6c, as C3), LACT (0x70..0x94, esp_timer), interrupts (0x98..0xa4: bit 0 T0, 1 T1, 2 WDT, 3 LACT).
/// All three counters share C3 T0's field layout (en 31, inc 30, autoreload 29, divider [28:13], alarm en 10), so each is a C3 Timg with offsets translated; bit 9 is C3's "use XTAL", not ESP32's, so writes clear it.
pub struct Esp32Timg {
    pub t: [Timg; 3],
    pub int_ena: u32,
    pub lact_rtc: u32,
}

/// Interrupt bit <-> internal timer
const TIMG_INT: [(usize, u32); 3] = [(0, 1), (1, 2), (2, 8)];

/// WDT interrupt bit (ESP32 layout); the watchdog lives in counter 0, which also owns the 0x48.. registers
const WDT_INT: u32 = 1 << 2;

impl Default for Esp32Timg {
    fn default() -> Self {
        Esp32Timg::new(0)
    }
}

impl Esp32Timg {
    pub fn new(group: u8) -> Self {
        Esp32Timg {
            t: [Timg::apb_wdt(group), Timg::default(), Timg::default()],
            int_ena: 0,
            lact_rtc: 0,
        }
    }

    pub fn wdt_irq(&self) -> bool {
        self.int_raw() & self.int_ena & WDT_INT != 0
    }

    /// ESP32 offset -> (which counter, C3 offset)
    fn map(off: u32) -> Option<(usize, u32)> {
        Some(match off {
            0x00..=0x20 => (0, off),
            0x24..=0x44 => (1, off - 0x24),
            0x48..=0x6c => (0, off),
            0x70 => (2, 0),
            0x78..=0x94 => (2, off - 0x74),
            _ => return None,
        })
    }

    pub fn int_raw(&self) -> u32 {
        TIMG_INT
            .iter()
            .filter(|(i, _)| self.t[*i].int_raw & 1 != 0)
            .fold(0, |v, (_, b)| v | b)
            | (self.t[0].int_raw & WDT_INT)
    }

    pub fn read(&mut self, off: u32, now: u64) -> u32 {
        match off {
            0x74 => self.lact_rtc,
            0x98 => self.int_ena,
            0x9c => self.int_raw(),
            0xa0 => self.int_raw() & self.int_ena,
            0xf8 => 0x1604290,
            _ => match Self::map(off) {
                Some((i, o)) => self.t[i].read(o, now),
                None => 0,
            },
        }
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        match off {
            0x74 => self.lact_rtc = v,
            0x98 => self.int_ena = v,
            0xa4 => {
                for (i, b) in TIMG_INT {
                    if v & b != 0 {
                        self.t[i].int_raw &= !1;
                    }
                }
                self.t[0].int_raw &= !(v & WDT_INT);
            }
            _ => {
                if let Some((i, o)) = Self::map(off) {
                    let v = if o == 0 { v & !(1 << 9) } else { v };
                    self.t[i].write(o, v, now);
                }
            }
        }
    }

    pub fn update(&mut self, now: u64) -> u64 {
        let mut n = u64::MAX;
        for t in self.t.iter_mut() {
            n = n.min(t.update(now));
        }
        n
    }

    /// Interrupt line level of one counter (0 = T0, 1 = T1, 2 = LACT)
    pub fn irq(&self, k: usize) -> bool {
        let b = TIMG_INT[k].1;
        self.int_raw() & self.int_ena & b != 0
    }
}

// ---------------------------------------------------------------- SPI1 (flash)

/// ESP32's SPI1 has the same command bits as C3's SPI_MEM but different offsets (spi_reg.h).
/// User-command addresses are left-aligned with low bits padded with 1s (spi_flash_ll_set_usr_address); shift back before the C3 model
pub struct Spi1 {
    pub inner: SpiFlash,
    /// Registers not involved in flash operations (clock, pins, slave config, ...) are stored as is
    pub extra: Vec<u32>,
    /// Chip on CS1 (M5-14); its storage also backs the cache's DRAM1 window
    pub psram: QuadPsram,
}

impl Default for Spi1 {
    fn default() -> Self {
        Spi1 {
            inner: SpiFlash::default(),
            extra: vec![0; 0x100 / 4],
            psram: QuadPsram::default(),
        }
    }
}

impl Spi1 {
    fn map(off: u32) -> Option<u32> {
        Some(match off {
            0x00..=0x0c => off,
            0x10 => 0x2c,
            0x14 => 0x10,
            0x18 => 0x14,
            0x1c..=0x2c => off - 4,
            0x80..=0xbc => off - 0x80 + 0x58,
            _ => return None,
        })
    }

    pub fn read(&self, off: u32) -> u32 {
        match Self::map(off) {
            Some(o) => self.inner.read(o),
            // EXT2 (0xF8): state machine idle
            None if off == 0xf8 => 0,
            None => self.extra.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    pub fn write(&mut self, off: u32, v: u32, flash: &mut [u8]) {
        let Some(o) = Self::map(off) else {
            if let Some(r) = self.extra.get_mut((off / 4) as usize) {
                *r = v;
            }
            return;
        };
        if o == 0 && v & (1 << 18) != 0 && QuadPsram::selected(self.extra[SPI_PIN]) {
            self.psram.user_transaction(&mut self.inner.regs);
            return;
        }
        if o == 0 && v & (1 << 18) != 0 {
            // User command: USER1 [31:26] is address bit count - 1
            let addr = self.inner.regs[1];
            let bits = (self.inner.regs[0x1c / 4] >> 26) + 1;
            if bits < 32 {
                self.inner.regs[1] = addr >> (32 - bits);
            }
            self.inner.write(0, v, flash);
            self.inner.regs[1] = addr;
            return;
        }
        self.inner.write(o, v, flash);
    }
}

// ---------------------------------------------------------------- LEDC (8 high-speed + 8 low-speed channels)

/// High- and low-speed groups each sit on a C3 LEDC (same channel layout). Timer registers differ (5-bit resolution, divider [22:5],
/// pause 23, clock select 25, low-speed para_up 26), so we convert to an equivalent divider of an 80MHz source in the internal timer
pub struct Esp32Ledc {
    pub hs: Ledc,
    pub ls: Ledc,
    pub timer_conf: [u32; 8],
    pub conf: u32,
    pub int_ena: u32,
    /// Timer overflow interrupt (not simulated; writes are only stored)
    pub rev: u64,
}

impl Default for Esp32Ledc {
    fn default() -> Self {
        let mut hs = Ledc::default();
        let mut ls = Ledc::default();
        // The internal model always counts from an 80MHz source
        hs.conf = 1;
        ls.conf = 1;
        Esp32Ledc {
            hs,
            ls,
            timer_conf: [0; 8],
            conf: 0,
            int_ena: 0,
            rev: 0,
        }
    }
}

impl Esp32Ledc {
    /// Changes whenever the output may have changed (lets the event log decide whether to rescan PWM)
    pub fn rev(&self) -> u64 {
        self.rev + self.hs.rev + self.ls.rev
    }

    pub fn int_raw(&self) -> u32 {
        (((self.hs.int_raw >> 4) & 0xff) << 8) | (((self.ls.int_raw >> 4) & 0xff) << 16)
    }

    /// Fold an ESP32 timer config into the internal timer
    fn apply_timer(&mut self, k: usize) {
        let v = self.timer_conf[k];
        let hs = k < 4;
        let tick = v & (1 << 25) != 0;
        // Source clock relative to 80MHz: tick_sel 0 is REF_TICK 1MHz for both; 1 is APB for high speed, SLOW_CLK (APB or 8MHz) for low speed
        let scale = match (hs, tick) {
            (true, true) => 1,
            (_, false) => 80,
            (false, true) => {
                if self.conf & 1 != 0 {
                    1
                } else {
                    10
                }
            }
        };
        let g = if hs { &mut self.hs } else { &mut self.ls };
        let t = &mut g.timers[k % 4];
        t.res = v & 0x1f;
        t.div = ((v >> 5) & 0x3_ffff) * scale;
        t.paused = v & (1 << 23) != 0;
        t.conf = v;
        self.rev += 1;
    }

    pub fn read(&self, off: u32) -> u32 {
        match off {
            0x00..=0x9c => self.hs.read(off),
            0xa0..=0x13c => self.ls.read(off - 0xa0),
            0x140..=0x17c => {
                let k = ((off - 0x140) / 8) as usize;
                if off.is_multiple_of(8) {
                    self.timer_conf[k] & !(1 << 26)
                } else {
                    0
                }
            }
            0x180 => self.int_raw(),
            0x184 => self.int_raw() & self.int_ena,
            0x188 => self.int_ena,
            0x190 => self.conf,
            0x1fc => 0x1604_0400,
            _ => 0,
        }
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        match off {
            0x00..=0x9c => {
                // High-speed channels have no para_up bit: changes apply on a CONF0 write or when CONF1 sets DUTY_START
                let r = off % 0x14;
                self.hs.write(off, v, now);
                if r == 0 || (r == 0x0c && v & (1 << 31) != 0) {
                    let base = off - r;
                    let c0 = self.hs.ch[(base / 0x14) as usize].conf0;
                    self.hs.write(base, c0 | (1 << 4), now);
                }
            }
            0xa0..=0x13c => self.ls.write(off - 0xa0, v, now),
            0x140..=0x17c if off.is_multiple_of(8) => {
                let k = ((off - 0x140) / 8) as usize;
                let first = self.timer_conf[k] == 0;
                self.timer_conf[k] = v;
                // Low-speed timers apply only when para_up (bit 26) is written; high-speed ones apply immediately
                if k < 4 || v & (1 << 26) != 0 || first {
                    self.apply_timer(k);
                }
            }
            0x188 => self.int_ena = v,
            0x18c => {
                self.hs.int_raw &= !(((v >> 8) & 0xff) << 4);
                self.ls.int_raw &= !(((v >> 16) & 0xff) << 4);
            }
            0x190 => {
                self.conf = v;
                for k in 4..8 {
                    self.apply_timer(k);
                }
            }
            _ => {}
        }
    }

    pub fn update(&mut self, now: u64) -> u64 {
        self.hs.update(now).min(self.ls.update(now))
    }

    pub fn irq(&self) -> bool {
        self.int_raw() & self.int_ena != 0
    }

    /// PWM on output signal sig (LEDC_HS_SIG_OUT0..7 = 71..78, LEDC_LS_SIG_OUT0..7 = 79..86)
    pub fn output(&self, sig: u32) -> Option<(f32, f32)> {
        match sig {
            71..=78 => self.hs.output((sig - 71) as usize),
            79..=86 => self.ls.output((sig - 79) as usize),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------- eFuse
/// BLK0 read registers (from 0x3FF5A000): factory MAC, chip revision v3.0 (ECO3, the common one on the market), dual core
pub fn default_efuse() -> [u32; 0x200 / 4] {
    let mut e = [0u32; 0x200 / 4];
    // Locally administered address so we don't borrow Espressif's OUI; last byte tells it apart from simulated C3 (01) / S3 (03)
    let mac = [0x02u8, 0x54, 0x42, 0x00, 0x00, 0x04];
    let crc = mac_crc8(&mac);
    // MAC_FACTORY: bits 32..79, mac[5] in the lowest byte (esp_efuse_table.c); CRC in bits 80..87
    e[1] = u32::from_le_bytes([mac[5], mac[4], mac[3], mac[2]]);
    e[2] = u32::from_le_bytes([mac[1], mac[0], crc, 0]);
    // CHIP_VER_REV1 (bit 111)
    e[3] |= 1 << 15;
    // CHIP_VER_REV2 (BLK0 RDATA5 bit 20); together with APB_CTRL_DATE bit 31 this means revision 3
    e[5] |= 1 << 20;
    e
}

/// CRC8 of the eFuse MAC (Dallas/Maxim: reflected polynomial 0x8C, initial value 0)
pub fn mac_crc8(mac: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &b in mac {
        let mut x = b;
        for _ in 0..8 {
            let mix = (crc ^ x) & 1;
            crc >>= 1;
            if mix != 0 {
                crc ^= 0x8c;
            }
            x >>= 1;
        }
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timg_lact_offsets() {
        let mut t = Esp32Timg::default();
        // LACT: divider 80 (1MHz), counting up, enabled
        t.write(0x70, (1 << 31) | (1 << 30) | (80 << 13), 0);
        t.write(0x80, 1, 160_000);
        assert_eq!(t.read(0x78, 160_000), 1000);
        // Alarm at 2000 us, interrupt enabled
        t.write(0x84, 2000, 160_000);
        t.write(0x88, 0, 160_000);
        t.write(0x98, 8, 160_000);
        let c = t.read(0x70, 0);
        t.write(0x70, c | (1 << 10), 160_000);
        let next = t.update(160_000);
        assert_eq!(next, 320_000);
        t.update(320_000);
        assert!(t.irq(2) && !t.irq(0));
        t.write(0xa4, 8, 320_000);
        assert!(!t.irq(2));
    }

    #[test]
    fn spi1_user_address_realigned() {
        let mut s = Spi1::default();
        let mut flash = vec![0u8; 0x2000];
        flash[0x1234] = 0x5a;
        // Read data (0x03), 24-bit address, read 8 bits
        s.write(0x1c, (1 << 31) | (1 << 30) | (1 << 28), &mut flash);
        s.write(0x20, 23 << 26, &mut flash);
        s.write(0x24, (7 << 28) | 0x03, &mut flash);
        s.write(0x2c, 7, &mut flash);
        s.write(0x04, (0x1234 << 8) | 0xff, &mut flash);
        s.write(0x00, 1 << 18, &mut flash);
        assert_eq!(s.read(0x80) & 0xff, 0x5a);
        assert_eq!(s.read(0x00), 0);
    }

    #[test]
    fn ledc_low_speed_ref_tick() {
        let mut l = Esp32Ledc::default();
        // Low-speed timer 0: 13 bits, REF_TICK 1MHz (tick_sel = 0), divider 1.0 -> 1e6 / 8192 Hz
        l.write(0x160, 13 | (256 << 5) | (1 << 26), 0);
        // Low-speed channel 0: timer 0, output enabled, 50% duty
        l.write(0xa0 + 0x08, 4096 << 4, 0);
        l.write(0xa0, (1 << 2) | (1 << 4), 0);
        let (d, hz) = l.output(79).unwrap();
        assert!((d - 0.5).abs() < 1e-3);
        assert!((hz - 1e6 / 8192.0).abs() < 0.1, "{hz}");
        // Values the IDF fade example actually writes: tick_sel = 1 picks SLOW_CLK, APB_CLK_SEL = 1 -> 80MHz / 1.953 / 8192 = 5kHz
        l.write(0x190, 1, 0);
        l.write(0x160, 0x2003e8d | (1 << 26), 0);
        let (_, hz) = l.output(79).unwrap();
        assert!((hz - 5000.0).abs() < 1.0, "{hz}");
    }

    #[test]
    fn efuse_mac_crc() {
        // Known sample from Espressif docs: CRC8 of all zeros is 0
        assert_eq!(mac_crc8(&[0; 6]), 0);
        let e = default_efuse();
        assert_eq!(e[1] & 0xff, 0x04);
    }

    #[test]
    fn gpio_iomux_and_matrix() {
        assert_eq!(Gpio::iomux_pin(0x44), Some(0));
        assert_eq!(Gpio::iomux_pin(0x7c), Some(21));
        let mut g = Gpio::default();
        g.write(0x24, 1 << 2);
        g.write(0x08, 1 << 2);
        assert_eq!(g.level() >> 2 & 1, 1);
        g.write(0x30, 1 << 1);
        g.write(0x14, 1 << 1);
        assert_eq!(g.read(0x40) & 2, 2);
    }
}
