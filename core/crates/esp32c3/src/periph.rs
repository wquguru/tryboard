//! ESP32-C3 peripheral models. Register offsets from ESP-IDF `components/soc/esp32c3/register/soc/*.h` (Apache-2.0 OR MIT).
//! Time base: CPU 160MHz, `now` is CPU cycles. SYSTIMER 16MHz = now/10; APB 80MHz = now/2.

pub const CPU_HZ: u64 = 160_000_000;

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

// ---------------------------------------------------------------- UART
pub struct Uart {
    pub tx: Vec<u8>,
    pub rx: std::collections::VecDeque<u8>,
    pub int_raw: u32,
    pub int_ena: u32,
    pub regs: [u32; 0x84 / 4],
}

impl Default for Uart {
    fn default() -> Self {
        let mut regs = [0u32; 0x84 / 4];
        regs[0x14 / 4] = 0x2b6; // CLKDIV default (115200 @ 80MHz)
        regs[0x20 / 4] = 0x1000_001c;
        regs[0x24 / 4] = 0xc060;
        regs[0x78 / 4] = 0x0320_0000;
        regs[0x7c / 4] = 0x0200_7220;
        regs[0x80 / 4] = 0x0000_0500;
        Uart {
            tx: Vec::new(),
            rx: Default::default(),
            int_raw: 0x2,
            int_ena: 0,
            regs,
        }
    }
}

impl Uart {
    pub fn read(&mut self, off: u32) -> u32 {
        match off {
            0x00 => {
                let v = self.rx.pop_front().unwrap_or(0) as u32;
                if self.rx.is_empty() {
                    self.int_raw &= !(1 | (1 << 8));
                }
                v
            }
            0x04 => self.int_raw,
            0x08 => self.int_raw & self.int_ena,
            0x0c => self.int_ena,
            // STATUS: rxfifo_cnt[9:0]; txfifo_cnt[25:16] always 0 (TX completes instantly)
            0x1c => (self.rx.len() as u32).min(127),
            0x6c => 0, // FSM idle
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        match off {
            0x00 => {
                self.tx.push(v as u8);
                self.int_raw |= 0x2 | (1 << 14); // TXFIFO_EMPTY, TX_DONE
            }
            0x0c => self.int_ena = v,
            0x10 => self.int_raw &= !v,
            _ => {
                if let Some(r) = self.regs.get_mut((off / 4) as usize) {
                    *r = v;
                }
            }
        }
    }

    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }

    pub fn push_rx(&mut self, data: &[u8]) {
        self.rx.extend(data.iter().copied());
        let thr = (self.regs[0x24 / 4] & 0x1ff) as usize;
        if self.rx.len() >= thr.max(1) {
            self.int_raw |= 1; // RXFIFO_FULL
        }
        // RXFIFO_TOUT: silicon fires after the line idles some character times; here a batch arriving counts as idle
        if !self.rx.is_empty() {
            self.int_raw |= 1 << 8;
        }
    }
}

// ---------------------------------------------------------------- SYSTIMER (16MHz)
pub struct Systimer {
    pub conf: u32,
    pub unit_load: [u64; 2],
    /// count = (now/10) + offset
    pub unit_offset: [i64; 2],
    pub unit_latch: [u64; 2],
    pub target: [u64; 3],
    pub target_conf: [u32; 3],
    pub int_ena: u32,
    pub int_raw: u32,
    /// One-shot comparators fire only on the first arrival after load; no refire while count stays >= target
    pub armed: [bool; 3],
}

impl Default for Systimer {
    fn default() -> Self {
        Systimer {
            conf: 0x4600_0000,
            unit_load: [0; 2],
            unit_offset: [0; 2],
            unit_latch: [0; 2],
            target: [0; 3],
            target_conf: [0; 3],
            int_ena: 0,
            int_raw: 0,
            armed: [false; 3],
        }
    }
}

impl Systimer {
    pub fn count(&self, unit: usize, now: u64) -> u64 {
        ((now / 10) as i64 + self.unit_offset[unit]) as u64 & ((1 << 52) - 1)
    }

    pub fn read(&mut self, off: u32, now: u64) -> u32 {
        match off {
            0x00 => self.conf,
            0x04 | 0x08 => 1 << 29, // VALUE_VALID
            0x0c => (self.unit_load[0] >> 32) as u32,
            0x10 => self.unit_load[0] as u32,
            0x14 => (self.unit_load[1] >> 32) as u32,
            0x18 => self.unit_load[1] as u32,
            0x1c | 0x24 | 0x2c => (self.target[((off - 0x1c) / 8) as usize] >> 32) as u32,
            0x20 | 0x28 | 0x30 => self.target[((off - 0x20) / 8) as usize] as u32,
            0x34..=0x3c => self.target_conf[((off - 0x34) / 4) as usize],
            0x40 => (self.unit_latch[0] >> 32) as u32,
            0x44 => self.unit_latch[0] as u32,
            0x48 => (self.unit_latch[1] >> 32) as u32,
            0x4c => self.unit_latch[1] as u32,
            0x64 => self.int_ena,
            0x68 => self.int_raw,
            0x70 => self.int_raw & self.int_ena,
            0xfc => 0x2006171,
            _ => {
                let _ = now;
                0
            }
        }
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        match off {
            0x00 => {
                // Comparator off -> on: rearm
                for i in 0..3 {
                    let bit = 1 << (24 - i);
                    if v & bit != 0 && self.conf & bit == 0 {
                        self.armed[i] = true;
                    }
                }
                self.conf = v;
            }
            0x04 | 0x08 => {
                let u = ((off - 4) / 4) as usize;
                if v & (1 << 30) != 0 {
                    self.unit_latch[u] = self.count(u, now);
                }
            }
            0x0c => {
                self.unit_load[0] = (self.unit_load[0] & 0xffff_ffff) | ((v as u64 & 0xfffff) << 32)
            }
            0x10 => self.unit_load[0] = (self.unit_load[0] & !0xffff_ffff) | v as u64,
            0x14 => {
                self.unit_load[1] = (self.unit_load[1] & 0xffff_ffff) | ((v as u64 & 0xfffff) << 32)
            }
            0x18 => self.unit_load[1] = (self.unit_load[1] & !0xffff_ffff) | v as u64,
            0x1c | 0x24 | 0x2c => {
                let i = ((off - 0x1c) / 8) as usize;
                self.target[i] = (self.target[i] & 0xffff_ffff) | ((v as u64 & 0xfffff) << 32);
            }
            0x20 | 0x28 | 0x30 => {
                let i = ((off - 0x20) / 8) as usize;
                self.target[i] = (self.target[i] & !0xffff_ffff) | v as u64;
            }
            0x34..=0x3c => self.target_conf[((off - 0x34) / 4) as usize] = v,
            0x50..=0x58 => {
                // COMPx_LOAD: apply target / period. Period mode counts from the current count
                let i = ((off - 0x50) / 4) as usize;
                self.armed[i] = true;
                if self.target_conf[i] & (1 << 30) != 0 {
                    let unit = (self.target_conf[i] >> 31) as usize;
                    self.target[i] =
                        self.count(unit, now) + (self.target_conf[i] & 0x3ff_ffff) as u64;
                }
            }
            0x5c | 0x60 => {
                let u = ((off - 0x5c) / 4) as usize;
                self.unit_offset[u] = self.unit_load[u] as i64 - (now / 10) as i64;
            }
            0x64 => self.int_ena = v & 7,
            0x6c => self.int_raw &= !v,
            _ => {}
        }
    }

    fn comp_enabled(&self, i: usize) -> bool {
        self.conf & (1 << (24 - i)) != 0
    }

    /// Advance comparators; returns the next CPU cycle to check.
    pub fn update(&mut self, now: u64) -> u64 {
        let mut next = u64::MAX;
        for i in 0..3 {
            if !self.comp_enabled(i) {
                continue;
            }
            let unit = (self.target_conf[i] >> 31) as usize;
            let cnt = self.count(unit, now);
            let periodic = self.target_conf[i] & (1 << 30) != 0;
            if cnt >= self.target[i] {
                if self.armed[i] || periodic {
                    self.int_raw |= 1 << i;
                    self.armed[i] = false;
                }
                if periodic {
                    let period = (self.target_conf[i] & 0x3ff_ffff) as u64;
                    if period == 0 {
                        continue;
                    }
                    // Skip missed periods to avoid a catch-up storm
                    let missed = (cnt - self.target[i]) / period + 1;
                    self.target[i] += missed * period;
                } else {
                    continue;
                }
            }
            if !periodic && !self.armed[i] {
                continue;
            }
            let delta = self.target[i] - cnt;
            next = next.min(now + delta * 10);
        }
        next
    }

    pub fn irq(&self, i: usize) -> bool {
        self.int_raw & self.int_ena & (1 << i) != 0
    }
}

// ---------------------------------------------------------------- TIMG (timer group: general timer + watchdog + RTC calibration)
pub struct Timg {
    pub t0config: u32,
    pub t0_offset: i64,
    pub t0_latch: u64,
    pub t0_alarm: u64,
    pub t0_load: u64,
    /// Count already >= alarm when armed (silicon fires at once): reload then counts from load without carrying the excess
    t0_alarm_late: bool,
    pub wdt_cfg: [u32; 6],
    pub wdt_wprotect: u32,
    /// MWDT: active stage and the cycle it started (each stage times from 0, stage 3 wraps to 0)
    pub wdt_stage: u8,
    pub wdt_origin: u64,
    /// Reset requested by a stage timeout: reset reason for the next boot (drained by the SoC bus)
    pub wdt_reset: Option<u32>,
    /// Chip differences: WDT bit in the INT registers (C3 1, S3 / ESP32 2), whether config0 bit 21 selects XTAL
    /// (C3 only; S3 / ESP32 use it as level-int enable and always count APB), group index for the reset reason
    pub wdt_int_bit: u32,
    pub wdt_xtal_sel: bool,
    pub group: u8,
    pub rtccali: [u32; 3],
    pub int_ena: u32,
    pub int_raw: u32,
    pub regclk: u32,
}

impl Default for Timg {
    fn default() -> Self {
        Timg {
            t0config: 0x6000_2000,
            t0_offset: 0,
            t0_latch: 0,
            t0_alarm: 0,
            t0_load: 0,
            t0_alarm_late: false,
            wdt_cfg: [
                0x0004_c000,
                0xffff,
                0x0186_a000,
                0x03ff_ffff,
                0x0fff_ffff,
                0x0fff_ffff,
            ],
            wdt_wprotect: 0,
            wdt_stage: 0,
            wdt_origin: 0,
            wdt_reset: None,
            wdt_int_bit: 1 << 1,
            wdt_xtal_sel: true,
            group: 0,
            rtccali: [0x0001_b000, 0, 0],
            int_ena: 0,
            int_raw: 0,
            regclk: 0,
        }
    }
}

/// RC slow clock about 136kHz, XTAL 40MHz.
const XTAL_HZ: u64 = 40_000_000;
const SLOW_HZ: u64 = 136_000;

const WDT_KEY: u32 = 0x50d8_3aa1;

impl Timg {
    /// C3 timer group `group` (0 / 1)
    pub fn c3(group: u8) -> Timg {
        Timg {
            group,
            ..Timg::default()
        }
    }

    /// S3 / ESP32 layout: WDT interrupt is bit 2 (bit 1 is T1) and the MWDT always counts APB
    pub fn apb_wdt(group: u8) -> Timg {
        Timg {
            group,
            wdt_int_bit: 1 << 2,
            wdt_xtal_sel: false,
            ..Timg::default()
        }
    }

    pub fn wdt_irq(&self) -> bool {
        self.int_raw & self.int_ena & self.wdt_int_bit != 0
    }

    fn wdt_enabled(&self) -> bool {
        // Flashboot mode (bit 14) is not modelled: direct boot skips the bootloader that would clear it
        self.wdt_cfg[0] & (1 << 31) != 0
    }

    /// CPU cycles per MWDT tick: prescaler on XTAL (40 MHz, 4 cycles) or APB (80 MHz, 2 cycles)
    fn wdt_period(&self) -> u64 {
        let pre = ((self.wdt_cfg[1] >> 16) as u64).max(1);
        let per = if self.wdt_xtal_sel && self.wdt_cfg[0] & (1 << 21) != 0 {
            4
        } else {
            2
        };
        pre * per
    }

    fn wdt_deadline(&self) -> u64 {
        let hold = (self.wdt_cfg[2 + self.wdt_stage as usize] as u64).max(1);
        self.wdt_origin + hold * self.wdt_period()
    }

    /// Settle stage timeouts up to `now`; returns the next stage deadline
    fn wdt_update(&mut self, now: u64) -> u64 {
        if !self.wdt_enabled() {
            return u64::MAX;
        }
        // Skip whole 4-stage rounds (tiny holds settled late would loop per tick); the last round is
        // still settled stage by stage, so its interrupt / reset actions fire as before
        if self.wdt_stage == 0 {
            let round: u64 = (2..6)
                .map(|i| (self.wdt_cfg[i] as u64).max(1) * self.wdt_period())
                .sum();
            let n = now.saturating_sub(self.wdt_origin) / round;
            if n > 1 {
                self.wdt_origin += (n - 1) * round;
            }
        }
        loop {
            let d = self.wdt_deadline();
            if d > now {
                return d;
            }
            let act = (self.wdt_cfg[0] >> (29 - 2 * self.wdt_stage as u32)) & 3;
            // soc/reset_reasons.h: core reset by MWDT0 / MWDT1 = 7 / 8, CPU reset by MWDT0 / MWDT1 = 0x0b / 0x11
            match act {
                1 => self.int_raw |= self.wdt_int_bit,
                2 => self.wdt_reset = Some(if self.group == 0 { 0x0b } else { 0x11 }),
                3 => self.wdt_reset = Some(if self.group == 0 { 7 } else { 8 }),
                _ => {}
            }
            self.wdt_stage = (self.wdt_stage + 1) & 3;
            self.wdt_origin = d;
            if self.wdt_reset.is_some() {
                return u64::MAX;
            }
        }
    }

    fn divider(&self) -> u64 {
        let d = ((self.t0config >> 13) & 0xffff) as u64;
        if d == 0 {
            65536
        } else {
            d
        }
    }
    fn src_ticks(&self, now: u64) -> u64 {
        // use_xtal = 1 means 40MHz, otherwise APB 80MHz
        if self.t0config & (1 << 9) != 0 {
            now / 4
        } else {
            now / 2
        }
    }
    pub fn count(&self, now: u64) -> u64 {
        if self.t0config & (1 << 31) == 0 {
            return self.t0_offset as u64;
        }
        ((self.src_ticks(now) / self.divider()) as i64 + self.t0_offset) as u64 & ((1 << 54) - 1)
    }

    pub fn read(&mut self, off: u32, now: u64) -> u32 {
        match off {
            0x00 => self.t0config,
            0x04 => self.t0_latch as u32,
            0x08 => (self.t0_latch >> 32) as u32,
            0x0c => 0,
            0x10 => self.t0_alarm as u32,
            0x14 => (self.t0_alarm >> 32) as u32,
            0x18 => self.t0_load as u32,
            0x1c => (self.t0_load >> 32) as u32,
            0x48..=0x5c => self.wdt_cfg[((off - 0x48) / 4) as usize],
            0x64 => self.wdt_wprotect,
            0x68 => self.rtccali[0],
            0x6c => self.rtccali[1],
            0x80 => self.rtccali[2],
            0x70 => self.int_ena,
            0x74 => self.int_raw,
            0x78 => self.int_raw & self.int_ena,
            0xf8 => 0x2006191,
            0xfc => self.regclk,
            _ => {
                let _ = now;
                0
            }
        }
    }

    /// When the alarm is (re)armed, note whether it is already past
    fn arm(&mut self, now: u64) {
        self.t0_alarm_late = self.count(now) >= self.t0_alarm;
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        // Settle past-due alarms first: auto-reload must apply before reads / config changes, or reads show counts >= alarm
        self.update(now);
        match off {
            0x00 => {
                // Freeze the current count before changing config so the count stays continuous
                let c = self.count(now);
                self.t0config = v;
                if v & (1 << 31) != 0 {
                    self.t0_offset = c as i64 - (self.src_ticks(now) / self.divider()) as i64;
                } else {
                    self.t0_offset = c as i64;
                }
                self.arm(now);
            }
            0x0c => self.t0_latch = self.count(now),
            0x10 => {
                self.t0_alarm = (self.t0_alarm & !0xffff_ffff) | v as u64;
                self.arm(now);
            }
            0x14 => {
                self.t0_alarm = (self.t0_alarm & 0xffff_ffff) | ((v as u64 & 0x3f_ffff) << 32);
                self.arm(now);
            }
            0x18 => self.t0_load = (self.t0_load & !0xffff_ffff) | v as u64,
            0x1c => self.t0_load = (self.t0_load & 0xffff_ffff) | ((v as u64 & 0x3f_ffff) << 32),
            0x20 => {
                if self.t0config & (1 << 31) != 0 {
                    self.t0_offset =
                        self.t0_load as i64 - (self.src_ticks(now) / self.divider()) as i64;
                } else {
                    self.t0_offset = self.t0_load as i64;
                }
                self.arm(now);
            }
            0x48..=0x5c => {
                if self.wdt_wprotect == WDT_KEY {
                    let was = self.wdt_enabled();
                    self.wdt_cfg[((off - 0x48) / 4) as usize] = v;
                    if !was && self.wdt_enabled() {
                        self.wdt_stage = 0;
                        self.wdt_origin = now;
                    }
                }
            }
            0x60 => {
                if self.wdt_wprotect == WDT_KEY {
                    self.wdt_stage = 0;
                    self.wdt_origin = now;
                }
            }
            0x64 => self.wdt_wprotect = v,
            0x68 => {
                // Calibration completes instantly: RDY always 1, result = slow-clock cycles x XTAL / slow clock
                let max = ((v >> 16) & 0x7fff) as u64;
                let val = max * XTAL_HZ / SLOW_HZ;
                self.rtccali[1] = ((val as u32) & 0x1ff_ffff) << 7;
                self.rtccali[0] = v | (1 << 15);
            }
            0x6c => {}
            0x80 => self.rtccali[2] = v,
            0x70 => self.int_ena = v,
            0x7c => self.int_raw &= !v,
            0xfc => self.regclk = v,
            _ => {}
        }
    }

    pub fn update(&mut self, now: u64) -> u64 {
        let wdt = self.wdt_update(now);
        self.t0_update(now).min(wdt)
    }

    fn t0_update(&mut self, now: u64) -> u64 {
        // T0 alarm
        if self.t0config & (1 << 31) != 0 && self.t0config & (1 << 10) != 0 {
            let c = self.count(now);
            if c >= self.t0_alarm {
                self.int_raw |= 1;
                self.t0config &= !(1 << 10);
                if self.t0config & (1 << 29) != 0 {
                    // Silicon reloads on the tick the count hits the alarm and keeps counting: when settled late, add back the extra ticks
                    // so the period doesn't drift with settle time
                    let late = if self.t0_alarm_late {
                        0
                    } else {
                        c - self.t0_alarm
                    };
                    self.t0_offset = (self.t0_load + late) as i64
                        - (self.src_ticks(now) / self.divider()) as i64;
                }
                self.t0_alarm_late = false;
            } else {
                let ticks = (self.t0_alarm - c) * self.divider();
                let per = if self.t0config & (1 << 9) != 0 { 4 } else { 2 };
                return now + ticks * per;
            }
        }
        u64::MAX
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
        let undriven = !driven & !self.ext_driven;
        // Pins driven by a peripheral (RMT etc.) through the GPIO matrix take the peripheral's level
        let out = (self.out & !self.periph_mask) | (self.periph_level & self.periph_mask);
        (out & driven) | (self.ext_in & self.ext_driven & !driven) | (pull & undriven & 0x3f_ffff)
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
/// ADC1 ch 0..4 = GPIO0..4, ADC2 ch 0 = GPIO5; voltage set externally (web knob / tests). Range per attenuation (datasheet,
/// approx.): 0dB≈750mV, 2.5dB≈1050mV, 6dB≈1300mV, 12dB≈2500mV. (lint: allow-long-comment)
pub struct Adc {
    pub regs: [u32; 0x400 / 4],
    /// Voltage on each pin (mV)
    pub pin_mv: [f32; 22],
    /// Noise amplitude (LSB), real ADC readings jitter; 0 disables
    pub noise_lsb: u32,
    seed: u32,
}

impl Default for Adc {
    fn default() -> Self {
        Adc {
            regs: [0; 0x400 / 4],
            pin_mv: [0.0; 22],
            noise_lsb: 2,
            seed: 0x1234_5678,
        }
    }
}

impl Adc {
    pub fn read(&self, off: u32) -> u32 {
        match off {
            0x48 => self.regs[0x44 / 4] & self.regs[0x40 / 4],
            0x3fc => 0x2007171,
            _ => self.regs[(off / 4) as usize],
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let i = (off / 4) as usize;
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
        let full = [750.0, 1050.0, 1300.0, 2500.0][atten as usize];
        let mv = if (unit == 0 && ch <= 4) || (unit == 1 && ch == 0) {
            self.pin_mv[pin]
        } else {
            0.0
        };
        // Linear congruential noise, reproducible
        self.seed = self.seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
        let n = if self.noise_lsb > 0 {
            (self.seed >> 16) % (2 * self.noise_lsb + 1)
        } else {
            0
        } as i32
            - self.noise_lsb as i32;
        let raw = ((mv / full * 4095.0).round() as i32 + n).clamp(0, 4095) as u32;
        if unit == 0 {
            self.regs[0x2c / 4] = raw;
            self.regs[0x44 / 4] |= 1 << 31;
        } else {
            self.regs[0x30 / 4] = raw;
            self.regs[0x44 / 4] |= 1 << 30;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// gptimer style: APB 80 MHz / 80 = 1 MHz, alarm 10000, auto-reload to 0
    fn periodic() -> Timg {
        let mut t = Timg::default();
        t.write(0x10, 10_000, 0);
        t.write(
            0x00,
            (1 << 31) | (1 << 30) | (1 << 29) | (80 << 13) | (1 << 10),
            0,
        );
        t
    }

    #[test]
    fn timg_autoreload_keeps_phase() {
        // 1 us = 160 CPU cycles. Alarm settled 300 us late: after reload the count should be 300, not 0
        let mut t = periodic();
        t.update(10_300 * 160);
        assert_eq!(t.int_raw & 1, 1);
        assert_eq!(t.count(10_300 * 160), 300);
        // Latch a reading (write UPDATE) before settling: must not read >= alarm
        let mut t = periodic();
        t.write(0x0c, 1, 10_050 * 160);
        assert_eq!(t.t0_latch, 50);
        // Already past when armed: fire at once and count from load
        let mut t = Timg::default();
        t.write(0x00, (1 << 31) | (1 << 30) | (1 << 29) | (80 << 13), 0);
        t.write(0x10, 100, 500 * 160);
        t.write(0x00, t.t0config | (1 << 10), 500 * 160);
        t.update(500 * 160);
        assert_eq!(t.int_raw & 1, 1);
        assert_eq!(t.count(500 * 160), 0);
    }

    /// IDF task watchdog setup on C3: XTAL / 20000 = 500 us ticks, stage 0 interrupt after 5 s, stage 1 system reset after 10 s
    fn twdt(t: &mut Timg, now: u64) {
        t.write(0x64, WDT_KEY, now);
        t.write(0x4c, 20_000 << 16, now);
        t.write(0x50, 10_000, now);
        t.write(0x54, 20_000, now);
        t.write(0x70, 1 << 1, now);
        t.write(0x48, (1 << 31) | (3 << 27) | (1 << 29) | (1 << 21), now);
        t.write(0x64, 0, now);
    }

    const S: u64 = CPU_HZ;

    #[test]
    fn mwdt_stage_timing() {
        let mut t = Timg::c3(0);
        twdt(&mut t, 0);
        assert_eq!(t.update(S), 5 * S);
        assert!(!t.wdt_irq());
        t.update(5 * S);
        assert!(t.wdt_irq());
        // Stage 1 times from the stage-0 timeout: system reset (CORE_MWDT0 = 7) at 15 s
        assert_eq!(t.update(5 * S + 1), 15 * S);
        assert_eq!(t.wdt_reset, None);
        t.update(15 * S);
        assert_eq!(t.wdt_reset, Some(7));
        // Group 1, CPU-reset action -> CPU0_MWDT1 = 0x11
        let mut t = Timg::c3(1);
        twdt(&mut t, 0);
        t.write(0x64, WDT_KEY, 0);
        t.write(0x48, (1 << 31) | (2 << 29) | (1 << 21), 0);
        t.update(5 * S);
        assert_eq!(t.wdt_reset, Some(0x11));
        // S3 / ESP32: bit 21 is not a clock select, APB / 40000 is also 500 us; interrupt on bit 2
        let mut t = Timg::apb_wdt(0);
        twdt(&mut t, 0);
        t.write(0x64, WDT_KEY, 0);
        t.write(0x4c, 40_000 << 16, 0);
        t.write(0x70, 1 << 2, 0);
        t.write(0x64, 0, 0);
        t.update(5 * S);
        assert!(t.wdt_irq() && t.int_raw == 1 << 2);
    }

    #[test]
    fn mwdt_feed_and_write_protect() {
        let mut t = Timg::c3(0);
        twdt(&mut t, 0);
        // Feed while locked is ignored
        t.write(0x60, 1, 4 * S);
        assert_eq!(t.update(4 * S), 5 * S);
        // Unlocked feed restarts stage 0 from now
        t.write(0x64, WDT_KEY, 4 * S);
        t.write(0x60, 1, 4 * S);
        assert_eq!(t.update(4 * S), 9 * S);
        // ISR path: clear interrupt and feed after stage 0 fired; stage 1 must not be reached
        t.update(9 * S);
        assert!(t.wdt_irq());
        t.write(0x7c, 1 << 1, 9 * S);
        t.write(0x60, 1, 9 * S);
        assert!(!t.wdt_irq());
        assert_eq!(t.update(9 * S), 14 * S);
        assert_eq!(t.wdt_reset, None);
        // Config writes while locked are dropped; disabling stops the countdown
        t.write(0x64, 0, 9 * S);
        t.write(0x48, 0, 9 * S);
        assert_eq!(t.update(9 * S), 14 * S);
        t.write(0x64, WDT_KEY, 9 * S);
        t.write(0x48, 0, 9 * S);
        assert_eq!(t.update(20 * S), u64::MAX);
        // Watchdog never enabled: no deadline from it
        assert_eq!(Timg::c3(0).update(100 * S), u64::MAX);
        // Tiny holds settled very late: rounds are skipped arithmetically and the phase is kept
        let mut t = Timg::c3(0);
        t.write(0x64, WDT_KEY, 0);
        t.write(0x4c, 1 << 16, 0);
        for o in [0x50, 0x54, 0x58, 0x5c] {
            t.write(o, 1, 0);
        }
        t.write(0x48, (1 << 31) | (1 << 29), 0);
        assert_eq!(t.update(1_000_000_001), 1_000_000_002);
        assert!(t.int_raw & (1 << 1) != 0);
    }
}
