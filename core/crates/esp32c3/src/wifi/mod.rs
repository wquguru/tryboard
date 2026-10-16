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

use crate::periph::CPU_HZ;
use crate::SocBus;

/// 对射频相关寄存器的读：返回 Some 表示由本模块给值（stored 是该地址上次写入的值）。
pub fn rf_read(a: u32, stored: u32) -> Option<u32> {
    Some(match a {
        // SAR / 峰值检测状态：位 26..24 == 7 表示空闲（rom_pkdet_vol_start、rom1_read_sar2_code 轮询）
        0x6000_e050 => stored | (7 << 24),
        // TX 直流校准比较器：位 24 = 转换完成（txdc_cal_v70 轮询），位 30 是比较结果，保持写入值
        0x6000_e04c => stored | (1 << 24),
        // FE：IQ 估计完成（位 16，rom_iq_est_enable 轮询）
        0x6000_6174 => stored | (1 << 16),
        // MAC：hal_init 写位 1 后等位 0 就绪
        0x6003_3d14 => stored | ((stored >> 1) & 1),
        _ => return None,
    })
}

// MAC 寄存器（基址 0x60033000，见 docs/WIFI.md）
const MAC_INT_ENA: u32 = 0x6003_3c34;
const MAC_INT_ST: u32 = 0x6003_3c3c;
const MAC_INT_CLR: u32 = 0x6003_3c40;
const RX_FIRST_DESC: u32 = 0x6003_3088;
const RX_LAST_DESC: u32 = 0x6003_3090;
const TXQ_DONE: u32 = 0x6003_3cb0;
const TXQ_DONE_CLR: u32 = 0x6003_3cac;
/// 发送队列 q 的配置寄存器 = 0x60033D08 - 8q；位 19..0 描述符地址低 20 位，位 31/30 启动
const TXQ0: u32 = 0x6003_3d08;
const TXQ_NUM: u32 = 5;
/// 发送结果 = 0x60034320 - 76q：位 15..12 结果码（0 成功，5 ACK 超时）
const TXQ_RESULT0: u32 = 0x6003_4320;

// MAC 中断事件位（wDev_ProcessFiq）
const EV_TX_DONE: u32 = 1 << 7;
const EV_RX: u32 = 1 << 14;

/// 硬件密钥表（hal_crypto_set_key_entry）：有效位图 + 每项 40 字节
/// 字 0 = 对端 MAC 字节 0..3，字 1 低 16 位 = MAC 字节 4..5、位 30 = 组密钥，字 2.. = 密钥（按内存字节装载）。
/// 字 1 高位其余字段（算法、槽位类别）没有用到：实测 IDF 把 GTK 装在槽 0、PTK 装在槽 4，对端都是 BSSID
const KEY_VALID: u32 = 0x6003_3814;
const KEY_GROUP: u32 = 1 << 30;
const KEY_TABLE: u32 = 0x6003_4400;
const KEY_ENTRY: u32 = 40;

/// 接收描述符里硬件写的元数据头（wifi_pkt_rx_ctrl_t，C3 为 12 个字）
const RX_HDR: u32 = 48;

enum Ev {
    TxDone { q: usize, code: u32 },
    Rx(world::Air),
}

#[derive(Default)]
pub struct WifiMac {
    pub int_raw: u32,
    pub int_ena: u32,
    tx_done: u32,
    tx_result: [u32; TXQ_NUM as usize],
    /// 下一个要填的接收描述符；None 表示从 RX_FIRST_DESC 开始
    rx_cur: Option<u32>,
    /// 最近一次填好的描述符（链表到头时从它的 next 继续）
    rx_last: u32,
    events: Vec<(u64, Ev)>,
    next_beacon: u64,
    pub world: world::World,
    /// 空中日志：给 CLI / 网页看
    pub log: Vec<String>,
    pub rx_dropped: u64,
    pub tx_frames: u64,
    pub rx_frames: u64,
}

impl WifiMac {
    pub fn irq(&self) -> bool {
        self.int_raw & self.int_ena != 0
    }

    fn schedule(&mut self, at: u64, ev: Ev) {
        self.events.push((at, ev));
    }
}

/// 置了受保护位的数据帧
fn is_protected_data(f: &[u8]) -> bool {
    f.len() >= 24 && f[0] & 0x0c == 0x08 && f[1] & 0x40 != 0
}

fn us_to_cycles(us: u64) -> u64 {
    us * (CPU_HZ / 1_000_000)
}

impl SocBus {
    fn tsf_us(&self) -> u64 {
        self.now / (CPU_HZ / 1_000_000)
    }

    /// Wi-Fi 相关寄存器的读；None 走通用读回
    pub(crate) fn wifi_read(&mut self, a: u32) -> Option<u32> {
        let w = &self.wifi;
        Some(match a {
            MAC_INT_ST => w.int_raw & w.int_ena,
            MAC_INT_ENA => w.int_ena,
            TXQ_DONE => w.tx_done,
            0x6003_3ca8 => 0,
            RX_LAST_DESC => w.rx_last & 0xf_ffff,
            a if (TXQ_RESULT0 - 76 * (TXQ_NUM - 1)..=TXQ_RESULT0).contains(&a) && (TXQ_RESULT0 - a).is_multiple_of(76) => {
                w.tx_result[((TXQ_RESULT0 - a) / 76) as usize]
            }
            // TSF 计时器（微秒）
            0x6003_5018 => self.tsf_us() as u32,
            0x6003_501c => (self.tsf_us() >> 32) as u32,
            // 省电模块中断状态
            0x6003_5118 => 0,
            _ => return None,
        })
    }

    /// Wi-Fi 相关寄存器的写；返回 true 表示已处理、不再存进通用寄存器表
    pub(crate) fn wifi_write(&mut self, a: u32, v: u32) -> bool {
        match a {
            MAC_INT_ENA => self.wifi.int_ena = v,
            MAC_INT_CLR => self.wifi.int_raw &= !v,
            TXQ_DONE_CLR => self.wifi.tx_done &= !v,
            RX_FIRST_DESC => {
                self.wifi.rx_cur = Some(v);
                return false;
            }
            a if (TXQ0 - 8 * (TXQ_NUM - 1)..=TXQ0).contains(&a) && (TXQ0 - a).is_multiple_of(8) => {
                let q = ((TXQ0 - a) / 8) as usize;
                if v & 0x8000_0000 != 0 {
                    self.wifi_tx(q, v);
                    // 启动位由硬件在发送结束后清除；这里立即清，驱动不会读回它
                    self.regs.insert(a, v & !0xc000_0000);
                    return true;
                }
                return false;
            }
            _ => return false,
        }
        self.irq_dirty = true;
        true
    }

    fn read_bytes(&self, a: u32, n: u32) -> Vec<u8> {
        (0..n).map(|i| self.mem_read(a + i, 1).unwrap_or(0) as u8).collect()
    }

    /// 发送队列启动：沿描述符链取出整帧，交给虚拟世界，按空口时间安排"发送完成"与回应
    fn wifi_tx(&mut self, q: usize, reg: u32) {
        let mut d = 0x3fc0_0000 | (reg & 0xf_ffff);
        let mut f = Vec::new();
        for _ in 0..16 {
            let w0 = self.mem_read(d, 4).unwrap_or(0);
            let buf = self.mem_read(d + 4, 4).unwrap_or(0);
            let len = (w0 >> 12) & 0xfff;
            f.extend(self.read_bytes(buf, len));
            let next = self.mem_read(d + 8, 4).unwrap_or(0);
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
                None => self.wifi_log("    （受保护帧找不到密钥，原样发出）".into()),
            }
        }
        let tsf = self.tsf_us();
        let (desc, replies, acked) = self.wifi.world.on_tx(&f, tsf);
        let unicast = f.len() >= 10 && f[4] & 1 == 0;
        let code = if unicast && !acked { 5 } else { 0 };
        // 空口时间：按 1Mbps 计（管理帧的基本速率），加前导码与 SIFS/ACK
        let air = 192 + f.len() as u64 * 8 + if unicast { 50 } else { 0 };
        let now = self.now;
        self.wifi.schedule(now + us_to_cycles(air), Ev::TxDone { q, code });
        for r in replies {
            let at = now + us_to_cycles(air + r.delay_us);
            self.wifi.schedule(at, Ev::Rx(r));
        }
        self.wifi.tx_frames += 1;
        let line = format!("{:>9.3}ms TX q{q} {}B {}", now as f64 / (CPU_HZ / 1000) as f64, f.len(), desc);
        self.wifi_log(line);
    }

    fn wifi_log(&mut self, s: String) {
        if self.wifi.log.len() < 10_000 {
            self.wifi.log.push(s);
        }
    }

    /// 把一帧写进下一个空闲接收描述符：48 字节元数据头 + 帧 + FCS
    fn wifi_rx(&mut self, air: world::Air) {
        let mut d = match self.wifi.rx_cur {
            Some(d) if d != 0 => d,
            _ => {
                // 链表走到头了：看驱动是否在最后一个描述符后面接了新的
                let next = if self.wifi.rx_last != 0 { self.mem_read(self.wifi.rx_last + 8, 4).unwrap_or(0) } else { 0 };
                if next == 0 {
                    self.wifi.rx_dropped += 1;
                    return;
                }
                next
            }
        };
        let w0 = self.mem_read(d, 4).unwrap_or(0);
        if w0 & (1 << 31) == 0 {
            // 不归硬件所有：驱动还没回收，丢帧（真机同样会因缓冲不足丢帧）
            self.wifi.rx_dropped += 1;
            return;
        }
        let size = w0 & 0xfff;
        let mut f = air.frame.clone();
        if is_protected_data(&f) {
            // 硬件按密钥表解密：CCMP 头、MIC 位置保留，受保护位不清（ccmp_decap 去掉头尾）
            match self.hw_ccmp(&f, false) {
                Some(p) => f = p,
                None => {
                    self.wifi.rx_dropped += 1;
                    self.wifi_log("    （受保护帧解密失败，丢弃）".into());
                    return;
                }
            }
        }
        let fcs = frame::crc32(&f);
        f.extend_from_slice(&fcs.to_le_bytes());
        let total = RX_HDR + f.len() as u32;
        if total > size {
            self.wifi.rx_dropped += 1;
            return;
        }
        let buf = self.mem_read(d + 4, 4).unwrap_or(0);
        let mut hdr = [0u32; 12];
        hdr[0] = (air.rssi as u8 as u32) | (1 << 28); // RSSI、命中接口 0（STA）
        hdr[2] = (air.channel as u32 & 0xf) << 16;
        hdr[3] = self.tsf_us() as u32;
        hdr[5] = (-96i8) as u8 as u32; // 噪声底
        hdr[11] = f.len() as u32 & 0xfff; // sig_len（含 FCS），rx_state = 0
        for (i, w) in hdr.iter().enumerate() {
            self.mem_write(buf + 4 * i as u32, 4, *w);
        }
        for (i, b) in f.iter().enumerate() {
            self.mem_write(buf + RX_HDR + i as u32, 1, *b as u32);
        }
        // 长度、EOF，所有权交还软件
        let w0n = (w0 & 0xfff) | (total << 12) | (1 << 30);
        self.mem_write(d, 4, w0n);
        self.wifi.rx_last = d;
        d = self.mem_read(d + 8, 4).unwrap_or(0);
        self.wifi.rx_cur = Some(d);
        self.wifi.int_raw |= EV_RX;
        self.wifi.rx_frames += 1;
        let desc = match frame::parse(&air.frame) {
            Some(h) => format!("FC=0x{:02x} 来自 {}", h.fc0, frame::mac_str(&h.a2)),
            None => "?".into(),
        };
        let line = format!(
            "{:>9.3}ms RX {}B ch{} {}dBm {}",
            self.now as f64 / (CPU_HZ / 1000) as f64,
            air.frame.len(),
            air.channel,
            air.rssi,
            desc
        );
        self.wifi_log(line);
    }

    /// 在硬件密钥表里找对端 MAC 的成对（group = false）或组密钥
    fn hw_key(&self, peer: &frame::Mac, group: bool) -> Option<[u8; 16]> {
        let reg = |a: u32| self.regs.get(&a).copied().unwrap_or(0);
        let valid = reg(KEY_VALID);
        (0..32).filter(|i| valid & (1 << i) != 0).find_map(|i| {
            let e = KEY_TABLE + KEY_ENTRY * i;
            let (w0, w1) = (reg(e), reg(e + 4));
            let mut mac = [0u8; 6];
            mac[..4].copy_from_slice(&w0.to_le_bytes());
            mac[4..].copy_from_slice(&(w1 as u16).to_le_bytes());
            if mac != *peer || (w1 & KEY_GROUP != 0) != group {
                return None;
            }
            let mut key = [0u8; 16];
            for j in 0..4 {
                key[4 * j as usize..4 * j as usize + 4].copy_from_slice(&reg(e + 8 + 4 * j).to_le_bytes());
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
        let peer: frame::Mac = if enc { f[4..10].try_into().unwrap() } else { f[10..16].try_into().unwrap() };
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
    pub(crate) fn wifi_update(&mut self, now: u64) -> u64 {
        // 已关联：所连 AP 每 102.4ms 发一次信标
        if let Some(i) = self.wifi.world.associated() {
            if self.wifi.next_beacon == 0 {
                self.wifi.next_beacon = now + us_to_cycles(102_400);
            }
            while now >= self.wifi.next_beacon {
                let tsf = self.tsf_us();
                let b = self.wifi.world.beacon(i, tsf);
                let at = self.wifi.next_beacon;
                self.wifi.schedule(at, Ev::Rx(b));
                self.wifi.next_beacon += us_to_cycles(102_400);
            }
        } else {
            self.wifi.next_beacon = 0;
        }
        // 虚拟 AP 自己的定时器（WPA2 四次握手重传 / 超时）
        let tsf = self.tsf_us();
        if self.wifi.world.next_timer().is_some_and(|t| t <= tsf) {
            let (airs, notes) = self.wifi.world.poll(tsf);
            for a in airs {
                let at = now + us_to_cycles(a.delay_us);
                self.wifi.schedule(at, Ev::Rx(a));
            }
            for n in notes {
                let line = format!("{:>9.3}ms AP {}", now as f64 / (CPU_HZ / 1000) as f64, n);
                self.wifi_log(line);
            }
        }
        let timer = self.wifi.world.next_timer().map_or(u64::MAX, us_to_cycles);
        if self.wifi.events.is_empty() {
            return if self.wifi.next_beacon != 0 { self.wifi.next_beacon.min(timer) } else { timer };
        }
        let mut due = Vec::new();
        let mut i = 0;
        while i < self.wifi.events.len() {
            if self.wifi.events[i].0 <= now {
                due.push(self.wifi.events.swap_remove(i));
            } else {
                i += 1;
            }
        }
        due.sort_by_key(|e| e.0);
        for (_, ev) in due {
            match ev {
                Ev::TxDone { q, code } => {
                    self.wifi.tx_result[q] = code << 12;
                    self.wifi.tx_done |= 1 << q;
                    self.wifi.int_raw |= EV_TX_DONE;
                }
                Ev::Rx(air) => self.wifi_rx(air),
            }
            self.irq_dirty = true;
        }
        let mut next = self.wifi.events.iter().map(|e| e.0).min().unwrap_or(u64::MAX);
        if self.wifi.next_beacon != 0 {
            next = next.min(self.wifi.next_beacon);
        }
        next.min(timer)
    }
}

#[cfg(test)]
mod tests;
