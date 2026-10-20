//! I2C buses identified by their SDA / SCL pads (M5-02). Devices on a pin bus are reached two ways: by whichever I2C
//! controller the GPIO matrix routes to both pads, and by firmware bit-banging the pads as GPIO (M5GFX autodetect).
//! The pad side is a slave state machine fed with resolved pad levels; it pulls SDA low (ACK / data 0) through the
//! chip's external-drive bits, and an optional board pull-up beats the internal pulldown like a real 4.7 kΩ resistor.
//! (lint: allow-long-comment)

use crate::i2c::I2cDevice;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    /// Master sends (address or data byte)
    Rx,
    /// Device sends (read data)
    Tx,
    /// NACKed: wait for START / STOP
    Ignore,
}

/// One bus wired to a fixed SDA / SCL pad pair
pub struct PinBus {
    pub sda: u32,
    pub scl: u32,
    /// External pull-ups on both lines (M5 internal buses have them)
    pub pullup: bool,
    pub devices: Vec<Box<dyn I2cDevice>>,
    /// Device currently pulls SDA low
    pub sda_low: bool,
    /// Bit-banged address bytes seen / not acknowledged
    pub transactions: u64,
    pub nacks: u64,
    phase: Phase,
    addr_byte: bool,
    /// SCL rising edges in the current byte (9 per byte incl. ACK)
    bit: u8,
    shift: u8,
    out: u8,
    cur: Option<usize>,
    /// Rx: device ACKed the byte; Tx: master ACKed it
    ack: bool,
    to_read: bool,
    /// Last observed (sda, scl); None while the pads are not GPIO-owned
    last: Option<(bool, bool)>,
}

impl PinBus {
    pub fn new(sda: u32, scl: u32, pullup: bool) -> Self {
        PinBus {
            sda,
            scl,
            pullup,
            devices: Vec::new(),
            sda_low: false,
            transactions: 0,
            nacks: 0,
            phase: Phase::Idle,
            addr_byte: false,
            bit: 0,
            shift: 0,
            out: 0xff,
            cur: None,
            ack: false,
            to_read: false,
            last: None,
        }
    }

    pub fn attach(&mut self, dev: Box<dyn I2cDevice>) {
        let a = dev.address();
        self.devices.retain(|d| d.address() != a);
        self.devices.push(dev);
    }

    pub fn device<T: 'static>(&mut self) -> Option<&mut T> {
        self.devices
            .iter_mut()
            .find_map(|d| d.as_any_mut().downcast_mut::<T>())
    }

    /// Pad mask of both lines
    pub fn mask(&self) -> u64 {
        (1 << self.sda) | (1 << self.scl)
    }

    /// Pads handed to a peripheral: forget line history and let go of SDA
    pub fn detach_pads(&mut self) {
        self.last = None;
        self.sda_low = false;
        if let Some(i) = self.cur.take() {
            self.devices[i].stop();
        }
        self.phase = Phase::Idle;
    }

    /// New resolved line levels (the device's own SDA drive included)
    pub fn on_lines(&mut self, now: u64, sda: bool, scl: bool) {
        let Some((ps, pc)) = self.last.replace((sda, scl)) else {
            return;
        };
        if scl != pc {
            if scl {
                self.rise(sda);
            } else {
                self.fall();
            }
        } else if scl && sda != ps {
            if sda {
                self.stop();
            } else {
                self.start(now);
            }
        }
    }

    fn start(&mut self, now: u64) {
        // A repeated START keeps the addressed device (no stop), like the controller model
        for d in self.devices.iter_mut() {
            d.set_time(now);
        }
        self.phase = Phase::Rx;
        self.addr_byte = true;
        self.bit = 0;
        self.shift = 0;
        self.sda_low = false;
        self.to_read = false;
    }

    fn stop(&mut self) {
        if let Some(i) = self.cur.take() {
            self.devices[i].stop();
        }
        self.phase = Phase::Idle;
        self.sda_low = false;
    }

    fn rise(&mut self, sda: bool) {
        match self.phase {
            Phase::Rx if self.bit < 8 => self.shift = self.shift << 1 | sda as u8,
            Phase::Tx if self.bit == 8 => self.ack = !sda,
            Phase::Rx | Phase::Tx => {}
            _ => return,
        }
        self.bit += 1;
    }

    fn fall(&mut self) {
        match (self.phase, self.bit) {
            (Phase::Rx, 8) => {
                let b = self.shift;
                let ack = if self.addr_byte {
                    self.addr_byte = false;
                    self.transactions += 1;
                    let read = b & 1 != 0;
                    self.cur = self.devices.iter().position(|d| d.address() == b >> 1);
                    let ok = match self.cur {
                        Some(i) => self.devices[i].start(read),
                        None => false,
                    };
                    if !ok {
                        self.nacks += 1;
                        self.cur = None;
                    }
                    self.to_read = ok && read;
                    ok
                } else {
                    match self.cur {
                        Some(i) => self.devices[i].write(b),
                        None => false,
                    }
                };
                self.ack = ack;
                self.sda_low = ack;
            }
            (Phase::Rx, 9) => {
                self.sda_low = false;
                self.bit = 0;
                self.shift = 0;
                if !self.ack {
                    self.phase = Phase::Ignore;
                } else if self.to_read {
                    self.phase = Phase::Tx;
                    self.load_next();
                }
            }
            (Phase::Tx, 1..=7) => self.sda_low = self.out >> (7 - self.bit) & 1 == 0,
            (Phase::Tx, 8) => self.sda_low = false,
            (Phase::Tx, 9) => {
                self.bit = 0;
                if self.ack {
                    self.load_next();
                } else {
                    self.phase = Phase::Ignore;
                    self.sda_low = false;
                }
            }
            _ => {}
        }
    }

    fn load_next(&mut self) {
        self.out = match self.cur {
            Some(i) => self.devices[i].read(),
            None => 0xff,
        };
        self.sda_low = self.out & 0x80 == 0;
    }
}

/// All pin buses of one chip
#[derive(Default)]
pub struct PinBuses {
    pub buses: Vec<PinBus>,
}

impl PinBuses {
    pub fn is_empty(&self) -> bool {
        self.buses.is_empty()
    }

    /// Add a bus; refused (None) when a pad is already used by another bus
    pub fn add(&mut self, bus: PinBus) -> Option<usize> {
        if self.buses.iter().any(|b| b.mask() & bus.mask() != 0) || bus.sda == bus.scl {
            return None;
        }
        self.buses.push(bus);
        Some(self.buses.len() - 1)
    }

    /// External pull-up mask to OR into the chip's board pull-ups
    pub fn pullups(&self) -> u64 {
        self.buses
            .iter()
            .filter(|b| b.pullup)
            .fold(0, |m, b| m | b.mask())
    }

    /// Bus whose pads carry controller signals (FUNCn_OUT_SEL & `mask` == sda_sig / scl_sig on both pads)
    pub fn routed(&self, func_out: &[u32], mask: u32, sda_sig: u32, scl_sig: u32) -> Option<usize> {
        self.buses.iter().position(|b| {
            let f = |p: u32| func_out.get(p as usize).map(|v| v & mask);
            f(b.sda) == Some(sda_sig) && f(b.scl) == Some(scl_sig)
        })
    }

    /// Feed resolved pad levels; `gpio_owned(pin)` says the pad's output is plain GPIO. Returns SDA drive changes
    /// (pin, pulled low) for the chip to apply to its external-drive bits before resolving again.
    pub fn on_level(
        &mut self,
        now: u64,
        lv: u64,
        gpio_owned: impl Fn(u32) -> bool,
    ) -> Vec<(u32, bool)> {
        let mut out = Vec::new();
        for b in &mut self.buses {
            let before = b.sda_low;
            if gpio_owned(b.sda) && gpio_owned(b.scl) {
                b.on_lines(now, lv >> b.sda & 1 != 0, lv >> b.scl & 1 != 0);
            } else if b.last.is_some() {
                b.detach_pads();
            }
            if b.sda_low != before {
                out.push((b.sda, b.sda_low));
            }
        }
        out
    }

    pub fn device<T: 'static>(&mut self) -> Option<&mut T> {
        self.buses.iter_mut().find_map(|b| b.device::<T>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::{bme280::Bme280, ssd1306::Ssd1306};

    /// Wired-AND bit-bang master over one bus: master releases (1) or pulls (0), device may pull SDA
    struct Master {
        bus: PinBuses,
        sda: bool,
        scl: bool,
        t: u64,
    }

    impl Master {
        fn line(&self) -> bool {
            self.sda && !self.bus.buses[0].sda_low
        }
        fn set(&mut self, sda: bool, scl: bool) {
            self.sda = sda;
            self.scl = scl;
            self.t += 100;
            for _ in 0..3 {
                let lv = (self.line() as u64) << 11 | (self.scl as u64) << 12;
                if self.bus.on_level(self.t, lv, |_| true).is_empty() {
                    break;
                }
            }
        }
        fn start(&mut self) {
            self.set(true, true);
            self.set(false, true);
            self.set(false, false);
        }
        fn stop(&mut self) {
            self.set(false, false);
            self.set(false, true);
            self.set(true, true);
        }
        /// Clock one bit out (or in, with bit = true releasing SDA) and sample SDA while SCL is high
        fn bit(&mut self, b: bool) -> bool {
            self.set(b, false);
            self.set(b, true);
            let v = self.line();
            self.set(b, false);
            v
        }
        fn write(&mut self, byte: u8) -> bool {
            for i in (0..8).rev() {
                self.bit(byte >> i & 1 != 0);
            }
            !self.bit(true)
        }
        fn read(&mut self, ack: bool) -> u8 {
            let mut v = 0u8;
            for _ in 0..8 {
                v = v << 1 | self.bit(true) as u8;
            }
            self.bit(!ack);
            v
        }
    }

    fn master() -> Master {
        let mut bus = PinBuses::default();
        let mut b = PinBus::new(11, 12, true);
        b.attach(Box::new(Bme280::new(0x76)));
        b.attach(Box::new(Ssd1306::new(0x3c)));
        bus.add(b).unwrap();
        let mut m = Master {
            bus,
            sda: true,
            scl: true,
            t: 0,
        };
        m.set(true, true);
        m
    }

    #[test]
    fn bitbang_scan_and_register_read() {
        let mut m = master();
        let mut found = Vec::new();
        for a in 1u8..0x78 {
            m.start();
            if m.write(a << 1) {
                found.push(a);
            }
            m.stop();
        }
        assert_eq!(found, vec![0x3c, 0x76]);
        // BME280 chip ID: write register 0xD0, repeated START, read one byte
        m.start();
        assert!(m.write(0x76 << 1));
        assert!(m.write(0xd0));
        m.start();
        assert!(m.write(0x76 << 1 | 1));
        assert_eq!(m.read(false), 0x60);
        m.stop();
        let b = &m.bus.buses[0];
        assert_eq!((b.transactions, b.nacks), (0x77 + 2, 0x77 - 2));
        assert!(!b.sda_low);
    }

    #[test]
    fn pads_not_gpio_are_ignored_and_routing_needs_both_pads() {
        let mut m = master();
        m.start();
        assert!(m.write(0x76 << 1));
        // Pads handed to the controller mid-byte: the device lets go of SDA
        m.bus.on_level(0, 0, |_| false);
        assert!(!m.bus.buses[0].sda_low);
        let mut fo = [0x100u32; 49];
        fo[11] = 92;
        assert_eq!(m.bus.routed(&fo, 0x1ff, 92, 91), None);
        fo[12] = 91;
        assert_eq!(m.bus.routed(&fo, 0x1ff, 92, 91), Some(0));
        assert_eq!(m.bus.pullups(), 1 << 11 | 1 << 12);
        assert!(m.bus.add(PinBus::new(12, 13, false)).is_none());
    }
}
