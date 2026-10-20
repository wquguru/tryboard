//! AXP192 PMIC (I2C 0x34, M5Stack Core2 v1.0 / StickC), per the X-Powers AXP192 datasheet: 0x00 power status (bit5 VBUS present, bit4
//! VBUS usable, bit2 battery current direction = charging), 0x01 charge status (bit6 charging, bit5 battery present), 0x03 ID 0x03, 0x12
//! output enables (bit0 DCDC1, bit1 DCDC3, bit2 LDO2, bit3 LDO3, bit4 DCDC2, bit6 EXTEN), 0x23 / 0x26 / 0x27 DCDC2 / 1 / 3 (0.7 V +
//! 25 mV * n), 0x28 LDO2 (bits 7:4) / LDO3 (bits 3:0) (1.8 V + 0.1 V * n), GPIO0..2 function 0x90 / 0x92 / 0x93 (0 open-drain per 0x94,
//! 2 = LDO (GPIO0), 5 = low, 6 / 7 = floating), GPIO3 / 4 via 0x95 (bit7 enable, mode bits 1:0 / 3:2, 1 = open-drain) and 0x96 bits 0 / 1;
//! IRQ enable 0x40..0x43, status 0x44..0x47 (write 1 to clear; 0x46 bit1 / bit0 PEK short / long, 0x44 bit3 / bit2 VBUS in / out, latch
//! only when enabled). ADC (12 bit = hi << 4 | lo; currents 13 bit = hi << 5 | lo): 0x5A VBUS 1.7 mV, 0x5C VBUS current 0.375 mA, 0x5E
//! temperature 0.1 °C - 144.7, 0x70 battery power, 0x78 VBAT 1.1 mV, 0x7A / 0x7C charge / discharge 0.5 mA, 0x7E APS 1.4 mV. Coulomb
//! counter 0xB0 / 0xB4 (32 bit) integrates the modelled current while 0xB8 bit7 is set (bit6 pause, bit5 clear). Battery is static (no
//! charge model), discharge current a fixed 120 mA estimate; open-drain pins read high when released (board pull-ups assumed). Board presets
//! read `rail_mv` / `gpio` (Core2: backlight DCDC3, LCD reset GPIO4, vibration LDO3, speaker enable GPIO2). Other registers are storage,
//! and accesses outside the modelled set are counted in `unimpl`. (lint: allow-long-comment)

use super::axp2101::ocv_mv;
use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;
use std::collections::BTreeMap;

pub const CHIP_ID: u8 = 0x03;
/// Current drawn from the battery when not on USB (mA, estimate)
const DISCHARGE_MA: f64 = 120.0;
const VBUS_MA: f64 = 200.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rail {
    Dcdc1,
    Dcdc2,
    Dcdc3,
    Ldo2,
    Ldo3,
    Exten,
}

pub struct Axp192 {
    pub addr: u8,
    regs: [u8; 256],
    ptr: u8,
    expect_reg: bool,
    pub percent: u8,
    pub usb: bool,
    pub temp_c: f64,
    pub unimpl: BTreeMap<u8, u64>,
    pub pwrkeys: u64,
    now: u64,
    /// Coulomb counter (charge, discharge) in counts, last integration time
    coulomb: [f64; 2],
    cc_at: u64,
}

fn modelled(r: u8) -> bool {
    matches!(r,
        0x00..=0x01 | 0x03 | 0x06..=0x0b | 0x10 | 0x12 | 0x23 | 0x25..=0x28 | 0x30..=0x36
        | 0x40..=0x47 | 0x4a | 0x4d | 0x56..=0x5f | 0x70..=0x72 | 0x78..=0x7f | 0x82..=0x85
        | 0x8a | 0x8f | 0x90..=0x9a | 0xb0..=0xb8)
}

/// Charge current setting (0x33 bits 3:0), mA
fn charge_ma(code: u8) -> f64 {
    const T: [u16; 16] = [
        100, 190, 280, 360, 450, 550, 630, 700, 780, 880, 960, 1000, 1080, 1160, 1240, 1320,
    ];
    T[(code & 15) as usize] as f64
}

impl Axp192 {
    pub fn new(addr: u8) -> Self {
        let mut regs = [0u8; 256];
        regs[0x03] = CHIP_ID;
        // Factory rails as on Core2 (estimate): DCDC1 3.3 V (ESP32), DCDC3 on, LDO2 / LDO3 3.0 V, EXTEN on
        regs[0x12] = 0x4f;
        regs[0x26] = 0x68; // 0.7 V + 104 * 25 mV = 3.3 V
        regs[0x27] = 0x54; // 2.8 V
        regs[0x28] = 0xcc;
        regs[0x30] = 0x60;
        regs[0x33] = 0xc0;
        regs[0x84] = 0x32;
        regs[0x90] = 0x07;
        regs[0x92] = 0x07;
        regs[0x93] = 0x07;
        let mut d = Axp192 {
            addr,
            regs,
            ptr: 0,
            expect_reg: false,
            percent: 80,
            usb: true,
            temp_c: 30.0,
            unimpl: BTreeMap::new(),
            pwrkeys: 0,
            now: 0,
            coulomb: [0.0; 2],
            cc_at: 0,
        };
        d.update();
        d
    }

    fn charging(&self) -> bool {
        self.usb && self.percent < 100
    }

    /// Battery current (mA): positive charging, negative discharging
    fn battery_ma(&self) -> f64 {
        if self.charging() {
            charge_ma(self.regs[0x33])
        } else if self.usb {
            0.0
        } else {
            -DISCHARGE_MA
        }
    }

    fn latch_irq(&mut self, reg: usize, bits: u8) {
        self.regs[reg] |= bits & self.regs[reg - 4];
    }

    /// Battery level and USB plug (`bat=pct[,usb]`)
    pub fn set_battery(&mut self, percent: u8, usb: bool) {
        self.integrate();
        if usb != self.usb {
            self.latch_irq(0x44, if usb { 0x08 } else { 0x04 });
        }
        self.percent = percent.min(100);
        self.usb = usb;
        self.update();
    }

    /// PEK (power key) press: short or long
    pub fn pwrkey(&mut self, long: bool) {
        self.pwrkeys += 1;
        self.latch_irq(0x46, if long { 0x01 } else { 0x02 });
    }

    /// Output voltage of a rail in mV, None while it is off
    pub fn rail_mv(&self, rail: Rail) -> Option<u16> {
        let r = &self.regs;
        let dcdc = |reg: usize| 700 + 25 * (r[reg] & 0x7f) as u16;
        let (bit, mv) = match rail {
            Rail::Dcdc1 => (0, dcdc(0x26)),
            Rail::Dcdc3 => (1, dcdc(0x27)),
            Rail::Ldo2 => (2, 1800 + 100 * (r[0x28] >> 4) as u16),
            Rail::Ldo3 => (3, 1800 + 100 * (r[0x28] & 15) as u16),
            Rail::Dcdc2 => (4, 700 + 25 * (r[0x23] & 0x3f) as u16),
            Rail::Exten => (6, 5000),
        };
        (r[0x12] & (1 << bit) != 0).then_some(mv)
    }

    /// Level of GPIO0..4 when the PMIC drives it (Some(high)), None for inputs / ADC / PWM
    pub fn gpio(&self, n: u8) -> Option<bool> {
        let r = &self.regs;
        match n {
            0..=2 => {
                let func = r[[0x90, 0x92, 0x93][n as usize]] & 7;
                match func {
                    0 => Some(r[0x94] & (1 << n) != 0),
                    2 if n == 0 => Some(true),
                    5 => Some(false),
                    6 | 7 => Some(true),
                    _ => None,
                }
            }
            3 | 4 => {
                let mode = (r[0x95] >> (2 * (n - 3))) & 3;
                (r[0x95] & 0x80 != 0 && mode == 1).then_some(r[0x96] & (1 << (n - 3)) != 0)
            }
            _ => None,
        }
    }

    fn adc_rate(&self) -> f64 {
        [25.0, 50.0, 100.0, 200.0][(self.regs[0x84] >> 6) as usize]
    }

    /// Advance the coulomb counter to now: counts = mA * s * rate / 32768 (inverse of the datasheet mAh formula)
    fn integrate(&mut self) {
        let dt = self.now.saturating_sub(self.cc_at) as f64 / CPU_HZ as f64;
        self.cc_at = self.now;
        let ctl = self.regs[0xb8];
        if ctl & 0x80 == 0 || ctl & 0x40 != 0 {
            return;
        }
        let i = self.battery_ma();
        let c = i.abs() * dt * self.adc_rate() / 32768.0;
        self.coulomb[if i >= 0.0 { 0 } else { 1 }] += c;
    }

    fn put12(&mut self, reg: usize, v: f64) {
        let raw = v.round().clamp(0.0, 4095.0) as u16;
        self.regs[reg] = (raw >> 4) as u8;
        self.regs[reg + 1] = (raw & 15) as u8;
    }

    fn put13(&mut self, reg: usize, v: f64) {
        let raw = v.round().clamp(0.0, 8191.0) as u16;
        self.regs[reg] = (raw >> 5) as u8;
        self.regs[reg + 1] = (raw & 31) as u8;
    }

    fn update(&mut self) {
        let charging = self.charging();
        self.regs[0x00] = if self.usb { 0x30 } else { 0 } | if charging { 0x04 } else { 0 };
        self.regs[0x01] = 0x20 | if charging { 0x40 } else { 0 };
        let vbat = ocv_mv(self.percent) as f64 + if charging { 50.0 } else { 0.0 };
        let i = self.battery_ma();
        self.put12(0x5a, if self.usb { 5000.0 / 1.7 } else { 0.0 });
        self.put12(0x5c, if self.usb { VBUS_MA / 0.375 } else { 0.0 });
        self.put12(0x5e, (self.temp_c + 144.7) * 10.0);
        self.put12(0x78, vbat / 1.1);
        self.put13(0x7a, i.max(0.0) / 0.5);
        self.put13(0x7c, (-i).max(0.0) / 0.5);
        self.put12(0x7e, if self.usb { 4900.0 } else { vbat } / 1.4);
        let p = (vbat * i.abs() / 1000.0 / 0.00055)
            .round()
            .clamp(0.0, 16_777_215.0) as u32;
        self.regs[0x70..0x73].copy_from_slice(&p.to_be_bytes()[1..]);
        let [c, d] = self.coulomb.map(|v| v as u32);
        self.regs[0xb0..0xb4].copy_from_slice(&c.to_be_bytes());
        self.regs[0xb4..0xb8].copy_from_slice(&d.to_be_bytes());
    }

    fn note(&mut self, reg: u8) {
        if !modelled(reg) {
            *self.unimpl.entry(reg).or_insert(0) += 1;
        }
    }
}

impl I2cDevice for Axp192 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn set_time(&mut self, now: u64) {
        self.now = now;
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        if read {
            self.integrate();
            self.update();
        }
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b;
            self.expect_reg = false;
            return true;
        }
        let p = self.ptr;
        self.note(p);
        match p {
            0x00 | 0x01 | 0x03 | 0x56..=0x7f | 0xb0..=0xb7 => {}
            0x44..=0x47 | 0x4d => self.regs[p as usize] &= !b,
            0xb8 => {
                self.integrate();
                if b & 0x20 != 0 {
                    self.coulomb = [0.0; 2];
                }
                self.regs[0xb8] = b & 0xc0;
            }
            _ => self.regs[p as usize] = b,
        }
        self.ptr = p.wrapping_add(1);
        true
    }
    fn read(&mut self) -> u8 {
        let p = self.ptr;
        self.note(p);
        self.ptr = p.wrapping_add(1);
        self.regs[p as usize]
    }
    fn stop(&mut self) {}
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rd(d: &mut Axp192, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    fn wr(d: &mut Axp192, reg: u8, v: &[u8]) {
        d.start(false);
        d.write(reg);
        for b in v {
            d.write(*b);
        }
    }

    /// M5Unified AXP192_Class::getBatteryLevel
    fn m5_level(d: &mut Axp192) -> i32 {
        let b = rd(d, 0x78, 4);
        let v = ((b[0] as i32) << 4) + b[1] as i32;
        let i = ((b[2] as i32) << 5) + b[3] as i32;
        let mut r = if v > 3150 {
            ((v - 3075) as f32 * 0.16) as i32
        } else if v > 2690 {
            ((v - 2690) as f32 * 0.027) as i32
        } else {
            0
        };
        if i > 16 {
            r -= 16;
        }
        r.min(100)
    }

    #[test]
    fn id_rails_and_gpio() {
        let mut d = Axp192::new(0x34);
        assert_eq!(rd(&mut d, 0x03, 1), [CHIP_ID]);
        // Core2 init: LCD backlight on DCDC3, vibration off (LDO3), LCD reset via GPIO4 (open-drain output)
        wr(&mut d, 0x27, &[((3000 - 700) / 25) as u8]);
        wr(&mut d, 0x12, &[0x4f & !0x08]);
        assert_eq!(d.rail_mv(Rail::Dcdc3), Some(3000));
        assert_eq!(d.rail_mv(Rail::Ldo3), None);
        assert_eq!(d.rail_mv(Rail::Ldo2), Some(3000));
        wr(&mut d, 0x95, &[0x84]);
        wr(&mut d, 0x96, &[0x00]);
        assert_eq!(d.gpio(4), Some(false));
        wr(&mut d, 0x96, &[0x02]);
        assert_eq!(d.gpio(4), Some(true));
        assert_eq!(d.gpio(3), None);
        // GPIO2 (speaker enable): M5Unified writes 0x05 low / 0x06 floating
        wr(&mut d, 0x93, &[0x05]);
        assert_eq!(d.gpio(2), Some(false));
        wr(&mut d, 0x93, &[0x06]);
        assert_eq!(d.gpio(2), Some(true));
        assert_eq!(rd(&mut d, 0x93, 1), [0x06]);
        assert!(d.unimpl.is_empty());
        rd(&mut d, 0xf0, 1);
        assert_eq!(d.unimpl.get(&0xf0), Some(&1));
    }

    #[test]
    fn battery_irq_and_coulomb() {
        let mut d = Axp192::new(0x34);
        // On USB and charging: status bits, VBUS ADC
        assert_eq!(rd(&mut d, 0x00, 2), [0x34, 0x60]);
        let b = rd(&mut d, 0x5a, 2);
        assert!((((b[0] as u16) << 4 | b[1] as u16) as f64 * 1.7 - 5000.0).abs() < 2.0);
        d.set_battery(80, false);
        assert_eq!(rd(&mut d, 0x00, 2), [0x00, 0x20]);
        let high = m5_level(&mut d);
        assert!((75..=90).contains(&high), "{high}");
        d.set_battery(20, false);
        assert!(m5_level(&mut d) < high);
        // PEK IRQ latches only when enabled (M5Unified writes 0x42 = 0x03), cleared by writing 1
        d.pwrkey(false);
        assert_eq!(rd(&mut d, 0x46, 1), [0]);
        wr(&mut d, 0x42, &[0x03]);
        d.pwrkey(false);
        assert_eq!(rd(&mut d, 0x46, 1), [0x02]);
        wr(&mut d, 0x46, &[0x02]);
        assert_eq!(rd(&mut d, 0x46, 1), [0]);
        // Coulomb counter: 120 mA discharge for 1 h at 25 Hz -> 120 * 3600 * 25 / 32768 counts
        wr(&mut d, 0xb8, &[0x80]);
        d.set_time(CPU_HZ * 3600);
        let b = rd(&mut d, 0xb4, 4);
        let n = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64;
        assert!((n - 120.0 * 3600.0 * 25.0 / 32768.0).abs() < 1.0, "{n}");
        wr(&mut d, 0xb8, &[0xa0]);
        assert_eq!(rd(&mut d, 0xb4, 4), [0, 0, 0, 0]);
    }
}
