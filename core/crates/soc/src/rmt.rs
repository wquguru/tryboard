//! RMT (IR remote / generic pulse TX+RX). C3: 2 TX (CH0/1) + 2 RX (CH2/3), RAM at base+0x400; S3: 4 TX + 4 RX, RAM at base+0x800; same layout rules (`RmtLayout`,
//! rmt_reg.h), TX IRQ bits end = ch, err = 4+ch, thres = 8+ch, loop = 12+ch; 48 32-bit items per block. Item: [14:0] dur0, 15 level0, [30:16] dur1, 31 level1; dur 0 = end.
//! Classic ESP32 (`RmtLayout::ESP32`, M5-11): 8 channels x 64 words, CONF0/CONF1 pairs, IRQ end = 3ch / err = 3ch+2 / thres = 24+ch, global wrap in APB_CONF, TX only.
//! TX advances lazily: `update(now)` consumes elapsed half-items, records level edges (`edges`), raises thres / end / err IRQs, returns the next due time.
//! RX (P2-05): input via GPIO matrix (RMT_SIG_IN0_IDX matches output numbering), fed by the SoC to `rx_input` on pin changes. After rx_en, start at the first
//! edge, write each level's ticks as a half-item; a level held > idle_thres ticks ends the frame (0-length half-item pads it, RX_END). Filter in `sigin`; rx_lim
//! threshold IRQ + wrap serve IDF ping-pong RX. Not modelled: carrier, APB FIFO mode, DMA RX (S3 ch 7), memory-owner errors. (lint: allow-long-comment)

use crate::periph::CPU_HZ;
use crate::sigin::Deglitch;

pub const BLOCK_WORDS: usize = 48;
/// C3 RMT output signal number in the GPIO matrix (soc/gpio_sig_map.h: RMT_SIG_OUT0_IDX = 51)
pub const SIG_OUT0: u32 = 51;

/// Per-chip RMT parameters. Register blocks in order: DATA[N], TX CONF0[ntx], RX CONF0/CONF1[nrx], STATUS[N],
/// INT_RAW/ST/ENA/CLR, carrier[N], LIM[N], SYS_CONF... (N = ntx + nrx)
#[derive(Clone, Copy, Debug)]
pub struct RmtLayout {
    pub ntx: usize,
    pub nrx: usize,
    pub ram_off: u32,
    /// RMT_SIG_OUT0_IDX
    pub sig_out0: u32,
    pub int_mask: u32,
    /// Position of mem_size in RX CONF0: C3 [25:23], S3 [27:24]
    pub rx_mem_shift: u32,
    pub rx_mem_mask: u32,
    /// First RX interrupt bits (RX channel i = first + i): end, error, threshold
    pub rx_end_bit: u32,
    pub rx_err_bit: u32,
    pub rx_thr_bit: u32,
    /// 32-bit items per RAM block (C3 / S3 48, ESP32 64)
    pub block: usize,
    /// Classic ESP32 register map (CONF0 + CONF1 per channel, wrap in APB_CONF, per-channel clock)
    pub classic: bool,
}

impl RmtLayout {
    pub const C3: RmtLayout = RmtLayout {
        ntx: 2,
        nrx: 2,
        ram_off: 0x400,
        sig_out0: 51,
        int_mask: 0x3fff,
        rx_mem_shift: 23,
        rx_mem_mask: 7,
        rx_end_bit: 2,
        rx_err_bit: 6,
        rx_thr_bit: 10,
        block: BLOCK_WORDS,
        classic: false,
    };
    pub const S3: RmtLayout = RmtLayout {
        ntx: 4,
        nrx: 4,
        ram_off: 0x800,
        sig_out0: 81,
        int_mask: 0x3fff_ffff,
        rx_mem_shift: 24,
        rx_mem_mask: 15,
        rx_end_bit: 16,
        rx_err_bit: 20,
        rx_thr_bit: 24,
        block: BLOCK_WORDS,
        classic: false,
    };
    /// Classic ESP32 (soc/esp32/register/soc/rmt_struct.h): 8 TX-capable channels, CHnCONF0/1 at 0x20 + 8n,
    /// STATUS 0x60, INT_RAW 0xa0, TX_LIM 0xd0, APB_CONF 0xf0, RAM +0x800; RX not modelled (nrx = 0).
    pub const ESP32: RmtLayout = RmtLayout {
        ntx: 8,
        nrx: 0,
        ram_off: 0x800,
        sig_out0: 87,
        int_mask: 0xffff_ffff,
        rx_mem_shift: 24,
        rx_mem_mask: 15,
        rx_end_bit: 1,
        rx_err_bit: 2,
        rx_thr_bit: 24,
        block: 64,
        classic: true,
    };
    /// CONF0 of RX channel i (CONF1 at +4)
    pub fn rx_conf0(&self, i: usize) -> u32 {
        self.conf0() + 4 * self.ntx as u32 + 8 * i as u32
    }
    fn n(&self) -> usize {
        self.ntx + self.nrx
    }
    pub fn conf0(&self) -> u32 {
        4 * self.n() as u32
    }
    /// Word stride between TX channels' CONF0 (classic has CONF0 + CONF1 pairs)
    fn conf_stride(&self) -> u32 {
        if self.classic {
            8
        } else {
            4
        }
    }
    pub fn status(&self) -> u32 {
        self.conf0() + self.conf_stride() * self.ntx as u32 + 8 * self.nrx as u32
    }
    pub fn int_raw(&self) -> u32 {
        // Classic has 8 APB_MEM_ADDR words between STATUS and INT_RAW
        self.status() + 4 * self.n() as u32 * if self.classic { 2 } else { 1 }
    }
    pub fn tx_lim(&self) -> u32 {
        self.int_raw() + 0x10 + 4 * self.n() as u32
    }
    /// Interrupt bits of TX channel ch: (end, error, threshold, loop count)
    pub fn tx_bits(&self, ch: usize) -> (u32, u32, u32, Option<u32>) {
        let c = ch as u32;
        if self.classic {
            (3 * c, 3 * c + 2, 24 + c, None)
        } else {
            (c, 4 + c, 8 + c, Some(12 + c))
        }
    }
    pub fn sys_conf(&self) -> u32 {
        self.tx_lim() + 4 * self.n() as u32
    }
}

#[derive(Default, Clone, Copy)]
struct Tx {
    active: bool,
    /// Item index relative to the channel's first block
    rd: usize,
    half: u8,
    /// CPU cycle when the current half-item ends
    half_end: u64,
    /// Items sent in this transmission (threshold IRQ count)
    sent: u32,
    loops: u32,
}

/// RX channel state
#[derive(Default, Clone, Copy)]
struct Rx {
    /// First edge seen, recording
    started: bool,
    /// Cycle when the current level segment started
    seg_t: u64,
    /// Next item to write (relative to channel start) and half-item
    wr: usize,
    half: u8,
    /// Items written in this reception (threshold IRQ count)
    items: u32,
    filt: Deglitch,
    /// Frames received (stats)
    pub frames: u64,
}

pub struct Rmt {
    pub layout: RmtLayout,
    /// Register mirror for 0x00..0x100
    pub regs: [u32; 0x100 / 4],
    pub ram: Vec<u32>,
    tx: Vec<Tx>,
    rx: Vec<Rx>,
    pub int_raw: u32,
    pub int_ena: u32,
    /// Current output level of TX channels
    pub level: Vec<bool>,
    /// Output edges (cycle, channel, level); SocBus takes them into the GPIO matrix
    pub edges: Vec<(u64, u8, bool)>,
}

impl Default for Rmt {
    fn default() -> Self {
        Rmt::new(RmtLayout::C3)
    }
}

impl Rmt {
    pub fn new(layout: RmtLayout) -> Rmt {
        let mut regs = [0u32; 0x100 / 4];
        let n = layout.ntx + layout.nrx;
        let tx = vec![Tx::default(); layout.ntx];
        if layout.classic {
            // CONF0: div=2, idle_thres=0x1000, mem_size=1, carrier on; CONF1: mem_owner=1, filter_thres=15; LIM 0x80
            for ch in 0..layout.ntx {
                regs[8 + 2 * ch] = 0x3110_0002;
                regs[9 + 2 * ch] = 0xf20;
                regs[(layout.tx_lim() / 4) as usize + ch] = 0x80;
            }
            return Rmt {
                layout,
                regs,
                ram: vec![0; layout.block * n],
                tx,
                rx: Vec::new(),
                int_raw: 0,
                int_ena: 0,
                level: vec![false; layout.ntx],
                edges: Vec::new(),
            };
        }
        // Resets: TX CONF0 mem_size=1, div=2, idle_out_en; LIM 0x80; SYS_CONF sclk_sel=1 (APB), apb_fifo_mask
        for ch in 0..layout.ntx {
            regs[(layout.conf0() / 4) as usize + ch] = 0x0071_0200;
            regs[(layout.tx_lim() / 4) as usize + ch] = 0x80;
        }
        // RX CONF0: div=2, idle_thres=0x7fff, mem_size=1, carrier enable / level; CONF1: mem_owner=1, filter_thres=15; RX_LIM 0x80
        for i in 0..layout.nrx {
            let c0 = (layout.rx_conf0(i) / 4) as usize;
            regs[c0] = 2 | (0x7fff << 8) | (1 << layout.rx_mem_shift) | (3 << 28);
            regs[c0 + 1] = (1 << 3) | (15 << 5);
            regs[(layout.tx_lim() / 4) as usize + layout.ntx + i] = 0x80;
        }
        regs[(layout.sys_conf() / 4) as usize] = 0x0500_0010;
        regs[0xcc / 4] = 0x2006231;
        Rmt {
            layout,
            regs,
            ram: vec![0; layout.block * n],
            tx,
            rx: vec![Rx::default(); layout.nrx],
            int_raw: 0,
            int_ena: 0,
            level: vec![false; layout.ntx],
            edges: Vec::new(),
        }
    }

    fn conf0(&self, ch: usize) -> u32 {
        let stride = (self.layout.conf_stride() / 4) as usize;
        self.regs[(self.layout.conf0() / 4) as usize + ch * stride]
    }

    /// Classic CONF1 of channel ch (tx_start, conti, idle level, clock select)
    fn conf1(&self, ch: usize) -> u32 {
        self.regs[9 + 2 * ch]
    }

    fn mem_words(&self, ch: usize) -> usize {
        let l = self.layout;
        let blocks = if l.classic {
            (self.conf0(ch) >> 24) & 15
        } else {
            (self.conf0(ch) >> 16) & 7
        };
        (blocks.max(1) as usize * l.block).min(l.block * (l.ntx + l.nrx - ch))
    }

    /// Continuous (loop) mode
    fn tx_conti(&self, ch: usize) -> bool {
        if self.layout.classic {
            self.conf1(ch) & (1 << 6) != 0
        } else {
            self.conf0(ch) & (1 << 3) != 0
        }
    }

    /// Wrap at the end of channel memory (classic: global APB_CONF.mem_tx_wrap_en)
    fn tx_wrap(&self, ch: usize) -> bool {
        if self.layout.classic {
            self.regs[(self.layout.sys_conf() / 4) as usize] & 2 != 0
        } else {
            self.conf0(ch) & (1 << 4) != 0
        }
    }

    /// Idle output level when idle_out_en is set
    fn tx_idle(&self, ch: usize) -> Option<bool> {
        let (c, en, lv) = if self.layout.classic {
            (self.conf1(ch), 19, 18)
        } else {
            (self.conf0(ch), 6, 5)
        };
        (c & (1 << en) != 0).then_some(c & (1 << lv) != 0)
    }

    /// RMT source clock (SYS_CONF.sclk_sel)
    fn src_hz(&self) -> u64 {
        match (self.regs[(self.layout.sys_conf() / 4) as usize] >> 24) & 3 {
            2 => 17_500_000,
            3 => 40_000_000,
            _ => 80_000_000,
        }
    }

    /// CPU cycles per tick at channel divider div (0 = 256), fixed point x256 to keep fractional dividers exact
    fn cycles_x256(&self, div: u32) -> u64 {
        let sys = self.regs[(self.layout.sys_conf() / 4) as usize];
        let div_num = ((sys >> 4) & 0xff) as u64 + 1;
        let div = if div == 0 { 256 } else { div as u64 };
        CPU_HZ * 256 * div * div_num / self.src_hz()
    }

    fn tick_cycles_x256(&self, ch: usize) -> u64 {
        if self.layout.classic {
            // ref_always_on: APB 80 MHz, else REF_TICK 1 MHz; no group divider
            let div = self.conf0(ch) & 0xff;
            let div = if div == 0 { 256 } else { div as u64 };
            let src = if self.conf1(ch) & (1 << 17) != 0 {
                80_000_000
            } else {
                1_000_000
            };
            return CPU_HZ * 256 * div / src;
        }
        self.cycles_x256((self.conf0(ch) >> 8) & 0xff)
    }

    fn tx_lim(&self, ch: usize) -> u32 {
        self.lim_reg(ch) & 0x1ff
    }

    fn lim_reg(&self, ch: usize) -> u32 {
        self.regs[(self.layout.tx_lim() / 4) as usize + ch]
    }

    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }

    pub fn read(&self, off: u32) -> u32 {
        let l = self.layout;
        if off >= l.ram_off {
            return self
                .ram
                .get(((off - l.ram_off) / 4) as usize)
                .copied()
                .unwrap_or(0);
        }
        if l.classic && (0x60..0x80).contains(&off) {
            // CHnSTATUS: mem_waddr_ex[9:0], mem_raddr_ex[19:10], state[22:20] (1 = sending)
            let ch = ((off - 0x60) / 4) as usize;
            let t = &self.tx[ch];
            let base = (ch * l.block) as u32;
            return base | (base + t.rd as u32) << 10 | if t.active { 1 << 20 } else { 0 };
        }
        let st = l.status();
        let ir = l.int_raw();
        // CHnSTATUS (TX): mem_raddr_ex[8:0], state[11:9] (0 idle / 1 sending)
        if off >= st && off < st + 4 * l.ntx as u32 {
            let ch = ((off - st) / 4) as usize;
            let t = &self.tx[ch];
            return (t.rd as u32 + (ch * l.block) as u32) | if t.active { 1 << 9 } else { 0 };
        }
        // RX STATUS: mem_waddr_ex (absolute item index; IDF subtracts channel start for count), apb_mem_raddr, state[24:22]
        if off >= st + 4 * l.ntx as u32 && off < st + 4 * l.n() as u32 {
            let i = ((off - st) / 4) as usize - l.ntx;
            let base = ((l.ntx + i) * l.block) as u32;
            let r = &self.rx[i];
            return (base + r.wr as u32) | (base << 11) | if r.started { 1 << 22 } else { 0 };
        }
        match off {
            _ if off == ir => self.int_raw,
            _ if off == ir + 4 => self.int_raw & self.int_ena,
            _ if off == ir + 8 => self.int_ena,
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        let l = self.layout;
        if off >= l.ram_off {
            if let Some(w) = self.ram.get_mut(((off - l.ram_off) / 4) as usize) {
                *w = v;
            }
            return;
        }
        let (c0, ir, lim) = (l.conf0(), l.int_raw(), l.tx_lim());
        if l.classic && off >= c0 && off < c0 + 8 * l.ntx as u32 {
            let ch = ((off - c0) / 8) as usize;
            if (off - c0).is_multiple_of(8) {
                self.regs[off as usize / 4] = v;
                return;
            }
            // CONF1 pulses read back 0 (IDF read-modify-writes CONF1, a sticky tx_start would retrigger):
            // tx_start, mem_wr_rst, mem_rd_rst, apb_mem_rst, ref_cnt_rst
            self.regs[off as usize / 4] = v & !(1 | 4 | 8 | 16 | 1 << 16);
            if v & 8 != 0 {
                self.tx[ch].rd = 0;
                self.tx[ch].half = 0;
            }
            if v & 1 != 0 {
                self.start(ch, now);
            }
            if !self.tx[ch].active {
                self.set_idle(ch, now);
            }
            return;
        }
        if off >= c0 && off < c0 + 4 * l.ntx as u32 {
            let ch = ((off - c0) / 4) as usize;
            // Self-clearing: tx_start, mem_rd_rst, apb_mem_rst, afifo_rst, conf_update, tx_stop
            self.regs[off as usize / 4] = v & !(1 | 2 | 4 | 1 << 7 | 1 << 23 | 1 << 24);
            if v & 2 != 0 {
                self.tx[ch].rd = 0;
                self.tx[ch].half = 0;
            }
            if v & (1 << 7) != 0 {
                self.stop(ch, now);
            }
            if v & 1 != 0 {
                self.start(ch, now);
            }
            if !self.tx[ch].active {
                self.set_idle(ch, now);
            }
            return;
        }
        let rc = l.rx_conf0(0);
        if off >= rc && off < rc + 8 * l.nrx as u32 {
            let i = ((off - rc) / 8) as usize;
            if (off - rc).is_multiple_of(8) {
                self.regs[off as usize / 4] = v;
                return;
            }
            // CONF1 self-clearing: mem_wr_rst, apb_mem_rst, afifo_rst, conf_update
            let was = self.regs[off as usize / 4] & 1 != 0;
            self.regs[off as usize / 4] = v & !(2 | 4 | 1 << 14 | 1 << 15);
            if v & 2 != 0 {
                self.rx[i].wr = 0;
                self.rx[i].half = 0;
            }
            let en = v & 1 != 0;
            if en && !was {
                // Start RX: wait for the first edge (the idle level before it isn't recorded)
                let r = &mut self.rx[i];
                r.started = false;
                r.items = 0;
                r.half = 0;
            } else if !en {
                self.rx[i].started = false;
            }
            return;
        }
        if off >= lim && off < lim + 4 * l.ntx as u32 {
            let ch = ((off - lim) / 4) as usize;
            if v & (1 << 20) != 0 {
                self.tx[ch].loops = 0;
            }
            self.regs[off as usize / 4] = v & !(1 << 20);
            return;
        }
        match off {
            _ if off == ir || off == ir + 4 => {}
            _ if off == ir + 8 => self.int_ena = v & l.int_mask,
            _ if off == ir + 12 => self.int_raw &= !v,
            _ => {
                if let Some(r) = self.regs.get_mut((off / 4) as usize) {
                    *r = v;
                }
            }
        }
    }

    fn emit(&mut self, ch: usize, t: u64, lv: bool) {
        if self.level[ch] != lv {
            self.level[ch] = lv;
            self.edges.push((t, ch as u8, lv));
        }
    }

    fn set_idle(&mut self, ch: usize, t: u64) {
        if let Some(lv) = self.tx_idle(ch) {
            self.emit(ch, t, lv);
        }
    }

    fn start(&mut self, ch: usize, now: u64) {
        let tx = &mut self.tx[ch];
        tx.active = true;
        tx.half = 0;
        tx.sent = 0;
        self.begin_half(ch, now);
    }

    fn stop(&mut self, ch: usize, now: u64) {
        self.tx[ch].active = false;
        self.set_idle(ch, now);
    }

    /// Start sending the current half-item at time t; handle end / loop on an end marker.
    fn begin_half(&mut self, ch: usize, t: u64) {
        // In loop mode an end marker right after another would loop forever: cap iterations per call
        for _ in 0..4 {
            let base = ch * self.layout.block;
            let idx = (base + self.tx[ch].rd) % self.ram.len();
            let item = self.ram[idx];
            let (dur, lv) = if self.tx[ch].half == 0 {
                (item & 0x7fff, item & (1 << 15) != 0)
            } else {
                ((item >> 16) & 0x7fff, item & (1 << 31) != 0)
            };
            if dur != 0 {
                self.emit(ch, t, lv);
                let cyc = (dur as u64 * self.tick_cycles_x256(ch))
                    .div_ceil(256)
                    .max(1);
                self.tx[ch].half_end = t + cyc;
                return;
            }
            // End marker
            let (end, _, _, loop_bit) = self.layout.tx_bits(ch);
            if self.tx_conti(ch) {
                // Continuous (loop) mode: restart from the beginning
                let lim = self.lim_reg(ch);
                let tx = &mut self.tx[ch];
                tx.rd = 0;
                tx.half = 0;
                tx.loops += 1;
                if let Some(b) = loop_bit {
                    if lim & (1 << 19) != 0 && tx.loops >= (lim >> 9) & 0x3ff {
                        tx.loops = 0;
                        self.int_raw |= 1 << b;
                    }
                }
                continue;
            }
            self.tx[ch].active = false;
            self.int_raw |= 1 << end; // TX_END
            self.set_idle(ch, t);
            return;
        }
        // Back-to-back end markers (empty loop): stop here
        self.tx[ch].active = false;
        self.int_raw |= 1 << self.layout.tx_bits(ch).1;
    }

    fn end_half(&mut self, ch: usize) {
        let t = self.tx[ch].half_end;
        if self.tx[ch].half == 0 {
            self.tx[ch].half = 1;
        } else {
            self.tx[ch].half = 0;
            self.tx[ch].rd += 1;
            self.tx[ch].sent += 1;
            let lim = self.tx_lim(ch);
            let (_, err, thr, _) = self.layout.tx_bits(ch);
            if lim > 0 && self.tx[ch].sent.is_multiple_of(lim) {
                self.int_raw |= 1 << thr; // TX_THR_EVENT
            }
            if self.tx[ch].rd >= self.mem_words(ch) {
                if self.tx_wrap(ch) {
                    self.tx[ch].rd = 0; // wrap
                } else {
                    // Reached end of channel memory without an end marker: error and stop
                    self.tx[ch].active = false;
                    self.int_raw |= 1 << err;
                    self.set_idle(ch, t);
                    return;
                }
            }
        }
        self.begin_half(ch, t);
    }

    // ------------------------------------------------------------ RX

    fn rx_conf(&self, i: usize) -> (u32, u32) {
        let c = (self.layout.rx_conf0(i) / 4) as usize;
        (self.regs[c], self.regs[c + 1])
    }

    fn rx_enabled(&self, i: usize) -> bool {
        self.rx_conf(i).1 & 1 != 0
    }

    /// RX channel i filter threshold (CPU cycles): rx_filter_thres RMT source clocks
    fn rx_filter(&self, i: usize) -> u64 {
        let c1 = self.rx_conf(i).1;
        if c1 & (1 << 4) == 0 {
            return 0;
        }
        ((c1 >> 5) & 0xff) as u64 * CPU_HZ / self.src_hz()
    }

    fn rx_tick_x256(&self, i: usize) -> u64 {
        self.cycles_x256(self.rx_conf(i).0 & 0xff)
    }

    /// How long a level must hold to end the frame (CPU cycles)
    fn rx_idle(&self, i: usize) -> u64 {
        let th = ((self.rx_conf(i).0 >> 8) & 0x7fff) as u64;
        (th * self.rx_tick_x256(i)).div_ceil(256)
    }

    fn rx_mem_words(&self, i: usize) -> usize {
        let l = self.layout;
        let blocks = ((self.rx_conf(i).0 >> l.rx_mem_shift) & l.rx_mem_mask).max(1) as usize;
        let ch = l.ntx + i;
        (blocks * l.block).min(l.block * (l.n() - ch))
    }

    /// Write a half-item (ticks, level); on a full item advance the write pointer, handle threshold IRQ / wrap / overflow
    fn rx_put(&mut self, i: usize, ticks: u64, lv: bool) {
        let l = self.layout;
        let base = (l.ntx + i) * l.block;
        let r = self.rx[i];
        let idx = (base + r.wr) % self.ram.len();
        let half = (ticks.min(0x7fff) as u32) | (lv as u32) << 15;
        if r.half == 0 {
            self.ram[idx] = half;
            self.rx[i].half = 1;
            return;
        }
        self.ram[idx] = (self.ram[idx] & 0xffff) | half << 16;
        self.rx[i].half = 0;
        self.rx[i].wr += 1;
        self.rx[i].items += 1;
        let wrap = self.rx_conf(i).1 & (1 << 13) != 0;
        let lim = self.regs[(l.tx_lim() / 4) as usize + l.ntx + i] & 0x1ff;
        if wrap && lim > 0 && self.rx[i].items.is_multiple_of(lim) {
            self.int_raw |= 1 << (l.rx_thr_bit + i as u32);
        }
        if self.rx[i].wr >= self.rx_mem_words(i) {
            if wrap {
                self.rx[i].wr = 0;
            } else {
                // Channel memory full: error and stop this reception
                self.int_raw |= 1 << (l.rx_err_bit + i as u32);
                self.rx[i].started = false;
            }
        }
    }

    /// Filtered level switches to lv at t
    fn rx_edge(&mut self, i: usize, t: u64, lv: bool) {
        if !self.rx_enabled(i) {
            return;
        }
        if !self.rx[i].started {
            self.rx[i].started = true;
            self.rx[i].seg_t = t;
            return;
        }
        let ticks = (t - self.rx[i].seg_t) * 256 / self.rx_tick_x256(i).max(1);
        self.rx_put(i, ticks, !lv);
        if self.rx[i].started {
            self.rx[i].seg_t = t;
        }
    }

    /// Advance RX channel i to now: apply due filtered edges, end the frame when a level holds past idle_thres
    fn rx_advance(&mut self, i: usize, now: u64) {
        let th = self.rx_filter(i);
        loop {
            let due = self.rx[i].filt.due(th).filter(|d| *d <= now);
            let idle_at = self.rx[i]
                .started
                .then(|| self.rx[i].seg_t + self.rx_idle(i))
                .filter(|e| *e <= now);
            match (due, idle_at) {
                (Some(d), e) if e.is_none_or(|e| d < e) => {
                    if let Some((t, lv)) = self.rx[i].filt.flush(now, th) {
                        self.rx_edge(i, t, lv);
                    }
                }
                (_, Some(_)) => {
                    // End: write the current level as a 0-length half-item to complete the last item
                    let lv = self.rx[i].filt.level;
                    self.rx_put(i, 0, lv);
                    if self.rx[i].half == 1 {
                        self.rx_put(i, 0, false);
                    }
                    self.rx[i].started = false;
                    self.rx[i].frames += 1;
                    self.int_raw |= 1 << (self.layout.rx_end_bit + i as u32);
                }
                _ => break,
            }
        }
    }

    /// Raw level of RX channel i's input at t (the SoC calls it when a pin may have changed; unchanged is fine)
    pub fn rx_input(&mut self, i: usize, t: u64, raw: bool) {
        if i >= self.layout.nrx {
            return;
        }
        self.rx_advance(i, t);
        let th = self.rx_filter(i);
        if let Some((t, lv)) = self.rx[i].filt.input(t, raw, th) {
            self.rx_edge(i, t, lv);
        }
    }

    /// Frames received on RX channel i
    pub fn rx_frames(&self, i: usize) -> u64 {
        self.rx.get(i).map(|r| r.frames).unwrap_or(0)
    }

    fn rx_next(&self, i: usize) -> u64 {
        let mut n = self.rx[i].filt.due(self.rx_filter(i)).unwrap_or(u64::MAX);
        if self.rx[i].started {
            n = n.min(self.rx[i].seg_t + self.rx_idle(i));
        }
        n
    }

    /// Advance to now; returns the next cycle to advance at (u64::MAX when not sending).
    pub fn update(&mut self, now: u64) -> u64 {
        let mut next = u64::MAX;
        for i in 0..self.layout.nrx {
            self.rx_advance(i, now);
            next = next.min(self.rx_next(i));
        }
        for ch in 0..self.layout.ntx {
            // Avoid hanging here on a bad config (tiny durations): consume at most 100k half-items per call
            let mut guard = 100_000;
            while self.tx[ch].active && self.tx[ch].half_end <= now && guard > 0 {
                self.end_half(ch);
                guard -= 1;
            }
            if self.tx[ch].active {
                next = next.min(self.tx[ch].half_end);
            }
        }
        next
    }
}

/// WS2812 / SK6812 decoder on one pin: 0/1 by high-pulse width, a long low (reset) commits a frame.
#[derive(Default)]
pub struct Ws2812 {
    last: bool,
    rise: u64,
    fall: u64,
    bits: Vec<bool>,
    /// Latest frame in LED order, converted from wire GRB to RGB
    pub rgb: Vec<[u8; 3]>,
    pub frames: u64,
    /// Frame history (cycle, colours) for CLI / acceptance; keeps the last 256 frames
    pub history: Vec<(u64, Vec<[u8; 3]>)>,
}

/// T0H ≈ 0.4us, T1H ≈ 0.8us, threshold 0.6us
const BIT_THRESHOLD: u64 = CPU_HZ * 6 / 10_000_000;
/// Reset (latch) low: datasheet wants >50us (newer parts >280us); anything over 40us ends the frame
pub const RESET_CYCLES: u64 = CPU_HZ * 40 / 1_000_000;

impl Ws2812 {
    pub fn feed(&mut self, t: u64, level: bool) {
        if level == self.last {
            return;
        }
        if level {
            if !self.bits.is_empty() && t.saturating_sub(self.fall) >= RESET_CYCLES {
                self.commit();
            }
            self.rise = t;
        } else {
            self.bits.push(t.saturating_sub(self.rise) > BIT_THRESHOLD);
            self.fall = t;
        }
        self.last = level;
    }

    /// Line held low until now: commit once past the reset time. Returns the next time to check.
    pub fn finalize(&mut self, now: u64) -> u64 {
        if !self.last && !self.bits.is_empty() {
            if now.saturating_sub(self.fall) >= RESET_CYCLES {
                self.commit();
            } else {
                return self.fall + RESET_CYCLES;
            }
        }
        u64::MAX
    }

    fn commit(&mut self) {
        let mut rgb = Vec::with_capacity(self.bits.len() / 24);
        for px in self.bits.as_chunks::<24>().0 {
            let byte = |i: usize| {
                px[i * 8..i * 8 + 8]
                    .iter()
                    .fold(0u8, |a, b| (a << 1) | *b as u8)
            };
            rgb.push([byte(1), byte(0), byte(2)]);
        }
        self.bits.clear();
        self.frames += 1;
        if self.history.len() >= 256 {
            self.history.remove(0);
        }
        self.history.push((self.fall, rgb.clone()));
        self.rgb = rgb;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 10MHz resolution (APB 80MHz / 8), WS2812 bits: 1 = 8 high 4 low, 0 = 4 high 8 low
    fn item(h: u32, l: u32) -> u32 {
        h | 1 << 15 | l << 16
    }

    #[test]
    fn tx_and_decode() {
        let mut r = Rmt::default();
        let color = [0x10u8, 0x80, 0xff]; // G R B wire order
        let mut i = 0;
        for byte in color {
            for b in (0..8).rev() {
                r.ram[i] = if byte >> b & 1 != 0 {
                    item(8, 4)
                } else {
                    item(4, 8)
                };
                i += 1;
            }
        }
        r.ram[i] = 0;
        r.regs[0x68 / 4] = 0x0500_0000; // APB 80MHz, group divider 1
        r.int_ena = 1;
        r.write(0x10, (1 << 16) | (8 << 8) | 1, 1000); // mem_size=1, div=8, start
        let mut d = Ws2812::default();
        let mut now = 1000;
        while now < 1000 + 200_000 {
            let n = r.update(now);
            for (t, _, lv) in r.edges.drain(..) {
                d.feed(t, lv);
            }
            d.finalize(now);
            now = n.min(now + 5000);
        }
        assert!(r.irq(), "TX_END interrupt");
        assert_eq!(d.frames, 1);
        assert_eq!(d.rgb, vec![[0x80, 0x10, 0xff]]);
    }

    #[test]
    fn threshold_and_wrap() {
        let mut r = Rmt::default();
        for w in r.ram.iter_mut().take(48) {
            *w = item(1, 1);
        }
        r.regs[0x68 / 4] = 0x0500_0000;
        r.regs[0x58 / 4] = 24;
        r.write(0x10, (1 << 16) | (1 << 4) | (8 << 8) | 1, 0);
        // 2 ticks per item, 16 cycles per tick -> 24 items = 768 cycles
        r.update(768);
        assert!(r.int_raw & (1 << 8) != 0, "threshold interrupt");
        assert!(r.tx[0].active);
    }

    #[test]
    fn s3_layout_offsets_and_tx() {
        // Matches soc/esp32s3/register/soc/rmt_reg.h
        let l = RmtLayout::S3;
        assert_eq!(
            (l.conf0(), l.status(), l.int_raw(), l.tx_lim(), l.sys_conf()),
            (0x20, 0x50, 0x70, 0xa0, 0xc0)
        );
        let c = RmtLayout::C3;
        assert_eq!(
            (c.conf0(), c.status(), c.int_raw(), c.tx_lim(), c.sys_conf()),
            (0x10, 0x28, 0x38, 0x58, 0x68)
        );
        // S3 channel 2: third RAM block
        let mut r = Rmt::new(l);
        r.ram[2 * BLOCK_WORDS] = item(10, 10);
        r.ram[2 * BLOCK_WORDS + 1] = 0;
        r.regs[0xc0 / 4] = 0x0500_0000;
        r.write(0x78, 1 << 2, 0); // TX_END ch2 interrupt enable
        r.write(0x28, (1 << 16) | (8 << 8) | 1, 0);
        r.update(10_000);
        assert!(r.irq());
        assert_eq!(r.read(0x74), 1 << 2);
    }

    /// Classic ESP32 channel 1: 64-word blocks, CONF0/CONF1 pairs, global wrap in APB_CONF, IRQ bits 3n / 3n+2 / 24+n.
    /// 100 items (> one block) of WS2812 data ping-pong through the wrap; the frame decodes intact.
    #[test]
    fn esp32_layout_wrap_and_decode() {
        let l = RmtLayout::ESP32;
        assert_eq!(
            (l.conf0(), l.status(), l.int_raw(), l.tx_lim(), l.sys_conf()),
            (0x20, 0x60, 0xa0, 0xd0, 0xf0)
        );
        let mut r = Rmt::new(l);
        let ram = 0x800 + 64 * 4; // channel 1's block
        let colors: Vec<u8> = (0..12).map(|k| (k * 23) as u8).collect(); // 4 pixels = 96 bits
        let bit = |k: usize| colors[k / 8] >> (7 - k % 8) & 1 != 0;
        let enc = |k: usize| {
            if k < 96 {
                if bit(k) {
                    item(8, 4)
                } else {
                    item(4, 8)
                }
            } else {
                0
            }
        };
        for k in 0..64 {
            r.write(ram + 4 * k as u32, enc(k), 0);
        }
        r.write(0xf0, 3, 0); // fifo_mask, mem_tx_wrap_en
        r.write(0xd4, 32, 0); // ch1 tx_lim
        r.write(0xa8, 1 << 3 | 1 << 5 | 1 << 25, 0);
        r.write(0x28, (1 << 24) | 8, 0); // ch1 CONF0: mem_size 1, div 8
                                         // CONF1: APB clock, idle out low enabled, mem_rd_rst + tx_start
        r.write(0x2c, 1 << 19 | 1 << 17 | 8 | 1, 0);
        assert_eq!(r.read(0x2c) & 1, 0, "tx_start reads back 0");
        let (mut d, mut now, mut next_fill) = (Ws2812::default(), 0u64, 64usize);
        while now < 400_000 {
            let n = r.update(now);
            if r.int_raw & (1 << 25) != 0 {
                // Refill the half just sent (IDF ping-pong)
                r.write(0xac, 1 << 25, now);
                for _ in 0..32 {
                    r.write(ram + 4 * (next_fill % 64) as u32, enc(next_fill), now);
                    next_fill += 1;
                }
            }
            for (t, c, lv) in r.edges.drain(..) {
                assert_eq!(c, 1);
                d.feed(t, lv);
            }
            d.finalize(now);
            now = n.min(now + 500);
        }
        assert_eq!(r.int_raw & (1 << 5), 0, "no TX error");
        assert!(r.int_raw & (1 << 3) != 0, "TX_END ch1");
        assert!(r.irq());
        assert_eq!(d.frames, 1);
        let rgb: Vec<[u8; 3]> = colors.chunks(3).map(|g| [g[1], g[0], g[2]]).collect();
        assert_eq!(d.rgb, rgb);
    }

    /// S3 RX channel 0 (hw channel 4): 1 MHz resolution, 12 ms idle ends; one 1000 us high pulse -> one item {1000, 1, 0, 0}
    #[test]
    fn rx_pulse_s3() {
        let l = RmtLayout::S3;
        let mut r = Rmt::new(l);
        r.regs[(l.sys_conf() / 4) as usize] = 0x0500_0000; // APB 80MHz, group divider 1
        let c0 = l.rx_conf0(0);
        assert_eq!(c0, 0x30);
        r.write(c0, 80 | (12000 << 8) | (1 << 24), 0);
        r.write(0x78, 1 << 16, 0); // RX_END ch4 interrupt enable
        r.rx_input(0, 0, false);
        r.write(c0 + 4, 1 | 2 | (1 << 3), 100); // reset write pointer + enable
        let us = CPU_HZ / 1_000_000;
        r.rx_input(0, 1000 * us, true);
        r.rx_input(0, 2000 * us, false);
        assert!(!r.irq());
        let n = r.update(5000 * us);
        assert_eq!(n, 2000 * us + 12000 * us);
        r.update(n);
        assert!(r.irq(), "RX_END");
        assert_eq!(r.read(0x60) & 0x3ff, 4 * 48 + 1, "one item written");
        assert_eq!(r.ram[4 * BLOCK_WORDS], 1000 | 1 << 15);
        assert_eq!(r.rx_frames(0), 1);
    }

    /// C3 RX channel 1 (hw channel 3): multiple levels + filter (glitches shorter than the threshold are swallowed)
    #[test]
    fn rx_items_and_filter_c3() {
        let l = RmtLayout::C3;
        let mut r = Rmt::new(l);
        r.regs[(l.sys_conf() / 4) as usize] = 0x0500_0000;
        let c0 = l.rx_conf0(1);
        assert_eq!(c0, 0x20);
        // 10 MHz resolution (div 8), idle 1000 ticks = 100 us; filter 40 x 80MHz clocks = 0.5 us
        r.write(c0, 8 | (1000 << 8) | (1 << 23), 0);
        r.write(c0 + 4, 1 | (1 << 4) | (40 << 5), 0);
        let us = CPU_HZ / 1_000_000;
        let mut t = 10 * us;
        let mut lv = true;
        for w in [9u64, 4, 3, 7] {
            r.rx_input(1, t, lv);
            t += w * us;
            lv = !lv;
        }
        r.rx_input(1, t, lv);
        r.rx_input(1, t + 2 * us, false);
        // A 0.2 us glitch during the low: filtered out, the low segment isn't split
        r.rx_input(1, t + 10 * us, true);
        r.rx_input(1, t + 10 * us + us / 5, false);
        r.update(t + 500 * us);
        assert!(r.int_raw & (1 << 3) != 0, "C3 RX channel 1 RX_END is bit 3");
        let base = 3 * BLOCK_WORDS;
        assert_eq!(r.ram[base], 90 | 1 << 15 | 40 << 16);
        assert_eq!(r.ram[base + 1], 30 | 1 << 15 | 70 << 16);
        assert_eq!(
            r.ram[base + 2],
            20 | 1 << 15,
            "last high segment + end (low, length 0)"
        );
        assert_eq!(
            r.read(0x34) & 0x1ff,
            3 * 48 + 3,
            "CH3STATUS (rmt_reg.h 0x34)"
        );
    }
}
