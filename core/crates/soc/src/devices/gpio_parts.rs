//! Simple tutorial parts on plain GPIO / ADC pins (F-04d): HC-SR501 PIR motion sensor, relay module, photoresistor
//! divider, plus the RC522 reader's chip-select tracking. They hang off `PinDevices` like the DHT11 does.

use super::pins::Drive;
use super::rc522::Rc522;
use super::xpt2046::Xpt2046;
use crate::periph::CPU_HZ;

/// HC-SR501 block time after the output falls: triggers are ignored for ~2.5 s (BISS0001 default)
pub const PIR_BLOCK_CYCLES: u64 = CPU_HZ * 5 / 2;

/// HC-SR501 in repeatable-trigger mode (the "H" jumper most modules ship with): output high while motion is
/// seen and for `hold` after the last of it; then blocked for 2.5 s. The ~60 s warm-up after power-on is skipped
#[derive(Clone, Debug)]
pub struct Pir {
    pub pin: u32,
    pub hold: u64,
    motion: bool,
    pub high: bool,
    rise_t: u64,
    fall_at: u64,
    block_until: u64,
    /// Rising edges of the output, and total time it was high (cycles, closed intervals only)
    pub triggers: u64,
    pub high_cycles: u64,
    out: Vec<Drive>,
}

impl Pir {
    pub fn new(pin: u32, hold_s: f64, now: u64) -> Pir {
        Pir {
            pin,
            hold: (hold_s.max(0.0) * CPU_HZ as f64) as u64,
            motion: false,
            high: false,
            rise_t: 0,
            fall_at: u64::MAX,
            block_until: 0,
            triggers: 0,
            high_cycles: 0,
            out: vec![(now, pin, 0)],
        }
    }

    /// Someone moving in front of the lens (true) or gone (false); script action pir=1 / pir=0
    pub fn set_motion(&mut self, now: u64, on: bool) {
        self.motion = on;
        if self.high {
            self.fall_at = if on { u64::MAX } else { now + self.hold };
        }
    }

    pub fn poll(&mut self, now: u64, out: &mut Vec<Drive>) -> u64 {
        out.append(&mut self.out);
        if self.high && self.fall_at <= now {
            let t = self.fall_at;
            out.push((t, self.pin, 0));
            self.high = false;
            self.high_cycles += t - self.rise_t;
            self.fall_at = u64::MAX;
            self.block_until = t + PIR_BLOCK_CYCLES;
        }
        if !self.high && self.motion && self.block_until <= now {
            let t = self.block_until.max(now);
            out.push((t, self.pin, 1));
            self.high = true;
            self.rise_t = t;
            self.triggers += 1;
        }
        match (self.high, self.motion) {
            (true, _) => self.fall_at,
            (false, true) => self.block_until,
            _ => u64::MAX,
        }
    }

    /// Seconds the output has been high so far (including a high still in progress)
    pub fn high_s(&self, now: u64) -> f64 {
        let open = if self.high { now - self.rise_t } else { 0 };
        (self.high_cycles + open) as f64 / CPU_HZ as f64
    }
}

/// Relay module on one GPIO (IN pin). `active_high` modules close on a high input (transistor driver); low-trigger
/// optocoupler boards close on low. Watches the chip's output only; contact bounce and the ~10 ms pull-in are ignored
#[derive(Clone, Debug)]
pub struct Relay {
    pub pin: u32,
    pub active_high: bool,
    pub on: bool,
    on_t: u64,
    pub switches: u64,
    pub on_cycles: u64,
    /// Switch events not yet taken by the host (cycle, closed)
    pub events: Vec<(u64, bool)>,
}

impl Relay {
    pub fn new(pin: u32, active_high: bool) -> Relay {
        Relay {
            pin,
            active_high,
            on: false,
            on_t: 0,
            switches: 0,
            on_cycles: 0,
            events: Vec::new(),
        }
    }

    pub fn on_level(&mut self, t: u64, level: u64) {
        let on = (level >> self.pin & 1 != 0) == self.active_high;
        if on == self.on {
            return;
        }
        self.on = on;
        self.switches += 1;
        if on {
            self.on_t = t;
        } else {
            self.on_cycles += t - self.on_t;
        }
        self.events.push((t, on));
    }

    pub fn on_s(&self, now: u64) -> f64 {
        let open = if self.on { now - self.on_t } else { 0 };
        (self.on_cycles + open) as f64 / CPU_HZ as f64
    }
}

/// Fixed resistor of the photoresistor divider (LDR from 3V3 to the pin, this to GND: brighter = higher voltage)
pub const LDR_FIXED_OHM: f64 = 10_000.0;
/// GL5528-class LDR: ~10 kohm at 10 lux, gamma 0.7, ~1 Mohm dark resistance
pub const LDR_R10_OHM: f64 = 10_000.0;
pub const LDR_GAMMA: f64 = 0.7;
pub const LDR_DARK_OHM: f64 = 1_000_000.0;

/// Photoresistor divider on an ADC pin; the host turns `lux` into a pad voltage
#[derive(Clone, Debug)]
pub struct Ldr {
    pub pin: u32,
    pub lux: f64,
}

impl Ldr {
    pub fn ohms(lux: f64) -> f64 {
        if lux <= 0.0 {
            return LDR_DARK_OHM;
        }
        (LDR_R10_OHM * (lux / 10.0).powf(-LDR_GAMMA)).min(LDR_DARK_OHM)
    }

    /// Pad voltage (mV) at `lux` with a 3.3 V supply
    pub fn mv(lux: f64) -> f32 {
        (3300.0 * LDR_FIXED_OHM / (LDR_FIXED_OHM + Self::ohms(lux))) as f32
    }
}

/// The parts above attached to one SoC
#[derive(Clone, Debug, Default)]
pub struct GpioParts {
    pub pirs: Vec<Pir>,
    pub relays: Vec<Relay>,
    pub ldrs: Vec<Ldr>,
    /// RC522 on the SPI bus: the chip's SPI transfer hands it bytes; here only its GPIO chip select is tracked
    pub rc522: Option<Box<Rc522>>,
    /// XPT2046 touch controller on SPI (CYD), same chip-select tracking as the RC522
    pub xpt2046: Option<Box<Xpt2046>>,
}

impl GpioParts {
    pub fn is_empty(&self) -> bool {
        self.pirs.is_empty()
            && self.relays.is_empty()
            && self.rc522.is_none()
            && self.xpt2046.is_none()
    }

    pub fn on_level(&mut self, t: u64, level: u64) {
        for r in &mut self.relays {
            r.on_level(t, level);
        }
        // CS driven high as a plain GPIO (Arduino style) ends the SPI frame
        if let Some(r) = &mut self.rc522 {
            if level >> r.cs & 1 != 0 {
                r.cs_release();
            }
        }
        if let Some(t) = &mut self.xpt2046 {
            if level >> t.cs & 1 != 0 {
                t.cs_release();
            }
        }
    }

    pub fn poll(&mut self, now: u64, out: &mut Vec<Drive>) -> u64 {
        let mut next = u64::MAX;
        for p in &mut self.pirs {
            next = next.min(p.poll(now, out));
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(p: &mut Pir, until: u64, out: &mut Vec<Drive>) {
        let mut now = 0;
        while now <= until {
            let n = p.poll(now, out);
            now = if n == u64::MAX || n <= now {
                now + CPU_HZ / 100
            } else {
                n
            };
        }
    }

    #[test]
    fn pir_hold_retrigger_and_block() {
        let s = CPU_HZ;
        let mut p = Pir::new(4, 2.0, 0);
        let mut out = Vec::new();
        p.poll(0, &mut out);
        p.set_motion(s / 2, true);
        p.poll(s / 2, &mut out);
        p.set_motion(s, false);
        // Retrigger while high: motion again at 2 s extends the hold from 2.5 s
        p.set_motion(2 * s, true);
        p.set_motion(2 * s + s / 2, false);
        run(&mut p, 5 * s, &mut out);
        let edges: Vec<(u64, i8)> = out.iter().map(|d| (d.0, d.2)).collect();
        assert_eq!(edges, vec![(0, 0), (s / 2, 1), (4 * s + s / 2, 0)]);
        assert_eq!(p.triggers, 1);
        assert!((p.high_s(5 * s) - 4.0).abs() < 1e-9);
        // Within the 2.5 s block nothing rises; motion still present at its end does
        out.clear();
        p.set_motion(5 * s, true);
        run(&mut p, 8 * s, &mut out);
        assert_eq!(out, vec![(7 * s, 4, 1)]);
        assert_eq!(p.triggers, 2);
    }

    #[test]
    fn relay_tracks_switches_and_on_time() {
        let mut r = Relay::new(5, true);
        r.on_level(100, 1 << 5);
        r.on_level(150, 1 << 5 | 1);
        r.on_level(400, 0);
        assert_eq!((r.switches, r.on_cycles, r.on), (2, 300, false));
        assert_eq!(r.events, vec![(100, true), (400, false)]);
        let mut low = Relay::new(5, false);
        low.on_level(10, 0);
        assert!(low.on);
    }

    #[test]
    fn gpio_cs_high_ends_the_rc522_frame() {
        let mut g = GpioParts {
            rc522: Some(Box::new(Rc522::new(7))),
            ..Default::default()
        };
        let r = g.rc522.as_mut().unwrap();
        // Arduino style: CS low, one byte per transfer; the address byte is only re-armed by CS going high
        r.byte(0x80 | 0x37 << 1);
        assert_eq!(r.byte(0), 0x92);
        g.on_level(10, 1 << 7);
        let r = g.rc522.as_mut().unwrap();
        assert_eq!(r.byte(0x80 | 0x37 << 1), 0);
        assert_eq!(r.byte(0), 0x92);
    }

    #[test]
    fn ldr_divider_is_monotonic() {
        assert!((Ldr::ohms(10.0) - 10_000.0).abs() < 1e-6);
        assert!((Ldr::mv(10.0) - 1650.0).abs() < 0.01);
        assert!(Ldr::mv(0.0) < 40.0);
        let mut last = 0.0;
        for lux in [0.0, 0.5, 2.0, 10.0, 100.0, 1000.0, 10_000.0] {
            let v = Ldr::mv(lux);
            assert!(v > last && v < 3300.0);
            last = v;
        }
    }
}
