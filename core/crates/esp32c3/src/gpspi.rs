//! GP-SPI2 主机（通用 SPI，FSPI）。寄存器见 soc/esp32s3/register/soc/spi_reg.h（C3 同族、布局一致），
//! 驱动写法见 hal/esp32s3/include/hal/spi_ll.h。
//!
//! 执行模型与 I2C 相同：写 CMD.USR 时 SoC 立刻按 命令 → 地址 → 哑周期 → MOSI 数据 的顺序把字节交给从机
//! （数据来自 W0..W15 或 GDMA 描述符链，SoC 负责取），"传输中"状态与 TRANS_DONE 中断推迟到按 SPI 时钟
//! 算出的耗时之后。MISO 方向没有会应答的器件，读回全 1。

use crate::periph::CPU_HZ;

pub mod reg {
    pub const CMD: u32 = 0x00;
    pub const ADDR: u32 = 0x04;
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
const DMA_TX_ENA: u32 = 1 << 28;
const DMA_RX_ENA: u32 = 1 << 27;
pub const INT_TRANS_DONE: u32 = 1 << 12;

/// 一次传输各阶段（CMD.USR 时刻的寄存器快照）
#[derive(Debug, Default, Clone)]
pub struct Plan {
    /// 命令 + 地址阶段要移出的字节（按线上顺序）
    pub head: Vec<u8>,
    pub head_bits: u32,
    pub dummy_bits: u32,
    /// MOSI 数据位数（0 = 无数据阶段）
    pub mosi_bits: u32,
    pub miso_bits: u32,
    pub dma_tx: bool,
    pub dma_rx: bool,
}

pub struct GpSpi {
    pub regs: [u32; 0x100 / 4],
    pub int_raw: u32,
    pub int_ena: u32,
    /// 进行中的传输何时结束
    pending: Option<u64>,
    /// 本次传输用到的 GDMA 发送通道（结束时由 SoC 给该通道置 EOF）
    pub dma_out_ch: Option<usize>,
    pub transfers: u64,
    pub bytes: u64,
}

impl Default for GpSpi {
    fn default() -> Self {
        let mut regs = [0u32; 0x100 / 4];
        // 复位值：由 spi_reg.h 各字段注释里的 default 求得
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

    /// 写寄存器。返回 true 表示固件刚启动了一次传输（CMD.USR），SoC 接着调 `plan` / `begin`。
    pub fn write(&mut self, off: u32, v: u32) -> bool {
        match off {
            reg::CMD => {
                // UPDATE（把配置同步到 SPI 时钟域）瞬间完成；USR 由"传输中"状态代替
                self.regs[0] = v & !(CMD_USR | CMD_UPDATE);
                return v & CMD_USR != 0 && !self.busy();
            }
            reg::DMA_INT_ENA => self.int_ena = v,
            reg::DMA_INT_CLR => self.int_raw &= !v,
            reg::DMA_INT_SET => self.int_raw |= v,
            // C3 的驱动直接写 RAW 清 trans_done（spi_ll_clear_int_stat：dma_int_raw.trans_done = 0），
            // RAW 在 C3 上是 R/W/WTC；S3 走 INT_CLR，不写这里
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

    /// 本次传输的各阶段
    pub fn plan(&self) -> Plan {
        let user = self.r(reg::USER);
        let user1 = self.r(reg::USER1);
        let user2 = self.r(reg::USER2);
        let mut p = Plan::default();
        if user & USER_COMMAND != 0 {
            // 命令值按 bit7..0 再 bit15..8 的顺序移出（spi_ll_set_command 已为 MSB 先发做了交换）
            let bits = ((user2 >> 28) & 0xf) + 1;
            let val = user2 & 0xffff;
            p.head.push(val as u8);
            if bits > 8 {
                p.head.push((val >> 8) as u8);
            }
            p.head_bits += bits;
        }
        if user & USER_ADDR != 0 {
            // 地址从 ADDR 寄存器最高位开始移出
            let bits = ((user1 >> 27) & 0x1f) + 1;
            let a = self.r(reg::ADDR);
            for i in 0..bits.div_ceil(8) {
                p.head.push((a >> (24 - 8 * i)) as u8);
            }
            p.head_bits += bits;
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

    /// 不用 DMA 时 MOSI 数据来自 W0..W15（小端字节序，最多 64 字节）
    pub fn tx_buffer(&self, n: usize) -> Vec<u8> {
        (0..n.min(64))
            .map(|i| (self.regs[(reg::W0 / 4) as usize + i / 4] >> (8 * (i % 4))) as u8)
            .collect()
    }

    /// 不用 DMA 时 MISO 数据写回 W0..W15
    pub fn rx_fill(&mut self, data: &[u8]) {
        for (i, b) in data.iter().take(64).enumerate() {
            let r = &mut self.regs[(reg::W0 / 4) as usize + i / 4];
            let sh = 8 * (i % 4);
            *r = (*r & !(0xff << sh)) | ((*b as u32) << sh);
        }
    }

    /// SPI 时钟（Hz）。源时钟：CLK_GATE.mst_clk_sel=1 为 PLL_F80M，0 为 XTAL 40MHz
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

    /// 开始计时：总位数按 SPI 时钟折合 CPU 周期（另加 CS 建立 / 保持各 1 个 SPI 周期）
    pub fn begin(&mut self, now: u64, p: &Plan, dma_out_ch: Option<usize>) {
        let bits = (p.head_bits + p.dummy_bits + p.mosi_bits.max(p.miso_bits) + 2) as u64;
        let cyc = (bits * CPU_HZ).div_ceil(self.clock_hz().max(1));
        self.pending = Some(now + cyc.max(1));
        self.dma_out_ch = dma_out_ch;
        self.transfers += 1;
        self.bytes += (p.mosi_bits as u64).div_ceil(8);
    }

    /// 推进：传输到点就置 TRANS_DONE。返回（下一个事件时刻，本次是否刚结束）
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

    /// 片选 CS0 是否参与传输（MISC.cs0_dis=0）
    pub fn cs0_enabled(&self) -> bool {
        self.r(reg::MISC) & 1 == 0
    }

    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_and_timing() {
        let mut s = GpSpi::default();
        // 40MHz：PLL 80MHz 源，pre=0 n=1
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
        // 26 位 × 4 周期
        assert_eq!(s.update(100 + 103), (100 + 104, false));
        assert_eq!(s.update(100 + 104), (u64::MAX, true));
        assert_eq!(s.read(reg::CMD) & CMD_USR, 0);
        assert_eq!(s.read(reg::DMA_INT_RAW) & INT_TRANS_DONE, INT_TRANS_DONE);
        s.write(reg::DMA_INT_CLR, INT_TRANS_DONE);
        assert_eq!(s.read(reg::DMA_INT_RAW), 0);
    }
}
