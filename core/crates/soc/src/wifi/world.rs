//! 虚拟无线世界：几个 AP，对模拟芯片发出的帧做出反应（探测响应、认证、关联……）。
//! 世界只认帧，不关心芯片内部；它产出"空中到达"的帧，由 MAC 模型写进接收描述符。

use super::frame::{self, fc, Mac};
use super::net::{self, Eth};
use super::phone::Phone;
use super::wpa::{self, Authenticator};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Auth {
    Open,
    Wpa2Psk,
}

#[derive(Clone, Debug)]
pub struct Ap {
    pub ssid: String,
    pub bssid: Mac,
    pub channel: u8,
    pub rssi: i8,
    pub auth: Auth,
    pub passphrase: String,
}

/// 一帧"空中到达"的数据：何时（相对现在的微秒）、内容（不含 FCS）、信号
pub struct Air {
    pub delay_us: u64,
    pub frame: Vec<u8>,
    pub rssi: i8,
    pub channel: u8,
    /// 发给芯片的哪个接口：false = STA（接口 0），true = 固件自建热点（接口 1，C-02 虚拟手机发来的帧）
    pub ap_if: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StaState {
    Idle,
    Authed,
    Assoc,
}

pub struct World {
    pub aps: Vec<Ap>,
    seq: u16,
    /// 模拟芯片当前的信道（从它发出的探测请求的 DS 元素推断；连上后取所连 AP 的信道）
    pub channel: u8,
    /// 与每个 AP 的连接状态（按 aps 下标）
    pub sta: Vec<StaState>,
    pub sta_mac: Mac,
    pub aid: u16,
    pub net: net::Net,
    /// WPA2 AP 的认证方（按 aps 下标，首次关联时创建：PBKDF2 要算 4096 轮）
    pub wpa: Vec<Option<Authenticator>>,
    /// 天线被金属件 / 电池挡住的衰减（dB，估算，P2-11）：双向都减，所以 AP 也听不清芯片
    pub antenna_loss_db: i32,
    /// 虚拟手机（C-02）：只有配了手机（--ap-phone / 网页手机面板）才有；没有时世界与以前逐字节相同
    pub phone: Option<Phone>,
    /// 固件自建热点的 MAC（从芯片发出的信标学来）：a2 是它的帧走手机，不当作 STA 接口的帧
    pub ap_mac: Option<Mac>,
}

/// 虚拟家用路由器（配网的目标）：手机启用时才出现，口令固定
pub const ROUTER_SSID: &str = "MyHome";
pub const ROUTER_PASS: &str = "12345678";
/// 手机启用时虚拟路由器网段改为 192.168.5.0/24：固件热点默认占着 192.168.4.0/24（APSTA 时两边不能重叠）
pub const ROUTER_GW: [u8; 4] = [192, 168, 5, 1];
pub const ROUTER_STA_IP: [u8; 4] = [192, 168, 5, 100];

/// 低于它扫描也收不到（管理帧 1 Mbps 的接收灵敏度量级，估算）
pub const SCAN_MIN_DBM: i32 = -92;
/// 低于它认证 / 关联 / 数据收发不成（估算：真机在 -80 dBm 附近开始频繁重传、掉线）
pub const LINK_MIN_DBM: i32 = -82;

impl Default for World {
    fn default() -> Self {
        let aps = vec![
            ap(
                "TryBoard-WiFi",
                [0x02, 0x54, 0x42, 0xa0, 0x00, 0x01],
                6,
                -42,
                Auth::Open,
                "",
            ),
            ap(
                "TryBoard-WPA2",
                [0x02, 0x54, 0x42, 0xa0, 0x00, 0x02],
                1,
                -55,
                Auth::Wpa2Psk,
                "tryboard123",
            ),
            ap(
                "Neighbor-5G-Ext",
                [0x02, 0x54, 0x42, 0xa0, 0x00, 0x03],
                11,
                -78,
                Auth::Wpa2Psk,
                "x",
            ),
            ap(
                "CoffeeShop",
                [0x02, 0x54, 0x42, 0xa0, 0x00, 0x04],
                6,
                -70,
                Auth::Open,
                "",
            ),
        ];
        let n = aps.len();
        World {
            aps,
            seq: 0,
            channel: 1,
            sta: vec![StaState::Idle; n],
            sta_mac: [0; 6],
            aid: 1,
            net: Default::default(),
            wpa: (0..n).map(|_| None).collect(),
            antenna_loss_db: 0,
            phone: None,
            ap_mac: None,
        }
    }
}

fn ap(ssid: &str, bssid: Mac, channel: u8, rssi: i8, auth: Auth, pw: &str) -> Ap {
    Ap {
        ssid: ssid.into(),
        bssid,
        channel,
        rssi,
        auth,
        passphrase: pw.into(),
    }
}

/// 802.11b/g 支持速率（1/2/5.5/11 为基本速率）与扩展速率
const RATES: [u8; 8] = [0x82, 0x84, 0x8b, 0x96, 0x0c, 0x12, 0x18, 0x24];
const EXT_RATES: [u8; 4] = [0x30, 0x48, 0x60, 0x6c];
/// 四次握手消息 1 在关联响应之后多久发出（微秒）
const EAPOL_DELAY_US: u64 = 3000;

/// RSN：版本 1、组 / 成对加密 CCMP、AKM PSK、能力 0x000c
const RSN_IE: [u8; 20] = [
    0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f,
    0xac, 0x02, 0x0c, 0x00,
];

impl World {
    /// 芯片这边收到的这个 AP 的信号强度（dBm）：AP 发射的 RSSI 减去天线遮挡
    /// 启用虚拟手机：加上虚拟路由器 MyHome（WPA2），虚拟网络换到 192.168.5.0/24。幂等
    pub fn enable_phone(&mut self, phone: Phone) {
        if !self.aps.iter().any(|a| a.ssid == ROUTER_SSID) {
            self.aps.push(ap(
                ROUTER_SSID,
                [0x02, 0x54, 0x42, 0xa0, 0x00, 0x05],
                6,
                -50,
                Auth::Wpa2Psk,
                ROUTER_PASS,
            ));
            self.sta.push(StaState::Idle);
            self.wpa.push(None);
        }
        // 芯片已经从缺省路由器拿到地址（STA 示例中途打开手机）：不搬网段，免得芯片手里的地址失效
        if !self.net.leased {
            self.net.gw = ROUTER_GW;
            self.net.sta_ip = ROUTER_STA_IP;
        }
        self.phone = Some(phone);
    }

    pub fn rssi(&self, i: usize) -> i8 {
        (self.aps[i].rssi as i32 - self.antenna_loss_db).clamp(-127, 0) as i8
    }

    /// 信号够不够完成认证 / 关联 / 数据收发（链路是对称的：芯片听不清 AP，AP 也听不清芯片）
    fn linkable(&self, i: usize) -> bool {
        self.rssi(i) as i32 >= LINK_MIN_DBM
    }

    fn weak(&self, i: usize, what: &str) -> String {
        format!(
            "{what} → {}：信号 {} dBm 低于 {LINK_MIN_DBM} dBm，AP 没听到（天线遮挡 {} dB，估算）",
            self.aps[i].ssid,
            self.rssi(i),
            self.antenna_loss_db
        )
    }

    fn next_seq(&mut self) -> u16 {
        self.seq = self.seq.wrapping_add(1) & 0xfff;
        self.seq
    }

    /// 信标 / 探测响应的帧体
    fn bss_frame(&mut self, i: usize, subtype: u8, da: &Mac, tsf_us: u64) -> Vec<u8> {
        let seq = self.next_seq();
        let a = &self.aps[i];
        let mut f = frame::mgmt_hdr(subtype, da, &a.bssid, &a.bssid, seq);
        f.extend_from_slice(&tsf_us.to_le_bytes());
        f.extend_from_slice(&100u16.to_le_bytes()); // 信标间隔 100 TU
        let mut cap: u16 = 0x0001 | 0x0400; // ESS、短时隙
        if a.auth != Auth::Open {
            cap |= 0x0010; // Privacy
        }
        f.extend_from_slice(&cap.to_le_bytes());
        frame::ie(&mut f, 0, a.ssid.as_bytes());
        frame::ie(&mut f, 1, &RATES);
        frame::ie(&mut f, 3, &[a.channel]);
        if subtype == fc::BEACON {
            frame::ie(&mut f, 5, &[0, 1, 0, 0]); // TIM
        }
        frame::ie(&mut f, 42, &[0]); // ERP
        if a.auth == Auth::Wpa2Psk {
            frame::ie(&mut f, 48, &RSN_IE);
        }
        frame::ie(&mut f, 50, &EXT_RATES);
        f
    }

    pub fn beacon(&mut self, i: usize, tsf_us: u64) -> Air {
        let f = self.bss_frame(i, fc::BEACON, &frame::BROADCAST, tsf_us);
        Air {
            delay_us: 0,
            frame: f,
            rssi: self.rssi(i),
            channel: self.aps[i].channel,
            ap_if: false,
        }
    }

    /// 芯片发出一帧；返回描述（给日志）与空中的回应，以及这帧是否会被确认（单播且对方存在）
    pub fn on_tx(&mut self, f: &[u8], tsf_us: u64) -> (String, Vec<Air>, bool) {
        let Some(h) = frame::parse(f) else {
            return ("短帧".into(), vec![], false);
        };
        // 固件热点（AP 接口）发的帧：信标学 MAC，其余给手机；不碰 STA 接口的状态
        if h.fc0 == fc::BEACON && self.ap_mac != Some(h.a2) && self.phone.is_some() {
            self.ap_mac = Some(h.a2);
        }
        if self.ap_mac == Some(h.a2) {
            let loss = self.antenna_loss_db;
            let Some(p) = self.phone.as_mut() else {
                return ("固件热点的帧（没有手机）".into(), vec![], false);
            };
            let (d, acked) = p.on_frame(f, tsf_us);
            let out = Self::phone_air(p, loss);
            return (d, out, acked);
        }
        let mut out = Vec::new();
        let body = &f[h.body.min(f.len())..];
        let unicast = h.a1[0] & 1 == 0;
        let target = self.aps.iter().position(|a| a.bssid == h.a1);
        let acked = unicast && target.is_some_and(|i| self.linkable(i));
        self.sta_mac = h.a2;
        let desc = match h.fc0 {
            fc::PROBE_REQ => {
                let ssid = frame::find_ie(body, 0).unwrap_or(&[]).to_vec();
                if let Some(ds) = frame::find_ie(body, 3) {
                    if let Some(c) = ds.first() {
                        self.channel = *c;
                    }
                }
                let ch = self.channel;
                for i in 0..self.aps.len() {
                    let a = &self.aps[i];
                    if a.channel != ch
                        || (!ssid.is_empty() && ssid != a.ssid.as_bytes())
                        || (self.rssi(i) as i32) < SCAN_MIN_DBM
                    {
                        continue;
                    }
                    let (rssi, channel) = (self.rssi(i), a.channel);
                    let resp = self.bss_frame(i, fc::PROBE_RESP, &h.a2, tsf_us);
                    out.push(Air {
                        delay_us: 600 + 400 * i as u64,
                        frame: resp,
                        rssi,
                        channel,
                        ap_if: false,
                    });
                }
                format!(
                    "探测请求 ch{} ssid={:?} → {} 个响应",
                    ch,
                    String::from_utf8_lossy(&ssid),
                    out.len()
                )
            }
            fc::AUTH => {
                let Some(i) = target else {
                    return ("认证 → 未知 BSSID".into(), out, false);
                };
                if !self.linkable(i) {
                    return (self.weak(i, "认证"), out, false);
                }
                self.channel = self.aps[i].channel;
                let alg = u16::from_le_bytes([body[0], body[1]]);
                let seq = self.next_seq();
                let a = &self.aps[i];
                let mut r = frame::mgmt_hdr(fc::AUTH, &h.a2, &a.bssid, &a.bssid, seq);
                // 开放系统认证第 2 步，状态 0 成功
                r.extend_from_slice(&alg.to_le_bytes());
                r.extend_from_slice(&2u16.to_le_bytes());
                r.extend_from_slice(&0u16.to_le_bytes());
                let (rssi, channel) = (self.rssi(i), self.aps[i].channel);
                out.push(Air {
                    delay_us: 800,
                    frame: r,
                    rssi,
                    channel,
                    ap_if: false,
                });
                self.sta[i] = StaState::Authed;
                format!("认证 → {}（开放系统，成功）", self.aps[i].ssid)
            }
            fc::ASSOC_REQ => {
                let Some(i) = target else {
                    return ("关联 → 未知 BSSID".into(), out, false);
                };
                if !self.linkable(i) {
                    return (self.weak(i, "关联"), out, false);
                }
                let seq = self.next_seq();
                let aid = self.aid;
                let a = &self.aps[i];
                let mut r = frame::mgmt_hdr(fc::ASSOC_RESP, &h.a2, &a.bssid, &a.bssid, seq);
                let mut cap: u16 = 0x0001 | 0x0400;
                if a.auth != Auth::Open {
                    cap |= 0x0010;
                }
                r.extend_from_slice(&cap.to_le_bytes());
                r.extend_from_slice(&0u16.to_le_bytes()); // 状态 成功
                r.extend_from_slice(&(aid | 0xc000).to_le_bytes());
                frame::ie(&mut r, 1, &RATES);
                frame::ie(&mut r, 50, &EXT_RATES);
                let (channel, wpa2) = (a.channel, a.auth == Auth::Wpa2Psk);
                let rssi = self.rssi(i);
                out.push(Air {
                    delay_us: 800,
                    frame: r,
                    rssi,
                    channel,
                    ap_if: false,
                });
                self.sta[i] = StaState::Assoc;
                if wpa2 {
                    // 关联成功即由 AP 发起四次握手（消息 1）
                    let m1 = self.auth(i).start(h.a2, tsf_us + EAPOL_DELAY_US);
                    let f = self.eapol_frame(i, &m1);
                    out.push(Air {
                        delay_us: EAPOL_DELAY_US,
                        frame: f,
                        rssi,
                        channel,
                        ap_if: false,
                    });
                }
                format!(
                    "关联 → {}（AID {}）{}",
                    self.aps[i].ssid,
                    aid,
                    if wpa2 {
                        "，发起四次握手 1/4"
                    } else {
                        ""
                    }
                )
            }
            fc::DEAUTH | fc::DISASSOC => {
                if let Some(i) = target {
                    self.sta[i] = StaState::Idle;
                    if let Some(a) = self.wpa[i].as_mut() {
                        a.state = wpa::Hs::Idle;
                    }
                }
                "去认证 / 去关联".into()
            }
            fc::NULL | fc::QOS_NULL => "空数据帧（省电状态通告）".into(),
            x if x & 0x0c == 0x08 => {
                let Some(i) = target else {
                    return ("数据帧 → 未知 BSSID".into(), out, false);
                };
                if !self.linkable(i) {
                    return (self.weak(i, "数据帧"), out, false);
                }
                if self.sta[i] != StaState::Assoc {
                    return ("数据帧（未关联，丢弃）".into(), out, acked);
                }
                let wpa2 = self.aps[i].auth == Auth::Wpa2Psk;
                let mut plain = f.to_vec();
                if h.fc1 & 0x40 != 0 {
                    let Some(a) = self.wpa[i].as_mut().filter(|a| a.authorized()) else {
                        return ("加密数据帧（还没有密钥，丢弃）".into(), out, acked);
                    };
                    match a.decrypt(f) {
                        Ok(p) => plain = p,
                        Err(e) => return (format!("加密数据帧：{e}，丢弃"), out, acked),
                    }
                }
                let body = &plain[h.body.min(plain.len())..];
                if body.len() < 8 || body[..6] != [0xaa, 0xaa, 0x03, 0, 0, 0] {
                    return ("数据帧（非 LLC/SNAP）".into(), out, acked);
                }
                let ethertype = u16::from_be_bytes([body[6], body[7]]);
                if wpa2 && ethertype == wpa::ETH_EAPOL {
                    let Some(a) = self.wpa[i].as_mut() else {
                        return ("EAPOL（无认证方）".into(), out, acked);
                    };
                    let (note, reply) = a.on_eapol(&body[8..], tsf_us);
                    if let Some(r) = reply {
                        let (rssi, channel) = (self.rssi(i), self.aps[i].channel);
                        let fr = self.eapol_frame(i, &r);
                        out.push(Air {
                            delay_us: 1000,
                            frame: fr,
                            rssi,
                            channel,
                            ap_if: false,
                        });
                    }
                    return (note, out, acked);
                }
                if wpa2
                    && (h.fc1 & 0x40 == 0 || !self.wpa[i].as_ref().is_some_and(|a| a.authorized()))
                {
                    // 端口没放行（或明文混进加密网络）：真 AP 同样丢弃
                    return (
                        format!("数据帧 0x{ethertype:04x}（WPA2 端口未放行 / 未加密，丢弃）"),
                        out,
                        acked,
                    );
                }
                let eth = Eth {
                    dst: h.a3,
                    src: h.a2,
                    ethertype,
                    payload: body[8..].to_vec(),
                };
                let before = self.net.log.len();
                let replies = self.net.on_eth(&eth, tsf_us);
                let (rssi, channel, bssid) = (self.rssi(i), self.aps[i].channel, self.aps[i].bssid);
                for (k, r) in replies.into_iter().enumerate() {
                    let mut f = self.data_from_ds(&r, &bssid);
                    if let Some(a) = self.wpa[i].as_mut().filter(|a| wpa2 && a.authorized()) {
                        f = a.encrypt(&f);
                    }
                    out.push(Air {
                        delay_us: 300 + 200 * k as u64,
                        frame: f,
                        rssi,
                        channel,
                        ap_if: false,
                    });
                }
                let notes: Vec<String> = self.net.log[before..].to_vec();
                format!(
                    "数据帧 {} 0x{:04x} {}B{}",
                    frame::mac_str(&eth.dst),
                    eth.ethertype,
                    eth.payload.len(),
                    if notes.is_empty() {
                        String::new()
                    } else {
                        format!("：{}", notes.join("；"))
                    }
                )
            }
            x => format!("帧 FC=0x{x:02x}"),
        };
        (desc, out, acked)
    }

    /// 以太网帧 → AP 发出的数据帧（FromDS：a1 目的、a2 BSSID、a3 源）
    fn data_from_ds(&mut self, e: &Eth, bssid: &Mac) -> Vec<u8> {
        let seq = self.next_seq();
        let mut f = vec![fc::DATA, 0x02, 0, 0];
        f.extend_from_slice(&e.dst);
        f.extend_from_slice(bssid);
        f.extend_from_slice(&e.src);
        f.extend_from_slice(&(seq << 4).to_le_bytes());
        f.extend_from_slice(&[0xaa, 0xaa, 0x03, 0, 0, 0]);
        f.extend_from_slice(&e.ethertype.to_be_bytes());
        f.extend_from_slice(&e.payload);
        f
    }

    fn auth(&mut self, i: usize) -> &mut Authenticator {
        let a = &self.aps[i];
        let mut rsn = vec![48, RSN_IE.len() as u8];
        rsn.extend_from_slice(&RSN_IE);
        let (pw, ssid, bssid) = (a.passphrase.clone(), a.ssid.clone(), a.bssid);
        self.wpa[i].get_or_insert_with(|| Authenticator::new(&pw, ssid.as_bytes(), bssid, &rsn))
    }

    /// AP → 终端的 EAPOL 数据帧（明文，LLC/SNAP 以太类型 0x888E）
    fn eapol_frame(&mut self, i: usize, eapol: &[u8]) -> Vec<u8> {
        let bssid = self.aps[i].bssid;
        let e = Eth {
            dst: self.sta_mac,
            src: bssid,
            ethertype: wpa::ETH_EAPOL,
            payload: eapol.to_vec(),
        };
        self.data_from_ds(&e, &bssid)
    }

    /// 认证方的重传 / 超时定时器（TSF 微秒）
    pub fn next_timer(&self) -> Option<u64> {
        let ap = self
            .wpa
            .iter()
            .flatten()
            .filter_map(|a| a.next_timer())
            .min();
        match self.phone.as_ref().and_then(|p| p.next_timer()) {
            Some(t) => Some(ap.map_or(t, |a| a.min(t))),
            None => ap,
        }
    }

    /// 手机要发的帧：信号按天线遮挡衰减（链路对称）
    fn phone_air(p: &mut Phone, loss: i32) -> Vec<Air> {
        let mut v = p.take_out();
        for a in &mut v {
            a.rssi = (a.rssi as i32 - loss).clamp(-127, 0) as i8;
        }
        v
    }

    /// 推进定时器：重发 EAPOL 消息，或重试用完时发去认证（原因 15 = 四次握手超时）
    pub fn poll(&mut self, tsf_us: u64) -> (Vec<Air>, Vec<String>) {
        let (mut out, mut log) = (Vec::new(), Vec::new());
        let loss = self.antenna_loss_db;
        if let Some(p) = self.phone.as_mut() {
            if p.next_timer().is_some_and(|t| t <= tsf_us) {
                p.poll(tsf_us);
                out.extend(Self::phone_air(p, loss));
            }
        }
        for i in 0..self.aps.len() {
            let Some(t) = self.wpa[i].as_mut().and_then(|a| a.poll(tsf_us)) else {
                continue;
            };
            let (rssi, channel, bssid) = (self.rssi(i), self.aps[i].channel, self.aps[i].bssid);
            match t {
                wpa::Timer::Resend(m) => {
                    let f = self.eapol_frame(i, &m);
                    out.push(Air {
                        delay_us: 0,
                        frame: f,
                        rssi,
                        channel,
                        ap_if: false,
                    });
                    log.push(format!("{}：四次握手没等到回应，重发", self.aps[i].ssid));
                }
                wpa::Timer::Timeout => {
                    let seq = self.next_seq();
                    let sta = self.sta_mac;
                    let mut f = frame::mgmt_hdr(fc::DEAUTH, &sta, &bssid, &bssid, seq);
                    f.extend_from_slice(&15u16.to_le_bytes());
                    out.push(Air {
                        delay_us: 0,
                        frame: f,
                        rssi,
                        channel,
                        ap_if: false,
                    });
                    self.sta[i] = StaState::Idle;
                    log.push(format!(
                        "{}：四次握手超时，发去认证（原因 15）",
                        self.aps[i].ssid
                    ));
                }
            }
        }
        (out, log)
    }

    /// 已关联的 AP（信标要持续发，否则芯片会判定信标丢失而断线）
    pub fn associated(&self) -> Option<usize> {
        self.sta.iter().position(|s| *s == StaState::Assoc)
    }
}
