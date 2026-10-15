//! Synopsys DWC2 USB OTG 控制器（ESP32-S3 的 USB_OTG，基址 0x60080000），只做设备模式。
//! 两种数据通路都支持：Slave（固件读写 FIFO 窗口）与 Buffer DMA（控制器按 DxEPDMAn 直接读写内存）。
//! esp_tinyusb 默认用 DMA（CONFIG_TINYUSB_MODE_DMA），TinyUSB 原版默认 Slave。
//!
//! 寄存器偏移 / 位定义按 DWC2 编程模型（公开资料与 TinyUSB 的 dwc2_type.h，MIT）。
//! 线上的事务不逐位模拟：虚拟主机以"一次 SETUP / IN / OUT 令牌"为单位调用本模型。

use std::collections::VecDeque;

pub const BASE: u32 = 0x6008_0000;
/// 寄存器 0x000..0xFFF + 16 个 4KB 的 FIFO 窗口
pub const SIZE: u32 = 0x1_1000;
pub const EP_COUNT: usize = 7;

// GINTSTS 位
const GINT_OTGINT: u32 = 1 << 2;
const GINT_SOF: u32 = 1 << 3;
const GINT_RXFLVL: u32 = 1 << 4;
const GINT_BOUTNAKEFF: u32 = 1 << 7;
const GINT_USBRST: u32 = 1 << 12;
const GINT_ENUMDNE: u32 = 1 << 13;
const GINT_IEPINT: u32 = 1 << 18;
const GINT_OEPINT: u32 = 1 << 19;
/// 只读、由内部状态算出的位
const GINT_DERIVED: u32 = GINT_OTGINT | GINT_RXFLVL | GINT_BOUTNAKEFF | GINT_IEPINT | GINT_OEPINT;

// 端点控制位
const EPCTL_NAKSTS: u32 = 1 << 17;
const EPCTL_STALL: u32 = 1 << 21;
const EPCTL_CNAK: u32 = 1 << 26;
const EPCTL_SNAK: u32 = 1 << 27;
const EPCTL_SD0PID: u32 = 1 << 28;
const EPCTL_SD1PID: u32 = 1 << 29;
const EPCTL_EPDIS: u32 = 1 << 30;
const EPCTL_EPENA: u32 = 1 << 31;

// 端点中断位
const EPINT_XFRC: u32 = 1 << 0;
const EPINT_EPDISD: u32 = 1 << 1;
const DOEPINT_STUP: u32 = 1 << 3;
const DIEPINT_INEPNE: u32 = 1 << 6;
const DIEPINT_TXFE: u32 = 1 << 7;

// GRXSTSP 包状态
const PKT_OUT_DATA: u32 = 2;
const PKT_OUT_DONE: u32 = 3;
const PKT_SETUP_DONE: u32 = 4;
const PKT_SETUP_DATA: u32 = 6;

#[derive(Default, Clone)]
pub struct Ep {
    pub ctl: u32,
    pub int: u32,
    pub tsiz: u32,
    pub dma: u32,
    pub nak: bool,
}

/// 共享接收 FIFO 里的一项：状态字 + 数据
struct RxEntry {
    status: u32,
    data: Vec<u8>,
}

/// DMA 访问内存用（由 SoC 提供）
pub trait Mem {
    fn rd8(&mut self, a: u32) -> u8;
    fn wr8(&mut self, a: u32, v: u8);
}

const DOEPINT_STPKTRX: u32 = 1 << 15;

/// 主机令牌的结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Handshake {
    Ack(Vec<u8>),
    Nak,
    Stall,
}

pub struct Dwc2 {
    regs: Vec<u32>,
    pub gintsts: u32,
    pub gotgint: u32,
    pub epin: [Ep; EP_COUNT],
    pub epout: [Ep; EP_COUNT],
    /// 各 IN 端点的发送 FIFO（固件按 32 位字写入，含包尾填充）
    txfifo: [VecDeque<u8>; EP_COUNT],
    rxq: VecDeque<RxEntry>,
    /// 已用 GRXSTSP 弹出、正被固件读取数据的那一项
    rx_cur: VecDeque<u8>,
    global_out_nak: bool,
    pub frame: u32,
    /// 设备已枚举出速度（ENUMDNE 之后）
    pub enumerated: bool,
}

impl Default for Dwc2 {
    fn default() -> Self {
        Dwc2 {
            regs: vec![0; 0x1000 / 4],
            gintsts: 0x0400_0020,
            gotgint: 0,
            epin: Default::default(),
            epout: Default::default(),
            txfifo: Default::default(),
            rxq: VecDeque::new(),
            rx_cur: VecDeque::new(),
            global_out_nak: false,
            frame: 0,
            enumerated: false,
        }
    }
}

// 常用寄存器偏移
const GOTGCTL: u32 = 0x000;
const GOTGINT: u32 = 0x004;
const GAHBCFG: u32 = 0x008;
const GRSTCTL: u32 = 0x010;
const GINTSTS: u32 = 0x014;
const GINTMSK: u32 = 0x018;
const GRXSTSR: u32 = 0x01c;
const GRXSTSP: u32 = 0x020;
const GSNPSID: u32 = 0x040;
const GHWCFG1: u32 = 0x044;
const GHWCFG2: u32 = 0x048;
const GHWCFG3: u32 = 0x04c;
const GHWCFG4: u32 = 0x050;
const DIEPTXF0: u32 = 0x028;
const DCFG: u32 = 0x800;
const DCTL: u32 = 0x804;
const DSTS: u32 = 0x808;
const DIEPMSK: u32 = 0x810;
const DOEPMSK: u32 = 0x814;
const DAINT: u32 = 0x818;
const DAINTMSK: u32 = 0x81c;
const DIEPEMPMSK: u32 = 0x834;

impl Dwc2 {
    fn r(&self, off: u32) -> u32 {
        self.regs[(off / 4) as usize]
    }

    /// 发送 FIFO 深度（字）：EP0 用 DIEPTXF0，其余用 DIEPTXFn（0x104 起）
    fn txfifo_depth(&self, ep: usize) -> u32 {
        let r = if ep == 0 { self.r(DIEPTXF0) } else { self.r(0x100 + 4 * ep as u32) };
        (r >> 16).max(16)
    }

    fn in_mps(&self, ep: usize) -> usize {
        let ctl = self.epin[ep].ctl;
        if ep == 0 {
            [64, 32, 16, 8][(ctl & 3) as usize]
        } else {
            (ctl & 0x7ff) as usize
        }
    }

    fn out_mps(&self, ep: usize) -> usize {
        let ctl = self.epout[ep].ctl;
        if ep == 0 {
            [64, 32, 16, 8][(ctl & 3) as usize]
        } else {
            (ctl & 0x7ff) as usize
        }
    }

    fn diepint(&self, ep: usize) -> u32 {
        let mut v = self.epin[ep].int;
        if self.txfifo[ep].is_empty() {
            v |= DIEPINT_TXFE;
        }
        v
    }

    fn daint(&self) -> u32 {
        let diepmsk = self.r(DIEPMSK);
        let doepmsk = self.r(DOEPMSK);
        let empmsk = self.r(DIEPEMPMSK);
        let mut d = 0;
        for ep in 0..EP_COUNT {
            let mut m = diepmsk;
            if empmsk & (1 << ep) != 0 {
                m |= DIEPINT_TXFE;
            }
            if self.diepint(ep) & m != 0 {
                d |= 1 << ep;
            }
            if self.epout[ep].int & doepmsk != 0 {
                d |= 1 << (16 + ep);
            }
        }
        d
    }

    fn gintsts_now(&self) -> u32 {
        let mut v = self.gintsts & !GINT_DERIVED;
        if self.gotgint != 0 {
            v |= GINT_OTGINT;
        }
        if !self.rxq.is_empty() {
            v |= GINT_RXFLVL;
        }
        if self.global_out_nak {
            v |= GINT_BOUTNAKEFF;
        }
        let daint = self.daint() & self.r(DAINTMSK);
        if daint & 0xffff != 0 {
            v |= GINT_IEPINT;
        }
        if daint >> 16 != 0 {
            v |= GINT_OEPINT;
        }
        v
    }

    /// 中断输出：全局中断使能且有未屏蔽的挂起位
    pub fn irq(&self) -> bool {
        self.r(GAHBCFG) & 1 != 0 && self.gintsts_now() & self.r(GINTMSK) != 0
    }

    /// 设备是否在总线上（软断开位 SDIS 已清）
    pub fn connected(&self) -> bool {
        self.r(DCTL) & 2 == 0 && self.r(GAHBCFG) & 1 != 0
    }

    pub fn address(&self) -> u8 {
        ((self.r(DCFG) >> 4) & 0x7f) as u8
    }

    pub fn read(&mut self, off: u32) -> u32 {
        if off >= 0x1000 {
            // 任意 FIFO 窗口读：取当前接收项的下一个字
            let mut w = [0u8; 4];
            for b in w.iter_mut() {
                *b = self.rx_cur.pop_front().unwrap_or(0);
            }
            return u32::from_le_bytes(w);
        }
        match off {
            GOTGCTL => (self.r(GOTGCTL) & 0xffff) | (1 << 16) | (1 << 18) | (1 << 19),
            GOTGINT => self.gotgint,
            // AHB 空闲；复位 / 冲刷都是瞬间完成的
            GRSTCTL => (self.r(GRSTCTL) & !0x3f) | (1 << 31),
            GINTSTS => self.gintsts_now(),
            GRXSTSR => self.rxq.front().map(|e| e.status).unwrap_or(0),
            GRXSTSP => match self.rxq.pop_front() {
                Some(e) => {
                    let ep = (e.status & 0xf) as usize;
                    if (e.status >> 17) & 0xf == PKT_SETUP_DONE {
                        self.epout[ep].int |= DOEPINT_STUP;
                    }
                    self.rx_cur = e.data.into();
                    e.status
                }
                None => 0,
            },
            GSNPSID => 0x4F54_400A,
            GHWCFG1 => 0,
            GHWCFG2 => 0x224D_D930,
            GHWCFG3 => 0x00C8_04B5,
            GHWCFG4 => 0xD3F0_A030,
            DSTS => (if self.enumerated { 3 << 1 } else { 0 }) | ((self.frame & 0x3fff) << 8),
            DAINT => self.daint(),
            0x900..=0x9ff => {
                let (ep, reg) = (((off - 0x900) / 0x20) as usize, (off - 0x900) % 0x20);
                if ep >= EP_COUNT {
                    return 0;
                }
                match reg {
                    0x00 => self.epin[ep].ctl | if self.epin[ep].nak { EPCTL_NAKSTS } else { 0 },
                    0x08 => self.diepint(ep),
                    0x10 => self.epin[ep].tsiz,
                    0x14 => self.epin[ep].dma,
                    0x18 => {
                        let used = (self.txfifo[ep].len() as u32).div_ceil(4);
                        self.txfifo_depth(ep).saturating_sub(used)
                    }
                    _ => 0,
                }
            }
            0xb00..=0xbff => {
                let (ep, reg) = (((off - 0xb00) / 0x20) as usize, (off - 0xb00) % 0x20);
                if ep >= EP_COUNT {
                    return 0;
                }
                match reg {
                    0x00 => self.epout[ep].ctl | if self.epout[ep].nak { EPCTL_NAKSTS } else { 0 },
                    0x08 => self.epout[ep].int,
                    0x10 => self.epout[ep].tsiz,
                    0x14 => self.epout[ep].dma,
                    _ => 0,
                }
            }
            _ => self.r(off),
        }
    }

    fn write_epctl(ep: &mut Ep, v: u32, is_in: bool, flushed: &mut bool) {
        if v & EPCTL_SNAK != 0 {
            ep.nak = true;
            if is_in {
                ep.int |= DIEPINT_INEPNE;
            }
        }
        if v & EPCTL_CNAK != 0 {
            ep.nak = false;
        }
        let mut ctl = v & !(EPCTL_CNAK | EPCTL_SNAK | EPCTL_SD0PID | EPCTL_SD1PID | EPCTL_EPDIS | EPCTL_NAKSTS);
        if v & EPCTL_EPDIS != 0 {
            if ep.ctl & EPCTL_EPENA != 0 {
                ep.int |= EPINT_EPDISD;
            }
            ctl &= !EPCTL_EPENA;
            *flushed = true;
        }
        ep.ctl = ctl;
    }

    pub fn write(&mut self, off: u32, v: u32) {
        if off >= 0x1000 {
            let ep = ((off - 0x1000) / 0x1000) as usize;
            if ep < EP_COUNT {
                self.txfifo[ep].extend(v.to_le_bytes());
            }
            return;
        }
        match off {
            GOTGINT => self.gotgint &= !v,
            GRSTCTL => {
                if v & 1 != 0 {
                    // 内核软复位：清 FIFO 与中断
                    self.rxq.clear();
                    self.rx_cur.clear();
                    self.txfifo.iter_mut().for_each(|f| f.clear());
                    self.gintsts = 0x0400_0020;
                }
                if v & (1 << 4) != 0 {
                    self.rxq.clear();
                    self.rx_cur.clear();
                }
                if v & (1 << 5) != 0 {
                    let n = ((v >> 6) & 0x1f) as usize;
                    if n == 0x10 {
                        self.txfifo.iter_mut().for_each(|f| f.clear());
                    } else if n < EP_COUNT {
                        self.txfifo[n].clear();
                    }
                }
                self.regs[(off / 4) as usize] = v & !0x3f;
            }
            // 写 1 清（派生位写了也没用）
            GINTSTS => self.gintsts &= !(v & !GINT_DERIVED),
            DCTL => {
                if v & (1 << 9) != 0 {
                    self.global_out_nak = true;
                }
                if v & (1 << 10) != 0 {
                    self.global_out_nak = false;
                }
                self.regs[(off / 4) as usize] = v & !((1 << 7) | (1 << 8) | (1 << 9) | (1 << 10));
            }
            0x900..=0x9ff => {
                let (ep, reg) = (((off - 0x900) / 0x20) as usize, (off - 0x900) % 0x20);
                if ep >= EP_COUNT {
                    return;
                }
                match reg {
                    0x00 => {
                        let mut flushed = false;
                        Self::write_epctl(&mut self.epin[ep], v, true, &mut flushed);
                    }
                    0x08 => self.epin[ep].int &= !v,
                    0x10 => self.epin[ep].tsiz = v,
                    0x14 => self.epin[ep].dma = v,
                    _ => {}
                }
            }
            0xb00..=0xbff => {
                let (ep, reg) = (((off - 0xb00) / 0x20) as usize, (off - 0xb00) % 0x20);
                if ep >= EP_COUNT {
                    return;
                }
                match reg {
                    0x00 => {
                        let mut flushed = false;
                        Self::write_epctl(&mut self.epout[ep], v, false, &mut flushed);
                    }
                    0x08 => self.epout[ep].int &= !v,
                    0x10 => self.epout[ep].tsiz = v,
                    0x14 => self.epout[ep].dma = v,
                    _ => {}
                }
            }
            _ => self.regs[(off / 4) as usize] = v,
        }
    }

    // ------------------------------------------------------------------ 主机侧接口

    /// 总线复位开始（主机拉 SE0）
    pub fn bus_reset(&mut self) {
        self.enumerated = false;
        self.gintsts |= GINT_USBRST;
    }

    /// 复位结束，速度协商完成（全速）
    pub fn enum_done(&mut self) {
        self.enumerated = true;
        self.gintsts |= GINT_ENUMDNE;
    }

    /// 1ms 帧开始
    pub fn sof(&mut self) {
        self.frame = (self.frame + 1) & 0x3fff;
        self.gintsts |= GINT_SOF;
    }

    fn status_word(ep: usize, bcnt: usize, pkt: u32) -> u32 {
        ep as u32 | ((bcnt as u32) << 4) | (pkt << 17)
    }

    fn dma(&self) -> bool {
        self.r(GAHBCFG) & (1 << 5) != 0
    }

    /// SETUP 令牌 + 8 字节数据：设备总是 ACK（接收 FIFO 有空间时）
    pub fn setup(&mut self, pkt: [u8; 8], mem: &mut dyn Mem) {
        // 新的 SETUP 取消 EP0 上还挂着的数据阶段
        self.txfifo[0].clear();
        if self.dma() {
            // DMA：8 字节写到 DOEPDMA0，指针后移；SETUP 阶段结束（STUP）时 EP0 OUT 自动关闭
            let e = &mut self.epout[0];
            for (i, b) in pkt.iter().enumerate() {
                mem.wr8(e.dma.wrapping_add(i as u32), *b);
            }
            e.dma = e.dma.wrapping_add(8);
            e.ctl &= !EPCTL_EPENA;
            e.int |= DOEPINT_STUP;
            let _ = DOEPINT_STPKTRX;
            return;
        }
        self.rxq.push_back(RxEntry { status: Self::status_word(0, 8, PKT_SETUP_DATA), data: pkt.to_vec() });
        self.rxq.push_back(RxEntry { status: Self::status_word(0, 0, PKT_SETUP_DONE), data: Vec::new() });
    }

    /// IN 令牌
    pub fn token_in(&mut self, ep: usize, mem: &mut dyn Mem) -> Handshake {
        if ep >= EP_COUNT {
            return Handshake::Stall;
        }
        let e = &self.epin[ep];
        if e.ctl & EPCTL_STALL != 0 {
            return Handshake::Stall;
        }
        if e.ctl & EPCTL_EPENA == 0 || e.nak {
            return Handshake::Nak;
        }
        let mps = self.in_mps(ep);
        let (size_mask, cnt_mask) = if ep == 0 { (0x7f, 0x3) } else { (0x7_ffff, 0x3ff) };
        let tsiz = self.epin[ep].tsiz;
        let remain = (tsiz & size_mask) as usize;
        let pkts = (tsiz >> 19) & cnt_mask;
        let len = remain.min(mps);
        let data: Vec<u8> = if self.dma() {
            let a = self.epin[ep].dma;
            let d = (0..len).map(|i| mem.rd8(a.wrapping_add(i as u32))).collect();
            self.epin[ep].dma = a.wrapping_add(len as u32);
            d
        } else {
            // 数据还没写进 FIFO：NAK，主机稍后重试
            if self.txfifo[ep].len() < len {
                return Handshake::Nak;
            }
            let d = self.txfifo[ep].drain(..len).collect();
            // 丢掉包尾填充（固件按整字写入）
            let pad = (4 - len % 4) % 4;
            for _ in 0..pad.min(self.txfifo[ep].len()) {
                self.txfifo[ep].pop_front();
            }
            d
        };
        let left = pkts.saturating_sub(1);
        let e = &mut self.epin[ep];
        e.tsiz = (tsiz & !(size_mask | (cnt_mask << 19))) | ((remain - len) as u32 & size_mask) | (left << 19);
        if left == 0 {
            e.ctl &= !EPCTL_EPENA;
            e.int |= EPINT_XFRC;
        }
        Handshake::Ack(data)
    }

    /// OUT 令牌 + 数据
    pub fn token_out(&mut self, ep: usize, data: &[u8], mem: &mut dyn Mem) -> Handshake {
        if ep >= EP_COUNT {
            return Handshake::Stall;
        }
        let e = &self.epout[ep];
        if e.ctl & EPCTL_STALL != 0 {
            return Handshake::Stall;
        }
        if e.ctl & EPCTL_EPENA == 0 || e.nak || self.global_out_nak {
            return Handshake::Nak;
        }
        let mps = self.out_mps(ep);
        let (size_mask, cnt_mask) = if ep == 0 { (0x7f, 0x3) } else { (0x7_ffff, 0x3ff) };
        let tsiz = e.tsiz;
        let remain = (tsiz & size_mask) as usize;
        let pkts = (tsiz >> 19) & cnt_mask;
        let left = pkts.saturating_sub(1);
        let dma = self.dma();
        let e = &mut self.epout[ep];
        e.tsiz = (tsiz & !(size_mask | (cnt_mask << 19))) | (remain.saturating_sub(data.len()) as u32 & size_mask) | (left << 19);
        let done = left == 0 || data.len() < mps;
        if dma {
            for (i, b) in data.iter().enumerate() {
                mem.wr8(e.dma.wrapping_add(i as u32), *b);
            }
            e.dma = e.dma.wrapping_add(data.len() as u32);
        } else {
            self.rxq.push_back(RxEntry { status: Self::status_word(ep, data.len(), PKT_OUT_DATA), data: data.to_vec() });
        }
        if done {
            self.epout[ep].ctl &= !EPCTL_EPENA;
            self.epout[ep].int |= EPINT_XFRC;
            if !dma {
                self.rxq.push_back(RxEntry { status: Self::status_word(ep, 0, PKT_OUT_DONE), data: Vec::new() });
            }
        }
        Handshake::Ack(Vec::new())
    }
}
