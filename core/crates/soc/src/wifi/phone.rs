//! 虚拟手机（C-02）：作为终端去连固件自建的热点（WIFI_MODE_AP / APSTA）。
//!
//! 链路：被动扫描（听固件的信标）→ 开放系统认证 → 关联 →（WPA2 时）四次握手，手机是请求方。
//! 网络：DHCP 客户端、ARP、DNS 客户端、最小 TCP 客户端 + HTTP/1.1（GET、POST 表单）。
//! 连上后像真手机一样先做联网探测（DNS 查 connectivitycheck 域名 → GET /generate_204）：
//! 得到的不是 204（固件 DNS 劫持 + 跳转）就判定「需要登录此网络」。
//! 全部按模拟时间推进，不依赖墙钟：同样的输入序列得到同样的帧序列（重放逐字节一致）。

use super::frame::{self, fc, Mac};
use super::net::{ipv4, l4_checksum, udp, ETH_ARP, ETH_IP};
use super::world::Air;
use super::wpa::{Supplicant, ETH_EAPOL};
use std::collections::{HashMap, VecDeque};

pub const PHONE_MAC: Mac = [0x02, 0x54, 0x42, 0xee, 0x00, 0x01];
/// 手机放在板子旁边：信号强（估算）
const PHONE_RSSI: i8 = -38;
/// 手机的 RSN IE：CCMP / CCMP / PSK，能力 0（不声明 PMF）。四次握手消息 2 里原样带上
const RSN_IE: [u8; 22] = [
    48, 20, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00,
    0x00, 0x0f, 0xac, 0x02, 0x00, 0x00,
];
const RATES: [u8; 8] = [0x82, 0x84, 0x8b, 0x96, 0x0c, 0x12, 0x18, 0x24];
const EXT_RATES: [u8; 4] = [0x30, 0x48, 0x60, 0x6c];
/// 联网探测用的域名与路径（安卓的写法；iPhone 用 captive.apple.com/hotspot-detect.html，差异要上真机看）
const PROBE_HOST: &str = "connectivitycheck.gstatic.com";
const PROBE_PATH: &str = "/generate_204";
/// 链路层重试间隔与次数
const LINK_RETRY_US: u64 = 300_000;
const LINK_TRIES: u32 = 4;
/// 连续这么久收不到信标：认为热点没了，回到扫描（真手机也会自动重连记住的网络）
const BEACON_LOSS_US: u64 = 3_000_000;
const DHCP_RETRY_US: u64 = 1_000_000;
const DNS_TIMEOUT_US: u64 = 1_500_000;
const TCP_RTO_US: u64 = 1_000_000;
const JOB_TIMEOUT_US: u64 = 10_000_000;

const SYN: u8 = 0x02;
const ACK: u8 = 0x10;
const FIN: u8 = 0x01;
const RST: u8 = 0x04;
const PSH: u8 = 0x08;

/// 手机上的操作（脚本动作 phone=...，网页手机面板的每一步）
#[derive(Clone, Debug, PartialEq)]
pub enum Cmd {
    /// 拿起手机：只打开无线局域网列表（开始听信标），不连任何热点
    On,
    /// 连这个热点（口令空 = 开放网络）
    Join {
        ssid: String,
        pass: String,
    },
    Leave,
    /// 点「打开」：打开登录页（联网探测得到的跳转地址，没有就打开网关首页）
    Open,
    Get(String),
    /// POST 表单：地址空 = 最近一页表单的 action
    Post(String, String),
}

impl Cmd {
    /// 解析脚本动作 phone= 后面的部分：on / join,ssid[,pass] / leave / open / get,url / post,url,body
    pub fn parse(s: &str) -> Option<Cmd> {
        let mut it = s.splitn(3, ',');
        let verb = it.next()?.trim();
        let a = it.next().unwrap_or("").to_string();
        let b = it.next().unwrap_or("").to_string();
        Some(match verb {
            "on" => Cmd::On,
            "join" if !a.is_empty() => Cmd::Join { ssid: a, pass: b },
            "leave" => Cmd::Leave,
            "open" => Cmd::Open,
            "get" => Cmd::Get(a),
            "post" => Cmd::Post(a, b),
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Link {
    Off,
    /// 等目标热点的信标
    Scan,
    Auth,
    Assoc,
    /// WPA2：等四次握手完成
    Eapol,
    Up,
}

impl Link {
    pub fn name(self) -> &'static str {
        match self {
            Link::Off => "off",
            Link::Scan => "scan",
            Link::Auth => "auth",
            Link::Assoc => "assoc",
            Link::Eapol => "eapol",
            Link::Up => "up",
        }
    }
}

/// 手机扫到的热点
#[derive(Clone, Debug)]
pub struct Bss {
    pub ssid: String,
    pub bssid: Mac,
    pub channel: u8,
    pub privacy: bool,
}

/// 手机看到的一页
#[derive(Clone, Debug, Default)]
pub struct Page {
    pub method: String,
    pub url: String,
    pub status: u16,
    pub location: String,
    pub title: String,
    pub text: String,
    pub form_action: String,
    pub form_method: String,
    pub fields: Vec<String>,
    pub body_len: usize,
    /// 出错时的原因（DNS 无回应、连接被拒、超时）
    pub error: String,
}

#[derive(Clone, Debug)]
struct Job {
    method: String,
    url: String,
    body: String,
    probe: bool,
}

#[derive(PartialEq, Eq, Debug)]
enum Js {
    Dns,
    SynSent,
    Est,
}

struct Run {
    job: Job,
    host: String,
    path: String,
    ip: [u8; 4],
    st: Js,
    dns_id: u16,
    tries: u32,
    retry_at: u64,
    deadline: u64,
    sport: u16,
    iss: u32,
    snd_nxt: u32,
    snd_una: u32,
    rcv_nxt: u32,
    req: Vec<u8>,
    resp: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Dhcp {
    Idle,
    Discover,
    Request { offer: [u8; 4], server: [u8; 4] },
    Bound,
}

pub struct Phone {
    pub mac: Mac,
    pub link: Link,
    pub seen: Vec<Bss>,
    pub ssid: String,
    pass: String,
    bss: Option<Bss>,
    supp: Option<Supplicant>,
    seq: u16,
    tries: u32,
    link_at: Option<u64>,
    last_beacon: u64,
    pub ip: Option<[u8; 4]>,
    pub gw: [u8; 4],
    pub dns: [u8; 4],
    mask: [u8; 4],
    dhcp: Dhcp,
    xid: u32,
    dhcp_at: Option<u64>,
    arp: HashMap<[u8; 4], Mac>,
    /// 等 ARP 的 IP 包：(目的 IP, 协议, 载荷)
    arp_wait: Vec<([u8; 4], u8, Vec<u8>)>,
    ip_id: u16,
    jobs: VecDeque<Job>,
    run: Option<Run>,
    /// 已关掉、但对方的 FIN 还可能到的连接：(本地端口, 期望序号, 发送序号, 对端)
    closing: Vec<(u16, u32, u32, [u8; 4])>,
    port: u16,
    pub pages: Vec<Page>,
    /// 联网探测结论：None 未探测；Some(None) 可以上网；Some(Some(url)) 需要登录，登录页地址
    pub captive: Option<Option<String>>,
    /// --ap-phone：探测到需要登录就自动打开登录页；--ap-post：拿到表单就自动提交
    pub auto_open: bool,
    pub auto_post: Option<String>,
    /// 手机侧日志（模拟时间微秒, 内容）
    pub log: Vec<(u64, String)>,
    /// 要发给芯片的帧（相对 now 的延时）；World::poll / on_tx 取走
    out: Vec<Air>,
    kick: bool,
    /// 内容变化计数（网页按它决定要不要刷新手机画面）
    pub version: u64,
}

impl Default for Phone {
    fn default() -> Self {
        Phone::new()
    }
}

fn ip_str(ip: &[u8; 4]) -> String {
    format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
}

fn parse_ip(s: &str) -> Option<[u8; 4]> {
    let v: Vec<u8> = s.split('.').filter_map(|x| x.parse().ok()).collect();
    (v.len() == 4 && s.split('.').count() == 4).then(|| [v[0], v[1], v[2], v[3]])
}

fn tcp_seg(
    src: [u8; 4],
    dst: [u8; 4],
    ports: (u16, u16),
    seq: u32,
    ack: u32,
    flags: u8,
    data: &[u8],
) -> Vec<u8> {
    let opts: &[u8] = if flags & SYN != 0 {
        &[2, 4, 0x05, 0xb4] // MSS 1460
    } else {
        &[]
    };
    let hl = 20 + opts.len();
    let mut s = Vec::with_capacity(hl + data.len());
    s.extend_from_slice(&ports.0.to_be_bytes());
    s.extend_from_slice(&ports.1.to_be_bytes());
    s.extend_from_slice(&seq.to_be_bytes());
    s.extend_from_slice(&ack.to_be_bytes());
    s.push(((hl / 4) as u8) << 4);
    s.push(flags);
    s.extend_from_slice(&65535u16.to_be_bytes());
    s.extend_from_slice(&[0, 0, 0, 0]);
    s.extend_from_slice(opts);
    s.extend_from_slice(data);
    let c = l4_checksum(src, dst, 6, &s);
    s[16..18].copy_from_slice(&c.to_be_bytes());
    s
}

/// 取 HTML 标签属性（引号或裸值）
fn attr(tag: &str, name: &str) -> String {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(p) = lower[from..].find(name) {
        let at = from + p;
        let before_ok = at == 0 || !lower.as_bytes()[at - 1].is_ascii_alphanumeric();
        let rest = &tag[at + name.len()..];
        let rest_t = rest.trim_start();
        if before_ok && rest_t.starts_with('=') {
            let v = rest_t[1..].trim_start();
            return if let Some(q) = v.chars().next().filter(|c| *c == '"' || *c == '\'') {
                v[1..].split(q).next().unwrap_or("").to_string()
            } else {
                v.split(|c: char| c.is_whitespace() || c == '>')
                    .next()
                    .unwrap_or("")
                    .to_string()
            };
        }
        from = at + name.len();
    }
    String::new()
}

/// 页面摘要：标题、正文前几十个字、第一个表单的 action / method / 字段名
fn summarize(p: &mut Page, html: &str) {
    let lower = html.to_ascii_lowercase();
    if let (Some(a), Some(b)) = (lower.find("<title>"), lower.find("</title>")) {
        if b > a + 7 {
            p.title = html[a + 7..b].trim().to_string();
        }
    }
    if let Some(fs) = lower.find("<form") {
        let end = lower[fs..].find('>').map_or(lower.len(), |e| fs + e);
        let tag = &html[fs..end];
        p.form_action = attr(tag, "action");
        p.form_method = attr(tag, "method").to_ascii_uppercase();
        if p.form_method.is_empty() {
            p.form_method = "GET".into();
        }
        let fend = lower[fs..].find("</form").map_or(lower.len(), |e| fs + e);
        let mut i = fs;
        while let Some(k) = lower[i..fend].find("<input") {
            let s = i + k;
            let e = lower[s..].find('>').map_or(fend, |x| s + x);
            let n = attr(&html[s..e], "name");
            if !n.is_empty() {
                p.fields.push(n);
            }
            i = e;
        }
    }
    // 正文：去掉 head 与标签，压缩空白
    let body_start = lower.find("<body").unwrap_or(0);
    let mut text = String::new();
    let mut in_tag = false;
    for c in html[body_start..].chars() {
        match c {
            '<' => {
                in_tag = true;
                text.push(' ');
            }
            '>' => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    p.text = words.join(" ").chars().take(80).collect();
}

impl Phone {
    pub fn new() -> Self {
        Phone {
            mac: PHONE_MAC,
            link: Link::Off,
            seen: Vec::new(),
            ssid: String::new(),
            pass: String::new(),
            bss: None,
            supp: None,
            seq: 0,
            tries: 0,
            link_at: None,
            last_beacon: 0,
            ip: None,
            gw: [0; 4],
            dns: [0; 4],
            mask: [255, 255, 255, 0],
            dhcp: Dhcp::Idle,
            xid: 0x7b0b_0000,
            dhcp_at: None,
            arp: HashMap::new(),
            arp_wait: Vec::new(),
            ip_id: 0,
            jobs: VecDeque::new(),
            run: None,
            closing: Vec::new(),
            port: 49_152,
            pages: Vec::new(),
            captive: None,
            auto_open: false,
            auto_post: None,
            log: Vec::new(),
            out: Vec::new(),
            kick: false,
            version: 0,
        }
    }

    fn note(&mut self, now: u64, s: String) {
        self.version += 1;
        if self.log.len() < 2000 {
            self.log.push((now, s));
        }
    }

    /// 执行一个操作；产生的帧在下一次 poll 时发出（调用方要让 MAC 模型尽快 update）
    pub fn command(&mut self, c: Cmd, now: u64) {
        self.version += 1;
        match c {
            Cmd::On => {}
            Cmd::Join { ssid, pass } => {
                self.reset_link();
                self.note(
                    now,
                    format!(
                        "要连 {ssid}（{}）",
                        if pass.is_empty() { "开放" } else { "WPA2" }
                    ),
                );
                self.ssid = ssid;
                self.pass = pass;
                self.link = Link::Scan;
                self.captive = None;
                self.try_start_auth(now);
            }
            Cmd::Leave => {
                if let Some(b) = self.bss.clone() {
                    if self.link != Link::Off && self.link != Link::Scan {
                        let seq = self.next_seq();
                        let mut f = frame::mgmt_hdr(fc::DEAUTH, &b.bssid, &self.mac, &b.bssid, seq);
                        f.extend_from_slice(&3u16.to_le_bytes()); // 终端离开
                        self.send(f, b.channel);
                    }
                }
                self.reset_link();
                self.ssid.clear();
                self.note(now, "断开热点".into());
            }
            Cmd::Open => {
                let url = match &self.captive {
                    Some(Some(u)) => u.clone(),
                    _ => format!("http://{}/", ip_str(&self.gw)),
                };
                self.push_job("GET", &url, "", false);
            }
            Cmd::Get(u) => self.push_job("GET", &u, "", false),
            Cmd::Post(u, body) => {
                let u = if u.is_empty() {
                    self.pages
                        .iter()
                        .rev()
                        .find(|p| !p.form_action.is_empty())
                        .map(|p| p.form_action.clone())
                        .unwrap_or_else(|| "/".into())
                } else {
                    u
                };
                self.push_job("POST", &u, &body, false);
            }
        }
        self.kick = true;
    }

    fn push_job(&mut self, method: &str, url: &str, body: &str, probe: bool) {
        self.jobs.push_back(Job {
            method: method.into(),
            url: url.into(),
            body: body.into(),
            probe,
        });
        self.kick = true;
    }

    fn reset_link(&mut self) {
        self.link = Link::Off;
        self.bss = None;
        self.supp = None;
        self.link_at = None;
        self.ip = None;
        self.dhcp = Dhcp::Idle;
        self.dhcp_at = None;
        self.arp.clear();
        self.arp_wait.clear();
        self.run = None;
        self.closing.clear();
    }

    fn next_seq(&mut self) -> u16 {
        self.seq = (self.seq + 1) & 0xfff;
        self.seq
    }

    fn send(&mut self, f: Vec<u8>, channel: u8) {
        let k = self.out.len() as u64;
        self.out.push(Air {
            delay_us: 150 + 120 * k,
            frame: f,
            rssi: PHONE_RSSI,
            channel,
            ap_if: true,
        });
    }

    pub fn take_out(&mut self) -> Vec<Air> {
        std::mem::take(&mut self.out)
    }

    pub fn next_timer(&self) -> Option<u64> {
        let mut t: Option<u64> = None;
        let mut m = |x: Option<u64>| {
            if let Some(x) = x {
                t = Some(t.map_or(x, |y: u64| y.min(x)));
            }
        };
        if self.kick {
            m(Some(0));
        }
        m(self.link_at);
        m(self.dhcp_at);
        if self.link == Link::Up {
            m(Some(self.last_beacon + BEACON_LOSS_US));
        }
        if let Some(r) = &self.run {
            m(Some(r.retry_at.min(r.deadline)));
        }
        t
    }

    fn try_start_auth(&mut self, now: u64) {
        if self.link != Link::Scan {
            return;
        }
        let Some(b) = self.seen.iter().find(|b| b.ssid == self.ssid).cloned() else {
            return;
        };
        if b.privacy != !self.pass.is_empty() {
            let msg = if b.privacy {
                format!("{} 要密码（WPA2），手机这边没填", b.ssid)
            } else {
                format!("{} 是开放网络，不用密码", b.ssid)
            };
            self.note(now, msg);
            if b.privacy {
                self.link = Link::Off;
                return;
            }
        }
        self.note(
            now,
            format!(
                "找到 {}（{} ch{}），开始认证",
                b.ssid,
                frame::mac_str(&b.bssid),
                b.channel
            ),
        );
        self.bss = Some(b);
        self.link = Link::Auth;
        self.tries = 0;
        self.send_auth();
        self.link_at = Some(now + LINK_RETRY_US);
    }

    fn send_auth(&mut self) {
        let b = self.bss.clone().unwrap();
        let seq = self.next_seq();
        let mut f = frame::mgmt_hdr(fc::AUTH, &b.bssid, &self.mac, &b.bssid, seq);
        f.extend_from_slice(&[0, 0, 1, 0, 0, 0]); // 开放系统、序号 1、状态 0
        self.tries += 1;
        self.send(f, b.channel);
    }

    fn send_assoc(&mut self) {
        let b = self.bss.clone().unwrap();
        let seq = self.next_seq();
        let mut f = frame::mgmt_hdr(fc::ASSOC_REQ, &b.bssid, &self.mac, &b.bssid, seq);
        let mut cap: u16 = 0x0001 | 0x0400;
        if b.privacy {
            cap |= 0x0010;
        }
        f.extend_from_slice(&cap.to_le_bytes());
        f.extend_from_slice(&10u16.to_le_bytes()); // 监听间隔
        frame::ie(&mut f, 0, b.ssid.as_bytes());
        frame::ie(&mut f, 1, &RATES);
        frame::ie(&mut f, 50, &EXT_RATES);
        if b.privacy {
            f.extend_from_slice(&RSN_IE);
        }
        self.tries += 1;
        self.send(f, b.channel);
    }

    /// 定时器到点：链路重试、DHCP 重发、DNS / TCP 重传与超时、信标丢失
    pub fn poll(&mut self, now: u64) {
        self.kick = false;
        if self.link == Link::Up && now >= self.last_beacon + BEACON_LOSS_US {
            let s = self.ssid.clone();
            self.note(
                now,
                format!("{s} 的信号没了（3 秒没收到信标），回到扫描，等它再出现"),
            );
            self.reset_link();
            self.ssid = s;
            self.link = Link::Scan;
            // 旧的扫描结果作废：等新的信标
            self.seen.clear();
        }
        if self.link_at.is_some_and(|t| now >= t) {
            self.link_at = None;
            if self.tries >= LINK_TRIES {
                let what = match self.link {
                    Link::Auth => "认证",
                    Link::Assoc => "关联",
                    _ => "四次握手",
                };
                self.note(now, format!("{what}没有回应，放弃"));
                self.reset_link();
            } else {
                match self.link {
                    Link::Auth => {
                        self.send_auth();
                        self.link_at = Some(now + LINK_RETRY_US);
                    }
                    Link::Assoc => {
                        self.send_assoc();
                        self.link_at = Some(now + LINK_RETRY_US);
                    }
                    Link::Eapol => {
                        // 四次握手由 AP 驱动，手机只等；超时就算失败
                        self.note(now, "四次握手没完成（热点口令不对？）".into());
                        self.reset_link();
                    }
                    _ => {}
                }
            }
        }
        if self.dhcp_at.is_some_and(|t| now >= t) {
            self.dhcp_at = Some(now + DHCP_RETRY_US);
            match self.dhcp {
                Dhcp::Discover => self.dhcp_send(1, None),
                Dhcp::Request { offer, server } => self.dhcp_send(3, Some((offer, server))),
                _ => self.dhcp_at = None,
            }
        }
        self.job_tick(now);
    }

    /// 芯片（固件热点）发出的一帧；返回 (日志描述, 是否被手机确认)
    pub fn on_frame(&mut self, f: &[u8], now: u64) -> (String, bool) {
        let Some(h) = frame::parse(f) else {
            return ("短帧".into(), false);
        };
        let body = &f[h.body.min(f.len())..];
        let to_me = h.a1 == self.mac;
        if h.fc0 == fc::BEACON || h.fc0 == fc::PROBE_RESP {
            if body.len() < 12 {
                return ("信标（短）".into(), false);
            }
            let ies = &body[12..];
            let ssid = String::from_utf8_lossy(frame::find_ie(ies, 0).unwrap_or(&[])).into_owned();
            let channel = frame::find_ie(ies, 3)
                .and_then(|d| d.first().copied())
                .unwrap_or(1);
            let privacy = u16::from_le_bytes([body[10], body[11]]) & 0x0010 != 0;
            let b = Bss {
                ssid: ssid.clone(),
                bssid: h.a3,
                channel,
                privacy,
            };
            match self.seen.iter_mut().find(|x| x.bssid == b.bssid) {
                Some(x) => {
                    if x.ssid != b.ssid || x.privacy != b.privacy {
                        *x = b;
                        self.version += 1;
                    }
                }
                None => {
                    self.seen.push(b);
                    self.version += 1;
                }
            }
            if self.bss.as_ref().is_some_and(|x| x.bssid == h.a3) {
                self.last_beacon = now;
            }
            if self.link == Link::Scan && ssid == self.ssid {
                self.try_start_auth(now);
            }
            return (format!("固件热点信标 ssid={ssid:?} ch{channel}"), false);
        }
        if !to_me && h.a1[0] & 1 == 0 {
            return (format!("帧 FC=0x{:02x}（不是给手机的）", h.fc0), false);
        }
        let from_bss = self.bss.as_ref().is_some_and(|b| b.bssid == h.a2);
        let desc = match h.fc0 {
            fc::AUTH if to_me && from_bss && self.link == Link::Auth && body.len() >= 6 => {
                let status = u16::from_le_bytes([body[4], body[5]]);
                if status != 0 {
                    self.note(now, format!("认证被拒（状态 {status}）"));
                    self.reset_link();
                    format!("认证响应：拒绝 {status}")
                } else {
                    self.link = Link::Assoc;
                    self.tries = 0;
                    self.send_assoc();
                    self.link_at = Some(now + LINK_RETRY_US);
                    "认证响应：成功 → 发关联请求".into()
                }
            }
            fc::ASSOC_RESP if to_me && from_bss && self.link == Link::Assoc && body.len() >= 6 => {
                let status = u16::from_le_bytes([body[2], body[3]]);
                let aid = u16::from_le_bytes([body[4], body[5]]) & 0x3fff;
                if status != 0 {
                    self.note(now, format!("关联被拒（状态 {status}）"));
                    self.reset_link();
                    format!("关联响应：拒绝 {status}")
                } else {
                    self.last_beacon = now;
                    let b = self.bss.clone().unwrap();
                    if b.privacy {
                        self.supp = Some(Supplicant::new(
                            &self.pass,
                            b.ssid.as_bytes(),
                            b.bssid,
                            self.mac,
                            &RSN_IE,
                        ));
                        self.link = Link::Eapol;
                        self.link_at = Some(now + 5_000_000);
                        self.tries = 0;
                    } else {
                        self.link_up(now);
                    }
                    format!("关联响应：成功 AID {aid}")
                }
            }
            fc::DEAUTH | fc::DISASSOC if from_bss => {
                let reason = body
                    .get(..2)
                    .map_or(0, |r| u16::from_le_bytes([r[0], r[1]]));
                self.note(
                    now,
                    format!("被热点断开（原因 {reason}），记着这个热点，它再出现就自动重连"),
                );
                self.reset_link();
                // 真手机记住连过的网络：回到扫描，等它的信标再出现
                self.link = Link::Scan;
                self.seen.clear();
                format!("去认证 / 去关联 原因 {reason}")
            }
            x if x & 0x0c == 0x08 && h.fc1 & 3 == 2 && from_bss => self.on_data(f, &h, now),
            x => format!("帧 FC=0x{x:02x}"),
        };
        (format!("→手机 {desc}"), to_me)
    }

    fn link_up(&mut self, now: u64) {
        self.link = Link::Up;
        self.link_at = None;
        let s = self.ssid.clone();
        self.note(now, format!("已连上 {s}，DHCP 要地址"));
        self.dhcp = Dhcp::Discover;
        self.xid = self.xid.wrapping_add(1);
        if self.supp.is_some() {
            // WPA2：对端收到消息 4 后才装密钥，紧跟着的加密帧会被它丢掉；稍等再发（真手机同样有这段间隔）
            self.dhcp_at = Some(now + 20_000);
        } else {
            self.dhcp_send(1, None);
            self.dhcp_at = Some(now + DHCP_RETRY_US);
        }
    }

    fn on_data(&mut self, f: &[u8], h: &frame::Hdr, now: u64) -> String {
        let mut plain = f.to_vec();
        if h.fc1 & 0x40 != 0 {
            match self
                .supp
                .as_ref()
                .filter(|s| s.done)
                .and_then(|s| s.decrypt(f))
            {
                Some(p) => plain = p,
                None => return "加密数据帧：手机解不开，丢弃".into(),
            }
        }
        let body = &plain[h.body.min(plain.len())..];
        if body.len() < 8 || body[..6] != [0xaa, 0xaa, 0x03, 0, 0, 0] {
            return "数据帧（非 LLC/SNAP）".into();
        }
        let et = u16::from_be_bytes([body[6], body[7]]);
        let p = body[8..].to_vec();
        match et {
            ETH_EAPOL => {
                let Some(s) = self.supp.as_mut() else {
                    return "EAPOL（开放网络，忽略）".into();
                };
                let (note, reply) = s.on_eapol(&p);
                let done = s.done;
                if let Some(r) = reply {
                    self.send_eth(h.a3, ETH_EAPOL, &r, false);
                }
                if done && self.link == Link::Eapol {
                    self.link_up(now);
                }
                note
            }
            ETH_ARP => self.on_arp(&p),
            ETH_IP => self.on_ip(&p, now),
            _ => format!("以太类型 0x{et:04x}"),
        }
    }

    /// 以太网帧 → 发给热点的数据帧（ToDS：a1 BSSID、a2 手机、a3 目的）
    fn send_eth(&mut self, dst: Mac, et: u16, payload: &[u8], encrypt: bool) {
        let Some(b) = self.bss.clone() else { return };
        let seq = self.next_seq();
        let mut f = vec![fc::DATA, 0x01, 0, 0];
        f.extend_from_slice(&b.bssid);
        f.extend_from_slice(&self.mac);
        f.extend_from_slice(&dst);
        f.extend_from_slice(&(seq << 4).to_le_bytes());
        f.extend_from_slice(&[0xaa, 0xaa, 0x03, 0, 0, 0]);
        f.extend_from_slice(&et.to_be_bytes());
        f.extend_from_slice(payload);
        if encrypt {
            if let Some(s) = self.supp.as_mut().filter(|s| s.done) {
                f = s.encrypt(&f);
            }
        }
        self.send(f, b.channel);
    }

    fn on_arp(&mut self, p: &[u8]) -> String {
        if p.len() < 28 {
            return "ARP（短）".into();
        }
        let op = u16::from_be_bytes([p[6], p[7]]);
        let smac: Mac = p[8..14].try_into().unwrap();
        let sip: [u8; 4] = p[14..18].try_into().unwrap();
        let tip: [u8; 4] = p[24..28].try_into().unwrap();
        if sip != [0; 4] {
            self.arp.insert(sip, smac);
        }
        if op == 1 && Some(tip) == self.ip {
            let mut r = vec![0, 1, 8, 0, 6, 4, 0, 2];
            r.extend_from_slice(&self.mac);
            r.extend_from_slice(&tip);
            r.extend_from_slice(&smac);
            r.extend_from_slice(&sip);
            self.send_eth(smac, ETH_ARP, &r, true);
            return format!("ARP 谁是 {} → 手机应答", ip_str(&tip));
        }
        // 等这个地址的包可以发了
        let waiting = std::mem::take(&mut self.arp_wait);
        let (ready, rest): (Vec<_>, Vec<_>) = waiting
            .into_iter()
            .partition(|w| self.arp.contains_key(&self.next_hop(w.0)));
        self.arp_wait = rest;
        for (d, proto, pl) in ready {
            self.send_ip(d, proto, &pl);
        }
        format!("ARP {} 是 {}", ip_str(&sip), frame::mac_str(&smac))
    }

    fn next_hop(&self, dst: [u8; 4]) -> [u8; 4] {
        let me = self.ip.unwrap_or([0; 4]);
        let same = (0..4).all(|i| dst[i] & self.mask[i] == me[i] & self.mask[i]);
        if same || self.gw == [0; 4] {
            dst
        } else {
            self.gw
        }
    }

    fn send_ip(&mut self, dst: [u8; 4], proto: u8, payload: &[u8]) {
        let src = self.ip.unwrap_or([0; 4]);
        self.ip_id = self.ip_id.wrapping_add(1);
        let pkt = ipv4(src, dst, proto, payload, self.ip_id);
        if dst == [255; 4] {
            self.send_eth([0xff; 6], ETH_IP, &pkt, true);
            return;
        }
        let hop = self.next_hop(dst);
        match self.arp.get(&hop).copied() {
            Some(m) => self.send_eth(m, ETH_IP, &pkt, true),
            None => {
                self.ip_id = self.ip_id.wrapping_sub(1);
                let first = !self.arp_wait.iter().any(|w| self.next_hop(w.0) == hop);
                self.arp_wait.push((dst, proto, payload.to_vec()));
                if first {
                    let mut r = vec![0, 1, 8, 0, 6, 4, 0, 1];
                    r.extend_from_slice(&self.mac);
                    r.extend_from_slice(&src);
                    r.extend_from_slice(&[0; 6]);
                    r.extend_from_slice(&hop);
                    self.send_eth([0xff; 6], ETH_ARP, &r, true);
                }
            }
        }
    }

    fn dhcp_send(&mut self, kind: u8, req: Option<([u8; 4], [u8; 4])>) {
        let mut d = vec![0u8; 240];
        d[0] = 1;
        d[1] = 1;
        d[2] = 6;
        d[4..8].copy_from_slice(&self.xid.to_be_bytes());
        d[10] = 0x80; // 请服务器广播回复（手机还没有地址）
        d[28..34].copy_from_slice(&self.mac);
        d[236..240].copy_from_slice(&[0x63, 0x82, 0x53, 0x63]);
        d.extend_from_slice(&[53, 1, kind]);
        if let Some((ip, server)) = req {
            d.extend_from_slice(&[50, 4]);
            d.extend_from_slice(&ip);
            d.extend_from_slice(&[54, 4]);
            d.extend_from_slice(&server);
        }
        d.extend_from_slice(&[55, 3, 1, 3, 6]);
        d.extend_from_slice(&[12, 14]);
        d.extend_from_slice(b"TryBoard-Phone");
        d.push(255);
        let u = udp([0; 4], [255; 4], 68, 67, &d);
        self.ip_id = self.ip_id.wrapping_add(1);
        let pkt = ipv4([0; 4], [255; 4], 17, &u, self.ip_id);
        self.send_eth([0xff; 6], ETH_IP, &pkt, true);
    }

    fn on_ip(&mut self, p: &[u8], now: u64) -> String {
        if p.len() < 20 || p[0] >> 4 != 4 {
            return "IP（短）".into();
        }
        let ihl = (p[0] & 15) as usize * 4;
        let total = (u16::from_be_bytes([p[2], p[3]]) as usize).min(p.len());
        let (proto, src) = (p[9], [p[12], p[13], p[14], p[15]]);
        if ihl > total {
            return "IP（坏头）".into();
        }
        let body = &p[ihl..total];
        match proto {
            17 if body.len() >= 8 => {
                let sport = u16::from_be_bytes([body[0], body[1]]);
                let dport = u16::from_be_bytes([body[2], body[3]]);
                let data = body[8..].to_vec();
                if dport == 68 {
                    self.on_dhcp(&data, now)
                } else if sport == 53 {
                    self.on_dns(&data, now)
                } else {
                    format!("UDP {sport}→{dport}")
                }
            }
            6 => self.on_tcp(src, body, now),
            1 => "ICMP".into(),
            _ => format!("IP 协议 {proto}"),
        }
    }

    fn on_dhcp(&mut self, d: &[u8], now: u64) -> String {
        if d.len() < 240 || d[0] != 2 || u32::from_be_bytes([d[4], d[5], d[6], d[7]]) != self.xid {
            return "DHCP（不是给手机的）".into();
        }
        let yi = [d[16], d[17], d[18], d[19]];
        let (mut kind, mut server, mut router, mut dns, mut mask) = (0, [0u8; 4], None, None, None);
        let mut i = 240;
        while i + 1 < d.len() && d[i] != 255 {
            if d[i] == 0 {
                i += 1;
                continue;
            }
            let l = d[i + 1] as usize;
            if i + 2 + l > d.len() {
                break;
            }
            let v = &d[i + 2..i + 2 + l];
            match d[i] {
                53 if l >= 1 => kind = v[0],
                54 if l >= 4 => server = [v[0], v[1], v[2], v[3]],
                3 if l >= 4 => router = Some([v[0], v[1], v[2], v[3]]),
                6 if l >= 4 => dns = Some([v[0], v[1], v[2], v[3]]),
                1 if l >= 4 => mask = Some([v[0], v[1], v[2], v[3]]),
                _ => {}
            }
            i += 2 + l;
        }
        match (kind, self.dhcp) {
            (2, Dhcp::Discover) => {
                self.dhcp = Dhcp::Request { offer: yi, server };
                self.dhcp_send(3, Some((yi, server)));
                self.dhcp_at = Some(now + DHCP_RETRY_US);
                format!("DHCP OFFER {}", ip_str(&yi))
            }
            (5, Dhcp::Request { .. }) => {
                self.dhcp = Dhcp::Bound;
                self.dhcp_at = None;
                self.ip = Some(yi);
                self.gw = router.unwrap_or(server);
                self.dns = dns.unwrap_or(self.gw);
                self.mask = mask.unwrap_or([255, 255, 255, 0]);
                self.note(
                    now,
                    format!(
                        "分到 {}（网关 {}，DNS {}）",
                        ip_str(&yi),
                        ip_str(&self.gw),
                        ip_str(&self.dns)
                    ),
                );
                // 真手机连上新网络第一件事：联网探测
                let url = format!("http://{PROBE_HOST}{PROBE_PATH}");
                self.jobs.push_front(Job {
                    method: "GET".into(),
                    url,
                    body: String::new(),
                    probe: true,
                });
                self.kick = true;
                format!("DHCP ACK {}", ip_str(&yi))
            }
            (6, _) => {
                self.note(now, "DHCP 被拒（NAK），重新要地址".into());
                self.dhcp = Dhcp::Discover;
                self.dhcp_send(1, None);
                "DHCP NAK".into()
            }
            _ => format!("DHCP 消息 {kind}（忽略）"),
        }
    }

    // ---------------- 应用层：DNS + HTTP 任务 ----------------

    fn job_tick(&mut self, now: u64) {
        if self.run.is_none() {
            if self.dhcp != Dhcp::Bound || self.ip.is_none() {
                return;
            }
            let Some(job) = self.jobs.pop_front() else {
                return;
            };
            self.start_job(job, now);
            return;
        }
        let r = self.run.as_ref().unwrap();
        if now >= r.deadline {
            self.finish_err(now, "超时：对方没有回应");
            return;
        }
        if now < r.retry_at {
            return;
        }
        let (st, tries) = (
            match r.st {
                Js::Dns => 0,
                Js::SynSent => 1,
                Js::Est => 2,
            },
            r.tries,
        );
        if tries >= 4 {
            let why = match st {
                0 => "DNS 没有回应",
                1 => "连不上（SYN 没有回应）",
                _ => "对方不再回应",
            };
            self.finish_err(now, why);
            return;
        }
        match st {
            0 => self.send_dns(now),
            1 => self.send_syn(now),
            _ => self.send_req(now),
        }
    }

    fn start_job(&mut self, job: Job, now: u64) {
        let url = job.url.trim().to_string();
        let (host, path) = if let Some(rest) = url.strip_prefix("http://") {
            match rest.find('/') {
                Some(i) => (rest[..i].to_string(), rest[i..].to_string()),
                None => (rest.to_string(), "/".to_string()),
            }
        } else if url.starts_with("https://") {
            self.pages.push(Page {
                method: job.method.clone(),
                url: url.clone(),
                error: "手机这边只模拟 HTTP，HTTPS 没做".into(),
                ..Default::default()
            });
            self.note(now, format!("{} {url}：不支持 HTTPS", job.method));
            self.kick = true;
            return;
        } else {
            let p = if url.starts_with('/') {
                url.clone()
            } else {
                format!("/{url}")
            };
            // 相对地址：沿用上一页的主机，没有就是网关
            let h = self
                .pages
                .iter()
                .rev()
                .find(|p| p.error.is_empty())
                .and_then(|p| p.url.strip_prefix("http://"))
                .and_then(|r| r.split('/').next())
                .map(|s| s.to_string())
                .unwrap_or_else(|| ip_str(&self.gw));
            (h, p)
        };
        let host = host.split(':').next().unwrap_or("").to_string();
        self.port = if self.port >= 65_000 {
            49_152
        } else {
            self.port + 1
        };
        let iss = 0x1000_0000u32.wrapping_add((self.port as u32) << 12);
        let ip = parse_ip(&host);
        let mut r = Run {
            job,
            host,
            path,
            ip: ip.unwrap_or([0; 4]),
            st: if ip.is_some() { Js::SynSent } else { Js::Dns },
            dns_id: self.port,
            tries: 0,
            retry_at: now,
            deadline: now + JOB_TIMEOUT_US,
            sport: self.port,
            iss,
            snd_nxt: iss,
            snd_una: iss,
            rcv_nxt: 0,
            req: Vec::new(),
            resp: Vec::new(),
        };
        let mut req = format!(
            "{} {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: TryBoard-Phone\r\nAccept: text/html,*/*\r\nConnection: close\r\n",
            r.job.method, r.path, r.host
        );
        if r.job.method == "POST" {
            req.push_str(&format!(
                "Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n",
                r.job.body.len()
            ));
        }
        req.push_str("\r\n");
        req.push_str(&r.job.body);
        r.req = req.into_bytes();
        let st0 = r.st == Js::Dns;
        self.run = Some(r);
        if st0 {
            self.send_dns(now);
        } else {
            self.send_syn(now);
        }
    }

    fn send_dns(&mut self, now: u64) {
        let (id, host) = {
            let r = self.run.as_mut().unwrap();
            r.tries += 1;
            r.retry_at = now + DNS_TIMEOUT_US;
            (r.dns_id, r.host.clone())
        };
        let mut q = id.to_be_bytes().to_vec();
        q.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
        for part in host.split('.') {
            q.push(part.len() as u8);
            q.extend_from_slice(part.as_bytes());
        }
        q.extend_from_slice(&[0, 0, 1, 0, 1]);
        let me = self.ip.unwrap_or([0; 4]);
        let u = udp(me, self.dns, id, 53, &q);
        let dns = self.dns;
        self.send_ip(dns, 17, &u);
    }

    fn on_dns(&mut self, d: &[u8], now: u64) -> String {
        let Some(r) = self.run.as_mut() else {
            return "DNS 应答（没在等）".into();
        };
        if r.st != Js::Dns || d.len() < 12 || u16::from_be_bytes([d[0], d[1]]) != r.dns_id {
            return "DNS 应答（不是在等的）".into();
        }
        let an = u16::from_be_bytes([d[6], d[7]]);
        // 跳过问题
        let mut i = 12;
        while i < d.len() && d[i] != 0 {
            i += 1 + d[i] as usize;
        }
        i += 5;
        let mut ip = None;
        for _ in 0..an {
            if i + 12 > d.len() {
                break;
            }
            // 名字：压缩指针或标签序列
            if d[i] & 0xc0 == 0xc0 {
                i += 2;
            } else {
                while i < d.len() && d[i] != 0 {
                    i += 1 + d[i] as usize;
                }
                i += 1;
            }
            if i + 10 > d.len() {
                break;
            }
            let t = u16::from_be_bytes([d[i], d[i + 1]]);
            let l = u16::from_be_bytes([d[i + 8], d[i + 9]]) as usize;
            i += 10;
            if t == 1 && l == 4 && i + 4 <= d.len() {
                ip = Some([d[i], d[i + 1], d[i + 2], d[i + 3]]);
                break;
            }
            i += l;
        }
        let host = r.host.clone();
        match ip {
            Some(a) => {
                r.ip = a;
                r.st = Js::SynSent;
                r.tries = 0;
                self.note(now, format!("DNS {host} → {}", ip_str(&a)));
                self.send_syn(now);
                format!("DNS 应答 {host} → {}", ip_str(&a))
            }
            None => {
                self.finish_err(now, "DNS 查不到这个域名");
                format!("DNS 应答 {host}：没有地址")
            }
        }
    }

    fn send_syn(&mut self, now: u64) {
        let me = self.ip.unwrap_or([0; 4]);
        let r = self.run.as_mut().unwrap();
        r.tries += 1;
        r.retry_at = now + TCP_RTO_US;
        r.snd_nxt = r.iss.wrapping_add(1);
        let s = tcp_seg(me, r.ip, (r.sport, 80), r.iss, 0, SYN, &[]);
        let ip = r.ip;
        self.send_ip(ip, 6, &s);
    }

    fn send_req(&mut self, now: u64) {
        let me = self.ip.unwrap_or([0; 4]);
        let r = self.run.as_mut().unwrap();
        r.tries += 1;
        r.retry_at = now + TCP_RTO_US;
        let start = r.iss.wrapping_add(1);
        let sent = r.snd_una.wrapping_sub(start) as usize;
        if sent >= r.req.len() {
            // 请求都被确认了：等回复，不重传
            r.retry_at = r.deadline;
            return;
        }
        let chunk = r.req[sent..]
            .iter()
            .take(1400)
            .copied()
            .collect::<Vec<u8>>();
        let seq = r.snd_una;
        r.snd_nxt = seq.wrapping_add(chunk.len() as u32);
        let s = tcp_seg(me, r.ip, (r.sport, 80), seq, r.rcv_nxt, ACK | PSH, &chunk);
        let ip = r.ip;
        self.send_ip(ip, 6, &s);
    }

    fn on_tcp(&mut self, src: [u8; 4], s: &[u8], now: u64) -> String {
        if s.len() < 20 {
            return "TCP（短）".into();
        }
        let sport = u16::from_be_bytes([s[0], s[1]]);
        let dport = u16::from_be_bytes([s[2], s[3]]);
        let seq = u32::from_be_bytes([s[4], s[5], s[6], s[7]]);
        let ack = u32::from_be_bytes([s[8], s[9], s[10], s[11]]);
        let flags = s[13];
        let hl = ((s[12] >> 4) as usize * 4).min(s.len());
        let data = &s[hl..];
        let me = self.ip.unwrap_or([0; 4]);
        // 已关闭连接上迟到的 FIN：确认它
        if let Some(k) = self.closing.iter().position(|c| c.0 == dport && c.3 == src) {
            let (lp, rn, sn, peer) = self.closing[k];
            if flags & FIN != 0 {
                let rn2 = seq.wrapping_add(data.len() as u32).wrapping_add(1);
                let a = tcp_seg(me, peer, (lp, sport), sn, rn2, ACK, &[]);
                self.send_ip(peer, 6, &a);
                self.closing.remove(k);
            } else {
                let _ = rn;
            }
            return format!("TCP :{sport}→:{dport}（收尾）");
        }
        let Some(r) = self.run.as_mut() else {
            return format!("TCP :{sport}→:{dport}（没有连接）");
        };
        if dport != r.sport || src != r.ip {
            return format!("TCP :{sport}→:{dport}（不是当前连接）");
        }
        if flags & RST != 0 {
            let why = if r.st == Js::SynSent {
                "连接被拒（板子没在 80 端口听）"
            } else {
                "连接被对方重置"
            };
            self.finish_err(now, why);
            return format!("TCP RST :{sport}");
        }
        if r.st == Js::SynSent {
            if flags & (SYN | ACK) == SYN | ACK && ack == r.iss.wrapping_add(1) {
                r.rcv_nxt = seq.wrapping_add(1);
                r.snd_una = ack;
                r.st = Js::Est;
                r.tries = 0;
                // 握手第三步的 ACK 与请求数据合在一段里发
                self.send_req(now);
                return "TCP SYN-ACK → 发请求".into();
            }
            return "TCP（等 SYN-ACK）".into();
        }
        if flags & ACK != 0 && ack.wrapping_sub(r.snd_una) as i32 > 0 {
            r.snd_una = ack;
            if r.snd_una == r.snd_nxt {
                // 请求的这一段已确认：剩下的接着发，否则只等回复
                let start = r.iss.wrapping_add(1);
                if (r.snd_una.wrapping_sub(start) as usize) < r.req.len() {
                    r.tries = 0;
                    self.send_req(now);
                    return "TCP ACK → 续发请求".into();
                }
                r.retry_at = r.deadline;
            }
        }
        let r = self.run.as_mut().unwrap();
        let mut fin = false;
        if seq == r.rcv_nxt {
            if !data.is_empty() {
                r.resp.extend_from_slice(data);
                r.rcv_nxt = r.rcv_nxt.wrapping_add(data.len() as u32);
            }
            if flags & FIN != 0 {
                r.rcv_nxt = r.rcv_nxt.wrapping_add(1);
                fin = true;
            }
        }
        let n = data.len();
        if n > 0 || flags & FIN != 0 {
            let a = tcp_seg(me, r.ip, (r.sport, sport), r.snd_nxt, r.rcv_nxt, ACK, &[]);
            let ip = r.ip;
            self.send_ip(ip, 6, &a);
        }
        if fin || self.response_complete() {
            self.finish_ok(now, fin);
        }
        format!("TCP :{sport} {n}B{}", if fin { " FIN" } else { "" })
    }

    fn response_complete(&self) -> bool {
        let Some(r) = &self.run else { return false };
        let Some(h) = r.resp.windows(4).position(|w| w == b"\r\n\r\n") else {
            return false;
        };
        let head = String::from_utf8_lossy(&r.resp[..h]).to_ascii_lowercase();
        let cl = head
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse::<usize>().ok());
        match cl {
            Some(n) => r.resp.len() >= h + 4 + n,
            None => false,
        }
    }

    fn finish_ok(&mut self, now: u64, got_fin: bool) {
        let r = self.run.take().unwrap();
        let me = self.ip.unwrap_or([0; 4]);
        // 主动关闭：发 FIN；对方的 FIN 若还没到，留在 closing 里等着确认
        let f = tcp_seg(
            me,
            r.ip,
            (r.sport, 80),
            r.snd_nxt,
            r.rcv_nxt,
            FIN | ACK,
            &[],
        );
        self.send_ip(r.ip, 6, &f);
        if !got_fin {
            self.closing
                .push((r.sport, r.rcv_nxt, r.snd_nxt.wrapping_add(1), r.ip));
            if self.closing.len() > 8 {
                self.closing.remove(0);
            }
        }
        let text = String::from_utf8_lossy(&r.resp).into_owned();
        let (head, body) = match text.find("\r\n\r\n") {
            Some(i) => (&text[..i], &text[i + 4..]),
            None => (text.as_str(), ""),
        };
        let status = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let location = head
            .lines()
            .find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.trim()
                    .eq_ignore_ascii_case("location")
                    .then(|| v.trim().to_string())
            })
            .unwrap_or_default();
        let url = format!("http://{}{}", r.host, r.path);
        let mut p = Page {
            method: r.job.method.clone(),
            url: url.clone(),
            status,
            location: location.clone(),
            body_len: body.len(),
            ..Default::default()
        };
        summarize(&mut p, body);
        let mut line = format!("{} {url} → {status}", p.method);
        if !location.is_empty() {
            line.push_str(&format!(" 跳转 {location}"));
        }
        if !p.title.is_empty() {
            line.push_str(&format!("「{}」", p.title));
        }
        if !p.fields.is_empty() {
            line.push_str(&format!(
                " 表单 {} {} 字段 {}",
                p.form_method,
                p.form_action,
                p.fields.join(", ")
            ));
        }
        if !p.text.is_empty() {
            line.push_str(&format!(" 正文：{}", p.text));
        }
        self.note(now, line);
        if r.job.probe {
            if status == 204 {
                self.captive = Some(None);
                self.note(now, "联网探测通过：可以上网".into());
            } else {
                let portal = if location.is_empty() {
                    format!("http://{}/", ip_str(&self.gw))
                } else {
                    location
                };
                self.note(
                    now,
                    format!("需要登录此网络（探测得到 {status}，不是 204）→ 登录页 {portal}"),
                );
                self.captive = Some(Some(portal.clone()));
                if self.auto_open {
                    self.push_job("GET", &portal, "", false);
                }
            }
        } else if p.form_method == "POST" {
            if let Some(body) = self.auto_post.take() {
                let act = if p.form_action.is_empty() {
                    r.path.clone()
                } else {
                    p.form_action.clone()
                };
                self.push_job("POST", &act, &body, false);
            }
        }
        self.pages.push(p);
        if self.pages.len() > 20 {
            self.pages.remove(0);
        }
        self.kick = true;
    }

    fn finish_err(&mut self, now: u64, why: &str) {
        let r = self.run.take().unwrap();
        let url = format!("http://{}{}", r.host, r.path);
        self.note(now, format!("{} {url}：{why}", r.job.method));
        if r.job.probe {
            // 探测失败（多半是固件没做 DNS）：手机只会提示「此网络无法上网」，不弹登录页
            self.captive = Some(None);
            self.note(
                now,
                "联网探测失败：手机会提示「此网络无法访问互联网」，不会自动弹登录页".into(),
            );
            if self.auto_open {
                let u = format!("http://{}/", ip_str(&self.gw));
                self.push_job("GET", &u, "", false);
            }
        }
        self.pages.push(Page {
            method: r.job.method,
            url,
            error: why.into(),
            ..Default::default()
        });
        self.kick = true;
    }

    /// 芯片复位：热点会消失，手机按信标丢失处理（之后热点再出现会自动重连）
    pub fn chip_reset(&mut self, now: u64) {
        if self.link == Link::Up {
            self.last_beacon = self.last_beacon.min(now);
        }
        self.kick = true;
    }

    /// 给网页的手机状态（JSON）
    pub fn json(&self) -> String {
        fn esc(s: &str) -> String {
            let mut o = String::with_capacity(s.len() + 2);
            o.push('"');
            for c in s.chars() {
                match c {
                    '"' => o.push_str("\\\""),
                    '\\' => o.push_str("\\\\"),
                    '\n' => o.push_str("\\n"),
                    '\r' => {}
                    c if (c as u32) < 0x20 => o.push(' '),
                    c => o.push(c),
                }
            }
            o.push('"');
            o
        }
        let seen: Vec<String> = self
            .seen
            .iter()
            .map(|b| {
                format!(
                    "{{\"ssid\":{},\"bssid\":\"{}\",\"ch\":{},\"wpa2\":{}}}",
                    esc(&b.ssid),
                    frame::mac_str(&b.bssid),
                    b.channel,
                    b.privacy
                )
            })
            .collect();
        let pages: Vec<String> = self
            .pages
            .iter()
            .map(|p| {
                format!(
                    "{{\"method\":{},\"url\":{},\"status\":{},\"location\":{},\"title\":{},\"text\":{},\"action\":{},\"form_method\":{},\"fields\":[{}],\"len\":{},\"error\":{}}}",
                    esc(&p.method),
                    esc(&p.url),
                    p.status,
                    esc(&p.location),
                    esc(&p.title),
                    esc(&p.text),
                    esc(&p.form_action),
                    esc(&p.form_method),
                    p.fields.iter().map(|f| esc(f)).collect::<Vec<_>>().join(","),
                    p.body_len,
                    esc(&p.error)
                )
            })
            .collect();
        let log: Vec<String> = self
            .log
            .iter()
            .rev()
            .take(40)
            .rev()
            .map(|(t, s)| format!("[{},{}]", t / 1000, esc(s)))
            .collect();
        let captive = match &self.captive {
            None => "null".to_string(),
            Some(None) => "false".to_string(),
            Some(Some(u)) => esc(u),
        };
        format!(
            "{{\"link\":\"{}\",\"ssid\":{},\"ip\":{},\"gw\":\"{}\",\"captive\":{},\"seen\":[{}],\"pages\":[{}],\"log\":[{}],\"busy\":{}}}",
            self.link.name(),
            esc(&self.ssid),
            self.ip.map_or("null".to_string(), |i| format!("\"{}\"", ip_str(&i))),
            ip_str(&self.gw),
            captive,
            seen.join(","),
            pages.join(","),
            log.join(","),
            self.run.is_some() || !self.jobs.is_empty()
        )
    }
}
