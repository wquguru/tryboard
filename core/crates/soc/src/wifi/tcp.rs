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
    /// 真实网络（C-03）：已交给浏览器、还在等回复的请求编号
    real: Option<u32>,
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
    /// 补充说明（C-03：跨域失败的原因、HTTPS 未放行……），没有为空
    pub note: String,
}

/// 真实网络（C-03）：交给浏览器 fetch 的一条 HTTP 请求（网页从发件箱取走）
#[derive(Clone, Debug)]
pub struct RealReq {
    pub id: u32,
    pub method: String,
    pub url: String,
    pub ctype: String,
    pub body: Vec<u8>,
}

/// 浏览器给的失败原因代号 → 网络页签上的说明（代号由网页 realfetch.ts 定）
pub fn reason_text(code: &str) -> &'static str {
    match code {
        "cors" => "对方网站不允许跨域（CORS），浏览器拦下了",
        "net" => "连不上（域名不存在、断网或被拦）",
        "timeout" => "10 秒没有回应",
        "mixed" => "页面是 https，浏览器不许发 http 请求（混合内容）",
        _ => "浏览器拦下了（跨域或网络错误）",
    }
}

/// 回复正文上限（与网页 realfetch.ts 的 MAX_BODY 相同）
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

/// 请求头里的某一项（大小写不敏感）
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
    /// 自定义页面：路径 → (内容类型, 内容)；网页 / 测试可以注入
    pub pages: HashMap<String, (String, Vec<u8>)>,
    pub requests: u64,
    /// 给网页「网络」页签的结构化记录（只给人看，不影响回给芯片的字节）
    pub rows: Vec<NetRow>,
    /// 当前模拟时刻（Net 收到每一帧时更新），DNS 行盖时间戳用
    pub now_us: u64,
    /// 「真实网络」开关（C-03，默认关）：开着时发往 tryboard.local 以外的 HTTP 请求进发件箱，等网页给回复
    pub realnet: bool,
    /// 等网页取走的请求
    pub outbox: Vec<RealReq>,
    pub next_req: u32,
    /// 等回复的请求：编号 → (连接, 网络页签那一行)
    waiting: HashMap<u32, (Key, usize)>,
    /// 已有行被改写的次数（等待 → 200 / 超时）：网页按 行数 + 这个数 判断要不要重取
    pub rev: u64,
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

/// 服务端 → 芯片的一段（key 是芯片视角：芯片地址、芯片端口、服务端地址、服务端端口）
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

/// 整个 HTTP 回复按 MSS 切段发出，最后一段带 FIN（Connection: close）
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

/// 这个请求要不要交给真实网络：Host 不是 tryboard.local、也不是直接写的网关地址
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
    /// 请求交给网页：进发件箱，网络页签加一行「等待」
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
            dest: "真实",
            url,
            status: "等待".into(),
            dur_us: None,
            note: String::new(),
        });
        id
    }

    /// 芯片在回复到达前断开：那一行记成超时，迟到的回复丢掉
    fn abandon(&mut self, c: &Conn) {
        let Some(id) = c.real else { return };
        if let Some((_, row)) = self.waiting.remove(&id) {
            if let Some(r) = self.rows.get_mut(row) {
                r.status = "超时".into();
                r.note = "芯片没等到回复就断开了".into();
                self.rev += 1;
            }
        }
    }

    /// 网页送来回复（脚本动作 netreply=）：status 0 = 浏览器没拿到回复，info 是原因代号，芯片收到 502；
    /// 否则 info 是内容类型。回给芯片的字节只由这几个参数决定，网页实时运行与命令行重放逐字节相同。
    /// 返回（连接, 段, 日志）
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
                    "失败".into()
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
        let line = format!("真实网络 {url} → {code}（{} 字节）", body.len());
        c.real = None;
        let out = send_resp(&key, &mut c, &resp, line);
        self.conns.insert(key, c);
        out.into_iter().map(|(s, l)| (key, s, l)).collect()
    }

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
            dest: "虚拟",
            url: format!("http://{}{path}", if host.is_empty() { "?" } else { &host }),
            status: status.split(' ').next().unwrap_or("").to_string(),
            dur_us: Some(now.saturating_sub(t0)),
            note: String::new(),
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
        let mk = |c: &Conn, fl: u8, opts: &[u8], d: &[u8]| to_chip(&key, c, fl, opts, d);

        if flags & RST != 0 {
            if let Some(c) = self.conns.remove(&key) {
                self.abandon(&c);
            }
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
                    // 真实网络开着时说明为什么没放行（关着时与以前一样不加说明）
                    note: match (self.realnet, dport) {
                        (false, _) => String::new(),
                        (true, 443 | 8443) => "真实网络只放行 HTTP，HTTPS 未放行".into(),
                        (true, _) => "真实网络只放行 HTTP".into(),
                    },
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
        let head = c.req.windows(4).position(|w| w == b"\r\n\r\n");
        if let (false, Some(hp)) = (c.responded, head) {
            if self.realnet && goes_real(&c.req[..hp], dst) {
                // 真实网络（C-03）：带正文的请求等 Content-Length 收齐，再交给网页去 fetch；回复由 real_reply 送回
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
        // 芯片等不及（esp_http_client 超时）先关了连接：这一行记成超时，回 RST 了结
        if peer_fin && c.real.is_some() && !c.fin_sent {
            self.abandon(&c);
            return vec![(
                mk(&c, RST | ACK, &[], &[]),
                Some("真实网络：芯片没等到回复就关了连接".into()),
            )];
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

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// base64 编码（真实网络发件箱里的请求体交给网页用）
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

/// base64 解码（netreply= 里的回复正文）；有非法字符返回 None
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

/// 解析脚本动作 netreply= 后面的部分：编号,状态,毫秒,内容类型或原因代号,base64 正文
/// （毫秒是浏览器实测、只给人看，不影响回给芯片的字节）
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
