//! 虚拟无线世界：几个 AP，对模拟芯片发出的帧做出反应（探测响应、认证、关联……）。
//! 世界只认帧，不关心芯片内部；它产出"空中到达"的帧，由 MAC 模型写进接收描述符。

use super::frame::{self, fc, Mac};

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
}

impl Default for World {
    fn default() -> Self {
        let aps = vec![
            ap("TryBoard-WiFi", [0x02, 0x54, 0x42, 0xa0, 0x00, 0x01], 6, -42, Auth::Open, ""),
            ap("TryBoard-WPA2", [0x02, 0x54, 0x42, 0xa0, 0x00, 0x02], 1, -55, Auth::Wpa2Psk, "tryboard123"),
            ap("Neighbor-5G-Ext", [0x02, 0x54, 0x42, 0xa0, 0x00, 0x03], 11, -78, Auth::Wpa2Psk, "x"),
            ap("CoffeeShop", [0x02, 0x54, 0x42, 0xa0, 0x00, 0x04], 6, -70, Auth::Open, ""),
        ];
        let n = aps.len();
        World { aps, seq: 0, channel: 1, sta: vec![StaState::Idle; n], sta_mac: [0; 6], aid: 1 }
    }
}

fn ap(ssid: &str, bssid: Mac, channel: u8, rssi: i8, auth: Auth, pw: &str) -> Ap {
    Ap { ssid: ssid.into(), bssid, channel, rssi, auth, passphrase: pw.into() }
}

/// 802.11b/g 支持速率（1/2/5.5/11 为基本速率）与扩展速率
const RATES: [u8; 8] = [0x82, 0x84, 0x8b, 0x96, 0x0c, 0x12, 0x18, 0x24];
const EXT_RATES: [u8; 4] = [0x30, 0x48, 0x60, 0x6c];
/// RSN：版本 1、组 / 成对加密 CCMP、AKM PSK、能力 0x000c
const RSN_IE: [u8; 20] = [
    0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x02, 0x0c,
    0x00,
];

impl World {
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
        Air { delay_us: 0, frame: f, rssi: self.aps[i].rssi, channel: self.aps[i].channel }
    }

    /// 芯片发出一帧；返回描述（给日志）与空中的回应，以及这帧是否会被确认（单播且对方存在）
    pub fn on_tx(&mut self, f: &[u8], tsf_us: u64) -> (String, Vec<Air>, bool) {
        let Some(h) = frame::parse(f) else { return ("短帧".into(), vec![], false) };
        let mut out = Vec::new();
        let body = &f[h.body.min(f.len())..];
        let unicast = h.a1[0] & 1 == 0;
        let target = self.aps.iter().position(|a| a.bssid == h.a1);
        let acked = unicast && target.is_some();
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
                    if a.channel != ch || (!ssid.is_empty() && ssid != a.ssid.as_bytes()) {
                        continue;
                    }
                    let (rssi, channel) = (a.rssi, a.channel);
                    let resp = self.bss_frame(i, fc::PROBE_RESP, &h.a2, tsf_us);
                    out.push(Air { delay_us: 600 + 400 * i as u64, frame: resp, rssi, channel });
                }
                format!(
                    "探测请求 ch{} ssid={:?} → {} 个响应",
                    ch,
                    String::from_utf8_lossy(&ssid),
                    out.len()
                )
            }
            fc::AUTH => {
                let Some(i) = target else { return ("认证 → 未知 BSSID".into(), out, false) };
                self.channel = self.aps[i].channel;
                let alg = u16::from_le_bytes([body[0], body[1]]);
                let seq = self.next_seq();
                let a = &self.aps[i];
                let mut r = frame::mgmt_hdr(fc::AUTH, &h.a2, &a.bssid, &a.bssid, seq);
                // 开放系统认证第 2 步，状态 0 成功
                r.extend_from_slice(&alg.to_le_bytes());
                r.extend_from_slice(&2u16.to_le_bytes());
                r.extend_from_slice(&0u16.to_le_bytes());
                let (rssi, channel) = (a.rssi, a.channel);
                out.push(Air { delay_us: 800, frame: r, rssi, channel });
                self.sta[i] = StaState::Authed;
                format!("认证 → {}（开放系统，成功）", self.aps[i].ssid)
            }
            fc::ASSOC_REQ => {
                let Some(i) = target else { return ("关联 → 未知 BSSID".into(), out, false) };
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
                let (rssi, channel) = (a.rssi, a.channel);
                out.push(Air { delay_us: 800, frame: r, rssi, channel });
                self.sta[i] = StaState::Assoc;
                format!("关联 → {}（AID {}）", self.aps[i].ssid, aid)
            }
            fc::DEAUTH | fc::DISASSOC => {
                if let Some(i) = target {
                    self.sta[i] = StaState::Idle;
                }
                "去认证 / 去关联".into()
            }
            fc::NULL | fc::QOS_NULL => "空数据帧（省电状态通告）".into(),
            x if x & 0x0c == 0x08 => "数据帧".into(),
            x => format!("帧 FC=0x{x:02x}"),
        };
        (desc, out, acked)
    }

    /// 已关联的 AP（信标要持续发，否则芯片会判定信标丢失而断线）
    pub fn associated(&self) -> Option<usize> {
        self.sta.iter().position(|s| *s == StaState::Assoc)
    }
}
