//! ESP32-S3-specific peripheral models (the parts whose layout differs from C3). Register offsets come from ESP-IDF
//! `components/soc/esp32s3/register/soc/*.h` (Apache-2.0 OR MIT).

/// Interrupt source numbers (soc/esp32s3/include/soc/interrupts.h, evaluated by compiling the header with clang)
pub mod src {
    pub const WIFI_MAC: u32 = 0;
    pub const GPIO: u32 = 16;
    pub const SPI2: u32 = 21;
    pub const I2S0: u32 = 25;
    pub const I2S1: u32 = 26;
    pub const UART0: u32 = 27;
    pub const UART1: u32 = 28;
    pub const LEDC: u32 = 35;
    pub const RMT: u32 = 40;
    pub const PCNT: u32 = 41;
    pub const I2C_EXT0: u32 = 42;
    pub const I2C_EXT1: u32 = 43;
    pub const TG0_T0: u32 = 50;
    pub const TG1_T0: u32 = 53;
    pub const SYSTIMER_TARGET0: u32 = 57;
    pub const DMA_IN_CH0: u32 = 66;
    pub const DMA_OUT_CH0: u32 = 71;
    pub const FROM_CPU0: u32 = 79;
    pub const USB_SERIAL_JTAG: u32 = 96;
    pub const MAX: usize = 99;
}

/// Level-type external lines per core-isa.h XCHAL_INTn_TYPE; edge lines latch on a rising edge until INTCLEAR.
/// Timer (6/15/16), software (7/29) and perf-counter (11) lines are CPU-managed, so the SoC leaves them alone.
pub const EXTERN_LEVEL_LINES: u32 = (1 << 0)
    | (1 << 1)
    | (1 << 2)
    | (1 << 3)
    | (1 << 4)
    | (1 << 5)
    | (1 << 8)
    | (1 << 9)
    | (1 << 12)
    | (1 << 13)
    | (1 << 17)
    | (1 << 18)
    | (1 << 19)
    | (1 << 20)
    | (1 << 21)
    | (1 << 23)
    | (1 << 24)
    | (1 << 25)
    | (1 << 26)
    | (1 << 27)
    | (1 << 31);
pub const EXTERN_EDGE_LINES: u32 = (1 << 10) | (1 << 22) | (1 << 28) | (1 << 30);
/// NMI (line 14) is also an external level input
pub const NMI_LINE: u32 = 1 << 14;
/// Interrupt line -> level (XCHAL_INTn_LEVEL)
pub const LINE_LEVEL: [u8; 32] = [
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 7, 3, 5, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 3, 4, 3, 4, 5,
];

// ---------------------------------------------------------------- Interrupt matrix (core 0)

/// Each peripheral source maps to one core 0 CPU line (INTERRUPT_CORE0_*_MAP_REG, offset = 4 x source). Lines
/// 6/7/11/14 (except NMI)/15/16/29 are internal, so mapping there masks the source (IDF uses e.g. 16 as "disabled").
pub struct Intmatrix {
    pub map: [u8; src::MAX],
    pub clock_gate: u32,
    /// Previous input level of edge lines, for rising-edge detection
    pub last_edge_in: u32,
}

impl Default for Intmatrix {
    fn default() -> Self {
        // Reset value: every source maps to line 16 (a timer line, i.e. unconnected)
        Intmatrix {
            map: [16; src::MAX],
            clock_gate: 1,
            last_edge_in: 0,
        }
    }
}

impl Intmatrix {
    pub fn read(&self, off: u32, levels: &[u64; 2]) -> Option<u32> {
        let i = (off / 4) as usize;
        Some(match off {
            _ if i < src::MAX => self.map[i] as u32,
            0x18c..=0x198 => {
                // INTR_STATUS_0..3: current level of 32 sources each
                let k = ((off - 0x18c) / 4) as usize;
                let bit0 = k * 32;
                let mut v = 0u32;
                for b in 0..32 {
                    let s = bit0 + b;
                    if s < src::MAX && (levels[s / 64] >> (s % 64)) & 1 != 0 {
                        v |= 1 << b;
                    }
                }
                v
            }
            0x19c => self.clock_gate,
            0x7fc => 0x2012300,
            _ => return None,
        })
    }

    pub fn write(&mut self, off: u32, v: u32) -> bool {
        let i = (off / 4) as usize;
        match off {
            _ if i < src::MAX => self.map[i] = (v & 31) as u8,
            0x19c => self.clock_gate = v,
            _ => return false,
        }
        true
    }

    /// Derive external line inputs from source levels: (level lines, newly rising edge lines)
    pub fn lines(&mut self, levels: &[u64; 2]) -> (u32, u32) {
        let mut lines = 0u32;
        for (w, &word) in levels.iter().enumerate() {
            let mut l = word;
            while l != 0 {
                let b = l.trailing_zeros() as usize;
                l &= l - 1;
                let s = w * 64 + b;
                if s < src::MAX {
                    lines |= 1 << self.map[s];
                }
            }
        }
        let edge_in = lines & EXTERN_EDGE_LINES;
        let rising = edge_in & !self.last_edge_in;
        self.last_edge_in = edge_in;
        (lines & (EXTERN_LEVEL_LINES | NMI_LINE), rising)
    }
}

// ---------------------------------------------------------------- EXTMEM (S3: separate I/D caches)
/// Cache ops complete instantly: enable bits self-clear, done bits set. Contents not modelled (flash / PSRAM reads go straight through the MMU).
pub struct Extmem {
    pub regs: [u32; 0x400 / 4],
}

impl Default for Extmem {
    fn default() -> Self {
        let mut regs = [0u32; 0x400 / 4];
        for (off, done) in OPS {
            regs[(off / 4) as usize] = done;
        }
        regs[0] = 1; // DCACHE_ENABLE
        regs[0x60 / 4] = 1; // ICACHE_ENABLE (bootloader already enabled the cache)
        Extmem { regs }
    }
}

/// (offset, done bit): DCACHE_LOCK / SYNC / OCCUPY / PRELOAD / AUTOLOAD, ICACHE_LOCK / SYNC / PRELOAD / AUTOLOAD
const OPS: [(u32, u32); 9] = [
    (0x1c, 1 << 2),
    (0x28, 1 << 3),
    (0x34, 1 << 1),
    (0x40, 1 << 1),
    (0x4c, 1 << 3),
    (0x7c, 1 << 2),
    (0x88, 1 << 1),
    (0x94, 1 << 1),
    (0xa0, 1 << 3),
];

impl Extmem {
    pub fn read(&self, off: u32) -> u32 {
        match off {
            0x130 => 0x1001, // CACHE_STATE: I / D both idle
            0x3fc => 0x2101040,
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let v = match off {
            0x1c | 0x7c => (v & !3) | 4,
            0x28 => (v & !7) | 8,
            0x34 | 0x40 | 0x88 | 0x94 => (v & !1) | 2,
            0x4c | 0xa0 => v | 8,
            // DCACHE_FREEZE / ICACHE_FREEZE: ena bit 0, done bit 2
            0x150 | 0x154 => (v & !4) | if v & 1 != 0 { 4 } else { 0 },
            _ => v,
        };
        if let Some(r) = self.regs.get_mut((off / 4) as usize) {
            *r = v;
        }
    }
}

// ---------------------------------------------------------------- GPIO (49 pins)
pub const NPINS: usize = 49;

pub struct Gpio {
    pub out: u64,
    pub enable: u64,
    pub ext_in: u64,
    pub ext_driven: u64,
    pub status: u64,
    pub pin: [u32; NPINS],
    pub func_out: [u32; NPINS],
    pub func_in: [u32; 256],
    pub iomux: [u32; NPINS],
    /// Fixed on-board pull-up (BOOT button GPIO0)
    pub board_pullup: u64,
    pub last_level: u64,
    pub strap: u32,
    /// Pins driven by peripheral signals (RMT etc., via the GPIO matrix): mask and level
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
            func_out: [0x100; NPINS],
            func_in: [0; 256],
            iomux: [0; NPINS],
            board_pullup: 1,
            last_level: 1,
            // GPIO0 pulled high -> SPI boot
            strap: 0x8,
            periph_mask: 0,
            periph_level: 0,
        }
    }
}

const MASK: u64 = (1 << NPINS) - 1;

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
        let undriven = !driven & !self.ext_driven;
        let out = (self.out & !self.periph_mask) | (self.periph_level & self.periph_mask);
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

    pub fn irq(&self) -> bool {
        (0..NPINS).any(|i| self.status & (1 << i) != 0 && (self.pin[i] >> 13) & 0x1f != 0)
    }

    fn lo(v: u64) -> u32 {
        v as u32
    }
    fn hi(v: u64) -> u32 {
        (v >> 32) as u32 & 0x1_ffff
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
            0x44 | 0x5c => Self::lo(self.status),
            0x50 | 0x68 => Self::hi(self.status),
            0x74..=0x134 => self.pin[((off - 0x74) / 4) as usize],
            0x154..=0x550 => self.func_in[((off - 0x154) / 4) as usize],
            0x554..=0x614 => self.func_out[((off - 0x554) / 4) as usize],
            0x6fc => 0x1907040,
            _ => 0,
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let (lo, hi) = (v as u64, (v as u64 & 0x1_ffff) << 32);
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
            0x74..=0x134 => self.pin[((off - 0x74) / 4) as usize] = v,
            0x154..=0x550 => self.func_in[((off - 0x154) / 4) as usize] = v,
            0x554..=0x614 => {
                let pin = ((off - 0x554) / 4) as usize;
                self.func_out[pin] = v;
                // Switching back to plain GPIO output (signal 256) releases the peripheral drive
                if v & 0x1ff == 0x100 {
                    self.periph_mask &= !(1 << pin);
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------- SAR ADC one-shot (S3 uses the RTC SENS controller)
// Unlike C3's APB_SARADC, S3 one-shot sampling goes through SENS (0x60008800). lint: allow-long-comment
// SAR_MEAS1_CTRL2 (0x0C): data [15:0], done bit 16, start bit 17, channel bitmap sar1_en_pad [30:19];
// SAR_MEAS2_CTRL2 (0x30) likewise for ADC2; SAR_ATTEN1 / 2 (0x14 / 0x38) 2 attenuation bits per channel.
// ADC1 ch n = GPIO(n+1), ADC2 ch n = GPIO(n+11). Full scale approximates datasheet atten steps: 0dB~950mV, 2.5dB~1250mV, 6dB~1750mV, 12dB~3100mV.
/// Offset of SENS_SAR_TSENS_CTRL_REG from the SENS base (0x60008800)
const TSENS_CTRL: u32 = 0x50;
const TSENS_RAW_25C: u32 = 104;

pub struct SensAdc {
    pub regs: [u32; 0x100 / 4],
    pub pin_mv: [f32; NPINS],
    pub noise_lsb: u32,
    seed: u32,
}

impl Default for SensAdc {
    fn default() -> Self {
        SensAdc {
            regs: [0; 0x100 / 4],
            pin_mv: [0.0; NPINS],
            noise_lsb: 2,
            seed: 0x1234_5678,
        }
    }
}

impl SensAdc {
    pub fn read(&self, off: u32) -> Option<u32> {
        let v = self.regs.get((off / 4) as usize).copied()?;
        Some(if off == TSENS_CTRL {
            // On-chip temp sensor (SENS_SAR_TSENS_CTRL_REG): write DUMP_OUT (bit 24), wait READY (bit 8), read OUT (bits 7..0); libphy's
            // temperature_sensor_get_raw_value calls it during Wi-Fi calibration. Raw 104 ~ 25 C (0.4386 x raw - 20.52, offset step 0)
            (v & !0x1ff) | (1 << 8) | TSENS_RAW_25C
        } else {
            v
        })
    }

    pub fn write(&mut self, off: u32, v: u32) -> bool {
        let Some(old) = self.regs.get((off / 4) as usize).copied() else {
            return false;
        };
        let mut v = v;
        if off == 0x0c || off == 0x30 {
            let unit = if off == 0x0c { 0 } else { 1 };
            if v & (1 << 17) == 0 {
                v &= !(1 << 16); // start bit cleared: clear the done bit too
            } else if old & (1 << 17) == 0 {
                let pads = (v >> 19) & 0xfff;
                let raw = self.sample(unit, pads.trailing_zeros());
                v = (v & !0xffff) | raw | (1 << 16);
            }
        }
        self.regs[(off / 4) as usize] = v;
        true
    }

    fn sample(&mut self, unit: u32, ch: u32) -> u32 {
        let atten_reg = self.regs[if unit == 0 { 0x14 / 4 } else { 0x38 / 4 }];
        let atten = (atten_reg >> (ch * 2)) & 3;
        let full = [950.0, 1250.0, 1750.0, 3100.0][atten as usize];
        let pin = if unit == 0 { ch + 1 } else { ch + 11 } as usize;
        let mv = if ch < 10 {
            self.pin_mv.get(pin).copied().unwrap_or(0.0)
        } else {
            0.0
        };
        self.seed = self.seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
        let n = if self.noise_lsb > 0 {
            (self.seed >> 16) % (2 * self.noise_lsb + 1)
        } else {
            0
        } as i32
            - self.noise_lsb as i32;
        ((mv / full * 4095.0).round() as i32 + n).clamp(0, 4095) as u32
    }
}

// ---------------------------------------------------------------- Analog front end (regi2c, accessed via ROM function HLE)
#[derive(Default)]
pub struct Analog {
    pub regs: std::collections::HashMap<(u8, u8), u8>,
}

impl Analog {
    pub fn read(&self, block: u8, reg: u8) -> u8 {
        let v = self.regs.get(&(block, reg)).copied().unwrap_or(0);
        match (block, reg) {
            // I2C_ULP (0x61) reg3: O_DONE_FLAG (bit 0), BG_O_DONE_FLAG (bit 3) -- bias / ocode calibration completes immediately
            (0x61, 3) => v | 0x09,
            _ => v,
        }
    }
}
