//! I2C0 主机控制器（I2C_EXT，0x60013000）+ 总线上的虚拟器件。
//! 寄存器见 soc/esp32c3/register/soc/i2c_reg.h / i2c_struct.h；命令格式见 hal/esp32c3/include/hal/i2c_ll.h。
//!
//! 执行模型：写 CTR.trans_start 后，按命令表 COMD0..7 立即对器件执行读写（器件看到的字节序与真机一致），
//! 但"总线忙"和完成中断推迟到按 SCL 时序算出的真实耗时之后，驱动看到的时序与真机一致。

use std::any::Any;
use std::collections::VecDeque;

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
        }
    }
}

impl I2c {
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

    fn run_commands(&mut self, now: u64) {
        self.transactions += 1;
        for d in self.devices.iter_mut() {
            d.set_time(now);
        }
        let mut bits: u64 = 0;
        let mut ints = 0u32;
        let mut nacked = false;
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
                    self.need_addr = true;
                    bits += 1;
                }
                op::WRITE => {
                    for _ in 0..n {
                        let b = self.tx.pop_front().unwrap_or(0xff);
                        bits += 9;
                        let acked = if self.need_addr {
                            self.need_addr = false;
                            let addr = b >> 1;
                            self.cur = self.devices.iter().position(|d| d.address() == addr);
                            match self.cur {
                                Some(i) => self.devices[i].start(b & 1 != 0),
                                None => false,
                            }
                        } else {
                            match self.cur {
                                Some(i) => self.devices[i].write(b),
                                None => false,
                            }
                        };
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
                        let b = match self.cur {
                            Some(i) => self.devices[i].read(),
                            None => 0xff, // 没人驱动 SDA：上拉读到全 1
                        };
                        let _ = (k, ack_val);
                        if self.rx.len() < FIFO_LEN {
                            self.rx.push_back(b);
                        } else {
                            ints |= 1 << 2; // RXFIFO_OVF
                        }
                        bits += 9;
                    }
                }
                op::STOP => {
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
        let done = now + bits.max(1) * self.bit_cycles();
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
