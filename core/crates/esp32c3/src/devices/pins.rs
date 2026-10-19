//! External devices that drive / watch GPIOs directly: rotary encoder (P2-01), HC-SR04 ultrasonic (P2-04).
//! Unlike I2C devices their output is a precisely timed waveform (quadrature, Echo width), so they live in the SoC:
//! `poll(now)` yields drives (time, pin, level) applied to GPIO in order (firing GPIO IRQs, PCNT / RMT RX, logic analyzer);
//! `on_level` shows the device the chip's output (Trig). External input (steps, press, distance) arrives from the CLI
//! script / web input log between time slices, and the device schedules the following waveform itself. (lint: allow-long-comment)

use std::collections::VecDeque;

use crate::periph::CPU_HZ;

/// One pin drive: (cycle, pin, level), level -1 = released (high-Z)
pub type Drive = (u64, u32, i8);

/// Gap between adjacent edges within one encoder step: 0.5 ms (4 edges = 2 ms per step, ~500 steps/s, far faster than real turning)
pub const ENC_EDGE_CYCLES: u64 = CPU_HZ / 2000;

/// EC11-style encoder module (KY-040): A (CLK) / B (DT) quadrature, 10 kΩ pull-ups on the module, contacts short to GND; one full
/// cycle (4 edges) per step; SW shorts to GND when pressed. Clockwise: A falls first (A leads B by 90°). No contact bounce (see DECISIONS).
#[derive(Clone, Debug)]
pub struct Encoder {
    pub a: u32,
    pub b: u32,
    pub sw: Option<u32>,
    /// Steps completed (clockwise positive)
    pub position: i64,
    pub pressed: bool,
    /// Steps not yet turned (each ±1)
    queue: VecDeque<i8>,
    /// Direction of the current step and edges done so far
    dir: i8,
    phase: u8,
    next_t: u64,
    /// Drives to apply (those that take effect immediately: attach / button)
    out: Vec<Drive>,
}

impl Encoder {
    pub fn new(a: u32, b: u32, sw: Option<u32>, now: u64) -> Encoder {
        // Power-up: both phases open (pulled high), button released
        let mut out = vec![(now, a, 1), (now, b, 1)];
        if let Some(s) = sw {
            out.push((now, s, -1));
        }
        Encoder {
            a,
            b,
            sw,
            position: 0,
            pressed: false,
            queue: VecDeque::new(),
            dir: 0,
            phase: 0,
            next_t: now,
            out,
        }
    }

    /// Turn by steps (positive = clockwise), queued after whatever is pending
    pub fn turn(&mut self, now: u64, steps: i32) {
        if self.dir == 0 && self.queue.is_empty() {
            self.next_t = self.next_t.max(now);
        }
        let s = steps.signum() as i8;
        for _ in 0..steps.unsigned_abs().min(10_000) {
            self.queue.push_back(s);
        }
    }

    pub fn press(&mut self, now: u64, down: bool) {
        self.pressed = down;
        if let Some(s) = self.sw {
            self.out.push((now, s, if down { 0 } else { -1 }));
        }
    }

    /// (A, B) levels after edge k within a step
    fn levels(dir: i8, k: u8) -> (bool, bool) {
        const CW: [(bool, bool); 4] = [(false, true), (false, false), (true, false), (true, true)];
        const CCW: [(bool, bool); 4] = [(true, false), (false, false), (false, true), (true, true)];
        if dir > 0 {
            CW[k as usize]
        } else {
            CCW[k as usize]
        }
    }

    pub fn poll(&mut self, now: u64, out: &mut Vec<Drive>) -> u64 {
        out.append(&mut self.out);
        loop {
            if self.dir == 0 {
                match self.queue.pop_front() {
                    Some(d) => {
                        self.dir = d;
                        self.phase = 0;
                    }
                    None => return u64::MAX,
                }
            }
            if self.next_t > now {
                return self.next_t;
            }
            let t = self.next_t;
            let (pa, pb) = if self.phase == 0 {
                (true, true)
            } else {
                Self::levels(self.dir, self.phase - 1)
            };
            let (a, b) = Self::levels(self.dir, self.phase);
            if a != pa {
                out.push((t, self.a, a as i8));
            }
            if b != pb {
                out.push((t, self.b, b as i8));
            }
            self.phase += 1;
            self.next_t = t + ENC_EDGE_CYCLES;
            if self.phase == 4 {
                self.position += self.dir as i64;
                self.dir = 0;
            }
        }
    }
}

/// Speed of sound (m/s): dry air at 20 °C. Real speed varies with temperature (~+0.6 m/s/°C); fixed here, see DECISIONS
pub const SOUND_MPS: f64 = 343.0;
/// Trig falling edge to Echo rising: the module first sends 8 pulses at 40 kHz (200 µs). Not in the datasheet; a typical measured value
pub const ECHO_DELAY_US: f64 = 250.0;
/// Echo high width when nothing is in range (datasheet: about 38 ms)
pub const ECHO_TIMEOUT_US: f64 = 38_000.0;
/// Range (datasheet 2-400 cm)
pub const RANGE_CM: (f64, f64) = (2.0, 400.0);

/// HC-SR04: Trig high >= 10 µs; ECHO_DELAY_US after its falling edge Echo goes high for round-trip time = 2 x distance / speed of sound.
/// Echo is a 5 V push-pull output (module on 5 V): the level risk is flagged by web wiring checks / advisor rules; logic level only here.
#[derive(Clone, Debug)]
pub struct Hcsr04 {
    pub trig: u32,
    pub echo: u32,
    /// Distance from probe to obstacle (cm); None = nothing ahead (out of range)
    pub distance_cm: Option<f64>,
    trig_high: Option<u64>,
    /// Echo rise / fall times of one measurement (scheduled, not yet happened)
    pulse: Option<(u64, u64)>,
    echo_high: bool,
    /// Trigger count and echoes sent (stats)
    pub pings: u64,
    pub echoes: u64,
    /// Width of the latest Echo (µs)
    pub last_us: f64,
    out: Vec<Drive>,
}

impl Hcsr04 {
    pub fn new(trig: u32, echo: u32, now: u64) -> Hcsr04 {
        Hcsr04 {
            trig,
            echo,
            distance_cm: Some(100.0),
            trig_high: None,
            pulse: None,
            echo_high: false,
            pings: 0,
            echoes: 0,
            last_us: 0.0,
            out: vec![(now, echo, 0)],
        }
    }

    /// Echo high width (µs) for this distance
    pub fn echo_us(d: Option<f64>) -> f64 {
        match d {
            Some(cm) if (RANGE_CM.0..=RANGE_CM.1).contains(&cm) => {
                2.0 * cm / 100.0 / SOUND_MPS * 1e6
            }
            Some(cm) if cm < RANGE_CM.0 => 2.0 * RANGE_CM.0 / 100.0 / SOUND_MPS * 1e6,
            _ => ECHO_TIMEOUT_US,
        }
    }

    /// Chip-side pin levels changed (bit = pin number)
    pub fn on_level(&mut self, t: u64, level: u64) {
        let hi = level >> self.trig & 1 != 0;
        match (hi, self.trig_high) {
            (true, None) => self.trig_high = Some(t),
            (false, Some(t0)) => {
                self.trig_high = None;
                // Ignore triggers while a measurement is in progress (echo not finished)
                if t - t0 >= CPU_HZ / 100_000 && self.pulse.is_none() {
                    self.pings += 1;
                    let us = Self::echo_us(self.distance_cm);
                    let rise = t + (ECHO_DELAY_US * CPU_HZ as f64 / 1e6) as u64;
                    let fall = rise + (us * CPU_HZ as f64 / 1e6).round() as u64;
                    self.pulse = Some((rise, fall));
                    self.last_us = us;
                }
            }
            _ => {}
        }
    }

    pub fn poll(&mut self, now: u64, out: &mut Vec<Drive>) -> u64 {
        out.append(&mut self.out);
        let Some((rise, fall)) = self.pulse else {
            return u64::MAX;
        };
        if !self.echo_high {
            if rise > now {
                return rise;
            }
            out.push((rise, self.echo, 1));
            self.echo_high = true;
        }
        if fall > now {
            return fall;
        }
        out.push((fall, self.echo, 0));
        self.echo_high = false;
        self.pulse = None;
        self.echoes += 1;
        u64::MAX
    }
}

/// Devices of this kind attached to the SoC
#[derive(Clone, Debug, Default)]
pub struct PinDevices {
    pub encoders: Vec<Encoder>,
    pub sonars: Vec<Hcsr04>,
}

impl PinDevices {
    pub fn is_empty(&self) -> bool {
        self.encoders.is_empty() && self.sonars.is_empty()
    }

    pub fn on_level(&mut self, t: u64, level: u64) {
        for s in &mut self.sonars {
            s.on_level(t, level);
        }
    }

    /// Drives due by now (time-ordered) and the next time to ask again
    pub fn poll(&mut self, now: u64) -> (Vec<Drive>, u64) {
        let mut out = Vec::new();
        let mut next = u64::MAX;
        for e in &mut self.encoders {
            next = next.min(e.poll(now, &mut out));
        }
        for s in &mut self.sonars {
            next = next.min(s.poll(now, &mut out));
        }
        out.sort_by_key(|d| d.0);
        (out, next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoder_quadrature_cw_then_ccw() {
        let mut e = Encoder::new(6, 7, Some(15), 0);
        let (d, _) = (e.poll(0, &mut Vec::new()), ());
        assert_eq!(d, u64::MAX);
        e.turn(1000, 1);
        e.turn(1000, -1);
        let mut out = Vec::new();
        let mut now = 1000;
        while now != u64::MAX {
            now = e.poll(now, &mut out);
        }
        // Clockwise: A falls, B falls, A rises, B rises; counter-clockwise: B falls, A falls, B rises, A rises
        let seq: Vec<(u32, i8)> = out.iter().map(|d| (d.1, d.2)).collect();
        assert_eq!(
            seq,
            vec![
                (6, 0),
                (7, 0),
                (6, 1),
                (7, 1),
                (7, 0),
                (6, 0),
                (7, 1),
                (6, 1)
            ]
        );
        assert_eq!(out[1].0 - out[0].0, ENC_EDGE_CYCLES);
        assert_eq!(e.position, 0);
    }

    #[test]
    fn sonar_echo_width() {
        let mut s = Hcsr04::new(17, 18, 0);
        s.distance_cm = Some(50.0);
        let us = CPU_HZ / 1_000_000;
        s.on_level(100 * us, 1 << 17);
        s.on_level(112 * us, 0);
        let mut out = Vec::new();
        let mut now = 0;
        loop {
            let n = s.poll(now, &mut out);
            if n == u64::MAX {
                break;
            }
            now = n;
        }
        let rise = out.iter().find(|d| d.2 == 1).unwrap().0;
        let fall = out.iter().rev().find(|d| d.2 == 0).unwrap().0;
        // 50 cm → 2 × 0.5 / 343 = 2915.5 µs
        assert!(((fall - rise) as f64 / us as f64 - 2915.45).abs() < 0.1);
        assert_eq!(rise, 112 * us + 250 * us);
        // Too-short trigger (5 µs): no response
        s.on_level(10_000 * us, 1 << 17);
        s.on_level(10_005 * us, 0);
        assert_eq!(s.pings, 1);
    }
}
