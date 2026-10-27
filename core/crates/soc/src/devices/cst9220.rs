//! CST9220 capacitive touch (I2C 0x5A, Waveshare ESP32-S3-Touch-AMOLED-2.16). 16-bit big-endian register addresses. Behaviour checked against the
//! public drivers (SensorLib TouchDrvCST92xx, MIT; espressif esp_lcd_touch_cst9220, Apache-2.0): 0xD000 report = per point 5 bytes
//! [id<<4 | event (6 = pressed), x>>4, y>>4, (x&15)<<4 | (y&15), z], then byte 5 = touch count (bits 6..0), byte 6 = 0xAB valid marker; point 2 starts
//! at byte 7. The host writes 0xAB to 0xD000 to ack, which clears the marker until the next scan. 0xD101 = command mode (touch reports stop),
//! 0xD109 = normal mode; in command mode 0xD1FC check code (0xCACA....), 0xD1F8 resolution, 0xD204 project ID + chip type 0x9220 (LE), 0xD208 fw.
//! One finger only; INT (driven by Machine) low while pressed. Not modelled: TP_RST, sleep, gestures / cover button, scan noise. (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use std::any::Any;

pub const CHIP_TYPE: u16 = 0x9220;
pub const ACK: u8 = 0xAB;
/// Report bytes for the 2 points the drivers read (MAX_FINGER_NUM * 5 + 5)
const REPORT_LEN: usize = 15;

pub struct Cst9220 {
    pub addr: u8,
    pub width: u16,
    pub height: u16,
    reg: u16,
    /// Address bytes still expected in the current write (2 after a write START)
    addr_left: u8,
    command_mode: bool,
    touch: Option<(u16, u16)>,
    report: [u8; REPORT_LEN],
    /// Unacked report waiting (finger moved / lifted since the last ack)
    pending: bool,
    /// Finger changed after the host last read 0xD000: an ack then covers an older report and must keep `pending`
    changed: bool,
    pub presses: u64,
    pub acks: u64,
}

impl Cst9220 {
    pub fn new(addr: u8) -> Self {
        Cst9220 {
            addr,
            width: 480,
            height: 480,
            reg: 0,
            addr_left: 0,
            command_mode: false,
            touch: None,
            report: [0; REPORT_LEN],
            pending: false,
            changed: false,
            presses: 0,
            acks: 0,
        }
    }

    pub fn touching(&self) -> bool {
        self.touch.is_some()
    }

    /// Finger down / move (clamped to the panel)
    pub fn press(&mut self, x: u16, y: u16) {
        let (x, y) = (x.min(self.width - 1), y.min(self.height - 1));
        if self.touch.is_none() {
            self.presses += 1;
        }
        self.touch = Some((x, y));
        self.pending = true;
        self.changed = true;
    }

    /// Finger up: one more report with 0 points (event 0), then nothing until the next press
    pub fn release(&mut self) {
        if self.touch.take().is_some() {
            self.pending = true;
            self.changed = true;
        }
    }

    /// Build the report the chip exposes at 0xD000 right now
    fn build_report(&mut self) {
        self.report = [0; REPORT_LEN];
        self.changed = false;
        // Command mode stops scanning; an acked report reads back as stale (no marker)
        if self.command_mode || !(self.pending || self.touch.is_some()) {
            return;
        }
        if let Some((x, y)) = self.touch {
            self.report[0] = 0x06; // ID 0, event pressed
            self.report[1] = (x >> 4) as u8;
            self.report[2] = (y >> 4) as u8;
            self.report[3] = ((x & 15) << 4 | (y & 15)) as u8;
            // Pressure kept below 0x10: drivers treat a set high nibble as the cover-screen button
            self.report[4] = 0x08;
            self.report[5] = 1;
        }
        self.report[6] = ACK;
    }

    /// 32-bit little-endian info words readable in command mode
    fn info(&self, reg: u16) -> Option<[u8; 4]> {
        let le = |v: u32| v.to_le_bytes();
        Some(match reg {
            0xD1FC => le(0xCACA_0000 | 0x0001),
            0xD1F8 => le((self.height as u32) << 16 | self.width as u32),
            0xD204 => le((CHIP_TYPE as u32) << 16 | 0x0001),
            0xD208 => le(0x0001_0203),
            0xD20C => le(0x1234_5678),
            _ => return None,
        })
    }

    fn read_at(&self, reg: u16) -> u8 {
        if (0xD000..0xD000 + REPORT_LEN as u16).contains(&reg) {
            return self.report[(reg - 0xD000) as usize];
        }
        if self.command_mode {
            let base = reg & !3;
            if let Some(w) = self.info(base) {
                return w[(reg & 3) as usize];
            }
        }
        0
    }
}

impl I2cDevice for Cst9220 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn start(&mut self, read: bool) -> bool {
        if read {
            if self.reg == 0xD000 {
                self.build_report();
            }
            self.addr_left = 0;
        } else {
            self.addr_left = 2;
        }
        true
    }
    fn write(&mut self, b: u8) -> bool {
        match self.addr_left {
            2 => {
                self.reg = (b as u16) << 8;
                self.addr_left = 1;
            }
            1 => {
                self.reg |= b as u16;
                self.addr_left = 0;
                match self.reg {
                    0xD101 => self.command_mode = true,
                    0xD109 => self.command_mode = false,
                    _ => {}
                }
            }
            _ => {
                // Report ack: the host consumed this scan's data
                // A lift landing between the read and this ack is a newer scan: keep it pending, or TOUCH UP is lost (H-26)
                if self.reg == 0xD000 && b == ACK {
                    self.pending &= self.changed;
                    self.acks += 1;
                }
                self.reg = self.reg.wrapping_add(1);
            }
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.read_at(self.reg);
        self.reg = self.reg.wrapping_add(1);
        v
    }
    fn stop(&mut self) {}
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rd(d: &mut Cst9220, reg: u16, n: usize) -> Vec<u8> {
        d.start(false);
        d.write((reg >> 8) as u8);
        d.write(reg as u8);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    fn wr(d: &mut Cst9220, bytes: &[u8]) {
        d.start(false);
        for b in bytes {
            d.write(*b);
        }
        d.stop();
    }

    fn xy(r: &[u8]) -> (u16, u16) {
        (
            (r[1] as u16) << 4 | (r[3] >> 4) as u16,
            (r[2] as u16) << 4 | (r[3] & 15) as u16,
        )
    }

    #[test]
    fn chip_info_in_command_mode() {
        let mut d = Cst9220::new(0x5a);
        // Normal mode: info words read as 0
        assert_eq!(rd(&mut d, 0xD204, 4), [0, 0, 0, 0]);
        wr(&mut d, &[0xD1, 0x01]);
        let c = rd(&mut d, 0xD1FC, 4);
        assert_eq!((c[3], c[2]), (0xCA, 0xCA));
        let t = rd(&mut d, 0xD204, 4);
        assert_eq!((t[3] as u16) << 8 | t[2] as u16, CHIP_TYPE);
        let r = rd(&mut d, 0xD1F8, 4);
        assert_eq!(((r[1] as u16) << 8 | r[0] as u16), 480);
        // Command mode: no touch reports
        d.press(10, 20);
        assert_eq!(rd(&mut d, 0xD000, 7)[6], 0);
        wr(&mut d, &[0xD1, 0x09]);
        assert_eq!(rd(&mut d, 0xD000, 7)[6], ACK);
    }

    #[test]
    fn report_ack_and_release() {
        let mut d = Cst9220::new(0x5a);
        assert_eq!(rd(&mut d, 0xD000, 15), [0; 15]);
        d.press(300, 450);
        let r = rd(&mut d, 0xD000, 15);
        assert_eq!((r[0], r[5] & 0x7f, r[6]), (0x06, 1, ACK));
        assert_eq!(xy(&r), (300, 450));
        assert!(r[4] < 0x10);
        wr(&mut d, &[0xD0, 0x00, ACK]);
        // Still pressed: the chip keeps scanning, a fresh report follows
        assert_eq!(rd(&mut d, 0xD000, 7)[6], ACK);
        d.press(479, 3);
        assert_eq!(xy(&rd(&mut d, 0xD000, 7)), (479, 3));
        wr(&mut d, &[0xD0, 0x00, ACK]);
        d.release();
        let r = rd(&mut d, 0xD000, 7);
        assert_eq!((r[0], r[5], r[6]), (0, 0, ACK));
        wr(&mut d, &[0xD0, 0x00, ACK]);
        // After the release report is acked: stale, no marker
        assert_eq!(rd(&mut d, 0xD000, 7)[6], 0);
        assert_eq!((d.presses, d.acks), (1, 3));
        // Lift between the read and its ack (web inputs land on 1 ms slice edges): the release report survives the ack
        d.press(100, 100);
        assert_eq!(rd(&mut d, 0xD000, 7)[5], 1);
        d.release();
        wr(&mut d, &[0xD0, 0x00, ACK]);
        let r = rd(&mut d, 0xD000, 7);
        assert_eq!((r[5], r[6]), (0, ACK));
        wr(&mut d, &[0xD0, 0x00, ACK]);
        assert_eq!(rd(&mut d, 0xD000, 7)[6], 0);
        // Clamped to the 480x480 panel
        d.press(900, 900);
        assert_eq!(xy(&rd(&mut d, 0xD000, 7)), (479, 479));
    }
}
