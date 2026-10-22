//! BLE virtual world (C-01): replaces Espressif's link-layer controller at the VHCI boundary. lint: allow-long-comment
//! The firmware's host stack (NimBLE) runs unchanged; its HCI commands / ACL go to a virtual LE controller that only does
//! the link layer HCI semantics need (advertising, scan response, connect, ACL per connection interval, disconnect).
//! The peer is a virtual phone (central, [`phone::Phone`]) with L2CAP and an ATT/GATT client.
//! Driven by simulated time (us), no wall clock or RNG, so same firmware + input log gives byte-identical air events.
//! Behavioural only: range, walls and phone OS differences are not modelled and need real hardware.

pub mod desk;
pub mod phone;
pub mod sig;
pub mod sig_xt;
pub mod sigs;
pub mod sigs_xt;

#[cfg(test)]
mod cover;
#[cfg(test)]
mod tests;

use phone::Phone;
use std::collections::VecDeque;

/// Connection handle (only one connection is supported)
pub const CONN_HANDLE: u16 = 0x0001;
/// Host-side ACL buffer size reported by LE Read Buffer Size
pub const ACL_LEN: u16 = 251;
pub const ACL_NUM: u8 = 12;

/// One line of the air event log (web Bluetooth tab, CLI stderr)
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
    /// Advertising interval (us), taken from the minimum interval of LE Set Advertising Parameters
    interval_us: u64,
    /// 0 ADV_IND, 1 directed high duty, 2 ADV_SCAN_IND, 3 ADV_NONCONN_IND, 4 directed low duty
    kind: u8,
    own_random: bool,
    data: Vec<u8>,
    scan_rsp: Vec<u8>,
    next_us: u64,
}

struct Link {
    interval_us: u64,
    next_event_us: u64,
    /// ACL packets from the host not yet on air (sent at the connection event, then Number Of Completed Packets)
    host_pkts: u16,
    /// Host -> phone: L2CAP frame being reassembled + finished frames waiting to send
    rx_frag: Vec<u8>,
    to_phone: VecDeque<Vec<u8>>,
}

pub struct Ble {
    /// Controller public address (HCI byte order: low byte first)
    pub addr: [u8; 6],
    random_addr: [u8; 6],
    event_mask: u64,
    le_event_mask: u64,
    adv: Adv,
    link: Option<Link>,
    /// H4 packets to the host (0x04 event / 0x02 ACL), sorted by due time
    to_host: VecDeque<(u64, Vec<u8>)>,
    rand: u64,
    pub phone: Phone,
    log: VecDeque<AirLine>,
    /// Total log lines (the web page fetches incrementally by sequence number)
    pub log_seq: u64,
    /// HCI commands from the host (opcode -> count); unimplemented ones still get Command Complete
    pub unknown_cmds: Vec<(u16, u32)>,
    /// Whether the firmware has brought up the controller (decides if the web shows the Bluetooth tab)
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

    /// Chip reset clears controller state and drops the link; the phone (outside world) survives and goes back to pre-scan
    pub fn chip_reset(&mut self, now: u64) {
        if self.link.take().is_some() {
            self.phone.on_disconnect(now, 0x08);
            self.air(now, "conn", "chip reset, connection timed out".into());
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

    /// Log lines with sequence >= from (sequence starts at 0)
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
        // Fixed-seed xorshift: LE Rand only has to look random, and replays must match
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
        // Keep sorted by time; equal times keep insertion order
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

    /// H4 packet from the host (firmware calls esp_vhci_host_send_packet)
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
            _ => self.air(
                now,
                "hci",
                format!("unknown H4 packet from host {:02x?}", pkt),
            ),
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
            // Read Local Version: HCI / LMP 5.0 (0x09), manufacturer 0x02E5 (Espressif)
            0x1001 => self.cmd_complete(at, op, &[0, 0x09, 0, 0, 0x09, 0xe5, 0x02, 0, 0]),
            // Read Local Supported Commands: all zero so the host takes the most conservative path
            0x1002 => {
                let mut r = vec![0u8; 65];
                r[0] = 0;
                self.cmd_complete(at, op, &r);
            }
            // Read Local Supported Features: LE only (bit 38), no BR/EDR (bit 37)
            0x1003 => self.cmd_complete(at, op, &[0, 0, 0, 0, 0, 0x60, 0, 0, 0]),
            0x1005 => self.cmd_complete(at, op, &[0, 0, 0, 0, 0, 0, 0, 0, 0]),
            0x1009 => {
                let mut r = vec![0];
                r.extend_from_slice(&self.addr);
                self.cmd_complete(at, op, &r);
            }
            // Vendor Read Static Address (NimBLE ble_hs_util_ensure_addr(1)): status + 6 bytes, top two bits set
            0xfc01 => {
                let mut r = vec![0];
                r.extend_from_slice(&self.static_addr());
                self.cmd_complete(at, op, &r);
            }
            0x2002 => {
                let l = ACL_LEN.to_le_bytes();
                self.cmd_complete(at, op, &[0, l[0], l[1], ACL_NUM]);
            }
            // LE features: only LL Privacy (bit 6); Bluedroid assumes a resolving list and divides by its size. NimBLE ignores this
            0x2003 => self.cmd_complete(at, op, &[0, 0x40, 0, 0, 0, 0, 0, 0, 0]),
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
                    // Single connection: no advertising while connected (a real controller returns 0x0C command disallowed)
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
                                "advertising started {} (interval {} ms)",
                                name,
                                self.adv.interval_us / 1000
                            )
                        } else {
                            "advertising stopped".into()
                        },
                    );
                }
                self.cmd_complete(at, op, &[0]);
            }
            0x200f => self.cmd_complete(at, op, &[0, 12]),
            // Read Local Name (Bluedroid): 248-byte zero-padded name
            0x0c14 => {
                let mut r = vec![0u8; 249];
                r[1..9].copy_from_slice(b"TryBoard");
                self.cmd_complete(at, op, &r);
            }
            // Host Number Of Completed Packets: no event unless it fails (Core 4.E 7.3.40); host credits are not modelled
            0x0c35 => {}
            // Status-only setup Bluedroid sends: C2H flow control, host buffer size, Espressif adv-report flow control
            // (resolving-list ops stay in the fallthrough below: NimBLE sends them too and its report must not change)
            0x0c31 | 0x0c33 | 0xfd09 | 0x202e => self.cmd_complete(at, op, &[0]),
            // Read Remote Version: peripheral-side NimBLE waits for it before reporting BLE_GAP_EVENT_CONNECT
            0x041d => {
                self.cmd_status(at, op, 0);
                let h = CONN_HANDLE.to_le_bytes();
                // Phone: LL 5.0, manufacturer 0xFFFF (reserved by the spec for testing)
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
                    self.air(
                        now,
                        "conn",
                        format!("firmware disconnected (reason 0x{reason:02x})"),
                    );
                    let h = CONN_HANDLE.to_le_bytes();
                    self.push_event(at + 10_000, 0x05, &[0, h[0], h[1], 0x16]);
                } else {
                    self.cmd_status(at, op, 0x02);
                }
            }
            _ => {
                // Everything else (incl. Espressif vendor commands 0xFCxx and the many 'set' commands) succeeds with no return data
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

    /// Time of the next due event (host packet, advertising, connection event, phone timer)
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

    /// Advance to now: run due advertising / connection events and phone timers; pop one due host packet
    pub fn poll(&mut self, now: u64) -> Option<Vec<u8>> {
        self.advance(now);
        if self.to_host.front().is_some_and(|x| x.0 <= now) {
            return self.to_host.pop_front().map(|x| x.1);
        }
        None
    }

    fn advance(&mut self, now: u64) {
        // Phone-side timers (scan timeout, auto flow)
        let acts = self.phone.tick(now);
        for a in acts {
            self.phone_action(a, now);
        }
        // Advertising is simulated event by event only while the phone scans or waits to connect; unheard adv can't affect firmware
        while self.adv.enabled && self.adv.next_us <= now {
            let t = self.adv.next_us;
            self.adv.next_us += self.adv.interval_us.max(20_000);
            if !self.phone.wants_adv() {
                // Jump close to now so re-enabling a scan long after doesn't replay a huge backlog
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
        // Connection events
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
                format!("{pdu} {} data {}", fmt_addr(&addr), hex(&data)),
            );
        }
        if scannable && self.phone.scanning() {
            if first {
                self.air(t, "adv", format!("SCAN_REQ → SCAN_RSP data {}", hex(&rsp)));
            }
            self.phone.on_scan_rsp(addr, &rsp);
        }
        if connectable && self.phone.connect_target() == Some(addr) {
            // CONNECT_IND: the phone connects, firmware side stops advertising and the link is up
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
                    "CONNECT_IND phone {} → {} (interval {} ms)",
                    fmt_addr(&paddr),
                    fmt_addr(&addr),
                    interval_us / 1000
                ),
            );
            self.phone.on_connected(t);
            let h = CONN_HANDLE.to_le_bytes();
            let itv = ((interval_us / 1250) as u16).to_le_bytes();
            // Role 1 = peripheral; peer address type 1 = random (phone); supervision timeout 5 s
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
        // Host -> phone
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
                self.air(t, line_kind(&s, "att"), s);
            }
            for r in replies {
                self.phone.queue_tx(r);
            }
        }
        // Phone -> host: queued PDUs go out at every connection event
        let (lines, out) = self.phone.conn_event(t);
        for s in lines {
            self.air(t, line_kind(&s, "att"), s);
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
            self.air(t, "conn", "phone disconnected".into());
            let h = CONN_HANDLE.to_le_bytes();
            self.push_event(t, 0x05, &[0, h[0], h[1], 0x13]);
        }
    }

    fn phone_action(&mut self, a: phone::Action, now: u64) {
        match a {
            phone::Action::Log(s) => self.air(now, "phone", s),
        }
    }

    /// Phone action from the web / input log (the part after `ble=`); returns an error text for the caller to show
    pub fn phone_cmd(&mut self, cmd: &str, now: u64) -> Result<(), String> {
        let lines = self.phone.command(cmd, now)?;
        for s in lines {
            self.air(now, line_kind(&s, "phone"), s);
        }
        // When the phone starts scanning, advertising resumes from now (skipped unheard events are not replayed)
        if self.adv.enabled && self.adv.next_us < now {
            self.adv.next_us = now;
        }
        Ok(())
    }

    /// Random static address derived from the public one (little-endian, MSB 0b11), stable across runs
    pub fn static_addr(&self) -> [u8; 6] {
        let mut a = self.addr;
        a[5] |= 0xc0;
        a
    }

    pub fn connected(&self) -> bool {
        self.link.is_some()
    }

    pub fn advertising(&self) -> bool {
        self.adv.enabled
    }

    /// For the web: JSON of the advertising / connection / phone view
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

    /// For the web: JSON array of air log lines with sequence >= from
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

/// Air-log kind: virtual desktop lines ("pc…", "fw → pc …") get their own kind
fn line_kind(s: &str, dflt: &'static str) -> &'static str {
    if s.starts_with("pc") || s.starts_with("fw → pc ") {
        "pc"
    } else {
        dflt
    }
}

/// Device name in advertising data (AD type 0x09 complete / 0x08 short)
pub fn adv_name(d: &[u8]) -> Option<String> {
    ad_fields(d)
        .find(|(t, _)| *t == 0x09 || *t == 0x08)
        .map(|(_, v)| String::from_utf8_lossy(v).into_owned())
}

/// 16-bit service UUIDs in advertising data (AD type 0x02 / 0x03)
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

/// Address in the usual notation (high byte first)
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
