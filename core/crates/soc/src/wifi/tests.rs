use super::frame;
use super::net::{self, Eth, Net};

#[test]
fn crc32_known_value() {
    assert_eq!(frame::crc32(b"123456789"), 0xcbf4_3926);
}

#[test]
fn ip_checksum_valid() {
    let p = net::ipv4([192, 168, 4, 1], [192, 168, 4, 100], 17, &[1, 2, 3], 7);
    assert_eq!(net::checksum(&p[..20], 0), 0);
}

fn dhcp_msg(kind: u8) -> Vec<u8> {
    let mut d = vec![0u8; 240];
    d[0] = 1;
    d[4..8].copy_from_slice(&[1, 2, 3, 4]);
    d[28..34].copy_from_slice(&[2, 0x54, 0x42, 0, 0, 1]);
    d[236..240].copy_from_slice(&[0x63, 0x82, 0x53, 0x63]);
    d.extend_from_slice(&[53, 1, kind, 255]);
    let u = net::udp([0; 4], [255; 4], 68, 67, &d);
    net::ipv4([0; 4], [255; 4], 17, &u, 1)
}

#[test]
fn dhcp_offer_then_ack() {
    let mut n = Net::default();
    let mac = [2, 0x54, 0x42, 0, 0, 1];
    for (kind, want) in [(1u8, 2u8), (3, 5)] {
        let e = Eth {
            dst: [0xff; 6],
            src: mac,
            ethertype: net::ETH_IP,
            payload: dhcp_msg(kind),
        };
        let r = n.on_eth(&e, 0);
        assert_eq!(r.len(), 1);
        let ip = &r[0].payload;
        let bootp = &ip[28..];
        assert_eq!(&bootp[4..8], &[1, 2, 3, 4], "xid echoed back");
        assert_eq!(&bootp[16..20], &net::STA_IP);
        assert_eq!(&bootp[240..243], &[53, 1, want]);
    }
    assert!(n.leased);
}

#[test]
fn dns_answers_gateway() {
    let mut n = Net::default();
    let mut q = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
    for part in ["tryboard", "local"] {
        q.push(part.len() as u8);
        q.extend_from_slice(part.as_bytes());
    }
    q.extend_from_slice(&[0, 0, 1, 0, 1]);
    let (r, _) = n.tcp.dns(&q, net::GW_IP).unwrap();
    assert_eq!(&r[..2], &[0x12, 0x34]);
    assert_eq!(r[7], 1);
    assert_eq!(&r[r.len() - 4..], &net::GW_IP);
}

#[test]
fn http_over_tcp() {
    let mut n = Net::default();
    let (c, s) = (net::STA_IP, net::GW_IP);
    let syn = {
        let mut t = vec![
            0x30, 0x39, 0, 80, 0, 0, 0, 100, 0, 0, 0, 0, 0x50, 0x02, 0x20, 0, 0, 0, 0, 0,
        ];
        let ck = net::l4_checksum(c, s, 6, &t);
        t[16..18].copy_from_slice(&ck.to_be_bytes());
        t
    };
    let r = n.tcp.on_segment(c, s, &syn, 0);
    assert_eq!(r.len(), 1);
    let synack = &r[0].0;
    assert_eq!(synack[13], 0x12);
    let isn = u32::from_be_bytes([synack[4], synack[5], synack[6], synack[7]]);
    let req = b"GET /hello.txt HTTP/1.1\r\nHost: tryboard.local\r\n\r\n";
    let mut t = vec![0x30, 0x39, 0, 80];
    t.extend_from_slice(&101u32.to_be_bytes());
    t.extend_from_slice(&(isn + 1).to_be_bytes());
    t.extend_from_slice(&[0x50, 0x18, 0x20, 0, 0, 0, 0, 0]);
    t.extend_from_slice(req);
    let r = n.tcp.on_segment(c, s, &t, 0);
    let resp: Vec<u8> = r.iter().flat_map(|(seg, _)| seg[20..].to_vec()).collect();
    let text = String::from_utf8_lossy(&resp);
    assert!(text.starts_with("HTTP/1.1 200 OK"));
    assert!(text.contains("TRYBOARD_HTTP_OK"));
    assert_eq!(
        r.last().unwrap().0[13] & 0x01,
        0x01,
        "last segment carries FIN"
    );
}

// ---------- C-02 virtual phone: the virtual world AP plays the "firmware hotspot", phone is the station (reverse of chip STA) ----------

use super::phone::{Cmd, Link, Phone};
use super::world::World;

/// Shuttle frames between phone and world until the deadline; a beacon every 102.4 ms
fn shuttle(p: &mut Phone, w: &mut World, ap: usize, mut t: u64, until: u64) -> u64 {
    let mut next_beacon = t;
    while t < until {
        if t >= next_beacon {
            let b = w.beacon(ap, t);
            p.on_frame(&b.frame, t);
            next_beacon += 102_400;
        }
        if p.next_timer().is_some_and(|x| x <= t) {
            p.poll(t);
        }
        let mut q: Vec<Vec<u8>> = p.take_out().into_iter().map(|a| a.frame).collect();
        let mut guard = 0;
        while !q.is_empty() {
            let f = q.remove(0);
            guard += 1;
            assert!(guard < 200, "frames ping-pong forever");
            let (_, airs, _) = w.on_tx(&f, t);
            for a in airs {
                p.on_frame(&a.frame, t);
                q.extend(p.take_out().into_iter().map(|a| a.frame));
            }
        }
        if w.next_timer().is_some_and(|x| x <= t) {
            for a in w.poll(t).0 {
                p.on_frame(&a.frame, t);
            }
        }
        t += 1000;
    }
    t
}

#[test]
fn phone_joins_open_ap_and_gets_dhcp() {
    let mut w = World::default();
    w.net.sta_ip = [192, 168, 4, 2];
    let mut p = Phone::new();
    p.command(
        Cmd::Join {
            ssid: "TryBoard-WiFi".into(),
            pass: String::new(),
        },
        0,
    );
    // No beacon heard yet: still scanning
    assert_eq!(p.link, Link::Scan);
    shuttle(&mut p, &mut w, 0, 0, 300_000);
    assert_eq!(p.link, Link::Up);
    assert_eq!(p.ip, Some([192, 168, 4, 2]));
    assert_eq!(p.gw, [192, 168, 4, 1]);
    // First thing after getting an address is the connectivity check: DNS for the check host (virtual DNS answers the gateway)
    assert!(p
        .log
        .iter()
        .any(|l| l.1.contains("DNS connectivitycheck.gstatic.com")));
    assert!(p.json().contains("\"ip\":\"192.168.4.2\""));
}

#[test]
fn phone_is_supplicant_in_wpa2_handshake() {
    let mut w = World::default();
    let mut p = Phone::new();
    p.command(
        Cmd::Join {
            ssid: "TryBoard-WPA2".into(),
            pass: "tryboard123".into(),
        },
        0,
    );
    shuttle(&mut p, &mut w, 1, 0, 500_000);
    // AP (authenticator) starts the 4-way handshake, phone (supplicant) answers; both install the same TK, DHCP goes encrypted
    assert!(w.wpa[1].as_ref().unwrap().authorized());
    assert_eq!(p.link, Link::Up);
    assert_eq!(p.ip, Some(net::STA_IP));
}

#[test]
fn phone_wrong_wpa2_password_never_comes_up() {
    let mut w = World::default();
    let mut p = Phone::new();
    p.command(
        Cmd::Join {
            ssid: "TryBoard-WPA2".into(),
            pass: "wrongpass1".into(),
        },
        0,
    );
    shuttle(&mut p, &mut w, 1, 0, 8_000_000);
    assert!(!w.wpa[1].as_ref().unwrap().authorized());
    assert_ne!(p.link, Link::Up);
    assert!(p.ip.is_none());
}

#[test]
fn phone_cmd_parse() {
    assert_eq!(
        Cmd::parse("post,/save,ssid=MyHome&pass=1,2"),
        Some(Cmd::Post("/save".into(), "ssid=MyHome&pass=1,2".into()))
    );
    assert_eq!(
        Cmd::parse("join,TryBoard-Setup"),
        Some(Cmd::Join {
            ssid: "TryBoard-Setup".into(),
            pass: String::new()
        })
    );
    assert_eq!(Cmd::parse("on"), Some(Cmd::On));
    assert_eq!(Cmd::parse("dance"), None);
}

// ---------- C-03 real network ----------

/// Frames the network sends back to the chip: (frame, attached note)
type Frames = Vec<(Vec<u8>, Option<String>)>;

/// Chip opens a TCP connection and sends a request; returns (server ISN from SYN-ACK, response to the request segment)
fn tcp_request(n: &mut Net, sport: u16, dport: u16, req: &[u8]) -> (u32, Frames) {
    let (c, s) = (net::STA_IP, net::GW_IP);
    let mut syn = sport.to_be_bytes().to_vec();
    syn.extend_from_slice(&dport.to_be_bytes());
    syn.extend_from_slice(&[0, 0, 0, 100, 0, 0, 0, 0, 0x50, 0x02, 0x20, 0, 0, 0, 0, 0]);
    let r = n.tcp.on_segment(c, s, &syn, 0);
    let isn = u32::from_be_bytes([r[0].0[4], r[0].0[5], r[0].0[6], r[0].0[7]]);
    if r[0].0[13] & 0x04 != 0 {
        return (isn, r);
    }
    let mut t = sport.to_be_bytes().to_vec();
    t.extend_from_slice(&dport.to_be_bytes());
    t.extend_from_slice(&101u32.to_be_bytes());
    t.extend_from_slice(&(isn + 1).to_be_bytes());
    t.extend_from_slice(&[0x50, 0x18, 0x20, 0, 0, 0, 0, 0]);
    t.extend_from_slice(req);
    (isn, n.tcp.on_segment(c, s, &t, 1000))
}

#[test]
fn realnet_queues_and_replies() {
    use super::tcp::{b64_decode, b64_encode, parse_netreply};
    let mut n = Net::default();
    n.tcp.realnet = true;
    // tryboard.local is still answered by the virtual server
    let (_, r) = tcp_request(
        &mut n,
        1000,
        80,
        b"GET /hello.txt HTTP/1.1\r\nHost: tryboard.local\r\n\r\n",
    );
    assert!(String::from_utf8_lossy(&r[0].0[20..]).contains("TRYBOARD_HTTP_OK"));
    // Other hosts go to the outbox, only an ACK comes back while waiting
    let (_, r) = tcp_request(
        &mut n,
        1001,
        80,
        b"GET /get HTTP/1.1\r\nHost: httpbin.org\r\n\r\n",
    );
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].0.len(), 20, "ACK only, no data");
    let out = std::mem::take(&mut n.tcp.outbox);
    assert_eq!(out.len(), 1);
    assert_eq!(
        (out[0].id, out[0].method.as_str(), out[0].url.as_str()),
        (1, "GET", "http://httpbin.org/get")
    );
    assert_eq!(n.tcp.rows.last().unwrap().status, "Waiting");
    // Reply: content determined only by the netreply parameters
    let (id, st, info, body) = parse_netreply(&format!(
        "1,200,321,application/json,{}",
        b64_encode(b"{\"ok\":1}")
    ))
    .unwrap();
    n.real_reply(id, st, &info, &body, 5000);
    assert_eq!(n.pending.len(), 1);
    let ip = &n.pending[0].payload;
    let text = String::from_utf8_lossy(&ip[40..]);
    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"), "{text}");
    assert!(text.ends_with("{\"ok\":1}"));
    let row = n.tcp.rows.last().unwrap();
    assert_eq!((row.status.as_str(), row.dur_us), ("200", Some(5000)));
    // Late / duplicate replies no longer apply
    n.pending.clear();
    n.real_reply(1, 200, "text/plain", b"x", 6000);
    assert!(n.pending.is_empty());
    // Browser got no reply: chip receives 502 + reason
    let (_, _) = tcp_request(
        &mut n,
        1002,
        80,
        b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n",
    );
    n.real_reply(2, 0, "cors", &[], 7000);
    let text = String::from_utf8_lossy(&n.pending[0].payload[40..]).into_owned();
    assert!(text.starts_with("HTTP/1.1 502 Bad Gateway"));
    assert!(text.ends_with("TRYBOARD_REALNET_ERROR cors\n"));
    assert!(n.tcp.rows.last().unwrap().note.contains("CORS"));
    // base64 round trip
    for d in [&b""[..], b"a", b"ab", b"abc", b"abcd"] {
        assert_eq!(b64_decode(&b64_encode(d)).unwrap(), d);
    }
}

#[test]
fn realnet_post_waits_for_body_and_https_is_refused() {
    let mut n = Net::default();
    n.tcp.realnet = true;
    // Headers arrived, body not yet: not in the outbox
    let (_, _) = tcp_request(&mut n, 2000, 80, b"POST /post HTTP/1.1\r\nHost: httpbin.org\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nab");
    assert!(n.tcp.outbox.is_empty());
    let (_, _) = tcp_request(
        &mut n,
        2001,
        80,
        b"POST /post HTTP/1.1\r\nHost: httpbin.org\r\nContent-Length: 5\r\n\r\nhello",
    );
    assert_eq!(n.tcp.outbox[0].body, b"hello");
    // HTTPS: still refused at SYN; with the real network on, the note says only HTTP is allowed
    let (_, r) = tcp_request(&mut n, 2002, 443, b"");
    assert_eq!(r[0].0[13] & 0x04, 0x04);
    let row = n.tcp.rows.last().unwrap();
    assert_eq!((row.method.as_str(), row.dest), ("HTTPS", "Not allowed"));
    assert!(row.note.contains("HTTPS is not allowed"));
}

// ---------- D-01 network faults ----------

#[test]
fn dns_fault_answers_servfail() {
    let mut n = Net::default();
    let mut q = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
    q.extend_from_slice(b"\x03api\x07example\x00\x00\x01\x00\x01");
    n.tcp.dns_fail = true;
    let (r, _) = n.tcp.dns(&q, net::GW_IP).unwrap();
    assert_eq!(r[3] & 0x0f, 2, "rcode SERVFAIL");
    assert_eq!(&r[6..12], &[0; 6], "no answers");
    assert_eq!(n.tcp.rows.last().unwrap().status, "Failed");
}

#[test]
fn silent_server_drops_syn_and_lists_it_once() {
    let mut n = Net::default();
    n.tcp.silent = true;
    let (c, s) = (net::STA_IP, net::GW_IP);
    let syn = vec![
        0x30, 0x39, 0, 80, 0, 0, 0, 100, 0, 0, 0, 0, 0x50, 0x02, 0x20, 0, 0, 0, 0, 0,
    ];
    assert!(n.tcp.on_segment(c, s, &syn, 0).is_empty());
    assert!(n.tcp.on_segment(c, s, &syn, 1000).is_empty());
    assert_eq!(n.tcp.rows.len(), 1);
    assert_eq!(n.tcp.rows[0].status, "No reply");
    n.tcp.silent = false;
    let r = n.tcp.on_segment(c, s, &syn, 2000);
    assert_eq!(r[0].0[13], 0x12, "SYN-ACK after recovery");
}

// ---------- F-09a-1 long-lived TCP + WebSocket ----------

use super::tcp::{Key, WsIn, WS_ECHO_PATH};
use super::ws;

const WS_CONN: Key = (net::STA_IP, 0x3039, net::GW_IP, 80);

type Segs = Vec<(Vec<u8>, Option<String>)>;

/// Chip -> server segment (chip port 0x3039 -> gateway :80)
fn chip_seg(seq: u32, ack: u32, flags: u8, wnd: u16, data: &[u8]) -> Vec<u8> {
    let mut t = vec![0x30, 0x39, 0, 80];
    t.extend_from_slice(&seq.to_be_bytes());
    t.extend_from_slice(&ack.to_be_bytes());
    t.extend_from_slice(&[0x50, flags]);
    t.extend_from_slice(&wnd.to_be_bytes());
    t.extend_from_slice(&[0, 0, 0, 0]);
    t.extend_from_slice(data);
    t
}

/// The chip's side of one connection: next seq, server bytes received in order (acked up to `acked`)
struct WsPeer {
    seq: u32,
    acked: u32,
    rx: Vec<u8>,
}

impl WsPeer {
    /// SYN + upgrade request to `path`; returns the peer and the server's reply to the request
    fn open(n: &mut Net, path: &str, wnd: u16) -> (WsPeer, Segs) {
        let (c, s) = (net::STA_IP, net::GW_IP);
        let r = n.tcp.on_segment(c, s, &chip_seg(100, 0, 0x02, wnd, &[]), 0);
        let isn = u32::from_be_bytes([r[0].0[4], r[0].0[5], r[0].0[6], r[0].0[7]]);
        let req = format!("GET {path} HTTP/1.1\r\nHost: tryboard.local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer t0k\r\n\r\n");
        let mut p = WsPeer {
            seq: 101,
            acked: isn + 1,
            rx: vec![],
        };
        let out = p.send(n, 0x18, wnd, req.as_bytes());
        (p, out)
    }

    fn send(&mut self, n: &mut Net, flags: u8, wnd: u16, d: &[u8]) -> Segs {
        let t = chip_seg(self.seq, self.acked, flags, wnd, d);
        self.seq += d.len() as u32 + (flags & 0x01) as u32;
        let out = n.tcp.on_segment(net::STA_IP, net::GW_IP, &t, 1000);
        self.take(&out);
        out
    }

    fn take(&mut self, segs: &[(Vec<u8>, Option<String>)]) {
        for (sg, _) in segs {
            let sq = u32::from_be_bytes([sg[4], sg[5], sg[6], sg[7]]);
            assert_eq!(sq, self.acked, "server segments arrive in order");
            self.rx.extend_from_slice(&sg[20..]);
            self.acked += (sg.len() - 20) as u32 + (sg[13] & 0x01) as u32;
        }
    }
}

/// Server push results in the on_segment shape
fn segs(v: Vec<(Key, Vec<u8>, Option<String>)>) -> Segs {
    v.into_iter().map(|(_, s, l)| (s, l)).collect()
}

fn masked(op: u8, fin: bool, d: &[u8]) -> Vec<u8> {
    ws::encode(op, fin, d, Some([0x12, 0x34, 0x56, 0x78]))
}

#[test]
fn ws_echo_handshake_mask_fragments_ping() {
    let mut n = Net::default();
    let (mut p, out) = WsPeer::open(&mut n, WS_ECHO_PATH, 0x2000);
    let text = String::from_utf8_lossy(&p.rx).into_owned();
    assert!(text.starts_with("HTTP/1.1 101 Switching Protocols\r\n"));
    assert!(text.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"));
    assert_eq!(out.len(), 1, "101 carries the ACK, no separate pure ACK");
    assert_eq!(out[0].0[13] & 0x01, 0, "no FIN: the connection stays open");
    assert!(out[0].1.as_deref().unwrap().contains("WebSocket open"));
    assert_eq!(n.tcp.rows.last().unwrap().method, "WS");
    // Fragmented masked text with a ping in the middle: pong first, then the reassembled echo (unmasked)
    p.rx.clear();
    let mut s = masked(ws::OP_TEXT, false, "\u{4f60}\u{597d}".as_bytes());
    s.extend(masked(ws::OP_PING, true, b"hb"));
    s.extend(masked(ws::OP_CONT, true, b", ws"));
    p.send(&mut n, 0x18, 0x2000, &s);
    let mut want = ws::encode(ws::OP_PONG, true, b"hb", None);
    want.extend(ws::encode(
        ws::OP_TEXT,
        true,
        "\u{4f60}\u{597d}, ws".as_bytes(),
        None,
    ));
    assert_eq!(p.rx, want);
    assert!(
        n.tcp.ws_inbox.is_empty(),
        "echo route does not use the inbox"
    );
    // A frame split across two TCP segments: the first half only earns an ACK
    p.rx.clear();
    let f = masked(ws::OP_BINARY, true, &[7; 300]);
    let ack_only = p.send(&mut n, 0x18, 0x2000, &f[..5]);
    assert_eq!(ack_only.len(), 1);
    assert_eq!(ack_only[0].0.len(), 20);
    p.send(&mut n, 0x18, 0x2000, &f[5..]);
    assert_eq!(p.rx, ws::encode(ws::OP_BINARY, true, &[7; 300], None));
    assert_eq!(n.tcp.ws_conns(), vec![WS_CONN]);
}

#[test]
fn ws_unregistered_route_stays_http() {
    let mut n = Net::default();
    let (p, out) = WsPeer::open(&mut n, "/xz/v1/", 0x2000);
    assert!(String::from_utf8_lossy(&p.rx).starts_with("HTTP/1.1 404 Not Found"));
    assert_eq!(
        out.last().unwrap().0[13] & 0x01,
        0x01,
        "old one-shot path: FIN"
    );
    assert!(n.tcp.ws_inbox.is_empty());
}

#[test]
fn ws_app_inbox_push_and_window() {
    let mut n = Net::default();
    n.tcp.ws_routes.push("/xz/".into());
    let (mut p, _) = WsPeer::open(&mut n, "/xz/v1/", 1000);
    match &n.tcp.ws_inbox[0] {
        WsIn::Open { key, path, head } => {
            assert_eq!((*key, path.as_str()), (WS_CONN, "/xz/v1/"));
            assert!(head.contains("Authorization: Bearer t0k"));
        }
        e => panic!("{e:?}"),
    }
    let hello = br#"{"type":"hello"}"#;
    p.send(&mut n, 0x18, 1000, &masked(ws::OP_TEXT, true, hello));
    assert_eq!(
        n.tcp.ws_inbox[1],
        WsIn::Msg {
            key: WS_CONN,
            op: ws::OP_TEXT,
            data: hello.to_vec()
        }
    );
    // Chip window 1000 bytes: a 3000-byte push goes out only as far as the window allows
    p.rx.clear();
    let big: Vec<u8> = (0..3000).map(|i| i as u8).collect();
    p.take(&segs(n.tcp.ws_send(WS_CONN, ws::OP_BINARY, true, &big)));
    assert_eq!(p.rx.len(), 1000, "limited by the chip window");
    // Chip ACKs what it got, window reopens: the rest flows
    p.send(&mut n, 0x10, 1000, &[]);
    assert_eq!(p.rx.len(), 2000);
    p.send(&mut n, 0x10, 0xFFFF, &[]);
    assert_eq!(p.rx, ws::encode(ws::OP_BINARY, true, &big, None));
    // Server-initiated fragments
    p.rx.clear();
    p.take(&segs(n.tcp.ws_send(WS_CONN, ws::OP_TEXT, false, b"ab")));
    p.take(&segs(n.tcp.ws_send(WS_CONN, ws::OP_CONT, true, b"c")));
    let mut want = ws::encode(ws::OP_TEXT, false, b"ab", None);
    want.extend(ws::encode(ws::OP_CONT, true, b"c", None));
    assert_eq!(p.rx, want);
    // Through Net: pushes land in pending for World::poll
    n.ws_send(WS_CONN, ws::OP_TEXT, true, b"{\"type\":\"tts\"}");
    assert_eq!(n.pending.len(), 1);
}

#[test]
fn ws_half_close_drains_queue_then_fin() {
    let mut n = Net::default();
    n.tcp.ws_routes.push("/xz/".into());
    let (mut p, _) = WsPeer::open(&mut n, "/xz/", 0x2000);
    p.rx.clear();
    // Window shut: the push stays queued
    p.send(&mut n, 0x10, 0, &[]);
    assert!(n
        .tcp
        .ws_send(WS_CONN, ws::OP_BINARY, true, &[1; 100])
        .is_empty());
    // Chip half-closes: plain ACK, the app hears 1006, the connection stays for the queued bytes
    let out = p.send(&mut n, 0x11, 0, &[]);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].0[13], 0x10);
    assert_eq!(
        n.tcp.ws_inbox.last(),
        Some(&WsIn::Closed {
            key: WS_CONN,
            code: 1006
        })
    );
    assert!(
        n.tcp.ws_conns().is_empty(),
        "no new pushes after the chip's FIN"
    );
    // Window reopens: queued frame goes out with our FIN, then the connection is gone
    let out = p.send(&mut n, 0x10, 0x2000, &[]);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].0[13] & 0x01, 0x01);
    assert_eq!(p.rx, ws::encode(ws::OP_BINARY, true, &[1; 100], None));
    assert!(
        p.send(&mut n, 0x10, 0x2000, &[]).is_empty(),
        "connection gone"
    );
}

#[test]
fn ws_close_handshakes() {
    // Chip closes: server echoes the code and FINs; the chip's FIN ends it
    let mut n = Net::default();
    let (mut p, _) = WsPeer::open(&mut n, WS_ECHO_PATH, 0x2000);
    p.rx.clear();
    let bye = ws::close_payload(1000, "bye");
    let out = p.send(&mut n, 0x18, 0x2000, &masked(ws::OP_CLOSE, true, &bye));
    let want = ws::encode(ws::OP_CLOSE, true, &ws::close_payload(1000, ""), None);
    assert_eq!(p.rx, want);
    assert_eq!(out.last().unwrap().0[13] & 0x01, 0x01);
    assert_eq!(n.tcp.rows.last().unwrap().status, "Closed 1000");
    assert_eq!(
        p.send(&mut n, 0x11, 0x2000, &[]).len(),
        1,
        "ACK of the chip FIN"
    );
    assert!(n.tcp.ws_conns().is_empty());

    // Server closes first: close frame + FIN; the chip may still send until its own FIN
    let mut n = Net::default();
    n.tcp.ws_routes.push("/xz/".into());
    let (mut p, _) = WsPeer::open(&mut n, "/xz/", 0x2000);
    p.rx.clear();
    let out = segs(n.tcp.ws_close(WS_CONN, 4000, "reboot"));
    p.take(&out);
    let want = ws::encode(ws::OP_CLOSE, true, &ws::close_payload(4000, "reboot"), None);
    assert_eq!(p.rx, want);
    assert_eq!(out.last().unwrap().0[13] & 0x01, 0x01);
    assert!(
        n.tcp.ws_close(WS_CONN, 4000, "again").is_empty(),
        "close only once"
    );
    assert!(n.tcp.ws_send(WS_CONN, ws::OP_TEXT, true, b"x").is_empty());
    let reply = masked(ws::OP_CLOSE, true, &ws::close_payload(4000, ""));
    assert_eq!(
        p.send(&mut n, 0x18, 0x2000, &reply).len(),
        1,
        "chip data after our FIN is ACKed"
    );
    assert_eq!(p.send(&mut n, 0x11, 0x2000, &[]).len(), 1);
    assert!(
        p.send(&mut n, 0x10, 0x2000, &[]).is_empty(),
        "connection gone"
    );
    // Through Net: the close lands in pending
    let mut n = Net::default();
    let _ = WsPeer::open(&mut n, WS_ECHO_PATH, 0x2000);
    n.ws_close(WS_CONN, 1001, "");
    assert_eq!(n.pending.len(), 1);

    // Unmasked chip frame: protocol error, close 1002 + FIN
    let mut n = Net::default();
    let (mut p, _) = WsPeer::open(&mut n, WS_ECHO_PATH, 0x2000);
    p.rx.clear();
    p.send(
        &mut n,
        0x18,
        0x2000,
        &ws::encode(ws::OP_TEXT, true, b"x", None),
    );
    let want = ws::encode(ws::OP_CLOSE, true, &ws::close_payload(1002, ""), None);
    assert_eq!(p.rx, want);
}

/// TCP payloads of the frames World queued for the chip (IPv4 header 20 bytes, TCP header 20 bytes)
fn pending_segs(w: &mut World) -> Segs {
    std::mem::take(&mut w.net.pending)
        .into_iter()
        .map(|e| (e.payload[20..].to_vec(), None))
        .collect()
}

/// Split unmasked server frames (no fragments, length < 64 KiB): (opcode, payload)
fn server_msgs(b: &[u8]) -> Vec<(u8, Vec<u8>)> {
    let (mut v, mut i) = (Vec::new(), 0);
    while i + 2 <= b.len() {
        let (op, l7) = (b[i] & 0x0F, (b[i + 1] & 0x7F) as usize);
        let (len, h) = if l7 == 126 {
            (u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize, 4)
        } else {
            (l7, 2)
        };
        v.push((op, b[i + h..i + h + len].to_vec()));
        i += h + len;
    }
    v
}

#[test]
fn xiaozhi_through_world_inbox_and_timer() {
    use super::xiaozhi;
    let mut w = World::default();
    assert_eq!(w.next_timer(), None);
    w.enable_xz(xiaozhi::Server::default());
    w.enable_xz(xiaozhi::Server::default());
    assert_eq!(
        w.net.tcp.ws_routes,
        vec![xiaozhi::WS_PATH.to_string()],
        "idempotent"
    );
    // OTA endpoint answers with the WebSocket url
    let (c, s) = (net::STA_IP, net::GW_IP);
    let r = w
        .net
        .tcp
        .on_segment(c, s, &chip_seg(500, 0, 0x02, 0xFFFF, &[]), 0);
    let isn = u32::from_be_bytes([r[0].0[4], r[0].0[5], r[0].0[6], r[0].0[7]]);
    let req = b"POST /xiaozhi/ota/ HTTP/1.1\r\nHost: tryboard.local\r\nContent-Length: 2\r\n\r\n{}";
    let r = w
        .net
        .tcp
        .on_segment(c, s, &chip_seg(501, isn + 1, 0x18, 0xFFFF, req), 0);
    let body = String::from_utf8_lossy(&r[0].0[20..]).into_owned();
    assert!(body.starts_with("HTTP/1.1 200 OK"), "{body}");
    assert!(body.contains(xiaozhi::WS_URL));
    // WebSocket: the open sits in the inbox until World runs the server
    let (mut p, _) = WsPeer::open(&mut w.net, "/xiaozhi/v1/", 0xFFFF);
    assert_eq!(w.next_timer(), Some(0), "unread events wake the world");
    assert!(w.xz_step(1000)[0].starts_with("[xz] open /xiaozhi/v1/ (Authorization Bearer t0k"));
    assert_eq!(w.next_timer(), None);
    p.rx.clear();
    let hello = masked(ws::OP_TEXT, true, br#"{"type":"hello"}"#);
    p.send(&mut w.net, 0x18, 0xFFFF, &hello);
    let notes = w.xz_step(2000);
    assert!(notes
        .iter()
        .any(|n| n.contains("hello reply session tb-0001")));
    p.take(&pending_segs(&mut w));
    let ev = server_msgs(&std::mem::take(&mut p.rx));
    assert!(String::from_utf8_lossy(&ev[0].1).contains("\"session_id\":\"tb-0001\""));
    // A turn: frames go out one per 60 ms as the world is polled at next_timer()
    let start = br#"{"type":"listen","state":"start","mode":"manual"}"#;
    p.send(&mut w.net, 0x18, 0xFFFF, &masked(ws::OP_TEXT, true, start));
    for _ in 0..6 {
        let f = masked(ws::OP_BINARY, true, &[0x58, 0]);
        p.send(&mut w.net, 0x18, 0xFFFF, &f);
    }
    let stop = br#"{"type":"listen","state":"stop"}"#;
    p.send(&mut w.net, 0x18, 0xFFFF, &masked(ws::OP_TEXT, true, stop));
    w.xz_step(10_000);
    let mut times = Vec::new();
    while let Some(t) = w.next_timer() {
        w.xz_step(t);
        p.take(&pending_segs(&mut w));
        times.push(t);
        // The chip ACKs everything
        p.send(&mut w.net, 0x10, 0xFFFF, &[]);
    }
    let ev = server_msgs(&p.rx);
    let bins = ev.iter().filter(|e| e.0 == ws::OP_BINARY).count();
    assert_eq!(bins, 20);
    let t0 = 10_000 + xiaozhi::STT_DELAY_US + xiaozhi::TTS_DELAY_US;
    assert_eq!(times[0], 10_000 + xiaozhi::STT_DELAY_US);
    assert_eq!(times[1], t0);
    assert_eq!(times[2] - times[1], xiaozhi::FRAME_US);
    assert_eq!(*times.last().unwrap(), t0 + 20 * xiaozhi::FRAME_US);
    let last = String::from_utf8_lossy(&ev.last().unwrap().1).into_owned();
    assert!(last.contains("\"state\":\"stop\""), "{last}");
    w.disable_xz();
    assert!(w.net.tcp.ws_routes.is_empty() && w.xz.is_none());
    assert!(w.net.tcp.ws_conns().is_empty(), "open session closed");
}
