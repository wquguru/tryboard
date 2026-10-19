//! ESP32-C3 peripheral models. Register offsets from ESP-IDF `components/soc/esp32c3/register/soc/*.h` (Apache-2.0 OR MIT).
//! Time base: CPU 160MHz, `now` is CPU cycles. SYSTIMER 16MHz = now/10; APB 80MHz = now/2.

use tryboard_soc::adc::{AdcChip, AdcModel};
pub use tryboard_soc::periph::{Systimer, Timg, Uart, CPU_HZ};

// ---------------------------------------------------------------- Interrupt source numbers (soc/interrupts.h)
pub mod src {
    pub const WIFI_MAC: u32 = 0;
    pub const GPIO: u32 = 16;
    pub const SPI2: u32 = 19;
    pub const I2S0: u32 = 20;
    pub const UART0: u32 = 21;
    pub const UART1: u32 = 22;
    pub const LEDC: u32 = 23;
    pub const USB_SERIAL_JTAG: u32 = 26;
    pub const RTC_CORE: u32 = 27;
    pub const RMT: u32 = 28;
    pub const I2C_EXT0: u32 = 29;
    pub const TG0_T0: u32 = 32;
    pub const TG0_WDT: u32 = 33;
    pub const TG1_T0: u32 = 34;
    pub const TG1_WDT: u32 = 35;
    pub const SYSTIMER_TARGET0: u32 = 37;
    /// One GDMA source per channel (IN / OUT shared): ETS_DMA_CH0..2_INTR_SOURCE
    pub const DMA_CH0: u32 = 44;
    pub const FROM_CPU0: u32 = 50;
}

// ---------------------------------------------------------------- Interrupt matrix + CPU interrupt controller
pub struct Intc {
    pub map: [u8; 64],
    pub enable: u32,
    pub edge: u32,
    pub pri: [u8; 32],
    pub thresh: u32,
    /// Latches for edge-type lines
    pub latched: u32,
    pub clock_gate: u32,
}

impl Default for Intc {
    fn default() -> Self {
        Intc {
            map: [0; 64],
            enable: 0,
            edge: 0,
            pri: [0; 32],
            thresh: 0,
            latched: 0,
            clock_gate: 1,
        }
    }
}

impl Intc {
    pub fn read(&self, off: u32) -> Option<u32> {
        Some(match off {
            0x000..=0x0f4 => self.map[(off / 4) as usize] as u32,
            0x100 => self.clock_gate,
            0x104 => self.enable,
            0x108 => self.edge,
            0x10c => 0,
            0x114..=0x190 => self.pri[((off - 0x114) / 4) as usize] as u32,
            0x194 => self.thresh,
            0x7fc => 0x2007210,
            _ => return None,
        })
    }

    pub fn write(&mut self, off: u32, v: u32) -> bool {
        match off {
            0x000..=0x0f4 => self.map[(off / 4) as usize] = (v & 31) as u8,
            0x100 => self.clock_gate = v,
            0x104 => self.enable = v,
            0x108 => self.edge = v,
            0x10c => self.latched &= !v,
            0x114..=0x190 => self.pri[((off - 0x114) / 4) as usize] = (v & 15) as u8,
            0x194 => self.thresh = v & 15,
            _ => return false,
        }
        true
    }

    /// Compute each CPU line's pending bit from source levels.
    pub fn pending(&mut self, levels: u64) -> u32 {
        let mut lines = 0u32;
        let mut l = levels;
        while l != 0 {
            let s = l.trailing_zeros();
            l &= l - 1;
            let line = self.map[s as usize];
            if line != 0 {
                lines |= 1 << line;
            }
        }
        // Edge type: latch while level is high, cleared only by software writing CLEAR
        self.latched |= lines & self.edge;
        (lines & !self.edge) | self.latched
    }

    /// Pick the line to take: enabled, priority >= threshold and nonzero, highest priority wins.
    pub fn select(&self, pending: u32) -> u32 {
        let mut best = 0u32;
        let mut best_pri = 0u8;
        let mut p = pending & self.enable;
        while p != 0 {
            let line = p.trailing_zeros();
            p &= p - 1;
            let pri = self.pri[line as usize];
            if pri != 0 && pri as u32 >= self.thresh && pri > best_pri {
                best = line;
                best_pri = pri;
            }
        }
        best
    }
}

// ---------------------------------------------------------------- GPIO (output / input / pin config)
pub struct Gpio {
    /// IO_MUX pin registers (pulls, input enable, function select)
    pub iomux: [u32; 22],
    /// Fixed board pull-ups (e.g. GPIO9 under the BOOT button)
    pub board_pullup: u32,
    /// Previous pin levels, for edge detection
    pub last_level: u32,
    pub out: u32,
    pub enable: u32,
    /// Levels driven onto pins externally (buttons, sensors); undriven inputs read their pull level
    pub ext_in: u32,
    pub ext_driven: u32,
    pub pin: [u32; 22],
    pub func_out: [u32; 22],
    pub func_in: [u32; 128],
    pub status: u32,
    pub strap: u32,
    /// Pins driven by peripheral signals (RMT etc., via the GPIO matrix): mask and level
    pub periph_mask: u32,
    pub periph_level: u32,
}

impl Default for Gpio {
    fn default() -> Self {
        Gpio {
            iomux: [0; 22],
            board_pullup: 1 << 9,
            last_level: 1 << 9,
            out: 0,
            enable: 0,
            ext_in: 0,
            ext_driven: 0,
            pin: [0; 22],
            func_out: [0x80; 22],
            func_in: [0; 128],
            status: 0,
            strap: 0xc, // GPIO2 / GPIO8 high -> SPI boot
            periph_mask: 0,
            periph_level: 0,
        }
    }
}

impl Gpio {
    /// Actual pin level: output if enabled; else external drive first, then pulls (IO_MUX FUN_WPU bit 8 / FUN_WPD bit 7).
    pub fn level(&self) -> u32 {
        let driven = self.enable & 0x3f_ffff;
        let mut pull = self.board_pullup;
        for (i, r) in self.iomux.iter().enumerate() {
            if r & (1 << 8) != 0 {
                pull |= 1 << i;
            }
            if r & (1 << 7) != 0 && self.board_pullup & (1 << i) == 0 {
                pull &= !(1 << i);
            }
        }
        // Pins driven by a peripheral (RMT etc.) through the GPIO matrix take the peripheral's level
        let out = (self.out & !self.periph_mask) | (self.periph_level & self.periph_mask);
        // Open drain (GPIO_PINn_PAD_DRIVER) writing 1 lets go of the line: an attached device (DHT11) sets it. Without one
        // it still reads 1, as if pulled up, so firmware that never wires an external device sees no change (D-03).
        let released = driven & out & self.open_drain() & self.ext_driven;
        let driven = driven & !released;
        let undriven = !driven & !self.ext_driven;
        (out & driven) | (self.ext_in & self.ext_driven & !driven) | (pull & undriven & 0x3f_ffff)
    }

    /// Pins in open-drain mode (GPIO_PINn_REG bit 2, PAD_DRIVER)
    pub fn open_drain(&self) -> u32 {
        let mut m = 0;
        for (i, r) in self.pin.iter().enumerate() {
            if r & (1 << 2) != 0 {
                m |= 1 << i;
            }
        }
        m
    }

    /// After level changes set STATUS bits per pin interrupt type (GPIO_PINn_INT_TYPE: 1 rise, 2 fall, 3 both, 4 low, 5 high).
    pub fn sense(&mut self) {
        let lv = self.level();
        let rise = lv & !self.last_level;
        let fall = !lv & self.last_level;
        for i in 0..22 {
            let ty = (self.pin[i] >> 7) & 7;
            let b = 1u32 << i;
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

    /// GPIO interrupt output: in STATUS and the pin's INT_ENA (bits 13..17, CPU interrupt bit 13) is on
    pub fn irq(&self) -> bool {
        (0..22).any(|i| self.status & (1 << i) != 0 && (self.pin[i] >> 13) & 0x1f != 0)
    }

    pub fn set_periph_level(&mut self, pin: u32, on: bool) {
        self.periph_mask |= 1 << pin;
        if on {
            self.periph_level |= 1 << pin;
        } else {
            self.periph_level &= !(1 << pin);
        }
    }

    pub fn read(&mut self, off: u32) -> u32 {
        match off {
            0x04 => self.out,
            0x20 => self.enable,
            0x38 => self.strap,
            0x3c => self.level(),
            0x44 => self.status,
            0x5c => self.status,
            0x74..=0xc8 => self.pin[((off - 0x74) / 4) as usize],
            0x154..=0x350 => self.func_in[((off - 0x154) / 4) as usize],
            0x554..=0x5a8 => self.func_out[((off - 0x554) / 4) as usize],
            0x6fc => 0x2006130,
            _ => 0,
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let m = 0x3f_ffff;
        match off {
            0x04 => self.out = v & m,
            0x08 => self.out |= v & m,
            0x0c => self.out &= !v,
            0x20 => self.enable = v & m,
            0x24 => self.enable |= v & m,
            0x28 => self.enable &= !v,
            0x44 => self.status = v,
            0x48 => self.status |= v,
            0x4c => self.status &= !v,
            0x74..=0xc8 => self.pin[((off - 0x74) / 4) as usize] = v,
            0x154..=0x350 => self.func_in[((off - 0x154) / 4) as usize] = v,
            0x554..=0x5a8 => {
                let pin = ((off - 0x554) / 4) as usize;
                self.func_out[pin] = v;
                // Switching back to plain GPIO output (signal 128) stops peripheral drive
                if v & 0xff == 0x80 {
                    self.periph_mask &= !(1 << pin);
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------- EXTMEM (cache control)
/// Cache ops (invalidate, sync, preload, lock, freeze) finish instantly: enable bits self-clear, done bits set. Cache itself
/// isn't modelled (flash reads go straight through the MMU), so these have no other side effects. (lint: allow-long-comment)
pub struct Extmem {
    pub regs: [u32; 0x100 / 4],
}

impl Default for Extmem {
    fn default() -> Self {
        let mut regs = [0u32; 0x100 / 4];
        regs[0x1c / 4] = 1 << 2; // LOCK_DONE
        regs[0x28 / 4] = 1 << 1; // SYNC_DONE
        regs[0x34 / 4] = 1 << 1; // PRELOAD_DONE
        regs[0x40 / 4] = 1 << 3; // AUTOLOAD_DONE
        regs[0x00] = 1; // ICACHE_ENABLE (bootloader already enabled cache)
        Extmem { regs }
    }
}

impl Extmem {
    pub fn read(&self, off: u32) -> u32 {
        match off {
            0xb0 => 1, // CACHE_STATE: idle
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let v = match off {
            0x1c => (v & !3) | 4,
            0x28 | 0x34 => (v & !1) | 2,
            0x40 => v | 8,
            0xcc => (v & !4) | if v & 1 != 0 { 4 } else { 0 },
            _ => v,
        };
        if let Some(r) = self.regs.get_mut((off / 4) as usize) {
            *r = v;
        }
    }
}

// ---------------------------------------------------------------- APB_SARADC (one-shot sampling)

/// ADC1 ch 0..4 = GPIO0..4, ADC2 ch 0 = GPIO5; voltage set externally (web knob / tests).
/// Code from voltage: tryboard_soc::adc (real = inverse of IDF calibration + bends + noise; ideal = linear).
pub struct Adc {
    pub regs: [u32; 0x400 / 4],
    /// Voltage on each pin (mV)
    pub pin_mv: [f32; 22],
    pub model: AdcModel,
    /// Wi-Fi RF holds the ADC2 arbiter: ADC2 results carry an invalid channel (adc_oneshot_ll_raw_check_valid)
    pub wifi_busy: bool,
}

impl Default for Adc {
    fn default() -> Self {
        Adc {
            regs: [0; 0x400 / 4],
            pin_mv: [0.0; 22],
            model: AdcModel::new(AdcChip::C3),
            wifi_busy: false,
        }
    }
}

impl Adc {
    pub fn read(&self, off: u32) -> u32 {
        match off {
            0x48 => self.regs[0x44 / 4] & self.regs[0x40 / 4],
            0x3fc => 0x2007171,
            // The APB window is 4 KiB but the register file is 1 KiB: reads past it see 0, as on silicon
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let i = (off / 4) as usize;
        if i >= self.regs.len() {
            return;
        }
        match off {
            0x4c => self.regs[0x44 / 4] &= !v,
            0x20 => {
                let rising = v & (1 << 29) != 0 && self.regs[i] & (1 << 29) == 0;
                self.regs[i] = v;
                if rising {
                    self.sample(v);
                }
            }
            _ => self.regs[i] = v,
        }
    }

    fn sample(&mut self, cfg: u32) {
        // Which ADC finishes is decided by adc1/adc2_onetime_sample enables (during calibration the channel may be internal)
        let chan = (cfg >> 25) & 0xf;
        let unit = if cfg & (1 << 31) != 0 { 0 } else { 1 };
        let ch = chan & 7;
        let atten = (cfg >> 23) & 3;
        let pin = if unit == 0 { ch as usize } else { 5 };
        let pad = (unit == 0 && ch <= 4) || (unit == 1 && ch == 0);
        if unit == 1 && self.wifi_busy {
            // Arbiter granted Wi-Fi: data status carries channel 0xF (> 9 = invalid), IDF returns ESP_ERR_TIMEOUT
            self.model.blocked += 1;
            self.regs[0x30 / 4] = 0xf << 13;
            self.regs[0x44 / 4] |= 1 << 30;
            return;
        }
        let mv = if pad { self.pin_mv[pin] } else { 0.0 };
        let raw = self.model.convert(unit, atten, pad.then_some(pin), mv);
        if unit == 0 {
            self.regs[0x2c / 4] = raw;
            self.regs[0x44 / 4] |= 1 << 31;
        } else {
            self.regs[0x30 / 4] = raw;
            self.regs[0x44 / 4] |= 1 << 30;
        }
    }
}
