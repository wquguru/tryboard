//! Wi-Fi：射频 / 基带 / MAC 硬件的行为模型（逆向笔记见 docs/WIFI.md）。
//!
//! 层次：芯片里的闭源驱动（libpp / libnet80211）照常运行，模拟器在寄存器 + DMA 描述符层面扮演 MAC，
//! 发出的 802.11 帧交给 [`world::World`]（虚拟 AP），世界的回应写进接收描述符并触发 MAC 中断。

pub mod crypto;
pub mod frame;
pub mod net;
pub mod tcp;
pub mod world;
pub mod wpa;

use crate::Mem;
use std::collections::HashMap;

/// 寄存器排布与时钟（按芯片参数化）。C3 与 S3 的 Wi-Fi MAC 是同一代 IP：MAC 寄存器、描述符、
/// 接收元数据头（wifi_pkt_rx_ctrl_t，两颗都是 12 个字）相同；不同的是射频校准时轮询的地址、
/// 硬件随机数寄存器位置（见 docs/WIFI.md「S3」）
#[derive(Clone, Copy, Debug)]
pub struct WifiLayout {
    pub chip: &'static str,
    /// 模拟时间基准（CPU 周期 / 秒）
    pub cpu_hz: u64,
    /// 射频 / 基带 / MAC 里"等硬件完成"的轮询：(地址, 就绪方式)
    pub rf_polls: &'static [(u32, RfReady)],
    pub mac: MacRegs,
}

/// 轮询寄存器的就绪值怎么给
#[derive(Clone, Copy, Debug)]
pub enum RfReady {
    /// 读回 = 上次写入值 | 掩码
    Or(u32),
    /// 读回 = 上次写入值 | (上次写入值 >> 1 & 1)：写位 1 启动、等位 0 就绪
    StartBit1Done0,
}

impl WifiLayout {
    pub const C3: WifiLayout = WifiLayout {
        chip: "esp32c3",
        cpu_hz: 160_000_000,
        rf_polls: &[
            // SAR / 峰值检测状态：位 26..24 == 7 表示空闲（rom_pkdet_vol_start、rom1_read_sar2_code 轮询）
            (0x6000_e050, RfReady::Or(7 << 24)),
            // TX 直流校准比较器：位 24 = 转换完成（txdc_cal_v70 轮询），位 30 是比较结果，保持写入值
            (0x6000_e04c, RfReady::Or(1 << 24)),
            // FE：IQ 估计完成（位 16，rom_iq_est_enable 轮询）
            (0x6000_6174, RfReady::Or(1 << 16)),
            // MAC：hal_init 写位 1 后等位 0 就绪
            (0x6003_3d14, RfReady::StartBit1Done0),
        ],
        mac: MacRegs::C3,
    };
    pub const S3: WifiLayout = WifiLayout {
        chip: "esp32s3",
        ..WifiLayout::C3
    };
    /// 经典 ESP32：MAC 是上一代 IP（寄存器在 0x3FF73000 一带，排布见 [`MacRegs::ESP32`]）
    pub const ESP32: WifiLayout = WifiLayout {
        chip: "esp32",
        cpu_hz: 160_000_000,
        // 射频校准轮询与 C3 同一套 PHY：外设偏移相同，只是 APB 基址 0x3FF40000（C3 是 0x60000000）
        rf_polls: &[
            // 0x3FF4E050 不列：ESP32 的 ram_get_fm_sar_dout 等位 26..24 回 0（与 C3 相反），存什么读什么正好
            (0x3ff4_e04c, RfReady::Or(1 << 24)),
            // FE：IQ 估计完成在位 31（ram_iq_est_enable 轮询；C3 是 0x6174 位 16）
            (0x3ff4_607c, RfReady::Or(1 << 31)),
            // ESP32 独有：set_chan_freq_sw_start 置位 8 启动 PLL 换频，等位 31 完成
            (0x3ff4_e0c4, RfReady::Or(1 << 31)),
            // MAC：hal_init 写位 1、等位 0（C3 在 +0xD14，ESP32 在 +0xD24）
            (0x3ff7_3d24, RfReady::StartBit1Done0),
        ],
        mac: MacRegs::ESP32,
    };
}

/// MAC 寄存器排布（见 docs/WIFI.md）。C3 / S3 是同一代 IP；经典 ESP32 是上一代，同名 HAL 函数、
/// 同样的描述符与发送结果码，但寄存器偏移逐个不同，接收元数据头只有 7 个字（「ESP32」一节）
#[derive(Clone, Copy, Debug)]
pub struct MacRegs {
    /// 本模块关心的 MAC / 省电模块地址范围
    pub range: (u32, u32),
    pub int_ena: u32,
    pub int_st: u32,
    pub int_clr: u32,
    pub rx_first: u32,
    /// 接收控制：位 0 = 重新装载描述符链（硬件读完即清，ESP32 驱动写后轮询到它清零；C3 不轮询，填 0）
    pub rx_ctrl: u32,
    /// 读：最近一次填好的描述符；`rx_last_full` = 回完整地址（ESP32），否则只回低 20 位（C3）
    pub rx_last: u32,
    pub rx_last_full: bool,
    /// 读：硬件下一个要填的描述符（ESP32 驱动回收时读它；C3 不读，填 0）
    pub rx_next: u32,
    pub txq_done: u32,
    pub txq_done_clr: u32,
    /// 发送队列 q 的配置寄存器 = txq0 - 8q；位 19..0 描述符地址低 20 位，位 31/30 启动
    pub txq0: u32,
    /// 发送结果 = txq_result0 - stride·q：位 15..12 结果码（0 成功，5 ACK 超时）
    pub txq_result0: u32,
    pub txq_result_stride: u32,
    /// 读回恒 0 的状态寄存器（发送状态、省电中断状态）
    pub zero: [u32; 2],
    /// TSF 计时器（微秒）低 / 高 32 位
    pub tsf_lo: u32,
    pub tsf_hi: u32,
    /// 描述符地址寄存器只存低 20 位，高位固定（C3 / S3 的 DRAM 在 0x3FCxxxxx，ESP32 在 0x3FFxxxxx）
    pub desc_hi: u32,
    /// 接收中断事件位（wDev_ProcessFiq 的掩码）
    pub ev_rx: u32,
    /// 硬件密钥表（hal_crypto_set_key_entry）：有效位图 + 每项 40 字节
    pub key_valid: u32,
    pub key_table: u32,
    /// 接收元数据头字数；噪声底（低字节）、长度（位 11..0）所在字
    pub rx_hdr_words: u32,
    pub rx_noise_word: usize,
    pub rx_len_word: usize,
    /// 硬件写进头里的 RSSI 比真实 dBm 高多少：ESP32 的 wDev_ProcessRxSucData 先减去 wDevCtrl+46
    /// （运行时读到 96）再上报，C3 不减
    pub rx_rssi_bias: i32,
}

impl MacRegs {
    pub const C3: MacRegs = MacRegs {
        range: (0x6003_3000, 0x6003_6000),
        int_ena: 0x6003_3c34,
        int_st: 0x6003_3c3c,
        int_clr: 0x6003_3c40,
        rx_first: 0x6003_3088,
        rx_ctrl: 0,
        rx_last: 0x6003_3090,
        rx_last_full: false,
        rx_next: 0,
        txq_done: 0x6003_3cb0,
        txq_done_clr: 0x6003_3cac,
        txq0: 0x6003_3d08,
        txq_result0: 0x6003_4320,
        txq_result_stride: 76,
        zero: [0x6003_3ca8, 0x6003_5118],
        tsf_lo: 0x6003_5018,
        tsf_hi: 0x6003_501c,
        desc_hi: 0x3fc0_0000,
        ev_rx: 1 << 14,
        key_valid: 0x6003_3814,
        key_table: 0x6003_4400,
        rx_hdr_words: 12,
        rx_noise_word: 5,
        rx_len_word: 11,
        rx_rssi_bias: 0,
    };
    /// 经典 ESP32（从 libpp / libnet80211 反汇编推出，见 docs/WIFI.md「ESP32」）
    pub const ESP32: MacRegs = MacRegs {
        range: (0x3ff7_3000, 0x3ff7_6000),
        int_ena: 0x3ff7_3c40,
        int_st: 0x3ff7_3c48,
        int_clr: 0x3ff7_3c4c,
        rx_first: 0x3ff7_3088,
        rx_ctrl: 0x3ff7_3084,
        rx_last: 0x3ff7_3090,
        rx_last_full: true,
        rx_next: 0x3ff7_308c,
        txq_done: 0x3ff7_3cc8,
        txq_done_clr: 0x3ff7_3cc4,
        txq0: 0x3ff7_3d20,
        txq_result0: 0x3ff7_4270,
        txq_result_stride: 60,
        zero: [0x3ff7_3cc0, 0x3ff7_3cc0],
        tsf_lo: 0x3ff7_5014,
        tsf_hi: 0x3ff7_5018,
        desc_hi: 0x3ff0_0000,
        // 接收掩码 0x1000024 里位 24 是"收到帧"（位 2 / 5 是溢出类）
        ev_rx: 1 << 24,
        key_valid: 0x3ff7_3814,
        key_table: 0x3ff7_4400,
        rx_hdr_words: 7,
        rx_noise_word: 2,
        rx_len_word: 6,
        rx_rssi_bias: 96,
    };

    pub fn contains(&self, a: u32) -> bool {
        (self.range.0..self.range.1).contains(&a)
    }
}

/// C3 / S3 的 MAC 地址范围（总线分派用）
pub const MAC_RANGE: std::ops::Range<u32> = MacRegs::C3.range.0..MacRegs::C3.range.1;
const TXQ_NUM: u32 = 5;

// MAC 中断事件位（wDev_ProcessFiq）：发送完成两代相同
const EV_TX_DONE: u32 = 1 << 7;

/// 硬件密钥表每项：字 0 = 对端 MAC 字节 0..3，字 1 低 16 位 = MAC 字节 4..5、位 30 = 组密钥，字 2.. = 密钥（按内存字节装载）。
/// 字 1 高位其余字段（算法、槽位类别）没有用到：实测 IDF 把 GTK 装在槽 0、PTK 装在槽 4，对端都是 BSSID
const KEY_GROUP: u32 = 1 << 30;
const KEY_ENTRY: u32 = 40;
const KEY_SLOTS: u32 = 32;

enum Ev {
    TxDone { q: usize, code: u32 },
    Rx(world::Air),
}

pub struct WifiMac {
    pub layout: WifiLayout,
    pub int_raw: u32,
    pub int_ena: u32,
    tx_done: u32,
    tx_result: [u32; TXQ_NUM as usize],
    /// 下一个要填的接收描述符；None 表示还没配置
    rx_cur: Option<u32>,
    /// 最近一次填好的描述符（链表到头时从它的 next 继续）
    rx_last: u32,
    events: Vec<(u64, Ev)>,
    next_beacon: u64,
    /// 密钥表寄存器的副本（有效位图 + 各槽），写入时同时存进通用寄存器表
    keys: HashMap<u32, u32>,
    pub world: world::World,
    /// 空中日志：给 CLI / 网页看
    pub log: Vec<String>,
    pub rx_dropped: u64,
    pub tx_frames: u64,
    pub rx_frames: u64,
}

impl Default for WifiMac {
    fn default() -> Self {
        WifiMac::new(WifiLayout::C3)
    }
}

/// 置了受保护位的数据帧
fn is_protected_data(f: &[u8]) -> bool {
    f.len() >= 24 && f[0] & 0x0c == 0x08 && f[1] & 0x40 != 0
}

fn read_bytes(mem: &mut dyn Mem, a: u32, n: u32) -> Vec<u8> {
    (0..n).map(|i| mem.rd8(a + i)).collect()
}

impl WifiMac {
    pub fn new(layout: WifiLayout) -> Self {
        WifiMac {
            layout,
            int_raw: 0,
            int_ena: 0,
            tx_done: 0,
            tx_result: [0; TXQ_NUM as usize],
            rx_cur: None,
            rx_last: 0,
            events: Vec::new(),
            next_beacon: 0,
            keys: HashMap::new(),
            world: world::World::default(),
            log: Vec::new(),
            rx_dropped: 0,
            tx_frames: 0,
            rx_frames: 0,
        }
    }

    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }

    fn schedule(&mut self, at: u64, ev: Ev) {
        self.events.push((at, ev));
    }

    fn us_to_cycles(&self, us: u64) -> u64 {
        us * (self.layout.cpu_hz / 1_000_000)
    }

    fn tsf_us(&self, now: u64) -> u64 {
        now / (self.layout.cpu_hz / 1_000_000)
    }

    fn ms(&self, now: u64) -> f64 {
        now as f64 / (self.layout.cpu_hz / 1000) as f64
    }

    /// 对射频相关寄存器的读：返回 Some 表示由本模块给值（stored 是该地址上次写入的值）
    pub fn rf_read(&self, a: u32, stored: u32) -> Option<u32> {
        let (_, r) = self.layout.rf_polls.iter().find(|(x, _)| *x == a)?;
        Some(match *r {
            RfReady::Or(m) => stored | m,
            RfReady::StartBit1Done0 => stored | ((stored >> 1) & 1),
        })
    }

    /// MAC 寄存器的读；None 走通用读回
    pub fn read(&mut self, a: u32, now: u64) -> Option<u32> {
        let m = self.layout.mac;
        let res = |a: u32| {
            a <= m.txq_result0
                && (m.txq_result0 - a).is_multiple_of(m.txq_result_stride)
                && (m.txq_result0 - a) / m.txq_result_stride < TXQ_NUM
        };
        Some(match a {
            a if a == m.int_st => self.int_raw & self.int_ena,
            a if a == m.int_ena => self.int_ena,
            a if a == m.txq_done => self.tx_done,
            a if m.zero.contains(&a) => 0,
            a if a == m.rx_last => {
                if m.rx_last_full {
                    self.rx_last
                } else {
                    self.rx_last & 0xf_ffff
                }
            }
            // 链表到头时读回 0x3FF00000（地址高位 | 空指针），驱动据此判断要不要重设起点
            a if m.rx_next != 0 && a == m.rx_next => {
                m.desc_hi | (self.rx_cur.unwrap_or(0) & 0xf_ffff)
            }
            a if res(a) => self.tx_result[((m.txq_result0 - a) / m.txq_result_stride) as usize],
            a if a == m.tsf_lo => self.tsf_us(now) as u32,
            a if a == m.tsf_hi => (self.tsf_us(now) >> 32) as u32,
            _ => return None,
        })
    }

    /// MAC 寄存器的写。返回 Some(值) 表示调用方把这个值存进通用寄存器表（读回用），None 表示已处理、不存
    pub fn write(&mut self, a: u32, v: u32, now: u64, mem: &mut dyn Mem) -> Option<u32> {
        let m = self.layout.mac;
        match a {
            a if a == m.int_ena => self.int_ena = v,
            a if a == m.int_clr => self.int_raw &= !v,
            a if a == m.txq_done_clr => self.tx_done &= !v,
            a if a == m.rx_first => {
                self.rx_cur = Some(v);
                return Some(v);
            }
            // 重新装载：rx() 在链表到头时本来就会去看最后一个描述符的 next，这里只需把位 0 清掉
            a if m.rx_ctrl != 0 && a == m.rx_ctrl => return Some(v & !1),
            a if a == m.key_valid
                || (m.key_table..m.key_table + KEY_ENTRY * KEY_SLOTS).contains(&a) =>
            {
                self.keys.insert(a, v);
                return Some(v);
            }
            a if a <= m.txq0 && (m.txq0 - a).is_multiple_of(8) && (m.txq0 - a) / 8 < TXQ_NUM => {
                let q = ((m.txq0 - a) / 8) as usize;
                if v & 0x8000_0000 != 0 {
                    self.tx(q, v, now, mem);
                    // 启动位由硬件在发送结束后清除；这里立即清，驱动不会读回它
                    return Some(v & !0xc000_0000);
                }
                return Some(v);
            }
            _ => return Some(v),
        }
        None
    }

    /// 发送队列启动：沿描述符链取出整帧，交给虚拟世界，按空口时间安排"发送完成"与回应
    fn tx(&mut self, q: usize, reg: u32, now: u64, mem: &mut dyn Mem) {
        let mut d = self.layout.mac.desc_hi | (reg & 0xf_ffff);
        let mut f = Vec::new();
        for _ in 0..16 {
            let w0 = mem.rd32(d);
            let buf = mem.rd32(d + 4);
            let len = (w0 >> 12) & 0xfff;
            f.extend(read_bytes(mem, buf, len));
            let next = mem.rd32(d + 8);
            if w0 & (1 << 30) != 0 || next == 0 {
                break;
            }
            d = next;
        }
        // 描述符里的长度含 4 字节 FCS（由硬件生成），帧内容不含
        f.truncate(f.len().saturating_sub(4));
        if is_protected_data(&f) {
            // 驱动已填好 CCMP 头（含 PN）并在末尾留 8 字节 MIC 位置，加密由硬件做
            match self.hw_ccmp(&f, true) {
                Some(e) => f = e,
                None => self.push_log("    （受保护帧找不到密钥，原样发出）".into()),
            }
        }
        let tsf = self.tsf_us(now);
        let (desc, replies, acked) = self.world.on_tx(&f, tsf);
        let unicast = f.len() >= 10 && f[4] & 1 == 0;
        let code = if unicast && !acked { 5 } else { 0 };
        // 空口时间：按 1Mbps 计（管理帧的基本速率），加前导码与 SIFS/ACK
        let air = 192 + f.len() as u64 * 8 + if unicast { 50 } else { 0 };
        let at = now + self.us_to_cycles(air);
        self.schedule(at, Ev::TxDone { q, code });
        for r in replies {
            let at = now + self.us_to_cycles(air + r.delay_us);
            self.schedule(at, Ev::Rx(r));
        }
        self.tx_frames += 1;
        let line = format!("{:>9.3}ms TX q{q} {}B {}", self.ms(now), f.len(), desc);
        self.push_log(line);
    }

    fn push_log(&mut self, s: String) {
        if self.log.len() < 10_000 {
            self.log.push(s);
        }
    }

    /// 把一帧写进下一个空闲接收描述符：元数据头（C3 48 字节 / ESP32 28 字节）+ 帧 + FCS
    fn rx(&mut self, air: world::Air, now: u64, mem: &mut dyn Mem) {
        let mut d = match self.rx_cur {
            Some(d) if d != 0 => d,
            _ => {
                // 链表走到头了：看驱动是否在最后一个描述符后面接了新的
                let next = if self.rx_last != 0 {
                    mem.rd32(self.rx_last + 8)
                } else {
                    0
                };
                if next == 0 {
                    self.rx_dropped += 1;
                    return;
                }
                next
            }
        };
        let w0 = mem.rd32(d);
        if w0 & (1 << 31) == 0 {
            // 不归硬件所有：驱动还没回收，丢帧（真机同样会因缓冲不足丢帧）
            self.rx_dropped += 1;
            return;
        }
        let size = w0 & 0xfff;
        let mut f = air.frame.clone();
        if is_protected_data(&f) {
            // 硬件按密钥表解密：CCMP 头、MIC 位置保留，受保护位不清（ccmp_decap 去掉头尾）
            match self.hw_ccmp(&f, false) {
                Some(p) => f = p,
                None => {
                    self.rx_dropped += 1;
                    self.push_log("    （受保护帧解密失败，丢弃）".into());
                    return;
                }
            }
        }
        let fcs = frame::crc32(&f);
        f.extend_from_slice(&fcs.to_le_bytes());
        let m = self.layout.mac;
        let hdr_len = 4 * m.rx_hdr_words;
        let total = hdr_len + f.len() as u32;
        if total > size {
            self.rx_dropped += 1;
            return;
        }
        let buf = mem.rd32(d + 4);
        let mut hdr = [0u32; 12];
        hdr[0] = ((air.rssi as i32 + m.rx_rssi_bias) as u8 as u32) | (1 << 28); // RSSI、命中接口 0（STA）
        hdr[2] = (air.channel as u32 & 0xf) << 16;
        hdr[3] = self.tsf_us(now) as u32;
        hdr[m.rx_noise_word] |= (-96i8) as u8 as u32; // 噪声底
        hdr[m.rx_len_word] |= f.len() as u32 & 0xfff; // sig_len（含 FCS），rx_state = 0
        for (i, w) in hdr[..m.rx_hdr_words as usize].iter().enumerate() {
            mem.wr32(buf + 4 * i as u32, *w);
        }
        for (i, b) in f.iter().enumerate() {
            mem.wr8(buf + hdr_len + i as u32, *b);
        }
        // 长度、EOF，所有权交还软件
        let w0n = (w0 & 0xfff) | (total << 12) | (1 << 30);
        mem.wr32(d, w0n);
        self.rx_last = d;
        d = mem.rd32(d + 8);
        self.rx_cur = Some(d);
        self.int_raw |= m.ev_rx;
        self.rx_frames += 1;
        let desc = match frame::parse(&air.frame) {
            Some(h) => format!("FC=0x{:02x} 来自 {}", h.fc0, frame::mac_str(&h.a2)),
            None => "?".into(),
        };
        let line = format!(
            "{:>9.3}ms RX {}B ch{} {}dBm {}",
            self.ms(now),
            air.frame.len(),
            air.channel,
            air.rssi,
            desc
        );
        self.push_log(line);
    }

    /// 在硬件密钥表里找对端 MAC 的成对（group = false）或组密钥
    fn hw_key(&self, peer: &frame::Mac, group: bool) -> Option<[u8; 16]> {
        let reg = |a: u32| self.keys.get(&a).copied().unwrap_or(0);
        let valid = reg(self.layout.mac.key_valid);
        (0..KEY_SLOTS)
            .filter(|i| valid & (1 << i) != 0)
            .find_map(|i| {
                let e = self.layout.mac.key_table + KEY_ENTRY * i;
                let (w0, w1) = (reg(e), reg(e + 4));
                let mut mac = [0u8; 6];
                mac[..4].copy_from_slice(&w0.to_le_bytes());
                mac[4..].copy_from_slice(&(w1 as u16).to_le_bytes());
                if mac != *peer || (w1 & KEY_GROUP != 0) != group {
                    return None;
                }
                let mut key = [0u8; 16];
                for j in 0..4 {
                    key[4 * j as usize..4 * j as usize + 4]
                        .copy_from_slice(&reg(e + 8 + 4 * j).to_le_bytes());
                }
                Some(key)
            })
    }

    /// 硬件 CCMP：enc = 发送方向（明文 + 预留 MIC → 密文），否则接收方向（密文 → 明文，保留头尾）
    fn hw_ccmp(&self, f: &[u8], enc: bool) -> Option<Vec<u8>> {
        let hl = frame::parse(f)?.body;
        if f.len() < hl + 16 {
            return None;
        }
        let key_id = f[hl + 3] >> 6;
        let unicast = f[4] & 1 == 0;
        // 单播：发送找接收方（a1）的成对密钥、接收找发送方（a2）的；组播只能是组密钥
        let peer: frame::Mac = if enc {
            f[4..10].try_into().unwrap()
        } else {
            f[10..16].try_into().unwrap()
        };
        let tk = self.hw_key(&peer, !unicast)?;
        let h = &f[hl..hl + 8];
        let pn = u64::from_le_bytes([h[0], h[1], h[4], h[5], h[6], h[7], 0, 0]);
        if enc {
            let mut plain = f[..hl].to_vec();
            plain[1] &= !0x40;
            plain.extend_from_slice(&f[hl + 8..f.len() - 8]);
            Some(crypto::ccmp_encrypt(&tk, &plain, pn, key_id))
        } else {
            let (p, _) = crypto::ccmp_decrypt(&tk, f)?;
            let mut out = f[..hl + 8].to_vec();
            out.extend_from_slice(&p[hl..]);
            out.extend_from_slice(&f[f.len() - 8..]);
            Some(out)
        }
    }

    /// 推进 Wi-Fi 事件；返回下一个事件时刻
    pub fn update(&mut self, now: u64, mem: &mut dyn Mem) -> u64 {
        let beacon = self.us_to_cycles(102_400);
        // 已关联：所连 AP 每 102.4ms 发一次信标
        if let Some(i) = self.world.associated() {
            if self.next_beacon == 0 {
                self.next_beacon = now + beacon;
            }
            while now >= self.next_beacon {
                let tsf = self.tsf_us(now);
                let b = self.world.beacon(i, tsf);
                let at = self.next_beacon;
                self.schedule(at, Ev::Rx(b));
                self.next_beacon += beacon;
            }
        } else {
            self.next_beacon = 0;
        }
        // 虚拟 AP 自己的定时器（WPA2 四次握手重传 / 超时）
        let tsf = self.tsf_us(now);
        if self.world.next_timer().is_some_and(|t| t <= tsf) {
            let (airs, notes) = self.world.poll(tsf);
            for a in airs {
                let at = now + self.us_to_cycles(a.delay_us);
                self.schedule(at, Ev::Rx(a));
            }
            for n in notes {
                let line = format!("{:>9.3}ms AP {}", self.ms(now), n);
                self.push_log(line);
            }
        }
        let timer = self
            .world
            .next_timer()
            .map_or(u64::MAX, |t| self.us_to_cycles(t));
        if self.events.is_empty() {
            return if self.next_beacon != 0 {
                self.next_beacon.min(timer)
            } else {
                timer
            };
        }
        let mut due = Vec::new();
        let mut i = 0;
        while i < self.events.len() {
            if self.events[i].0 <= now {
                due.push(self.events.swap_remove(i));
            } else {
                i += 1;
            }
        }
        due.sort_by_key(|e| e.0);
        for (_, ev) in due {
            match ev {
                Ev::TxDone { q, code } => {
                    self.tx_result[q] = code << 12;
                    self.tx_done |= 1 << q;
                    self.int_raw |= EV_TX_DONE;
                }
                Ev::Rx(air) => self.rx(air, now, mem),
            }
        }
        let mut next = self.events.iter().map(|e| e.0).min().unwrap_or(u64::MAX);
        if self.next_beacon != 0 {
            next = next.min(self.next_beacon);
        }
        next.min(timer)
    }
}

#[cfg(test)]
mod tests;
