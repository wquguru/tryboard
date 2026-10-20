//! Classic ESP32 general-purpose SPI master (HSPI = SPI2 at 0x3FF64000, VSPI = SPI3 at 0x3FF65000).
//! Registers per soc/esp32/register/soc/spi_reg.h, driver usage per hal/esp32/include/hal/spi_ll.h. (lint: allow-long-comment)
//! The layout and semantics differ from the C3 / S3 block (`gpspi.rs`): USR is CMD bit 18 with no UPDATE, separate
//! MOSI / MISO lengths, TRANS_DONE lives in SLAVE, and the DMA engine (lldesc lists) sits inside the SPI block.
//! It produces the same `gpspi::Plan`, so the SoC glue hands bytes to the same slave models.

use crate::gpspi::Plan;
use crate::periph::CPU_HZ;
use crate::Mem;

pub mod reg {
    pub const CMD: u32 = 0x00;
    pub const ADDR: u32 = 0x04;
    pub const CTRL: u32 = 0x08;
    pub const CLOCK: u32 = 0x18;
    pub const USER: u32 = 0x1c;
    pub const USER1: u32 = 0x20;
    pub const USER2: u32 = 0x24;
    pub const MOSI_DLEN: u32 = 0x28;
    pub const MISO_DLEN: u32 = 0x2c;
    pub const SLV_WR_STATUS: u32 = 0x30;
    pub const PIN: u32 = 0x34;
    pub const SLAVE: u32 = 0x38;
    pub const W0: u32 = 0x80;
    pub const DMA_CONF: u32 = 0x100;
    pub const DMA_OUT_LINK: u32 = 0x104;
    pub const DMA_IN_LINK: u32 = 0x108;
    pub const DMA_STATUS: u32 = 0x10c;
    pub const DMA_INT_ENA: u32 = 0x110;
    pub const DMA_INT_RAW: u32 = 0x114;
    pub const DMA_INT_ST: u32 = 0x118;
    pub const DMA_INT_CLR: u32 = 0x11c;
    pub const IN_SUC_EOF_DES_ADDR: u32 = 0x124;
    pub const OUT_EOF_DES_ADDR: u32 = 0x138;
    pub const DATE: u32 = 0x3fc;
}

pub const CMD_USR: u32 = 1 << 18;
const USER_COMMAND: u32 = 1 << 31;
const USER_ADDR: u32 = 1 << 30;
const USER_DUMMY: u32 = 1 << 29;
const USER_MISO: u32 = 1 << 28;
const USER_MOSI: u32 = 1 << 27;
const USER_MOSI_HIGHPART: u32 = 1 << 25;
const USER_MISO_HIGHPART: u32 = 1 << 24;
const USER_FWRITE_DUAL: u32 = 1 << 12;
const USER_FWRITE_QUAD: u32 = 1 << 13;
const USER_FWRITE_DIO: u32 = 1 << 14;
const USER_FWRITE_QIO: u32 = 1 << 15;
const CTRL_FREAD_DUAL: u32 = 1 << 14;
const CTRL_FREAD_QUAD: u32 = 1 << 20;
const CTRL_FREAD_DIO: u32 = 1 << 23;
const CTRL_FREAD_QIO: u32 = 1 << 24;
const PIN_CS0_DIS: u32 = 1;
const PIN_CS_KEEP_ACTIVE: u32 = 1 << 30;
pub const SLAVE_TRANS_DONE: u32 = 1 << 4;
pub const SLAVE_TRANS_INTEN: u32 = 1 << 9;
const LINK_STOP: u32 = 1 << 28;
const LINK_START: u32 = 1 << 29;
const LINK_RESTART: u32 = 1 << 30;
const DMA_CONF_OUT_AUTO_WRBACK: u32 = 1 << 8;
/// DMA_INT bits
pub const INT_IN_DONE: u32 = 1 << 3;
pub const INT_IN_SUC_EOF: u32 = 1 << 5;
pub const INT_OUT_DONE: u32 = 1 << 6;
pub const INT_OUT_EOF: u32 = 1 << 7;
pub const INT_OUT_TOTAL_EOF: u32 = 1 << 8;
/// Link registers hold the low 20 bits of a descriptor address; internal DRAM sits at 0x3FFxxxxx
const LINK_BASE: u32 = 0x3ff0_0000;
/// APB clock feeding the SPI clock divider
const APB_HZ: u64 = 80_000_000;

pub struct ClassicSpi {
    pub regs: [u32; 0x400 / 4],
    pub dma_int_raw: u32,
    pending: Option<u64>,
    /// Descriptor heads armed by DMA_OUT_LINK / DMA_IN_LINK start (there is no dma_tx_ena on this chip)
    out_link: Option<u32>,
    in_link: Option<u32>,
    /// Last OUT descriptor of the transfer in progress; EOF interrupts are raised when it ends
    out_last: Option<u32>,
    pub transfers: u64,
    pub bytes: u64,
}

impl Default for ClassicSpi {
    fn default() -> Self {
        let mut regs = [0u32; 0x400 / 4];
        // Reset values: derived from the defaults in spi_reg.h field comments
        for (off, v) in [
            (reg::CTRL, 0x0020_a400),
            (0x0c, 0x5fff_0000), // CTRL1
            (0x14, 0x0000_0011), // CTRL2
            (reg::CLOCK, 0x8000_3043),
            (reg::USER, 0x8000_0040),
            (reg::USER1, 0x5c00_0007),
            (reg::USER2, 0x7000_0000),
            (reg::PIN, 0x0000_0006),
            (reg::SLAVE, 0x0000_0020),
            (0x3c, 0x0200_0000), // SLAVE1
            (0x54, 0x15c0_4830), // CACHE_SCTRL
            (0xf0, 0x800a_0050), // EXT0
            (0xf4, 0x800f_0000), // EXT1
            (reg::DMA_CONF, 0x0000_0200),
            (reg::DATE, 0x0160_4270),
        ] {
            regs[(off / 4) as usize] = v;
        }
        ClassicSpi {
            regs,
            dma_int_raw: 0,
            pending: None,
            out_link: None,
            in_link: None,
            out_last: None,
            transfers: 0,
            bytes: 0,
        }
    }
}

impl ClassicSpi {
    fn r(&self, off: u32) -> u32 {
        self.regs[(off / 4) as usize]
    }

    pub fn busy(&self) -> bool {
        self.pending.is_some()
    }

    /// Offsets this model implements (anything else in the 1 KB block is plain storage, reported as unimplemented)
    pub fn known(off: u32) -> bool {
        matches!(off, 0x00..=0x64 | 0x80..=0xbc | 0x100..=0x14c | reg::DATE)
    }

    pub fn read(&self, off: u32) -> u32 {
        match off {
            reg::CMD => {
                let v = self.r(reg::CMD) & !CMD_USR;
                if self.busy() {
                    v | CMD_USR
                } else {
                    v
                }
            }
            reg::DMA_INT_RAW => self.dma_int_raw,
            reg::DMA_INT_ST => self.dma_int_raw & self.r(reg::DMA_INT_ENA),
            reg::DMA_INT_CLR => 0,
            // Start / stop / restart self-clear
            reg::DMA_OUT_LINK | reg::DMA_IN_LINK => {
                self.r(off) & !(LINK_STOP | LINK_START | LINK_RESTART)
            }
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    /// Register write. true = firmware just started a transfer (CMD.USR); the SoC then runs it with `transfer`
    pub fn write(&mut self, off: u32, v: u32) -> bool {
        let Some(r) = self.regs.get_mut((off / 4) as usize) else {
            return false;
        };
        match off {
            reg::CMD => {
                *r = v & !CMD_USR;
                return v & CMD_USR != 0 && !self.busy();
            }
            reg::DMA_INT_CLR => self.dma_int_raw &= !v,
            reg::DMA_INT_RAW | reg::DMA_INT_ST => {}
            reg::DMA_OUT_LINK => {
                *r = v;
                if v & LINK_STOP != 0 {
                    self.out_link = None;
                }
                if v & (LINK_START | LINK_RESTART) != 0 {
                    self.out_link = Some(LINK_BASE | (v & 0xf_ffff));
                }
            }
            reg::DMA_IN_LINK => {
                *r = v;
                if v & LINK_STOP != 0 {
                    self.in_link = None;
                }
                if v & (LINK_START | LINK_RESTART) != 0 {
                    self.in_link = Some(LINK_BASE | (v & 0xf_ffff));
                }
            }
            // SLAVE.trans_done is the transfer-done raw bit; spi_ll_clear_int_stat writes it back as 0
            _ => *r = v,
        }
        false
    }

    /// Phases of this transfer
    pub fn plan(&self) -> Plan {
        let user = self.r(reg::USER);
        let user1 = self.r(reg::USER1);
        let user2 = self.r(reg::USER2);
        let ctrl = self.r(reg::CTRL);
        let n = |dual: bool, quad: bool| match (dual, quad) {
            (_, true) => 4,
            (true, _) => 2,
            _ => 1,
        };
        let mut p = Plan {
            cmd_lines: 1,
            addr_lines: n(
                user & USER_FWRITE_DIO != 0 || ctrl & CTRL_FREAD_DIO != 0,
                user & USER_FWRITE_QIO != 0 || ctrl & CTRL_FREAD_QIO != 0,
            ),
            mosi_lines: n(
                user & (USER_FWRITE_DUAL | USER_FWRITE_DIO) != 0,
                user & (USER_FWRITE_QUAD | USER_FWRITE_QIO) != 0,
            ),
            miso_lines: n(
                ctrl & (CTRL_FREAD_DUAL | CTRL_FREAD_DIO) != 0,
                ctrl & (CTRL_FREAD_QUAD | CTRL_FREAD_QIO) != 0,
            ),
            ..Plan::default()
        };
        if user & USER_COMMAND != 0 {
            // Command shifts out bit7..0 then bit15..8 (spi_ll_set_command already swapped for MSB-first)
            let bits = ((user2 >> 28) & 0xf) + 1;
            let val = user2 & 0xffff;
            p.head.push(val as u8);
            if bits > 8 {
                p.head.push((val >> 8) as u8);
            }
            p.head_bits += bits;
            p.cmd_bits = bits;
        }
        if user & USER_ADDR != 0 {
            // Address shifts out from the top bit of ADDR, then SLV_WR_STATUS for lengths over 32 bits
            let bits = ((user1 >> 26) & 0x3f) + 1;
            let a = ((self.r(reg::ADDR) as u64) << 32) | self.r(reg::SLV_WR_STATUS) as u64;
            for i in 0..bits.div_ceil(8) {
                p.head.push((a >> (56 - 8 * i)) as u8);
            }
            p.head_bits += bits;
            p.addr_bits = bits;
        }
        if user & USER_DUMMY != 0 {
            p.dummy_bits = (user1 & 0xff) + 1;
        }
        if user & USER_MOSI != 0 {
            p.mosi_bits = (self.r(reg::MOSI_DLEN) & 0xff_ffff) + 1;
        }
        if user & USER_MISO != 0 {
            p.miso_bits = (self.r(reg::MISO_DLEN) & 0xff_ffff) + 1;
        }
        p.dma_tx = self.out_link.is_some();
        p.dma_rx = self.in_link.is_some();
        p
    }

    /// First W register of the data buffer: W8 when the high-part bit is set (M5GFX double-buffers with it)
    fn w_base(&self, high: u32) -> usize {
        (reg::W0 / 4) as usize + if self.r(reg::USER) & high != 0 { 8 } else { 0 }
    }

    /// Without DMA, MOSI data comes from W0..W15 (or W8..W15), little-endian
    pub fn tx_buffer(&self, n: usize) -> Vec<u8> {
        let base = self.w_base(USER_MOSI_HIGHPART);
        let cap = (16 - (base - (reg::W0 / 4) as usize)) * 4;
        (0..n.min(cap))
            .map(|i| (self.regs[base + i / 4] >> (8 * (i % 4))) as u8)
            .collect()
    }

    /// Without DMA, MISO data is written back to W0..W15 (or W8..W15)
    pub fn rx_fill(&mut self, data: &[u8]) {
        let base = self.w_base(USER_MISO_HIGHPART);
        let cap = (16 - (base - (reg::W0 / 4) as usize)) * 4;
        for (i, b) in data.iter().take(cap).enumerate() {
            let r = &mut self.regs[base + i / 4];
            let sh = 8 * (i % 4);
            *r = (*r & !(0xff << sh)) | ((*b as u32) << sh);
        }
    }

    /// DMA TX: gather `max` bytes from the armed descriptor chain (owner handed back when OUT_AUTO_WRBACK is set)
    pub fn dma_take(&mut self, max: usize, mem: &mut dyn Mem) -> Vec<u8> {
        let Some(link) = self.out_link.take() else {
            return Vec::new();
        };
        let wb = self.r(reg::DMA_CONF) & DMA_CONF_OUT_AUTO_WRBACK != 0;
        let (data, last) = lldesc_take(link, max, wb, mem);
        self.out_last = last;
        data
    }

    /// DMA RX: scatter into the armed descriptor chain, raise IN_DONE / IN_SUC_EOF
    pub fn dma_put(&mut self, data: &[u8], mem: &mut dyn Mem) {
        let Some(link) = self.in_link.take() else {
            return;
        };
        if let Some(d) = lldesc_fill(link, data, mem) {
            self.regs[(reg::IN_SUC_EOF_DES_ADDR / 4) as usize] = d;
        }
        self.dma_int_raw |= INT_IN_DONE | INT_IN_SUC_EOF;
    }

    /// SPI clock (Hz): APB 80 MHz, or ÷ (pre+1)(n+1) unless CLOCK.clk_equ_sysclk
    pub fn clock_hz(&self) -> u64 {
        let c = self.r(reg::CLOCK);
        if c & (1 << 31) != 0 {
            return APB_HZ;
        }
        let pre = ((c >> 18) & 0x1fff) as u64 + 1;
        let n = ((c >> 12) & 0x3f) as u64 + 1;
        APB_HZ / (pre * n)
    }

    /// CS stays asserted after the transfer (PIN.cs_keep_active)
    pub fn cs_keep_active(&self) -> bool {
        self.r(reg::PIN) & PIN_CS_KEEP_ACTIVE != 0
    }

    /// CS0 takes part in the transfer (PIN.cs0_dis = 0)
    pub fn cs0_enabled(&self) -> bool {
        self.r(reg::PIN) & PIN_CS0_DIS == 0
    }

    /// Start timing: SPI clocks of all phases plus one each for CS setup / hold
    pub fn begin(&mut self, now: u64, p: &Plan) {
        let clk = |bits: u32, n: u32| bits.div_ceil(n.max(1));
        let data = clk(p.mosi_bits, p.mosi_lines).max(clk(p.miso_bits, p.miso_lines));
        let clocks =
            clk(p.cmd_bits, p.cmd_lines) + clk(p.addr_bits, p.addr_lines) + p.dummy_bits + data + 2;
        let cyc = (clocks as u64 * CPU_HZ).div_ceil(self.clock_hz().max(1));
        self.pending = Some(now + cyc.max(1));
        self.transfers += 1;
        self.bytes += (p.mosi_bits as u64).div_ceil(8);
    }

    /// Advance: set SLAVE.trans_done (and the DMA OUT EOF bits) when the transfer is due. Returns the next event time
    pub fn update(&mut self, now: u64) -> u64 {
        match self.pending {
            Some(t) if now >= t => {
                self.pending = None;
                self.regs[(reg::SLAVE / 4) as usize] |= SLAVE_TRANS_DONE;
                if let Some(d) = self.out_last.take() {
                    self.regs[(reg::OUT_EOF_DES_ADDR / 4) as usize] = d;
                    self.dma_int_raw |= INT_OUT_DONE | INT_OUT_EOF | INT_OUT_TOTAL_EOF;
                }
                u64::MAX
            }
            Some(t) => t,
            None => u64::MAX,
        }
    }

    /// SPIn interrupt source: trans_done & trans_inten
    pub fn irq(&self) -> bool {
        let s = self.r(reg::SLAVE);
        s & SLAVE_TRANS_DONE != 0 && s & SLAVE_TRANS_INTEN != 0
    }

    /// SPIn_DMA interrupt source
    pub fn dma_irq(&self) -> bool {
        self.dma_int_raw & self.r(reg::DMA_INT_ENA) != 0
    }
}

/// Walk an lldesc chain (word 0: size[11:0] length[23:12] eof[30] owner[31]; buffer; next) gathering up to `max`
/// bytes. Returns the data and the last descriptor used
pub fn lldesc_take(
    link: u32,
    max: usize,
    writeback: bool,
    mem: &mut dyn Mem,
) -> (Vec<u8>, Option<u32>) {
    let mut data = Vec::with_capacity(max.min(1 << 16));
    let mut desc = link;
    let mut last = None;
    // Guard against firmware linking the chain into a loop
    for _ in 0..4096 {
        if desc == 0 || data.len() >= max {
            break;
        }
        let w0 = mem.rd32(desc);
        let buf = mem.rd32(desc + 4);
        let next = mem.rd32(desc + 8);
        let len = ((w0 >> 12) & 0xfff) as usize;
        for i in 0..len.min(max - data.len()) {
            data.push(mem.rd8(buf + i as u32));
        }
        if writeback {
            mem.wr32(desc, w0 & !(1 << 31));
        }
        last = Some(desc);
        if w0 & (1 << 30) != 0 {
            break;
        }
        desc = next;
    }
    (data, last)
}

/// Scatter `data` into an lldesc chain (fills `size` bytes per descriptor, writes length, hands owner back, sets eof
/// on the last one used). Returns that descriptor
pub fn lldesc_fill(link: u32, data: &[u8], mem: &mut dyn Mem) -> Option<u32> {
    let mut desc = link;
    let mut pos = 0;
    let mut last = None;
    for _ in 0..4096 {
        if desc == 0 {
            break;
        }
        let w0 = mem.rd32(desc);
        let buf = mem.rd32(desc + 4);
        let next = mem.rd32(desc + 8);
        let n = ((w0 & 0xfff) as usize).min(data.len() - pos);
        for (i, b) in data[pos..pos + n].iter().enumerate() {
            mem.wr8(buf + i as u32, *b);
        }
        pos += n;
        let end = pos >= data.len() || next == 0;
        let w0n = (w0 & !(0xfff << 12) & !(3 << 30)) | ((n as u32) << 12) | if end { 1 << 30 } else { 0 };
        mem.wr32(desc, w0n);
        last = Some(desc);
        if end {
            break;
        }
        desc = next;
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Ram(Vec<u8>);
    impl Mem for Ram {
        fn rd8(&mut self, a: u32) -> u8 {
            self.0[(a - LINK_BASE) as usize]
        }
        fn rd32(&mut self, a: u32) -> u32 {
            let o = (a - LINK_BASE) as usize;
            u32::from_le_bytes(self.0[o..o + 4].try_into().unwrap())
        }
        fn wr8(&mut self, a: u32, v: u8) {
            self.0[(a - LINK_BASE) as usize] = v;
        }
        fn wr32(&mut self, a: u32, v: u32) {
            let o = (a - LINK_BASE) as usize;
            self.0[o..o + 4].copy_from_slice(&v.to_le_bytes());
        }
    }

    #[test]
    fn plan_w_registers_and_timing() {
        let mut s = ClassicSpi::default();
        // 40 MHz: pre=0, n=1
        s.write(reg::CLOCK, 1 << 12);
        assert_eq!(s.clock_hz(), 40_000_000);
        s.write(reg::USER, USER_COMMAND | USER_ADDR | USER_MOSI);
        s.write(reg::USER2, (7 << 28) | 0x2c);
        s.write(reg::USER1, 23 << 26);
        s.write(reg::ADDR, 0x0012_3400 << 8);
        s.write(reg::MOSI_DLEN, 8 * 3 - 1);
        s.write(reg::W0, 0x0033_2211);
        assert!(s.write(reg::CMD, CMD_USR));
        let p = s.plan();
        assert_eq!(p.head, vec![0x2c, 0x12, 0x34, 0x00]);
        assert_eq!((p.mosi_bits, p.miso_bits, p.dma_tx), (24, 0, false));
        assert_eq!(s.tx_buffer(3), vec![0x11, 0x22, 0x33]);
        s.begin(100, &p);
        assert!(s.read(reg::CMD) & CMD_USR != 0);
        // (8 + 24 + 24 + 2) clocks x 4 cycles
        assert_eq!(s.update(100), 100 + 58 * 4);
        assert_eq!(s.update(100 + 58 * 4), u64::MAX);
        assert_eq!(s.read(reg::CMD) & CMD_USR, 0);
        assert!(!s.irq());
        s.write(reg::SLAVE, s.read(reg::SLAVE) | SLAVE_TRANS_INTEN);
        assert!(s.irq());
        // spi_ll_clear_int_stat: read-modify-write of SLAVE with trans_done = 0
        s.write(reg::SLAVE, s.read(reg::SLAVE) & !SLAVE_TRANS_DONE);
        assert!(!s.irq());
        // High part: data from W8
        s.write(reg::USER, USER_MOSI | USER_MOSI_HIGHPART | USER_MISO_HIGHPART);
        s.write(reg::W0 + 32, 0xddcc_bbaa);
        assert_eq!(s.tx_buffer(2), vec![0xaa, 0xbb]);
        s.rx_fill(&[1, 2]);
        assert_eq!(s.read(reg::W0 + 32) & 0xffff, 0x0201);
    }

    #[test]
    fn dma_chain_out_and_in() {
        let mut m = Ram(vec![0; 0x1000]);
        let d0 = LINK_BASE + 0x100;
        let d1 = LINK_BASE + 0x110;
        // d0: 3 bytes at 0x200 -> d1: 2 bytes at 0x300, eof
        m.wr32(d0, (1 << 31) | (3 << 12) | 4);
        m.wr32(d0 + 4, LINK_BASE + 0x200);
        m.wr32(d0 + 8, d1);
        m.wr32(d1, (1 << 31) | (1 << 30) | (2 << 12) | 4);
        m.wr32(d1 + 4, LINK_BASE + 0x300);
        m.wr32(d1 + 8, 0);
        for (i, b) in [1u8, 2, 3].iter().enumerate() {
            m.wr8(LINK_BASE + 0x200 + i as u32, *b);
        }
        m.wr8(LINK_BASE + 0x300, 4);
        m.wr8(LINK_BASE + 0x301, 5);
        let mut s = ClassicSpi::default();
        s.write(reg::DMA_CONF, DMA_CONF_OUT_AUTO_WRBACK);
        s.write(reg::DMA_OUT_LINK, LINK_START | (d0 & 0xf_ffff));
        assert_eq!(s.read(reg::DMA_OUT_LINK) & LINK_START, 0);
        s.write(reg::USER, USER_MOSI);
        s.write(reg::MOSI_DLEN, 5 * 8 - 1);
        let p = s.plan();
        assert!(p.dma_tx);
        assert_eq!(s.dma_take(5, &mut m), vec![1, 2, 3, 4, 5]);
        assert_eq!(m.rd32(d1) >> 31, 0);
        s.begin(0, &p);
        s.write(reg::DMA_INT_ENA, INT_OUT_EOF);
        let t = s.update(0);
        s.update(t);
        assert!(s.dma_irq());
        assert_eq!(s.read(reg::OUT_EOF_DES_ADDR), d1);
        // Next transfer without a new start uses the W registers
        assert!(!s.plan().dma_tx);
        // RX: 4 bytes into d0 (size 4)
        s.write(reg::DMA_IN_LINK, LINK_START | (d0 & 0xf_ffff));
        s.dma_put(&[9, 8, 7, 6], &mut m);
        assert_eq!(m.rd32(LINK_BASE + 0x200), 0x0607_0809);
        assert_eq!((m.rd32(d0) >> 12) & 0xfff, 4);
        assert_eq!(s.dma_int_raw & INT_IN_SUC_EOF, INT_IN_SUC_EOF);
    }
}
