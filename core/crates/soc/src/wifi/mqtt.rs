//! Minimal MQTT 3.1.1 broker on port 1883 of the virtual internet (F-08b), written from the OASIS 3.1.1 spec.
//! QoS 0 / 1, `+` / `#` wildcards, retained messages; no QoS 2, persistent sessions or TLS. tcp.rs owns the TCP side.

use super::tcp::Key;
use std::collections::BTreeMap;

pub const PORT: u16 = 1883;

const CONNECT: u8 = 1;
const CONNACK: u8 = 2;
const PUBLISH: u8 = 3;
const PUBACK: u8 = 4;
const SUBSCRIBE: u8 = 8;
const SUBACK: u8 = 9;
const UNSUBSCRIBE: u8 = 10;
const UNSUBACK: u8 = 11;
const PINGREQ: u8 = 12;
const PINGRESP: u8 = 13;
const DISCONNECT: u8 = 14;

/// Largest packet accepted from the chip (anything larger closes the connection)
pub const MAX_PACKET: usize = 1 << 20;

/// What the broker asks tcp.rs to do
#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    /// Bytes for one connection (possibly not the one that sent the packet)
    Send(Key, Vec<u8>),
    /// Close the TCP connection (FIN once queued bytes are out)
    Close(Key),
    /// Network-tab row status for the connection
    Status(Key, String),
    /// Air-log line (also kept in `Broker::log`)
    Log(String),
}

/// A length field over 4 bytes or a packet over MAX_PACKET
#[derive(Debug, PartialEq)]
pub struct Malformed;

/// Fixed header byte, body, total length on the wire
pub type Packet<'a> = (u8, &'a [u8], usize);

/// Remaining Length (spec 2.2.3): 7 bits per byte, high bit = more, at most 4 bytes
pub fn encode_len(mut n: usize, out: &mut Vec<u8>) {
    loop {
        let mut b = (n % 128) as u8;
        n /= 128;
        if n > 0 {
            b |= 0x80;
        }
        out.push(b);
        if n == 0 {
            break;
        }
    }
}

/// Ok(Some((length, bytes used))), Ok(None) = need more bytes, Err = more than 4 length bytes
pub fn decode_len(b: &[u8]) -> Result<Option<(usize, usize)>, Malformed> {
    let mut n = 0usize;
    for (i, &x) in b.iter().enumerate() {
        if i == 4 {
            return Err(Malformed);
        }
        n |= ((x & 0x7f) as usize) << (7 * i);
        if x & 0x80 == 0 {
            return Ok(Some((n, i + 1)));
        }
    }
    if b.len() >= 4 {
        Err(Malformed)
    } else {
        Ok(None)
    }
}

/// Fixed header byte + Remaining Length + body
fn packet(first: u8, body: &[u8]) -> Vec<u8> {
    let mut p = vec![first];
    encode_len(body.len(), &mut p);
    p.extend_from_slice(body);
    p
}

fn put_str(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u16).to_be_bytes());
    out.extend_from_slice(s);
}

pub fn connack(rc: u8) -> Vec<u8> {
    packet(CONNACK << 4, &[0, rc])
}

pub fn publish(topic: &str, payload: &[u8], qos: u8, pid: u16, retain: bool) -> Vec<u8> {
    let mut b = Vec::new();
    put_str(&mut b, topic.as_bytes());
    if qos > 0 {
        b.extend_from_slice(&pid.to_be_bytes());
    }
    b.extend_from_slice(payload);
    packet((PUBLISH << 4) | (qos << 1) | retain as u8, &b)
}

fn ack(kind: u8, pid: u16) -> Vec<u8> {
    packet(kind << 4, &pid.to_be_bytes())
}

/// One complete packet off the front of `buf`: Ok(Some((first byte, body, total length))), Ok(None) = incomplete
pub fn split_packet(buf: &[u8]) -> Result<Option<Packet<'_>>, Malformed> {
    if buf.is_empty() {
        return Ok(None);
    }
    let Some((n, used)) = decode_len(&buf[1..])? else {
        return Ok(None);
    };
    if n > MAX_PACKET {
        return Err(Malformed);
    }
    let end = 1 + used + n;
    if buf.len() < end {
        return Ok(None);
    }
    Ok(Some((buf[0], &buf[1 + used..end], end)))
}

/// Cursor over a packet body (UTF-8 strings and u16 fields, spec 1.5)
struct Rd<'a>(&'a [u8]);

impl<'a> Rd<'a> {
    fn u8(&mut self) -> Option<u8> {
        let (&b, rest) = self.0.split_first()?;
        self.0 = rest;
        Some(b)
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_be_bytes([self.u8()?, self.u8()?]))
    }
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let n = self.u16()? as usize;
        if self.0.len() < n {
            return None;
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Some(a)
    }
    fn str(&mut self) -> Option<String> {
        String::from_utf8(self.bytes()?.to_vec()).ok()
    }
}

/// Topic filter rules (spec 4.7.1): `#` only as a whole last level, `+` only as a whole level
pub fn valid_filter(f: &str) -> bool {
    if f.is_empty() {
        return false;
    }
    let levels: Vec<&str> = f.split('/').collect();
    levels.iter().enumerate().all(|(i, l)| {
        (!l.contains('#') || (*l == "#" && i + 1 == levels.len()))
            && (!l.contains('+') || *l == "+")
    })
}

/// Topic names in PUBLISH carry no wildcards
pub fn valid_topic(t: &str) -> bool {
    !t.is_empty() && !t.contains(['+', '#'])
}

/// Does a filter match a topic name; wildcards at the first level never match `$` topics (spec 4.7.2)
pub fn topic_matches(filter: &str, topic: &str) -> bool {
    if topic.starts_with('$') && (filter.starts_with('+') || filter.starts_with('#')) {
        return false;
    }
    let (mut f, mut t) = (filter.split('/'), topic.split('/'));
    loop {
        match (f.next(), t.next()) {
            (Some("#"), _) => return true,
            (Some("+"), Some(_)) => {}
            (Some(a), Some(b)) if a == b => {}
            (None, None) => return true,
            _ => return false,
        }
    }
}

#[derive(Default)]
struct Session {
    buf: Vec<u8>,
    /// Client id once CONNECT was accepted
    client: Option<String>,
    keepalive_s: u16,
    last_us: u64,
    /// Filter -> granted QoS
    subs: BTreeMap<String, u8>,
    next_pid: u16,
}

/// The broker: one session per TCP connection, all clients share topics and retained messages
#[derive(Default)]
pub struct Broker {
    sessions: BTreeMap<Key, Session>,
    /// Retained messages (topic -> payload, QoS); survive board resets like the rest of the internet
    pub retained: BTreeMap<String, (Vec<u8>, u8)>,
    /// (time us, line) for the CLI summary and the web air log
    pub log: Vec<(u64, String)>,
    pub published: u64,
    pub delivered: u64,
    auto_id: u32,
}

/// Script action after `mqtt=`: `pub,<topic>,<payload>` (QoS 0), `pub1,...` (QoS 1), `retain,<topic>,<payload>`
#[derive(Clone, Debug, PartialEq)]
pub struct Cmd {
    pub topic: String,
    pub payload: Vec<u8>,
    pub qos: u8,
    pub retain: bool,
}

impl Cmd {
    pub fn parse(s: &str) -> Option<Cmd> {
        let mut it = s.splitn(3, ',');
        let (qos, retain) = match it.next()?.trim() {
            "pub" => (0, false),
            "pub1" => (1, false),
            "retain" => (0, true),
            _ => return None,
        };
        let topic = it.next()?.trim().to_string();
        let payload = it.next().unwrap_or("").as_bytes().to_vec();
        valid_topic(&topic).then_some(Cmd {
            topic,
            payload,
            qos,
            retain,
        })
    }
}

fn show(p: &[u8]) -> String {
    let s = String::from_utf8_lossy(&p[..p.len().min(60)]).replace(['\r', '\n'], " ");
    if p.len() > 60 {
        format!("{s}…")
    } else {
        s
    }
}

impl Broker {
    fn note(&mut self, now: u64, out: &mut Vec<Out>, line: String) {
        self.log.push((now, line.clone()));
        out.push(Out::Log(format!("[mqtt] {line}")));
    }

    fn name(&self, key: &Key) -> String {
        self.sessions
            .get(key)
            .and_then(|s| s.client.clone())
            .unwrap_or_else(|| format!(":{}", key.1))
    }

    /// TCP connection accepted on port 1883
    pub fn open(&mut self, key: Key, now: u64) {
        self.sessions.insert(
            key,
            Session {
                last_us: now,
                ..Default::default()
            },
        );
    }

    /// TCP connection gone (FIN / RST) without DISCONNECT
    pub fn gone(&mut self, key: &Key, now: u64) -> Vec<Out> {
        let mut out = Vec::new();
        if self.sessions.contains_key(key) {
            let n = self.name(key);
            self.sessions.remove(key);
            self.note(now, &mut out, format!("{n} connection lost"));
        }
        out
    }

    fn drop_session(&mut self, key: Key, now: u64, why: &str, out: &mut Vec<Out>) {
        let n = self.name(&key);
        self.sessions.remove(&key);
        self.note(now, out, format!("{n} {why}"));
        out.push(Out::Status(key, "Closed".into()));
        out.push(Out::Close(key));
    }

    /// Bytes from the chip on a 1883 connection; packets may straddle segments
    pub fn feed(&mut self, key: Key, data: &[u8], now: u64) -> Vec<Out> {
        let mut out = Vec::new();
        let Some(s) = self.sessions.get_mut(&key) else {
            return out;
        };
        s.buf.extend_from_slice(data);
        while let Some(s) = self.sessions.get_mut(&key) {
            let buf = std::mem::take(&mut s.buf);
            let (first, body, used) = match split_packet(&buf) {
                Ok(Some((f, b, u))) => (f, b.to_vec(), u),
                Ok(None) => {
                    s.buf = buf;
                    break;
                }
                Err(Malformed) => {
                    self.drop_session(key, now, "malformed packet, closed", &mut out);
                    break;
                }
            };
            s.buf = buf[used..].to_vec();
            s.last_us = now;
            if let Err(why) = self.packet(key, first, &body, now, &mut out) {
                self.drop_session(key, now, &why, &mut out);
                break;
            }
        }
        out
    }

    fn packet(
        &mut self,
        key: Key,
        first: u8,
        body: &[u8],
        now: u64,
        out: &mut Vec<Out>,
    ) -> Result<(), String> {
        let (kind, flags) = (first >> 4, first & 0x0f);
        let connected = self.sessions.get(&key).is_some_and(|s| s.client.is_some());
        if kind != CONNECT && !connected {
            return Err("sent a packet before CONNECT, closed".into());
        }
        let mut r = Rd(body);
        let bad = || "malformed packet, closed".to_string();
        match kind {
            CONNECT if connected => return Err("sent a second CONNECT, closed".into()),
            CONNECT => {
                let proto = r.str().ok_or_else(bad)?;
                let level = r.u8().ok_or_else(bad)?;
                let cflags = r.u8().ok_or_else(bad)?;
                let keep = r.u16().ok_or_else(bad)?;
                if proto != "MQTT" || level != 4 {
                    out.push(Out::Send(key, connack(1)));
                    return Err(format!(
                        "CONNECT protocol {proto} level {level} refused (only 3.1.1)"
                    ));
                }
                let mut id = r.str().ok_or_else(bad)?;
                // Will topic / message, user name, password: parsed in flag order, not used
                if cflags & 0x04 != 0 {
                    r.bytes().ok_or_else(bad)?;
                    r.bytes().ok_or_else(bad)?;
                }
                if cflags & 0x80 != 0 {
                    r.bytes().ok_or_else(bad)?;
                }
                if cflags & 0x40 != 0 {
                    r.bytes().ok_or_else(bad)?;
                }
                if id.is_empty() {
                    self.auto_id += 1;
                    id = format!("auto-{}", self.auto_id);
                }
                // Same client id on another connection: the old one is taken over (spec 3.1.4)
                let old: Vec<Key> = self
                    .sessions
                    .iter()
                    .filter(|(k, s)| **k != key && s.client.as_deref() == Some(id.as_str()))
                    .map(|(k, _)| *k)
                    .collect();
                for k in old {
                    self.drop_session(k, now, "taken over by a new connection", out);
                }
                if let Some(s) = self.sessions.get_mut(&key) {
                    s.client = Some(id.clone());
                    s.keepalive_s = keep;
                }
                out.push(Out::Send(key, connack(0)));
                out.push(Out::Status(key, format!("Connected {id}")));
                self.note(
                    now,
                    out,
                    format!("CONNECT {id} keepalive {keep}s → CONNACK 0"),
                );
            }
            PUBLISH => {
                let qos = (flags >> 1) & 3;
                if qos > 1 {
                    return Err(format!("PUBLISH QoS {qos} not supported, closed"));
                }
                let topic = r.str().ok_or_else(bad)?;
                if !valid_topic(&topic) {
                    return Err(format!("PUBLISH to invalid topic {topic:?}, closed"));
                }
                let pid = if qos > 0 { r.u16().ok_or_else(bad)? } else { 0 };
                let payload = r.0.to_vec();
                if qos == 1 {
                    out.push(Out::Send(key, ack(PUBACK, pid)));
                }
                let from = self.name(&key);
                out.extend(self.route(&from, &topic, &payload, qos, flags & 1 != 0, now));
            }
            PUBACK => {}
            SUBSCRIBE | UNSUBSCRIBE if flags != 2 => {
                return Err("bad SUBSCRIBE flags, closed".into())
            }
            SUBSCRIBE => {
                let pid = r.u16().ok_or_else(bad)?;
                let mut codes = Vec::new();
                let mut granted = Vec::new();
                while !r.0.is_empty() {
                    let f = r.str().ok_or_else(bad)?;
                    let q = r.u8().ok_or_else(bad)?;
                    if q > 2 || !valid_filter(&f) {
                        codes.push(0x80);
                        continue;
                    }
                    // QoS 2 requests are granted QoS 1 (the spec lets the server downgrade)
                    let g = q.min(1);
                    codes.push(g);
                    granted.push((f, g));
                }
                if codes.is_empty() {
                    return Err("SUBSCRIBE without topics, closed".into());
                }
                let mut b = pid.to_be_bytes().to_vec();
                b.extend_from_slice(&codes);
                out.push(Out::Send(key, packet(SUBACK << 4, &b)));
                let n = self.name(&key);
                for (f, g) in &granted {
                    if let Some(s) = self.sessions.get_mut(&key) {
                        s.subs.insert(f.clone(), *g);
                    }
                    self.note(now, out, format!("SUBSCRIBE {n} {f} QoS {g}"));
                }
                // Retained messages matching the new filters go out with RETAIN set (spec 3.3.1.3)
                let hits: Vec<(String, Vec<u8>, u8)> = self
                    .retained
                    .iter()
                    .filter_map(|(t, (p, q))| {
                        let g = granted
                            .iter()
                            .filter(|(f, _)| topic_matches(f, t))
                            .map(|(_, g)| *g)
                            .max()?;
                        Some((t.clone(), p.clone(), g.min(*q)))
                    })
                    .collect();
                for (t, p, q) in hits {
                    let pid = self.pid(&key, q);
                    out.push(Out::Send(key, publish(&t, &p, q, pid, true)));
                    self.delivered += 1;
                    self.note(now, out, format!("retained {t} → {n}"));
                }
            }
            UNSUBSCRIBE => {
                let pid = r.u16().ok_or_else(bad)?;
                let n = self.name(&key);
                while !r.0.is_empty() {
                    let f = r.str().ok_or_else(bad)?;
                    if let Some(s) = self.sessions.get_mut(&key) {
                        s.subs.remove(&f);
                    }
                    self.note(now, out, format!("UNSUBSCRIBE {n} {f}"));
                }
                out.push(Out::Send(key, ack(UNSUBACK, pid)));
            }
            PINGREQ => out.push(Out::Send(key, packet(PINGRESP << 4, &[]))),
            DISCONNECT => {
                let n = self.name(&key);
                self.sessions.remove(&key);
                self.note(now, out, format!("DISCONNECT {n}"));
                out.push(Out::Status(key, "Closed".into()));
                out.push(Out::Close(key));
            }
            k => return Err(format!("unexpected packet type {k}, closed")),
        }
        Ok(())
    }

    /// Next packet id for a QoS 1 delivery (never 0); 0 for QoS 0
    fn pid(&mut self, key: &Key, qos: u8) -> u16 {
        let Some(s) = self.sessions.get_mut(key).filter(|_| qos > 0) else {
            return 0;
        };
        s.next_pid = s.next_pid.wrapping_add(1).max(1);
        s.next_pid
    }

    /// Deliver to every matching subscription (one copy per client at its highest granted QoS)
    fn route(
        &mut self,
        from: &str,
        topic: &str,
        payload: &[u8],
        qos: u8,
        retain: bool,
        now: u64,
    ) -> Vec<Out> {
        let mut out = Vec::new();
        self.published += 1;
        if retain {
            if payload.is_empty() {
                self.retained.remove(topic);
            } else {
                self.retained
                    .insert(topic.to_string(), (payload.to_vec(), qos));
            }
        }
        let targets: Vec<(Key, u8)> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.client.is_some())
            .filter_map(|(k, s)| {
                let g = s
                    .subs
                    .iter()
                    .filter(|(f, _)| topic_matches(f, topic))
                    .map(|(_, g)| *g)
                    .max()?;
                Some((*k, g.min(qos)))
            })
            .collect();
        for (k, q) in &targets {
            let pid = self.pid(k, *q);
            out.push(Out::Send(*k, publish(topic, payload, *q, pid, false)));
        }
        self.delivered += targets.len() as u64;
        let r = if retain { " retain" } else { "" };
        self.note(
            now,
            &mut out,
            format!(
                "PUBLISH {from} {topic} QoS {qos}{r} \"{}\" ({} bytes) → {} subscriber(s)",
                show(payload),
                payload.len(),
                targets.len()
            ),
        );
        out
    }

    /// Publish from the virtual cloud (script action mqtt=pub...)
    pub fn publish(&mut self, c: &Cmd, now: u64) -> Vec<Out> {
        self.route("cloud", &c.topic, &c.payload, c.qos, c.retain, now)
    }

    /// Keep alive (spec 3.1.2.10): no packet for 1.5 x the interval closes the connection
    pub fn poll(&mut self, now: u64) -> Vec<Out> {
        let mut out = Vec::new();
        let late: Vec<Key> = self
            .sessions
            .iter()
            .filter(|(_, s)| deadline(s).is_some_and(|d| d <= now))
            .map(|(k, _)| *k)
            .collect();
        for k in late {
            self.drop_session(k, now, "keepalive expired, closed", &mut out);
        }
        out
    }

    /// Earliest keepalive deadline (TSF us), None when no client has one
    pub fn next_timer(&self) -> Option<u64> {
        self.sessions.values().filter_map(deadline).min()
    }

    /// Connected clients
    pub fn clients(&self) -> usize {
        self.sessions
            .values()
            .filter(|s| s.client.is_some())
            .count()
    }

    /// One summary line for the CLI
    pub fn summary(&self) -> String {
        format!(
            "mqtt broker: {} client(s) connected, {} publish(es), {} deliveries, {} retained",
            self.clients(),
            self.published,
            self.delivered,
            self.retained.len()
        )
    }
}

fn deadline(s: &Session) -> Option<u64> {
    (s.client.is_some() && s.keepalive_s > 0).then(|| s.last_us + s.keepalive_s as u64 * 1_500_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    const K1: Key = ([192, 168, 4, 100], 50001, [192, 168, 4, 1], PORT);
    const K2: Key = ([192, 168, 4, 100], 50002, [192, 168, 4, 1], PORT);

    fn connect(id: &str, keep: u16) -> Vec<u8> {
        let mut b = Vec::new();
        put_str(&mut b, b"MQTT");
        b.extend_from_slice(&[4, 0x02]);
        b.extend_from_slice(&keep.to_be_bytes());
        put_str(&mut b, id.as_bytes());
        packet(CONNECT << 4, &b)
    }

    fn subscribe(pid: u16, f: &[(&str, u8)]) -> Vec<u8> {
        let mut b = pid.to_be_bytes().to_vec();
        for (t, q) in f {
            put_str(&mut b, t.as_bytes());
            b.push(*q);
        }
        packet((SUBSCRIBE << 4) | 2, &b)
    }

    fn sends(o: &[Out], k: Key) -> Vec<Vec<u8>> {
        o.iter()
            .filter_map(|x| match x {
                Out::Send(kk, b) if *kk == k => Some(b.clone()),
                _ => None,
            })
            .collect()
    }

    fn up(b: &mut Broker, k: Key, id: &str) {
        b.open(k, 0);
        let o = b.feed(k, &connect(id, 15), 0);
        assert_eq!(sends(&o, k), vec![vec![0x20, 2, 0, 0]]);
    }

    #[test]
    fn remaining_length() {
        for (n, enc) in [
            (0usize, vec![0x00]),
            (127, vec![0x7f]),
            (128, vec![0x80, 0x01]),
            (16_383, vec![0xff, 0x7f]),
            (16_384, vec![0x80, 0x80, 0x01]),
            (2_097_152, vec![0x80, 0x80, 0x80, 0x01]),
            (268_435_455, vec![0xff, 0xff, 0xff, 0x7f]),
        ] {
            let mut v = Vec::new();
            encode_len(n, &mut v);
            assert_eq!(v, enc, "{n}");
            assert_eq!(decode_len(&enc), Ok(Some((n, enc.len()))));
        }
        assert_eq!(decode_len(&[0x80, 0x80]), Ok(None));
        assert_eq!(decode_len(&[0x80, 0x80, 0x80, 0x80, 0x01]), Err(Malformed));
    }

    #[test]
    fn wildcards() {
        assert!(topic_matches(
            "sport/tennis/#",
            "sport/tennis/player1/ranking"
        ));
        assert!(topic_matches("sport/#", "sport"));
        assert!(topic_matches("#", "a/b"));
        assert!(topic_matches("sport/+/player1", "sport/tennis/player1"));
        assert!(!topic_matches("sport/+", "sport"));
        assert!(topic_matches("sport/+", "sport/"));
        assert!(!topic_matches("sensor/+/temp", "sensor/temp"));
        assert!(topic_matches("+/+", "/finance"));
        assert!(!topic_matches("#", "$SYS/x"));
        assert!(topic_matches("$SYS/#", "$SYS/x"));
        assert!(!topic_matches("a/b", "a/b/c"));
        assert!(valid_filter("a/+/#") && valid_filter("#") && valid_filter("+"));
        assert!(
            !valid_filter("a/#/b")
                && !valid_filter("a#")
                && !valid_filter("a+/b")
                && !valid_filter("")
        );
        assert!(!valid_topic("a/+") && valid_topic("a/b"));
    }

    #[test]
    fn connect_subscribe_publish_echo_split_segments() {
        let mut b = Broker::default();
        b.open(K1, 0);
        // CONNECT split across two segments, then SUBSCRIBE + PUBLISH in one
        let c = connect("tryboard-c3", 15);
        assert!(b.feed(K1, &c[..5], 0).is_empty());
        let o = b.feed(K1, &c[5..], 0);
        assert_eq!(sends(&o, K1), vec![vec![0x20, 2, 0, 0]]);
        let mut d = subscribe(7, &[("tryboard/#", 0), ("bad/#/x", 0)]);
        d.extend(publish("tryboard/hello", b"hello world", 0, 0, false));
        let o = b.feed(K1, &d, 1000);
        let s = sends(&o, K1);
        assert_eq!(s[0], vec![0x90, 4, 0, 7, 0, 0x80]);
        assert_eq!(s[1], publish("tryboard/hello", b"hello world", 0, 0, false));
        assert_eq!(b.published, 1);
        assert_eq!(b.delivered, 1);
    }

    #[test]
    fn qos1_puback_and_downgrade() {
        let mut b = Broker::default();
        up(&mut b, K1, "a");
        up(&mut b, K2, "b");
        b.feed(K1, &subscribe(1, &[("t/+", 1)]), 0);
        b.feed(K2, &subscribe(1, &[("t/x", 0)]), 0);
        let o = b.feed(K2, &publish("t/x", b"v", 1, 0x1234, false), 0);
        // Publisher gets PUBACK with its id; QoS 1 subscriber gets QoS 1 with a broker id, QoS 0 one gets QoS 0
        assert_eq!(
            sends(&o, K2),
            vec![vec![0x40, 2, 0x12, 0x34], publish("t/x", b"v", 0, 0, false)]
        );
        assert_eq!(sends(&o, K1), vec![publish("t/x", b"v", 1, 1, false)]);
        // Client PUBACK is consumed quietly; QoS 2 publishes close the connection
        assert!(sends(&b.feed(K1, &[0x40, 2, 0, 1], 0), K1).is_empty());
        let o = b.feed(K1, &publish("t/x", b"v", 2, 5, false), 0);
        assert!(o.contains(&Out::Close(K1)));
    }

    #[test]
    fn unsubscribe_ping_disconnect() {
        let mut b = Broker::default();
        up(&mut b, K1, "a");
        b.feed(K1, &subscribe(2, &[("x", 0)]), 0);
        let mut u = 3u16.to_be_bytes().to_vec();
        put_str(&mut u, b"x");
        let o = b.feed(K1, &packet((UNSUBSCRIBE << 4) | 2, &u), 0);
        assert_eq!(sends(&o, K1), vec![vec![0xb0, 2, 0, 3]]);
        let o = b.feed(K1, &publish("x", b"1", 0, 0, false), 0);
        assert!(sends(&o, K1).is_empty());
        assert_eq!(sends(&b.feed(K1, &[0xc0, 0], 0), K1), vec![vec![0xd0, 0]]);
        let o = b.feed(K1, &[0xe0, 0], 0);
        assert!(o.contains(&Out::Close(K1)));
        assert_eq!(b.clients(), 0);
    }

    #[test]
    fn protocol_errors_close() {
        let mut b = Broker::default();
        b.open(K1, 0);
        // Anything before CONNECT
        assert!(b.feed(K1, &[0xc0, 0], 0).contains(&Out::Close(K1)));
        // Wrong protocol level: CONNACK 1 then close
        b.open(K1, 0);
        let mut c = connect("a", 0);
        c[8] = 3;
        let o = b.feed(K1, &c, 0);
        assert_eq!(sends(&o, K1), vec![vec![0x20, 2, 0, 1]]);
        assert!(o.contains(&Out::Close(K1)));
        // Second CONNECT
        up(&mut b, K1, "a");
        assert!(b.feed(K1, &connect("a", 0), 0).contains(&Out::Close(K1)));
    }

    #[test]
    fn retained_and_cloud_publish() {
        let mut b = Broker::default();
        up(&mut b, K1, "a");
        b.publish(&Cmd::parse("retain,home/temp,21.5").unwrap(), 0);
        let o = b.feed(K1, &subscribe(1, &[("home/+", 0)]), 0);
        assert_eq!(sends(&o, K1)[1], publish("home/temp", b"21.5", 0, 0, true));
        let o = b.publish(&Cmd::parse("pub,home/door,open, closed").unwrap(), 5);
        assert_eq!(
            sends(&o, K1),
            vec![publish("home/door", b"open, closed", 0, 0, false)]
        );
        // Empty retained payload clears it
        b.publish(&Cmd::parse("retain,home/temp,").unwrap(), 6);
        assert!(b.retained.is_empty());
        assert_eq!(Cmd::parse("pub,a/+,x"), None);
        assert_eq!(Cmd::parse("nope,a,x"), None);
        assert_eq!(Cmd::parse("pub1,a,x").unwrap().qos, 1);
    }

    #[test]
    fn keepalive() {
        let mut b = Broker::default();
        up(&mut b, K1, "a");
        assert_eq!(b.next_timer(), Some(22_500_000));
        assert!(b.poll(22_000_000).is_empty());
        // PINGREQ resets the clock
        b.feed(K1, &[0xc0, 0], 20_000_000);
        assert_eq!(b.next_timer(), Some(42_500_000));
        assert!(b.poll(42_000_000).is_empty());
        let o = b.poll(42_500_000);
        assert!(o.contains(&Out::Close(K1)));
        assert_eq!(b.next_timer(), None);
        // Keepalive 0 never expires
        b.open(K2, 0);
        b.feed(K2, &connect("z", 0), 0);
        assert_eq!(b.next_timer(), None);
    }

    #[test]
    fn same_client_id_takes_over() {
        let mut b = Broker::default();
        up(&mut b, K1, "dev");
        b.open(K2, 0);
        let o = b.feed(K2, &connect("dev", 15), 0);
        assert!(o.contains(&Out::Close(K1)));
        assert_eq!(b.clients(), 1);
    }
}
