//! Pin / bus event log (logic analyzer, P1-05): bounded ring buffer stamped in CPU cycles, one per SocBus (C3 / S3); CLI `--trace-io` and wasm `tb_io_take`
//! read the same sequence (format and cap: DECISIONS, event buffer entry). GPIO: only watched pins (bit-banged pins toggle millions of times per second).
//! LEDC: one entry per PWM change, no waveform. RMT: one per WS2812 frame (LED count + first colour), not 800kHz bits. I2C: transaction level from
//! the master model, timed by SCL bits. All fields are integers (mHz, duty/65535) so Rust and TS text match exactly. (lint: allow-long-comment)

use std::collections::VecDeque;

/// Default cap: 65536 entries x 16 bytes = 1MB. The web worker drains it every batch (<= 20ms), so it normally never fills
pub const DEFAULT_CAP: usize = 1 << 16;

pub mod kind {
    pub const GPIO: u8 = 1;
    pub const PWM: u8 = 2;
    pub const WS2812: u8 = 3;
    pub const I2C_START: u8 = 10;
    pub const I2C_ADDR: u8 = 11;
    pub const I2C_DATA: u8 = 12;
    pub const I2C_STOP: u8 = 13;
}

/// Bits of an I2C event's b field
pub mod i2cbit {
    /// R/W bit of an address byte; direction of a data byte (1 = slave sends, master reads)
    pub const READ: u16 = 1;
    /// The 9th bit after this byte is NACK (address / write: slave didn't ACK; read: master wants no more)
    pub const NACK: u16 = 2;
    /// START event: repeated start
    pub const RESTART: u16 = 4;
    /// Which I2C controller (S3 has I2C1)
    pub const PORT1: u16 = 1 << 15;
}

/// One event, 16 bytes LE: t u64 | kind u8 | a u8 | b u16 | v u32  (lint: allow-long-comment)
/// - GPIO: a = pin, b = level
/// - PWM: a = pin, b = duty x 65535 (rounded), v = frequency (mHz, 0 = PWM stopped)
/// - WS2812: a = pin, b = LED count, v = first 0xRRGGBB
/// - I2C_START: b = RESTART / PORT1 bits, v = CPU cycles per SCL bit (frontend draws SDA/SCL from it)
/// - I2C_ADDR: a = 7-bit address, b = READ / NACK / PORT1
/// - I2C_DATA: a = byte, b = READ (direction) / NACK / PORT1
/// - I2C_STOP: b = PORT1
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct IoEvent {
    pub t: u64,
    pub kind: u8,
    pub a: u8,
    pub b: u16,
    pub v: u32,
}

impl IoEvent {
    pub const BYTES: usize = 16;

    pub fn to_bytes(&self) -> [u8; 16] {
        let mut o = [0u8; 16];
        o[..8].copy_from_slice(&self.t.to_le_bytes());
        o[8] = self.kind;
        o[9] = self.a;
        o[10..12].copy_from_slice(&self.b.to_le_bytes());
        o[12..16].copy_from_slice(&self.v.to_le_bytes());
        o
    }

    /// One text line (identical to the CLI `--trace-io` file and `eventLine` in web `web/src/app/iotrace.ts`)
    pub fn line(&self) -> String {
        use i2cbit::*;
        let port = if self.b & PORT1 != 0 { "I2C1" } else { "I2C0" };
        let dir = |b: u16| if b & READ != 0 { "R" } else { "W" };
        let ack = |b: u16| if b & NACK != 0 { "NACK" } else { "ACK" };
        match self.kind {
            kind::GPIO => format!("{} GPIO {} {}", self.t, self.a, self.b),
            kind::PWM => format!("{} PWM {} {} {}", self.t, self.a, self.b, self.v),
            kind::WS2812 => format!("{} WS2812 {} {} {:06x}", self.t, self.a, self.b, self.v),
            kind::I2C_START => format!(
                "{} {port} {} {}",
                self.t,
                if self.b & RESTART != 0 {
                    "RESTART"
                } else {
                    "START"
                },
                self.v
            ),
            kind::I2C_ADDR => format!(
                "{} {port} ADDR {:02x} {} {}",
                self.t,
                self.a,
                dir(self.b),
                ack(self.b)
            ),
            kind::I2C_DATA => format!(
                "{} {port} DATA {:02x} {} {}",
                self.t,
                self.a,
                dir(self.b),
                ack(self.b)
            ),
            kind::I2C_STOP => format!("{} {port} STOP", self.t),
            k => format!("{} ? {k} {} {} {}", self.t, self.a, self.b, self.v),
        }
    }
}

pub struct IoTrace {
    pub buf: VecDeque<IoEvent>,
    pub cap: usize,
    /// Entries pushed out when full (oldest first)
    pub dropped: u64,
    /// Watched GPIOs (bit = pin); PWM / WS2812 / I2C aren't limited by it (they change rarely anyway)
    pub watch: u64,
    gpio_last: u64,
    /// Last recorded PWM per pin (duty u16, frequency mHz); frequency 0 = no PWM
    pwm_last: [(u16, u32); 64],
    /// GPIO matrix / enables changed: rescan every pin's PWM on next update
    pub pwm_dirty: bool,
    /// LEDC revision at the last scan
    pub ledc_rev: u64,
    /// Fine capture for VCD (D-04), independent of `watch` and `cap`
    pub vcd: Option<crate::vcd::VcdCapture>,
}

impl IoTrace {
    /// reset_level: pin levels at power-up (same starting point as SocBus's gpio_log)
    pub fn new(reset_level: u64) -> Self {
        IoTrace {
            buf: VecDeque::new(),
            cap: DEFAULT_CAP,
            dropped: 0,
            watch: 0,
            gpio_last: reset_level,
            pwm_last: [(0, 0); 64],
            pwm_dirty: true,
            ledc_rev: u64::MAX,
            vcd: None,
        }
    }

    #[inline]
    pub fn push(&mut self, e: IoEvent) {
        if self.cap == 0 {
            return;
        }
        if self.buf.len() >= self.cap {
            self.buf.pop_front();
            self.dropped += 1;
        }
        self.buf.push_back(e);
    }

    pub fn extend(&mut self, v: &mut Vec<IoEvent>) {
        for e in v.drain(..) {
            self.push(e);
        }
    }

    /// Pin levels (all pins) may have changed: log only watched pins that actually changed
    #[inline]
    pub fn gpio(&mut self, now: u64, level: u64) {
        if let Some(v) = self.vcd.as_mut() {
            v.on_gpio(now, self.gpio_last, level);
        }
        let diff = (level ^ self.gpio_last) & self.watch;
        self.gpio_last = level;
        if diff == 0 {
            return;
        }
        let mut d = diff;
        while d != 0 {
            let pin = d.trailing_zeros();
            d &= d - 1;
            self.push(IoEvent {
                t: now,
                kind: kind::GPIO,
                a: pin as u8,
                b: (level >> pin & 1) as u16,
                v: 0,
            });
        }
    }

    /// Whether to rescan PWM: LEDC changed (rev differs) or GPIO matrix / enables changed
    #[inline]
    pub fn pwm_scan_needed(&self, ledc_rev: u64) -> bool {
        self.pwm_dirty || ledc_rev != self.ledc_rev
    }

    /// A pin's PWM right now (None = none); log an entry if it differs from the last one
    pub fn pwm(&mut self, now: u64, pin: usize, p: Option<(f32, f32)>) {
        let cur = match p {
            Some((d, f)) if f > 0.0 => (
                ((d as f64).clamp(0.0, 1.0) * 65535.0).round() as u16,
                ((f as f64) * 1000.0).round().min(u32::MAX as f64) as u32,
            ),
            _ => (0, 0),
        };
        if pin >= 64 || self.pwm_last[pin] == cur {
            return;
        }
        self.pwm_last[pin] = cur;
        self.push(IoEvent {
            t: now,
            kind: kind::PWM,
            a: pin as u8,
            b: cur.0,
            v: cur.1,
        });
    }

    pub fn ws2812(&mut self, now: u64, pin: u32, rgb: &[[u8; 3]]) {
        let first = rgb
            .first()
            .map(|c| (c[0] as u32) << 16 | (c[1] as u32) << 8 | c[2] as u32)
            .unwrap_or(0);
        self.push(IoEvent {
            t: now,
            kind: kind::WS2812,
            a: pin as u8,
            b: rgb.len().min(u16::MAX as usize) as u16,
            v: first,
        });
    }

    /// Current levels of all pins as last seen
    pub fn gpio_level(&self) -> u64 {
        self.gpio_last
    }

    /// Take all buffered events (in recording order)
    pub fn take(&mut self) -> Vec<IoEvent> {
        self.buf.drain(..).collect()
    }

    /// Move to the new bus after a software reset: buffer, watch settings and recorded PWM state carry over (simulated time continues)
    pub fn carry(&mut self) -> IoTrace {
        let mut t = IoTrace::new(self.gpio_last);
        std::mem::swap(&mut t.buf, &mut self.buf);
        t.cap = self.cap;
        t.dropped = self.dropped;
        t.watch = self.watch;
        t.pwm_last = self.pwm_last;
        t.vcd = self.vcd.take();
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_cap_and_gpio_watch() {
        let mut t = IoTrace::new(0);
        t.cap = 3;
        t.watch = 1 << 4;
        t.gpio(10, 1 << 4 | 1 << 5); // only GPIO4 is logged
        t.gpio(20, 1 << 5);
        t.gpio(30, 1 << 4);
        t.gpio(40, 0);
        assert_eq!(t.buf.len(), 3);
        assert_eq!(t.dropped, 1);
        let v = t.take();
        assert_eq!(
            v.iter().map(|e| (e.t, e.a, e.b)).collect::<Vec<_>>(),
            vec![(20, 4, 0), (30, 4, 1), (40, 4, 0)]
        );
    }

    #[test]
    fn pwm_dedup_and_lines() {
        let mut t = IoTrace::new(0);
        t.pwm(1, 4, Some((0.08375, 50.0)));
        t.pwm(2, 4, Some((0.08375, 50.0)));
        t.pwm(3, 4, None);
        let v = t.take();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].line(), "1 PWM 4 5489 50000");
        assert_eq!(v[1].line(), "3 PWM 4 0 0");
        let e = IoEvent {
            t: 5,
            kind: kind::I2C_ADDR,
            a: 0x76,
            b: i2cbit::READ,
            v: 0,
        };
        assert_eq!(e.line(), "5 I2C0 ADDR 76 R ACK");
        let b = e.to_bytes();
        assert_eq!(b[8], kind::I2C_ADDR);
        assert_eq!(b[9], 0x76);
    }
}
