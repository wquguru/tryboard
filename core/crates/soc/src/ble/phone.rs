//! Virtual phone: BLE central + L2CAP + ATT/GATT client, mimicking a minimal nRF Connect-style app:
//! scan, connect, MTU exchange, discovery, read / write / CCCD subscribe. One ATT request in flight (ATT requires it), at most one per connection event.

use super::{adv_name, adv_uuids, fmt_addr, hex, json_str};
use std::collections::VecDeque;

/// Connection interval the phone requests (30 ms, near the Android default)
pub const CONN_INTERVAL_US: u64 = 30_000;
/// Phone-side ATT MTU
pub const PHONE_MTU: u16 = 247;
/// Window for counting notifications after subscribing (acceptance: at least 2 within 3 s)
const SUB_WINDOW_US: u64 = 3_000_000;
const HIST_CAP: usize = 120;

pub enum Action {
    Log(String),
}

#[derive(Clone, Debug)]
pub struct Device {
    pub addr: [u8; 6],
    pub atype: u8,
    pub name: String,
    pub rssi: i8,
    pub uuids: Vec<u16>,
    pub connectable: bool,
    last_log_us: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Chr {
    pub uuid16: Option<u16>,
    pub uuid: String,
    pub props: u8,
    pub decl: u16,
    pub handle: u16,
    pub end: u16,
    pub cccd: Option<u16>,
    pub value: Vec<u8>,
    pub notify: bool,
    pub notes: u32,
    /// (simulated time us, value) for the web chart
    pub hist: VecDeque<(u64, f64)>,
    sub_at: Option<u64>,
    sub_reported: bool,
}

#[derive(Clone, Debug)]
pub struct Svc {
    pub uuid16: Option<u16>,
    pub uuid: String,
    pub start: u16,
    pub end: u16,
    pub chars: Vec<Chr>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum State {
    Idle,
    Scanning,
    Connecting,
    Connected,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Disc {
    Mtu,
    Svcs(u16),
    Chars(usize, u16),
    Descs(usize, usize, u16),
    Ready,
}

#[derive(Clone, Debug, PartialEq)]
enum Op {
    Read(u16),
    Write(u16, Vec<u8>),
    Sub(u16, bool),
}

#[derive(Clone, Debug, PartialEq)]
enum Pending {
    Disc(Disc),
    Op(Op),
}

pub struct Phone {
    pub addr: [u8; 6],
    pub rssi: i8,
    state: State,
    target: Option<[u8; 6]>,
    pub devices: Vec<Device>,
    pub services: Vec<Svc>,
    pub mtu: u16,
    disc: Disc,
    pending: Option<Pending>,
    ops: VecDeque<Op>,
    tx: VecDeque<(u16, Vec<u8>)>,
    want_disc: bool,
    auto: bool,
    auto_done: bool,
}

impl Default for Phone {
    fn default() -> Self {
        Self::new()
    }
}

impl Phone {
    pub fn new() -> Phone {
        Phone {
            // Random static address C0:FF:EE:12:34:56 (top two bits 11)
            addr: [0x56, 0x34, 0x12, 0xee, 0xff, 0xc0],
            rssi: -52,
            state: State::Idle,
            target: None,
            devices: Vec::new(),
            services: Vec::new(),
            mtu: 23,
            disc: Disc::Mtu,
            pending: None,
            ops: VecDeque::new(),
            tx: VecDeque::new(),
            want_disc: false,
            auto: false,
            auto_done: false,
        }
    }

    pub fn wants_adv(&self) -> bool {
        matches!(self.state, State::Scanning | State::Connecting)
    }

    pub fn scanning(&self) -> bool {
        self.state == State::Scanning
    }

    pub fn connect_target(&self) -> Option<[u8; 6]> {
        (self.state == State::Connecting)
            .then_some(self.target)
            .flatten()
    }

    pub fn wants_disconnect(&self) -> bool {
        self.want_disc
    }

    pub fn next_timer(&self) -> Option<u64> {
        None
    }

    pub fn tick(&mut self, _now: u64) -> Vec<Action> {
        Vec::new()
    }

    pub fn ready(&self) -> bool {
        self.state == State::Connected && self.disc == Disc::Ready
    }

    /// Received an advertising packet; returns whether to log it (at most one line per device per second)
    pub fn on_adv(
        &mut self,
        t: u64,
        addr: [u8; 6],
        atype: u8,
        connectable: bool,
        data: &[u8],
        _pdu: &str,
    ) -> bool {
        if !self.wants_adv() {
            return false;
        }
        let name = adv_name(data);
        let uuids = adv_uuids(data);
        let i = match self.devices.iter().position(|d| d.addr == addr) {
            Some(i) => i,
            None => {
                self.devices.push(Device {
                    addr,
                    atype,
                    name: String::new(),
                    rssi: self.rssi,
                    uuids: Vec::new(),
                    connectable,
                    last_log_us: 0,
                });
                self.devices.len() - 1
            }
        };
        let d = &mut self.devices[i];
        let new = d.last_log_us == 0;
        if let Some(n) = name {
            d.name = n;
        }
        for u in uuids {
            if !d.uuids.contains(&u) {
                d.uuids.push(u);
            }
        }
        d.connectable = connectable;
        let log = new || t >= d.last_log_us + 1_000_000;
        if log {
            d.last_log_us = t.max(1);
        }
        if self.auto && self.state == State::Scanning && connectable && self.target.is_none() {
            self.target = Some(addr);
            self.state = State::Connecting;
        }
        log
    }

    pub fn on_scan_rsp(&mut self, addr: [u8; 6], data: &[u8]) {
        if let Some(d) = self.devices.iter_mut().find(|d| d.addr == addr) {
            if let Some(n) = adv_name(data) {
                d.name = n;
            }
            for u in adv_uuids(data) {
                if !d.uuids.contains(&u) {
                    d.uuids.push(u);
                }
            }
        }
    }

    pub fn on_connected(&mut self, _t: u64) {
        self.state = State::Connected;
        self.services.clear();
        self.mtu = 23;
        self.disc = Disc::Mtu;
        self.pending = None;
        self.tx.clear();
        self.want_disc = false;
    }

    pub fn on_disconnect(&mut self, _t: u64, _reason: u8) {
        self.state = State::Idle;
        self.target = None;
        self.pending = None;
        self.ops.clear();
        self.tx.clear();
        self.want_disc = false;
        for s in &mut self.services {
            for c in &mut s.chars {
                c.notify = false;
            }
        }
    }

    pub fn queue_tx(&mut self, p: (u16, Vec<u8>)) {
        self.tx.push_back(p);
    }

    fn chr_mut(&mut self, h: u16) -> Option<&mut Chr> {
        self.services
            .iter_mut()
            .flat_map(|s| s.chars.iter_mut())
            .find(|c| c.handle == h || c.cccd == Some(h))
    }

    fn chr_name(&self, h: u16) -> String {
        self.services
            .iter()
            .flat_map(|s| s.chars.iter())
            .find(|c| c.handle == h || c.cccd == Some(h))
            .map_or(format!("0x{h:04x}"), |c| c.uuid.clone())
    }

    /// Resolve the target: 0x prefix is a handle, otherwise a 16-bit hex characteristic UUID
    fn resolve(&self, s: &str) -> Result<u16, String> {
        let s = s.trim();
        if let Some(h) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
            return u16::from_str_radix(h, 16).map_err(|_| format!("bad handle: {s}"));
        }
        let u = u16::from_str_radix(s, 16).map_err(|_| format!("bad UUID: {s}"))?;
        self.services
            .iter()
            .flat_map(|x| x.chars.iter())
            .find(|c| c.uuid16 == Some(u))
            .map(|c| c.handle)
            .ok_or(format!(
                "characteristic {s} not found (not connected or discovery not finished?)"
            ))
    }

    /// Phone action command (the part after `ble=` in the input log)
    pub fn command(&mut self, cmd: &str, _now: u64) -> Result<Vec<String>, String> {
        let mut it = cmd.split_whitespace();
        let verb = it.next().unwrap_or("");
        let arg = it.next();
        let mut out = Vec::new();
        match verb {
            "auto" => {
                self.auto = true;
                self.auto_done = false;
                if self.state == State::Idle {
                    self.start_scan();
                    out.push(
                        "phone: scanning (auto: connect to the first connectable device, read every readable characteristic, subscribe to every notification)"
                            .into(),
                    );
                }
            }
            "scan" => match arg {
                Some("off") | Some("0") => {
                    if self.state == State::Scanning {
                        self.state = State::Idle;
                        out.push("phone: stop scanning".into());
                    }
                }
                _ => {
                    if self.state == State::Connected {
                        return Err("already connected, disconnect before scanning".into());
                    }
                    self.start_scan();
                    out.push("phone: scanning".into());
                }
            },
            "connect" => {
                if self.state == State::Connected {
                    return Err("already connected".into());
                }
                let d = match arg {
                    None => self.devices.iter().find(|d| d.connectable),
                    Some(a) => self
                        .devices
                        .iter()
                        .find(|d| fmt_addr(&d.addr).eq_ignore_ascii_case(a) || d.name == a),
                }
                .ok_or("no connectable device found yet")?;
                let (addr, name) = (d.addr, d.name.clone());
                self.target = Some(addr);
                self.state = State::Connecting;
                out.push(format!("phone: connect {name} {}", fmt_addr(&addr)));
            }
            "disconnect" => {
                match self.state {
                    State::Connected => self.want_disc = true,
                    State::Connecting => {
                        self.state = State::Idle;
                        self.target = None;
                    }
                    _ => {}
                }
                self.auto = false;
                out.push("phone: disconnect".into());
            }
            "read" => {
                let h = self.resolve(arg.ok_or("read needs a characteristic")?)?;
                self.ops.push_back(Op::Read(h));
            }
            "write" => {
                let h = self.resolve(arg.ok_or("write needs a characteristic")?)?;
                let v: String = it.collect();
                let bytes = parse_hex(&v)?;
                self.ops.push_back(Op::Write(h, bytes));
            }
            "sub" | "unsub" => {
                let h = self.resolve(arg.ok_or("sub needs a characteristic")?)?;
                let on = verb == "sub" && it.next() != Some("0");
                self.ops.push_back(Op::Sub(h, on));
            }
            _ => return Err(format!("unknown phone command: {cmd}")),
        }
        Ok(out)
    }

    fn start_scan(&mut self) {
        self.state = State::Scanning;
        self.devices.clear();
        self.target = None;
    }

    /// One connection event: if nothing is pending, send the next request (discovery first, then user actions)
    pub fn conn_event(&mut self, t: u64) -> (Vec<String>, Vec<(u16, Vec<u8>)>) {
        let mut lines = Vec::new();
        // Notification count in the 3 s after subscribing
        for s in &mut self.services {
            for c in &mut s.chars {
                if let Some(at) = c.sub_at {
                    if !c.sub_reported && t >= at + SUB_WINDOW_US {
                        c.sub_reported = true;
                        let n = c
                            .hist
                            .iter()
                            .filter(|(x, _)| *x > at && *x <= at + SUB_WINDOW_US)
                            .count();
                        lines.push(format!(
                            "phone: {n} notifications within 3 s of subscribing to {}",
                            c.uuid
                        ));
                    }
                }
            }
        }
        if self.state == State::Connected && self.pending.is_none() && !self.want_disc {
            if self.disc != Disc::Ready {
                let d = self.disc;
                if let Some(req) = self.disc_request(d) {
                    self.pending = Some(Pending::Disc(d));
                    self.tx.push_back((4, req));
                }
            } else if let Some(op) = self.ops.pop_front() {
                let req = match &op {
                    Op::Read(h) => {
                        lines.push(format!("phone → read {}", self.chr_name(*h)));
                        let mut r = vec![0x0a];
                        r.extend_from_slice(&h.to_le_bytes());
                        Some(r)
                    }
                    Op::Write(h, v) => {
                        lines.push(format!("phone → write {} = {}", self.chr_name(*h), hex(v)));
                        let mut r = vec![0x12];
                        r.extend_from_slice(&h.to_le_bytes());
                        r.extend_from_slice(v);
                        Some(r)
                    }
                    Op::Sub(h, on) => {
                        let name = self.chr_name(*h);
                        let c = self.chr_mut(*h);
                        match c.and_then(|c| c.cccd.map(|d| (d, c.props))) {
                            Some((d, props)) => {
                                // Characteristics with indicate but no notify get 0x0002
                                let v: u16 = if !*on {
                                    0
                                } else if props & 0x10 != 0 {
                                    1
                                } else {
                                    2
                                };
                                lines.push(format!(
                                    "phone → {} {name} (write CCCD 0x{d:04x} = {v:04x})",
                                    if *on { "subscribe" } else { "unsubscribe" }
                                ));
                                let mut r = vec![0x12];
                                r.extend_from_slice(&d.to_le_bytes());
                                r.extend_from_slice(&v.to_le_bytes());
                                Some(r)
                            }
                            None => {
                                lines.push(format!("phone: {name} has no CCCD, cannot subscribe"));
                                None
                            }
                        }
                    }
                };
                if let Some(r) = req {
                    self.pending = Some(Pending::Op(op));
                    self.tx.push_back((4, r));
                }
            }
        }
        (lines, self.tx.drain(..).collect())
    }

    fn disc_request(&mut self, d: Disc) -> Option<Vec<u8>> {
        match d {
            Disc::Mtu => {
                let m = PHONE_MTU.to_le_bytes();
                Some(vec![0x02, m[0], m[1]])
            }
            Disc::Svcs(start) => {
                let s = start.to_le_bytes();
                Some(vec![0x10, s[0], s[1], 0xff, 0xff, 0x00, 0x28])
            }
            Disc::Chars(si, start) => {
                let s = start.to_le_bytes();
                let e = self.services[si].end.to_le_bytes();
                Some(vec![0x08, s[0], s[1], e[0], e[1], 0x03, 0x28])
            }
            Disc::Descs(si, ci, start) => {
                let c = &self.services[si].chars[ci];
                let (s, e) = (start.to_le_bytes(), c.end.to_le_bytes());
                Some(vec![0x04, s[0], s[1], e[0], e[1]])
            }
            Disc::Ready => None,
        }
    }

    /// Next discovery step after the given one completes
    fn next_disc(&mut self, from: Disc) -> Disc {
        match from {
            Disc::Mtu => Disc::Svcs(1),
            Disc::Svcs(_) => match self.services.first() {
                Some(s) => Disc::Chars(0, s.start),
                None => Disc::Ready,
            },
            Disc::Chars(si, _) => {
                // Characteristics of this service done: fill each end handle (before the next declaration / service end)
                let end = self.services[si].end;
                let n = self.services[si].chars.len();
                for i in 0..n {
                    let e = if i + 1 < n {
                        self.services[si].chars[i + 1].decl - 1
                    } else {
                        end
                    };
                    self.services[si].chars[i].end = e;
                }
                if si + 1 < self.services.len() {
                    Disc::Chars(si + 1, self.services[si + 1].start)
                } else {
                    self.next_desc(0, 0)
                }
            }
            Disc::Descs(si, ci, _) => self.next_desc(si, ci + 1),
            Disc::Ready => Disc::Ready,
        }
    }

    /// From (si, ci), find the next characteristic with handles after its value handle (may have descriptors)
    fn next_desc(&self, mut si: usize, mut ci: usize) -> Disc {
        loop {
            if si >= self.services.len() {
                return Disc::Ready;
            }
            if ci >= self.services[si].chars.len() {
                si += 1;
                ci = 0;
                continue;
            }
            let c = &self.services[si].chars[ci];
            if c.end > c.handle {
                return Disc::Descs(si, ci, c.handle + 1);
            }
            ci += 1;
        }
    }

    fn finish_disc(&mut self, from: Disc, lines: &mut Vec<String>) {
        let d = self.next_disc(from);
        self.disc = d;
        if d == Disc::Ready {
            let n: usize = self.services.iter().map(|s| s.chars.len()).sum();
            lines.push(format!(
                "phone: discovery done, {} services, {n} characteristics",
                self.services.len()
            ));
            for s in &self.services {
                lines.push(format!(
                    "phone:   service {}{}",
                    s.uuid,
                    uuid_name(s.uuid16).map_or(String::new(), |x| format!(" {x}"))
                ));
                for c in &s.chars {
                    lines.push(format!(
                        "phone:     characteristic {}{} handle 0x{:04x} [{}]",
                        c.uuid,
                        uuid_name(c.uuid16).map_or(String::new(), |x| format!(" {x}")),
                        c.handle,
                        props_text(c.props).join(" ")
                    ));
                }
            }
            if self.auto && !self.auto_done {
                self.auto_done = true;
                let all: Vec<(u16, u8, bool)> = self
                    .services
                    .iter()
                    .flat_map(|s| s.chars.iter())
                    .map(|c| (c.handle, c.props, c.cccd.is_some()))
                    .collect();
                for &(h, p, _) in &all {
                    if p & 0x02 != 0 {
                        self.ops.push_back(Op::Read(h));
                    }
                }
                for &(h, p, cccd) in &all {
                    if p & 0x30 != 0 && cccd {
                        self.ops.push_back(Op::Sub(h, true));
                    }
                }
            }
        }
    }

    /// L2CAP frame from the firmware; returns log lines and PDUs to reply
    pub fn on_l2cap(&mut self, t: u64, cid: u16, p: &[u8]) -> (Vec<String>, Vec<(u16, Vec<u8>)>) {
        let mut lines = Vec::new();
        let mut out = Vec::new();
        match cid {
            4 => self.on_att(t, p, &mut lines, &mut out),
            5 => {
                // LE signaling: accept every connection parameter update request, Command Reject for others
                if p.len() >= 4 {
                    let (code, id) = (p[0], p[1]);
                    if code == 0x12 {
                        lines.push(
                            "fw → requests connection parameter update, phone accepts".into(),
                        );
                        out.push((5, vec![0x13, id, 2, 0, 0, 0]));
                    } else if code & 1 == 0 || code == 0x01 {
                        // Responses (even codes) need no reply
                    } else {
                        out.push((5, vec![0x01, id, 2, 0, 0, 0]));
                    }
                }
            }
            6 => {
                // SMP: pairing is not supported
                lines.push("fw → requests pairing; the virtual phone does not pair, replies Pairing Failed".into());
                out.push((6, vec![0x05, 0x05]));
            }
            _ => {}
        }
        (lines, out)
    }

    fn on_att(&mut self, t: u64, p: &[u8], lines: &mut Vec<String>, out: &mut Vec<(u16, Vec<u8>)>) {
        let Some(&op) = p.first() else { return };
        let u16at = |i: usize| {
            p.get(i..i + 2)
                .map_or(0, |b| u16::from_le_bytes([b[0], b[1]]))
        };
        match op {
            // Requests from the firmware (server): answer MTU exchange with our value, nothing else is supported
            0x02 => {
                let m = PHONE_MTU.to_le_bytes();
                self.mtu = u16at(1).clamp(23, PHONE_MTU);
                out.push((4, vec![0x03, m[0], m[1]]));
            }
            0x1b | 0x1d => {
                let h = u16at(1);
                let v = p.get(3..).unwrap_or(&[]).to_vec();
                if op == 0x1d {
                    out.push((4, vec![0x1e]));
                }
                let name = self.chr_name(h);
                if let Some(c) = self.chr_mut(h) {
                    c.notes += 1;
                    let n = c.notes;
                    let num = value_num(c.uuid16, &v);
                    c.value = v.clone();
                    if c.hist.len() == HIST_CAP {
                        c.hist.pop_front();
                    }
                    c.hist.push_back((t, num));
                    lines.push(format!(
                        "fw → {} {name} #{n} = {}{}",
                        if op == 0x1b { "notify" } else { "indicate" },
                        hex(&v),
                        value_text(c.uuid16, &v).map_or(String::new(), |s| format!(" ({s})"))
                    ));
                } else {
                    lines.push(format!("fw → notify 0x{h:04x} = {}", hex(&v)));
                }
            }
            _ if op & 1 == 0 && op & 0x40 == 0 && op != 0x1e => {
                // Other requests: Request Not Supported
                out.push((4, vec![0x01, op, 0, 0, 0x06]));
            }
            _ => self.on_response(t, op, p, lines),
        }
    }

    fn on_response(&mut self, t: u64, op: u8, p: &[u8], lines: &mut Vec<String>) {
        let Some(pend) = self.pending.take() else {
            return;
        };
        let u16at = |i: usize| {
            p.get(i..i + 2)
                .map_or(0, |b| u16::from_le_bytes([b[0], b[1]]))
        };
        let err = (op == 0x01).then(|| p.get(4).copied().unwrap_or(0));
        match pend {
            Pending::Disc(d) => match (d, op) {
                (Disc::Mtu, _) => {
                    if op == 0x03 {
                        self.mtu = u16at(1).clamp(23, PHONE_MTU);
                    }
                    lines.push(format!("phone: MTU {}", self.mtu));
                    self.finish_disc(d, lines);
                }
                (Disc::Svcs(_), 0x11) => {
                    let len = p.get(1).copied().unwrap_or(6) as usize;
                    let mut last = 0u16;
                    for e in p.get(2..).unwrap_or(&[]).chunks_exact(len.max(6)) {
                        let (s, en) = (
                            u16::from_le_bytes([e[0], e[1]]),
                            u16::from_le_bytes([e[2], e[3]]),
                        );
                        let (u16v, us) = uuid_of(&e[4..]);
                        self.services.push(Svc {
                            uuid16: u16v,
                            uuid: us,
                            start: s,
                            end: en,
                            chars: Vec::new(),
                        });
                        last = en;
                    }
                    if last == 0xffff || last == 0 {
                        self.finish_disc(d, lines);
                    } else {
                        self.disc = Disc::Svcs(last + 1);
                    }
                }
                (Disc::Chars(si, _), 0x09) => {
                    let len = p.get(1).copied().unwrap_or(7) as usize;
                    let mut last = 0u16;
                    for e in p.get(2..).unwrap_or(&[]).chunks_exact(len.max(7)) {
                        let decl = u16::from_le_bytes([e[0], e[1]]);
                        let props = e[2];
                        let h = u16::from_le_bytes([e[3], e[4]]);
                        let (u16v, us) = uuid_of(&e[5..]);
                        self.services[si].chars.push(Chr {
                            uuid16: u16v,
                            uuid: us,
                            props,
                            decl,
                            handle: h,
                            ..Default::default()
                        });
                        last = h;
                    }
                    if last == 0 || last >= self.services[si].end {
                        self.finish_disc(d, lines);
                    } else {
                        self.disc = Disc::Chars(si, last + 1);
                    }
                }
                (Disc::Descs(si, ci, _), 0x05) => {
                    let fmt = p.get(1).copied().unwrap_or(1);
                    let step = if fmt == 1 { 4 } else { 18 };
                    let mut last = 0u16;
                    for e in p.get(2..).unwrap_or(&[]).chunks_exact(step) {
                        let h = u16::from_le_bytes([e[0], e[1]]);
                        if fmt == 1 && u16::from_le_bytes([e[2], e[3]]) == 0x2902 {
                            self.services[si].chars[ci].cccd = Some(h);
                        }
                        last = h;
                    }
                    if last == 0 || last >= self.services[si].chars[ci].end {
                        self.finish_disc(d, lines);
                    } else {
                        self.disc = Disc::Descs(si, ci, last + 1);
                    }
                }
                // Error reply (Attribute Not Found) means this range is exhausted
                (_, 0x01) => self.finish_disc(d, lines),
                _ => self.finish_disc(d, lines),
            },
            Pending::Op(o) => match o {
                Op::Read(h) => {
                    let name = self.chr_name(h);
                    if let Some(e) = err {
                        lines.push(format!("fw → read {name} failed (ATT error 0x{e:02x})"));
                    } else if let Some(c) = self.chr_mut(h) {
                        let v = p[1..].to_vec();
                        let txt = value_text(c.uuid16, &v);
                        c.value = v.clone();
                        lines.push(format!(
                            "fw → read {name} = {}{}",
                            hex(&v),
                            txt.map_or(String::new(), |s| format!(" ({s})"))
                        ));
                    }
                }
                Op::Write(h, v) => {
                    let name = self.chr_name(h);
                    match err {
                        Some(e) => {
                            lines.push(format!("fw → write {name} failed (ATT error 0x{e:02x})"))
                        }
                        None => {
                            lines.push(format!("fw → write {name} ok"));
                            if let Some(c) = self.chr_mut(h) {
                                c.value = v;
                            }
                        }
                    }
                }
                Op::Sub(h, on) => {
                    let name = self.chr_name(h);
                    match err {
                        Some(e) => lines.push(format!(
                            "fw → subscribe {name} failed (ATT error 0x{e:02x})"
                        )),
                        None => {
                            lines.push(format!(
                                "fw → {} {name} ok",
                                if on { "subscribe" } else { "unsubscribe" }
                            ));
                            if let Some(c) = self.chr_mut(h) {
                                c.notify = on;
                                if on && c.sub_at.is_none() {
                                    c.sub_at = Some(t);
                                }
                            }
                        }
                    }
                }
            },
        }
    }

    pub fn json(&self) -> String {
        let st = match self.state {
            State::Idle => "idle",
            State::Scanning => "scanning",
            State::Connecting => "connecting",
            State::Connected => "connected",
        };
        let mut s = format!(
            "{{\"state\":\"{st}\",\"ready\":{},\"busy\":{},\"mtu\":{},\"rssi\":{},\"auto\":{},\"target\":{},\"devices\":[",
            self.ready(),
            self.pending.is_some() || !self.ops.is_empty(),
            self.mtu,
            self.rssi,
            self.auto,
            self.target.map_or("null".into(), |a| format!("\"{}\"", fmt_addr(&a)))
        );
        for (i, d) in self.devices.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!(
                "{{\"addr\":\"{}\",\"name\":{},\"rssi\":{},\"connectable\":{},\"uuids\":[{}]}}",
                fmt_addr(&d.addr),
                json_str(&d.name),
                d.rssi,
                d.connectable,
                d.uuids
                    .iter()
                    .map(|u| format!("\"{u:04X}\""))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        s.push_str("],\"services\":[");
        for (i, sv) in self.services.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!(
                "{{\"uuid\":\"{}\",\"name\":{},\"start\":{},\"end\":{},\"chars\":[",
                sv.uuid,
                json_str(uuid_name(sv.uuid16).unwrap_or("")),
                sv.start,
                sv.end
            ));
            for (j, c) in sv.chars.iter().enumerate() {
                if j > 0 {
                    s.push(',');
                }
                let hist = c
                    .hist
                    .iter()
                    .map(|(t, v)| format!("[{},{}]", t / 1000, v))
                    .collect::<Vec<_>>()
                    .join(",");
                s.push_str(&format!(
                    "{{\"uuid\":\"{}\",\"name\":{},\"handle\":{},\"props\":[{}],\"cccd\":{},\"value\":\"{}\",\"text\":{},\"notify\":{},\"notes\":{},\"hist\":[{hist}]}}",
                    c.uuid,
                    json_str(uuid_name(c.uuid16).unwrap_or("")),
                    c.handle,
                    props_text(c.props).iter().map(|p| format!("\"{p}\"")).collect::<Vec<_>>().join(","),
                    c.cccd.map_or("null".into(), |h| h.to_string()),
                    hex(&c.value),
                    json_str(&value_text(c.uuid16, &c.value).unwrap_or_default()),
                    c.notify,
                    c.notes
                ));
            }
            s.push_str("]}");
        }
        s.push_str("]}");
        s
    }
}

fn uuid_of(b: &[u8]) -> (Option<u16>, String) {
    if b.len() == 2 {
        let u = u16::from_le_bytes([b[0], b[1]]);
        (Some(u), format!("{u:04X}"))
    } else {
        let mut r: Vec<u8> = b.to_vec();
        r.reverse();
        let h: String = r.iter().map(|x| format!("{x:02x}")).collect();
        if h.len() == 32 {
            (
                None,
                format!(
                    "{}-{}-{}-{}-{}",
                    &h[0..8],
                    &h[8..12],
                    &h[12..16],
                    &h[16..20],
                    &h[20..]
                ),
            )
        } else {
            (None, h)
        }
    }
}

fn props_text(p: u8) -> Vec<&'static str> {
    let mut v = Vec::new();
    if p & 0x02 != 0 {
        v.push("read");
    }
    if p & 0x04 != 0 {
        v.push("write-nr");
    }
    if p & 0x08 != 0 {
        v.push("write");
    }
    if p & 0x10 != 0 {
        v.push("notify");
    }
    if p & 0x20 != 0 {
        v.push("indicate");
    }
    v
}

/// Readable names for common SIG-assigned UUIDs
pub fn uuid_name(u: Option<u16>) -> Option<&'static str> {
    Some(match u? {
        0x1800 => "Generic Access",
        0x1801 => "Generic Attribute",
        0x180A => "Device Information",
        0x180D => "Heart Rate",
        0x180F => "Battery",
        0x181A => "Environmental Sensing",
        0x2A00 => "Device Name",
        0x2A01 => "Appearance",
        0x2A05 => "Service Changed",
        0x2A19 => "Battery Level",
        0x2A29 => "Manufacturer Name",
        0x2A37 => "Heart Rate Measurement",
        0x2A38 => "Body Sensor Location",
        0x2A6E => "Temperature",
        0x2A6F => "Humidity",
        0x2B29 => "Client Supported Features",
        0x2B2A => "Database Hash",
        _ => return None,
    })
}

/// Chart value: Heart Rate Measurement parsed per spec, others as little-endian unsigned (up to 4 bytes)
fn value_num(u: Option<u16>, v: &[u8]) -> f64 {
    match (u, v) {
        (Some(0x2A37), [f, a, b, ..]) if f & 1 == 1 => u16::from_le_bytes([*a, *b]) as f64,
        (Some(0x2A37), [_, a, ..]) => *a as f64,
        _ => v
            .iter()
            .take(4)
            .rev()
            .fold(0u64, |acc, x| acc << 8 | *x as u64) as f64,
    }
}

fn value_text(u: Option<u16>, v: &[u8]) -> Option<String> {
    match (u?, v) {
        (0x2A37, _) if v.len() >= 2 => Some(format!("{} bpm", value_num(u, v))),
        (0x2A19, [p]) => Some(format!("{p}%")),
        (0x2A38, [l]) => Some(
            [
                "Other", "Chest", "Wrist", "Finger", "Hand", "Ear lobe", "Foot",
            ]
            .get(*l as usize)
            .unwrap_or(&"?")
            .to_string(),
        ),
        (0x2A00, _) => Some(String::from_utf8_lossy(v).into_owned()),
        _ => None,
    }
}

fn parse_hex(s: &str) -> Result<Vec<u8>, String> {
    let s: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .collect();
    let s = s.trim_start_matches("0x");
    if s.is_empty() || !s.len().is_multiple_of(2) {
        return Err(format!("value must be an even number of hex digits: {s}"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| format!("bad hex: {s}")))
        .collect()
}
