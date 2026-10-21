//! Virtual internet servers: DNS (every name resolves to the gateway), TCP (passive open only), HTTP/1.1 (port 80, Connection: close).
//! No retransmission: the network never drops. `Upgrade: websocket` on a registered route stays open for server pushes (ws.rs).

use super::net::l4_checksum;
use super::ws;
use std::collections::HashMap;

const SYN: u8 = 0x02;
const ACK: u8 = 0x10;
const FIN: u8 = 0x01;
const RST: u8 = 0x04;
const PSH: u8 = 0x08;
const MSS: usize = 1400;

#[derive(Default)]
struct Conn {
    /// Next sequence number to send / expected to receive
    snd_nxt: u32,
    rcv_nxt: u32,
    req: Vec<u8>,
    responded: bool,
    fin_sent: bool,
    /// Time the SYN arrived (the network tab "duration" counts from here)
    t0: u64,
    /// Real network (C-03): id of the request handed to the browser and still awaiting a reply
    real: Option<u32>,
    /// Long-lived connections (F-09a-1, WebSocket only; HTTP keeps its one-shot path):
    /// oldest unacked byte, chip's advertised window, bytes waiting for window space
    snd_una: u32,
    peer_wnd: u32,
    sendq: Vec<u8>,
    /// Chip sent FIN (half-closed: we may still send) / we owe a FIN once sendq drains
    peer_fin: bool,
    fin_pending: bool,
    ws: Option<Box<WsConn>>,
}

/// WebSocket state on an upgraded connection
struct WsConn {
    dec: ws::Decoder,
    /// Built-in echo route: messages come straight back instead of going to the inbox
    echo: bool,
    close_sent: bool,
    /// Closed event already reported to the inbox
    reported: bool,
    /// Network-tab row of this connection
    row: usize,
}

/// Built-in WebSocket route: echoes every text / binary message (smoke tests, no app needed)
pub const WS_ECHO_PATH: &str = "/echo";

/// What WebSocket apps drain from `Tcp::ws_inbox` (F-09a-2 xiaozhi script and later)
#[derive(Clone, Debug, PartialEq)]
pub enum WsIn {
    /// Upgrade accepted: request path and the full request head (Authorization, Device-Id...)
    Open {
        key: Key,
        path: String,
        head: String,
    },
    Msg {
        key: Key,
        op: u8,
        data: Vec<u8>,
    },
    /// Close code from the chip (1006 = TCP gone without a close frame)
    Closed {
        key: Key,
        code: u16,
    },
}

/// One network-tab row (C-02 / C-03): a DNS query / HTTP request / blocked connection from the chip
#[derive(Clone, Debug)]
pub struct NetRow {
    pub t_us: u64,
    /// DNS / GET / POST / HTTPS / MQTT / TCP
    pub method: String,
    /// Virtual / Real / Not allowed
    pub dest: &'static str,
    pub url: String,
    pub status: String,
    pub dur_us: Option<u64>,
    /// Extra note (C-03: why cross-origin failed, HTTPS not allowed...), empty when none
    pub note: String,
}

/// Real network (C-03): an HTTP request for the browser to fetch (the web drains the outbox)
#[derive(Clone, Debug)]
pub struct RealReq {
    pub id: u32,
    pub method: String,
    pub url: String,
    pub ctype: String,
    pub body: Vec<u8>,
}

/// Browser failure reason code -> network-tab note (codes defined by web realfetch.ts)
pub fn reason_text(code: &str) -> &'static str {
    match code {
        "cors" => "The site does not allow cross-origin requests (CORS); the browser blocked it",
        "net" => "Cannot connect (no such domain, offline or blocked)",
        "timeout" => "No reply in 10 s",
        "mixed" => "The page is https; the browser does not allow http requests (mixed content)",
        _ => "Blocked by the browser (cross-origin or network error)",
    }
}

/// Reply body limit (same as MAX_BODY in web realfetch.ts)
pub const REAL_MAX_BODY: usize = 64 * 1024;

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

/// One request header (case-insensitive)
fn header<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.split("\r\n").skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

pub type Key = ([u8; 4], u16, [u8; 4], u16);

#[derive(Default)]
pub struct Tcp {
    conns: HashMap<Key, Conn>,
    ip_id: u16,
    isn: u32,
    /// Custom pages: path -> (content type, body); the web page / tests can inject them
    pub pages: HashMap<String, (String, Vec<u8>)>,
    pub requests: u64,
    /// Structured rows for the web "network" tab (display only, never affects bytes sent to the chip)
    pub rows: Vec<NetRow>,
    /// Current simulated time (updated on every frame Net receives), stamps DNS rows
    pub now_us: u64,
    /// "Real network" switch (C-03, off by default): when on, HTTP requests not for tryboard.local go to the outbox for the web to answer
    pub realnet: bool,
    /// Requests waiting for the web to take them
    pub outbox: Vec<RealReq>,
    pub next_req: u32,
    /// Requests awaiting a reply: id -> (connection, network-tab row)
    waiting: HashMap<u32, (Key, usize)>,
    /// Number of rewritten rows (Waiting -> 200 / Timed out): the web refetches when rows + this change
    pub rev: u64,
    /// Injected faults (D-01, set by the world from its conditions): DNS answers SERVFAIL / the server drops everything
    pub dns_fail: bool,
    pub silent: bool,
    /// Connections already listed as unanswered (SYN retries make one row, not many)
    silent_seen: std::collections::HashSet<Key>,
    /// WebSocket routes served by an app (path prefixes); other upgrade requests get the usual HTTP 404
    pub ws_routes: Vec<String>,
    /// WebSocket events for the app to drain (open / message / closed)
    pub ws_inbox: Vec<WsIn>,
}

/// Guess a protocol name from the port (how a blocked connection is labelled in the network tab)
fn proto_name(port: u16) -> &'static str {
    match port {
        443 | 8443 => "HTTPS",
        1883 | 8883 => "MQTT",
        _ => "TCP",
    }
}

/// Parameters of one TCP segment (server -> chip)
struct Seg<'a> {
    sport: u16,
    dport: u16,
    seq: u32,
    ack: u32,
    flags: u8,
    opts: &'a [u8],
    src: [u8; 4],
    dst: [u8; 4],
}

/// One server -> chip segment (key from the chip view: chip addr, chip port, server addr, server port)
fn to_chip(k: &Key, c: &Conn, flags: u8, opts: &[u8], d: &[u8]) -> Vec<u8> {
    let (src, sport, dst, dport) = *k;
    seg(
        Seg {
            sport: dport,
            dport: sport,
            seq: c.snd_nxt,
            ack: c.rcv_nxt,
            flags,
            opts,
            src: dst,
            dst: src,
        },
        d,
    )
}

/// The whole HTTP reply goes out in MSS-sized segments, the last with FIN (Connection: close)
fn send_resp(k: &Key, c: &mut Conn, resp: &[u8], line: String) -> Vec<(Vec<u8>, Option<String>)> {
    let mut out = Vec::new();
    let chunks: Vec<&[u8]> = resp.chunks(MSS).collect();
    for (i, ch) in chunks.iter().enumerate() {
        let last = i + 1 == chunks.len();
        let fl = ACK | PSH | if last { FIN } else { 0 };
        out.push((
            to_chip(k, c, fl, &[], ch),
            if i == 0 { Some(line.clone()) } else { None },
        ));
        c.snd_nxt = c
            .snd_nxt
            .wrapping_add(ch.len() as u32 + if last { 1 } else { 0 });
    }
    c.fin_sent = true;
    out
}

fn seg(p: Seg, data: &[u8]) -> Vec<u8> {
    let Seg {
        sport,
        dport,
        seq,
        ack,
        flags,
        opts,
        src,
        dst,
    } = p;
    let hl = 20 + opts.len();
    let mut s = Vec::with_capacity(hl + data.len());
    s.extend_from_slice(&sport.to_be_bytes());
    s.extend_from_slice(&dport.to_be_bytes());
    s.extend_from_slice(&seq.to_be_bytes());
    s.extend_from_slice(&ack.to_be_bytes());
    s.push(((hl / 4) as u8) << 4);
    s.push(flags);
    s.extend_from_slice(&8192u16.to_be_bytes());
    s.extend_from_slice(&[0, 0, 0, 0]);
    s.extend_from_slice(opts);
    s.extend_from_slice(data);
    let c = l4_checksum(src, dst, 6, &s);
    s[16] = (c >> 8) as u8;
    s[17] = c as u8;
    s
}

/// Should this request go to the real network: Host is neither tryboard.local nor the literal gateway address
fn goes_real(head: &[u8], server: [u8; 4]) -> bool {
    let text = String::from_utf8_lossy(head);
    let host = header(&text, "host").unwrap_or("");
    let name = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    let gw = format!("{}.{}.{}.{}", server[0], server[1], server[2], server[3]);
    !(name.is_empty() || name == "tryboard.local" || name == gw)
}

fn content_length(head: &str) -> usize {
    header(head, "content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

fn body_complete(req: &[u8], hp: usize) -> bool {
    let cl = content_length(&String::from_utf8_lossy(&req[..hp]));
    req.len() >= hp + 4 + cl
}

impl Tcp {
    /// Hand the request to the web: into the outbox, network tab gets a "Waiting" row
    fn queue_real(&mut self, req: &[u8], hp: usize, t0: u64) -> u32 {
        let text = String::from_utf8_lossy(&req[..hp]).into_owned();
        let first = text.lines().next().unwrap_or("");
        let mut parts = first.split_whitespace();
        let (method, path) = (parts.next().unwrap_or("GET"), parts.next().unwrap_or("/"));
        let host = header(&text, "host").unwrap_or("");
        let url = format!("http://{host}{path}");
        let cl = content_length(&text);
        self.next_req += 1;
        let id = self.next_req;
        self.requests += 1;
        self.outbox.push(RealReq {
            id,
            method: method.to_string(),
            url: url.clone(),
            ctype: header(&text, "content-type").unwrap_or("").to_string(),
            body: req[hp + 4..(hp + 4 + cl).min(req.len())].to_vec(),
        });
        self.rows.push(NetRow {
            t_us: t0,
            method: method.to_string(),
            dest: "Real",
            url,
            status: "Waiting".into(),
            dur_us: None,
            note: String::new(),
        });
        id
    }

    /// Chip disconnected before the reply: mark the row as timed out and drop the late reply
    fn abandon(&mut self, c: &Conn) {
        let Some(id) = c.real else { return };
        if let Some((_, row)) = self.waiting.remove(&id) {
            if let Some(r) = self.rows.get_mut(row) {
                r.status = "Timed out".into();
                r.note = "The chip closed the connection before a reply came".into();
                self.rev += 1;
            }
        }
    }

    /// Reply from the web (netreply=): status 0 = browser got nothing (info = reason code, chip gets 502), else info is the content type;
    /// bytes to the chip depend only on these, so live web and CLI replay match exactly. Returns (connection, segments, log)
    pub fn real_reply(
        &mut self,
        id: u32,
        status: u16,
        info: &str,
        body: &[u8],
        now_us: u64,
    ) -> Vec<(Key, Vec<u8>, Option<String>)> {
        let Some((key, row)) = self.waiting.remove(&id) else {
            return vec![];
        };
        let Some(mut c) = self.conns.remove(&key) else {
            return vec![];
        };
        let (code, ctype, body, note) = if status == 0 {
            (
                502,
                "text/plain".to_string(),
                format!("TRYBOARD_REALNET_ERROR {info}\n").into_bytes(),
                reason_text(info).to_string(),
            )
        } else {
            (
                status,
                info.to_string(),
                body[..body.len().min(REAL_MAX_BODY)].to_vec(),
                String::new(),
            )
        };
        let mut resp = format!(
            "HTTP/1.1 {code} {}\r\nServer: tryboard-realnet\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            reason_phrase(code),
            body.len()
        )
        .into_bytes();
        resp.extend_from_slice(&body);
        let url = match self.rows.get_mut(row) {
            Some(r) => {
                r.status = if status == 0 {
                    "Failed".into()
                } else {
                    code.to_string()
                };
                r.dur_us = Some(now_us.saturating_sub(c.t0));
                r.note = note;
                r.url.clone()
            }
            None => String::new(),
        };
        self.rev += 1;
        let line = format!("real network {url} -> {code} ({} bytes)", body.len());
        c.real = None;
        let out = send_resp(&key, &mut c, &resp, line);
        self.conns.insert(key, c);
        out.into_iter().map(|(s, l)| (key, s, l)).collect()
    }

    pub fn next_ip_id(&mut self) -> u16 {
        self.ip_id = self.ip_id.wrapping_add(1);
        self.ip_id
    }

    /// DNS query -> answer (A record pointing at the gateway)
    pub fn dns(&mut self, q: &[u8], gw: [u8; 4]) -> Option<(Vec<u8>, String)> {
        if q.len() < 12 || q[2] & 0x80 != 0 || u16::from_be_bytes([q[4], q[5]]) != 1 {
            return None;
        }
        // Parse the name in the question
        let mut i = 12;
        let mut name = Vec::new();
        while i < q.len() && q[i] != 0 {
            let l = q[i] as usize;
            if i + 1 + l > q.len() {
                return None;
            }
            name.push(String::from_utf8_lossy(&q[i + 1..i + 1 + l]).into_owned());
            i += 1 + l;
        }
        let qend = i + 5;
        if qend > q.len() {
            return None;
        }
        let qtype = u16::from_be_bytes([q[i + 1], q[i + 2]]);
        let mut r = q[..qend].to_vec();
        r[2] = 0x81; // Response, recursion desired
        r[3] = 0x80; // Recursion available, no error
        let n = name.join(".");
        if self.dns_fail {
            r[3] = 0x82; // SERVFAIL, no answer
            r[6..12].fill(0);
            self.rows.push(NetRow {
                t_us: self.now_us,
                method: "DNS".into(),
                dest: "Virtual",
                url: n.clone(),
                status: "Failed".into(),
                dur_us: None,
                note: "Injected fault: DNS answers SERVFAIL".into(),
            });
            return Some((r, format!("DNS {n} → SERVFAIL (injected fault)")));
        }
        if qtype == 1 {
            r[7] = 1; // 1 answer
            r.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0x0e, 0x10, 0, 4]);
            r.extend_from_slice(&gw);
        } else {
            r[7] = 0;
        }
        r[8..12].fill(0);
        self.rows.push(NetRow {
            t_us: self.now_us,
            method: "DNS".into(),
            dest: "Virtual",
            url: n.clone(),
            status: "Resolved".into(),
            dur_us: None,
            note: String::new(),
        });
        Some((
            r,
            format!("DNS {n} → {}.{}.{}.{}", gw[0], gw[1], gw[2], gw[3]),
        ))
    }

    fn response(&mut self, req: &[u8], t0: u64, now: u64) -> (Vec<u8>, String) {
        let text = String::from_utf8_lossy(req);
        let first = text.lines().next().unwrap_or("");
        let mut parts = first.split_whitespace();
        let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));
        let host = text
            .lines()
            .find_map(|l| {
                l.strip_prefix("Host: ")
                    .or_else(|| l.strip_prefix("host: "))
            })
            .unwrap_or("")
            .trim()
            .to_string();
        self.requests += 1;
        let (status, ctype, body): (&str, String, Vec<u8>) = if let Some((t, b)) =
            self.pages.get(path)
        {
            ("200 OK", t.clone(), b.clone())
        } else {
            match path {
                "/" => (
                    "200 OK",
                    "text/html; charset=utf-8".into(),
                    format!(
                        "<!doctype html><html><head><title>TryBoard</title></head><body><h1>Hello from the TryBoard virtual internet</h1><p>Host: {host}</p><p>TRYBOARD_HTTP_OK</p></body></html>\n"
                    )
                    .into_bytes(),
                ),
                "/hello.txt" => ("200 OK", "text/plain".into(), b"TRYBOARD_HTTP_OK\n".to_vec()),
                "/api/time" => (
                    "200 OK",
                    "application/json".into(),
                    b"{\"unixtime\":1792123200,\"timezone\":\"Asia/Shanghai\"}\n".to_vec(),
                ),
                _ => ("404 Not Found", "text/plain".into(), b"not found\n".to_vec()),
            }
        };
        let mut r = format!(
            "HTTP/1.1 {status}\r\nServer: tryboard-virtual\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        r.extend_from_slice(&body);
        self.rows.push(NetRow {
            t_us: t0,
            method: method.to_string(),
            dest: "Virtual",
            url: format!("http://{}{path}", if host.is_empty() { "?" } else { &host }),
            status: status.split(' ').next().unwrap_or("").to_string(),
            dur_us: Some(now.saturating_sub(t0)),
            note: String::new(),
        });
        (
            r,
            format!(
                "HTTP {method} {host}{path} → {status} ({} bytes)",
                body.len()
            ),
        )
    }

    /// TCP segment from the chip; returns the segments to reply (and an optional log line)
    pub fn on_segment(
        &mut self,
        src: [u8; 4],
        dst: [u8; 4],
        s: &[u8],
        now_us: u64,
    ) -> Vec<(Vec<u8>, Option<String>)> {
        if s.len() < 20 {
            return vec![];
        }
        let sport = u16::from_be_bytes([s[0], s[1]]);
        let dport = u16::from_be_bytes([s[2], s[3]]);
        let seq = u32::from_be_bytes([s[4], s[5], s[6], s[7]]);
        let flags = s[13];
        let ackno = u32::from_be_bytes([s[8], s[9], s[10], s[11]]);
        let wnd = u16::from_be_bytes([s[14], s[15]]) as u32;
        let hl = ((s[12] >> 4) as usize * 4).min(s.len());
        let data = &s[hl..];
        let key = (src, sport, dst, dport);
        let mut out = Vec::new();
        if self.silent {
            // Server not responding (D-01): every segment vanishes; list each connection attempt once
            if flags & SYN != 0 && flags & ACK == 0 && self.silent_seen.insert(key) {
                self.rows.push(NetRow {
                    t_us: now_us,
                    method: "TCP".into(),
                    dest: "Virtual",
                    url: format!("{}.{}.{}.{}:{dport}", dst[0], dst[1], dst[2], dst[3]),
                    status: "No reply".into(),
                    dur_us: None,
                    note: "Injected fault: the server does not respond".into(),
                });
            }
            return out;
        }
        let mk = |c: &Conn, fl: u8, opts: &[u8], d: &[u8]| to_chip(&key, c, fl, opts, d);

        if flags & RST != 0 {
            if let Some(mut c) = self.conns.remove(&key) {
                self.abandon(&c);
                self.ws_gone(&key, &mut c);
            }
            return out;
        }
        if flags & SYN != 0 {
            if dport != 80 {
                // Only port 80 listens: RST for other ports
                let c = Conn {
                    snd_nxt: 0,
                    rcv_nxt: seq.wrapping_add(1),
                    ..Default::default()
                };
                out.push((
                    mk(&c, RST | ACK, &[], &[]),
                    Some(format!("TCP :{dport} connection refused")),
                ));
                self.rows.push(NetRow {
                    t_us: now_us,
                    method: proto_name(dport).into(),
                    dest: "Not allowed",
                    url: format!("{}.{}.{}.{}:{dport}", dst[0], dst[1], dst[2], dst[3]),
                    status: "Blocked".into(),
                    dur_us: None,
                    // With the real network on, explain why it was blocked (off: no note, as before)
                    note: match (self.realnet, dport) {
                        (false, _) => String::new(),
                        (true, 443 | 8443) => {
                            "The real network only allows HTTP; HTTPS is not allowed".into()
                        }
                        (true, _) => "The real network only allows HTTP".into(),
                    },
                });
                return out;
            }
            self.isn = self.isn.wrapping_add(0x0101_0101);
            let mut c = Conn {
                snd_nxt: self.isn,
                rcv_nxt: seq.wrapping_add(1),
                t0: now_us,
                snd_una: self.isn,
                peer_wnd: wnd,
                ..Default::default()
            };
            out.push((
                mk(&c, SYN | ACK, &[2, 4, (MSS >> 8) as u8, MSS as u8], &[]),
                Some(format!("TCP connect :{dport}")),
            ));
            c.snd_nxt = c.snd_nxt.wrapping_add(1);
            self.conns.insert(key, c);
            return out;
        }
        let Some(mut c) = self.conns.remove(&key) else {
            return out;
        };
        if c.ws.is_some() {
            return self.on_ws_segment(key, c, seq, flags, ackno, wnd, data);
        }
        // Window / ACK bookkeeping (only WebSocket sends use it; the HTTP path below is unchanged)
        if flags & ACK != 0 {
            c.peer_wnd = wnd;
            if ackno.wrapping_sub(c.snd_una) <= c.snd_nxt.wrapping_sub(c.snd_una) {
                c.snd_una = ackno;
            }
        }
        let mut need_ack = false;
        if !data.is_empty() && seq == c.rcv_nxt {
            c.rcv_nxt = c.rcv_nxt.wrapping_add(data.len() as u32);
            c.req.extend_from_slice(data);
            need_ack = true;
        }
        let peer_fin = flags & FIN != 0;
        if peer_fin {
            c.rcv_nxt = c.rcv_nxt.wrapping_add(1);
            need_ack = true;
        }
        let head = c.req.windows(4).position(|w| w == b"\r\n\r\n");
        if let (false, Some(hp)) = (c.responded, head) {
            if let Some(line) = self.try_upgrade(&key, &mut c, hp, now_us) {
                // WebSocket (F-09a-1): 101 + anything already due; the connection stays open
                if peer_fin {
                    c.peer_fin = true;
                    c.fin_pending = true;
                    self.ws_gone(&key, &mut c);
                }
                let segs = flush(&key, &mut c);
                if segs.is_empty() {
                    out.push((mk(&c, ACK, &[], &[]), Some(line)));
                } else {
                    for (i, sg) in segs.into_iter().enumerate() {
                        out.push((sg, (i == 0).then(|| line.clone())));
                    }
                }
                if !(c.peer_fin && c.fin_sent) {
                    self.conns.insert(key, c);
                }
                return out;
            }
            if self.realnet && goes_real(&c.req[..hp], dst) {
                // Real network (C-03): requests with a body wait for the full Content-Length, then go to the web; real_reply answers
                if body_complete(&c.req, hp) {
                    c.responded = true;
                    let id = self.queue_real(&c.req, hp, c.t0);
                    c.real = Some(id);
                    self.waiting.insert(id, (key, self.rows.len() - 1));
                }
            } else {
                c.responded = true;
                let (resp, line) = self.response(&c.req, c.t0, now_us);
                out.extend(send_resp(&key, &mut c, &resp, line));
                need_ack = false;
            }
        }
        // The chip gave up first (esp_http_client timeout) and closed: mark the row as timed out and answer with RST
        if peer_fin && c.real.is_some() && !c.fin_sent {
            self.abandon(&c);
            return vec![(
                mk(&c, RST | ACK, &[], &[]),
                Some("Real network: the chip closed the connection before a reply came".into()),
            )];
        }
        if need_ack {
            out.push((mk(&c, ACK, &[], &[]), None));
        }
        // Both sides sent FIN: connection over
        if !(peer_fin && c.fin_sent) {
            self.conns.insert(key, c);
        }
        out
    }
}

/// Send what the window allows from sendq (MSS-sized), then the owed FIN once it is empty
fn flush(k: &Key, c: &mut Conn) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let inflight = c.snd_nxt.wrapping_sub(c.snd_una) as usize;
        let room = (c.peer_wnd as usize).saturating_sub(inflight);
        let n = c.sendq.len().min(MSS).min(room);
        let fin = c.fin_pending && !c.fin_sent && n == c.sendq.len();
        if n == 0 && !fin {
            break;
        }
        let d: Vec<u8> = c.sendq.drain(..n).collect();
        let fl = ACK | if n > 0 { PSH } else { 0 } | if fin { FIN } else { 0 };
        out.push(to_chip(k, c, fl, &[], &d));
        c.snd_nxt = c.snd_nxt.wrapping_add(n as u32 + fin as u32);
        if fin {
            c.fin_sent = true;
            break;
        }
    }
    out
}

impl Tcp {
    /// `Upgrade: websocket` on the echo route or a registered one: 101 into sendq, the rest of the bytes start the frame stream
    fn try_upgrade(&mut self, key: &Key, c: &mut Conn, hp: usize, now_us: u64) -> Option<String> {
        let head = String::from_utf8_lossy(&c.req[..hp]).into_owned();
        let u = ws::parse_upgrade(&head)?;
        let echo = u.path == WS_ECHO_PATH;
        if !echo
            && !self
                .ws_routes
                .iter()
                .any(|r| u.path.starts_with(r.as_str()))
        {
            return None;
        }
        let host = header(&head, "host").unwrap_or("?").to_string();
        self.requests += 1;
        self.rows.push(NetRow {
            t_us: c.t0,
            method: "WS".into(),
            dest: "Virtual",
            url: format!("ws://{host}{}", u.path),
            status: "101".into(),
            dur_us: Some(now_us.saturating_sub(c.t0)),
            note: String::new(),
        });
        c.responded = true;
        c.sendq.extend_from_slice(&ws::handshake_response(&u));
        c.ws = Some(Box::new(WsConn {
            dec: ws::Decoder::default(),
            echo,
            close_sent: false,
            reported: false,
            row: self.rows.len() - 1,
        }));
        if !echo {
            self.ws_inbox.push(WsIn::Open {
                key: *key,
                path: u.path.clone(),
                head,
            });
        }
        let rest = c.req.split_off(hp + 4);
        c.req.clear();
        let line = format!("WebSocket open ws://{host}{}", u.path);
        Some(match self.ws_feed(key, c, &rest) {
            Some(l) => format!("{line}; {l}"),
            None => line,
        })
    }

    /// Chip bytes on an open WebSocket: answer ping / close here, hand messages to the app (or echo them).
    /// Returns a log line when the WebSocket closed
    fn ws_feed(&mut self, key: &Key, c: &mut Conn, data: &[u8]) -> Option<String> {
        let w = c.ws.as_mut()?;
        let mut line = None;
        for e in w.dec.feed(data) {
            match e {
                ws::Event::Message { op, data } if w.echo => {
                    if !w.close_sent {
                        c.sendq.extend(ws::encode(op, true, &data, None));
                    }
                }
                ws::Event::Message { op, data } => self.ws_inbox.push(WsIn::Msg {
                    key: *key,
                    op,
                    data,
                }),
                ws::Event::Ping(p) => {
                    if !w.close_sent {
                        c.sendq.extend(ws::encode(ws::OP_PONG, true, &p, None));
                    }
                }
                ws::Event::Pong(_) => {}
                ws::Event::Close { code, .. } | ws::Event::Error(code) => {
                    // Echo the chip's close code (empty when it sent none), or send ours on a protocol error; then FIN
                    if !w.close_sent {
                        let p = match code {
                            1005 => vec![],
                            n => ws::close_payload(n, ""),
                        };
                        c.sendq.extend(ws::encode(ws::OP_CLOSE, true, &p, None));
                        w.close_sent = true;
                    }
                    c.fin_pending = true;
                    if !w.reported {
                        w.reported = true;
                        if let Some(r) = self.rows.get_mut(w.row) {
                            r.status = format!("Closed {code}");
                            self.rev += 1;
                        }
                        if !w.echo {
                            self.ws_inbox.push(WsIn::Closed { key: *key, code });
                        }
                        line = Some(format!("WebSocket close {code}"));
                    }
                }
            }
        }
        line
    }

    /// A segment on an upgraded (long-lived) connection: ACK bookkeeping, frames in, queued data out, half-close
    #[allow(clippy::too_many_arguments)]
    fn on_ws_segment(
        &mut self,
        key: Key,
        mut c: Conn,
        seq: u32,
        flags: u8,
        ackno: u32,
        wnd: u32,
        data: &[u8],
    ) -> Vec<(Vec<u8>, Option<String>)> {
        if flags & ACK != 0 {
            c.peer_wnd = wnd;
            if ackno.wrapping_sub(c.snd_una) <= c.snd_nxt.wrapping_sub(c.snd_una) {
                c.snd_una = ackno;
            }
        }
        let mut need_ack = false;
        let mut line = None;
        if !data.is_empty() {
            // In order: take it. Anything else (a retransmit) only earns a duplicate ACK
            need_ack = true;
            if seq == c.rcv_nxt && !c.peer_fin {
                c.rcv_nxt = c.rcv_nxt.wrapping_add(data.len() as u32);
                line = self.ws_feed(&key, &mut c, data);
            }
        }
        let fin_seq = seq.wrapping_add(data.len() as u32);
        if flags & FIN != 0 && !c.peer_fin && fin_seq == c.rcv_nxt {
            // Half-close: the chip is done sending; queued data still goes out, then our FIN
            c.rcv_nxt = c.rcv_nxt.wrapping_add(1);
            c.peer_fin = true;
            c.fin_pending = true;
            need_ack = true;
            self.ws_gone(&key, &mut c);
        }
        let segs = flush(&key, &mut c);
        let mut out: Vec<(Vec<u8>, Option<String>)> = segs.into_iter().map(|s| (s, None)).collect();
        if out.is_empty() && need_ack {
            out.push((to_chip(&key, &c, ACK, &[], &[]), None));
        }
        if let (Some(l), Some(f)) = (line, out.first_mut()) {
            f.1 = Some(l);
        }
        if !(c.peer_fin && c.fin_sent) {
            self.conns.insert(key, c);
        }
        out
    }

    /// Connection gone without a close handshake (chip FIN / RST): tell the app once
    fn ws_gone(&mut self, key: &Key, c: &mut Conn) {
        let Some(w) = c.ws.as_mut().filter(|w| !w.reported) else {
            return;
        };
        w.reported = true;
        if let Some(r) = self.rows.get_mut(w.row) {
            r.status = "Closed 1006".into();
            self.rev += 1;
        }
        if !w.echo {
            self.ws_inbox.push(WsIn::Closed {
                key: *key,
                code: 1006,
            });
        }
    }

    /// Open WebSocket connections the server may still push to, sorted
    pub fn ws_conns(&self) -> Vec<Key> {
        let mut v: Vec<Key> = self
            .conns
            .iter()
            .filter(|(_, c)| c.ws.as_ref().is_some_and(|w| !w.close_sent) && !c.fin_pending)
            .map(|(k, _)| *k)
            .collect();
        v.sort();
        v
    }

    /// Server push (F-09a-1): a whole message, or with `fin` false one fragment (continue with OP_CONT).
    /// Returns what the chip's window allows now; the rest goes out as it ACKs. Same shape as real_reply
    pub fn ws_send(
        &mut self,
        key: Key,
        op: u8,
        fin: bool,
        data: &[u8],
    ) -> Vec<(Key, Vec<u8>, Option<String>)> {
        let Some(c) = self.conns.get_mut(&key) else {
            return vec![];
        };
        if !c.ws.as_ref().is_some_and(|w| !w.close_sent) || c.fin_pending {
            return vec![];
        }
        c.sendq.extend(ws::encode(op, fin, data, None));
        flush(&key, c).into_iter().map(|s| (key, s, None)).collect()
    }

    /// Server-initiated close: close frame then FIN; the connection ends when the chip's FIN arrives
    pub fn ws_close(
        &mut self,
        key: Key,
        code: u16,
        reason: &str,
    ) -> Vec<(Key, Vec<u8>, Option<String>)> {
        let Some(c) = self.conns.get_mut(&key) else {
            return vec![];
        };
        let Some(w) = c.ws.as_mut().filter(|w| !w.close_sent) else {
            return vec![];
        };
        w.close_sent = true;
        let row = (!w.reported).then_some(w.row);
        w.reported = true;
        let p = ws::close_payload(code, reason);
        c.sendq.extend(ws::encode(ws::OP_CLOSE, true, &p, None));
        c.fin_pending = true;
        let mut out: Vec<_> = flush(&key, c).into_iter().map(|s| (key, s, None)).collect();
        if let Some(r) = row.and_then(|i| self.rows.get_mut(i)) {
            r.status = format!("Closed {code}");
            self.rev += 1;
        }
        if let Some(f) = out.first_mut() {
            f.2 = Some(format!("WebSocket close {code} (server)"));
        }
        out
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// base64 encode (request bodies in the real-network outbox for the web)
pub fn b64_encode(d: &[u8]) -> String {
    let mut s = String::with_capacity(d.len().div_ceil(3) * 4);
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                s.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// base64 decode (reply body in netreply=); None on invalid characters
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for ch in s.bytes().filter(|c| *c != b'=') {
        let v = B64.iter().position(|x| *x == ch)? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Parse the part after script action netreply=: id,status,ms,content type or reason code,base64 body
/// (ms is the browser-measured time, display only, never affects bytes sent to the chip)
pub fn parse_netreply(s: &str) -> Option<(u32, u16, String, Vec<u8>)> {
    let mut p = s.splitn(4, ',');
    let id = p.next()?.trim().parse().ok()?;
    let status = p.next()?.trim().parse().ok()?;
    let _ms: f64 = p.next()?.trim().parse().ok()?;
    let (info, body) = p.next()?.rsplit_once(',')?;
    Some((
        id,
        status,
        info.trim().to_string(),
        b64_decode(body.trim())?,
    ))
}
