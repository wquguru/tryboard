//! USB-Serial-JTAG (USJ) serial endpoint, register layout from IDF `soc/usb_serial_jtag_reg.h` (same on C3 / S3).
//! A virtual host is attached by default: it drains the IN FIFO on WR_DONE, sends SOF every 1 ms frame
//! and feeds typed bytes into the OUT FIFO. The JTAG endpoint is not modelled.

use std::collections::VecDeque;

use crate::periph::CPU_HZ;

pub const INT_JTAG_IN_FLUSH: u32 = 1 << 0;
pub const INT_SOF: u32 = 1 << 1;
pub const INT_SERIAL_OUT_RECV_PKT: u32 = 1 << 2;
pub const INT_SERIAL_IN_EMPTY: u32 = 1 << 3;
const INT_MASK: u32 = 0xfff;
/// Full-speed frame: 1 ms in CPU cycles
const FRAME: u64 = CPU_HZ / 1000;
const FIFO: usize = 64;

pub struct Usj {
    /// A host is on the USB cable: SOF ticks, IN data is drained
    pub connected: bool,
    in_fifo: Vec<u8>,
    out_fifo: VecDeque<u8>,
    int_raw: u32,
    pub int_ena: u32,
    /// Frame number at the last SOF clear; SOF raw re-asserts once a new frame starts
    sof_frame: u64,
    conf0: u32,
    misc_conf: u32,
    mem_conf: u32,
    /// Bytes the host received (flushed by WR_DONE), taken by the chip's console router
    pub flushed: Vec<u8>,
}

impl Default for Usj {
    fn default() -> Self {
        Usj {
            connected: true,
            in_fifo: Vec::new(),
            out_fifo: VecDeque::new(),
            int_raw: INT_SERIAL_IN_EMPTY,
            int_ena: 0,
            sof_frame: 0,
            // Reset values from usb_serial_jtag_reg.h: USB pad enabled, D+ pull-up on
            conf0: 0x4200,
            misc_conf: 0,
            mem_conf: 0x2,
            flushed: Vec::new(),
        }
    }
}

impl Usj {
    fn frame(now: u64) -> u64 {
        now / FRAME
    }

    fn raw(&self, now: u64) -> u32 {
        let mut r = self.int_raw;
        if self.connected && Self::frame(now) != self.sof_frame {
            r |= INT_SOF;
        }
        r
    }

    pub fn irq(&self, now: u64) -> bool {
        self.raw(now) & self.int_ena != 0
    }

    /// Next cycle at which the interrupt line may change by itself (only the SOF tick does)
    pub fn next_event(&self, now: u64) -> u64 {
        if self.connected && self.int_ena & INT_SOF != 0 {
            (Self::frame(now) + 1) * FRAME
        } else {
            u64::MAX
        }
    }

    /// Bytes the host typed into the virtual serial port
    pub fn push_rx(&mut self, data: &[u8]) {
        if !self.connected || data.is_empty() {
            return;
        }
        self.out_fifo.extend(data.iter().copied());
        self.int_raw |= INT_SERIAL_OUT_RECV_PKT;
    }

    pub fn read(&mut self, off: u32, now: u64) -> Option<u32> {
        let out_cnt = self.out_fifo.len().min(FIFO) as u32;
        Some(match off {
            0x00 => self.out_fifo.pop_front().map_or(0, u32::from),
            0x04 => {
                let free = self.in_fifo.len() < FIFO;
                ((free as u32) << 1) | ((!self.out_fifo.is_empty() as u32) << 2)
            }
            0x08 => self.raw(now),
            0x0c => self.raw(now) & self.int_ena,
            0x10 => self.int_ena,
            0x14 => 0,
            0x18 => self.conf0,
            // JFIFO_ST: JTAG FIFOs are always empty
            0x20 => (1 << 2) | (1 << 6),
            0x24 => {
                if self.connected {
                    (Self::frame(now) & 0x7ff) as u32
                } else {
                    0
                }
            }
            0x2c => (self.in_fifo.len() as u32) << 2,
            0x3c => out_cnt << 16,
            0x44 => self.misc_conf,
            0x48 => self.mem_conf,
            // DATE (usb_serial_jtag_reg.h reset value)
            0x80 => 0x0210_1200,
            _ => return None,
        })
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) -> bool {
        match off {
            0x00 => {
                if self.in_fifo.len() < FIFO {
                    self.in_fifo.push(v as u8);
                }
                // A full 64-byte packet goes out without WR_DONE (only short packets need the flush)
                if self.in_fifo.len() == FIFO {
                    self.wr_done();
                }
            }
            0x04 => {
                if v & 1 != 0 {
                    self.wr_done();
                }
            }
            0x10 => self.int_ena = v & INT_MASK,
            0x14 => {
                if v & INT_SOF != 0 {
                    self.sof_frame = Self::frame(now);
                }
                self.int_raw &= !(v & INT_MASK);
                // Unread OUT data keeps the packet interrupt pending (ISRs read at most 64 bytes per pass)
                if !self.out_fifo.is_empty() {
                    self.int_raw |= INT_SERIAL_OUT_RECV_PKT;
                }
            }
            0x18 => self.conf0 = v,
            0x44 => self.misc_conf = v,
            0x48 => self.mem_conf = v,
            _ => return false,
        }
        true
    }

    /// WR_DONE: the attached host picks the packet up at once; without a host the FIFO stays full
    fn wr_done(&mut self) {
        if !self.connected {
            return;
        }
        self.flushed.append(&mut self.in_fifo);
        self.int_raw |= INT_SERIAL_IN_EMPTY;
    }

    /// Plug / unplug the virtual host cable
    pub fn set_connected(&mut self, on: bool, now: u64) {
        self.connected = on;
        self.sof_frame = Self::frame(now);
        if on {
            self.wr_done();
        } else {
            self.out_fifo.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tx_flush_rx_and_sof() {
        let mut u = Usj::default();
        u.write(0x10, INT_SERIAL_IN_EMPTY | INT_SERIAL_OUT_RECV_PKT, 0);
        u.write(0x14, INT_SERIAL_IN_EMPTY, 0);
        assert!(!u.irq(0));
        for b in b"hi\n" {
            u.write(0, *b as u32, 0);
        }
        assert!(u.flushed.is_empty());
        u.write(0x04, 1, 0);
        assert_eq!(u.flushed, b"hi\n");
        assert!(u.irq(0));
        // RX: data available until drained, interrupt re-raised while bytes remain
        u.push_rx(b"ab");
        assert_eq!(u.read(0x04, 0).unwrap() & 4, 4);
        u.write(0x14, INT_SERIAL_OUT_RECV_PKT, 0);
        assert_ne!(u.read(0x08, 0).unwrap() & INT_SERIAL_OUT_RECV_PKT, 0);
        assert_eq!(u.read(0, 0), Some(b'a' as u32));
        assert_eq!(u.read(0, 0), Some(b'b' as u32));
        u.write(0x14, INT_SERIAL_OUT_RECV_PKT, 0);
        assert_eq!(u.read(0x08, 0).unwrap() & INT_SERIAL_OUT_RECV_PKT, 0);
        // SOF: cleared, then raised again in the next frame
        u.write(0x14, INT_SOF, 10);
        assert_eq!(u.read(0x08, 10).unwrap() & INT_SOF, 0);
        assert_ne!(u.read(0x08, FRAME + 10).unwrap() & INT_SOF, 0);
        u.set_connected(false, FRAME * 3);
        assert_eq!(u.read(0x08, FRAME * 9).unwrap() & INT_SOF, 0);
    }
}
