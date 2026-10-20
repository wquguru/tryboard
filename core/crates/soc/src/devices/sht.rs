//! Sensirion SHT3x (SHT30, 16-bit commands) and SHT4x (SHT40, 8-bit commands) humidity / temperature sensors (I2C).
//! Behaviour per the SHT3x-DIS and SHT4x datasheets: every word is followed by a CRC-8, a read before the result is ready is NACKed.

use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;
use std::collections::BTreeMap;

/// Sensirion CRC-8: polynomial 0x31, init 0xFF, no reflection, no final XOR
pub fn crc8(data: &[u8]) -> u8 {
    let mut c = 0xffu8;
    for &b in data {
        c ^= b;
        for _ in 0..8 {
            c = if c & 0x80 != 0 {
                (c << 1) ^ 0x31
            } else {
                c << 1
            };
        }
    }
    c
}

/// Words with their CRC bytes, as both chips send them
fn frame(words: &[u16]) -> Vec<u8> {
    let mut v = Vec::with_capacity(words.len() * 3);
    for w in words {
        let b = w.to_be_bytes();
        v.extend_from_slice(&b);
        v.push(crc8(&b));
    }
    v
}

fn ms(ms: f64) -> u64 {
    (ms * CPU_HZ as f64 / 1000.0) as u64
}

/// Ticks for T = -45 + 175 * S / 65535 (both families)
pub fn temp_ticks(t: f64) -> u16 {
    ((t + 45.0) * 65535.0 / 175.0).round().clamp(0.0, 65535.0) as u16
}

/// Serial number both models report (two 16-bit words)
const SERIAL: u32 = 0x1d2c_3b4a;

/// Pending read: the bytes and when they become readable
struct Out {
    data: Vec<u8>,
    ready: u64,
    /// Command used clock stretching: a hardware master waits, so an early read still gets the data
    stretch: bool,
}

pub struct Sht3x {
    pub addr: u8,
    pub temp_c: f64,
    pub humidity: f64,
    now: u64,
    cmd: Vec<u8>,
    out: Option<Out>,
    pos: usize,
    reading: bool,
    /// Periodic mode: (period cycles, next measurement end)
    periodic: Option<(u64, u64)>,
    /// Latest periodic result, cleared by the fetch that reads it
    latest: Option<Vec<u8>>,
    status: u16,
    pub measurements: u64,
    pub unimpl: BTreeMap<u16, u64>,
}

impl Sht3x {
    pub fn new(addr: u8) -> Self {
        Sht3x {
            addr,
            temp_c: 23.5,
            humidity: 45.0,
            now: 0,
            cmd: Vec::new(),
            out: None,
            pos: 0,
            reading: false,
            periodic: None,
            latest: None,
            // Alert pending + system reset detected, as after power-up
            status: 0x8010,
            measurements: 0,
            unimpl: BTreeMap::new(),
        }
    }

    fn sample(&mut self) -> Vec<u8> {
        self.measurements += 1;
        let rh = (self.humidity.clamp(0.0, 100.0) * 65535.0 / 100.0).round() as u16;
        frame(&[temp_ticks(self.temp_c), rh])
    }

    /// Typical measurement duration by repeatability (datasheet table 4, max values)
    fn t_meas(lsb: u8) -> u64 {
        ms(match lsb {
            0x06 | 0x00 | 0x32 | 0x30 | 0x36 | 0x34 | 0x37 => 15.5,
            0x0d | 0x0b | 0x24 | 0x26 | 0x20 | 0x22 | 0x21 => 6.5,
            _ => 4.5,
        })
    }

    fn reply(&mut self, data: Vec<u8>, delay: u64, stretch: bool) {
        self.out = Some(Out {
            data,
            ready: self.now + delay,
            stretch,
        });
    }

    fn command(&mut self, c: u16) {
        let (msb, lsb) = ((c >> 8) as u8, c as u8);
        // While measuring periodically only fetch / break / reset / heater / status are accepted
        let periodic_ok = matches!(
            c,
            0xe000 | 0x3093 | 0x30a2 | 0x306d | 0x3066 | 0xf32d | 0x3041
        );
        if self.periodic.is_some() && !periodic_ok {
            *self.unimpl.entry(c).or_default() += 1;
            return;
        }
        match c {
            0x2c06 | 0x2c0d | 0x2c10 | 0x2400 | 0x240b | 0x2416 => {
                let d = self.sample();
                self.reply(d, Self::t_meas(lsb), msb == 0x2c);
            }
            0x2032 | 0x2024 | 0x202f | 0x2130 | 0x2126 | 0x212d | 0x2236 | 0x2220 | 0x222b
            | 0x2334 | 0x2322 | 0x2329 | 0x2737 | 0x2721 | 0x272a | 0x2b32 => {
                let mps = match msb {
                    0x20 => 0.5,
                    0x21 => 1.0,
                    0x22 => 2.0,
                    0x23 | 0x2b => 4.0, // 0x2b32 = ART, 4 Hz
                    _ => 10.0,
                };
                self.periodic = Some((ms(1000.0 / mps), self.now + Self::t_meas(lsb)));
                self.latest = None;
            }
            0xe000 => {
                if let Some(d) = self.latest.take() {
                    self.reply(d, 0, false);
                }
            }
            0x3093 => self.periodic = None,
            0x30a2 => {
                *self = Sht3x {
                    temp_c: self.temp_c,
                    humidity: self.humidity,
                    now: self.now,
                    measurements: self.measurements,
                    unimpl: std::mem::take(&mut self.unimpl),
                    ..Sht3x::new(self.addr)
                };
            }
            0x306d => self.status |= 1 << 13,
            0x3066 => self.status &= !(1 << 13),
            0xf32d => {
                let d = frame(&[self.status]);
                self.reply(d, 0, false);
            }
            0x3041 => self.status &= !(0x8000 | 0x0010 | 0x0c00),
            0x3780 | 0x3682 => {
                let d = frame(&[(SERIAL >> 16) as u16, SERIAL as u16]);
                self.reply(d, ms(0.5), c == 0x3780);
            }
            _ => *self.unimpl.entry(c).or_default() += 1,
        }
    }

    fn advance(&mut self) {
        while let Some((period, next)) = self.periodic {
            if self.now < next {
                break;
            }
            self.latest = Some(self.sample());
            self.periodic = Some((period, next + period));
        }
    }
}

impl I2cDevice for Sht3x {
    fn address(&self) -> u8 {
        self.addr
    }
    fn set_time(&mut self, now: u64) {
        self.now = now;
        self.advance();
    }
    fn start(&mut self, read: bool) -> bool {
        self.reading = read;
        self.cmd.clear();
        if !read {
            return true;
        }
        match &self.out {
            Some(o) => o.stretch || self.now >= o.ready,
            None => false,
        }
    }
    fn write(&mut self, b: u8) -> bool {
        self.cmd.push(b);
        if self.cmd.len() == 2 {
            self.command(u16::from_be_bytes([self.cmd[0], self.cmd[1]]));
        }
        // Alert-limit writes carry data + CRC after the command: accept and ignore
        true
    }
    fn read(&mut self) -> u8 {
        let v = self
            .out
            .as_ref()
            .and_then(|o| o.data.get(self.pos).copied())
            .unwrap_or(0xff);
        self.pos += 1;
        v
    }
    fn stop(&mut self) {
        if self.reading && self.pos > 0 {
            self.out = None;
        }
        self.pos = 0;
        self.reading = false;
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

pub struct Sht4x {
    pub addr: u8,
    pub temp_c: f64,
    pub humidity: f64,
    now: u64,
    first: bool,
    out: Option<Out>,
    pos: usize,
    reading: bool,
    pub measurements: u64,
    pub unimpl: BTreeMap<u16, u64>,
}

impl Sht4x {
    pub fn new(addr: u8) -> Self {
        Sht4x {
            addr,
            temp_c: 23.5,
            humidity: 45.0,
            now: 0,
            first: false,
            out: None,
            pos: 0,
            reading: false,
            measurements: 0,
            unimpl: BTreeMap::new(),
        }
    }

    fn command(&mut self, c: u8) {
        // Max durations, datasheet table 4; heater pulses measure at their end (self-heating not modelled)
        let t = match c {
            0xfd => 8.3,
            0xf6 => 4.5,
            0xe0 => 1.7,
            0x39 | 0x2f | 0x1e => 1100.0,
            0x32 | 0x24 | 0x15 => 110.0,
            0x89 => {
                let d = frame(&[(SERIAL >> 16) as u16, SERIAL as u16]);
                self.reply(d, ms(1.0));
                return;
            }
            0x94 => {
                self.out = None;
                return;
            }
            _ => {
                *self.unimpl.entry(c as u16).or_default() += 1;
                return;
            }
        };
        self.measurements += 1;
        // RH = -6 + 125 * S / 65535; the sensor reports beyond 0..100 %, the host clips
        let rh = ((self.humidity.clamp(0.0, 100.0) + 6.0) * 65535.0 / 125.0).round() as u16;
        let d = frame(&[temp_ticks(self.temp_c), rh]);
        self.reply(d, ms(t));
    }

    fn reply(&mut self, data: Vec<u8>, delay: u64) {
        self.out = Some(Out {
            data,
            ready: self.now + delay,
            stretch: false,
        });
    }
}

impl I2cDevice for Sht4x {
    fn address(&self) -> u8 {
        self.addr
    }
    fn set_time(&mut self, now: u64) {
        self.now = now;
    }
    fn start(&mut self, read: bool) -> bool {
        self.reading = read;
        self.first = !read;
        if !read {
            return true;
        }
        // No clock stretching on SHT4x: the header is NACKed until the result is ready
        self.out.as_ref().is_some_and(|o| self.now >= o.ready)
    }
    fn write(&mut self, b: u8) -> bool {
        // Only the first byte is a command (some drivers send a trailing dummy byte)
        if self.first {
            self.first = false;
            self.command(b);
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self
            .out
            .as_ref()
            .and_then(|o| o.data.get(self.pos).copied())
            .unwrap_or(0xff);
        self.pos += 1;
        v
    }
    fn stop(&mut self) {
        if self.reading && self.pos > 0 {
            self.out = None;
        }
        self.pos = 0;
        self.reading = false;
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_n(d: &mut dyn I2cDevice, n: usize) -> Option<Vec<u8>> {
        if !d.start(true) {
            d.stop();
            return None;
        }
        let v = (0..n).map(|_| d.read()).collect();
        d.stop();
        Some(v)
    }

    fn cmd(d: &mut dyn I2cDevice, bytes: &[u8]) {
        assert!(d.start(false));
        for &b in bytes {
            d.write(b);
        }
        d.stop();
    }

    fn decode(v: &[u8]) -> (u16, u16) {
        assert_eq!(v[2], crc8(&v[0..2]), "crc word 0");
        assert_eq!(v[5], crc8(&v[3..5]), "crc word 1");
        (
            u16::from_be_bytes([v[0], v[1]]),
            u16::from_be_bytes([v[3], v[4]]),
        )
    }

    #[test]
    fn crc_vector() {
        // Datasheet example: 0xBEEF -> 0x92
        assert_eq!(crc8(&[0xbe, 0xef]), 0x92);
    }

    #[test]
    fn sht30_single_shot_roundtrip() {
        for (t, h) in [(23.5, 45.0), (-10.3, 90.2), (41.7, 3.4)] {
            let mut d = Sht3x::new(0x44);
            d.temp_c = t;
            d.humidity = h;
            d.set_time(1000);
            // Clock-stretching command: data comes back on the next read
            cmd(&mut d, &[0x2c, 0x06]);
            let (st, sh) = decode(&read_n(&mut d, 6).unwrap());
            assert!((-45.0 + 175.0 * st as f64 / 65535.0 - t).abs() < 0.01);
            assert!((100.0 * sh as f64 / 65535.0 - h).abs() < 0.01);
            // No stretching: NACK until 15 ms have passed
            cmd(&mut d, &[0x24, 0x00]);
            assert!(read_n(&mut d, 6).is_none());
            d.set_time(1000 + ms(16.0));
            assert!(read_n(&mut d, 6).is_some());
            assert!(read_n(&mut d, 6).is_none(), "result read once");
        }
    }

    #[test]
    fn sht30_periodic_fetch_and_reset() {
        let mut d = Sht3x::new(0x44);
        cmd(&mut d, &[0x21, 0x30]); // 1 mps high
        cmd(&mut d, &[0xe0, 0x00]);
        assert!(
            read_n(&mut d, 6).is_none(),
            "no data before the first period"
        );
        d.set_time(ms(20.0));
        cmd(&mut d, &[0xe0, 0x00]);
        assert!(read_n(&mut d, 6).is_some());
        cmd(&mut d, &[0xe0, 0x00]);
        assert!(read_n(&mut d, 6).is_none(), "fetch clears the buffer");
        d.temp_c = 30.0;
        d.set_time(ms(1020.0));
        cmd(&mut d, &[0xe0, 0x00]);
        let (st, _) = decode(&read_n(&mut d, 6).unwrap());
        assert_eq!(st, temp_ticks(30.0));
        cmd(&mut d, &[0x30, 0x93]); // break
        d.set_time(ms(5000.0));
        cmd(&mut d, &[0xe0, 0x00]);
        assert!(read_n(&mut d, 6).is_none());
        // Status, clear, serial, soft reset
        cmd(&mut d, &[0xf3, 0x2d]);
        let s = read_n(&mut d, 3).unwrap();
        assert_eq!((s[0], s[1], s[2]), (0x80, 0x10, crc8(&[0x80, 0x10])));
        cmd(&mut d, &[0x30, 0x41]);
        cmd(&mut d, &[0xf3, 0x2d]);
        assert_eq!(read_n(&mut d, 2).unwrap(), vec![0, 0]);
        cmd(&mut d, &[0x37, 0x80]);
        let (a, b) = decode(&read_n(&mut d, 6).unwrap());
        assert_eq!(((a as u32) << 16) | b as u32, SERIAL);
        cmd(&mut d, &[0x30, 0xa2]);
        cmd(&mut d, &[0xf3, 0x2d]);
        assert_eq!(read_n(&mut d, 2).unwrap(), vec![0x80, 0x10]);
        assert!(d.unimpl.is_empty());
        cmd(&mut d, &[0x12, 0x34]);
        assert_eq!(d.unimpl.get(&0x1234), Some(&1));
    }

    #[test]
    fn sht40_roundtrip() {
        for (t, h) in [(23.5, 45.0), (-10.3, 90.2), (41.7, 3.4)] {
            let mut d = Sht4x::new(0x44);
            d.temp_c = t;
            d.humidity = h;
            cmd(&mut d, &[0xfd, 0x01]);
            assert!(read_n(&mut d, 6).is_none(), "busy");
            d.set_time(ms(9.0));
            let (st, sh) = decode(&read_n(&mut d, 6).unwrap());
            assert!((-45.0 + 175.0 * st as f64 / 65535.0 - t).abs() < 0.01);
            assert!((-6.0 + 125.0 * sh as f64 / 65535.0 - h).abs() < 0.01);
        }
        let mut d = Sht4x::new(0x44);
        cmd(&mut d, &[0x89]);
        d.set_time(ms(2.0));
        let (a, b) = decode(&read_n(&mut d, 6).unwrap());
        assert_eq!(((a as u32) << 16) | b as u32, SERIAL);
        cmd(&mut d, &[0x94]);
        assert!(read_n(&mut d, 6).is_none());
        assert!(d.unimpl.is_empty());
    }
}
