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

// ---------- C-02 虚拟手机：用虚拟世界的 AP 当"固件热点"，手机当终端，方向与芯片 STA 相反 ----------

use super::phone::{Cmd, Link, Phone};
use super::world::World;

/// 在手机与世界之间来回传帧，直到到时；信标每 102.4ms 一次
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
            assert!(guard < 200, "帧来回不停");
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
    // 还没听到信标：停在扫描
    assert_eq!(p.link, Link::Scan);
    shuttle(&mut p, &mut w, 0, 0, 300_000);
    assert_eq!(p.link, Link::Up);
    assert_eq!(p.ip, Some([192, 168, 4, 2]));
    assert_eq!(p.gw, [192, 168, 4, 1]);
    // 拿到地址后第一件事是联网探测：DNS 查探测域名（虚拟网络的 DNS 答网关地址）
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
    // 四次握手由 AP（认证方）发起、手机（请求方）应答，双方装上同一把 TK，DHCP 走加密数据帧
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

// ---------- C-03 真实网络 ----------

/// 网络回给芯片的帧：(帧, 附带的说明)
type Frames = Vec<(Vec<u8>, Option<String>)>;

/// 芯片侧打开一条 TCP 连接、发出请求；返回 (SYN-ACK 里的服务端 ISN, 请求段的回应)
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
    // tryboard.local 照旧由虚拟服务器回答
    let (_, r) = tcp_request(
        &mut n,
        1000,
        80,
        b"GET /hello.txt HTTP/1.1\r\nHost: tryboard.local\r\n\r\n",
    );
    assert!(String::from_utf8_lossy(&r[0].0[20..]).contains("TRYBOARD_HTTP_OK"));
    // 其它域名进发件箱，只回 ACK，等回复
    let (_, r) = tcp_request(
        &mut n,
        1001,
        80,
        b"GET /get HTTP/1.1\r\nHost: httpbin.org\r\n\r\n",
    );
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].0.len(), 20, "只有 ACK，没有数据");
    let out = std::mem::take(&mut n.tcp.outbox);
    assert_eq!(out.len(), 1);
    assert_eq!(
        (out[0].id, out[0].method.as_str(), out[0].url.as_str()),
        (1, "GET", "http://httpbin.org/get")
    );
    assert_eq!(n.tcp.rows.last().unwrap().status, "等待");
    // 回复：内容由 netreply 参数唯一决定
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
    // 迟到 / 重复的回复不再生效
    n.pending.clear();
    n.real_reply(1, 200, "text/plain", b"x", 6000);
    assert!(n.pending.is_empty());
    // 浏览器拿不到回复：芯片收到 502 + 原因
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
    // base64 往返
    for d in [&b""[..], b"a", b"ab", b"abc", b"abcd"] {
        assert_eq!(b64_decode(&b64_encode(d)).unwrap(), d);
    }
}

#[test]
fn realnet_post_waits_for_body_and_https_is_refused() {
    let mut n = Net::default();
    n.tcp.realnet = true;
    // 头部到了、正文还没到：不进发件箱
    let (_, _) = tcp_request(&mut n, 2000, 80, b"POST /post HTTP/1.1\r\nHost: httpbin.org\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nab");
    assert!(n.tcp.outbox.is_empty());
    let (_, _) = tcp_request(
        &mut n,
        2001,
        80,
        b"POST /post HTTP/1.1\r\nHost: httpbin.org\r\nContent-Length: 5\r\n\r\nhello",
    );
    assert_eq!(n.tcp.outbox[0].body, b"hello");
    // HTTPS：照旧在 SYN 就拒绝，开着真实网络时说明只放行 HTTP
    let (_, r) = tcp_request(&mut n, 2002, 443, b"");
    assert_eq!(r[0].0[13] & 0x04, 0x04);
    let row = n.tcp.rows.last().unwrap();
    assert_eq!((row.method.as_str(), row.dest), ("HTTPS", "未放行"));
    assert!(row.note.contains("HTTPS 未放行"));
}
