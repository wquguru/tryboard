//! IR remote link (F-10c): an NEC remote aimed at a 38 kHz receiver module (VS1838B / TSOP38238 style) whose
//! active-low demodulated output drives `rx_pin`, plus an "eye" watching the board's IR LED on `tx_pin`. The eye
//! sees the LED's real carrier toggles (classic ESP32 RMT), keeps only 20-60 kHz bursts (what a receiver module
//! passes), decodes NEC from the envelope, and optionally forwards the envelope to the same receiver (loopback,
//! an LED pointed at the module). Receiver delay and envelope timing are idealised, not calibrated. (lint: allow-long-comment)

use std::collections::VecDeque;

use super::pins::Drive;
use crate::periph::CPU_HZ;

const US: u64 = CPU_HZ / 1_000_000;
/// Receiver module output delay after the burst starts / ends (datasheets: ~100-300 us); same on both edges
pub const RX_DELAY_US: u64 = 150;
/// A burst ends when no carrier edge arrives for this long
const GAP_US: u64 = 60;
/// Carrier pulses longer than this (below ~20 kHz) are not a carrier: the receiver module ignores them
const MAX_HALF_US: u64 = 25;
/// Idle after the last burst that closes a frame for decoding
const FRAME_END_US: u64 = 15_000;
/// NEC frame period (a held key repeats every 108 ms)
const NEC_PERIOD_US: u64 = 108_000;

/// One IR remote code
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IrCode {
    /// NEC extended frame as the IDF example reads it: 16-bit address then 16-bit command, LSB first
    Nec { addr: u16, cmd: u16 },
    /// NEC repeat code (key held)
    Repeat,
}

impl IrCode {
    /// `ADDR,CMD` (hex, 16-bit each), a single 32-bit hex value (command << 16 | address), or `repeat`
    pub fn parse(s: &str) -> Result<IrCode, String> {
        let s = s.trim();
        if s.eq_ignore_ascii_case("repeat") || s.eq_ignore_ascii_case("rep") {
            return Ok(IrCode::Repeat);
        }
        let hex = |x: &str| {
            let x = x.trim();
            let x = x
                .strip_prefix("0x")
                .or_else(|| x.strip_prefix("0X"))
                .unwrap_or(x);
            u32::from_str_radix(x, 16).ok()
        };
        let bad = || format!("ir= needs ADDR,CMD (hex), a 32-bit hex code or repeat, got '{s}'");
        match s.split_once(',') {
            Some((a, c)) => match (hex(a), hex(c)) {
                (Some(a), Some(c)) if a <= 0xffff && c <= 0xffff => Ok(IrCode::Nec {
                    addr: a as u16,
                    cmd: c as u16,
                }),
                _ => Err(bad()),
            },
            None => hex(s)
                .map(|v| IrCode::Nec {
                    addr: v as u16,
                    cmd: (v >> 16) as u16,
                })
                .ok_or_else(bad),
        }
    }

    /// Marks and spaces (us): lead 9000 / 4500, bit 560 + 560 (0) or 1690 (1), stop 560; repeat 9000 / 2250 + 560
    pub fn bursts(self) -> Vec<(u64, u64)> {
        match self {
            IrCode::Repeat => vec![(9000, 2250), (560, 0)],
            IrCode::Nec { addr, cmd } => {
                let bits = addr as u32 | (cmd as u32) << 16;
                let mut v = vec![(9000, 4500)];
                v.extend((0..32).map(|k| (560, if bits >> k & 1 != 0 { 1690 } else { 560 })));
                v.push((560, 0));
                v
            }
        }
    }

    /// Decode marks / spaces (us) of one frame, ±25 % tolerance
    pub fn decode(b: &[(u64, u64)]) -> Option<IrCode> {
        let near = |v: u64, want: u64| v * 4 >= want * 3 && v * 4 <= want * 5;
        let (lead, space) = *b.first()?;
        if !near(lead, 9000) {
            return None;
        }
        if b.len() == 2 && near(space, 2250) {
            return Some(IrCode::Repeat);
        }
        if b.len() != 34 || !near(space, 4500) {
            return None;
        }
        let mut bits = 0u32;
        for (k, &(m, s)) in b[1..33].iter().enumerate() {
            if !near(m, 560) {
                return None;
            }
            if near(s, 1690) {
                bits |= 1 << k;
            } else if !near(s, 560) {
                return None;
            }
        }
        Some(IrCode::Nec {
            addr: bits as u16,
            cmd: (bits >> 16) as u16,
        })
    }

    pub fn text(self) -> String {
        match self {
            IrCode::Nec { addr, cmd } => format!("NEC address=0x{addr:04X} command=0x{cmd:04X}"),
            IrCode::Repeat => "NEC repeat".into(),
        }
    }
}

/// What the eye saw on the IR LED pin
#[derive(Clone, Debug, PartialEq)]
pub struct IrSeen {
    /// Cycle when the frame closed
    pub t: u64,
    /// Decoded code; None = bursts that aren't NEC
    pub code: Option<IrCode>,
    pub bursts: usize,
    /// Mean carrier frequency (Hz)
    pub carrier_hz: f64,
}

/// Remote + receiver module on rx_pin, and / or the eye on the IR LED tx_pin
#[derive(Clone, Debug, Default)]
pub struct IrLink {
    pub rx_pin: Option<u32>,
    pub tx_pin: Option<u32>,
    /// Eye bursts also reach the receiver module (LED aimed at it)
    pub loopback: bool,
    /// Receiver input events (cycle, source 0 = remote / 1 = LED, burst on), kept sorted
    events: VecDeque<(u64, u8, bool)>,
    on: [bool; 2],
    out_low: bool,
    remote_free: u64,
    out: Vec<Drive>,
    /// Eye: current burst (start, first rise, last rise, last fall, rises)
    burst: Option<(u64, u64, u64, u64, u64)>,
    hi_since: Option<u64>,
    /// LEDC carrier envelope switched on at (cycle, Hz); LEDC never toggles the pin per period
    env: Option<(u64, f64)>,
    frame: Vec<(u64, u64)>,
    last_end: u64,
    car_sum: f64,
    car_n: u64,
    /// Remote frames sent, LED frames decoded, LED pulses without a usable carrier
    pub sent: u64,
    pub seen: Vec<IrSeen>,
    pub decoded: u64,
    pub unmodulated: u64,
}

impl IrLink {
    pub fn new(rx_pin: Option<u32>, tx_pin: Option<u32>, loopback: bool, now: u64) -> IrLink {
        IrLink {
            rx_pin,
            tx_pin,
            loopback: loopback && rx_pin.is_some() && tx_pin.is_some(),
            out: rx_pin.map(|p| vec![(now, p, 1)]).unwrap_or_default(),
            ..IrLink::default()
        }
    }

    fn push(&mut self, ev: (u64, u8, bool)) {
        let at = self.events.partition_point(|e| e.0 <= ev.0);
        self.events.insert(at, ev);
    }

    /// The remote sends one code (script action ir=); queued behind a frame still in the air
    pub fn press(&mut self, now: u64, code: IrCode) {
        if self.rx_pin.is_none() {
            return;
        }
        let start = now.max(self.remote_free);
        let mut t = start;
        for (m, s) in code.bursts() {
            self.push((t + RX_DELAY_US * US, 0, true));
            self.push((t + (RX_DELAY_US + m) * US, 0, false));
            t += (m + s) * US;
        }
        self.remote_free = start + NEC_PERIOD_US * US;
        self.sent += 1;
    }

    /// IR LED pin level at t (every carrier toggle, in time order)
    pub fn feed(&mut self, t: u64, lv: bool) {
        // Edges can arrive in a batch: close a burst / frame that ended before this edge first
        self.eye_poll(t);
        if lv {
            self.hi_since = Some(t);
            match &mut self.burst {
                Some(b) => {
                    b.2 = t;
                    b.4 += 1;
                }
                None => self.burst = Some((t, t, t, t, 1)),
            }
            return;
        }
        let Some(h) = self.hi_since.take() else {
            return;
        };
        if t - h > MAX_HALF_US * US {
            // Steady light (no carrier): a receiver module stays silent
            self.unmodulated += 1;
            if self.burst.take().is_some_and(|b| b.4 > 2) && self.loopback {
                self.push((t + RX_DELAY_US * US, 1, false));
            }
            return;
        }
        if let Some(b) = &mut self.burst {
            b.3 = t;
            if b.4 == 2 && self.loopback {
                // Second carrier pulse confirms the burst: the receiver output follows RX_DELAY after its start
                let ev = (b.0 + RX_DELAY_US * US, 1, true);
                self.push(ev);
            }
        }
    }

    /// A carrier burst from start to end joins the frame when the receiver module would pass it
    fn end_burst(&mut self, start: u64, end: u64, hz: f64) {
        if !(20_000.0..=60_000.0).contains(&hz) {
            return;
        }
        self.car_sum += hz;
        self.car_n += 1;
        if let Some(p) = self.frame.last_mut() {
            p.1 = (start - self.last_end) / US;
        }
        self.frame.push(((end - start) / US, 0));
        self.last_end = end;
    }

    /// LEDC output on the IR LED pin at t: on = a square wave at hz (0 < duty < 1), off = dark or steady
    pub fn feed_carrier(&mut self, t: u64, on: bool, hz: f64) {
        self.eye_poll(t);
        match (self.env, on) {
            (None, true) => {
                self.env = Some((t, hz));
                if self.loopback && (20_000.0..=60_000.0).contains(&hz) {
                    self.push((t + RX_DELAY_US * US, 1, true));
                }
            }
            (Some((start, hz)), false) => {
                self.env = None;
                if !(20_000.0..=60_000.0).contains(&hz) {
                    self.unmodulated += 1;
                    return;
                }
                if self.loopback {
                    self.push((t + RX_DELAY_US * US, 1, false));
                }
                self.end_burst(start, t, hz);
            }
            _ => {}
        }
    }

    /// Close a burst whose carrier stopped GAP ago, and a frame idle for FRAME_END
    fn eye_poll(&mut self, now: u64) -> u64 {
        let mut next = u64::MAX;
        if let Some((start, first, last_rise, last_fall, rises)) = self.burst {
            let close = last_rise.max(last_fall) + GAP_US * US;
            if self.hi_since.is_some() {
                // Wait for the fall (feed decides carrier or steady light)
            } else if now < close {
                next = next.min(close);
            } else {
                self.burst = None;
                if rises >= 2 {
                    if self.loopback {
                        self.push(((last_fall + RX_DELAY_US * US).max(now), 1, false));
                    }
                    let hz = (rises - 1) as f64 * CPU_HZ as f64 / (last_rise - first) as f64;
                    self.end_burst(start, last_fall, hz);
                }
            }
        }
        if !self.frame.is_empty() && self.burst.is_none() && self.env.is_none() {
            let end = self.last_end + FRAME_END_US * US;
            if now >= end {
                let frame = std::mem::take(&mut self.frame);
                let code = IrCode::decode(&frame);
                self.decoded += code.is_some() as u64;
                self.seen.push(IrSeen {
                    t: end,
                    code,
                    bursts: frame.len(),
                    carrier_hz: self.car_sum / self.car_n.max(1) as f64,
                });
                self.car_sum = 0.0;
                self.car_n = 0;
            } else {
                next = next.min(end);
            }
        }
        next
    }

    pub fn poll(&mut self, now: u64, out: &mut Vec<Drive>) -> u64 {
        out.append(&mut self.out);
        let mut next = self.eye_poll(now);
        while let Some(&(t, src, on)) = self.events.front() {
            if t > now {
                next = next.min(t);
                break;
            }
            self.events.pop_front();
            self.on[src as usize] = on;
            let low = self.on[0] || self.on[1];
            if low != self.out_low {
                self.out_low = low;
                if let Some(p) = self.rx_pin {
                    out.push((t, p, !low as i8));
                }
            }
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_bursts_roundtrip() {
        let c = IrCode::parse("0440,3003").unwrap();
        assert_eq!(
            c,
            IrCode::Nec {
                addr: 0x0440,
                cmd: 0x3003
            }
        );
        assert_eq!(IrCode::parse("0x30030440").unwrap(), c);
        assert_eq!(IrCode::parse("repeat").unwrap(), IrCode::Repeat);
        assert!(IrCode::parse("12345,1").is_err());
        let b = c.bursts();
        assert_eq!(b.len(), 34);
        assert_eq!(IrCode::decode(&b), Some(c));
        assert_eq!(
            IrCode::decode(&IrCode::Repeat.bursts()),
            Some(IrCode::Repeat)
        );
    }

    /// LEDC envelope (IRremote SimpleSender): on / off at the NEC mark edges decodes like real carrier toggles
    #[test]
    fn ledc_envelope_decodes_nec() {
        let mut l = IrLink::new(None, Some(4), false, 0);
        let code = IrCode::parse("0000,0036").unwrap();
        let mut t = 1000;
        for (m, s) in code.bursts() {
            l.feed_carrier(t, true, 37_987.0);
            l.feed_carrier(t + 10, true, 37_987.0);
            l.feed_carrier(t + m * US, false, 37_987.0);
            t += (m + s) * US;
        }
        // A 5 kHz tone is not a carrier the receiver module passes
        l.feed_carrier(t + 20_000 * US, true, 5_000.0);
        l.feed_carrier(t + 21_000 * US, false, 5_000.0);
        let mut out = Vec::new();
        let mut now = 0;
        while now < CPU_HZ / 10 {
            let n = l.poll(now, &mut out);
            now = n.max(now + 1);
        }
        assert_eq!(l.seen.len(), 1);
        assert_eq!(l.seen[0].code, Some(code));
        assert_eq!(l.seen[0].bursts, 34);
        assert!((l.seen[0].carrier_hz - 37_987.0).abs() < 1.0);
        assert_eq!((l.decoded, l.unmodulated), (1, 1));
    }

    /// The remote's receiver output: idle high, active low per burst, delayed RX_DELAY
    #[test]
    fn remote_drives_active_low_envelope() {
        let mut l = IrLink::new(Some(19), None, false, 0);
        l.press(1000, IrCode::Repeat);
        let mut out = Vec::new();
        let mut now = 0;
        while now < CPU_HZ / 10 {
            let n = l.poll(now, &mut out);
            now = n.max(now + 1);
        }
        let d = RX_DELAY_US * US;
        assert_eq!(
            out,
            vec![
                (0, 19, 1),
                (1000 + d, 19, 0),
                (1000 + d + 9000 * US, 19, 1),
                (1000 + d + 11250 * US, 19, 0),
                (1000 + d + 11810 * US, 19, 1)
            ]
        );
    }

    /// Eye: 38 kHz bursts decode to the code, a steady (unmodulated) pulse is ignored
    #[test]
    fn eye_decodes_carrier_bursts() {
        let mut l = IrLink::new(None, Some(18), false, 0);
        let code = IrCode::Nec {
            addr: 0x00ff,
            cmd: 0xa25d,
        };
        let (hi, per) = (CPU_HZ / 114_000, CPU_HZ / 38_000);
        let mut t = 100 * US;
        let mut out = Vec::new();
        for (m, s) in code.bursts() {
            let end = t + m * US;
            let mut c = t;
            while c < end {
                l.feed(c, true);
                l.feed(c + hi, false);
                l.eye_poll(c);
                c += per;
            }
            t = end + s * US;
        }
        l.feed(t + 30_000 * US, true);
        l.feed(t + 31_000 * US, false);
        l.poll(t + 60_000 * US, &mut out);
        assert_eq!(l.seen.len(), 1);
        assert_eq!(l.seen[0].code, Some(code));
        assert!((l.seen[0].carrier_hz - 38_000.0).abs() < 100.0);
        assert_eq!(l.unmodulated, 1);
    }
}
