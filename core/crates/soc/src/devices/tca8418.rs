//! TCA8418 keypad scanner (I2C 0x34; M5 Cardputer-Adv keyboard), per the TI TCA8418 datasheet: 0x01 CFG (bit7 AI auto-increment,
//! bit5 OVR_FLOW_M, bit0 KE_IEN), 0x02 INT_STAT (bit0 K_INT, bit3 OVR_FLOW; write 1 to clear), 0x03 KEY_LCK_EC (bits 3:0 event count),
//! 0x04..0x0D KEY_EVENT_A..J (reading A pops the 10-deep FIFO: bit7 press, bits 6:0 key = row * 10 + col + 1, 0 when empty),
//! 0x1D..0x1F KP_GPIO1..3 (rows 0..7, cols 0..7, cols 8..9 enabled for the matrix), the rest storage. Keys outside the enabled matrix
//! give no event. Full FIFO: drop the new event (OVR_FLOW_M = 0) or the oldest (1). `int_active` gives the INT pin (active low on the
//! chip). Not done: GPI events, key lock, debounce timing. Behaviour from the datasheet; M5's driver not yet checked. (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use std::any::Any;
use std::collections::VecDeque;

const FIFO: usize = 10;

pub struct Tca8418 {
    pub addr: u8,
    regs: [u8; 0x30],
    ptr: u8,
    expect_reg: bool,
    fifo: VecDeque<u8>,
    pub events: u64,
}

impl Tca8418 {
    pub fn new(addr: u8) -> Self {
        Tca8418 {
            addr,
            regs: [0; 0x30],
            ptr: 0,
            expect_reg: false,
            fifo: VecDeque::new(),
            events: 0,
        }
    }

    fn in_matrix(&self, row: u8, col: u8) -> bool {
        let col_bit = if col < 8 {
            self.regs[0x1e] & (1 << col)
        } else {
            self.regs[0x1f] & (1 << (col - 8))
        };
        row < 8 && col < 10 && self.regs[0x1d] & (1 << row) != 0 && col_bit != 0
    }

    fn push(&mut self, row: u8, col: u8, press: bool) {
        if !self.in_matrix(row, col) {
            return;
        }
        let ev = (press as u8) << 7 | (row * 10 + col + 1);
        if self.fifo.len() == FIFO {
            self.regs[0x02] |= 0x08;
            if self.regs[0x01] & 0x20 == 0 {
                return;
            }
            self.fifo.pop_front();
        }
        self.fifo.push_back(ev);
        self.events += 1;
        self.regs[0x02] |= 0x01;
    }

    /// Key at (row, col) pressed
    pub fn press(&mut self, row: u8, col: u8) {
        self.push(row, col, true);
    }

    /// Key at (row, col) released
    pub fn release(&mut self, row: u8, col: u8) {
        self.push(row, col, false);
    }

    /// INT pin asserted: K_INT with KE_IEN, or overflow with OVR_FLOW_IEN (CFG bit4)
    pub fn int_active(&self) -> bool {
        let (cfg, st) = (self.regs[0x01], self.regs[0x02]);
        (st & 0x01 != 0 && cfg & 0x01 != 0) || (st & 0x08 != 0 && cfg & 0x10 != 0)
    }

    fn read_reg(&mut self, r: u8) -> u8 {
        match r {
            0x03 => (self.regs[0x03] & 0xf0) | self.fifo.len() as u8,
            0x04 => self.fifo.pop_front().unwrap_or(0),
            0x05..=0x0d => self.fifo.get((r - 0x04) as usize).copied().unwrap_or(0),
            _ => self.regs[r as usize],
        }
    }

    fn write_reg(&mut self, r: u8, v: u8) {
        match r {
            0x02 => self.regs[0x02] &= !(v & 0x1f),
            0x03..=0x0d => {}
            _ => self.regs[r as usize] = v,
        }
    }

    fn next(&self, r: u8) -> u8 {
        // Without AI the pointer stays put; FIFO pops always stay on KEY_EVENT_A
        if self.regs[0x01] & 0x80 == 0 || r == 0x04 {
            r
        } else {
            (r + 1) % 0x30
        }
    }
}

impl I2cDevice for Tca8418 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b % 0x30;
            self.expect_reg = false;
        } else {
            self.write_reg(self.ptr, b);
            self.ptr = self.next(self.ptr);
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.read_reg(self.ptr);
        self.ptr = self.next(self.ptr);
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

    fn wr(d: &mut Tca8418, reg: u8, data: &[u8]) {
        d.start(false);
        d.write(reg);
        for b in data {
            d.write(*b);
        }
        d.stop();
    }

    fn rd(d: &mut Tca8418, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    #[test]
    fn matrix_fifo_and_int() {
        let mut d = Tca8418::new(0x34);
        // Matrix 7 rows x 8 cols, key events interrupt, auto-increment
        wr(&mut d, 0x1d, &[0x7f]);
        wr(&mut d, 0x1e, &[0xff]);
        wr(&mut d, 0x01, &[0x81]);
        assert_eq!(rd(&mut d, 0x1d, 3), [0x7f, 0xff, 0x00]);
        assert!(!d.int_active());
        d.press(2, 3);
        d.release(2, 3);
        d.press(7, 0); // row 7 not in the matrix
        d.press(0, 9); // col 9 not in the matrix
        assert!(d.int_active());
        assert_eq!(rd(&mut d, 0x03, 1), [2]);
        assert_eq!(rd(&mut d, 0x04, 3), [0x80 | 24, 24, 0]);
        wr(&mut d, 0x02, &[0x01]);
        assert!(!d.int_active());
        // Overflow keeps the first 10 events unless OVR_FLOW_M is set
        for c in 0..8 {
            d.press(0, c);
            d.release(0, c);
        }
        assert_eq!(rd(&mut d, 0x03, 1), [10]);
        assert_eq!(rd(&mut d, 0x02, 1)[0] & 0x08, 0x08);
        assert_eq!(rd(&mut d, 0x04, 1), [0x81]);
    }
}
