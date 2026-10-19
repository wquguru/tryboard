//! Virtual internet servers: DNS (every name resolves to the gateway), TCP (passive open only), HTTP/1.1 (port 80, Connection: close).
//! No retransmission or congestion control: the virtual network never drops, so replies go out in one go.

use super::net::{l4_checksum, GW_IP};
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
}

type Key = ([u8; 4], u16, [u8; 4], u16);

#[derive(Default)]
pub struct Tcp {
    conns: HashMap<Key, Conn>,
    ip_id: u16,
    isn: u32,
    /// Custom pages: path -> (content type, body); the web page / tests can inject them
    pub pages: HashMap<String, (String, Vec<u8>)>,
    pub requests: u64,
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

impl Tcp {
    pub fn next_ip_id(&mut self) -> u16 {
        self.ip_id = self.ip_id.wrapping_add(1);
        self.ip_id
    }

    /// DNS query -> answer (A record pointing at the gateway)
    pub fn dns(&mut self, q: &[u8]) -> Option<(Vec<u8>, String)> {
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
        if qtype == 1 {
            r[7] = 1; // 1 answer
            r.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0x0e, 0x10, 0, 4]);
            r.extend_from_slice(&GW_IP);
        } else {
            r[7] = 0;
        }
        r[8..12].fill(0);
        let n = name.join(".");
        Some((r, format!("DNS {n} → 192.168.4.1")))
    }

    fn response(&mut self, req: &[u8]) -> (Vec<u8>, String) {
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
        _now_us: u64,
    ) -> Vec<(Vec<u8>, Option<String>)> {
        if s.len() < 20 {
            return vec![];
        }
        let sport = u16::from_be_bytes([s[0], s[1]]);
        let dport = u16::from_be_bytes([s[2], s[3]]);
        let seq = u32::from_be_bytes([s[4], s[5], s[6], s[7]]);
        let flags = s[13];
        let hl = ((s[12] >> 4) as usize * 4).min(s.len());
        let data = &s[hl..];
        let key = (src, sport, dst, dport);
        let mut out = Vec::new();
        let mk = |c: &Conn, fl: u8, opts: &[u8], d: &[u8]| {
            seg(
                Seg {
                    sport: dport,
                    dport: sport,
                    seq: c.snd_nxt,
                    ack: c.rcv_nxt,
                    flags: fl,
                    opts,
                    src: dst,
                    dst: src,
                },
                d,
            )
        };

        if flags & RST != 0 {
            self.conns.remove(&key);
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
                return out;
            }
            self.isn = self.isn.wrapping_add(0x0101_0101);
            let mut c = Conn {
                snd_nxt: self.isn,
                rcv_nxt: seq.wrapping_add(1),
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
        if !c.responded && c.req.windows(4).any(|w| w == b"\r\n\r\n") {
            c.responded = true;
            let (resp, line) = self.response(&c.req);
            let chunks: Vec<&[u8]> = resp.chunks(MSS).collect();
            for (i, ch) in chunks.iter().enumerate() {
                let last = i + 1 == chunks.len();
                let fl = ACK | PSH | if last { FIN } else { 0 };
                out.push((
                    mk(&c, fl, &[], ch),
                    if i == 0 { Some(line.clone()) } else { None },
                ));
                c.snd_nxt = c
                    .snd_nxt
                    .wrapping_add(ch.len() as u32 + if last { 1 } else { 0 });
            }
            c.fin_sent = true;
            need_ack = false;
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
