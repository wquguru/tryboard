//! Virtual desktop (E-06): the computer side of the Claude Desktop Buddy BLE protocol, run by the virtual phone's GATT client.
//! Newline-delimited UTF-8 JSON over Nordic UART Service: writes to RX split at MTU-3, TX notifications joined at '\n'.
//! Everything here derives from simulated time only, so `pc=` input logs replay byte for byte.

use std::collections::VecDeque;

pub const NUS_SVC: &str = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
pub const NUS_RX: &str = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
pub const NUS_TX: &str = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
/// Advertised name prefix the desktop app looks for
pub const NAME_PREFIX: &str = "Claude";
/// Lines longer than this are dropped by both sides (protocol limit)
pub const MAX_LINE: usize = 4096;
const POLL_US: u64 = 2_000_000;
const KEEPALIVE_US: u64 = 10_000_000;
/// Scripted activity changes phase every 6 s (running flips, a new entry rolls in)
const PHASE_US: u64 = 6_000_000;
/// Simulated wall clock at boot: 2026-10-20 10:42:00 UTC+8
pub const BASE_EPOCH: u64 = 1_792_464_120;
pub const TZ_OFFSET_S: i64 = 8 * 3600;
pub const OWNER: &str = "TryBoard";
/// Write Without Response PDUs per connection event (phones typically fit a handful)
pub const WRITES_PER_EVENT: usize = 4;

const COMMANDS: [&str; 10] = [
    "git push",
    "yarn test",
    "reading src/main.rs",
    "cargo build --release",
    "editing README.md",
    "grep -rn TODO",
    "npm run lint",
    "git commit -m wip",
    "reading docs/PLAN.md",
    "cargo clippy",
];

/// Accumulates received bytes into lines; a line over [`MAX_LINE`] is dropped whole
#[derive(Default, Debug)]
pub struct LineBuf {
    buf: Vec<u8>,
    frags: u32,
    drop: bool,
}

#[derive(Debug, PartialEq)]
pub enum Line {
    /// Text and the number of chunks it arrived in
    Ok(String, u32),
    /// Dropped for exceeding the limit
    TooLong,
}

impl LineBuf {
    pub fn push(&mut self, d: &[u8]) -> Vec<Line> {
        let mut out = Vec::new();
        // Each chunk counts once for every line it carries bytes of
        let mut counted = false;
        for &b in d {
            if !counted {
                self.frags += 1;
                counted = true;
            }
            if b == b'\n' {
                if self.drop {
                    out.push(Line::TooLong);
                } else if !self.buf.is_empty() {
                    let s = String::from_utf8_lossy(&self.buf).into_owned();
                    out.push(Line::Ok(s, self.frags));
                }
                self.buf.clear();
                self.drop = false;
                self.frags = 0;
                counted = false;
            } else if self.buf.len() < MAX_LINE {
                self.buf.push(b);
            } else {
                self.drop = true;
            }
        }
        out
    }

    pub fn clear(&mut self) {
        *self = LineBuf::default();
    }
}

/// Split one line (newline appended) into ATT payloads of at most MTU-3 bytes
pub fn fragment(line: &str, mtu: u16) -> Vec<Vec<u8>> {
    let mut b = line.as_bytes().to_vec();
    b.push(b'\n');
    let n = (mtu.max(23) - 3) as usize;
    b.chunks(n).map(|c| c.to_vec()).collect()
}

/// Value of a top-level-ish `"key":` in a flat JSON text (string or bare token); enough for acks
pub fn json_field(s: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\":");
    let i = s.find(&pat)? + pat.len();
    let rest = s[i..].trim_start();
    if let Some(r) = rest.strip_prefix('"') {
        return r.find('"').map(|e| r[..e].to_string());
    }
    let e = rest.find([',', '}', ']']).unwrap_or(rest.len());
    Some(rest[..e].trim().to_string())
}

fn clip(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn hhmm(epoch: u64) -> String {
    let local = epoch as i64 + TZ_OFFSET_S;
    let m = local.rem_euclid(86_400) / 60;
    format!("{:02}:{:02}", m / 60, m % 60)
}

pub struct Desk {
    pub on: bool,
    /// Session running: TX subscribed, lines flow
    pub active: bool,
    /// RX value handle and whether it takes Write Without Response
    pub rx: Option<(u16, bool)>,
    pub tx: Option<u16>,
    template: Option<String>,
    outbox: VecDeque<String>,
    inbox: LineBuf,
    start_us: u64,
    next_poll: u64,
    last_hb: u64,
    phase: u64,
    pub sent: u32,
    pub heartbeats: u32,
    pub polls: u32,
    pub acks: u32,
    /// Acks received per command name
    ack_kinds: Vec<(String, u32)>,
    pub last_rx: String,
    pub last_hb_text: String,
}

impl Default for Desk {
    fn default() -> Self {
        Self::new()
    }
}

impl Desk {
    pub fn new() -> Desk {
        Desk {
            on: false,
            active: false,
            rx: None,
            tx: None,
            template: None,
            outbox: VecDeque::new(),
            inbox: LineBuf::default(),
            start_us: 0,
            next_poll: 0,
            last_hb: 0,
            phase: 0,
            sent: 0,
            heartbeats: 0,
            polls: 0,
            acks: 0,
            ack_kinds: Vec::new(),
            last_rx: String::new(),
            last_hb_text: String::new(),
        }
    }

    /// Link gone: keep counters and pending user lines, drop the session
    pub fn end(&mut self) {
        self.active = false;
        self.rx = None;
        self.tx = None;
        self.inbox.clear();
    }

    /// `pc=json,<base64>` / `pc=hb,<base64>`: returns the log line
    pub fn command(&mut self, verb: &str, arg: &str, now: u64) -> Result<String, String> {
        let raw = crate::wifi::tcp::b64_decode(arg.trim()).ok_or("bad base64")?;
        let text = String::from_utf8(raw).map_err(|_| "not UTF-8")?;
        let text = text.trim_end_matches(['\r', '\n']).to_string();
        if text.contains('\n') {
            return Err("one JSON line expected".into());
        }
        match verb {
            "json" => {
                self.outbox.push_back(text.clone());
                Ok(format!("pc: queued {}", clip(&text, 60)))
            }
            "hb" => {
                self.template = Some(text);
                if self.active {
                    let hb = self.heartbeat(now);
                    self.outbox.push_back(hb);
                    self.heartbeats += 1;
                    self.last_hb = now;
                }
                Ok("pc: heartbeat template set".into())
            }
            _ => Err(format!("unknown pc action: {verb}")),
        }
    }

    /// TX subscribed: greet with time and owner, then the first heartbeat
    pub fn start(&mut self, t: u64) {
        self.active = true;
        self.start_us = t;
        let epoch = BASE_EPOCH + t / 1_000_000;
        // User lines queued before the link came up go after the greeting
        let pending: Vec<String> = self.outbox.drain(..).collect();
        self.outbox
            .push_back(format!("{{\"time\":[{epoch},{TZ_OFFSET_S}]}}"));
        self.outbox
            .push_back(format!("{{\"cmd\":\"owner\",\"name\":\"{OWNER}\"}}"));
        self.phase = 0;
        let hb = self.heartbeat(t);
        self.outbox.push_back(hb);
        self.heartbeats += 1;
        self.last_hb = t;
        self.outbox.extend(pending);
        self.next_poll = t + POLL_US;
    }

    /// Due status polls and heartbeats (state change or 10 s keepalive)
    pub fn poll(&mut self, t: u64) {
        if !self.active {
            return;
        }
        let ph = (t - self.start_us) / PHASE_US;
        let changed = self.template.is_none() && ph != self.phase;
        if changed || t >= self.last_hb + KEEPALIVE_US {
            self.phase = ph;
            let hb = self.heartbeat(t);
            self.outbox.push_back(hb);
            self.heartbeats += 1;
            self.last_hb = t;
        }
        if t >= self.next_poll {
            self.next_poll += POLL_US;
            self.outbox.push_back("{\"cmd\":\"status\"}".into());
            self.polls += 1;
        }
    }

    pub fn next_line(&mut self) -> Option<String> {
        let l = self.outbox.pop_front()?;
        self.sent += 1;
        Some(l)
    }

    pub fn heartbeat(&mut self, t: u64) -> String {
        let s = self.heartbeat_text(t);
        self.last_hb_text = s.clone();
        s
    }

    fn heartbeat_text(&self, t: u64) -> String {
        let el = t.saturating_sub(self.start_us);
        let k = el / PHASE_US;
        let epoch = BASE_EPOCH + t / 1_000_000;
        let tokens = 184_502 + el / 27_000;
        let today = 31_200 + el / 27_000;
        let running = k % 2;
        let waiting = u64::from(k % 3 == 2);
        if let Some(tpl) = &self.template {
            return tpl
                .replace("{tokens}", &tokens.to_string())
                .replace("{tokens_today}", &today.to_string())
                .replace("{running}", &running.to_string())
                .replace("{time}", &hhmm(epoch));
        }
        // Newest first: entry i happened i phases ago
        let entries: Vec<String> = (0..8u64)
            .map(|i| {
                let at = epoch.saturating_sub(i * PHASE_US / 1_000_000 + 37);
                let cmd = COMMANDS[((k + 100 - i) % COMMANDS.len() as u64) as usize];
                format!("\"{} {cmd}\"", hhmm(at))
            })
            .collect();
        let msg = if waiting == 1 {
            "approve: Bash".to_string()
        } else {
            format!(
                "working: {}",
                COMMANDS[(k % COMMANDS.len() as u64) as usize]
            )
        };
        format!(
            "{{\"total\":3,\"running\":{running},\"waiting\":{waiting},\"msg\":\"{msg}\",\"entries\":[{}],\"tokens\":{tokens},\"tokens_today\":{today}}}",
            entries.join(",")
        )
    }

    /// TX notification payload; returns log lines
    pub fn on_notify(&mut self, d: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for l in self.inbox.push(d) {
            match l {
                Line::TooLong => out.push(format!("pc: dropped a line over {MAX_LINE} bytes")),
                Line::Ok(s, n) => {
                    out.push(format!(
                        "fw → pc {} ({} B, {n} notification{})",
                        clip(&s, 80),
                        s.len(),
                        if n == 1 { "" } else { "s" }
                    ));
                    if let Some(a) = json_field(&s, "ack") {
                        self.acks += 1;
                        let k = match self.ack_kinds.iter_mut().find(|x| x.0 == a) {
                            Some(x) => {
                                x.1 += 1;
                                x.1
                            }
                            None => {
                                self.ack_kinds.push((a.clone(), 1));
                                1
                            }
                        };
                        let ok = json_field(&s, "ok").as_deref() == Some("true");
                        let mut line =
                            format!("pc: ack {a} #{k} {}", if ok { "ok" } else { "failed" });
                        if let Some(p) = json_field(&s, "pct") {
                            line.push_str(&format!(", battery {p}%"));
                        }
                        out.push(line);
                    }
                    self.last_rx = s;
                }
            }
        }
        out
    }

    pub fn json(&self) -> String {
        format!(
            "{{\"on\":{},\"active\":{},\"sent\":{},\"heartbeats\":{},\"polls\":{},\"acks\":{},\"last_rx\":{},\"last_hb\":{}}}",
            self.on,
            self.active,
            self.sent,
            self.heartbeats,
            self.polls,
            self.acks,
            super::json_str(&self.last_rx),
            super::json_str(&self.last_hb_text)
        )
    }
}

/// Log text for one line going out: first 80 characters, size and write count
pub fn send_log(line: &str, writes: usize) -> String {
    format!(
        "pc → {} ({} B, {writes} write{})",
        clip(line, 80),
        line.len() + 1,
        if writes == 1 { "" } else { "s" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragments_at_mtu_minus_three() {
        let s = "x".repeat(500);
        let f = fragment(&s, 247);
        assert_eq!(
            f.iter().map(|c| c.len()).collect::<Vec<_>>(),
            [244, 244, 13]
        );
        assert_eq!(*f[2].last().unwrap(), b'\n');
        assert_eq!(fragment("{}", 23), vec![b"{}\n".to_vec()]);
    }

    #[test]
    fn reassembles_across_chunks() {
        let mut b = LineBuf::default();
        let line = format!("{{\"a\":\"{}\"}}", "y".repeat(300));
        let mut got = Vec::new();
        for c in fragment(&line, 100) {
            got.extend(b.push(&c));
        }
        assert_eq!(got, vec![Line::Ok(line, 4)]);
    }

    #[test]
    fn holds_partial_and_splits_two_lines() {
        let mut b = LineBuf::default();
        assert!(b.push(b"{\"ack\":\"o").is_empty());
        let r = b.push(b"wner\"}\n{\"x\":1}\n{\"y\"");
        assert_eq!(
            r,
            vec![
                Line::Ok("{\"ack\":\"owner\"}".into(), 2),
                Line::Ok("{\"x\":1}".into(), 1)
            ]
        );
        assert_eq!(b.push(b":2}\n"), vec![Line::Ok("{\"y\":2}".into(), 2)]);
    }

    #[test]
    fn drops_over_4k() {
        let mut b = LineBuf::default();
        let big = vec![b'z'; MAX_LINE + 10];
        assert!(b.push(&big).is_empty());
        assert_eq!(
            b.push(b"z\n{}\n"),
            vec![Line::TooLong, Line::Ok("{}".into(), 1)]
        );
    }

    #[test]
    fn ack_fields_parse() {
        let s = "{\"ack\":\"status\",\"ok\":true,\"data\":{\"bat\":{\"pct\":87}}}";
        assert_eq!(json_field(s, "ack").as_deref(), Some("status"));
        assert_eq!(json_field(s, "ok").as_deref(), Some("true"));
        assert_eq!(json_field(s, "pct").as_deref(), Some("87"));
    }

    #[test]
    fn scripted_session_is_deterministic_and_long() {
        let run = || {
            let mut d = Desk::new();
            d.start(1_000_000);
            let mut t = 1_000_000;
            while t < 26_000_000 {
                d.poll(t);
                t += 30_000;
            }
            let mut v = Vec::new();
            while let Some(l) = d.next_line() {
                v.push(l);
            }
            v
        };
        let a = run();
        assert_eq!(a, run());
        assert!(a[0].starts_with("{\"time\":[1792464121,28800]"));
        assert!(a[1].contains("owner"));
        let hbs: Vec<&String> = a.iter().filter(|l| l.contains("\"total\"")).collect();
        assert!(hbs.len() >= 4, "{}", hbs.len());
        assert!(
            hbs[0].len() > 244,
            "heartbeat must span two writes at MTU 247"
        );
        assert!(hbs[0].contains("\"running\":0") && hbs[1].contains("\"running\":1"));
        assert!(a.iter().filter(|l| l.contains("status")).count() >= 12);
    }

    #[test]
    fn template_and_json_commands() {
        let mut d = Desk::new();
        let b64 = crate::wifi::tcp::b64_encode(b"{\"total\":1,\"tokens\":{tokens}}");
        d.command("hb", &b64, 0).unwrap();
        d.start(0);
        let l: Vec<String> = std::iter::from_fn(|| d.next_line()).collect();
        assert_eq!(l[2], "{\"total\":1,\"tokens\":184502}");
        assert!(d.command("json", "!!", 0).is_err());
        assert!(d.command("nope", "e30=", 0).is_err());
    }
}
