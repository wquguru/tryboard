//! I2C0 master (I2C_EXT, 0x60013000) + virtual devices on the bus. Registers in soc/esp32c3/register/soc/i2c_reg.h / i2c_struct.h, commands in hal/esp32c3/include/hal/i2c_ll.h.
//! On CTR.trans_start the COMD0..7 table runs against devices immediately (same byte order as hardware), but bus-busy and the done IRQ are deferred by the SCL-timed duration.

use crate::iotrace::{i2cbit, kind, IoEvent};
use std::any::Any;
use std::collections::{BTreeMap, VecDeque};
use tryboard_elec::i2cbus::{self, Verdict};

/// A slave device on the bus. `start` is called after the address byte and returns whether it ACKs.
pub trait I2cDevice: Any {
    fn address(&self) -> u8;
    fn start(&mut self, read: bool) -> bool;
    fn write(&mut self, b: u8) -> bool;
    fn read(&mut self) -> u8;
    fn stop(&mut self);
    /// Current time (CPU cycles) before a transaction, for devices that model measurement timing
    fn set_time(&mut self, _now: u64) {}
    fn as_any_mut(&mut self) -> &mut dyn Any;
}

pub const FIFO_LEN: usize = 32;

/// Controller differences: opcodes, table length, clock. C3 / S3 share one; classic ESP32 (soc/esp32 i2c_reg.h, hal/esp32 i2c_ll.h) uses RSTART 0, WRITE 1,
/// READ 2, STOP 3, END 4, a 16-entry table and SCL counts on APB 80MHz (14-bit, no CLK_CONF); other offsets/bits match, so the model is reused
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct I2cLayout {
    pub op_rstart: u32,
    pub op_write: u32,
    pub op_read: u32,
    pub op_stop: u32,
    pub op_end: u32,
    pub ncmd: usize,
    /// SCL high / low periods in APB 80MHz, 14-bit (classic ESP32); otherwise CLK_CONF source and divider, 9-bit
    pub apb_clock: bool,
}

impl I2cLayout {
    pub const C3: I2cLayout = I2cLayout {
        op_rstart: 6,
        op_write: 1,
        op_read: 3,
        op_stop: 2,
        op_end: 4,
        ncmd: 8,
        apb_clock: false,
    };
    pub const ESP32: I2cLayout = I2cLayout {
        op_rstart: 0,
        op_write: 1,
        op_read: 2,
        op_stop: 3,
        op_end: 4,
        ncmd: 16,
        apb_clock: true,
    };
}

pub mod int {
    pub const END_DETECT: u32 = 1 << 3;
    pub const BYTE_TRANS_DONE: u32 = 1 << 4;
    pub const TRANS_COMPLETE: u32 = 1 << 7;
    pub const TIME_OUT: u32 = 1 << 8;
    pub const TRANS_START: u32 = 1 << 9;
    pub const NACK: u32 = 1 << 10;
}

pub struct I2c {
    pub regs: [u32; 0x100 / 4],
    pub tx: VecDeque<u8>,
    pub rx: VecDeque<u8>,
    pub int_raw: u32,
    pub int_ena: u32,
    pub devices: Vec<Box<dyn I2cDevice>>,
    /// Index of the currently addressed device
    cur: Option<usize>,
    /// Next written byte is an address byte (after RSTART)
    need_addr: bool,
    /// Transaction in progress: completion time and interrupts to set then
    pending: Option<(u64, u32)>,
    pub transactions: u64,
    pub nacks: u64,
    /// Transaction-level events (logic analyzer): SocBus moves them into IoTrace after every register write
    pub events: Vec<IoEvent>,
    /// Between start and stop (when the table runs in batches, a later batch's RSTART is a repeated start)
    in_txn: bool,
    /// Controller bit in events (I2C1 = i2cbit::PORT1)
    pub port_bit: u16,
    /// Total external wire length (cm, estimate, P2-11); None = ideal bus (no rise time)
    pub wire_cm: Option<f64>,
    /// Bytes misread / address NACKs caused by excessive rise time (estimate)
    pub slow_bytes: u64,
    pub slow_nacks: u64,
    /// Per 7-bit address: address bytes sent and how many were ACKed (generated checkpoints judge "is it connected" per device)
    pub addr_acks: BTreeMap<u8, (u64, u64)>,
    pub layout: I2cLayout,
}

impl Default for I2c {
    fn default() -> Self {
        let mut regs = [0u32; 0x100 / 4];
        regs[0x00] = 0x100; // SCL_LOW_PERIOD
        regs[1] = 0x20b; // CTR (0x04)
        regs[0x18 / 4] = 0x408b; // FIFO_CONF
        regs[0x38 / 4] = 0x100; // SCL_HIGH_PERIOD
        regs[0x54 / 4] = 0x0020_0000; // CLK_CONF: sclk_active
        regs[0xf8 / 4] = 0x2007_0201;
        I2c {
            regs,
            tx: VecDeque::new(),
            rx: VecDeque::new(),
            int_raw: 0,
            int_ena: 0,
            devices: Vec::new(),
            cur: None,
            need_addr: false,
            pending: None,
            transactions: 0,
            nacks: 0,
            events: Vec::new(),
            in_txn: false,
            port_bit: 0,
            wire_cm: None,
            slow_bytes: 0,
            slow_nacks: 0,
            addr_acks: BTreeMap::new(),
            layout: I2cLayout::C3,
        }
    }
}

impl I2c {
    /// Second controller (S3's I2C1): events carry the PORT1 bit
    pub fn with_port(port_bit: u16) -> Self {
        I2c {
            port_bit,
            ..I2c::default()
        }
    }

    /// Explicit layout (classic ESP32 uses `I2cLayout::ESP32`)
    pub fn with_layout(layout: I2cLayout, port_bit: u16) -> Self {
        I2c {
            layout,
            port_bit,
            ..I2c::default()
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

    fn busy(&self) -> bool {
        self.pending.is_some()
    }

    /// CPU cycles per SCL bit (CPU 160MHz)
    fn bit_cycles(&self) -> u64 {
        if self.layout.apb_clock {
            let low = (self.regs[0] & 0x3fff) as u64 + 1;
            let high = (self.regs[0x38 / 4] & 0x3fff) as u64 + 1;
            // APB 80MHz = half of CPU 160MHz
            return (low + high).max(4) * 2;
        }
        let clk = self.regs[0x54 / 4];
        let div = (clk & 0xff) as u64 + 1;
        // sclk_sel: 0 = XTAL 40MHz, 1 = RC_FAST ≈ 17.5MHz
        let src_hz: u64 = if clk & (1 << 20) != 0 {
            17_500_000
        } else {
            40_000_000
        };
        let low = (self.regs[0] & 0x1ff) as u64 + 1;
        let high = (self.regs[0x38 / 4] & 0x1ff) as u64 + 1;
        let wait = ((self.regs[0x38 / 4] >> 9) & 0x7f) as u64;
        let sclk_cycles = (low + high + wait).max(4) * div;
        sclk_cycles * crate::periph::CPU_HZ / src_hz
    }

    pub fn read(&mut self, off: u32) -> u32 {
        match off {
            // SR: resp_rec, bus_busy, rxfifo_cnt[13:8], txfifo_cnt[23:18]
            0x08 => {
                let busy = if self.busy() { 1 << 4 } else { 0 };
                busy | ((self.rx.len() as u32 & 0x3f) << 8) | ((self.tx.len() as u32 & 0x3f) << 18)
            }
            0x14 => {
                // FIFO_ST: approximate read/write pointers with counts
                let rx = self.rx.len() as u32 & 0x1f;
                let tx = self.tx.len() as u32 & 0x1f;
                (rx << 5) | (tx << 15)
            }
            0x1c => self.rx.pop_front().unwrap_or(0) as u32,
            0x20 => self.int_raw,
            0x28 => self.int_ena,
            0x2c => self.int_raw & self.int_ena,
            0x80 => self.regs[0x80 / 4] & !1, // scl_rst_slv_en self-clears: bus clear completes instantly
            0x100..=0x17f => {
                let i = ((off - 0x100) / 4) as usize;
                self.tx.get(i).copied().unwrap_or(0) as u32
            }
            0x180..=0x1ff => {
                let i = ((off - 0x180) / 4) as usize;
                self.rx.get(i).copied().unwrap_or(0) as u32
            }
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    /// Register write with a pin bus's devices (M5-02) appended for this access; own devices keep their indices.
    /// The chip picks the bus from GPIO matrix routing; a stale device index from another bus is dropped.
    pub fn write_with(
        &mut self,
        off: u32,
        v: u32,
        now: u64,
        extra: Option<&mut Vec<Box<dyn I2cDevice>>>,
    ) {
        let n = self.devices.len();
        let Some(x) = extra else {
            if self.cur.is_some_and(|i| i >= n) {
                self.cur = None;
            }
            return self.write(off, v, now);
        };
        self.devices.append(x);
        if self.cur.is_some_and(|i| i >= self.devices.len()) {
            self.cur = None;
        }
        self.write(off, v, now);
        *x = self.devices.split_off(n);
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        match off {
            0x04 => {
                // fsm_rst / conf_upgate / trans_start are self-clearing
                self.regs[1] = v & !((1 << 5) | (1 << 10) | (1 << 11));
                if v & (1 << 10) != 0 {
                    self.pending = None;
                    self.cur = None;
                    self.in_txn = false;
                }
                if v & (1 << 5) != 0 && v & (1 << 4) != 0 {
                    self.run_commands(now);
                }
            }
            0x18 => {
                if v & (1 << 13) != 0 {
                    self.tx.clear();
                }
                if v & (1 << 12) != 0 {
                    self.rx.clear();
                }
                self.regs[0x18 / 4] = v & !((1 << 12) | (1 << 13));
            }
            0x1c => {
                if self.tx.len() < FIFO_LEN {
                    self.tx.push_back(v as u8);
                } else {
                    self.int_raw |= 1 << 11; // TXFIFO_OVF
                }
            }
            0x24 => self.int_raw &= !v,
            0x28 => self.int_ena = v & 0x3ffff,
            0x100..=0x17f => {
                // Non-FIFO mode writes TX RAM directly: overwrite by index
                let i = ((off - 0x100) / 4) as usize;
                while self.tx.len() <= i && self.tx.len() < FIFO_LEN {
                    self.tx.push_back(0);
                }
                if let Some(x) = self.tx.get_mut(i) {
                    *x = v as u8;
                }
            }
            _ => {
                if let Some(r) = self.regs.get_mut((off / 4) as usize) {
                    *r = v;
                }
            }
        }
    }

    /// Current SCL frequency (Hz)
    pub fn scl_hz(&self) -> f64 {
        crate::periph::CPU_HZ as f64 / self.bit_cycles() as f64
    }

    /// Bus load (P2-11): rise time, limit at this frequency, verdict; None for an ideal bus
    pub fn load(&self) -> Option<(f64, f64, Verdict)> {
        let cm = self.wire_cm?;
        let rise = i2cbus::rise_ns(cm, self.devices.len());
        let limit = i2cbus::limit_ns(self.scl_hz());
        Some((rise, limit, i2cbus::verdict(rise, limit)))
    }

    fn run_commands(&mut self, now: u64) {
        self.transactions += 1;
        for d in self.devices.iter_mut() {
            d.set_time(now);
        }
        let mut bits: u64 = 0;
        let mut ints = 0u32;
        let mut nacked = false;
        // Event time = start + SCL bits elapsed x cycles per bit (same formula as the done IRQ)
        let bc = self.bit_cycles();
        let pb = self.port_bit;
        // Wire too long: rise time over limit (estimate). Marginal loses 0->1 bits in read bytes; Fail garbles addresses so nobody ACKs
        let slow = self.load().map(|l| l.2).unwrap_or(Verdict::Ok);
        let l = self.layout;
        for idx in 0..l.ncmd {
            let reg = 0x58 / 4 + idx;
            let cmd = self.regs[reg];
            let opc = (cmd >> 11) & 7;
            let n = (cmd & 0xff) as usize;
            let ack_en = cmd & (1 << 8) != 0;
            let ack_exp = (cmd >> 9) & 1;
            let ack_val = (cmd >> 10) & 1;
            if nacked && opc != l.op_stop {
                continue;
            }
            self.regs[reg] |= 1 << 31;
            match opc {
                _ if opc == l.op_rstart => {
                    let b = pb | if self.in_txn { i2cbit::RESTART } else { 0 };
                    self.events.push(IoEvent {
                        t: now + bits * bc,
                        kind: kind::I2C_START,
                        a: 0,
                        b,
                        v: bc.min(u32::MAX as u64) as u32,
                    });
                    self.in_txn = true;
                    self.need_addr = true;
                    bits += 1;
                }
                _ if opc == l.op_write => {
                    for _ in 0..n {
                        let b = self.tx.pop_front().unwrap_or(0xff);
                        let t = now + bits * bc;
                        bits += 9;
                        let is_addr = self.need_addr;
                        let acked = if self.need_addr {
                            self.need_addr = false;
                            let addr = b >> 1;
                            self.cur = if slow == Verdict::Fail {
                                self.slow_nacks += 1;
                                None
                            } else {
                                self.devices.iter().position(|d| d.address() == addr)
                            };
                            let ok = match self.cur {
                                Some(i) => self.devices[i].start(b & 1 != 0),
                                None => false,
                            };
                            let e = self.addr_acks.entry(addr).or_insert((0, 0));
                            e.0 += 1;
                            e.1 += ok as u64;
                            ok
                        } else {
                            match self.cur {
                                Some(i) => self.devices[i].write(b),
                                None => false,
                            }
                        };
                        let nack = if acked { 0 } else { i2cbit::NACK };
                        self.events.push(if is_addr {
                            IoEvent {
                                t,
                                kind: kind::I2C_ADDR,
                                a: b >> 1,
                                b: pb | (b & 1) as u16 | nack,
                                v: 0,
                            }
                        } else {
                            IoEvent {
                                t,
                                kind: kind::I2C_DATA,
                                a: b,
                                b: pb | nack,
                                v: 0,
                            }
                        });
                        let level = if acked { 0 } else { 1 };
                        if ack_en && level != ack_exp {
                            nacked = true;
                            self.nacks += 1;
                            ints |= int::NACK;
                            break;
                        }
                    }
                }
                _ if opc == l.op_read => {
                    for k in 0..n {
                        let mut b = match self.cur {
                            Some(i) => self.devices[i].read(),
                            None => 0xff, // nobody drives SDA: pull-up reads all ones
                        };
                        if slow == Verdict::Marginal && self.cur.is_some() {
                            let c = i2cbus::corrupt_read(b);
                            self.slow_bytes += (c != b) as u64;
                            b = c;
                        }
                        // The master answers each read byte with ACK_VALUE (usually NACK on the last to tell the slave to stop)
                        let _ = k;
                        let nack = if ack_val != 0 { i2cbit::NACK } else { 0 };
                        self.events.push(IoEvent {
                            t: now + bits * bc,
                            kind: kind::I2C_DATA,
                            a: b,
                            b: pb | i2cbit::READ | nack,
                            v: 0,
                        });
                        if self.rx.len() < FIFO_LEN {
                            self.rx.push_back(b);
                        } else {
                            ints |= 1 << 2; // RXFIFO_OVF
                        }
                        bits += 9;
                    }
                }
                _ if opc == l.op_stop => {
                    self.events.push(IoEvent {
                        t: now + bits * bc,
                        kind: kind::I2C_STOP,
                        a: 0,
                        b: pb,
                        v: 0,
                    });
                    self.in_txn = false;
                    if let Some(i) = self.cur.take() {
                        self.devices[i].stop();
                    }
                    bits += 1;
                    if !nacked {
                        ints |= int::TRANS_COMPLETE;
                    }
                    break;
                }
                _ if opc == l.op_end => {
                    ints |= int::END_DETECT;
                    break;
                }
                _ => {}
            }
        }
        self.int_raw |= int::TRANS_START;
        let done = now + bits.max(1) * bc;
        self.pending = Some((done, ints));
    }

    /// Advance: set the done interrupt when the transaction is due. Returns the next event time.
    pub fn update(&mut self, now: u64) -> u64 {
        match self.pending {
            Some((t, ints)) if now >= t => {
                self.int_raw |= ints;
                self.pending = None;
                u64::MAX
            }
            Some((t, _)) => t,
            None => u64::MAX,
        }
    }

    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::bme280::Bme280;

    /// C3 opcodes (hal/esp32c3 i2c_ll.h)
    mod op {
        pub const RSTART: u32 = 6;
        pub const WRITE: u32 = 1;
        pub const READ: u32 = 3;
        pub const STOP: u32 = 2;
        pub const END: u32 = 4;
    }

    fn cmd(op: u32, n: u32, ack_en: bool, ack_val: u32) -> u32 {
        op << 11 | (ack_en as u32) << 8 | ack_val << 10 | n
    }

    /// Read the BME280 chip ID (0xD0): returns (address ACKed, byte read)
    fn read_id(b: &mut I2c) -> (bool, u8) {
        b.rx.clear();
        b.tx.clear();
        b.write(0x1c, 0x76 << 1, 0);
        b.write(0x1c, 0xd0, 0);
        b.write(0x1c, 0x76 << 1 | 1, 0);
        b.regs[0x58 / 4] = cmd(op::RSTART, 0, false, 0);
        b.regs[0x58 / 4 + 1] = cmd(op::WRITE, 2, true, 0);
        b.regs[0x58 / 4 + 2] = cmd(op::RSTART, 0, false, 0);
        b.regs[0x58 / 4 + 3] = cmd(op::WRITE, 1, true, 0);
        b.regs[0x58 / 4 + 4] = cmd(op::READ, 1, false, 1);
        b.regs[0x58 / 4 + 5] = cmd(op::STOP, 0, false, 0);
        let n0 = b.nacks;
        b.write(0x04, 1 << 5 | 1 << 4, 0);
        (b.nacks == n0, b.rx.pop_front().unwrap_or(0))
    }

    /// P2-11: longer wires, longer rise time. Two modules at 400 kHz: 20 cm OK, 60 cm misreads (0x60 -> 0x20), 150 cm no ACK
    #[test]
    fn long_wire_corrupts_then_nacks() {
        let mut b = I2c::default();
        b.attach(Box::new(Bme280::new(0x76)));
        b.attach(Box::new(crate::devices::ssd1306::Ssd1306::new(0x3c)));
        // 400 kHz: 40 MHz / (50 + 50)
        b.regs[0] = 49;
        b.regs[0x38 / 4] = 49;
        assert!((b.scl_hz() - 400_000.0).abs() < 1.0);
        assert_eq!(read_id(&mut b), (true, 0x60));
        b.wire_cm = Some(20.0);
        assert_eq!(read_id(&mut b), (true, 0x60));
        b.wire_cm = Some(60.0);
        assert_eq!(b.load().unwrap().2, Verdict::Marginal);
        assert_eq!(read_id(&mut b), (true, 0x20));
        assert_eq!(b.slow_bytes, 1);
        b.wire_cm = Some(150.0);
        assert!(!read_id(&mut b).0);
        assert_eq!(b.slow_nacks, 1);
        // Down to 100 kHz: the same 150 cm is within standard mode's 1000 ns
        b.regs[0] = 199;
        b.regs[0x38 / 4] = 199;
        assert_eq!(read_id(&mut b), (true, 0x60));
    }

    /// Read 8 bytes from BME280 0xF7 in two command batches (second starts with RSTART = repeated start); events match the real bus
    #[test]
    fn events_burst_read_with_restart() {
        let mut b = I2c::default();
        b.attach(Box::new(Bme280::new(0x76)));
        // Batch 1: START 0x76 W · 0xF7 · END
        b.write(0x1c, 0x76 << 1, 0);
        b.write(0x1c, 0xf7, 0);
        b.regs[0x58 / 4] = cmd(op::RSTART, 0, false, 0);
        b.regs[0x58 / 4 + 1] = cmd(op::WRITE, 2, true, 0);
        b.regs[0x58 / 4 + 2] = cmd(op::END, 0, false, 0);
        b.write(0x04, 1 << 5 | 1 << 4, 0);
        // Batch 2: RESTART 0x76 R · 7 bytes ACK · 1 byte NACK · STOP
        b.write(0x1c, 0x76 << 1 | 1, 100_000);
        b.regs[0x58 / 4] = cmd(op::RSTART, 0, false, 0);
        b.regs[0x58 / 4 + 1] = cmd(op::WRITE, 1, true, 0);
        b.regs[0x58 / 4 + 2] = cmd(op::READ, 7, false, 0);
        b.regs[0x58 / 4 + 3] = cmd(op::READ, 1, false, 1);
        b.regs[0x58 / 4 + 4] = cmd(op::STOP, 0, false, 0);
        b.write(0x04, 1 << 5 | 1 << 4, 100_000);
        let kinds: Vec<String> = b
            .events
            .iter()
            .map(|e| e.line().split_once(' ').unwrap().1.to_string())
            .collect();
        let bc = b.events[0].v as u64;
        let (st, rst) = (format!("I2C0 START {bc}"), format!("I2C0 RESTART {bc}"));
        assert_eq!(
            &kinds[..4],
            [
                st.as_str(),
                "I2C0 ADDR 76 W ACK",
                "I2C0 DATA f7 W ACK",
                rst.as_str()
            ]
        );
        assert_eq!(kinds[4], "I2C0 ADDR 76 R ACK");
        assert_eq!(kinds.iter().filter(|k| k.contains(" R ")).count(), 9);
        assert!(kinds[12].ends_with("R NACK"));
        assert_eq!(kinds[13], "I2C0 STOP");
        // Times by SCL bits: 1 bit for start, 9 bits per byte
        assert_eq!(b.events[1].t, bc);
        assert_eq!(b.events[2].t, 10 * bc);
        assert_eq!(b.events[4].t, 100_000 + bc);
    }
}
