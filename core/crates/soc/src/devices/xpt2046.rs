//! XPT2046 / ADS7843 resistive touch controller on SPI (F-10a2, CYD board). Behaviour from the XPT2046 datasheet:
//! a control byte (start bit 1, channel A2..A0, MODE, SER/DFR, PD1..0) starts a conversion; one BUSY clock later the
//! result shifts out MSB first on DOUT. The bit stream carries over between SPI transfers while CS stays low.

use std::collections::VecDeque;

/// Raw 12-bit span the panel's edges map to (typical CYD calibration in tutorials; not measured on real hardware)
const RAW_X: (f64, f64) = (200.0, 3700.0);
const RAW_Y: (f64, f64) = (240.0, 3800.0);
/// Pressure channels while touched: z = Z1 + 4095 - Z2 = 1495, above the usual 300..400 threshold
const Z1_TOUCHED: u16 = 600;
const Z2_TOUCHED: u16 = 3200;

#[derive(Clone, Debug)]
pub struct Xpt2046 {
    pub cs: u32,
    /// PENIRQ output (active low while pressed), driven by the machine
    pub irq: Option<u32>,
    /// Panel size the touch coordinates are given in (screen pixels)
    pub width: u16,
    pub height: u16,
    touch: Option<(u16, u16)>,
    /// Control byte bits collected so far (None = waiting for a start bit)
    ctrl: Option<(u8, u32)>,
    dout: VecDeque<bool>,
    pub conversions: u64,
}

impl Xpt2046 {
    pub fn new(cs: u32, irq: Option<u32>) -> Self {
        Self {
            cs,
            irq,
            width: 240,
            height: 320,
            touch: None,
            ctrl: None,
            dout: VecDeque::new(),
            conversions: 0,
        }
    }

    pub fn press(&mut self, x: u16, y: u16) {
        self.touch = Some((x.min(self.width - 1), y.min(self.height - 1)));
    }

    pub fn release(&mut self) {
        self.touch = None;
    }

    pub fn touched(&self) -> bool {
        self.touch.is_some()
    }

    /// 12-bit conversion result of channel A2..A0
    fn sample(&self, ch: u8) -> u16 {
        let span = |(lo, hi): (f64, f64), v: u16, n: u16| {
            (lo + (hi - lo) * v as f64 / (n.max(2) - 1) as f64).round() as u16
        };
        match (ch, self.touch) {
            (0b101, Some((x, _))) => span(RAW_X, x, self.width),
            (0b001, Some((_, y))) => span(RAW_Y, y, self.height),
            (0b011, Some(_)) => Z1_TOUCHED,
            (0b100, Some(_)) => Z2_TOUCHED,
            (0b100, None) => 4095,
            // VBAT (1/4 of 3.3 V on a 2.5 V reference) / AUX / temperature: fixed mid-scale stand-ins
            (0b010, _) => 1352,
            (0b110 | 0b000 | 0b111, _) => 2048,
            _ => 0,
        }
    }

    /// One SCLK: sample DIN, return the DOUT bit the master reads on this clock
    fn clock(&mut self, din: bool) -> bool {
        let out = self.dout.pop_front().unwrap_or(false);
        match self.ctrl {
            None if din => self.ctrl = Some((1, 1)),
            None => {}
            Some((v, n)) => {
                let v = v << 1 | din as u8;
                if n + 1 < 8 {
                    self.ctrl = Some((v, n + 1));
                } else {
                    self.ctrl = None;
                    self.convert(v);
                }
            }
        }
        out
    }

    /// Control byte complete: BUSY clock, then the result MSB first (12 or 8 bits per MODE)
    fn convert(&mut self, c: u8) {
        self.conversions += 1;
        let mut r = self.sample((c >> 4) & 7);
        let bits = if c & 0x08 != 0 {
            r >>= 4;
            8
        } else {
            12
        };
        self.dout.clear();
        self.dout.push_back(false);
        self.dout.extend((0..bits).rev().map(|i| r >> i & 1 != 0));
    }

    fn clock_byte(&mut self, b: u8, n: u32) -> u8 {
        let mut o = 0u8;
        for i in 0..n {
            o = o << 1 | self.clock(b >> (7 - i) & 1 != 0) as u8;
        }
        o << (8 - n)
    }

    /// One SPI transaction: `head` (`head_bits` of command / address), `dummy` idle clocks, then MOSI `data`; returns
    /// `miso_len` bytes, read while `data` shifts out (full duplex) or after it (half duplex)
    pub fn transfer(
        &mut self,
        head: &[u8],
        head_bits: u32,
        dummy: u32,
        data: &[u8],
        miso_len: usize,
        full_duplex: bool,
    ) -> Vec<u8> {
        let mut left = head_bits;
        for &b in head {
            let n = left.min(8);
            self.clock_byte(b, n);
            left -= n;
        }
        for _ in 0..dummy {
            self.clock(false);
        }
        let rx: Vec<u8> = data.iter().map(|&b| self.clock_byte(b, 8)).collect();
        if full_duplex {
            let mut rx = rx;
            rx.resize(miso_len, 0);
            return rx;
        }
        (0..miso_len).map(|_| self.clock_byte(0, 8)).collect()
    }

    /// CS high aborts a control byte and stops DOUT
    pub fn cs_release(&mut self) {
        self.ctrl = None;
        self.dout.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read3(t: &mut Xpt2046, cmd: u8) -> u16 {
        let rx = t.transfer(&[], 0, 0, &[cmd, 0, 0], 3, true);
        u16::from_be_bytes([rx[1], rx[2]]) >> 3
    }

    #[test]
    fn full_duplex_three_byte_reads() {
        let mut t = Xpt2046::new(33, Some(36));
        assert_eq!(read3(&mut t, 0xB0), 0);
        assert_eq!(read3(&mut t, 0xC0), 4095);
        t.press(0, 319);
        assert_eq!(read3(&mut t, 0xD0), 200);
        assert_eq!(read3(&mut t, 0x90), 3800);
        let z = read3(&mut t, 0xB0) + 4095 - read3(&mut t, 0xC0);
        assert!(z > 400, "{z}");
        assert_eq!(t.conversions, 6);
    }

    #[test]
    fn pipelined_and_half_duplex() {
        let mut t = Xpt2046::new(33, None);
        t.press(239, 0);
        // XPT2046_Touchscreen style: the next command rides in the low byte of a 16-bit transfer
        t.transfer(&[], 0, 0, &[0xD1], 1, true);
        let rx = t.transfer(&[], 0, 0, &[0x00, 0x91], 2, true);
        assert_eq!(u16::from_be_bytes([rx[0], rx[1]]) >> 3, 3700);
        let rx = t.transfer(&[], 0, 0, &[0x00, 0x00], 2, true);
        assert_eq!(u16::from_be_bytes([rx[0], rx[1]]) >> 3, 240);
        // esp_lcd_touch style: command phase, then a 16-bit read phase
        let rx = t.transfer(&[0xD0], 8, 0, &[], 2, false);
        assert_eq!(u16::from_be_bytes([rx[0], rx[1]]) >> 3, 3700);
        // 8-bit mode keeps the top bits
        let rx = t.transfer(&[], 0, 0, &[0xD8, 0, 0], 3, true);
        assert_eq!(
            (u16::from_be_bytes([rx[1], rx[2]]) >> 7) as u8,
            (3700u16 >> 4) as u8
        );
    }
}
