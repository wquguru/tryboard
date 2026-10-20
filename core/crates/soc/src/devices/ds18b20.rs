//! DS18B20 1-Wire thermometer (F-04c). Written from the Maxim datasheet and the 1-Wire app notes (AN126 timing, AN187 search),
//! no library code. A `OneWireBus` owns one GPIO and any number of devices: the host drives every slot, so the bus reacts
//! to host edges (reset by low width, write bit by low width, read slot by holding the line low) and emits one wired-AND
//! drive stream; each device only keeps protocol state. Released = drive 1 (stands in for the 4.7 kΩ pull-up). (lint: allow-long-comment)

use std::collections::VecDeque;

use super::pins::Drive;
use crate::periph::CPU_HZ;

const US: u64 = CPU_HZ / 1_000_000;
/// Host low at least this long is a reset (datasheet 480 µs min; 10 % slack for busy-wait drift)
pub const RESET_MIN_US: u64 = 430;
/// Presence pulse: device waits 15-60 µs after the host releases, then holds low 60-240 µs
pub const PRESENCE_WAIT_US: u64 = 30;
pub const PRESENCE_LOW_US: u64 = 120;
/// Write slot: the device samples about 30 µs after the falling edge (window 15-60 µs), so a shorter low is a 1
pub const WRITE1_MAX_US: u64 = 30;
/// Read slot with a 0: the device holds the line this long from the host's falling edge (host samples within 15 µs)
pub const READ0_HOLD_US: u64 = 30;
/// Power-on temperature register (+85 °C), what a read before the first conversion returns
pub const POWER_ON_RAW: i16 = 0x0550;
/// 12-bit conversion time; each bit less halves it (93.75 ms at 9 bits)
pub const CONV_12BIT_MS: f64 = 750.0;

/// CRC-8/MAXIM (poly x^8 + x^5 + x^4 + 1, reflected 0x8C), as used for the ROM code and scratchpad
pub fn crc8(data: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &b in data {
        let mut b = b;
        for _ in 0..8 {
            let mix = (crc ^ b) & 1;
            crc >>= 1;
            if mix != 0 {
                crc ^= 0x8C;
            }
            b >>= 1;
        }
    }
    crc
}

/// Raw temperature register for a reading at a resolution of 9-12 bits (undefined low bits read as 0)
pub fn raw_temp(temp_c: f64, bits: u32) -> i16 {
    let raw = (temp_c.clamp(-55.0, 125.0) * 16.0).round() as i16;
    raw & !((1i16 << (12 - bits.clamp(9, 12))) - 1)
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    /// Deselected or not addressed yet: waits for the next reset
    Idle,
    RomCmd,
    MatchRom,
    /// SEARCH ROM bit i: phase 0 sends the bit, 1 its complement, 2 reads the host's direction
    Search(u32, u8),
    FnCmd,
    /// Sends `tx` LSB first, then 1s (also READ POWER SUPPLY: externally powered reads 1)
    Tx,
    /// Read slots after CONVERT T: 0 while converting, 1 when done
    Converting,
    /// WRITE SCRATCHPAD: TH, TL, config
    RxScratch,
}

/// One DS18B20 (externally powered). Factory TH / TL / config: 0x4B / 0x46 / 0x7F (12 bits)
#[derive(Clone, Debug)]
pub struct Ds18b20 {
    pub rom: [u8; 8],
    pub temp_c: f64,
    /// Added to the bus temperature (the second device of a CLI bus reads +0.5 °C, so addressing is checkable)
    pub offset_c: f64,
    pub th: u8,
    pub tl: u8,
    pub cfg: u8,
    eeprom: [u8; 3],
    t_reg: i16,
    pending: Option<(u64, i16)>,
    mode: Mode,
    rx: u64,
    rxn: u32,
    tx: Vec<u8>,
    txn: usize,
}

impl Ds18b20 {
    /// Family code 0x28 + 48-bit serial + CRC
    pub fn new(serial: [u8; 6]) -> Ds18b20 {
        let mut rom = [0x28, 0, 0, 0, 0, 0, 0, 0];
        rom[1..7].copy_from_slice(&serial);
        rom[7] = crc8(&rom[..7]);
        Ds18b20 {
            rom,
            temp_c: 25.0,
            offset_c: 0.0,
            th: 0x4B,
            tl: 0x46,
            cfg: 0x7F,
            eeprom: [0x4B, 0x46, 0x7F],
            t_reg: POWER_ON_RAW,
            pending: None,
            mode: Mode::Idle,
            rx: 0,
            rxn: 0,
            tx: Vec::new(),
            txn: 0,
        }
    }

    pub fn bits(&self) -> u32 {
        9 + (self.cfg as u32 >> 5 & 3)
    }

    pub fn conv_cycles(&self) -> u64 {
        let ms = CONV_12BIT_MS / (1 << (12 - self.bits())) as f64;
        (ms * (CPU_HZ / 1000) as f64) as u64
    }

    /// 9-byte scratchpad: temperature LSB / MSB, TH, TL, config, 0xFF, 0x0C, 0x10, CRC
    pub fn scratchpad(&self) -> [u8; 9] {
        let [lo, hi] = self.t_reg.to_le_bytes();
        let mut s = [lo, hi, self.th, self.tl, self.cfg, 0xFF, 0x0C, 0x10, 0];
        s[8] = crc8(&s[..8]);
        s
    }

    fn settle(&mut self, now: u64) {
        if let Some((done, raw)) = self.pending {
            if now >= done {
                self.t_reg = raw;
                self.pending = None;
            }
        }
    }

    /// Alarm flag: integer part of the last reading >= TH or <= TL (signed)
    fn alarm(&self) -> bool {
        let t = (self.t_reg >> 4) as i8;
        t >= self.th as i8 || t <= self.tl as i8
    }

    fn rom_bit(&self, i: u32) -> bool {
        self.rom[i as usize / 8] >> (i % 8) & 1 != 0
    }

    fn reset(&mut self, now: u64) {
        self.settle(now);
        self.mode = Mode::RomCmd;
        self.rx = 0;
        self.rxn = 0;
    }

    fn send(&mut self, data: Vec<u8>) {
        self.tx = data;
        self.txn = 0;
        self.mode = Mode::Tx;
    }

    /// Host falling edge: Some(bit) when this device answers a read slot (and the slot is consumed here)
    fn tx_bit(&mut self, now: u64) -> Option<bool> {
        match self.mode {
            Mode::Tx => {
                let b = self
                    .tx
                    .get(self.txn / 8)
                    .is_none_or(|v| v >> (self.txn % 8) & 1 != 0);
                self.txn += 1;
                Some(b)
            }
            Mode::Converting => Some(now >= self.pending.map_or(0, |p| p.0)),
            Mode::Search(i, ph) if ph < 2 => {
                self.mode = Mode::Search(i, ph + 1);
                Some(self.rom_bit(i) != (ph == 1))
            }
            _ => None,
        }
    }

    /// Host write slot (rising edge of a slot this device did not answer); `stats` counts finished commands
    fn rx_bit(&mut self, b: bool, now: u64, stats: &mut OneWireStats) {
        match self.mode {
            Mode::Search(i, 2) => {
                self.mode = if b != self.rom_bit(i) {
                    Mode::Idle
                } else if i == 63 {
                    Mode::FnCmd
                } else {
                    Mode::Search(i + 1, 0)
                };
                return;
            }
            Mode::RomCmd | Mode::MatchRom | Mode::FnCmd | Mode::RxScratch => {}
            _ => return,
        }
        self.rx |= (b as u64) << self.rxn;
        self.rxn += 1;
        let n = self.rxn;
        match self.mode {
            Mode::MatchRom if n == 64 => {
                self.mode = if self.rx.to_le_bytes() == self.rom {
                    Mode::FnCmd
                } else {
                    Mode::Idle
                };
            }
            // Leave as soon as a bit differs, like the real part
            Mode::MatchRom if b != self.rom_bit(n - 1) => self.mode = Mode::Idle,
            Mode::RxScratch if n == 24 => {
                let [th, tl, cfg, ..] = self.rx.to_le_bytes();
                self.th = th;
                self.tl = tl;
                self.cfg = cfg & 0x60 | 0x1F;
                self.mode = Mode::Idle;
            }
            Mode::RomCmd if n == 8 => self.rom_cmd(self.rx as u8, stats),
            Mode::FnCmd if n == 8 => self.fn_cmd(self.rx as u8, now, stats),
            _ => return,
        }
        self.rx = 0;
        self.rxn = 0;
    }

    fn rom_cmd(&mut self, c: u8, stats: &mut OneWireStats) {
        self.mode = match c {
            0x33 => {
                self.send(self.rom.to_vec());
                return;
            }
            0x55 => Mode::MatchRom,
            0xCC => Mode::FnCmd,
            0xF0 => Mode::Search(0, 0),
            0xEC if self.alarm() => Mode::Search(0, 0),
            0xEC => Mode::Idle,
            _ => {
                stats.unknown_cmds += 1;
                Mode::Idle
            }
        };
    }

    fn fn_cmd(&mut self, c: u8, now: u64, stats: &mut OneWireStats) {
        self.settle(now);
        match c {
            0x44 => {
                let raw = raw_temp(self.temp_c + self.offset_c, self.bits());
                self.pending = Some((now + self.conv_cycles(), raw));
                self.mode = Mode::Converting;
                stats.conversions += 1;
            }
            0xBE => {
                self.send(self.scratchpad().to_vec());
                stats.scratch_reads += 1;
            }
            0x4E => self.mode = Mode::RxScratch,
            0x48 => {
                self.eeprom = [self.th, self.tl, self.cfg];
                self.send(Vec::new());
            }
            0xB8 => {
                [self.th, self.tl, self.cfg] = self.eeprom;
                self.send(Vec::new());
            }
            0xB4 => self.send(Vec::new()),
            _ => {
                stats.unknown_cmds += 1;
                self.mode = Mode::Idle;
            }
        }
    }
}

/// Bus counters for the CLI report line
#[derive(Clone, Debug, Default)]
pub struct OneWireStats {
    pub resets: u64,
    pub conversions: u64,
    pub scratch_reads: u64,
    pub unknown_cmds: u64,
}

/// One 1-Wire data pin with its devices
#[derive(Clone, Debug)]
pub struct OneWireBus {
    pub pin: u32,
    pub devs: Vec<Ds18b20>,
    pub stats: OneWireStats,
    last_hi: bool,
    low_since: Option<u64>,
    /// Devices that answered the current read slot (bit i = devs[i])
    tx_mask: u64,
    holding: bool,
    wave: VecDeque<(u64, i8)>,
    out: Vec<Drive>,
}

impl OneWireBus {
    /// `count` DS18B20s with fixed, distinct serials (search order = ROM order, LSB first)
    pub fn new(pin: u32, count: usize, now: u64) -> OneWireBus {
        let devs = (0..count.clamp(1, 64))
            .map(|i| {
                let i = i as u8;
                let mut d = Ds18b20::new([
                    0x3A ^ i.wrapping_mul(0x41),
                    0x5C,
                    0x1E,
                    0x0B + i,
                    0x00,
                    0x00,
                ]);
                d.offset_c = 0.5 * i as f64;
                d
            })
            .collect();
        Self::with_devices(pin, devs, now)
    }

    pub fn with_devices(pin: u32, devs: Vec<Ds18b20>, now: u64) -> OneWireBus {
        OneWireBus {
            pin,
            devs,
            stats: OneWireStats::default(),
            last_hi: true,
            low_since: None,
            tx_mask: 0,
            holding: false,
            wave: VecDeque::new(),
            out: vec![(now, pin, 1)],
        }
    }

    pub fn set_temp(&mut self, t: f64) {
        for d in &mut self.devs {
            d.temp_c = t;
        }
    }

    /// Pin levels changed (bit = pin number). Edges the bus itself causes are skipped: while it holds the line low
    /// nothing the host does is visible anyway.
    pub fn on_level(&mut self, t: u64, level: u64) {
        let hi = level >> self.pin & 1 != 0;
        if hi == self.last_hi {
            return;
        }
        self.last_hi = hi;
        if self.holding {
            return;
        }
        if !hi {
            if self.low_since.is_some() {
                return;
            }
            self.low_since = Some(t);
            self.tx_mask = 0;
            let mut zero = false;
            for (i, d) in self.devs.iter_mut().enumerate() {
                if let Some(b) = d.tx_bit(t) {
                    self.tx_mask |= 1 << i;
                    zero |= !b;
                }
            }
            if zero {
                self.wave.push_back((t, 0));
                self.wave.push_back((t + READ0_HOLD_US * US, 1));
            }
            return;
        }
        let Some(t0) = self.low_since.take() else {
            return;
        };
        let low = t - t0;
        if low >= RESET_MIN_US * US {
            self.stats.resets += 1;
            for d in &mut self.devs {
                d.reset(t);
            }
            self.wave.clear();
            let at = t + PRESENCE_WAIT_US * US;
            self.wave.push_back((at, 0));
            self.wave.push_back((at + PRESENCE_LOW_US * US, 1));
            return;
        }
        let b = low < WRITE1_MAX_US * US;
        for (i, d) in self.devs.iter_mut().enumerate() {
            if self.tx_mask >> i & 1 == 0 {
                d.rx_bit(b, t, &mut self.stats);
            }
        }
        self.tx_mask = 0;
    }

    pub fn poll(&mut self, now: u64, out: &mut Vec<Drive>) -> u64 {
        out.append(&mut self.out);
        while let Some(&(t, lv)) = self.wave.front() {
            if t > now {
                return t;
            }
            self.holding = lv == 0;
            out.push((t, self.pin, lv));
            self.wave.pop_front();
        }
        u64::MAX
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal host: wired-AND of its own drive and the bus drives, stepping 1 µs at a time like a busy-wait driver
    struct Host {
        bus: OneWireBus,
        t: u64,
        host_low: bool,
        bus_low: bool,
    }

    impl Host {
        fn new(bus: OneWireBus) -> Host {
            Host {
                bus,
                t: 0,
                host_low: false,
                bus_low: false,
            }
        }
        fn level(&self) -> u64 {
            ((!self.host_low && !self.bus_low) as u64) << self.bus.pin
        }
        fn sync(&mut self) {
            let mut out = Vec::new();
            self.bus.poll(self.t, &mut out);
            for (t, _, lv) in out {
                self.bus_low = lv == 0;
                let l = self.level();
                self.bus.on_level(t, l);
            }
        }
        fn wait(&mut self, us: u64) {
            for _ in 0..us {
                self.t += US;
                self.sync();
            }
        }
        fn drive(&mut self, low: bool) {
            self.host_low = low;
            let l = self.level();
            self.bus.on_level(self.t, l);
            self.sync();
        }
        fn reset(&mut self) -> bool {
            self.drive(true);
            self.wait(480);
            self.drive(false);
            self.wait(70);
            let p = self.level() == 0;
            self.wait(410);
            p
        }
        fn write_bit(&mut self, b: bool) {
            self.drive(true);
            self.wait(if b { 6 } else { 60 });
            self.drive(false);
            self.wait(if b { 64 } else { 10 });
        }
        fn read_bit(&mut self) -> bool {
            self.drive(true);
            self.wait(6);
            self.drive(false);
            self.wait(9);
            let b = self.level() != 0;
            self.wait(55);
            b
        }
        fn write(&mut self, v: u8) {
            for k in 0..8 {
                self.write_bit(v >> k & 1 != 0);
            }
        }
        fn read(&mut self) -> u8 {
            (0..8).fold(0, |a, k| a | (self.read_bit() as u8) << k)
        }
        fn scratch(&mut self, rom: Option<[u8; 8]>) -> [u8; 9] {
            assert!(self.reset());
            match rom {
                Some(r) => {
                    self.write(0x55);
                    r.iter().for_each(|&b| self.write(b));
                }
                None => self.write(0xCC),
            }
            self.write(0xBE);
            std::array::from_fn(|_| self.read())
        }
        fn convert(&mut self) -> u64 {
            assert!(self.reset());
            self.write(0xCC);
            self.write(0x44);
            let t0 = self.t;
            while !self.read_bit() {
                self.wait(1000);
            }
            self.t - t0
        }
        /// AN187-style search: returns every ROM code on the bus
        fn search(&mut self) -> Vec<[u8; 8]> {
            let mut found = Vec::new();
            let mut rom = [0u8; 8];
            let mut last = 0i32;
            loop {
                assert!(self.reset());
                self.write(0xF0);
                let mut zero_at = 0i32;
                for i in 0..64i32 {
                    let (b, c) = (self.read_bit(), self.read_bit());
                    assert!(!(b && c), "no device answered bit {i}");
                    let prev = rom[i as usize / 8] >> (i % 8) & 1 != 0;
                    let dir = if b != c {
                        b
                    } else if i + 1 < last {
                        prev
                    } else {
                        i + 1 == last
                    };
                    if b == c && !dir {
                        zero_at = i + 1;
                    }
                    let m = 1 << (i % 8);
                    if dir {
                        rom[i as usize / 8] |= m;
                    } else {
                        rom[i as usize / 8] &= !m;
                    }
                    self.write_bit(dir);
                }
                found.push(rom);
                last = zero_at;
                if last == 0 {
                    return found;
                }
            }
        }
    }

    #[test]
    fn crc8_check_value() {
        assert_eq!(crc8(b"123456789"), 0xA1);
        let d = Ds18b20::new([1, 2, 3, 4, 5, 6]);
        assert_eq!(crc8(&d.rom), 0);
        assert_eq!(crc8(&d.scratchpad()), 0);
        // Datasheet example ROM 0x02 1C B8 01 00 00 00 → CRC 0xA2
        assert_eq!(crc8(&[0x02, 0x1C, 0xB8, 0x01, 0, 0, 0]), 0xA2);
    }

    #[test]
    fn raw_temp_table() {
        // Datasheet table 1
        assert_eq!(raw_temp(125.0, 12), 0x07D0);
        assert_eq!(raw_temp(25.0625, 12), 0x0191);
        assert_eq!(raw_temp(10.125, 12), 0x00A2);
        assert_eq!(raw_temp(0.5, 12), 0x0008);
        assert_eq!(raw_temp(-0.5, 12), -8);
        assert_eq!(raw_temp(-10.125, 12) as u16, 0xFF5E);
        assert_eq!(raw_temp(-25.0625, 12) as u16, 0xFE6F);
        assert_eq!(raw_temp(-55.0, 12) as u16, 0xFC90);
        assert_eq!(raw_temp(23.5625, 9), raw_temp(23.5, 12));
    }

    #[test]
    fn reset_presence_and_absence() {
        let mut h = Host::new(OneWireBus::new(4, 1, 0));
        h.sync();
        assert!(h.reset());
        assert_eq!(h.bus.stats.resets, 1);
        // Too-short "reset" (200 µs) gets no presence pulse
        h.drive(true);
        h.wait(200);
        h.drive(false);
        h.wait(70);
        assert_ne!(h.level(), 0);
    }

    #[test]
    fn skip_convert_read_scratchpad() {
        let mut h = Host::new(OneWireBus::new(4, 1, 0));
        h.sync();
        h.bus.set_temp(-10.125);
        // Before any conversion: power-on +85 °C
        let s = h.scratch(None);
        assert_eq!(i16::from_le_bytes([s[0], s[1]]), POWER_ON_RAW);
        assert_eq!(&s[2..8], &[0x4B, 0x46, 0x7F, 0xFF, 0x0C, 0x10]);
        assert_eq!(crc8(&s), 0);
        let dt = h.convert();
        let ms = dt / (CPU_HZ / 1000);
        assert!((750..=752).contains(&ms), "conversion took {ms} ms");
        let s = h.scratch(None);
        assert_eq!([s[0], s[1]], [0x5E, 0xFF]);
        assert_eq!(h.bus.stats.conversions, 1);
        assert_eq!(h.bus.stats.scratch_reads, 2);
        // 9-bit resolution via WRITE SCRATCHPAD: 93.75 ms, 0.5 °C steps
        h.bus.set_temp(23.5625);
        assert!(h.reset());
        h.write(0xCC);
        h.write(0x4E);
        h.write(0x50);
        h.write(0x05);
        h.write(0x1F);
        let ms = h.convert() / (CPU_HZ / 1000);
        assert!((93..=95).contains(&ms), "9-bit conversion took {ms} ms");
        let s = h.scratch(None);
        assert_eq!(i16::from_le_bytes([s[0], s[1]]), 23 * 16 + 8);
        assert_eq!(&s[2..5], &[0x50, 0x05, 0x1F]);
        // READ POWER SUPPLY: externally powered reads 1
        assert!(h.reset());
        h.write(0xCC);
        h.write(0xB4);
        assert!(h.read_bit());
        assert_eq!(h.bus.stats.unknown_cmds, 0);
    }

    #[test]
    fn two_devices_search_match_read_rom() {
        let mut h = Host::new(OneWireBus::new(5, 2, 0));
        h.sync();
        h.bus.set_temp(23.5);
        let roms = h.search();
        let mut want: Vec<[u8; 8]> = h.bus.devs.iter().map(|d| d.rom).collect();
        assert_eq!(roms.len(), 2);
        assert_ne!(roms[0], roms[1]);
        let mut got = roms.clone();
        got.sort();
        want.sort();
        assert_eq!(got, want);
        h.convert();
        for r in &roms {
            let s = h.scratch(Some(*r));
            assert_eq!(crc8(&s), 0);
            let i = h.bus.devs.iter().position(|d| d.rom == *r).unwrap();
            let raw = i16::from_le_bytes([s[0], s[1]]);
            assert_eq!(raw as f64 / 16.0, 23.5 + 0.5 * i as f64);
        }
        // READ ROM with one device on the bus
        let mut h = Host::new(OneWireBus::new(5, 1, 0));
        h.sync();
        assert!(h.reset());
        h.write(0x33);
        let rom: [u8; 8] = std::array::from_fn(|_| h.read());
        assert_eq!(rom, h.bus.devs[0].rom);
        // ALARM SEARCH: 72 °C lies between TL 70 and TH 75, so no device answers (bit and complement both 1)
        h.bus.set_temp(72.0);
        h.convert();
        assert!(h.reset());
        h.write(0xEC);
        assert!(h.read_bit() && h.read_bit(), "no alarm: nobody answers");
    }
}
