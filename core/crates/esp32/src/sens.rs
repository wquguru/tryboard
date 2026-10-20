//! Classic ESP32 SAR ADC one-shot through the RTC SENS controller (0x3FF48800, M5-12), on the shared AdcModel.
//! MEAS_START1 / 2: data [15:0], done 16, start 17, en_pad [30:19]; ATTEN1 / 2 two bits per channel.

use crate::periph::NPINS;
use tryboard_soc::adc::{AdcChip, AdcModel};

/// Offset of SENS inside the RTC_CNTL page
pub const OFFSET: u32 = 0x800;
const READ_CTRL: u32 = 0x00;
const START_FORCE: u32 = 0x2c;
const ATTEN1: u32 = 0x34;
const ATTEN2: u32 = 0x38;
const SLAVE_ADDR1: u32 = 0x3c;
const MEAS_START1: u32 = 0x54;
const READ_CTRL2: u32 = 0x90;
const MEAS_START2: u32 = 0x94;
// Touch pads (M5-13): a measurement completes at once; OUT1..5 hold the counts, slot 2n in [31:16], 2n+1 in [15:0]
const TOUCH_OUT1: u32 = 0x70;
const TOUCH_OUT5: u32 = 0x80;
const TOUCH_CTRL2: u32 = 0x84;
/// Count of an untouched pad with the IDF default charge settings; a finger lowers it
pub const TOUCH_IDLE: u16 = 1000;
/// ADC1 channel n -> GPIO, ADC2 channel n -> GPIO (soc/esp32/adc_periph.c)
pub const ADC1_GPIO: [usize; 8] = [36, 37, 38, 39, 32, 33, 34, 35];
pub const ADC2_GPIO: [usize; 10] = [4, 0, 2, 15, 13, 12, 14, 27, 25, 26];

/// Pin voltages plus the SENS ADC registers (the bus keeps its old `adc` name for the common interface)
pub struct Adc {
    pub pin_mv: [f32; NPINS],
    pub model: AdcModel,
    /// Touch pad counts by pad number (board presets lower a pad to mimic its load)
    pub touch: [u16; 10],
    regs: [u32; 0x100 / 4],
}

impl Default for Adc {
    fn default() -> Self {
        Adc {
            pin_mv: [0.0; NPINS],
            model: AdcModel::new(AdcChip::Esp32),
            touch: [TOUCH_IDLE; 10],
            regs: [0; 0x100 / 4],
        }
    }
}

impl Adc {
    /// Registers with modelled behaviour (`off` relative to SENS); others stay generic and count as unimpl
    pub fn owns(off: u32) -> bool {
        matches!(
            off,
            READ_CTRL
                | START_FORCE
                | ATTEN1
                | ATTEN2
                | SLAVE_ADDR1
                | MEAS_START1
                | READ_CTRL2
                | MEAS_START2
                | TOUCH_OUT1..=TOUCH_OUT5 | TOUCH_CTRL2
        )
    }

    pub fn read(&self, off: u32) -> u32 {
        let v = self.regs[(off / 4) as usize];
        // meas_status [29:22]: 0 = RTC controller idle (adc_oneshot_ll_start spins on it)
        match off {
            SLAVE_ADDR1 => v & !(0xff << 22),
            // touch_meas_done: the FSM finishes before the driver polls
            TOUCH_CTRL2 => v | 1 << 10,
            TOUCH_OUT1..=TOUCH_OUT5 => {
                // Register slots 8 / 9 hold pads 9 / 8 (TOUCH_LL_CHAN_SWAP)
                let pad = |s: usize| [0, 1, 2, 3, 4, 5, 6, 7, 9, 8][s];
                let n = ((off - TOUCH_OUT1) / 4 * 2) as usize;
                (self.touch[pad(n)] as u32) << 16 | self.touch[pad(n + 1)] as u32
            }
            _ => v,
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let old = self.regs[(off / 4) as usize];
        let mut v = v;
        if off == MEAS_START1 || off == MEAS_START2 {
            let unit = (off == MEAS_START2) as u32;
            if v & (1 << 17) == 0 {
                v &= !(1 << 16); // start cleared: done drops too
            } else if old & (1 << 17) == 0 {
                let pads = (v >> 19) & 0xfff;
                let data = if pads == 0 {
                    old & 0xffff
                } else {
                    self.sample(unit, pads.trailing_zeros())
                };
                v = (v & !0xffff) | data | (1 << 16);
            }
        }
        self.regs[(off / 4) as usize] = v;
    }

    fn sample(&mut self, unit: u32, ch: u32) -> u32 {
        let atten =
            (self.regs[((if unit == 0 { ATTEN1 } else { ATTEN2 }) / 4) as usize] >> (ch * 2)) & 3;
        let pin = if unit == 0 {
            ADC1_GPIO.get(ch as usize)
        } else {
            ADC2_GPIO.get(ch as usize)
        }
        .copied();
        let mv = pin.map_or(0.0, |p| self.pin_mv[p]);
        let raw = self.model.convert(unit, atten, pin, mv);
        // SAR1/2_BIT_WIDTH: 9..12 bits; IDF sets DATA_INV = 1, which yields the non-inverted code
        let width = 9 + ((self.regs[(START_FORCE / 4) as usize] >> (2 * unit)) & 3);
        let raw = raw >> (12 - width);
        let inv_bit = if unit == 0 { 28 } else { 29 };
        let ctrl = self.regs[((if unit == 0 { READ_CTRL } else { READ_CTRL2 }) / 4) as usize];
        if ctrl >> inv_bit & 1 != 0 {
            raw
        } else {
            !raw & ((1 << width) - 1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oneshot_adc1_gpio38_12bit() {
        let mut a = Adc::default();
        a.model.set_ideal(true);
        a.pin_mv[38] = 1575.0; // half of the 12 dB ideal range
        a.write(ATTEN1, 3 << 4);
        a.write(START_FORCE, 3);
        a.write(READ_CTRL, 1 << 28);
        let go = 1 << 31 | 1 << (19 + 2) | 1 << 18;
        a.write(MEAS_START1, go);
        assert_eq!(a.read(MEAS_START1) >> 16 & 1, 0);
        a.write(MEAS_START1, go | 1 << 17);
        let v = a.read(MEAS_START1);
        assert_eq!(v >> 16 & 1, 1);
        assert_eq!(v & 0xffff, 2048);
        // Without DATA_INV the code comes out inverted
        a.write(READ_CTRL, 0);
        a.write(MEAS_START1, go);
        a.write(MEAS_START1, go | 1 << 17);
        assert_eq!(a.read(MEAS_START1) & 0xffff, 4095 - 2048);
    }

    #[test]
    fn touch_pads_read_back() {
        let mut a = Adc::default();
        a.touch[7] = 300;
        assert_eq!(a.read(TOUCH_CTRL2) >> 10 & 1, 1);
        // OUT4 holds pads 6 (high half) and 7 (low half)
        assert_eq!(a.read(TOUCH_OUT1 + 12), (TOUCH_IDLE as u32) << 16 | 300);
    }
}
