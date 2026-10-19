//! GDMA: per channel an IN / OUT linked-list DMA pair, attached to a peripheral via PERI_SEL (SPI2 = 0). Registers in soc/esp32{s3,c3}/register/soc/gdma_reg.h,
//! drivers in hal/esp32{s3,c3}/include/hal/gdma_ll.h (C3 is ahb_dma v1). Layouts differ (S3: interrupt regs per direction; C3: shared per channel at 0x00,
//! channel groups from 0x70 with other offsets); all in `GdmaLayout`. No FIFO/burst model: block peripherals (SPI2, C3 AES/SHA) pull the whole chain via
//! `take_out` at start and `out_done` sets OUT_DONE / OUT_EOF / OUT_TOTAL_EOF. Streaming I2S consumes the ring one descriptor at a time (`out_next` / `out_eof`,
//! `in_peek` / `in_fill`): DONE per descriptor, EOF on suc_eof (address latched), stop at next = 0. dma_descriptor_t word 0 = size[11:0] | length[23:12] |
//! suc_eof[30] | owner[31], word 1 = buffer, word 2 = next. (lint: allow-long-comment)

/// Interface for peripherals to access memory (implemented by the SoC); shares tryboard-soc's definition with the Wi-Fi MAC
pub use tryboard_soc::Mem as DmaMem;

/// Register layout (parameterized per chip)
#[derive(Clone, Copy, Debug)]
pub struct GdmaLayout {
    pub nch: usize,
    /// Start of channel group 0
    pub ch_base: u32,
    /// Channel stride
    pub stride: u32,
    /// Offset of the OUT register group from the channel start
    pub out_off: u32,
    /// In-group offsets (same for IN / OUT): LINK, PERI_SEL, EOF descriptor address, FIFO status
    pub link: u32,
    pub peri_sel: u32,
    pub eof_des: u32,
    pub fifo_status: u32,
    /// true: interrupt regs at +0x08 inside each direction group (S3); false: shared at 0x00 + ch*0x10 for IN / OUT (C3)
    pub int_in_dir: bool,
    /// Link address registers hold only the low 20 bits; high bits are fixed to internal SRAM's D-bus base
    pub link_base: u32,
    /// Reset values: OUT_CONF0 (S3 out_eof_mode defaults to 1), IN_CONF1, IN / OUT FIFO status (empty)
    pub rst_out_conf0: u32,
    pub rst_in_conf1: u32,
    pub rst_infifo: u32,
    pub rst_outfifo: u32,
}

impl GdmaLayout {
    /// ESP32-S3: 5 channels, stride 0xC0, OUT at +0x60
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
    /// ESP32-C3: 3 channels, groups from 0x70 with stride 0xC0, OUT at +0x60 (IN_CONF0_CH0 = 0x70, OUT_CONF0_CH0 = 0xD0)
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
        // FIFO empty, REMAIN_UNDER_1..4B all set
        rst_infifo: 0x0780_0002,
        rst_outfifo: 0x0780_0002,
    };
}

// In-group offsets (same on both chips)
const CONF0: u32 = 0x00;
// S3 per-direction interrupt registers
const INT_RAW: u32 = 0x08;
const INT_ST: u32 = 0x0c;
const INT_ENA: u32 = 0x10;
const INT_CLR: u32 = 0x14;

/// Map between C3 shared interrupt bits (gdma_reg.h GDMA_*_CH0_INT_RAW_S) and this model's per-direction bits (S3 layout):
/// (in-group bit, shared register bit, is OUT)
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
    /// Link start (full address) and whether started
    pub link: u32,
    pub started: bool,
    pub peri_sel: u32,
    pub eof_desc: u32,
    /// Descriptor a streaming peripheral (I2S) is on (= link at start, moves to next when done)
    pub cur: u32,
}

pub struct Gdma {
    pub layout: GdmaLayout,
    pub regs: Vec<u32>,
    pub out: Vec<Dir>,
    pub inn: Vec<Dir>,
    /// Total bytes moved (debug)
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
            // Reset values (gdma_reg.h): OUT_CONF0, IN_CONF1, FIFO status "empty"
            let mut set = |o: u32, v: u32| regs[(o / 4) as usize] = v;
            set(base + layout.out_off, layout.rst_out_conf0);
            set(base + 0x04, layout.rst_in_conf1);
            set(base + layout.fifo_status, layout.rst_infifo);
            set(
                base + layout.out_off + layout.fifo_status,
                layout.rst_outfifo,
            );
            // PERI_SEL resets to 63 (unconnected)
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

    /// Empty shell with no memory: placeholder while the SoC temporarily takes the real GDMA out to borrow the bus
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

    /// Offset -> (channel, is OUT group, in-group offset)
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

    /// C3 shared interrupt registers: offset -> (channel, register 0 RAW / 1 ST / 2 ENA / 3 CLR)
    fn decode_shared_int(&self, off: u32) -> Option<(usize, u32)> {
        if self.layout.int_in_dir {
            return None;
        }
        let ch = (off / 0x10) as usize;
        (ch < self.layout.nch).then_some((ch, (off % 0x10) / 4))
    }

    /// Combine both directions' interrupt bits into the C3 shared register value
    fn shared_bits(&self, ch: usize, ena: bool) -> u32 {
        let mut v = 0;
        for &(dir_bit, bit, out) in &C3_INT_MAP {
            let d = if out { &self.out[ch] } else { &self.inn[ch] };
            let x = if ena { d.int_ena } else { d.int_raw };
            v |= ((x >> dir_bit) & 1) << bit;
        }
        v
    }

    /// Split a C3 shared register value back into directions (returns (IN bits, OUT bits))
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
                // Link register: start / stop / restart self-clear, park=1 (idle) -- fetching completes instantly
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
            // out_rst / in_rst: reset the channel state machine
            if v & 1 != 0 {
                d.started = false;
            }
        } else if o == l.peri_sel {
            d.peri_sel = v & 0x3f;
        } else if o == l.link {
            // OUT: stop 20, start 21, restart 22; IN: stop 21, start 22, restart 23
            let (stop, start, restart) = if out { (20, 21, 22) } else { (21, 22, 23) };
            if v & (1 << stop) != 0 {
                d.started = false;
            }
            if v & (1 << start) != 0 {
                d.link = l.link_base | (v & 0xf_ffff);
                d.cur = d.link;
                d.started = true;
            }
            if v & (1 << restart) != 0 {
                d.started = true;
            }
        }
    }

    /// Channel wired to peripheral `peri` per PERI_SEL, started or not:
    /// the C3's AES / SHA may configure the link before setting start
    pub fn channel_for_peri(&self, peri: u32, out: bool) -> Option<usize> {
        (0..self.layout.nch).find(|&c| {
            let d = if out { &self.out[c] } else { &self.inn[c] };
            d.peri_sel == peri
        })
    }

    /// Channel ch's link head (low 20 bits of LINK + SRAM base), for when start isn't set yet
    pub fn configured_link(&self, ch: usize, out: bool) -> u32 {
        let l = self.layout;
        let off = l.ch_base + ch as u32 * l.stride + if out { l.out_off } else { 0 } + l.link;
        l.link_base | (self.regs[(off / 4) as usize] & 0xf_ffff)
    }

    /// Started TX channel wired to peripheral `peri` (SPI2 = 0)
    pub fn out_channel_for(&self, peri: u32) -> Option<usize> {
        (0..self.layout.nch).find(|&c| self.out[c].started && self.out[c].peri_sel == peri)
    }

    /// Started RX channel wired to peripheral `peri`
    pub fn in_channel_for(&self, peri: u32) -> Option<usize> {
        (0..self.layout.nch).find(|&c| self.inn[c].started && self.inn[c].peri_sel == peri)
    }

    /// Pull data along TX channel ch's descriptor chain (up to max bytes), stopping at suc_eof or a null pointer;
    /// hands owner back to the CPU when OUT_CONF0.out_auto_wrback is set.
    pub fn take_out(&mut self, ch: usize, max: usize, mem: &mut dyn DmaMem) -> Vec<u8> {
        let auto_wb =
            self.regs[((self.layout.ch_base + ch as u32 * self.layout.stride + self.layout.out_off)
                / 4) as usize]
                & (1 << 2)
                != 0;
        let d = &mut self.out[ch];
        let mut data = Vec::with_capacity(max.min(1 << 16));
        let mut desc = d.link;
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

    /// Write data into RX channel ch's descriptor chain (fill size, then next); set suc_eof on the last one used
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

    /// Streaming TX: take the current descriptor's data (length bytes) on channel ch and move to the next.
    /// Returns (descriptor address, data, has suc_eof, is last in chain); None if not started or at the end
    pub fn out_next(
        &mut self,
        ch: usize,
        mem: &mut dyn DmaMem,
    ) -> Option<(u32, Vec<u8>, bool, bool)> {
        let conf0 =
            self.regs[((self.layout.ch_base + ch as u32 * self.layout.stride + self.layout.out_off)
                / 4) as usize];
        let d = self.out.get_mut(ch)?;
        if !d.started || d.cur == 0 {
            return None;
        }
        let desc = d.cur;
        let w0 = mem.rd32(desc);
        let buf = mem.rd32(desc + 4);
        let next = mem.rd32(desc + 8);
        let len = ((w0 >> 12) & 0xfff) as usize;
        let data: Vec<u8> = (0..len as u32).map(|i| mem.rd8(buf + i)).collect();
        // out_auto_wrback: hand owner back after reading
        if conf0 & (1 << 2) != 0 {
            mem.wr32(desc, w0 & !(1 << 31));
        }
        d.cur = next;
        if next == 0 {
            d.started = false;
        }
        self.out_bytes += len as u64;
        Some((desc, data, w0 & (1 << 30) != 0, next == 0))
    }

    /// Streaming TX: descriptor desc's data has been sent (I2S finished playing this block)
    pub fn out_eof(&mut self, ch: usize, desc: u32, eof: bool, last: bool) {
        if let Some(d) = self.out.get_mut(ch) {
            d.int_raw |= out_int::DONE;
            if eof {
                d.int_raw |= out_int::EOF;
                d.eof_desc = desc;
            }
            if last {
                d.int_raw |= out_int::TOTAL_EOF;
            }
        }
    }

    /// Streaming RX: the descriptor channel ch writes next (address, size)
    pub fn in_peek(&self, ch: usize, mem: &mut dyn DmaMem) -> Option<(u32, usize)> {
        let d = self.inn.get(ch)?;
        if !d.started || d.cur == 0 {
            return None;
        }
        Some((d.cur, (mem.rd32(d.cur) & 0xfff) as usize))
    }

    /// Streaming RX: write a block into descriptor desc (must still be current), length = data length, owner back to the CPU;
    /// on eof set suc_eof, raise IN_SUC_EOF and latch the descriptor address. Returns whether it was written
    pub fn in_fill(
        &mut self,
        ch: usize,
        desc: u32,
        data: &[u8],
        eof: bool,
        mem: &mut dyn DmaMem,
    ) -> bool {
        let Some(d) = self.inn.get_mut(ch) else {
            return false;
        };
        if !d.started || d.cur != desc {
            return false;
        }
        let w0 = mem.rd32(desc);
        let buf = mem.rd32(desc + 4);
        let next = mem.rd32(desc + 8);
        let n = data.len().min((w0 & 0xfff) as usize);
        let mut i = 0;
        while i < n {
            let a = buf + i as u32;
            if a & 3 == 0 && i + 4 <= n {
                mem.wr32(
                    a,
                    u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]),
                );
                i += 4;
            } else {
                let w = mem.rd32(a & !3);
                let sh = (a & 3) * 8;
                mem.wr32(a & !3, (w & !(0xff << sh)) | ((data[i] as u32) << sh));
                i += 1;
            }
        }
        let w0n = (w0 & 0xfff) | ((n as u32) << 12) | if eof { 1 << 30 } else { 0 };
        mem.wr32(desc, w0n);
        // IN_DONE; IN_SUC_EOF
        d.int_raw |= 1;
        if eof {
            d.int_raw |= 2;
            d.eof_desc = desc;
        }
        d.cur = next;
        if next == 0 {
            d.started = false;
            // IN_DSCR_EMPTY: chain exhausted
            d.int_raw |= 1 << 4;
        }
        true
    }

    /// All data on TX channel ch has been sent
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
        fn wr8(&mut self, a: u32, v: u8) {
            self.0[(a - BASE) as usize] = v;
        }
        fn wr32(&mut self, a: u32, v: u32) {
            let o = (a - BASE) as usize;
            self.0[o..o + 4].copy_from_slice(&v.to_le_bytes());
        }
    }

    #[test]
    fn walks_descriptor_chain() {
        let mut m = Ram(vec![0; 0x1000]);
        // Two descriptors: 3 bytes + 2 bytes (second has suc_eof)
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
        assert_eq!(m.rd32(d0) >> 31, 0, "owner handed back to CPU");
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
        // Channel 1: OUT_PERI_SEL_CH1 = 0x1c0, OUT_LINK_CH1 = 0x1a0 (gdma_reg.h)
        assert_eq!(g.read(0x1c0), 0x3f, "unconnected after reset");
        g.write(0x1c0, 0);
        g.write(0x1a0, (1 << 21) | (d0 & 0xf_ffff));
        assert_eq!(g.out_channel_for(0), Some(1));
        assert_eq!(g.take_out(1, 100, &mut m), vec![0x11, 0x22, 0x33, 0x44]);
        assert_eq!(g.read(0x1a8), d0, "OUT_EOF_DES_ADDR_CH1");
        // INT_ENA_CH1 = 0x18: OUT_EOF is bit 4; INT_RAW_CH1 = 0x10
        g.write(0x18, 1 << 4);
        g.out_done(1);
        assert!(g.out_irq(1));
        assert_eq!(g.read(0x10), (1 << 3) | (1 << 4) | (1 << 8));
        assert_eq!(g.read(0x14), 1 << 4, "INT_ST = RAW & ENA");
        g.write(0x1c, 1 << 4);
        assert!(!g.out_irq(1));
        assert_eq!(g.read(0x10), (1 << 3) | (1 << 8));
        // IN direction: IN_PERI_SEL_CH0 = 0xa0, IN_LINK_CH0 = 0x80
        g.write(0xa0, 6);
        g.write(0x80, d0 & 0xf_ffff);
        assert_eq!(g.channel_for_peri(6, false), Some(0));
        assert_eq!(g.configured_link(0, false), d0);
    }
}
