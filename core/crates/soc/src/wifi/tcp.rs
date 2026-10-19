//! 虚拟互联网的服务端：DNS（所有域名解析到网关）、TCP（只做被动打开）、HTTP/1.1（80 端口，Connection: close）。
//! 不做重传与拥塞控制：虚拟网络不丢包，按需一次性回完。

use super::net::l4_checksum;
use std::collections::HashMap;

const SYN: u8 = 0x02;
const ACK: u8 = 0x10;
const FIN: u8 = 0x01;
const RST: u8 = 0x04;
const PSH: u8 = 0x08;
const MSS: usize = 1400;

#[derive(Default)]
struct Conn {
    /// 下一个要发的序号、期望收到的序号
    snd_nxt: u32,
    rcv_nxt: u32,
    req: Vec<u8>,
    responded: bool,
    fin_sent: bool,
    /// 收到 SYN 的时刻（网络页签的「耗时」从这里算）
    t0: u64,
}

/// 网络页签的一行（C-02 / C-03）：芯片发出的一次 DNS 查询 / HTTP 请求 / 被拦下的连接
#[derive(Clone, Debug)]
pub struct NetRow {
    pub t_us: u64,
    /// DNS / GET / POST / HTTPS / MQTT / TCP
    pub method: String,
    /// 虚拟 / 真实 / 未放行
    pub dest: &'static str,
    pub url: String,
    pub status: String,
    pub dur_us: Option<u64>,
}

type Key = ([u8; 4], u16, [u8; 4], u16);

#[derive(Default)]
pub struct Tcp {
    conns: HashMap<Key, Conn>,
    ip_id: u16,
    isn: u32,
    /// 自定义页面：路径 → (内容类型, 内容)；网页 / 测试可以注入
    pub pages: HashMap<String, (String, Vec<u8>)>,
    pub requests: u64,
    /// 给网页「网络」页签的结构化记录（只给人看，不影响回给芯片的字节）
    pub rows: Vec<NetRow>,
    /// 当前模拟时刻（Net 收到每一帧时更新），DNS 行盖时间戳用
    pub now_us: u64,
}

/// 按端口猜协议名（被拦下的连接在网络页签里怎么称呼）
fn proto_name(port: u16) -> &'static str {
    match port {
        443 | 8443 => "HTTPS",
        1883 | 8883 => "MQTT",
        _ => "TCP",
    }
}

/// 一个 TCP 段的参数（服务端 → 芯片方向）
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

    /// DNS 查询 → 应答（A 记录指向网关）
    pub fn dns(&mut self, q: &[u8], gw: [u8; 4]) -> Option<(Vec<u8>, String)> {
        if q.len() < 12 || q[2] & 0x80 != 0 || u16::from_be_bytes([q[4], q[5]]) != 1 {
            return None;
        }
        // 解析问题里的域名
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
        r[2] = 0x81; // 应答、递归期望
        r[3] = 0x80; // 可递归、无错
        if qtype == 1 {
            r[7] = 1; // 1 条回答
            r.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0x0e, 0x10, 0, 4]);
            r.extend_from_slice(&gw);
        } else {
            r[7] = 0;
        }
        r[8..12].fill(0);
        let n = name.join(".");
        self.rows.push(NetRow {
            t_us: self.now_us,
            method: "DNS".into(),
            dest: "虚拟",
            url: n.clone(),
            status: "解析".into(),
            dur_us: None,
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
            dest: "虚拟",
            url: format!("http://{}{path}", if host.is_empty() { "?" } else { &host }),
            status: status.split(' ').next().unwrap_or("").to_string(),
            dur_us: Some(now.saturating_sub(t0)),
        });
        (
            r,
            format!(
                "HTTP {method} {host}{path} → {status}（{} 字节）",
                body.len()
            ),
        )
    }

    /// 收到芯片发来的 TCP 段；返回要回的段（和可选日志）
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
                // 只有 80 端口在听：其它端口回 RST
                let c = Conn {
                    snd_nxt: 0,
                    rcv_nxt: seq.wrapping_add(1),
                    ..Default::default()
                };
                out.push((
                    mk(&c, RST | ACK, &[], &[]),
                    Some(format!("TCP :{dport} 拒绝连接")),
                ));
                self.rows.push(NetRow {
                    t_us: now_us,
                    method: proto_name(dport).into(),
                    dest: "未放行",
                    url: format!("{}.{}.{}.{}:{dport}", dst[0], dst[1], dst[2], dst[3]),
                    status: "拦截".into(),
                    dur_us: None,
                });
                return out;
            }
            self.isn = self.isn.wrapping_add(0x0101_0101);
            let mut c = Conn {
                snd_nxt: self.isn,
                rcv_nxt: seq.wrapping_add(1),
                t0: now_us,
                ..Default::default()
            };
            out.push((
                mk(&c, SYN | ACK, &[2, 4, (MSS >> 8) as u8, MSS as u8], &[]),
                Some(format!("TCP 连接 :{dport}")),
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
            let (resp, line) = self.response(&c.req, c.t0, now_us);
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
        // 双方都发了 FIN：连接结束
        if !(peer_fin && c.fin_sent) {
            self.conns.insert(key, c);
        }
        out
    }
}
