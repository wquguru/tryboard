//! INA219 current / power monitor (I2C 0x40..0x4F), per the TI INA219 datasheet: 16-bit big-endian registers, no pointer
//! auto-increment. 0x00 config (reset 0x399F; bit15 RST, bit13 BRNG 16 / 32 V, bits 12:11 PGA ±40..±320 mV, bits 2:0 mode),
//! 0x01 shunt voltage (signed, 10 µV / LSB, clipped to the PGA range), 0x02 bus voltage (4 mV / LSB in bits 15:3, bit1 CNVR,
//! bit0 OVF), 0x03 power = current * bus / 5000, 0x04 current = shunt * cal / 4096, 0x05 calibration (bit0 reads 0). CNVR is
//! set one conversion time after a config write or power read, which clears it. Modes 0 / 4 (power-down, ADC off) freeze the
//! readings. What it measures comes from `set_load` (the electrical model). (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

pub const CONFIG_RESET: u16 = 0x399f;
/// Shunt on common breakout modules (R100)
pub const SHUNT_OHM: f64 = 0.1;

pub struct Ina219 {
    pub addr: u8,
    config: u16,
    cal: u16,
    ptr: u8,
    expect_reg: bool,
    /// Bytes into the current 16-bit word (0 = MSB next)
    half: u8,
    word: u16,
    now: u64,
    /// Cycle at which CNVR sets; None = no conversion pending
    cnvr_at: Option<u64>,
    /// Live inputs: bus voltage (mV) and shunt current (A)
    pub bus_mv: f64,
    pub current_a: f64,
    pub shunt_ohm: f64,
    /// Last converted raw values (shunt LSBs, bus LSBs), kept while the ADC is off
    shunt_raw: i16,
    bus_raw: u16,
}

impl Ina219 {
    pub fn new(addr: u8) -> Self {
        let mut d = Ina219 {
            addr,
            config: CONFIG_RESET,
            cal: 0,
            ptr: 0,
            expect_reg: false,
            half: 0,
            word: 0,
            now: 0,
            cnvr_at: None,
            bus_mv: 0.0,
            current_a: 0.0,
            shunt_ohm: SHUNT_OHM,
            shunt_raw: 0,
            bus_raw: 0,
        };
        d.start_conversion();
        d
    }

    /// What the chip sees: bus voltage (V, IN- to GND) and the current through the shunt (A, positive IN+ -> IN-)
    pub fn set_load(&mut self, bus_v: f64, current_a: f64) {
        self.bus_mv = bus_v * 1000.0;
        self.current_a = current_a;
    }

    fn mode(&self) -> u16 {
        self.config & 7
    }

    fn adc_on(&self) -> bool {
        !matches!(self.mode(), 0 | 4)
    }

    /// Conversion time (cycles) of one ADC setting (bits 3:0 of BADC / SADC), datasheet table 5 max values
    fn adc_time(bits: u16) -> u64 {
        let us = if bits & 8 == 0 {
            [93.0, 163.0, 304.0, 586.0][(bits & 3) as usize]
        } else {
            [
                586.0, 1060.0, 2130.0, 4260.0, 8510.0, 17020.0, 34050.0, 68100.0,
            ][(bits & 7) as usize]
        };
        (us * CPU_HZ as f64 / 1e6) as u64
    }

    fn conv_time(&self) -> u64 {
        let (badc, sadc) = ((self.config >> 7) & 0xf, (self.config >> 3) & 0xf);
        match self.mode() & 3 {
            1 => Self::adc_time(sadc),
            2 => Self::adc_time(badc),
            _ => Self::adc_time(sadc) + Self::adc_time(badc),
        }
    }

    fn start_conversion(&mut self) {
        self.cnvr_at = self.adc_on().then(|| self.now + self.conv_time());
    }

    /// Full-scale shunt LSBs for the PGA setting (±40 / 80 / 160 / 320 mV)
    fn shunt_limit(&self) -> f64 {
        4000.0 * (1u16 << ((self.config >> 11) & 3)) as f64
    }

    /// Refresh the latched values from the live inputs while the ADC runs
    fn sample(&mut self) {
        if !self.adc_on() {
            return;
        }
        let m = self.mode() & 3;
        if m != 2 {
            let lim = self.shunt_limit();
            let uv = self.current_a * self.shunt_ohm * 1e6;
            self.shunt_raw = (uv / 10.0).round().clamp(-lim, lim) as i16;
        }
        if m != 1 {
            let max_mv = if self.config & 0x2000 != 0 {
                32000.0
            } else {
                16000.0
            };
            self.bus_raw = (self.bus_mv.clamp(0.0, max_mv) / 4.0).round().min(8191.0) as u16;
        }
    }

    fn current_reg(&self) -> (i16, bool) {
        let c = self.shunt_raw as i64 * self.cal as i64 / 4096;
        (c.clamp(-32768, 32767) as i16, c != c.clamp(-32768, 32767))
    }

    fn power_reg(&self) -> (u16, bool) {
        let (c, ovf) = self.current_reg();
        let p = (c as i64).abs() * self.bus_raw as i64 / 5000;
        (p.min(65535) as u16, ovf || p > 65535)
    }

    fn reg(&mut self, p: u8) -> u16 {
        self.sample();
        match p {
            0x00 => self.config,
            0x01 => self.shunt_raw as u16,
            0x02 => {
                let cnvr = self.cnvr_at.is_some_and(|t| self.now >= t);
                let ovf = self.power_reg().1;
                self.bus_raw << 3 | (cnvr as u16) << 1 | ovf as u16
            }
            0x03 => self.power_reg().0,
            0x04 => self.current_reg().0 as u16,
            0x05 => self.cal,
            _ => 0,
        }
    }

    fn set_reg(&mut self, p: u8, v: u16) {
        match p {
            0x00 if v & 0x8000 != 0 => {
                self.config = CONFIG_RESET;
                self.cal = 0;
                self.start_conversion();
            }
            0x00 => {
                self.config = v & 0x3fff;
                self.start_conversion();
            }
            0x05 => self.cal = v & 0xfffe,
            _ => {}
        }
    }
}

impl I2cDevice for Ina219 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn set_time(&mut self, now: u64) {
        self.now = now;
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        self.half = 0;
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b;
            self.expect_reg = false;
        } else if self.half == 0 {
            self.word = (b as u16) << 8;
            self.half = 1;
        } else {
            self.set_reg(self.ptr, self.word | b as u16);
            self.half = 0;
        }
        true
    }
    fn read(&mut self) -> u8 {
        if self.half == 0 {
            self.word = self.reg(self.ptr);
            // Reading the power register clears CNVR; continuous modes convert again
            if self.ptr == 0x03 {
                self.cnvr_at = (self.mode() >= 5).then(|| self.now + self.conv_time());
            }
        }
        self.half ^= 1;
        if self.half == 1 {
            (self.word >> 8) as u8
        } else {
            self.word as u8
        }
    }
    fn stop(&mut self) {}
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rd16(d: &mut Ina219, reg: u8) -> u16 {
        d.start(false);
        d.write(reg);
        d.start(true);
        (d.read() as u16) << 8 | d.read() as u16
    }

    fn wr16(d: &mut Ina219, reg: u8, v: u16) {
        d.start(false);
        d.write(reg);
        d.write((v >> 8) as u8);
        d.write(v as u8);
        d.stop();
    }

    #[test]
    fn readings_and_calibration() {
        let mut d = Ina219::new(0x40);
        assert_eq!(rd16(&mut d, 0x00), CONFIG_RESET);
        // 5.0 V bus, 120 mA through 0.1 ohm = 12 mV shunt
        d.set_load(5.0, 0.120);
        assert_eq!(rd16(&mut d, 0x01) as i16, 1200);
        assert_eq!(rd16(&mut d, 0x02) >> 3, 1250);
        // Calibration 0 (power-on): current and power read 0
        assert_eq!(rd16(&mut d, 0x04), 0);
        // Cal 4096 with 0.1 ohm: current LSB 100 uA, power LSB 2 mW
        wr16(&mut d, 0x05, 4097);
        assert_eq!(rd16(&mut d, 0x05), 4096);
        assert_eq!(rd16(&mut d, 0x04) as i16, 1200);
        assert_eq!(rd16(&mut d, 0x03), 300);
        // Reverse current reads negative; PGA /1 clips at 40 mV
        d.set_load(3.3, -0.05);
        assert_eq!(rd16(&mut d, 0x01) as i16, -500);
        wr16(&mut d, 0x00, 0x019f);
        d.set_load(3.3, 1.0);
        assert_eq!(rd16(&mut d, 0x01) as i16, 4000);
    }

    #[test]
    fn cnvr_power_down_and_reset() {
        let mut d = Ina219::new(0x40);
        d.set_load(5.0, 0.1);
        assert_eq!(rd16(&mut d, 0x02) & 2, 0);
        d.set_time(CPU_HZ);
        assert_eq!(rd16(&mut d, 0x02) & 2, 2);
        rd16(&mut d, 0x03);
        assert_eq!(rd16(&mut d, 0x02) & 2, 0);
        // Power-down keeps the last value
        wr16(&mut d, 0x00, CONFIG_RESET & !7);
        d.set_load(4.0, 0.2);
        assert_eq!(rd16(&mut d, 0x02) >> 3, 1250);
        assert_eq!(rd16(&mut d, 0x01) as i16, 1000);
        wr16(&mut d, 0x05, 100);
        wr16(&mut d, 0x00, 0x8000);
        assert_eq!(rd16(&mut d, 0x00), CONFIG_RESET);
        assert_eq!(rd16(&mut d, 0x05), 0);
        assert_eq!(rd16(&mut d, 0x02) >> 3, 1000);
    }
}
