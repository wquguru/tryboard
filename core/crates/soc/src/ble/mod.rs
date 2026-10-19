//! BLE 虚拟世界（C-01）：在 VHCI 边界上替换乐鑫的链路层控制器。
//!
//! 固件里的主机协议栈（NimBLE）照常跑，它发出的 HCI 命令 / ACL 交给这里的虚拟 LE 控制器；
//! 控制器只实现"HCI 语义需要的那部分链路层"：广播 / 扫描响应、建立连接、按连接间隔收发 ACL、断开。
//! 空中另一端是一台虚拟手机（中心设备，[`phone::Phone`]），带 L2CAP 与 ATT/GATT 客户端。
//!
//! 一切按模拟时间（微秒）推进，没有墙钟和随机数：同一固件 + 同一输入日志，空中事件逐字节相同。
//! 结论属"行为模拟"：信号距离、穿墙、手机系统差异都不在模型里，必须上真机。

pub mod phone;
pub mod sig;
pub mod sigs;

#[cfg(test)]
mod tests;

use phone::Phone;
use std::collections::VecDeque;

/// 连接句柄（只支持一条连接）
pub const CONN_HANDLE: u16 = 0x0001;
/// 主机侧 ACL 缓冲（LE Read Buffer Size 报给主机的值）
pub const ACL_LEN: u16 = 251;
pub const ACL_NUM: u8 = 12;

/// 空中事件日志的一行（网页"蓝牙"页签、命令行 stderr）
#[derive(Clone, Debug, PartialEq)]
pub struct AirLine {
    pub t_us: u64,
    /// adv / conn / att / hci / phone
    pub kind: &'static str,
    pub text: String,
}

#[derive(Default)]
struct Adv {
    enabled: bool,
    /// 广播间隔（微秒），取 LE Set Advertising Parameters 的最小间隔
    interval_us: u64,
    /// 0 ADV_IND、1 直连高占空、2 ADV_SCAN_IND、3 ADV_NONCONN_IND、4 直连低占空
    kind: u8,
    own_random: bool,
    data: Vec<u8>,
    scan_rsp: Vec<u8>,
    next_us: u64,
}

struct Link {
    interval_us: u64,
    next_event_us: u64,
    /// 主机发来、还没上空中的 ACL 包数（连接事件时上空中并回 Number Of Completed Packets）
    host_pkts: u16,
    /// 主机 → 手机：正在拼的 L2CAP 帧 + 拼好待发的
    rx_frag: Vec<u8>,
    to_phone: VecDeque<Vec<u8>>,
}

pub struct Ble {
    /// 控制器公共地址（HCI 字节序：低字节在前）
    pub addr: [u8; 6],
    random_addr: [u8; 6],
    event_mask: u64,
    le_event_mask: u64,
    adv: Adv,
    link: Option<Link>,
    /// 发给主机的 H4 包（0x04 事件 / 0x02 ACL），按到期时刻排好
    to_host: VecDeque<(u64, Vec<u8>)>,
    rand: u64,
    pub phone: Phone,
    log: VecDeque<AirLine>,
    /// 日志总条数（网页按序号增量取）
    pub log_seq: u64,
    /// 主机发过来的 HCI 命令计数（opcode → 次数），未实现的命令也照样回 Command Complete
    pub unknown_cmds: Vec<(u16, u32)>,
    /// 固件是否已经把控制器初始化起来了（决定网页显不显示"蓝牙"页签）
    pub active: bool,
}

const LOG_CAP: usize = 4000;

impl Ble {
    pub fn new(addr: [u8; 6]) -> Ble {
        Ble {
            addr,
            random_addr: [0; 6],
            event_mask: 0x0000_1fff_ffff_ffff,
            le_event_mask: 0x1f,
            adv: Adv::default(),
            link: None,
            to_host: VecDeque::new(),
            rand: 0x5452_5942_4c45_0001,
            phone: Phone::new(),
            log: VecDeque::new(),
            log_seq: 0,
            unknown_cmds: Vec::new(),
            active: false,
        }
    }

    /// 芯片复位：控制器状态清空、连接断掉；手机（外部世界）还在，回到扫描前的状态
    pub fn chip_reset(&mut self, now: u64) {
        if self.link.take().is_some() {
            self.phone.on_disconnect(now, 0x08);
            self.air(now, "conn", "芯片复位，连接超时断开".into());
        }
        self.adv = Adv::default();
        self.to_host.clear();
        self.active = false;
    }

    pub fn air(&mut self, t_us: u64, kind: &'static str, text: String) {
        if self.log.len() == LOG_CAP {
            self.log.pop_front();
        }
        self.log.push_back(AirLine { t_us, kind, text });
        self.log_seq += 1;
    }

    /// 序号 ≥ from 的日志（序号从 0 起）
    pub fn log_since(&self, from: u64) -> impl Iterator<Item = (u64, &AirLine)> {
        let first = self.log_seq - self.log.len() as u64;
        let skip = from.saturating_sub(first) as usize;
        self.log
            .iter()
            .enumerate()
            .skip(skip)
            .map(move |(i, l)| (first + i as u64, l))
    }

    fn rand64(&mut self) -> u64 {
        // 固定种子的 xorshift：LE Rand 只要"像随机"，重放必须相同
        let mut x = self.rand;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rand = x;
        x
    }

    fn push_event(&mut self, at: u64, code: u8, params: &[u8]) {
        let mut p = vec![0x04, code, params.len() as u8];
        p.extend_from_slice(params);
        self.push_host(at, p);
    }

    fn push_host(&mut self, at: u64, pkt: Vec<u8>) {
        // 保持按时刻有序；同一时刻保持先后
        let i = self
            .to_host
            .iter()
            .rposition(|(t, _)| *t <= at)
            .map_or(0, |i| i + 1);
        self.to_host.insert(i, (at, pkt));
    }

    fn le_meta(&mut self, at: u64, sub: u8, params: &[u8]) {
        if self.le_event_mask & (1 << (sub - 1)) == 0 {
            return;
        }
        let mut p = vec![sub];
        p.extend_from_slice(params);
        self.push_event(at, 0x3e, &p);
    }

    fn cmd_complete(&mut self, at: u64, op: u16, ret: &[u8]) {
        let mut p = vec![1, op as u8, (op >> 8) as u8];
        p.extend_from_slice(ret);
        self.push_event(at, 0x0e, &p);
    }

    fn cmd_status(&mut self, at: u64, op: u16, status: u8) {
        self.push_event(at, 0x0f, &[status, 1, op as u8, (op >> 8) as u8]);
    }

    /// 主机发来一个 H4 包（固件调 esp_vhci_host_send_packet）
    pub fn host_send(&mut self, pkt: &[u8], now: u64) {
        self.active = true;
        match pkt.first() {
            Some(0x01) if pkt.len() >= 4 => {
                let op = u16::from_le_bytes([pkt[1], pkt[2]]);
                let n = (pkt[3] as usize).min(pkt.len() - 4);
                let p = pkt[4..4 + n].to_vec();
                self.command(op, &p, now);
            }
            Some(0x02) if pkt.len() >= 5 => {
                let hf = u16::from_le_bytes([pkt[1], pkt[2]]);
                let n = (u16::from_le_bytes([pkt[3], pkt[4]]) as usize).min(pkt.len() - 5);
                self.host_acl(hf & 0x0fff, (hf >> 12) as u8 & 3, &pkt[5..5 + n], now);
            }
            _ => self.air(now, "hci", format!("主机发来未知 H4 包 {:02x?}", pkt)),
        }
    }

    fn command(&mut self, op: u16, p: &[u8], now: u64) {
        let at = now;
        let u16at = |i: usize| {
            p.get(i..i + 2)
                .map_or(0, |b| u16::from_le_bytes([b[0], b[1]]))
        };
        match op {
            // HCI_Reset
            0x0c03 => {
                self.adv = Adv::default();
                self.link = None;
                self.event_mask = 0x0000_1fff_ffff_ffff;
                self.le_event_mask = 0x1f;
                self.cmd_complete(at, op, &[0]);
            }
            0x0c01 => {
                self.event_mask = u64::from_le_bytes(
                    p.get(..8)
                        .and_then(|b| b.try_into().ok())
                        .unwrap_or([0xff; 8]),
                );
                self.cmd_complete(at, op, &[0]);
            }
            0x2001 => {
                self.le_event_mask = u64::from_le_bytes(
                    p.get(..8)
                        .and_then(|b| b.try_into().ok())
                        .unwrap_or([0xff; 8]),
                );
                self.cmd_complete(at, op, &[0]);
            }
            // Read Local Version：HCI / LMP 5.0（0x09），厂商 0x02E5（乐鑫）
            0x1001 => self.cmd_complete(at, op, &[0, 0x09, 0, 0, 0x09, 0xe5, 0x02, 0, 0]),
            // Read Local Supported Commands：全 0（主机走最保守的路径）
            0x1002 => {
                let mut r = vec![0u8; 65];
                r[0] = 0;
                self.cmd_complete(at, op, &r);
            }
            // Read Local Supported Features：只支持 LE（位 38），不支持 BR/EDR（位 37）
            0x1003 => self.cmd_complete(at, op, &[0, 0, 0, 0, 0, 0x60, 0, 0, 0]),
            0x1005 => self.cmd_complete(at, op, &[0, 0, 0, 0, 0, 0, 0, 0, 0]),
            0x1009 => {
                let mut r = vec![0];
                r.extend_from_slice(&self.addr);
                self.cmd_complete(at, op, &r);
            }
            0x2002 => {
                let l = ACL_LEN.to_le_bytes();
                self.cmd_complete(at, op, &[0, l[0], l[1], ACL_NUM]);
            }
            // LE 本地特性：全 0（不报数据长度扩展、隐私、2M、扩展广播，主机就不会发这些命令）
            0x2003 => self.cmd_complete(at, op, &[0, 0, 0, 0, 0, 0, 0, 0, 0]),
            0x2005 => {
                if let Some(a) = p.get(..6) {
                    self.random_addr.copy_from_slice(a);
                }
                self.cmd_complete(at, op, &[0]);
            }
            0x2006 => {
                let min = u16at(0).max(0x20) as u64;
                self.adv.interval_us = min * 625;
                self.adv.kind = p.get(4).copied().unwrap_or(0);
                self.adv.own_random = p.get(5).copied().unwrap_or(0) & 1 == 1;
                self.cmd_complete(at, op, &[0]);
            }
            0x2007 => self.cmd_complete(at, op, &[0, 9]),
            0x2008 | 0x2009 => {
                let n = (p.first().copied().unwrap_or(0) as usize)
                    .min(31)
                    .min(p.len().saturating_sub(1));
                let d = p[1..1 + n].to_vec();
                if op == 0x2008 {
                    self.adv.data = d;
                } else {
                    self.adv.scan_rsp = d;
                }
                self.cmd_complete(at, op, &[0]);
            }
            0x200a => {
                let on = p.first().copied().unwrap_or(0) == 1;
                if on && self.link.is_some() {
                    // 只支持一条连接：连着时不再广播（真控制器会报 0x0C 命令不允许）
                    self.cmd_complete(at, op, &[0x0c]);
                    return;
                }
                if on != self.adv.enabled {
                    self.adv.enabled = on;
                    self.adv.next_us = now + 1000;
                    let name = adv_name(&self.adv.data).unwrap_or_default();
                    self.air(
                        now,
                        "adv",
                        if on {
                            format!(
                                "开始广播 {}（间隔 {} ms）",
                                name,
                                self.adv.interval_us / 1000
                            )
                        } else {
                            "停止广播".into()
                        },
                    );
                }
                self.cmd_complete(at, op, &[0]);
            }
            0x200f => self.cmd_complete(at, op, &[0, 12]),
            // Read Remote Version：从机侧 NimBLE 等它完成才上报 BLE_GAP_EVENT_CONNECT
            0x041d => {
                self.cmd_status(at, op, 0);
                let h = CONN_HANDLE.to_le_bytes();
                // 手机：LL 5.0，厂商号 0xFFFF（规范保留给测试用）
                self.push_event(at + 30_000, 0x0c, &[0, h[0], h[1], 0x09, 0xff, 0xff, 0, 0]);
            }
            0x2016 => {
                self.cmd_status(at, op, 0);
                let h = CONN_HANDLE.to_le_bytes();
                let mut r = vec![0, h[0], h[1]];
                r.extend_from_slice(&[0x01, 0, 0, 0, 0, 0, 0, 0]);
                self.le_meta(at + 30_000, 0x04, &r);
            }
            0x2018 => {
                let r = self.rand64().to_le_bytes();
                let mut v = vec![0];
                v.extend_from_slice(&r);
                self.cmd_complete(at, op, &v);
            }
            0x201c => self.cmd_complete(at, op, &[0, 0xff, 0xff, 0xff, 0x03, 0, 0, 0, 0]),
            0x2013 => {
                self.cmd_status(at, op, 0);
                let itv = u16at(2).max(6);
                if let Some(l) = self.link.as_mut() {
                    l.interval_us = itv as u64 * 1250;
                }
                let h = CONN_HANDLE.to_le_bytes();
                let mut r = vec![0, h[0], h[1]];
                r.extend_from_slice(&itv.to_le_bytes());
                r.extend_from_slice(p.get(6..10).unwrap_or(&[0, 0, 0xf4, 0x01]));
                self.le_meta(at + 60_000, 0x03, &r);
            }
            0x2022 => {
                let h = CONN_HANDLE.to_le_bytes();
                self.cmd_complete(at, op, &[0, h[0], h[1]]);
            }
            0x2023 => self.cmd_complete(at, op, &[0, 27, 0, 0x48, 0x01]),
            0x202f => self.cmd_complete(at, op, &[0, 27, 0, 0x48, 0x01, 27, 0, 0x48, 0x01]),
            0x202a => self.cmd_complete(at, op, &[0, 8]),
            0x2030 => {
                let h = CONN_HANDLE.to_le_bytes();
                self.cmd_complete(at, op, &[0, h[0], h[1], 1, 1]);
            }
            0x2032 => {
                self.cmd_status(at, op, 0);
                let h = CONN_HANDLE.to_le_bytes();
                self.le_meta(at + 30_000, 0x0c, &[0, h[0], h[1], 1, 1]);
            }
            0x1405 => {
                let h = CONN_HANDLE.to_le_bytes();
                self.cmd_complete(at, op, &[0, h[0], h[1], self.phone.rssi as u8]);
            }
            // Disconnect
            0x0406 => {
                if self.link.is_some() {
                    self.cmd_status(at, op, 0);
                    let reason = p.get(2).copied().unwrap_or(0x13);
                    self.link = None;
                    self.phone.on_disconnect(now, reason);
                    self.air(now, "conn", format!("固件断开连接（原因 0x{reason:02x}）"));
                    let h = CONN_HANDLE.to_le_bytes();
                    self.push_event(at + 10_000, 0x05, &[0, h[0], h[1], 0x16]);
                } else {
                    self.cmd_status(at, op, 0x02);
                }
            }
            _ => {
                // 其余命令（含乐鑫厂商命令 0xFCxx、各种"设置"命令）一律回成功、不带返回值
                match self.unknown_cmds.iter_mut().find(|(o, _)| *o == op) {
                    Some(e) => e.1 += 1,
                    None => self.unknown_cmds.push((op, 1)),
                }
                self.cmd_complete(at, op, &[0]);
            }
        }
    }

    fn host_acl(&mut self, handle: u16, pb: u8, data: &[u8], now: u64) {
        let Some(l) = self.link.as_mut() else {
            return;
        };
        if handle != CONN_HANDLE {
            return;
        }
        l.host_pkts += 1;
        if pb != 1 {
            l.rx_frag.clear();
        }
        l.rx_frag.extend_from_slice(data);
        if l.rx_frag.len() >= 4 {
            let need = u16::from_le_bytes([l.rx_frag[0], l.rx_frag[1]]) as usize + 4;
            if l.rx_frag.len() >= need {
                let f: Vec<u8> = std::mem::take(&mut l.rx_frag);
                l.to_phone.push_back(f);
            }
        }
        let _ = now;
    }

    /// 下一个到期事件（给主机的包、广播、连接事件、手机定时器）的时刻
    pub fn next_due(&self) -> Option<u64> {
        let mut t = self.to_host.front().map(|x| x.0);
        let mut m = |x: Option<u64>| {
            if let Some(x) = x {
                t = Some(t.map_or(x, |t: u64| t.min(x)));
            }
        };
        if self.adv.enabled && self.phone.wants_adv() {
            m(Some(self.adv.next_us));
        }
        if let Some(l) = &self.link {
            m(Some(l.next_event_us));
        }
        m(self.phone.next_timer());
        t
    }

    /// 推进到 now：处理到期的广播事件、连接事件、手机定时器；取出一个到期的给主机的包
    pub fn poll(&mut self, now: u64) -> Option<Vec<u8>> {
        self.advance(now);
        if self.to_host.front().is_some_and(|x| x.0 <= now) {
            return self.to_host.pop_front().map(|x| x.1);
        }
        None
    }

    fn advance(&mut self, now: u64) {
        // 手机侧定时器（扫描超时、自动流程）
        let acts = self.phone.tick(now);
        for a in acts {
            self.phone_action(a, now);
        }
        // 广播：只有手机在扫描或等着连接时才逐个事件模拟（没人听时广播不影响固件，省得空转）
        while self.adv.enabled && self.adv.next_us <= now {
            let t = self.adv.next_us;
            self.adv.next_us += self.adv.interval_us.max(20_000);
            if !self.phone.wants_adv() {
                // 跳到当前时刻附近，免得关掉扫描很久后再打开要补跑一大串
                if self.adv.next_us < now {
                    let k = (now - self.adv.next_us) / self.adv.interval_us.max(20_000) + 1;
                    self.adv.next_us += k * self.adv.interval_us.max(20_000);
                }
                continue;
            }
            self.adv_event(t);
            if self.link.is_some() {
                break;
            }
        }
        // 连接事件
        while let Some(l) = self.link.as_mut() {
            if l.next_event_us > now {
                break;
            }
            let t = l.next_event_us;
            l.next_event_us += l.interval_us;
            self.conn_event(t);
        }
    }

    fn own_addr(&self) -> ([u8; 6], u8) {
        if self.adv.own_random {
            (self.random_addr, 1)
        } else {
            (self.addr, 0)
        }
    }

    fn adv_event(&mut self, t: u64) {
        let connectable = matches!(self.adv.kind, 0 | 1 | 4);
        let scannable = matches!(self.adv.kind, 0 | 2);
        let (addr, atype) = self.own_addr();
        let data = self.adv.data.clone();
        let rsp = self.adv.scan_rsp.clone();
        let pdu = [
            "ADV_IND",
            "ADV_DIRECT_IND",
            "ADV_SCAN_IND",
            "ADV_NONCONN_IND",
            "ADV_DIRECT_IND",
        ][self.adv.kind.min(4) as usize];
        let first = self.phone.on_adv(t, addr, atype, connectable, &data, pdu);
        if first {
            self.air(
                t,
                "adv",
                format!("{pdu} {} 数据 {}", fmt_addr(&addr), hex(&data)),
            );
        }
        if scannable && self.phone.scanning() {
            if first {
                self.air(t, "adv", format!("SCAN_REQ → SCAN_RSP 数据 {}", hex(&rsp)));
            }
            self.phone.on_scan_rsp(addr, &rsp);
        }
        if connectable && self.phone.connect_target() == Some(addr) {
            // CONNECT_IND：手机发起连接，固件这边广播结束、连接建立
            let interval_us = phone::CONN_INTERVAL_US;
            self.adv.enabled = false;
            self.link = Some(Link {
                interval_us,
                next_event_us: t + 1250 + interval_us,
                host_pkts: 0,
                rx_frag: Vec::new(),
                to_phone: VecDeque::new(),
            });
            let paddr = self.phone.addr;
            self.air(
                t,
                "conn",
                format!(
                    "CONNECT_IND 手机 {} → {}（间隔 {} ms）",
                    fmt_addr(&paddr),
                    fmt_addr(&addr),
                    interval_us / 1000
                ),
            );
            self.phone.on_connected(t);
            let h = CONN_HANDLE.to_le_bytes();
            let itv = ((interval_us / 1250) as u16).to_le_bytes();
            // 角色 1 = 从机；对端地址类型 1 = 随机地址（手机）；监督超时 5 s
            let mut r = vec![0, h[0], h[1], 1, 1];
            r.extend_from_slice(&paddr);
            let enhanced = self.le_event_mask & (1 << 9) != 0;
            if enhanced {
                r.extend_from_slice(&[0; 12]);
            }
            r.extend_from_slice(&[itv[0], itv[1], 0, 0, 0xf4, 0x01, 0]);
            self.le_meta(t + 1250, if enhanced { 0x0a } else { 0x01 }, &r);
        }
    }

    fn conn_event(&mut self, t: u64) {
        let Some(l) = self.link.as_mut() else { return };
        // 主机 → 手机
        let frames: Vec<Vec<u8>> = l.to_phone.drain(..).collect();
        let done = std::mem::take(&mut l.host_pkts);
        if done > 0 {
            let h = CONN_HANDLE.to_le_bytes();
            let n = done.to_le_bytes();
            self.push_event(t, 0x13, &[1, h[0], h[1], n[0], n[1]]);
        }
        for f in frames {
            if f.len() < 4 {
                continue;
            }
            let cid = u16::from_le_bytes([f[2], f[3]]);
            let (lines, replies) = self.phone.on_l2cap(t, cid, &f[4..]);
            for s in lines {
                self.air(t, "att", s);
            }
            for r in replies {
                self.phone.queue_tx(r);
            }
        }
        // 手机 → 主机：每个连接事件发出排队的 PDU
        let (lines, out) = self.phone.conn_event(t);
        for s in lines {
            self.air(t, "att", s);
        }
        for (cid, payload) in out {
            let mut l2 = Vec::with_capacity(payload.len() + 4);
            l2.extend_from_slice(&(payload.len() as u16).to_le_bytes());
            l2.extend_from_slice(&cid.to_le_bytes());
            l2.extend_from_slice(&payload);
            let hf = CONN_HANDLE | (0b10 << 12);
            let mut p = vec![0x02];
            p.extend_from_slice(&hf.to_le_bytes());
            p.extend_from_slice(&(l2.len() as u16).to_le_bytes());
            p.extend_from_slice(&l2);
            self.push_host(t, p);
        }
        if self.phone.wants_disconnect() {
            self.link = None;
            self.phone.on_disconnect(t, 0x13);
            self.air(t, "conn", "手机断开连接".into());
            let h = CONN_HANDLE.to_le_bytes();
            self.push_event(t, 0x05, &[0, h[0], h[1], 0x13]);
        }
    }

    fn phone_action(&mut self, a: phone::Action, now: u64) {
        match a {
            phone::Action::Log(s) => self.air(now, "phone", s),
        }
    }

    /// 网页 / 输入日志里的手机操作（`ble=` 后面那段）。返回错误文字给调用方提示
    pub fn phone_cmd(&mut self, cmd: &str, now: u64) -> Result<(), String> {
        let lines = self.phone.command(cmd, now)?;
        for s in lines {
            self.air(now, "phone", s);
        }
        // 手机开始扫描时，广播从当前时刻接着发（之前没人听时跳过的不补）
        if self.adv.enabled && self.adv.next_us < now {
            self.adv.next_us = now;
        }
        Ok(())
    }

    pub fn connected(&self) -> bool {
        self.link.is_some()
    }

    pub fn advertising(&self) -> bool {
        self.adv.enabled
    }

    /// 网页用：广播 / 连接 / 手机视图的 JSON
    pub fn json(&self) -> String {
        format!(
            "{{\"active\":{},\"advertising\":{},\"adv_name\":{},\"connected\":{},\"addr\":\"{}\",\"log_seq\":{},\"phone\":{}}}",
            self.active,
            self.adv.enabled,
            json_str(&adv_name(&self.adv.data).unwrap_or_default()),
            self.link.is_some(),
            fmt_addr(&self.own_addr().0),
            self.log_seq,
            self.phone.json()
        )
    }

    /// 网页用：序号 ≥ from 的空中日志 JSON 数组
    pub fn log_json(&self, from: u64) -> String {
        let mut s = String::from("[");
        for (i, (n, l)) in self.log_since(from).enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!(
                "{{\"n\":{n},\"t\":{},\"k\":\"{}\",\"s\":{}}}",
                l.t_us,
                l.kind,
                json_str(&l.text)
            ));
        }
        s.push(']');
        s
    }
}

/// 广播数据里的设备名（AD 类型 0x09 完整名 / 0x08 简称）
pub fn adv_name(d: &[u8]) -> Option<String> {
    ad_fields(d)
        .find(|(t, _)| *t == 0x09 || *t == 0x08)
        .map(|(_, v)| String::from_utf8_lossy(v).into_owned())
}

/// 广播数据里的 16 位服务 UUID（AD 类型 0x02 / 0x03）
pub fn adv_uuids(d: &[u8]) -> Vec<u16> {
    ad_fields(d)
        .filter(|(t, _)| *t == 0x02 || *t == 0x03)
        .flat_map(|(_, v)| {
            v.as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn ad_fields(d: &[u8]) -> impl Iterator<Item = (u8, &[u8])> {
    let mut p = 0;
    std::iter::from_fn(move || {
        let n = *d.get(p)? as usize;
        if n == 0 || p + 1 + n > d.len() {
            return None;
        }
        let f = (d[p + 1], &d[p + 2..p + 1 + n]);
        p += 1 + n;
        Some(f)
    })
}

/// 地址按习惯写法（高字节在前）
pub fn fmt_addr(a: &[u8; 6]) -> String {
    format!(
        "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
        a[5], a[4], a[3], a[2], a[1], a[0]
    )
}

pub fn hex(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{x:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}
