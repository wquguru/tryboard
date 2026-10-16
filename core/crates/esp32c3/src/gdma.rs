//! GDMA（通用 DMA）：每通道一对 IN / OUT 链表 DMA，通过 PERI_SEL 接到外设（SPI2 = 0）。
//! 寄存器见 soc/esp32s3/register/soc/gdma_reg.h、soc/esp32c3/register/soc/gdma_reg.h，
//! 驱动写法见 hal/esp32s3/include/hal/gdma_ll.h、hal/esp32c3/include/hal/gdma_ll.h（C3 是 ahb_dma v1）。
//! 两颗芯片的通道组排布不同：S3 每个方向自带一组中断寄存器；C3 的中断寄存器集中在 0x00 起、
//! 每通道一组、IN / OUT 共用，通道组从 0x70 开始，组内偏移也不同。这些差异都放在 `GdmaLayout` 里。
//!
//! 不模拟 FIFO 与突发：外设（SPI2、C3 的 AES / SHA）开始传输时由 SoC 调 `take_out` 一次性沿描述符链取出全部数据，
//! 传输结束时调 `out_done` 置 OUT_DONE / OUT_EOF / OUT_TOTAL_EOF。
//! 描述符（dma_descriptor_t）：字 0 = size[11:0] | length[23:12] | suc_eof[30] | owner[31]，字 1 = 缓冲区，字 2 = 下一个。

/// 外设访问内存的接口（SoC 实现）
pub trait DmaMem {
    fn rd8(&mut self, a: u32) -> u8;
    fn rd32(&mut self, a: u32) -> u32;
    fn wr32(&mut self, a: u32, v: u32);
}

/// 寄存器排布（按芯片参数化）
#[derive(Clone, Copy, Debug)]
pub struct GdmaLayout {
    pub nch: usize,
    /// 第 0 通道组的起点
    pub ch_base: u32,
    /// 通道间距
    pub stride: u32,
    /// OUT 寄存器组相对通道起点的偏移
    pub out_off: u32,
    /// 组内偏移（IN / OUT 两组相同）：LINK、PERI_SEL、EOF 描述符地址、FIFO 状态
    pub link: u32,
    pub peri_sel: u32,
    pub eof_des: u32,
    pub fifo_status: u32,
    /// true：中断寄存器在每个方向的组内 +0x08（S3）；false：集中在 0x00 + ch×0x10、IN / OUT 共用（C3）
    pub int_in_dir: bool,
    /// 链表地址寄存器只有低 20 位，高位固定为内部 SRAM 的 D 总线基址
    pub link_base: u32,
    /// 复位值：OUT_CONF0（S3 的 out_eof_mode 默认 1）、IN_CONF1、IN / OUT FIFO 状态（空）
    pub rst_out_conf0: u32,
    pub rst_in_conf1: u32,
    pub rst_infifo: u32,
    pub rst_outfifo: u32,
}

impl GdmaLayout {
    /// ESP32-S3：5 个通道，间距 0xC0，OUT 在 +0x60
    pub const S3: GdmaLayout = GdmaLayout {
        nch: 5,
        ch_base: 0,
        stride: 0xc0,
        out_off: 0x60,
        link: 0x20,
        peri_sel: 0x48,
        eof_des: 0x28,
        fifo_status: 0x18,
        int_in_dir: true,
        link_base: 0x3fc0_0000,
        rst_out_conf0: 0x8,
        rst_in_conf1: 0xc,
        rst_infifo: 0x0f00_003a,
        rst_outfifo: 0x0780_002a,
    };
    /// ESP32-C3：3 个通道，通道组从 0x70 起、间距 0xC0，OUT 在 +0x60（IN_CONF0_CH0 = 0x70，OUT_CONF0_CH0 = 0xD0）
    pub const C3: GdmaLayout = GdmaLayout {
        nch: 3,
        ch_base: 0x70,
        stride: 0xc0,
        out_off: 0x60,
        link: 0x10,
        peri_sel: 0x30,
        eof_des: 0x18,
        fifo_status: 0x08,
        int_in_dir: false,
        link_base: 0x3fc0_0000,
        rst_out_conf0: 0,
        rst_in_conf1: 0,
        // FIFO 空、REMAIN_UNDER_1..4B 全置
        rst_infifo: 0x0780_0002,
        rst_outfifo: 0x0780_0002,
    };
}

// 组内偏移（两颗芯片相同）
const CONF0: u32 = 0x00;
// S3 每个方向组内的中断寄存器
const INT_RAW: u32 = 0x08;
const INT_ST: u32 = 0x0c;
const INT_ENA: u32 = 0x10;
const INT_CLR: u32 = 0x14;

/// C3 共用中断寄存器的位（gdma_reg.h GDMA_*_CH0_INT_RAW_S）与本模型按方向存的位（S3 排布）之间的映射：
/// (方向组内位, 共用寄存器位, 是否 OUT)
const C3_INT_MAP: [(u32, u32, bool); 9] = [
    (0, 0, false), // IN_DONE
    (1, 1, false), // IN_SUC_EOF
    (2, 2, false), // IN_ERR_EOF
    (3, 5, false), // IN_DSCR_ERR
    (4, 7, false), // IN_DSCR_EMPTY
    (0, 3, true),  // OUT_DONE
    (1, 4, true),  // OUT_EOF
    (2, 6, true),  // OUT_DSCR_ERR
    (3, 8, true),  // OUT_TOTAL_EOF
];

pub mod out_int {
    pub const DONE: u32 = 1 << 0;
    pub const EOF: u32 = 1 << 1;
    pub const DSCR_ERR: u32 = 1 << 2;
    pub const TOTAL_EOF: u32 = 1 << 3;
}

#[derive(Clone, Copy, Default)]
pub struct Dir {
    pub int_raw: u32,
    pub int_ena: u32,
    /// 链表起点（完整地址）与是否已启动
    pub link: u32,
    pub started: bool,
    pub peri_sel: u32,
    pub eof_desc: u32,
}

pub struct Gdma {
    pub layout: GdmaLayout,
    pub regs: Vec<u32>,
    pub out: Vec<Dir>,
    pub inn: Vec<Dir>,
    /// 累计搬运的字节数（调试用）
    pub out_bytes: u64,
}

impl Gdma {
    pub fn new(layout: GdmaLayout) -> Self {
        let d = Dir {
            peri_sel: 0x3f,
            ..Default::default()
        };
        let mut regs = vec![0u32; 0x1000 / 4];
        for ch in 0..layout.nch as u32 {
            let base = layout.ch_base + ch * layout.stride;
            // 复位值（gdma_reg.h）：OUT_CONF0、IN_CONF1、FIFO 状态"空"
            let mut set = |o: u32, v: u32| regs[(o / 4) as usize] = v;
            set(base + layout.out_off, layout.rst_out_conf0);
            set(base + 0x04, layout.rst_in_conf1);
            set(base + layout.fifo_status, layout.rst_infifo);
            set(base + layout.out_off + layout.fifo_status, layout.rst_outfifo);
            // PERI_SEL 复位为 63（未接）
            set(base + layout.peri_sel, 0x3f);
            set(base + layout.out_off + layout.peri_sel, 0x3f);
        }
        Gdma {
            layout,
            regs,
            out: vec![d; layout.nch],
            inn: vec![d; layout.nch],
            out_bytes: 0,
        }
    }

    /// 不占内存的空壳：SoC 临时把真 GDMA 取出来、借总线访问内存时占位
    pub fn placeholder() -> Self {
        Gdma {
            layout: GdmaLayout {
                nch: 0,
                ..GdmaLayout::S3
            },
            regs: Vec::new(),
            out: Vec::new(),
            inn: Vec::new(),
            out_bytes: 0,
        }
    }

    /// 偏移 → (通道, 是否 OUT 组, 组内偏移)
    fn decode(&self, off: u32) -> Option<(usize, bool, u32)> {
        let off = off.checked_sub(self.layout.ch_base)?;
        let ch = (off / self.layout.stride) as usize;
        if ch >= self.layout.nch {
            return None;
        }
        let o = off % self.layout.stride;
        Some(if o >= self.layout.out_off {
            (ch, true, o - self.layout.out_off)
        } else {
            (ch, false, o)
        })
    }

    /// C3 共用中断寄存器：偏移 → (通道, 寄存器号 0 RAW / 1 ST / 2 ENA / 3 CLR)
    fn decode_shared_int(&self, off: u32) -> Option<(usize, u32)> {
        if self.layout.int_in_dir {
            return None;
        }
        let ch = (off / 0x10) as usize;
        (ch < self.layout.nch).then_some((ch, (off % 0x10) / 4))
    }

    /// 把两个方向的中断位拼成 C3 共用寄存器的值
    fn shared_bits(&self, ch: usize, ena: bool) -> u32 {
        let mut v = 0;
        for &(dir_bit, bit, out) in &C3_INT_MAP {
            let d = if out { &self.out[ch] } else { &self.inn[ch] };
            let x = if ena { d.int_ena } else { d.int_raw };
            v |= ((x >> dir_bit) & 1) << bit;
        }
        v
    }

    /// C3 共用寄存器的值拆回两个方向（返回 (IN 位, OUT 位)）
    fn split_bits(v: u32) -> (u32, u32) {
        let (mut i, mut o) = (0, 0);
        for &(dir_bit, bit, out) in &C3_INT_MAP {
            let b = ((v >> bit) & 1) << dir_bit;
            if out {
                o |= b;
            } else {
                i |= b;
            }
        }
        (i, o)
    }

    pub fn read(&self, off: u32) -> u32 {
        if let Some((ch, r)) = self.decode_shared_int(off) {
            return match r {
                0 => self.shared_bits(ch, false),
                1 => self.shared_bits(ch, false) & self.shared_bits(ch, true),
                2 => self.shared_bits(ch, true),
                _ => 0,
            };
        }
        let l = self.layout;
        if let Some((ch, out, o)) = self.decode(off) {
            let d = if out { &self.out[ch] } else { &self.inn[ch] };
            if l.int_in_dir {
                match o {
                    INT_RAW => return d.int_raw,
                    INT_ST => return d.int_raw & d.int_ena,
                    INT_ENA => return d.int_ena,
                    INT_CLR => return 0,
                    _ => {}
                }
            }
            if o == l.link {
                // 链表寄存器：start / stop / restart 自清，park=1（空闲）——取数据瞬间完成
                let park = if out { 1 << 23 } else { 1 << 24 };
                let v = self.regs[(off / 4) as usize];
                return (v & 0xf_ffff) | park | if out { 0 } else { v & (1 << 20) };
            }
            if o == l.peri_sel {
                return d.peri_sel;
            }
            // OUT_EOF_DES_ADDR / IN_SUC_EOF_DES_ADDR
            if o == l.eof_des {
                return d.eof_desc;
            }
        }
        self.regs.get((off / 4) as usize).copied().unwrap_or(0)
    }

    pub fn write(&mut self, off: u32, v: u32) {
        if let Some((ch, r)) = self.decode_shared_int(off) {
            let (i, o) = Self::split_bits(v);
            match r {
                2 => {
                    self.inn[ch].int_ena = i;
                    self.out[ch].int_ena = o;
                }
                3 => {
                    self.inn[ch].int_raw &= !i;
                    self.out[ch].int_raw &= !o;
                }
                _ => {}
            }
            return;
        }
        if let Some(r) = self.regs.get_mut((off / 4) as usize) {
            *r = v;
        }
        let Some((ch, out, o)) = self.decode(off) else {
            return;
        };
        let l = self.layout;
        let d = if out {
            &mut self.out[ch]
        } else {
            &mut self.inn[ch]
        };
        if l.int_in_dir {
            match o {
                INT_ENA => d.int_ena = v,
                INT_CLR => d.int_raw &= !v,
                _ => {}
            }
        }
        if o == CONF0 {
            // out_rst / in_rst：复位通道状态机
            if v & 1 != 0 {
                d.started = false;
            }
        } else if o == l.peri_sel {
            d.peri_sel = v & 0x3f;
        } else if o == l.link {
            // OUT：stop 20、start 21、restart 22；IN：stop 21、start 22、restart 23
            let (stop, start, restart) = if out { (20, 21, 22) } else { (21, 22, 23) };
            if v & (1 << stop) != 0 {
                d.started = false;
            }
            if v & (1 << start) != 0 {
                d.link = l.link_base | (v & 0xf_ffff);
                d.started = true;
            }
            if v & (1 << restart) != 0 {
                d.started = true;
            }
        }
    }

    /// 接到外设 `peri` 的通道当前配置的链表头（不管是否已启动）。
    /// C3 的 AES / SHA 在置 start 之前就可能先配好链表，按 PERI_SEL 找通道即可
    pub fn channel_for_peri(&self, peri: u32, out: bool) -> Option<usize> {
        (0..self.layout.nch).find(|&c| {
            let d = if out { &self.out[c] } else { &self.inn[c] };
            d.peri_sel == peri
        })
    }

    /// 通道 ch 的链表头（LINK 寄存器低 20 位 + SRAM 基址），用于还没置 start 的情况
    pub fn configured_link(&self, ch: usize, out: bool) -> u32 {
        let l = self.layout;
        let off = l.ch_base + ch as u32 * l.stride + if out { l.out_off } else { 0 } + l.link;
        l.link_base | (self.regs[(off / 4) as usize] & 0xf_ffff)
    }

    /// 接到外设 `peri`（SPI2 = 0）且已启动的发送通道
    pub fn out_channel_for(&self, peri: u32) -> Option<usize> {
        (0..self.layout.nch).find(|&c| self.out[c].started && self.out[c].peri_sel == peri)
    }

    /// 接到外设 `peri` 且已启动的接收通道
    pub fn in_channel_for(&self, peri: u32) -> Option<usize> {
        (0..self.layout.nch).find(|&c| self.inn[c].started && self.inn[c].peri_sel == peri)
    }

    /// 沿发送通道 ch 的描述符链取出数据（最多 max 字节）。遇 suc_eof 或空指针结束；
    /// OUT_CONF0.out_auto_wrback 置位时把描述符的 owner 交还 CPU。
    pub fn take_out(&mut self, ch: usize, max: usize, mem: &mut dyn DmaMem) -> Vec<u8> {
        let auto_wb = self.regs[((self.layout.ch_base
            + ch as u32 * self.layout.stride
            + self.layout.out_off)
            / 4) as usize]
            & (1 << 2)
            != 0;
        let d = &mut self.out[ch];
        let mut data = Vec::with_capacity(max.min(1 << 16));
        let mut desc = d.link;
        // 防止固件把链表连成环导致死循环
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
            if auto_wb {
                mem.wr32(desc, w0 & !(1 << 31));
            }
            d.eof_desc = desc;
            if w0 & (1 << 30) != 0 {
                break;
            }
            desc = next;
        }
        d.started = false;
        self.out_bytes += data.len() as u64;
        data
    }

    /// 把数据写进接收通道 ch 的描述符链（填满 size 再进下一个），最后一个用到的描述符置 suc_eof
    pub fn put_in(&mut self, ch: usize, data: &[u8], mem: &mut dyn DmaMem) {
        let d = &mut self.inn[ch];
        let mut desc = d.link;
        let mut pos = 0;
        for _ in 0..4096 {
            if desc == 0 {
                break;
            }
            let w0 = mem.rd32(desc);
            let buf = mem.rd32(desc + 4);
            let next = mem.rd32(desc + 8);
            let size = (w0 & 0xfff) as usize;
            let n = size.min(data.len() - pos);
            for i in 0..n {
                let a = buf + i as u32;
                let w = mem.rd32(a & !3);
                let sh = (a & 3) * 8;
                mem.wr32(a & !3, (w & !(0xff << sh)) | ((data[pos + i] as u32) << sh));
            }
            pos += n;
            let last = pos >= data.len() || next == 0;
            let w0n = (w0 & !(0xfff << 12) & !(1 << 31) & !(1 << 30))
                | ((n as u32) << 12)
                | if last { 1 << 30 } else { 0 };
            mem.wr32(desc, w0n);
            d.eof_desc = desc;
            if last {
                break;
            }
            desc = next;
        }
        d.started = false;
        // IN_DONE | IN_SUC_EOF
        d.int_raw |= 0b11;
    }

    /// 发送通道 ch 的数据已全部送出
    pub fn out_done(&mut self, ch: usize) {
        if let Some(d) = self.out.get_mut(ch) {
            d.int_raw |= out_int::DONE | out_int::EOF | out_int::TOTAL_EOF;
        }
    }

    pub fn out_irq(&self, ch: usize) -> bool {
        self.out[ch].int_raw & self.out[ch].int_ena != 0
    }

    pub fn in_irq(&self, ch: usize) -> bool {
        self.inn[ch].int_raw & self.inn[ch].int_ena != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Ram(Vec<u8>);
    const BASE: u32 = 0x3fc8_8000;
    impl DmaMem for Ram {
        fn rd8(&mut self, a: u32) -> u8 {
            self.0[(a - BASE) as usize]
        }
        fn rd32(&mut self, a: u32) -> u32 {
            let o = (a - BASE) as usize;
            u32::from_le_bytes(self.0[o..o + 4].try_into().unwrap())
        }
        fn wr32(&mut self, a: u32, v: u32) {
            let o = (a - BASE) as usize;
            self.0[o..o + 4].copy_from_slice(&v.to_le_bytes());
        }
    }

    #[test]
    fn walks_descriptor_chain() {
        let mut m = Ram(vec![0; 0x1000]);
        // 两个描述符：3 字节 + 2 字节（第二个 suc_eof）
        let (d0, d1, b0, b1) = (BASE, BASE + 0x10, BASE + 0x100, BASE + 0x200);
        m.wr32(d0, (1 << 31) | (3 << 12) | 4);
        m.wr32(d0 + 4, b0);
        m.wr32(d0 + 8, d1);
        m.wr32(d1, (1 << 31) | (1 << 30) | (2 << 12) | 4);
        m.wr32(d1 + 4, b1);
        m.wr32(d1 + 8, 0);
        m.wr32(b0, 0x0033_2211);
        m.wr32(b1, 0x0000_5544);
        let l = GdmaLayout::S3;
        let mut g = Gdma::new(l);
        let out0 = l.out_off;
        g.write(out0, 1 << 2); // auto writeback
        g.write(out0 + l.peri_sel, 0);
        g.write(out0 + l.link, (1 << 21) | (d0 & 0xf_ffff));
        assert_eq!(g.out_channel_for(0), Some(0));
        assert_eq!(
            g.take_out(0, 100, &mut m),
            vec![0x11, 0x22, 0x33, 0x44, 0x55]
        );
        assert_eq!(m.rd32(d0) >> 31, 0, "owner 交还 CPU");
        assert_eq!(g.read(out0 + 0x28), d1);
        g.write(out0 + INT_ENA, out_int::EOF);
        g.out_done(0);
        assert!(g.out_irq(0));
        g.write(out0 + INT_CLR, 0xf);
        assert!(!g.out_irq(0));
    }

    #[test]
    fn c3_layout_shared_interrupts() {
        let mut m = Ram(vec![0; 0x1000]);
        let (d0, b0) = (BASE, BASE + 0x100);
        m.wr32(d0, (1 << 31) | (1 << 30) | (4 << 12) | 4);
        m.wr32(d0 + 4, b0);
        m.wr32(d0 + 8, 0);
        m.wr32(b0, 0x4433_2211);
        let l = GdmaLayout::C3;
        let mut g = Gdma::new(l);
        // 通道 1：OUT_PERI_SEL_CH1 = 0x1c0，OUT_LINK_CH1 = 0x1a0（gdma_reg.h）
        assert_eq!(g.read(0x1c0), 0x3f, "复位未接外设");
        g.write(0x1c0, 0);
        g.write(0x1a0, (1 << 21) | (d0 & 0xf_ffff));
        assert_eq!(g.out_channel_for(0), Some(1));
        assert_eq!(g.take_out(1, 100, &mut m), vec![0x11, 0x22, 0x33, 0x44]);
        assert_eq!(g.read(0x1a8), d0, "OUT_EOF_DES_ADDR_CH1");
        // INT_ENA_CH1 = 0x18：OUT_EOF 是第 4 位；INT_RAW_CH1 = 0x10
        g.write(0x18, 1 << 4);
        g.out_done(1);
        assert!(g.out_irq(1));
        assert_eq!(g.read(0x10), (1 << 3) | (1 << 4) | (1 << 8));
        assert_eq!(g.read(0x14), 1 << 4, "INT_ST = RAW & ENA");
        g.write(0x1c, 1 << 4);
        assert!(!g.out_irq(1));
        assert_eq!(g.read(0x10), (1 << 3) | (1 << 8));
        // IN 方向：IN_PERI_SEL_CH0 = 0xa0、IN_LINK_CH0 = 0x80
        g.write(0xa0, 6);
        g.write(0x80, d0 & 0xf_ffff);
        assert_eq!(g.channel_for_peri(6, false), Some(0));
        assert_eq!(g.configured_link(0, false), d0);
    }
}
