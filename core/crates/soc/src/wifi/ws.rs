//! WebSocket server side (RFC 6455) for the virtual internet (F-09a-1): 101 handshake, frame codec, fragmentation, ping / close.
//! Written from the RFC; tcp.rs owns the TCP connection and routes `Upgrade: websocket` requests here.

use super::crypto::sha1;
use super::tcp::b64_encode;

pub const OP_CONT: u8 = 0x0;
pub const OP_TEXT: u8 = 0x1;
pub const OP_BINARY: u8 = 0x2;
pub const OP_CLOSE: u8 = 0x8;
pub const OP_PING: u8 = 0x9;
pub const OP_PONG: u8 = 0xA;

/// Largest reassembled message accepted from the chip (anything larger closes with 1009)
pub const MAX_MSG: usize = 1 << 20;

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Sec-WebSocket-Accept for a client key
pub fn accept_key(key: &str) -> String {
    let mut d = key.trim().as_bytes().to_vec();
    d.extend_from_slice(GUID.as_bytes());
    b64_encode(&sha1(&d))
}

/// One request header (case-insensitive name)
fn header<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.split("\r\n").skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

/// A parsed upgrade request: path and the Sec-WebSocket-Key
pub struct Upgrade {
    pub path: String,
    pub key: String,
    /// Request head (request line + headers), kept for the app (Authorization, Device-Id...)
    pub head: String,
}

/// Is this request head a WebSocket upgrade (GET + Upgrade: websocket + a key)?
pub fn parse_upgrade(head: &str) -> Option<Upgrade> {
    let first = head.lines().next()?;
    let mut parts = first.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let path = parts.next()?.to_string();
    if !header(head, "upgrade")?.eq_ignore_ascii_case("websocket") {
        return None;
    }
    let key = header(head, "sec-websocket-key")?.to_string();
    Some(Upgrade {
        path,
        key,
        head: head.to_string(),
    })
}

/// 101 Switching Protocols reply
pub fn handshake_response(u: &Upgrade) -> Vec<u8> {
    format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        accept_key(&u.key)
    )
    .into_bytes()
}

/// Encode one frame; the server never masks (mask is for tests that play the client)
pub fn encode(op: u8, fin: bool, payload: &[u8], mask: Option<[u8; 4]>) -> Vec<u8> {
    let mut f = Vec::with_capacity(payload.len() + 14);
    f.push(if fin { 0x80 } else { 0 } | (op & 0x0F));
    let m = if mask.is_some() { 0x80 } else { 0 };
    match payload.len() {
        n if n < 126 => f.push(m | n as u8),
        n if n <= 0xFFFF => {
            f.push(m | 126);
            f.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            f.push(m | 127);
            f.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    match mask {
        Some(k) => {
            f.extend_from_slice(&k);
            f.extend(payload.iter().enumerate().map(|(i, b)| b ^ k[i & 3]));
        }
        None => f.extend_from_slice(payload),
    }
    f
}

/// Close frame payload: 2-byte code + reason
pub fn close_payload(code: u16, reason: &str) -> Vec<u8> {
    let mut p = code.to_be_bytes().to_vec();
    p.extend_from_slice(reason.as_bytes());
    p
}

/// What the decoder hands up
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// A whole (reassembled) text or binary message
    Message {
        op: u8,
        data: Vec<u8>,
    },
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    /// Peer close: code (1005 when absent) + reason
    Close {
        code: u16,
        reason: String,
    },
    /// Protocol violation: we close with this code (1002 protocol error, 1007 bad UTF-8, 1009 too big)
    Error(u16),
}

/// Incremental decoder for chip -> server frames (they must be masked)
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
    /// Message being reassembled from fragments: (opcode, bytes so far)
    frag: Option<(u8, Vec<u8>)>,
    /// After an error or close, ignore everything else
    done: bool,
}

impl Decoder {
    pub fn feed(&mut self, data: &[u8]) -> Vec<Event> {
        let mut out = Vec::new();
        if self.done {
            return out;
        }
        self.buf.extend_from_slice(data);
        loop {
            match self.frame() {
                None => break,
                Some(Err(code)) => {
                    out.push(Event::Error(code));
                    self.done = true;
                    break;
                }
                Some(Ok(Some(e))) => {
                    let stop = matches!(e, Event::Close { .. } | Event::Error(_));
                    out.push(e);
                    if stop {
                        self.done = true;
                        break;
                    }
                }
                Some(Ok(None)) => {}
            }
        }
        out
    }

    /// Bytes buffered but not yet a whole frame (tests, diagnostics)
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// Take one whole frame off the buffer: None = need more bytes, Ok(None) = a non-final fragment
    fn frame(&mut self) -> Option<Result<Option<Event>, u16>> {
        let b = &self.buf;
        if b.len() < 2 {
            return None;
        }
        let (fin, rsv, op) = (b[0] & 0x80 != 0, b[0] & 0x70, b[0] & 0x0F);
        let masked = b[1] & 0x80 != 0;
        let (len, mut at) = match b[1] & 0x7F {
            126 if b.len() >= 4 => (u16::from_be_bytes([b[2], b[3]]) as u64, 4),
            127 if b.len() >= 10 => (u64::from_be_bytes(b[2..10].try_into().unwrap()), 10),
            126 | 127 => return None,
            n => (n as u64, 2),
        };
        // RFC 6455 5.1: client frames must be masked; no extensions negotiated, so RSV must be 0
        if !masked || rsv != 0 {
            return Some(Err(1002));
        }
        if len > MAX_MSG as u64 {
            return Some(Err(1009));
        }
        if b.len() < at + 4 + len as usize {
            return None;
        }
        let key = [b[at], b[at + 1], b[at + 2], b[at + 3]];
        at += 4;
        let payload: Vec<u8> = b[at..at + len as usize]
            .iter()
            .enumerate()
            .map(|(i, x)| x ^ key[i & 3])
            .collect();
        self.buf.drain(..at + len as usize);
        Some(self.handle(fin, op, payload))
    }

    fn handle(&mut self, fin: bool, op: u8, p: Vec<u8>) -> Result<Option<Event>, u16> {
        match op {
            OP_CLOSE | OP_PING | OP_PONG => {
                // Control frames: not fragmented, payload <= 125 (5.5)
                if !fin || p.len() > 125 {
                    return Err(1002);
                }
                Ok(Some(match op {
                    OP_PING => Event::Ping(p),
                    OP_PONG => Event::Pong(p),
                    _ => {
                        if p.len() == 1 {
                            return Err(1002);
                        }
                        let code = if p.len() >= 2 {
                            u16::from_be_bytes([p[0], p[1]])
                        } else {
                            1005
                        };
                        let reason =
                            String::from_utf8_lossy(p.get(2..).unwrap_or(&[])).into_owned();
                        Event::Close { code, reason }
                    }
                }))
            }
            OP_TEXT | OP_BINARY => {
                if self.frag.is_some() {
                    return Err(1002);
                }
                if fin {
                    return finish(op, p).map(Some);
                }
                self.frag = Some((op, p));
                Ok(None)
            }
            OP_CONT => {
                let Some((first, mut acc)) = self.frag.take() else {
                    return Err(1002);
                };
                if acc.len() + p.len() > MAX_MSG {
                    return Err(1009);
                }
                acc.extend_from_slice(&p);
                if fin {
                    return finish(first, acc).map(Some);
                }
                self.frag = Some((first, acc));
                Ok(None)
            }
            _ => Err(1002),
        }
    }
}

fn finish(op: u8, data: Vec<u8>) -> Result<Event, u16> {
    if op == OP_TEXT && std::str::from_utf8(&data).is_err() {
        return Err(1007);
    }
    Ok(Event::Message { op, data })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_key_rfc_example() {
        // RFC 6455 section 1.3
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn upgrade_parse() {
        let h = "GET /xz/v1/ HTTP/1.1\r\nHost: tryboard.local\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13";
        let u = parse_upgrade(h).unwrap();
        assert_eq!(u.path, "/xz/v1/");
        let r = String::from_utf8(handshake_response(&u)).unwrap();
        assert!(r.starts_with("HTTP/1.1 101 Switching Protocols\r\n"));
        assert!(r.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"));
        assert!(parse_upgrade("GET / HTTP/1.1\r\nHost: x").is_none());
        assert!(parse_upgrade(&h.replace("GET", "POST")).is_none());
    }

    #[test]
    fn masked_text_rfc_example() {
        // RFC 6455 5.7: masked "Hello"
        let f = [
            0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58,
        ];
        assert_eq!(
            encode(OP_TEXT, true, b"Hello", Some([0x37, 0xfa, 0x21, 0x3d])),
            f
        );
        let mut d = Decoder::default();
        // Byte at a time: nothing until the frame is whole
        for b in &f[..f.len() - 1] {
            assert!(d.feed(&[*b]).is_empty());
        }
        assert_eq!(
            d.feed(&f[f.len() - 1..]),
            vec![Event::Message {
                op: OP_TEXT,
                data: b"Hello".to_vec()
            }]
        );
        assert_eq!(d.buffered(), 0);
        // Server frames are unmasked
        assert_eq!(
            encode(OP_TEXT, true, b"Hello", None),
            [0x81, 0x05, b'H', b'e', b'l', b'l', b'o']
        );
    }

    #[test]
    fn unmasked_client_frame_is_error() {
        let mut d = Decoder::default();
        assert_eq!(
            d.feed(&encode(OP_TEXT, true, b"x", None)),
            vec![Event::Error(1002)]
        );
        // Decoder stays closed afterwards
        assert!(d
            .feed(&encode(OP_TEXT, true, b"x", Some([1, 2, 3, 4])))
            .is_empty());
    }

    #[test]
    fn fragments_with_interleaved_ping() {
        let k = Some([9, 8, 7, 6]);
        let mut s = encode(OP_BINARY, false, &[1, 2], k);
        s.extend(encode(OP_PING, true, b"p", k));
        s.extend(encode(OP_CONT, false, &[3], k));
        s.extend(encode(OP_CONT, true, &[4, 5], k));
        let mut d = Decoder::default();
        assert_eq!(
            d.feed(&s),
            vec![
                Event::Ping(b"p".to_vec()),
                Event::Message {
                    op: OP_BINARY,
                    data: vec![1, 2, 3, 4, 5]
                }
            ]
        );
        // Continuation without a start, or a new message mid-fragment, is a protocol error
        assert_eq!(
            Decoder::default().feed(&encode(OP_CONT, true, b"x", k)),
            vec![Event::Error(1002)]
        );
        let mut d = Decoder::default();
        let mut s = encode(OP_TEXT, false, b"a", k);
        s.extend(encode(OP_TEXT, true, b"b", k));
        assert_eq!(d.feed(&s), vec![Event::Error(1002)]);
    }

    #[test]
    fn long_lengths_and_close() {
        let k = Some([0xAA, 0x55, 0x01, 0xFE]);
        for n in [125usize, 126, 65535, 65536] {
            let p: Vec<u8> = (0..n).map(|i| i as u8).collect();
            let f = encode(OP_BINARY, true, &p, k);
            assert_eq!(
                f.len(),
                n + 4
                    + if n < 126 {
                        2
                    } else if n <= 0xFFFF {
                        4
                    } else {
                        10
                    }
            );
            let mut d = Decoder::default();
            assert_eq!(
                d.feed(&f),
                vec![Event::Message {
                    op: OP_BINARY,
                    data: p
                }]
            );
        }
        let mut d = Decoder::default();
        let mut s = encode(OP_CLOSE, true, &close_payload(1000, "bye"), k);
        s.extend(encode(OP_TEXT, true, b"after", k));
        assert_eq!(
            d.feed(&s),
            vec![Event::Close {
                code: 1000,
                reason: "bye".into()
            }]
        );
        assert_eq!(
            Decoder::default().feed(&encode(OP_CLOSE, true, &[], k)),
            vec![Event::Close {
                code: 1005,
                reason: String::new()
            }]
        );
        // Bad UTF-8 text, oversized control frame
        assert_eq!(
            Decoder::default().feed(&encode(OP_TEXT, true, &[0xFF], k)),
            vec![Event::Error(1007)]
        );
        assert_eq!(
            Decoder::default().feed(&encode(OP_PING, true, &[0; 126], k)),
            vec![Event::Error(1002)]
        );
    }
}
