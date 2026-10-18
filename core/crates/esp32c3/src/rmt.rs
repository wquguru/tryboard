//! RMT（红外遥控 / 通用脉冲收发）。C3：2 发送（CH0/1）+ 2 接收（CH2/3），通道 RAM 在 base+0x400；
//! S3：4 发送 + 4 接收，RAM 在 base+0x800。两者寄存器排布规律相同（见 `RmtLayout`），发送中断位也相同：
//! 结束 = ch、出错 = 4+ch、阈值 = 8+ch、循环 = 12+ch。每块 48 个 32 位条目。
//! 寄存器见 soc/esp32c3|esp32s3/register/soc/rmt_reg.h。
//!
//! 条目格式：bit[14:0] 持续时间 0、bit15 电平 0、bit[30:16] 持续时间 1、bit31 电平 1；持续时间为 0 表示结束。
//! 发送按时间惰性推进：`update(now)` 把已经"发生"的半条目依次消费掉，记录输出电平跳变（`edges`），
//! 并在阈值 / 结束 / 出错时置中断。下一次需要推进的时刻由 `update` 返回。
//! 接收（P2-05）：输入信号经 GPIO 矩阵进来（RMT_SIG_IN0_IDX 与输出同号），由 SoC 在引脚电平变化时按时刻喂给
//! `rx_input`。rx_en 之后等第一个跳变开始记，每段电平的时长（tick）写成半个条目；电平保持超过 idle_thres
//! 个 tick 就结束：把当前电平写成时长 0 的半条目补齐最后一个条目，置 RX_END。滤波（rx_filter_thres 个
//! RMT 源时钟）见 `sigin`。阈值中断（rx_lim 个条目）+ 回绕给 IDF 的乒乓接收用。
//! 未建模：载波调制 / 解调、APB FIFO 模式、DMA 接收（S3 通道 7）、内存所有者错误。

use crate::periph::CPU_HZ;
use crate::sigin::Deglitch;

pub const BLOCK_WORDS: usize = 48;
/// C3 的 RMT 输出信号在 GPIO 矩阵里的编号（soc/gpio_sig_map.h：RMT_SIG_OUT0_IDX = 51）
pub const SIG_OUT0: u32 = 51;

/// 芯片相关的 RMT 参数。寄存器块依次是：DATA[N]、发送 CONF0[ntx]、接收 CONF0/CONF1[nrx]、STATUS[N]、
/// INT_RAW/ST/ENA/CLR、载波 [N]、LIM[N]、SYS_CONF……（N = ntx + nrx）
#[derive(Clone, Copy, Debug)]
pub struct RmtLayout {
    pub ntx: usize,
    pub nrx: usize,
    pub ram_off: u32,
    /// RMT_SIG_OUT0_IDX
    pub sig_out0: u32,
    pub int_mask: u32,
    /// 接收通道 CONF0 里 mem_size 的位置：C3 [25:23]、S3 [27:24]
    pub rx_mem_shift: u32,
    pub rx_mem_mask: u32,
    /// 接收中断位的起点（第 i 个接收通道 = 起点 + i）：结束、出错、阈值
    pub rx_end_bit: u32,
    pub rx_err_bit: u32,
    pub rx_thr_bit: u32,
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
    };
    /// 第 i 个接收通道的 CONF0（CONF1 在 +4）
    pub fn rx_conf0(&self, i: usize) -> u32 {
        self.conf0() + 4 * self.ntx as u32 + 8 * i as u32
    }
    fn n(&self) -> usize {
        self.ntx + self.nrx
    }
    pub fn conf0(&self) -> u32 {
        4 * self.n() as u32
    }
    pub fn status(&self) -> u32 {
        self.conf0() + 4 * self.ntx as u32 + 8 * self.nrx as u32
    }
    pub fn int_raw(&self) -> u32 {
        self.status() + 4 * self.n() as u32
    }
    pub fn tx_lim(&self) -> u32 {
        self.int_raw() + 0x10 + 4 * self.n() as u32
    }
    pub fn sys_conf(&self) -> u32 {
        self.tx_lim() + 4 * self.n() as u32
    }
}

#[derive(Default, Clone, Copy)]
struct Tx {
    active: bool,
    /// 相对通道起始块的条目下标
    rd: usize,
    half: u8,
    /// 当前半条目结束的 CPU 周期
    half_end: u64,
    /// 本次发送已发出的条目数（阈值中断计数）
    sent: u32,
    loops: u32,
}

/// 接收通道状态
#[derive(Default, Clone, Copy)]
struct Rx {
    /// 已经看到第一个跳变、正在记
    started: bool,
    /// 当前这段电平开始的周期
    seg_t: u64,
    /// 下一个要写的条目（相对通道起始块）与半条目
    wr: usize,
    half: u8,
    /// 本次接收写完的条目数（阈值中断计数）
    items: u32,
    filt: Deglitch,
    /// 收完的帧数（统计）
    pub frames: u64,
}

pub struct Rmt {
    pub layout: RmtLayout,
    /// 0x00..0x100 的寄存器镜像
    pub regs: [u32; 0x100 / 4],
    pub ram: Vec<u32>,
    tx: Vec<Tx>,
    rx: Vec<Rx>,
    pub int_raw: u32,
    pub int_ena: u32,
    /// 发送通道当前输出电平
    pub level: Vec<bool>,
    /// 输出电平跳变（周期, 通道, 电平），由 SocBus 取走送进 GPIO 矩阵
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
        // 复位值：发送通道 CONF0 mem_size=1、div=2、idle_out_en；LIM 0x80；SYS_CONF sclk_sel=1(APB)、apb_fifo_mask
        for ch in 0..layout.ntx {
            regs[(layout.conf0() / 4) as usize + ch] = 0x0071_0200;
            regs[(layout.tx_lim() / 4) as usize + ch] = 0x80;
        }
        // 接收通道 CONF0：div=2、idle_thres=0x7fff、mem_size=1、载波使能 / 电平；CONF1：mem_owner=1、filter_thres=15；RX_LIM 0x80
        for i in 0..layout.nrx {
            let c0 = (layout.rx_conf0(i) / 4) as usize;
            regs[c0] = 2 | (0x7fff << 8) | (1 << layout.rx_mem_shift) | (3 << 28);
            regs[c0 + 1] = (1 << 3) | (15 << 5);
            regs[(layout.tx_lim() / 4) as usize + layout.ntx + i] = 0x80;
        }
        regs[(layout.sys_conf() / 4) as usize] = 0x0500_0010;
        regs[0xcc / 4] = 0x2006231;
        let n = layout.ntx + layout.nrx;
        Rmt {
            layout,
            regs,
            ram: vec![0; BLOCK_WORDS * n],
            tx: vec![Tx::default(); layout.ntx],
            rx: vec![Rx::default(); layout.nrx],
            int_raw: 0,
            int_ena: 0,
            level: vec![false; layout.ntx],
            edges: Vec::new(),
        }
    }

    fn conf0(&self, ch: usize) -> u32 {
        self.regs[(self.layout.conf0() / 4) as usize + ch]
    }

    fn mem_words(&self, ch: usize) -> usize {
        let blocks = ((self.conf0(ch) >> 16) & 7).max(1) as usize;
        (blocks * BLOCK_WORDS).min(BLOCK_WORDS * (self.layout.ntx + self.layout.nrx - ch))
    }

    /// RMT 源时钟（SYS_CONF.sclk_sel）
    fn src_hz(&self) -> u64 {
        match (self.regs[(self.layout.sys_conf() / 4) as usize] >> 24) & 3 {
            2 => 17_500_000,
            3 => 40_000_000,
            _ => 80_000_000,
        }
    }

    /// 通道分频 div（0 = 256）时一个 tick 等于多少 CPU 周期（定点：×256，保留分数分频的精度）
    fn cycles_x256(&self, div: u32) -> u64 {
        let sys = self.regs[(self.layout.sys_conf() / 4) as usize];
        let div_num = ((sys >> 4) & 0xff) as u64 + 1;
        let div = if div == 0 { 256 } else { div as u64 };
        CPU_HZ * 256 * div * div_num / self.src_hz()
    }

    fn tick_cycles_x256(&self, ch: usize) -> u64 {
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
        let st = l.status();
        let ir = l.int_raw();
        // CHnSTATUS（发送通道）：mem_raddr_ex[8:0]、state[11:9]（0 空闲 / 1 发送中）
        if off >= st && off < st + 4 * l.ntx as u32 {
            let ch = ((off - st) / 4) as usize;
            let t = &self.tx[ch];
            return (t.rd as u32 + (ch * BLOCK_WORDS) as u32) | if t.active { 1 << 9 } else { 0 };
        }
        // 接收通道 STATUS：mem_waddr_ex（绝对条目号，IDF 减去通道起点得到已写条目数）、apb_mem_raddr、state[24:22]
        if off >= st + 4 * l.ntx as u32 && off < st + 4 * l.n() as u32 {
            let i = ((off - st) / 4) as usize - l.ntx;
            let base = ((l.ntx + i) * BLOCK_WORDS) as u32;
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
        if off >= c0 && off < c0 + 4 * l.ntx as u32 {
            let ch = ((off - c0) / 4) as usize;
            // 自清位：tx_start、mem_rd_rst、apb_mem_rst、afifo_rst、conf_update、tx_stop
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
            // CONF1 自清位：mem_wr_rst、apb_mem_rst、afifo_rst、conf_update
            let was = self.regs[off as usize / 4] & 1 != 0;
            self.regs[off as usize / 4] = v & !(2 | 4 | 1 << 14 | 1 << 15);
            if v & 2 != 0 {
                self.rx[i].wr = 0;
                self.rx[i].half = 0;
            }
            let en = v & 1 != 0;
            if en && !was {
                // 开始接收：等第一个跳变（之前的空闲电平不记）
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
        let c = self.conf0(ch);
        if c & (1 << 6) != 0 {
            self.emit(ch, t, c & (1 << 5) != 0);
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

    /// 在时刻 t 开始发送当前半条目；遇到结束标记时处理结束 / 循环。
    fn begin_half(&mut self, ch: usize, t: u64) {
        // 循环模式下一个结束标记紧接着另一个会无限循环：限制单次推进次数
        for _ in 0..4 {
            let base = ch * BLOCK_WORDS;
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
            // 结束标记
            if self.conf0(ch) & (1 << 3) != 0 {
                // 连续（循环）模式：回到起点重发
                let lim = self.lim_reg(ch);
                let tx = &mut self.tx[ch];
                tx.rd = 0;
                tx.half = 0;
                tx.loops += 1;
                if lim & (1 << 19) != 0 && tx.loops >= (lim >> 9) & 0x3ff {
                    tx.loops = 0;
                    self.int_raw |= 1 << (12 + ch);
                }
                continue;
            }
            self.tx[ch].active = false;
            self.int_raw |= 1 << ch; // TX_END
            self.set_idle(ch, t);
            return;
        }
        // 连续出现结束标记（空数据循环），停在这里
        self.tx[ch].active = false;
        self.int_raw |= 1 << (4 + ch);
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
            if lim > 0 && self.tx[ch].sent.is_multiple_of(lim) {
                self.int_raw |= 1 << (8 + ch); // TX_THR_EVENT
            }
            if self.tx[ch].rd >= self.mem_words(ch) {
                if self.conf0(ch) & (1 << 4) != 0 {
                    self.tx[ch].rd = 0; // 回绕
                } else {
                    // 读到通道内存末尾仍没有结束标记：出错停止
                    self.tx[ch].active = false;
                    self.int_raw |= 1 << (4 + ch);
                    self.set_idle(ch, t);
                    return;
                }
            }
        }
        self.begin_half(ch, t);
    }

    // ------------------------------------------------------------ 接收

    fn rx_conf(&self, i: usize) -> (u32, u32) {
        let c = (self.layout.rx_conf0(i) / 4) as usize;
        (self.regs[c], self.regs[c + 1])
    }

    fn rx_enabled(&self, i: usize) -> bool {
        self.rx_conf(i).1 & 1 != 0
    }

    /// 接收通道 i 的滤波门限（CPU 周期）：rx_filter_thres 个 RMT 源时钟
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

    /// 电平保持多久算结束（CPU 周期）
    fn rx_idle(&self, i: usize) -> u64 {
        let th = ((self.rx_conf(i).0 >> 8) & 0x7fff) as u64;
        (th * self.rx_tick_x256(i)).div_ceil(256)
    }

    fn rx_mem_words(&self, i: usize) -> usize {
        let l = self.layout;
        let blocks = ((self.rx_conf(i).0 >> l.rx_mem_shift) & l.rx_mem_mask).max(1) as usize;
        let ch = l.ntx + i;
        (blocks * BLOCK_WORDS).min(BLOCK_WORDS * (l.n() - ch))
    }

    /// 写半个条目（时长 tick、电平）；凑满一个条目就前进写指针，处理阈值中断 / 回绕 / 溢出
    fn rx_put(&mut self, i: usize, ticks: u64, lv: bool) {
        let l = self.layout;
        let base = (l.ntx + i) * BLOCK_WORDS;
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
                // 通道内存写满：出错并停止本次接收
                self.int_raw |= 1 << (l.rx_err_bit + i as u32);
                self.rx[i].started = false;
            }
        }
    }

    /// 滤波后的电平在 t 跳变到 lv
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

    /// 推进接收通道 i 到 now：到期的滤波跳变生效、电平保持超过 idle_thres 就结束本帧
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
                    // 结束：当前电平写成时长 0 的半条目，补齐最后一个条目
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

    /// 接收通道 i 的输入信号在 t 时刻的原始电平（SoC 在引脚电平可能变化时调用，电平没变也可以调）
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

    /// 接收通道 i 收完的帧数
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

    /// 推进到 now；返回下一次需要推进的周期（无发送时 u64::MAX）。
    pub fn update(&mut self, now: u64) -> u64 {
        let mut next = u64::MAX;
        for i in 0..self.layout.nrx {
            self.rx_advance(i, now);
            next = next.min(self.rx_next(i));
        }
        for ch in 0..self.layout.ntx {
            // 防止配置错误（持续时间极短）时卡死在这里：单次最多消费 100k 个半条目
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

/// WS2812 / SK6812 解码器：挂在一个引脚上，按高电平宽度判 0/1，低电平超过复位时间提交一帧。
#[derive(Default)]
pub struct Ws2812 {
    last: bool,
    rise: u64,
    fall: u64,
    bits: Vec<bool>,
    /// 最近一帧，按灯珠顺序，已从线上 GRB 顺序换成 RGB
    pub rgb: Vec<[u8; 3]>,
    pub frames: u64,
    /// 帧历史（周期, 颜色），给 CLI / 验收用，只留最近 256 帧
    pub history: Vec<(u64, Vec<[u8; 3]>)>,
}

/// T0H ≈ 0.4µs、T1H ≈ 0.8µs，阈值取 0.6µs
const BIT_THRESHOLD: u64 = CPU_HZ * 6 / 10_000_000;
/// 复位（锁存）低电平：手册要求 >50µs（新款 >280µs），40µs 以上即视为帧结束
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

    /// 线上保持低电平到 now：超过复位时间就提交。返回下一次需要检查的时刻。
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

    /// 10MHz 分辨率（APB 80MHz / 8），WS2812 位：1 = 8 高 4 低，0 = 4 高 8 低
    fn item(h: u32, l: u32) -> u32 {
        h | 1 << 15 | l << 16
    }

    #[test]
    fn tx_and_decode() {
        let mut r = Rmt::default();
        let color = [0x10u8, 0x80, 0xff]; // G R B 线上顺序
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
        r.regs[0x68 / 4] = 0x0500_0000; // APB 80MHz，组分频 1
        r.int_ena = 1;
        r.write(0x10, (1 << 16) | (8 << 8) | 1, 1000); // mem_size=1，div=8，start
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
        assert!(r.irq(), "TX_END 中断");
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
        // 每条目 2 tick，每 tick 16 周期 → 24 条目 = 768 周期
        r.update(768);
        assert!(r.int_raw & (1 << 8) != 0, "阈值中断");
        assert!(r.tx[0].active);
    }

    #[test]
    fn s3_layout_offsets_and_tx() {
        // 与 soc/esp32s3/register/soc/rmt_reg.h 一致
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
        // S3 通道 2：RAM 第 3 块
        let mut r = Rmt::new(l);
        r.ram[2 * BLOCK_WORDS] = item(10, 10);
        r.ram[2 * BLOCK_WORDS + 1] = 0;
        r.regs[0xc0 / 4] = 0x0500_0000;
        r.write(0x78, 1 << 2, 0); // TX_END ch2 中断使能
        r.write(0x28, (1 << 16) | (8 << 8) | 1, 0);
        r.update(10_000);
        assert!(r.irq());
        assert_eq!(r.read(0x74), 1 << 2);
    }

    /// S3 接收通道 0（硬件通道 4）：1 MHz 分辨率、空闲 12 ms 结束；一个 1000 µs 高脉冲 → 一个条目 {1000, 1, 0, 0}
    #[test]
    fn rx_pulse_s3() {
        let l = RmtLayout::S3;
        let mut r = Rmt::new(l);
        r.regs[(l.sys_conf() / 4) as usize] = 0x0500_0000; // APB 80MHz，组分频 1
        let c0 = l.rx_conf0(0);
        assert_eq!(c0, 0x30);
        r.write(c0, 80 | (12000 << 8) | (1 << 24), 0);
        r.write(0x78, 1 << 16, 0); // RX_END ch4 中断使能
        r.rx_input(0, 0, false);
        r.write(c0 + 4, 1 | 2 | (1 << 3), 100); // 复位写指针 + 使能
        let us = CPU_HZ / 1_000_000;
        r.rx_input(0, 1000 * us, true);
        r.rx_input(0, 2000 * us, false);
        assert!(!r.irq());
        let n = r.update(5000 * us);
        assert_eq!(n, 2000 * us + 12000 * us);
        r.update(n);
        assert!(r.irq(), "RX_END");
        assert_eq!(r.read(0x60) & 0x3ff, 4 * 48 + 1, "写了一个条目");
        assert_eq!(r.ram[4 * BLOCK_WORDS], 1000 | 1 << 15);
        assert_eq!(r.rx_frames(0), 1);
    }

    /// C3 接收通道 1（硬件通道 3）：多段电平 + 滤波（短于门限的毛刺被吞掉）
    #[test]
    fn rx_items_and_filter_c3() {
        let l = RmtLayout::C3;
        let mut r = Rmt::new(l);
        r.regs[(l.sys_conf() / 4) as usize] = 0x0500_0000;
        let c0 = l.rx_conf0(1);
        assert_eq!(c0, 0x20);
        // 10 MHz 分辨率（div 8）、空闲 1000 tick = 100 µs；滤波 40 个 80MHz 时钟 = 0.5 µs
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
        // 低电平期间一个 0.2 µs 的毛刺：被滤掉，不打断这段低电平
        r.rx_input(1, t + 10 * us, true);
        r.rx_input(1, t + 10 * us + us / 5, false);
        r.update(t + 500 * us);
        assert!(r.int_raw & (1 << 3) != 0, "C3 接收通道 1 的 RX_END 在位 3");
        let base = 3 * BLOCK_WORDS;
        assert_eq!(r.ram[base], 90 | 1 << 15 | 40 << 16);
        assert_eq!(r.ram[base + 1], 30 | 1 << 15 | 70 << 16);
        assert_eq!(
            r.ram[base + 2],
            20 | 1 << 15,
            "最后一段高电平 + 结束（低电平时长 0）"
        );
        assert_eq!(
            r.read(0x34) & 0x1ff,
            3 * 48 + 3,
            "CH3STATUS（rmt_reg.h 0x34）"
        );
    }
}
