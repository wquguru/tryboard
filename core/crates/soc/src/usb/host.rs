//! Virtual USB host (the "PC / phone on the other end"): detect attach -> bus reset -> enumerate -> set config -> poll per class.
//! Classes: HID (keyboard, mouse; report IDs from the report descriptor), CDC-ACM (virtual serial, both directions).
//! Ticks every 0.25ms with at most one transaction per endpoint per tick (NAK retries next tick), like a real host's
//! retry cadence. lint: allow-long-comment

use super::dwc2::{Dwc2, Handshake, Mem};

#[derive(Debug, Clone, Default)]
pub struct DeviceInfo {
    pub vid: u16,
    pub pid: u16,
    pub usb_version: u16,
    pub class: u8,
    pub manufacturer: String,
    pub product: String,
    pub serial: String,
    /// One line per interface, e.g. HID keyboard + mouse, CDC-ACM virtual serial
    pub interfaces: Vec<String>,
    pub ep0_mps: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HidKind {
    Keyboard,
    Mouse,
    Other,
}

#[derive(Debug, Clone)]
struct HidItf {
    itf: u8,
    ep_in: u8,
    interval: u8,
    report_len: u16,
    protocol: u8,
    /// Report ID -> kind; empty means no report IDs
    ids: Vec<(u8, HidKind)>,
    next_poll: u64,
}

#[derive(Debug, Clone)]
struct CdcItf {
    comm_itf: u8,
    ep_in: u8,
    ep_out: u8,
    mps_out: usize,
}

/// Control transfer
#[derive(Debug, Clone)]
struct Ctrl {
    setup: [u8; 8],
    out: Vec<u8>,
    got: Vec<u8>,
    stage: Stage,
    what: Req,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Setup,
    DataIn,
    DataOut(usize),
    StatusIn,
    StatusOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Req {
    DevDesc8,
    SetAddress,
    DevDesc,
    ConfigHead,
    ConfigFull,
    LangIds,
    Str(u8),
    SetConfig,
    HidIdle(usize),
    HidReport(usize),
    CdcLine(usize),
    CdcCtrl(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Detached,
    /// Pull-up detected, waiting out debounce
    Attached(u64),
    /// In reset (SE0); sends ENUMDNE when time is up
    Reset(u64),
    /// Recovery period after reset
    Recovery(u64),
    Enumerating,
    Configured,
    Failed,
}

pub struct Host {
    state: State,
    ctrl: Option<Ctrl>,
    queue: Vec<Req>,
    pub info: DeviceInfo,
    config: Vec<u8>,
    hid: Vec<HidItf>,
    cdc: Vec<CdcItf>,
    /// Enumeration log (shown by CLI / web page)
    pub log: Vec<String>,
    /// Text typed by the keyboard
    pub typed: String,
    last_keys: Vec<u8>,
    /// Mouse: accumulated position, buttons, report count
    pub mouse: (i32, i32, u8, u64),
    pub cdc_rx: Vec<u8>,
    pub cdc_tx: Vec<u8>,
    /// Current time (microseconds)
    now_us: u64,
    last_frame_us: u64,
    /// HID reports received (debug)
    pub hid_reports: u64,
    /// Failure retry count
    naks: u32,
    /// Manufacturer / product / serial string indices
    str_idx: [u8; 3],
}

impl Default for Host {
    fn default() -> Self {
        Host {
            state: State::Detached,
            ctrl: None,
            queue: Vec::new(),
            info: DeviceInfo::default(),
            config: Vec::new(),
            hid: Vec::new(),
            cdc: Vec::new(),
            log: Vec::new(),
            typed: String::new(),
            last_keys: Vec::new(),
            mouse: (0, 0, 0, 0),
            cdc_rx: Vec::new(),
            cdc_tx: Vec::new(),
            now_us: 0,
            last_frame_us: 0,
            hid_reports: 0,
            naks: 0,
            str_idx: [0; 3],
        }
    }
}

fn setup_pkt(bm: u8, req: u8, value: u16, index: u16, len: u16) -> [u8; 8] {
    let [vl, vh] = value.to_le_bytes();
    let [il, ih] = index.to_le_bytes();
    let [ll, lh] = len.to_le_bytes();
    [bm, req, vl, vh, il, ih, ll, lh]
}

fn utf16(d: &[u8]) -> String {
    if d.len() < 2 {
        return String::new();
    }
    let n = (d[0] as usize).min(d.len());
    let w: Vec<u16> = d[2..n]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    String::from_utf16_lossy(&w)
}

/// HID keycode -> character (US layout); `shift` is whether Shift is held
fn keycode_char(k: u8, shift: bool) -> Option<char> {
    let c = match k {
        0x04..=0x1d => {
            let c = (b'a' + k - 0x04) as char;
            return Some(if shift { c.to_ascii_uppercase() } else { c });
        }
        0x1e..=0x27 => {
            let (n, s) = (b"1234567890", b"!@#$%^&*()");
            let i = (k - 0x1e) as usize;
            return Some(if shift { s[i] } else { n[i] } as char);
        }
        0x28 => '\n',
        0x2b => '\t',
        0x2c => ' ',
        0x2d => {
            if shift {
                '_'
            } else {
                '-'
            }
        }
        0x2e => {
            if shift {
                '+'
            } else {
                '='
            }
        }
        0x2f => {
            if shift {
                '{'
            } else {
                '['
            }
        }
        0x30 => {
            if shift {
                '}'
            } else {
                ']'
            }
        }
        0x31 => {
            if shift {
                '|'
            } else {
                '\\'
            }
        }
        0x33 => {
            if shift {
                ':'
            } else {
                ';'
            }
        }
        0x34 => {
            if shift {
                '"'
            } else {
                '\''
            }
        }
        0x35 => {
            if shift {
                '~'
            } else {
                '`'
            }
        }
        0x36 => {
            if shift {
                '<'
            } else {
                ','
            }
        }
        0x37 => {
            if shift {
                '>'
            } else {
                '.'
            }
        }
        0x38 => {
            if shift {
                '?'
            } else {
                '/'
            }
        }
        _ => return None,
    };
    Some(c)
}

/// Rough parse of the HID report descriptor: report ID of each application collection (keyboard / mouse)
fn parse_report_desc(d: &[u8]) -> Vec<(u8, HidKind)> {
    let mut out = Vec::new();
    let (mut page, mut usage, mut depth) = (0u32, 0u32, 0i32);
    let mut app = HidKind::Other;
    let mut i = 0;
    while i < d.len() {
        let b = d[i];
        if b == 0xfe {
            // Long item
            let len = *d.get(i + 1).unwrap_or(&0) as usize;
            i += 3 + len;
            continue;
        }
        let size = [0, 1, 2, 4][(b & 3) as usize];
        let mut v = 0u32;
        for k in 0..size {
            v |= (*d.get(i + 1 + k).unwrap_or(&0) as u32) << (8 * k);
        }
        match b & 0xfc {
            0x04 => page = v,  // Usage Page
            0x08 => usage = v, // Usage
            0xa0 => {
                // Collection
                if depth == 0 {
                    app = match (page, usage) {
                        (1, 6) => HidKind::Keyboard,
                        (1, 2) => HidKind::Mouse,
                        _ => HidKind::Other,
                    };
                }
                depth += 1;
            }
            0xc0 => depth -= 1,               // End Collection
            0x84 => out.push((v as u8, app)), // Report ID
            _ => {}
        }
        i += 1 + size;
    }
    if out.is_empty() && app != HidKind::Other {
        out.push((0, app));
    }
    out
}

impl Host {
    fn say(&mut self, s: String) {
        self.log.push(s);
    }

    pub fn state_name(&self) -> &'static str {
        match self.state {
            State::Detached => "detached",
            State::Attached(_) | State::Reset(_) | State::Recovery(_) => "resetting",
            State::Enumerating => "enumerating",
            State::Configured => "configured",
            State::Failed => "failed",
        }
    }

    pub fn configured(&self) -> bool {
        self.state == State::Configured
    }

    /// Advance to now_us; returns the next time (microseconds) we need to be called
    pub fn tick(&mut self, dev: &mut Dwc2, mem: &mut dyn Mem, now_us: u64) -> u64 {
        self.now_us = now_us;
        // Disconnected: back to detached
        if !dev.connected() {
            if self.state != State::Detached {
                self.say("device detached".into());
                *self = Host {
                    log: std::mem::take(&mut self.log),
                    ..Default::default()
                };
            }
            return now_us + 1000;
        }
        if dev.enumerated && now_us >= self.last_frame_us + 1000 {
            self.last_frame_us = now_us;
            dev.sof();
        }
        match self.state {
            State::Detached => {
                self.say("D+ pull-up detected: full-speed device attached".into());
                self.state = State::Attached(now_us + 10_000);
            }
            State::Attached(t) if now_us >= t => {
                self.say("bus reset".into());
                dev.bus_reset();
                self.state = State::Reset(now_us + 10_000);
            }
            State::Reset(t) if now_us >= t => {
                dev.enum_done();
                self.last_frame_us = now_us;
                self.state = State::Recovery(now_us + 10_000);
            }
            State::Recovery(t) if now_us >= t => {
                self.state = State::Enumerating;
                self.queue = vec![Req::DevDesc8];
            }
            State::Enumerating => self.step_ctrl(dev, mem),
            State::Configured => {
                if self.ctrl.is_some() || !self.queue.is_empty() {
                    self.step_ctrl(dev, mem);
                }
                self.poll_classes(dev, mem);
            }
            _ => {}
        }
        now_us + 250
    }

    fn start(&mut self, what: Req) {
        let (setup, out) = match what {
            Req::DevDesc8 => (setup_pkt(0x80, 6, 0x0100, 0, 64), vec![]),
            Req::SetAddress => (setup_pkt(0x00, 5, 1, 0, 0), vec![]),
            Req::DevDesc => (setup_pkt(0x80, 6, 0x0100, 0, 18), vec![]),
            Req::ConfigHead => (setup_pkt(0x80, 6, 0x0200, 0, 9), vec![]),
            Req::ConfigFull => {
                let total = u16::from_le_bytes([self.config[2], self.config[3]]);
                (setup_pkt(0x80, 6, 0x0200, 0, total), vec![])
            }
            Req::LangIds => (setup_pkt(0x80, 6, 0x0300, 0, 255), vec![]),
            Req::Str(i) => (setup_pkt(0x80, 6, 0x0300 | i as u16, 0x0409, 255), vec![]),
            Req::SetConfig => (setup_pkt(0x00, 9, 1, 0, 0), vec![]),
            Req::HidIdle(k) => (setup_pkt(0x21, 0x0a, 0, self.hid[k].itf as u16, 0), vec![]),
            Req::HidReport(k) => (
                setup_pkt(
                    0x81,
                    6,
                    0x2200,
                    self.hid[k].itf as u16,
                    self.hid[k].report_len,
                ),
                vec![],
            ),
            // 115200 8N1
            Req::CdcLine(k) => (
                setup_pkt(0x21, 0x20, 0, self.cdc[k].comm_itf as u16, 7),
                vec![0x00, 0xc2, 0x01, 0x00, 0, 0, 8],
            ),
            // DTR | RTS: a terminal program opened the port
            Req::CdcCtrl(k) => (
                setup_pkt(0x21, 0x22, 3, self.cdc[k].comm_itf as u16, 0),
                vec![],
            ),
        };
        self.ctrl = Some(Ctrl {
            setup,
            out,
            got: Vec::new(),
            stage: Stage::Setup,
            what,
        });
        self.naks = 0;
    }

    fn step_ctrl(&mut self, dev: &mut Dwc2, mem: &mut dyn Mem) {
        if self.ctrl.is_none() {
            if self.queue.is_empty() {
                return;
            }
            let w = self.queue.remove(0);
            self.start(w);
        }
        // Push as far as possible within one tick, until a NAK
        for _ in 0..8 {
            let Some(c) = self.ctrl.as_mut() else { return };
            let len = u16::from_le_bytes([c.setup[6], c.setup[7]]) as usize;
            let is_in = c.setup[0] & 0x80 != 0;
            match c.stage {
                Stage::Setup => {
                    dev.setup(c.setup, mem);
                    c.stage = if len == 0 {
                        Stage::StatusIn
                    } else if is_in {
                        Stage::DataIn
                    } else {
                        Stage::DataOut(0)
                    };
                    // The device must handle the SETUP interrupt first; this tick ends here
                    return;
                }
                Stage::DataIn => match dev.token_in(0, mem) {
                    Handshake::Ack(d) => {
                        let short = d.len() < 64;
                        c.got.extend_from_slice(&d);
                        if short || c.got.len() >= len {
                            c.got.truncate(len);
                            c.stage = Stage::StatusOut;
                        }
                    }
                    Handshake::Nak => return self.nak(),
                    Handshake::Stall => return self.stalled(),
                },
                Stage::DataOut(off) => {
                    let end = (off + 64).min(c.out.len());
                    let chunk = c.out[off..end].to_vec();
                    match dev.token_out(0, &chunk, mem) {
                        Handshake::Ack(_) => {
                            c.stage = if end >= c.out.len() {
                                Stage::StatusIn
                            } else {
                                Stage::DataOut(end)
                            }
                        }
                        Handshake::Nak => return self.nak(),
                        Handshake::Stall => return self.stalled(),
                    }
                }
                Stage::StatusIn => match dev.token_in(0, mem) {
                    Handshake::Ack(_) => return self.done(),
                    Handshake::Nak => return self.nak(),
                    Handshake::Stall => return self.stalled(),
                },
                Stage::StatusOut => match dev.token_out(0, &[], mem) {
                    Handshake::Ack(_) => return self.done(),
                    Handshake::Nak => return self.nak(),
                    Handshake::Stall => return self.stalled(),
                },
            }
        }
    }

    fn nak(&mut self) {
        self.naks += 1;
        // No progress for 2 s (8000 ticks): give up on this request
        if self.naks > 8000 {
            let w = self.ctrl.take().map(|c| c.what);
            self.say(format!("control transfer timed out: {w:?}"));
            if self.state == State::Enumerating {
                self.state = State::Failed;
            }
        }
    }

    fn stalled(&mut self) {
        // Infallible: only reached from step_ctrl while self.ctrl is Some.
        let c = self.ctrl.take().unwrap();
        self.say(format!("device STALL: {:?} (ignored, continuing)", c.what));
        if c.what == Req::DevDesc8 || c.what == Req::ConfigHead {
            self.state = State::Failed;
        }
    }

    fn done(&mut self) {
        // Infallible: only reached from step_ctrl while self.ctrl is Some.
        let c = self.ctrl.take().unwrap();
        let d = c.got;
        match c.what {
            Req::DevDesc8 => {
                self.info.ep0_mps = *d.get(7).unwrap_or(&64);
                self.say(format!(
                    "GET_DESCRIPTOR(device) first {} bytes: EP0 max packet size {}",
                    d.len(),
                    self.info.ep0_mps
                ));
                self.queue.push(Req::SetAddress);
            }
            Req::SetAddress => {
                self.say("SET_ADDRESS(1)".into());
                self.queue.push(Req::DevDesc);
            }
            Req::DevDesc => {
                if d.len() >= 18 {
                    self.info.usb_version = u16::from_le_bytes([d[2], d[3]]);
                    self.info.class = d[4];
                    self.info.vid = u16::from_le_bytes([d[8], d[9]]);
                    self.info.pid = u16::from_le_bytes([d[10], d[11]]);
                    self.say(format!(
                        "device descriptor: USB {:x}.{:02x}, VID 0x{:04X} PID 0x{:04X}, class 0x{:02X}",
                        self.info.usb_version >> 8,
                        self.info.usb_version & 0xff,
                        self.info.vid,
                        self.info.pid,
                        self.info.class
                    ));
                    self.queue.push(Req::ConfigHead);
                    // Remember string indices; fetch them after the config descriptor
                    for (k, &i) in [d[14], d[15], d[16]].iter().enumerate() {
                        if i != 0 {
                            self.str_idx[k] = i;
                        }
                    }
                } else {
                    self.state = State::Failed;
                }
            }
            Req::ConfigHead => {
                self.config = d;
                self.queue.push(Req::ConfigFull);
            }
            Req::ConfigFull => {
                self.config = d;
                self.parse_config();
                self.queue.push(Req::LangIds);
            }
            Req::LangIds => {
                for i in self.str_idx {
                    if i != 0 {
                        self.queue.push(Req::Str(i));
                    }
                }
                self.queue.push(Req::SetConfig);
            }
            Req::Str(i) => {
                let s = utf16(&d);
                if i == self.str_idx[0] {
                    self.info.manufacturer = s.clone();
                }
                if i == self.str_idx[1] {
                    self.info.product = s.clone();
                }
                if i == self.str_idx[2] {
                    self.info.serial = s.clone();
                }
                self.say(format!("string {i}: \"{s}\""));
            }
            Req::SetConfig => {
                self.say("SET_CONFIGURATION(1): device configured".into());
                for k in 0..self.hid.len() {
                    self.queue.push(Req::HidIdle(k));
                    self.queue.push(Req::HidReport(k));
                }
                for k in 0..self.cdc.len() {
                    self.queue.push(Req::CdcLine(k));
                    self.queue.push(Req::CdcCtrl(k));
                }
                self.state = State::Configured;
            }
            Req::HidIdle(_) => {}
            Req::HidReport(k) => {
                let ids = parse_report_desc(&d);
                let desc: Vec<String> = ids
                    .iter()
                    .map(|(id, kind)| {
                        let n = match kind {
                            HidKind::Keyboard => "keyboard",
                            HidKind::Mouse => "mouse",
                            HidKind::Other => "other",
                        };
                        if *id == 0 {
                            n.to_string()
                        } else {
                            format!("report {id}={n}")
                        }
                    })
                    .collect();
                self.say(format!(
                    "HID report descriptor {} bytes: {}",
                    d.len(),
                    desc.join(", ")
                ));
                let h = &mut self.hid[k];
                h.ids = ids;
                if h.ids.is_empty() {
                    h.ids.push((
                        0,
                        if h.protocol == 1 {
                            HidKind::Keyboard
                        } else if h.protocol == 2 {
                            HidKind::Mouse
                        } else {
                            HidKind::Other
                        },
                    ));
                }
            }
            Req::CdcLine(_) => self.say("CDC SET_LINE_CODING 115200 8N1".into()),
            Req::CdcCtrl(_) => {
                self.say("CDC SET_CONTROL_LINE_STATE DTR=1 RTS=1 (terminal opened)".into())
            }
        }
    }

    fn parse_config(&mut self) {
        let d = self.config.clone();
        let mut i = 0;
        let mut itf_class = 0u8;
        let mut pending_hid: Option<HidItf> = None;
        let mut cdc_comm: Option<u8> = None;
        let mut cdc_eps: (u8, u8, usize) = (0, 0, 64);
        while i + 1 < d.len() {
            let (len, ty) = (d[i] as usize, d[i + 1]);
            if len < 2 {
                break;
            }
            let x = &d[i..(i + len).min(d.len())];
            match ty {
                4 if x.len() >= 9 => {
                    if let Some(h) = pending_hid.take() {
                        self.hid.push(h);
                    }
                    let (itf_num, itf_sub, itf_proto) = (x[2], x[6], x[7]);
                    itf_class = x[5];
                    let name = match (itf_class, itf_sub, itf_proto) {
                        (3, _, 1) => "HID keyboard (boot protocol)".to_string(),
                        (3, _, 2) => "HID mouse (boot protocol)".to_string(),
                        (3, _, _) => "HID".to_string(),
                        (2, 2, _) => {
                            cdc_comm = Some(itf_num);
                            "CDC-ACM control interface".to_string()
                        }
                        (2, 0x0d, _) => "CDC-NCM network control interface".to_string(),
                        (0x0a, _, _) => "CDC data interface".to_string(),
                        (8, _, _) => "mass storage (USB drive)".to_string(),
                        (1, _, _) => "audio".to_string(),
                        (c, s, p) => format!("class 0x{c:02X}/0x{s:02X}/0x{p:02X}"),
                    };
                    self.info
                        .interfaces
                        .push(format!("interface {itf_num}: {name}"));
                    if itf_class == 3 {
                        pending_hid = Some(HidItf {
                            itf: itf_num,
                            ep_in: 0,
                            interval: 10,
                            report_len: 0,
                            protocol: itf_proto,
                            ids: Vec::new(),
                            next_poll: 0,
                        });
                    }
                }
                0x21 if itf_class == 3 && x.len() >= 9 => {
                    if let Some(h) = pending_hid.as_mut() {
                        h.report_len = u16::from_le_bytes([x[7], x[8]]);
                    }
                }
                5 if x.len() >= 7 => {
                    let (addr, attr) = (x[2], x[3] & 3);
                    let mps = u16::from_le_bytes([x[4], x[5]]) as usize;
                    if itf_class == 3 && addr & 0x80 != 0 {
                        if let Some(h) = pending_hid.as_mut() {
                            h.ep_in = addr & 0x7f;
                            h.interval = x[6].max(1);
                        }
                    }
                    if itf_class == 0x0a && attr == 2 {
                        if addr & 0x80 != 0 {
                            cdc_eps.0 = addr & 0x7f;
                        } else {
                            cdc_eps.1 = addr;
                            cdc_eps.2 = mps;
                        }
                    }
                }
                _ => {}
            }
            i += len;
        }
        if let Some(h) = pending_hid.take() {
            self.hid.push(h);
        }
        if let Some(comm) = cdc_comm {
            if cdc_eps.0 != 0 && cdc_eps.1 != 0 {
                self.cdc.push(CdcItf {
                    comm_itf: comm,
                    ep_in: cdc_eps.0,
                    ep_out: cdc_eps.1,
                    mps_out: cdc_eps.2.max(8),
                });
            }
        }
        let total = d.len();
        self.say(format!(
            "config descriptor {total} bytes, {} interfaces",
            self.info.interfaces.len()
        ));
        for s in self.info.interfaces.clone() {
            self.say(format!("  {s}"));
        }
    }

    fn poll_classes(&mut self, dev: &mut Dwc2, mem: &mut dyn Mem) {
        let now_ms = self.now_us / 1000;
        for k in 0..self.hid.len() {
            if self.hid[k].ids.is_empty() || now_ms < self.hid[k].next_poll {
                continue;
            }
            let ep = self.hid[k].ep_in as usize;
            if let Handshake::Ack(d) = dev.token_in(ep, mem) {
                self.on_hid_report(k, &d);
                // Keep fetching quickly while data flows (after a report, the next one waits one interval)
            }
            self.hid[k].next_poll = now_ms + self.hid[k].interval as u64;
        }
        for k in 0..self.cdc.len() {
            let c = self.cdc[k].clone();
            if let Handshake::Ack(d) = dev.token_in(c.ep_in as usize, mem) {
                self.cdc_rx.extend_from_slice(&d);
            }
            if !self.cdc_tx.is_empty() {
                let n = self.cdc_tx.len().min(c.mps_out);
                let chunk: Vec<u8> = self.cdc_tx[..n].to_vec();
                if let Handshake::Ack(_) = dev.token_out(c.ep_out as usize, &chunk, mem) {
                    self.cdc_tx.drain(..n);
                }
            }
        }
    }

    fn on_hid_report(&mut self, k: usize, d: &[u8]) {
        self.hid_reports += 1;
        let ids = self.hid[k].ids.clone();
        let (kind, body) = if ids.len() == 1 && ids[0].0 == 0 {
            (ids[0].1, d)
        } else {
            let Some(&id) = d.first() else { return };
            let kind = ids
                .iter()
                .find(|x| x.0 == id)
                .map(|x| x.1)
                .unwrap_or(HidKind::Other);
            (kind, &d[1..])
        };
        match kind {
            HidKind::Keyboard if body.len() >= 3 => {
                let shift = body[0] & 0x22 != 0;
                let keys: Vec<u8> = body[2..].iter().copied().filter(|&x| x > 3).collect();
                for &key in &keys {
                    if !self.last_keys.contains(&key) {
                        if let Some(ch) = keycode_char(key, shift) {
                            self.typed.push(ch);
                        } else if key == 0x2a {
                            self.typed.pop();
                        }
                    }
                }
                self.last_keys = keys;
            }
            HidKind::Mouse if body.len() >= 3 => {
                let (b, dx, dy) = (body[0], body[1] as i8 as i32, body[2] as i8 as i32);
                self.mouse.0 += dx;
                self.mouse.1 += dy;
                self.mouse.2 = b;
                self.mouse.3 += 1;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opening fragments of TinyUSB's TUD_HID_REPORT_DESC_KEYBOARD / MOUSE (with report IDs 1 / 2)
    #[test]
    fn report_ids_by_application() {
        let d = [
            0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x85, 0x01, 0x05, 0x07,
            0xc0, // keyboard, report 1
            0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x85, 0x02, 0x09, 0x01, 0xa1, 0x00, 0xc0,
            0xc0, // mouse, report 2
        ];
        assert_eq!(
            parse_report_desc(&d),
            vec![(1, HidKind::Keyboard), (2, HidKind::Mouse)]
        );
    }

    #[test]
    fn keycodes_to_text() {
        assert_eq!(keycode_char(0x0b, true), Some('H'));
        assert_eq!(keycode_char(0x08, false), Some('e'));
        assert_eq!(keycode_char(0x1e, true), Some('!'));
        assert_eq!(keycode_char(0x28, false), Some('\n'));
        assert_eq!(keycode_char(0x2c, false), Some(' '));
    }

    #[test]
    fn utf16_string_descriptor() {
        let d = [10, 3, b'T', 0, b'r', 0, b'y', 0, b'B', 0];
        assert_eq!(utf16(&d), "TryB");
    }
}
