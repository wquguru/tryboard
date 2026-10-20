//! GP-SPI2 master (general-purpose SPI, FSPI). Registers in soc/esp32s3/register/soc/spi_reg.h (C3 same layout), driver usage in hal/esp32s3/include/hal/spi_ll.h.
//! Like I2C: on CMD.USR the SoC immediately hands bytes (command -> address -> dummy -> MOSI data, from W0..W15 or GDMA chain) to the slave;
//! busy state and TRANS_DONE are deferred by the SPI-clock duration. No device answers on MISO, so reads are all ones. (lint: allow-long-comment)

use crate::periph::CPU_HZ;

pub mod reg {
    pub const CMD: u32 = 0x00;
    pub const ADDR: u32 = 0x04;
    pub const CTRL: u32 = 0x08;
    pub const CLOCK: u32 = 0x0c;
    pub const USER: u32 = 0x10;
    pub const USER1: u32 = 0x14;
    pub const USER2: u32 = 0x18;
    pub const MS_DLEN: u32 = 0x1c;
    pub const MISC: u32 = 0x20;
    pub const DMA_CONF: u32 = 0x30;
    pub const DMA_INT_ENA: u32 = 0x34;
    pub const DMA_INT_CLR: u32 = 0x38;
    pub const DMA_INT_RAW: u32 = 0x3c;
    pub const DMA_INT_ST: u32 = 0x40;
    pub const DMA_INT_SET: u32 = 0x44;
    pub const W0: u32 = 0x98;
    pub const W15: u32 = 0xd4;
    pub const CLK_GATE: u32 = 0xe8;
    pub const DATE: u32 = 0xf0;
}

const CMD_USR: u32 = 1 << 24;
const CMD_UPDATE: u32 = 1 << 23;
const USER_COMMAND: u32 = 1 << 31;
const USER_ADDR: u32 = 1 << 30;
const USER_DUMMY: u32 = 1 << 29;
const USER_MISO: u32 = 1 << 28;
const USER_MOSI: u32 = 1 << 27;
// Multi-line phases (spi_ll_master_set_line_mode): CTRL fcmd 8/9/10, faddr 5/6/7, fread 14/15/16; USER fwrite 12/13/14
const CTRL_FCMD_DUAL: u32 = 8;
const CTRL_FADDR_DUAL: u32 = 5;
const CTRL_FREAD_DUAL: u32 = 14;
const USER_FWRITE_DUAL: u32 = 12;
const MISC_CS_KEEP_ACTIVE: u32 = 1 << 30;
const MISC_CK_IDLE_EDGE: u32 = 1 << 29;
const DMA_TX_ENA: u32 = 1 << 28;
const DMA_RX_ENA: u32 = 1 << 27;
pub const INT_TRANS_DONE: u32 = 1 << 12;

/// Phases of one transfer (register snapshot at CMD.USR)
#[derive(Debug, Default, Clone)]
pub struct Plan {
    /// Command + address bytes to shift out (in wire order)
    pub head: Vec<u8>,
    pub head_bits: u32,
    pub cmd_bits: u32,
    pub addr_bits: u32,
    /// Data lines per phase (1 / 2 / 4 / 8): command, address, MOSI, MISO
    pub cmd_lines: u32,
    pub addr_lines: u32,
    pub mosi_lines: u32,
    pub miso_lines: u32,
    pub dummy_bits: u32,
    /// MOSI data bits (0 = no data phase)
    pub mosi_bits: u32,
    pub miso_bits: u32,
    pub dma_tx: bool,
    pub dma_rx: bool,
}

pub struct GpSpi {
    pub regs: [u32; 0x100 / 4],
    pub int_raw: u32,
    pub int_ena: u32,
    /// When the transfer in progress ends
    pending: Option<u64>,
    /// GDMA TX channel used by this transfer (the SoC sets EOF on it at the end)
    pub dma_out_ch: Option<usize>,
    pub transfers: u64,
    pub bytes: u64,
    /// MISC.CK_IDLE_EDGE as last synced by UPDATE / USR
    idle_latched: bool,
    /// Idle-level flips synced since the SoC last drained them; each pair is one SCLK pulse with no data
    pub idle_flips: u32,
}

impl Default for GpSpi {
    fn default() -> Self {
        let mut regs = [0u32; 0x100 / 4];
        // Reset values: derived from the defaults in spi_reg.h field comments
        regs[(reg::CLOCK / 4) as usize] = 0x8000_3043;
        regs[(reg::USER / 4) as usize] = 0x8000_00c0;
        regs[(reg::USER1 / 4) as usize] = 0xb841_0007;
        regs[(reg::USER2 / 4) as usize] = 0x7800_0000;
        regs[(reg::MISC / 4) as usize] = 0x0000_003e;
        regs[(reg::DMA_CONF / 4) as usize] = 0x3;
        regs[(0x08 / 4) as usize] = 0x003c_0000; // CTRL
        regs[(0xe0 / 4) as usize] = 0x0280_0000; // SLAVE
        regs[(reg::DATE / 4) as usize] = 0x0210_1190;
        GpSpi {
            regs,
            int_raw: 0,
            int_ena: 0,
            pending: None,
            dma_out_ch: None,
            transfers: 0,
            bytes: 0,
            idle_latched: false,
            idle_flips: 0,
        }
    }
}

impl GpSpi {
    fn r(&self, off: u32) -> u32 {
        self.regs[(off / 4) as usize]
    }

    pub fn busy(&self) -> bool {
        self.pending.is_some()
    }

    pub fn read(&self, off: u32) -> u32 {
        match off {
            reg::CMD => {
                let v = self.r(reg::CMD) & !(CMD_USR | CMD_UPDATE);
                if self.busy() {
                    v | CMD_USR
                } else {
                    v
                }
            }
            reg::DMA_INT_ENA => self.int_ena,
            reg::DMA_INT_RAW => self.int_raw,
            reg::DMA_INT_ST => self.int_raw & self.int_ena,
            reg::DMA_INT_CLR | reg::DMA_INT_SET => 0,
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    /// Register write. true = firmware just started a transfer (CMD.USR); the SoC then calls `plan` / `begin`.
    pub fn write(&mut self, off: u32, v: u32) -> bool {
        match off {
            reg::CMD => {
                // UPDATE (sync config to the SPI clock domain) completes instantly; USR is represented by the busy state
                self.regs[0] = v & !(CMD_USR | CMD_UPDATE);
                if v & (CMD_USR | CMD_UPDATE) != 0 {
                    // M5GFX makes its one-bit read dummy by flipping the idle clock level and syncing it twice
                    let e = self.r(reg::MISC) & MISC_CK_IDLE_EDGE != 0;
                    if e != self.idle_latched {
                        self.idle_latched = e;
                        self.idle_flips += 1;
                    }
                }
                return v & CMD_USR != 0 && !self.busy();
            }
            reg::DMA_INT_ENA => self.int_ena = v,
            reg::DMA_INT_CLR => self.int_raw &= !v,
            reg::DMA_INT_SET => self.int_raw |= v,
            // The C3 driver clears trans_done by writing RAW (spi_ll_clear_int_stat: dma_int_raw.trans_done = 0);
            // RAW is R/W/WTC on the C3; the S3 uses INT_CLR instead
            reg::DMA_INT_RAW => self.int_raw = v,
            reg::DMA_INT_ST => {}
            _ => {
                if let Some(r) = self.regs.get_mut((off / 4) as usize) {
                    *r = v;
                }
            }
        }
        false
    }

    /// Phases of this transfer
    pub fn plan(&self) -> Plan {
        let user = self.r(reg::USER);
        let user1 = self.r(reg::USER1);
        let user2 = self.r(reg::USER2);
        let ctrl = self.r(reg::CTRL);
        let mut p = Plan {
            cmd_lines: lines(ctrl, CTRL_FCMD_DUAL),
            addr_lines: lines(ctrl, CTRL_FADDR_DUAL),
            mosi_lines: lines(user, USER_FWRITE_DUAL),
            miso_lines: lines(ctrl, CTRL_FREAD_DUAL),
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
            // Address shifts out from the top bit of ADDR
            let bits = ((user1 >> 27) & 0x1f) + 1;
            let a = self.r(reg::ADDR);
            for i in 0..bits.div_ceil(8) {
                p.head.push((a >> (24 - 8 * i)) as u8);
            }
            p.head_bits += bits;
            p.addr_bits = bits;
        }
        if user & USER_DUMMY != 0 {
            p.dummy_bits = (user1 & 0xff) + 1;
        }
        let dlen = (self.r(reg::MS_DLEN) & 0x3_ffff) + 1;
        if user & USER_MOSI != 0 {
            p.mosi_bits = dlen;
        }
        if user & USER_MISO != 0 {
            p.miso_bits = dlen;
        }
        let dma = self.r(reg::DMA_CONF);
        p.dma_tx = dma & DMA_TX_ENA != 0;
        p.dma_rx = dma & DMA_RX_ENA != 0;
        p
    }

    /// Without DMA, MOSI data comes from W0..W15 (little-endian, up to 64 bytes)
    pub fn tx_buffer(&self, n: usize) -> Vec<u8> {
        (0..n.min(64))
            .map(|i| (self.regs[(reg::W0 / 4) as usize + i / 4] >> (8 * (i % 4))) as u8)
            .collect()
    }

    /// Without DMA, MISO data is written back to W0..W15
    pub fn rx_fill(&mut self, data: &[u8]) {
        for (i, b) in data.iter().take(64).enumerate() {
            let r = &mut self.regs[(reg::W0 / 4) as usize + i / 4];
            let sh = 8 * (i % 4);
            *r = (*r & !(0xff << sh)) | ((*b as u32) << sh);
        }
    }

    /// SPI clock (Hz). Source: CLK_GATE.mst_clk_sel=1 is PLL_F80M, 0 is XTAL 40MHz
    pub fn clock_hz(&self) -> u64 {
        let src: u64 = if self.r(reg::CLK_GATE) & (1 << 2) != 0 {
            80_000_000
        } else {
            40_000_000
        };
        let c = self.r(reg::CLOCK);
        if c & (1 << 31) != 0 {
            return src;
        }
        let pre = ((c >> 18) & 0xf) as u64 + 1;
        let n = ((c >> 12) & 0x3f) as u64 + 1;
        src / (pre * n)
    }

    /// Whether CS stays asserted after this transfer (MISC.cs_keep_active, set per transaction by spi_ll_master_keep_cs)
    pub fn cs_keep_active(&self) -> bool {
        self.r(reg::MISC) & MISC_CS_KEEP_ACTIVE != 0
    }

    /// Start timing: SPI clocks of all phases in CPU cycles (plus 1 SPI cycle each for CS setup / hold).
    /// A phase on n lines moves n bits per clock; dummy is already counted in clocks
    pub fn begin(&mut self, now: u64, p: &Plan, dma_out_ch: Option<usize>) {
        let clk = |bits: u32, n: u32| bits.div_ceil(n.max(1));
        let data = clk(p.mosi_bits, p.mosi_lines).max(clk(p.miso_bits, p.miso_lines));
        let clocks =
            clk(p.cmd_bits, p.cmd_lines) + clk(p.addr_bits, p.addr_lines) + p.dummy_bits + data + 2;
        let cyc = (clocks as u64 * CPU_HZ).div_ceil(self.clock_hz().max(1));
        self.pending = Some(now + cyc.max(1));
        self.dma_out_ch = dma_out_ch;
        self.transfers += 1;
        self.bytes += (p.mosi_bits as u64).div_ceil(8);
    }

    /// Advance: set TRANS_DONE when the transfer is due. Returns (next event time, just finished)
    pub fn update(&mut self, now: u64) -> (u64, bool) {
        match self.pending {
            Some(t) if now >= t => {
                self.pending = None;
                self.int_raw |= INT_TRANS_DONE;
                (u64::MAX, true)
            }
            Some(t) => (t, false),
            None => (u64::MAX, false),
        }
    }

    /// Whether CS0 takes part in the transfer (MISC.cs0_dis=0)
    pub fn cs0_enabled(&self) -> bool {
        self.r(reg::MISC) & 1 == 0
    }

    /// CS line n (0..=5) is driven by this transfer (MISC.CSn_DIS clear)
    pub fn cs_enabled(&self, n: u32) -> bool {
        n < 6 && self.r(reg::MISC) >> n & 1 == 0
    }

    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }
}

/// Line count from three consecutive dual / quad / octal bits starting at `dual`
fn lines(r: u32, dual: u32) -> u32 {
    match (r >> dual) & 7 {
        0 => 1,
        b if b & 4 != 0 => 8,
        b if b & 2 != 0 => 4,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_and_timing() {
        let mut s = GpSpi::default();
        // 40MHz: PLL 80MHz source, pre=0 n=1
        s.write(reg::CLK_GATE, 0b111);
        s.write(reg::CLOCK, 1 << 12);
        assert_eq!(s.clock_hz(), 40_000_000);
        s.write(reg::USER, USER_MOSI);
        s.write(reg::MS_DLEN, 8 * 3 - 1);
        s.write(reg::W0, 0x0033_2211);
        assert!(s.write(reg::CMD, CMD_USR));
        let p = s.plan();
        assert_eq!(p.mosi_bits, 24);
        assert_eq!(s.tx_buffer(3), vec![0x11, 0x22, 0x33]);
        s.begin(100, &p, None);
        assert!(s.read(reg::CMD) & CMD_USR != 0);
        // 26 bits x 4 cycles
        assert_eq!(s.update(100 + 103), (100 + 104, false));
        assert_eq!(s.update(100 + 104), (u64::MAX, true));
        assert_eq!(s.read(reg::CMD) & CMD_USR, 0);
        assert_eq!(s.read(reg::DMA_INT_RAW) & INT_TRANS_DONE, INT_TRANS_DONE);
        s.write(reg::DMA_INT_CLR, INT_TRANS_DONE);
        assert_eq!(s.read(reg::DMA_INT_RAW), 0);
    }

    /// Quad write (QIO data phase): 32-bit single-line command then a 480x20 RGB565 strip on four lines
    #[test]
    fn quad_timing() {
        let run = |quad: bool| {
            let mut s = GpSpi::default();
            s.write(reg::CLK_GATE, 0b111);
            s.write(reg::CLOCK, 1 << 31);
            let fw = if quad { 1 << 13 } else { 0 };
            s.write(reg::USER, USER_MOSI | fw);
            s.write(reg::MS_DLEN, 480 * 20 * 16 - 1);
            let p = s.plan();
            assert_eq!(p.mosi_lines, if quad { 4 } else { 1 });
            s.begin(0, &p, None);
            s.update(0).0
        };
        let (one, four) = (run(false), run(true));
        // 80 MHz SPI clock, CPU_HZ 160 MHz: 2 cycles per clock; data clocks quarter, the 2 CS clocks stay
        assert_eq!(one, (480 * 20 * 16 + 2) * 2);
        assert_eq!(four, (480 * 20 * 4 + 2) * 2);
        let mut s = GpSpi::default();
        s.write(reg::CTRL, 1 << 9 | 1 << 6 | 1 << 15);
        s.write(reg::USER, USER_COMMAND | 1 << 14);
        let p = s.plan();
        assert_eq!(
            (p.cmd_lines, p.addr_lines, p.mosi_lines, p.miso_lines),
            (4, 4, 8, 4)
        );
        assert_eq!(lines(1 << 8, CTRL_FCMD_DUAL), 2);
    }
}
