//! I2C0 主机控制器（I2C_EXT，0x60013000）+ 总线上的虚拟器件。
//! 寄存器见 soc/esp32c3/register/soc/i2c_reg.h / i2c_struct.h；命令格式见 hal/esp32c3/include/hal/i2c_ll.h。
//!
//! 执行模型：写 CTR.trans_start 后，按命令表 COMD0..7 立即对器件执行读写（器件看到的字节序与真机一致），
//! 但"总线忙"和完成中断推迟到按 SCL 时序算出的真实耗时之后，驱动看到的时序与真机一致。

use crate::iotrace::{i2cbit, kind, IoEvent};
use std::any::Any;
use std::collections::{BTreeMap, VecDeque};
use tryboard_elec::i2cbus::{self, Verdict};

/// 总线上的从机器件。`start` 在地址字节之后调用，返回是否应答。
pub trait I2cDevice: Any {
    fn address(&self) -> u8;
    fn start(&mut self, read: bool) -> bool;
    fn write(&mut self, b: u8) -> bool;
    fn read(&mut self) -> u8;
    fn stop(&mut self);
    /// 事务开始前告知当前时间（CPU 周期），有测量时序的器件用
    fn set_time(&mut self, _now: u64) {}
    fn as_any_mut(&mut self) -> &mut dyn Any;
}

pub const FIFO_LEN: usize = 32;

mod op {
    pub const RSTART: u32 = 6;
    pub const WRITE: u32 = 1;
    pub const READ: u32 = 3;
    pub const STOP: u32 = 2;
    pub const END: u32 = 4;
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
    /// 当前被寻址的器件下标
    cur: Option<usize>,
    /// 下一个写入的字节是地址字节（RSTART 之后）
    need_addr: bool,
    /// 进行中的事务：完成时刻与届时要置位的中断
    pending: Option<(u64, u32)>,
    pub transactions: u64,
    pub nacks: u64,
    /// 事务层事件（逻辑分析仪）：SocBus 每次写寄存器后搬进 IoTrace
    pub events: Vec<IoEvent>,
    /// 起始之后、停止之前（命令表分几批执行时，后一批的 RSTART 是重复起始）
    in_txn: bool,
    /// 事件里的控制器编号位（I2C1 = i2cbit::PORT1）
    pub port_bit: u16,
    /// 外接线总长（cm，估算，P2-11）；None = 理想总线（不算上升时间）
    pub wire_cm: Option<f64>,
    /// 因上升时间超标读错的字节数 / 地址不应答次数（估算）
    pub slow_bytes: u64,
    pub slow_nacks: u64,
    /// 每个 7 位地址：发过几次地址字节、其中几次有人应答（生成检查点按器件判"接上了没有"）
    pub addr_acks: BTreeMap<u8, (u64, u64)>,
}

impl Default for I2c {
    fn default() -> Self {
        let mut regs = [0u32; 0x100 / 4];
        regs[0x00] = 0x100; // SCL_LOW_PERIOD
        regs[1] = 0x20b; // CTR（0x04）
        regs[0x18 / 4] = 0x408b; // FIFO_CONF
        regs[0x38 / 4] = 0x100; // SCL_HIGH_PERIOD
        regs[0x54 / 4] = 0x0020_0000; // CLK_CONF：sclk_active
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
        }
    }
}

impl I2c {
    /// 第二个控制器（S3 的 I2C1）：事件里带 PORT1 位
    pub fn with_port(port_bit: u16) -> Self {
        I2c {
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

    /// 一个 SCL 位周期折合多少 CPU 周期（CPU 160MHz）
    fn bit_cycles(&self) -> u64 {
        let clk = self.regs[0x54 / 4];
        let div = (clk & 0xff) as u64 + 1;
        // sclk_sel：0 = XTAL 40MHz，1 = RC_FAST ≈ 17.5MHz
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
            // SR：resp_rec、bus_busy、rxfifo_cnt[13:8]、txfifo_cnt[23:18]
            0x08 => {
                let busy = if self.busy() { 1 << 4 } else { 0 };
                busy | ((self.rx.len() as u32 & 0x3f) << 8) | ((self.tx.len() as u32 & 0x3f) << 18)
            }
            0x14 => {
                // FIFO_ST：用计数近似读写指针
                let rx = self.rx.len() as u32 & 0x1f;
                let tx = self.tx.len() as u32 & 0x1f;
                (rx << 5) | (tx << 15)
            }
            0x1c => self.rx.pop_front().unwrap_or(0) as u32,
            0x20 => self.int_raw,
            0x28 => self.int_ena,
            0x2c => self.int_raw & self.int_ena,
            0x80 => self.regs[0x80 / 4] & !1, // scl_rst_slv_en 自清：清总线瞬间完成
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

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        match off {
            0x04 => {
                // fsm_rst / conf_upgate / trans_start 都是自清位
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
                // 非 FIFO 方式直接写 TX RAM：按下标覆盖
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

    /// 当前 SCL 频率（Hz）
    pub fn scl_hz(&self) -> f64 {
        crate::periph::CPU_HZ as f64 / self.bit_cycles() as f64
    }

    /// 总线负载（P2-11）：上升时间、这个频率下的上限、结论；理想总线返回 None
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
        // 事件时刻 = 开始时刻 + 已经过去的 SCL 位数 × 每位周期（与完成中断的时刻同一套算法）
        let bc = self.bit_cycles();
        let pb = self.port_bit;
        // 线太长：上升时间超标（估算）。Marginal 读回的字节丢 0→1 的位；Fail 地址都传不对、没人应答
        let slow = self.load().map(|l| l.2).unwrap_or(Verdict::Ok);
        for idx in 0..8 {
            let reg = 0x58 / 4 + idx;
            let cmd = self.regs[reg];
            let opc = (cmd >> 11) & 7;
            let n = (cmd & 0xff) as usize;
            let ack_en = cmd & (1 << 8) != 0;
            let ack_exp = (cmd >> 9) & 1;
            let ack_val = (cmd >> 10) & 1;
            if nacked && opc != op::STOP {
                continue;
            }
            self.regs[reg] |= 1 << 31;
            match opc {
                op::RSTART => {
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
                op::WRITE => {
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
                op::READ => {
                    for k in 0..n {
                        let mut b = match self.cur {
                            Some(i) => self.devices[i].read(),
                            None => 0xff, // 没人驱动 SDA：上拉读到全 1
                        };
                        if slow == Verdict::Marginal && self.cur.is_some() {
                            let c = i2cbus::corrupt_read(b);
                            self.slow_bytes += (c != b) as u64;
                            b = c;
                        }
                        // 主机在每个读字节后回 ACK_VALUE（最后一个字节通常是 NACK，告诉从机不要了）
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
                op::STOP => {
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
                op::END => {
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

    /// 推进：事务到点就置位完成中断。返回下一个事件时刻。
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

    fn cmd(op: u32, n: u32, ack_en: bool, ack_val: u32) -> u32 {
        op << 11 | (ack_en as u32) << 8 | ack_val << 10 | n
    }

    /// 读 BME280 芯片 ID（0xD0）：返回 (地址是否应答, 读到的字节)
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

    /// P2-11：线越长上升时间越长。400 kHz 下 2 个模块：20 cm 正常、60 cm 读错（0x60 → 0x20）、150 cm 不应答
    #[test]
    fn long_wire_corrupts_then_nacks() {
        let mut b = I2c::default();
        b.attach(Box::new(Bme280::new(0x76)));
        b.attach(Box::new(crate::devices::ssd1306::Ssd1306::new(0x3c)));
        // 400 kHz：40 MHz / (50 + 50)
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
        // 降到 100 kHz：同样 150 cm 在标准模式的 1000 ns 以内
        b.regs[0] = 199;
        b.regs[0x38 / 4] = 199;
        assert_eq!(read_id(&mut b), (true, 0x60));
    }

    /// 读 BME280 的 0xF7 起 8 字节，分两批命令（第二批以 RSTART 开头 = 重复起始），事件序列与真机总线上一致
    #[test]
    fn events_burst_read_with_restart() {
        let mut b = I2c::default();
        b.attach(Box::new(Bme280::new(0x76)));
        // 第一批：START 0x76 W · 0xF7 · END
        b.write(0x1c, 0x76 << 1, 0);
        b.write(0x1c, 0xf7, 0);
        b.regs[0x58 / 4] = cmd(op::RSTART, 0, false, 0);
        b.regs[0x58 / 4 + 1] = cmd(op::WRITE, 2, true, 0);
        b.regs[0x58 / 4 + 2] = cmd(op::END, 0, false, 0);
        b.write(0x04, 1 << 5 | 1 << 4, 0);
        // 第二批：RESTART 0x76 R · 7 字节 ACK · 1 字节 NACK · STOP
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
        // 时刻按 SCL 位：起始 1 位、每字节 9 位
        assert_eq!(b.events[1].t, bc);
        assert_eq!(b.events[2].t, 10 * bc);
        assert_eq!(b.events[4].t, 100_000 + bc);
    }
}
