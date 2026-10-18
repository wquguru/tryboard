//! ESP32-C3 外设模型。寄存器偏移来自 ESP-IDF `components/soc/esp32c3/register/soc/*.h`（Apache-2.0 OR MIT）。
//!
//! 时间基准：CPU 160MHz，`now` 是 CPU 周期数。SYSTIMER 16MHz = now/10；APB 80MHz = now/2。

pub const CPU_HZ: u64 = 160_000_000;

// ---------------------------------------------------------------- 中断源编号（soc/interrupts.h）
pub mod src {
    pub const WIFI_MAC: u32 = 0;
    pub const GPIO: u32 = 16;
    pub const SPI2: u32 = 19;
    pub const I2S0: u32 = 20;
    pub const UART0: u32 = 21;
    pub const UART1: u32 = 22;
    pub const LEDC: u32 = 23;
    pub const USB_SERIAL_JTAG: u32 = 26;
    pub const RTC_CORE: u32 = 27;
    pub const RMT: u32 = 28;
    pub const I2C_EXT0: u32 = 29;
    pub const TG0_T0: u32 = 32;
    pub const TG0_WDT: u32 = 33;
    pub const TG1_T0: u32 = 34;
    pub const TG1_WDT: u32 = 35;
    pub const SYSTIMER_TARGET0: u32 = 37;
    /// GDMA 每通道一个源（IN / OUT 共用）：ETS_DMA_CH0..2_INTR_SOURCE
    pub const DMA_CH0: u32 = 44;
    pub const FROM_CPU0: u32 = 50;
}

// ---------------------------------------------------------------- 中断矩阵 + CPU 中断控制器
pub struct Intc {
    pub map: [u8; 64],
    pub enable: u32,
    pub edge: u32,
    pub pri: [u8; 32],
    pub thresh: u32,
    /// 边沿型线的锁存
    pub latched: u32,
    pub clock_gate: u32,
}

impl Default for Intc {
    fn default() -> Self {
        Intc {
            map: [0; 64],
            enable: 0,
            edge: 0,
            pri: [0; 32],
            thresh: 0,
            latched: 0,
            clock_gate: 1,
        }
    }
}

impl Intc {
    pub fn read(&self, off: u32) -> Option<u32> {
        Some(match off {
            0x000..=0x0f4 => self.map[(off / 4) as usize] as u32,
            0x100 => self.clock_gate,
            0x104 => self.enable,
            0x108 => self.edge,
            0x10c => 0,
            0x114..=0x190 => self.pri[((off - 0x114) / 4) as usize] as u32,
            0x194 => self.thresh,
            0x7fc => 0x2007210,
            _ => return None,
        })
    }

    pub fn write(&mut self, off: u32, v: u32) -> bool {
        match off {
            0x000..=0x0f4 => self.map[(off / 4) as usize] = (v & 31) as u8,
            0x100 => self.clock_gate = v,
            0x104 => self.enable = v,
            0x108 => self.edge = v,
            0x10c => self.latched &= !v,
            0x114..=0x190 => self.pri[((off - 0x114) / 4) as usize] = (v & 15) as u8,
            0x194 => self.thresh = v & 15,
            _ => return false,
        }
        true
    }

    /// 由各中断源电平算出每条 CPU 线的挂起位。
    pub fn pending(&mut self, levels: u64) -> u32 {
        let mut lines = 0u32;
        let mut l = levels;
        while l != 0 {
            let s = l.trailing_zeros();
            l &= l - 1;
            let line = self.map[s as usize];
            if line != 0 {
                lines |= 1 << line;
            }
        }
        // 边沿型：有电平就锁存，软件写 CLEAR 才清
        self.latched |= lines & self.edge;
        (lines & !self.edge) | self.latched
    }

    /// 选出应当响应的线：使能、优先级 ≥ 阈值且非 0，取优先级最高者。
    pub fn select(&self, pending: u32) -> u32 {
        let mut best = 0u32;
        let mut best_pri = 0u8;
        let mut p = pending & self.enable;
        while p != 0 {
            let line = p.trailing_zeros();
            p &= p - 1;
            let pri = self.pri[line as usize];
            if pri != 0 && pri as u32 >= self.thresh && pri > best_pri {
                best = line;
                best_pri = pri;
            }
        }
        best
    }
}

// ---------------------------------------------------------------- UART
pub struct Uart {
    pub tx: Vec<u8>,
    pub rx: std::collections::VecDeque<u8>,
    pub int_raw: u32,
    pub int_ena: u32,
    pub regs: [u32; 0x84 / 4],
}

impl Default for Uart {
    fn default() -> Self {
        let mut regs = [0u32; 0x84 / 4];
        regs[0x14 / 4] = 0x2b6; // CLKDIV 默认（115200 @ 80MHz）
        regs[0x20 / 4] = 0x1000_001c;
        regs[0x24 / 4] = 0xc060;
        regs[0x78 / 4] = 0x0320_0000;
        regs[0x7c / 4] = 0x0200_7220;
        regs[0x80 / 4] = 0x0000_0500;
        Uart {
            tx: Vec::new(),
            rx: Default::default(),
            int_raw: 0x2,
            int_ena: 0,
            regs,
        }
    }
}

impl Uart {
    pub fn read(&mut self, off: u32) -> u32 {
        match off {
            0x00 => {
                let v = self.rx.pop_front().unwrap_or(0) as u32;
                if self.rx.is_empty() {
                    self.int_raw &= !(1 | (1 << 8));
                }
                v
            }
            0x04 => self.int_raw,
            0x08 => self.int_raw & self.int_ena,
            0x0c => self.int_ena,
            // STATUS：rxfifo_cnt[9:0]，txfifo_cnt[25:16] 恒为 0（发送瞬间完成）
            0x1c => (self.rx.len() as u32).min(127),
            0x6c => 0, // FSM 空闲
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        match off {
            0x00 => {
                self.tx.push(v as u8);
                self.int_raw |= 0x2 | (1 << 14); // TXFIFO_EMPTY、TX_DONE
            }
            0x0c => self.int_ena = v,
            0x10 => self.int_raw &= !v,
            _ => {
                if let Some(r) = self.regs.get_mut((off / 4) as usize) {
                    *r = v;
                }
            }
        }
    }

    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }

    pub fn push_rx(&mut self, data: &[u8]) {
        self.rx.extend(data.iter().copied());
        let thr = (self.regs[0x24 / 4] & 0x1ff) as usize;
        if self.rx.len() >= thr.max(1) {
            self.int_raw |= 1; // RXFIFO_FULL
        }
        // RXFIFO_TOUT：真机在线路空闲若干字符时间后触发；这里一批数据到达即视为空闲
        if !self.rx.is_empty() {
            self.int_raw |= 1 << 8;
        }
    }
}

// ---------------------------------------------------------------- SYSTIMER（16MHz）
pub struct Systimer {
    pub conf: u32,
    pub unit_load: [u64; 2],
    /// 计数 = (now/10) + offset
    pub unit_offset: [i64; 2],
    pub unit_latch: [u64; 2],
    pub target: [u64; 3],
    pub target_conf: [u32; 3],
    pub int_ena: u32,
    pub int_raw: u32,
    /// 单次模式比较器只在"装载后第一次计数到达"时触发一次；之后即使计数仍 ≥ 目标也不再触发
    pub armed: [bool; 3],
}

impl Default for Systimer {
    fn default() -> Self {
        Systimer {
            conf: 0x4600_0000,
            unit_load: [0; 2],
            unit_offset: [0; 2],
            unit_latch: [0; 2],
            target: [0; 3],
            target_conf: [0; 3],
            int_ena: 0,
            int_raw: 0,
            armed: [false; 3],
        }
    }
}

impl Systimer {
    pub fn count(&self, unit: usize, now: u64) -> u64 {
        ((now / 10) as i64 + self.unit_offset[unit]) as u64 & ((1 << 52) - 1)
    }

    pub fn read(&mut self, off: u32, now: u64) -> u32 {
        match off {
            0x00 => self.conf,
            0x04 | 0x08 => 1 << 29, // VALUE_VALID
            0x0c => (self.unit_load[0] >> 32) as u32,
            0x10 => self.unit_load[0] as u32,
            0x14 => (self.unit_load[1] >> 32) as u32,
            0x18 => self.unit_load[1] as u32,
            0x1c | 0x24 | 0x2c => (self.target[((off - 0x1c) / 8) as usize] >> 32) as u32,
            0x20 | 0x28 | 0x30 => self.target[((off - 0x20) / 8) as usize] as u32,
            0x34..=0x3c => self.target_conf[((off - 0x34) / 4) as usize],
            0x40 => (self.unit_latch[0] >> 32) as u32,
            0x44 => self.unit_latch[0] as u32,
            0x48 => (self.unit_latch[1] >> 32) as u32,
            0x4c => self.unit_latch[1] as u32,
            0x64 => self.int_ena,
            0x68 => self.int_raw,
            0x70 => self.int_raw & self.int_ena,
            0xfc => 0x2006171,
            _ => {
                let _ = now;
                0
            }
        }
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        match off {
            0x00 => {
                // 比较器从关到开：重新装弹
                for i in 0..3 {
                    let bit = 1 << (24 - i);
                    if v & bit != 0 && self.conf & bit == 0 {
                        self.armed[i] = true;
                    }
                }
                self.conf = v;
            }
            0x04 | 0x08 => {
                let u = ((off - 4) / 4) as usize;
                if v & (1 << 30) != 0 {
                    self.unit_latch[u] = self.count(u, now);
                }
            }
            0x0c => {
                self.unit_load[0] = (self.unit_load[0] & 0xffff_ffff) | ((v as u64 & 0xfffff) << 32)
            }
            0x10 => self.unit_load[0] = (self.unit_load[0] & !0xffff_ffff) | v as u64,
            0x14 => {
                self.unit_load[1] = (self.unit_load[1] & 0xffff_ffff) | ((v as u64 & 0xfffff) << 32)
            }
            0x18 => self.unit_load[1] = (self.unit_load[1] & !0xffff_ffff) | v as u64,
            0x1c | 0x24 | 0x2c => {
                let i = ((off - 0x1c) / 8) as usize;
                self.target[i] = (self.target[i] & 0xffff_ffff) | ((v as u64 & 0xfffff) << 32);
            }
            0x20 | 0x28 | 0x30 => {
                let i = ((off - 0x20) / 8) as usize;
                self.target[i] = (self.target[i] & !0xffff_ffff) | v as u64;
            }
            0x34..=0x3c => self.target_conf[((off - 0x34) / 4) as usize] = v,
            0x50..=0x58 => {
                // COMPx_LOAD：把 target / period 生效。周期模式下从当前计数起算
                let i = ((off - 0x50) / 4) as usize;
                self.armed[i] = true;
                if self.target_conf[i] & (1 << 30) != 0 {
                    let unit = (self.target_conf[i] >> 31) as usize;
                    self.target[i] =
                        self.count(unit, now) + (self.target_conf[i] & 0x3ff_ffff) as u64;
                }
            }
            0x5c | 0x60 => {
                let u = ((off - 0x5c) / 4) as usize;
                self.unit_offset[u] = self.unit_load[u] as i64 - (now / 10) as i64;
            }
            0x64 => self.int_ena = v & 7,
            0x6c => self.int_raw &= !v,
            _ => {}
        }
    }

    fn comp_enabled(&self, i: usize) -> bool {
        self.conf & (1 << (24 - i)) != 0
    }

    /// 推进比较器；返回下一次需要检查的 CPU 周期。
    pub fn update(&mut self, now: u64) -> u64 {
        let mut next = u64::MAX;
        for i in 0..3 {
            if !self.comp_enabled(i) {
                continue;
            }
            let unit = (self.target_conf[i] >> 31) as usize;
            let cnt = self.count(unit, now);
            let periodic = self.target_conf[i] & (1 << 30) != 0;
            if cnt >= self.target[i] {
                if self.armed[i] || periodic {
                    self.int_raw |= 1 << i;
                    self.armed[i] = false;
                }
                if periodic {
                    let period = (self.target_conf[i] & 0x3ff_ffff) as u64;
                    if period == 0 {
                        continue;
                    }
                    // 跳过已错过的周期，避免追赶风暴
                    let missed = (cnt - self.target[i]) / period + 1;
                    self.target[i] += missed * period;
                } else {
                    continue;
                }
            }
            if !periodic && !self.armed[i] {
                continue;
            }
            let delta = self.target[i] - cnt;
            next = next.min(now + delta * 10);
        }
        next
    }

    pub fn irq(&self, i: usize) -> bool {
        self.int_raw & self.int_ena & (1 << i) != 0
    }
}

// ---------------------------------------------------------------- TIMG（定时器组：通用定时器 + 看门狗 + RTC 校准）
pub struct Timg {
    pub t0config: u32,
    pub t0_offset: i64,
    pub t0_latch: u64,
    pub t0_alarm: u64,
    pub t0_load: u64,
    /// 告警装上时计数已经不小于告警值（真机立刻触发）：这种情况重载后从 load 起数，不补"超出的计数"
    t0_alarm_late: bool,
    pub wdt_cfg: [u32; 6],
    pub wdt_wprotect: u32,
    pub rtccali: [u32; 3],
    pub int_ena: u32,
    pub int_raw: u32,
    pub regclk: u32,
}

impl Default for Timg {
    fn default() -> Self {
        Timg {
            t0config: 0x6000_2000,
            t0_offset: 0,
            t0_latch: 0,
            t0_alarm: 0,
            t0_load: 0,
            t0_alarm_late: false,
            wdt_cfg: [
                0x0004_c000,
                0xffff,
                0x0186_a000,
                0x03ff_ffff,
                0x0fff_ffff,
                0x0fff_ffff,
            ],
            wdt_wprotect: 0,
            rtccali: [0x0001_b000, 0, 0],
            int_ena: 0,
            int_raw: 0,
            regclk: 0,
        }
    }
}

/// RC 慢时钟约 136kHz，XTAL 40MHz。
const XTAL_HZ: u64 = 40_000_000;
const SLOW_HZ: u64 = 136_000;

impl Timg {
    fn divider(&self) -> u64 {
        let d = ((self.t0config >> 13) & 0xffff) as u64;
        if d == 0 {
            65536
        } else {
            d
        }
    }
    fn src_ticks(&self, now: u64) -> u64 {
        // use_xtal 为 1 时 40MHz，否则 APB 80MHz
        if self.t0config & (1 << 9) != 0 {
            now / 4
        } else {
            now / 2
        }
    }
    pub fn count(&self, now: u64) -> u64 {
        if self.t0config & (1 << 31) == 0 {
            return self.t0_offset as u64;
        }
        ((self.src_ticks(now) / self.divider()) as i64 + self.t0_offset) as u64 & ((1 << 54) - 1)
    }

    pub fn read(&mut self, off: u32, now: u64) -> u32 {
        match off {
            0x00 => self.t0config,
            0x04 => self.t0_latch as u32,
            0x08 => (self.t0_latch >> 32) as u32,
            0x0c => 0,
            0x10 => self.t0_alarm as u32,
            0x14 => (self.t0_alarm >> 32) as u32,
            0x18 => self.t0_load as u32,
            0x1c => (self.t0_load >> 32) as u32,
            0x48..=0x5c => self.wdt_cfg[((off - 0x48) / 4) as usize],
            0x64 => self.wdt_wprotect,
            0x68 => self.rtccali[0],
            0x6c => self.rtccali[1],
            0x80 => self.rtccali[2],
            0x70 => self.int_ena,
            0x74 => self.int_raw,
            0x78 => self.int_raw & self.int_ena,
            0xf8 => 0x2006191,
            0xfc => self.regclk,
            _ => {
                let _ = now;
                0
            }
        }
    }

    /// 告警（重新）装上时记下是不是已经过点
    fn arm(&mut self, now: u64) {
        self.t0_alarm_late = self.count(now) >= self.t0_alarm;
    }

    pub fn write(&mut self, off: u32, v: u32, now: u64) {
        // 先结算已经过点的告警：自动重载要在读数 / 改配置之前生效，否则会读到 ≥ 告警值的计数
        self.update(now);
        match off {
            0x00 => {
                // 先冻结当前计数，再换配置，保证计数连续
                let c = self.count(now);
                self.t0config = v;
                if v & (1 << 31) != 0 {
                    self.t0_offset = c as i64 - (self.src_ticks(now) / self.divider()) as i64;
                } else {
                    self.t0_offset = c as i64;
                }
                self.arm(now);
            }
            0x0c => self.t0_latch = self.count(now),
            0x10 => {
                self.t0_alarm = (self.t0_alarm & !0xffff_ffff) | v as u64;
                self.arm(now);
            }
            0x14 => {
                self.t0_alarm = (self.t0_alarm & 0xffff_ffff) | ((v as u64 & 0x3f_ffff) << 32);
                self.arm(now);
            }
            0x18 => self.t0_load = (self.t0_load & !0xffff_ffff) | v as u64,
            0x1c => self.t0_load = (self.t0_load & 0xffff_ffff) | ((v as u64 & 0x3f_ffff) << 32),
            0x20 => {
                if self.t0config & (1 << 31) != 0 {
                    self.t0_offset =
                        self.t0_load as i64 - (self.src_ticks(now) / self.divider()) as i64;
                } else {
                    self.t0_offset = self.t0_load as i64;
                }
                self.arm(now);
            }
            0x48..=0x5c => {
                if self.wdt_wprotect == 0x50d8_3aa1 {
                    self.wdt_cfg[((off - 0x48) / 4) as usize] = v;
                }
            }
            0x60 => {}
            0x64 => self.wdt_wprotect = v,
            0x68 => {
                // 校准瞬间完成：RDY 恒为 1，结果 = 慢时钟周期数 × XTAL/慢时钟
                let max = ((v >> 16) & 0x7fff) as u64;
                let val = max * XTAL_HZ / SLOW_HZ;
                self.rtccali[1] = ((val as u32) & 0x1ff_ffff) << 7;
                self.rtccali[0] = v | (1 << 15);
            }
            0x6c => {}
            0x80 => self.rtccali[2] = v,
            0x70 => self.int_ena = v,
            0x7c => self.int_raw &= !v,
            0xfc => self.regclk = v,
            _ => {}
        }
    }

    pub fn update(&mut self, now: u64) -> u64 {
        // T0 告警
        if self.t0config & (1 << 31) != 0 && self.t0config & (1 << 10) != 0 {
            let c = self.count(now);
            if c >= self.t0_alarm {
                self.int_raw |= 1;
                self.t0config &= !(1 << 10);
                if self.t0config & (1 << 29) != 0 {
                    // 真机在计数到告警值那一拍就重载、接着往上数：结算晚了的话把多数的那几拍补上，
                    // 周期才不会随结算时刻漂
                    let late = if self.t0_alarm_late { 0 } else { c - self.t0_alarm };
                    self.t0_offset =
                        (self.t0_load + late) as i64 - (self.src_ticks(now) / self.divider()) as i64;
                }
                self.t0_alarm_late = false;
            } else {
                let ticks = (self.t0_alarm - c) * self.divider();
                let per = if self.t0config & (1 << 9) != 0 { 4 } else { 2 };
                return now + ticks * per;
            }
        }
        u64::MAX
    }
}

// ---------------------------------------------------------------- GPIO（输出 / 输入 / 引脚配置）
pub struct Gpio {
    /// IO_MUX 引脚寄存器（上下拉、输入使能、功能选择）
    pub iomux: [u32; 22],
    /// 板上固定的上拉（如 BOOT 键所在的 GPIO9）
    pub board_pullup: u32,
    /// 上一次的引脚电平，用于边沿检测
    pub last_level: u32,
    pub out: u32,
    pub enable: u32,
    /// 外部驱动到引脚上的电平（按键、传感器），未驱动的输入读到 pull 决定的电平
    pub ext_in: u32,
    pub ext_driven: u32,
    pub pin: [u32; 22],
    pub func_out: [u32; 22],
    pub func_in: [u32; 128],
    pub status: u32,
    pub strap: u32,
    /// 由外设信号（RMT 等，经 GPIO 矩阵）驱动的引脚：掩码与电平
    pub periph_mask: u32,
    pub periph_level: u32,
}

impl Default for Gpio {
    fn default() -> Self {
        Gpio {
            iomux: [0; 22],
            board_pullup: 1 << 9,
            last_level: 1 << 9,
            out: 0,
            enable: 0,
            ext_in: 0,
            ext_driven: 0,
            pin: [0; 22],
            func_out: [0x80; 22],
            func_in: [0; 128],
            status: 0,
            strap: 0xc, // GPIO2 / GPIO8 拉高 → SPI 启动
            periph_mask: 0,
            periph_level: 0,
        }
    }
}

impl Gpio {
    /// 引脚的实际电平：输出使能时取输出；否则外部驱动优先，再看上下拉（IO_MUX FUN_WPU 位 8 / FUN_WPD 位 7）。
    pub fn level(&self) -> u32 {
        let driven = self.enable & 0x3f_ffff;
        let mut pull = self.board_pullup;
        for (i, r) in self.iomux.iter().enumerate() {
            if r & (1 << 8) != 0 {
                pull |= 1 << i;
            }
            if r & (1 << 7) != 0 && self.board_pullup & (1 << i) == 0 {
                pull &= !(1 << i);
            }
        }
        let undriven = !driven & !self.ext_driven;
        // 经 GPIO 矩阵由外设（RMT 等）驱动的引脚取外设电平
        let out = (self.out & !self.periph_mask) | (self.periph_level & self.periph_mask);
        (out & driven) | (self.ext_in & self.ext_driven & !driven) | (pull & undriven & 0x3f_ffff)
    }

    /// 电平变化后按每个引脚的中断类型置 STATUS 位（GPIO_PINn_INT_TYPE：1 上升 2 下降 3 双沿 4 低电平 5 高电平）。
    pub fn sense(&mut self) {
        let lv = self.level();
        let rise = lv & !self.last_level;
        let fall = !lv & self.last_level;
        for i in 0..22 {
            let ty = (self.pin[i] >> 7) & 7;
            let b = 1u32 << i;
            let hit = match ty {
                1 => rise & b != 0,
                2 => fall & b != 0,
                3 => (rise | fall) & b != 0,
                4 => lv & b == 0,
                5 => lv & b != 0,
                _ => false,
            };
            if hit {
                self.status |= b;
            }
        }
        self.last_level = lv;
    }

    /// GPIO 中断输出：STATUS 中且该引脚 INT_ENA（位 13..17，CPU 中断位 13）开启
    pub fn irq(&self) -> bool {
        (0..22).any(|i| self.status & (1 << i) != 0 && (self.pin[i] >> 13) & 0x1f != 0)
    }

    pub fn set_periph_level(&mut self, pin: u32, on: bool) {
        self.periph_mask |= 1 << pin;
        if on {
            self.periph_level |= 1 << pin;
        } else {
            self.periph_level &= !(1 << pin);
        }
    }

    pub fn read(&mut self, off: u32) -> u32 {
        match off {
            0x04 => self.out,
            0x20 => self.enable,
            0x38 => self.strap,
            0x3c => self.level(),
            0x44 => self.status,
            0x5c => self.status,
            0x74..=0xc8 => self.pin[((off - 0x74) / 4) as usize],
            0x154..=0x350 => self.func_in[((off - 0x154) / 4) as usize],
            0x554..=0x5a8 => self.func_out[((off - 0x554) / 4) as usize],
            0x6fc => 0x2006130,
            _ => 0,
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let m = 0x3f_ffff;
        match off {
            0x04 => self.out = v & m,
            0x08 => self.out |= v & m,
            0x0c => self.out &= !v,
            0x20 => self.enable = v & m,
            0x24 => self.enable |= v & m,
            0x28 => self.enable &= !v,
            0x44 => self.status = v,
            0x48 => self.status |= v,
            0x4c => self.status &= !v,
            0x74..=0xc8 => self.pin[((off - 0x74) / 4) as usize] = v,
            0x154..=0x350 => self.func_in[((off - 0x154) / 4) as usize] = v,
            0x554..=0x5a8 => {
                let pin = ((off - 0x554) / 4) as usize;
                self.func_out[pin] = v;
                // 改回普通 GPIO 输出（信号 128）时不再由外设驱动
                if v & 0xff == 0x80 {
                    self.periph_mask &= !(1 << pin);
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------- EXTMEM（cache 控制）
/// cache 操作（失效、同步、预载、锁定、冻结）在模拟器里瞬间完成：使能位自清，完成位置 1。
/// cache 本身不建模（flash 读直接经 MMU 翻译），所以这些操作没有别的副作用。
pub struct Extmem {
    pub regs: [u32; 0x100 / 4],
}

impl Default for Extmem {
    fn default() -> Self {
        let mut regs = [0u32; 0x100 / 4];
        regs[0x1c / 4] = 1 << 2; // LOCK_DONE
        regs[0x28 / 4] = 1 << 1; // SYNC_DONE
        regs[0x34 / 4] = 1 << 1; // PRELOAD_DONE
        regs[0x40 / 4] = 1 << 3; // AUTOLOAD_DONE
        regs[0x00] = 1; // ICACHE_ENABLE（bootloader 已开 cache）
        Extmem { regs }
    }
}

impl Extmem {
    pub fn read(&self, off: u32) -> u32 {
        match off {
            0xb0 => 1, // CACHE_STATE：空闲
            _ => self.regs.get((off / 4) as usize).copied().unwrap_or(0),
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let v = match off {
            0x1c => (v & !3) | 4,
            0x28 | 0x34 => (v & !1) | 2,
            0x40 => v | 8,
            0xcc => (v & !4) | if v & 1 != 0 { 4 } else { 0 },
            _ => v,
        };
        if let Some(r) = self.regs.get_mut((off / 4) as usize) {
            *r = v;
        }
    }
}

// ---------------------------------------------------------------- APB_SARADC（单次采样）
/// ADC1 通道 0..4 = GPIO0..4，ADC2 通道 0 = GPIO5。电压由外部（网页旋钮 / 测试脚本）设定。
/// 量程按数据手册的衰减档位近似：0dB≈750mV、2.5dB≈1050mV、6dB≈1300mV、12dB≈2500mV。
pub struct Adc {
    pub regs: [u32; 0x400 / 4],
    /// 每个引脚上的电压（mV）
    pub pin_mv: [f32; 22],
    /// 噪声幅度（LSB），真实 ADC 读数有抖动；0 关闭
    pub noise_lsb: u32,
    seed: u32,
}

impl Default for Adc {
    fn default() -> Self {
        Adc {
            regs: [0; 0x400 / 4],
            pin_mv: [0.0; 22],
            noise_lsb: 2,
            seed: 0x1234_5678,
        }
    }
}

impl Adc {
    pub fn read(&self, off: u32) -> u32 {
        match off {
            0x48 => self.regs[0x44 / 4] & self.regs[0x40 / 4],
            0x3fc => 0x2007171,
            _ => self.regs[(off / 4) as usize],
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        let i = (off / 4) as usize;
        match off {
            0x4c => self.regs[0x44 / 4] &= !v,
            0x20 => {
                let rising = v & (1 << 29) != 0 && self.regs[i] & (1 << 29) == 0;
                self.regs[i] = v;
                if rising {
                    self.sample(v);
                }
            }
            _ => self.regs[i] = v,
        }
    }

    fn sample(&mut self, cfg: u32) {
        // 哪个 ADC 完成由 adc1/adc2_onetime_sample 使能位决定（校准时通道字段可能指向内部通道）
        let chan = (cfg >> 25) & 0xf;
        let unit = if cfg & (1 << 31) != 0 { 0 } else { 1 };
        let ch = chan & 7;
        let atten = (cfg >> 23) & 3;
        let pin = if unit == 0 { ch as usize } else { 5 };
        let full = [750.0, 1050.0, 1300.0, 2500.0][atten as usize];
        let mv = if (unit == 0 && ch <= 4) || (unit == 1 && ch == 0) {
            self.pin_mv[pin]
        } else {
            0.0
        };
        // 线性同余噪声，保证可复现
        self.seed = self.seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
        let n = if self.noise_lsb > 0 {
            (self.seed >> 16) % (2 * self.noise_lsb + 1)
        } else {
            0
        } as i32
            - self.noise_lsb as i32;
        let raw = ((mv / full * 4095.0).round() as i32 + n).clamp(0, 4095) as u32;
        if unit == 0 {
            self.regs[0x2c / 4] = raw;
            self.regs[0x44 / 4] |= 1 << 31;
        } else {
            self.regs[0x30 / 4] = raw;
            self.regs[0x44 / 4] |= 1 << 30;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// gptimer 的写法：APB 80 MHz ÷ 80 = 1 MHz，告警 10000、自动重载到 0
    fn periodic() -> Timg {
        let mut t = Timg::default();
        t.write(0x10, 10_000, 0);
        t.write(0x00, (1 << 31) | (1 << 30) | (1 << 29) | (80 << 13) | (1 << 10), 0);
        t
    }

    #[test]
    fn timg_autoreload_keeps_phase() {
        // 1 µs = 160 个 CPU 周期。告警到点后晚了 300 µs 才结算：重载后应当是 300，不是 0
        let mut t = periodic();
        t.update(10_300 * 160);
        assert_eq!(t.int_raw & 1, 1);
        assert_eq!(t.count(10_300 * 160), 300);
        // 没结算就先锁存读数（写 UPDATE）：不能读到 ≥ 告警值
        let mut t = periodic();
        t.write(0x0c, 1, 10_050 * 160);
        assert_eq!(t.t0_latch, 50);
        // 装告警时已经过点：立刻触发，从 load 起数
        let mut t = Timg::default();
        t.write(0x00, (1 << 31) | (1 << 30) | (1 << 29) | (80 << 13), 0);
        t.write(0x10, 100, 500 * 160);
        t.write(0x00, t.t0config | (1 << 10), 500 * 160);
        t.update(500 * 160);
        assert_eq!(t.int_raw & 1, 1);
        assert_eq!(t.count(500 * 160), 0);
    }
}
