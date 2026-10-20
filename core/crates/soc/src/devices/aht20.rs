//! Aosong AHT20 humidity / temperature sensor (I2C 0x38), per the AHT20 datasheet: no register pointer, 3-byte commands
//! 0xBE 0x08 0x00 (init / calibrate; AHT10's 0xE1 also accepted), 0xAC 0x33 0x00 (trigger, ~80 ms), 0xBA (soft reset), 0x71
//! (status). A read returns status (bit7 busy, bit3 CAL, bit4 set like real parts: idle 0x18), 20-bit humidity, 20-bit
//! temperature, CRC-8 (poly 0x31, init 0xFF over the 6 bytes). RH = S / 2^20 * 100 %, T = S / 2^20 * 200 - 50 C. Reads while
//! busy return the busy status and the previous result. Other commands count in `unimpl`. (lint: allow-long-comment)

use super::sht::crc8;
use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;
use std::collections::BTreeMap;

/// Measurement time (datasheet: wait > 75 ms after the trigger)
const T_MEAS: u64 = CPU_HZ / 1000 * 80;
/// Status bits
const BUSY: u8 = 0x80;
const CAL: u8 = 0x08;

pub struct Aht20 {
    pub addr: u8,
    pub temp_c: f64,
    pub humidity: f64,
    now: u64,
    cmd: Vec<u8>,
    pos: usize,
    /// Status without the busy bit (CAL and the always-set bit4)
    status: u8,
    /// Last finished result: humidity and temperature ticks (20 bits each)
    raw: (u32, u32),
    /// Pending measurement: cycle it finishes and the ticks it latched
    busy_until: Option<(u64, (u32, u32))>,
    pub measurements: u64,
    pub unimpl: BTreeMap<u8, u64>,
}

/// 20-bit humidity ticks for RH %
pub fn hum_ticks(rh: f64) -> u32 {
    (rh.clamp(0.0, 100.0) / 100.0 * 1_048_576.0)
        .round()
        .min(1_048_575.0) as u32
}

/// 20-bit temperature ticks for T (C), range -50..150
pub fn temp_ticks(t: f64) -> u32 {
    ((t + 50.0) / 200.0 * 1_048_576.0)
        .round()
        .clamp(0.0, 1_048_575.0) as u32
}

impl Aht20 {
    pub fn new(addr: u8) -> Self {
        Aht20 {
            addr,
            temp_c: 23.5,
            humidity: 45.0,
            now: 0,
            cmd: Vec::new(),
            pos: 0,
            // Calibrated at the factory: CAL is set out of power-on
            status: 0x10 | CAL,
            raw: (0, 0),
            busy_until: None,
            measurements: 0,
            unimpl: BTreeMap::new(),
        }
    }

    fn settle(&mut self) {
        if let Some((t, r)) = self.busy_until {
            if self.now >= t {
                self.raw = r;
                self.busy_until = None;
            }
        }
    }

    fn status_byte(&self) -> u8 {
        self.status | if self.busy_until.is_some() { BUSY } else { 0 }
    }

    fn frame(&self) -> [u8; 7] {
        let (h, t) = self.raw;
        let mut f = [
            self.status_byte(),
            (h >> 12) as u8,
            (h >> 4) as u8,
            ((h & 0xf) << 4) as u8 | (t >> 16) as u8,
            (t >> 8) as u8,
            t as u8,
            0,
        ];
        f[6] = crc8(&f[..6]);
        f
    }

    fn command(&mut self) {
        match self.cmd.as_slice() {
            [0xac, 0x33, 0x00] => {
                let r = (hum_ticks(self.humidity), temp_ticks(self.temp_c));
                self.busy_until = Some((self.now + T_MEAS, r));
                self.measurements += 1;
            }
            [0xbe | 0xe1, 0x08, 0x00] => self.status |= CAL,
            [0xba] => {
                self.busy_until = None;
                self.raw = (0, 0);
            }
            [0x71] => {}
            // Partial commands wait for their remaining bytes
            [0xac] | [0xac, 0x33] | [0xbe | 0xe1] | [0xbe | 0xe1, 0x08] => return,
            c => *self.unimpl.entry(c[0]).or_default() += 1,
        }
        self.cmd.clear();
    }
}

impl I2cDevice for Aht20 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn set_time(&mut self, now: u64) {
        self.now = now;
        self.settle();
    }
    fn start(&mut self, read: bool) -> bool {
        self.cmd.clear();
        self.pos = 0;
        if read {
            self.settle();
        }
        true
    }
    fn write(&mut self, b: u8) -> bool {
        self.cmd.push(b);
        self.command();
        true
    }
    fn read(&mut self) -> u8 {
        let f = self.frame();
        // Reading past the CRC keeps clocking out 0xFF (bus released)
        let v = f.get(self.pos).copied().unwrap_or(0xff);
        self.pos += 1;
        v
    }
    fn stop(&mut self) {
        // An unfinished command at STOP is dropped, as the chip ignores it
        if !self.cmd.is_empty() {
            *self.unimpl.entry(self.cmd[0]).or_default() += 1;
            self.cmd.clear();
        }
        self.pos = 0;
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wr(d: &mut Aht20, bytes: &[u8]) {
        d.start(false);
        for &b in bytes {
            d.write(b);
        }
        d.stop();
    }

    fn rd(d: &mut Aht20, n: usize) -> Vec<u8> {
        d.start(true);
        let v = (0..n).map(|_| d.read()).collect();
        d.stop();
        v
    }

    #[test]
    fn measure_busy_then_result_with_crc() {
        let mut d = Aht20::new(0x38);
        d.set_time(1000);
        assert_eq!(rd(&mut d, 1), vec![0x18]);
        wr(&mut d, &[0xbe, 0x08, 0x00]);
        d.temp_c = 21.5;
        d.humidity = 55.0;
        wr(&mut d, &[0xac, 0x33, 0x00]);
        assert_eq!(rd(&mut d, 1)[0] & BUSY, BUSY);
        d.set_time(1000 + T_MEAS);
        let f = rd(&mut d, 7);
        assert_eq!(f[0], 0x18);
        assert_eq!(crc8(&f[..6]), f[6]);
        let h = (f[1] as u32) << 12 | (f[2] as u32) << 4 | (f[3] as u32) >> 4;
        let t = ((f[3] & 0xf) as u32) << 16 | (f[4] as u32) << 8 | f[5] as u32;
        let rh = h as f64 / 1_048_576.0 * 100.0;
        let tc = t as f64 / 1_048_576.0 * 200.0 - 50.0;
        assert!((rh - 55.0).abs() < 0.001, "{rh}");
        assert!((tc - 21.5).abs() < 0.001, "{tc}");
        assert_eq!(d.measurements, 1);
        assert!(d.unimpl.is_empty());
    }

    #[test]
    fn reset_and_unknown_commands() {
        let mut d = Aht20::new(0x38);
        wr(&mut d, &[0xac, 0x33, 0x00]);
        wr(&mut d, &[0xba]);
        assert_eq!(rd(&mut d, 1), vec![0x18]);
        wr(&mut d, &[0x42]);
        wr(&mut d, &[0xac]);
        assert_eq!(d.unimpl.get(&0x42), Some(&1));
        assert_eq!(d.unimpl.get(&0xac), Some(&1));
        assert_eq!(temp_ticks(-60.0), 0);
        assert_eq!(hum_ticks(100.0), 1_048_575);
    }
}
