//! RMT（红外遥控 / 通用脉冲收发）。C3：2 发送（CH0/1）+ 2 接收（CH2/3），通道 RAM 在 base+0x400；
//! S3：4 发送 + 4 接收，RAM 在 base+0x800。两者寄存器排布规律相同（见 `RmtLayout`），发送中断位也相同：
//! 结束 = ch、出错 = 4+ch、阈值 = 8+ch、循环 = 12+ch。每块 48 个 32 位条目。
//! 寄存器见 soc/esp32c3|esp32s3/register/soc/rmt_reg.h。
//!
//! 条目格式：bit[14:0] 持续时间 0、bit15 电平 0、bit[30:16] 持续时间 1、bit31 电平 1；持续时间为 0 表示结束。
//! 发送按时间惰性推进：`update(now)` 把已经"发生"的半条目依次消费掉，记录输出电平跳变（`edges`），
//! 并在阈值 / 结束 / 出错时置中断。下一次需要推进的时刻由 `update` 返回。
//! 未建模：载波调制（不影响 WS2812 这类用法）、接收通道采样（RX 没有外部输入源）、APB FIFO 模式。

use crate::periph::CPU_HZ;

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
}

impl RmtLayout {
    pub const C3: RmtLayout = RmtLayout { ntx: 2, nrx: 2, ram_off: 0x400, sig_out0: 51, int_mask: 0x3fff };
    pub const S3: RmtLayout = RmtLayout { ntx: 4, nrx: 4, ram_off: 0x800, sig_out0: 81, int_mask: 0x3fff_ffff };
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

pub struct Rmt {
    pub layout: RmtLayout,
    /// 0x00..0x100 的寄存器镜像
    pub regs: [u32; 0x100 / 4],
    pub ram: Vec<u32>,
    tx: Vec<Tx>,
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
        regs[(layout.sys_conf() / 4) as usize] = 0x0500_0010;
        regs[0xcc / 4] = 0x2006231;
        let n = layout.ntx + layout.nrx;
        Rmt {
            layout,
            regs,
            ram: vec![0; BLOCK_WORDS * n],
            tx: vec![Tx::default(); layout.ntx],
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

    /// 一个 RMT tick 等于多少 CPU 周期（定点：×256，保留分数分频的精度）
    fn tick_cycles_x256(&self, ch: usize) -> u64 {
        let sys = self.regs[(self.layout.sys_conf() / 4) as usize];
        let src_hz: u64 = match (sys >> 24) & 3 {
            2 => 17_500_000,
            3 => 40_000_000,
            _ => 80_000_000,
        };
        let div_num = ((sys >> 4) & 0xff) as u64 + 1;
        let div = match (self.conf0(ch) >> 8) & 0xff {
            0 => 256,
            d => d as u64,
        };
        CPU_HZ * 256 * div * div_num / src_hz
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
            return self.ram.get(((off - l.ram_off) / 4) as usize).copied().unwrap_or(0);
        }
        let st = l.status();
        let ir = l.int_raw();
        // CHnSTATUS（发送通道）：mem_raddr_ex[8:0]、state[11:9]（0 空闲 / 1 发送中）
        if off >= st && off < st + 4 * l.ntx as u32 {
            let ch = ((off - st) / 4) as usize;
            let t = &self.tx[ch];
            return (t.rd as u32 + (ch * BLOCK_WORDS) as u32) | if t.active { 1 << 9 } else { 0 };
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
                let cyc = (dur as u64 * self.tick_cycles_x256(ch)).div_ceil(256).max(1);
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

    /// 推进到 now；返回下一次需要推进的周期（无发送时 u64::MAX）。
    pub fn update(&mut self, now: u64) -> u64 {
        let mut next = u64::MAX;
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
            let byte = |i: usize| px[i * 8..i * 8 + 8].iter().fold(0u8, |a, b| (a << 1) | *b as u8);
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
                r.ram[i] = if byte >> b & 1 != 0 { item(8, 4) } else { item(4, 8) };
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
        assert_eq!((l.conf0(), l.status(), l.int_raw(), l.tx_lim(), l.sys_conf()), (0x20, 0x50, 0x70, 0xa0, 0xc0));
        let c = RmtLayout::C3;
        assert_eq!((c.conf0(), c.status(), c.int_raw(), c.tx_lim(), c.sys_conf()), (0x10, 0x28, 0x38, 0x58, 0x68));
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
}
