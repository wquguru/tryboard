//! Virtual wireless world: a few APs reacting to the chip's frames (probe response, auth, association, ...).
//! It only sees frames, not chip internals; its 'arrived over the air' frames are written into RX descriptors by the MAC model.

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

/// A frame arriving over the air: when (us from now), content (no FCS), signal
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
    /// The chip's current channel (inferred from the DS element of its probe requests; the AP's channel once connected)
    pub channel: u8,
    /// Connection state with each AP (indexed like aps)
    pub sta: Vec<StaState>,
    pub sta_mac: Mac,
    pub aid: u16,
    pub net: net::Net,
    /// Authenticator per WPA2 AP (indexed like aps, created on first association since PBKDF2 needs 4096 rounds)
    pub wpa: Vec<Option<Authenticator>>,
    /// Antenna attenuation from metal parts / battery (dB, estimate, P2-11); applied both ways so the AP hears the chip worse too
    pub antenna_loss_db: i32,
    /// 虚拟手机（C-02）：只有配了手机（--ap-phone / 网页手机面板）才有；没有时世界与以前逐字节相同
    pub phone: Option<Phone>,
    /// 固件自建热点的 MAC（从芯片发出的信标学来）：a2 是它的帧走手机，不当作 STA 接口的帧
    pub ap_mac: Option<Mac>,
}

/// Virtual home router (the provisioning target): appears only with the phone, fixed passphrase
pub const ROUTER_SSID: &str = "MyHome";
pub const ROUTER_PASS: &str = "12345678";
/// With the phone the router moves to 192.168.5.0/24: the firmware SoftAP holds 192.168.4.0/24
/// by default and the two must not overlap in APSTA
pub const ROUTER_GW: [u8; 4] = [192, 168, 5, 1];
pub const ROUTER_STA_IP: [u8; 4] = [192, 168, 5, 100];

/// Below this even scanning fails (roughly 1 Mbps management-frame sensitivity, estimate)
pub const SCAN_MIN_DBM: i32 = -92;
/// Below this auth / association / data fail (estimate: real chips retry and drop often around -80 dBm)
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

/// 802.11b/g supported rates (1/2/5.5/11 basic) and extended rates
const RATES: [u8; 8] = [0x82, 0x84, 0x8b, 0x96, 0x0c, 0x12, 0x18, 0x24];
const EXT_RATES: [u8; 4] = [0x30, 0x48, 0x60, 0x6c];
/// Delay of 4-way handshake message 1 after the association response (us)
const EAPOL_DELAY_US: u64 = 3000;

/// RSN: version 1, group / pairwise CCMP, AKM PSK, capabilities 0x000c
const RSN_IE: [u8; 20] = [
    0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f,
    0xac, 0x02, 0x0c, 0x00,
];

impl World {
    /// Enable the virtual phone: add router MyHome (WPA2) and move the network to 192.168.5.0/24. Idempotent
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
        // Chip already leased from the default router (phone turned on mid STA example): keep the subnet
        // so its address stays valid
        if !self.net.leased {
            self.net.gw = ROUTER_GW;
            self.net.sta_ip = ROUTER_STA_IP;
        }
        self.phone = Some(phone);
    }

    /// Signal of this AP as seen by the chip (dBm): AP RSSI minus antenna blockage
    pub fn rssi(&self, i: usize) -> i8 {
        (self.aps[i].rssi as i32 - self.antenna_loss_db).clamp(-127, 0) as i8
    }

    /// Whether the signal suffices for auth / association / data (the link is symmetric)
    fn linkable(&self, i: usize) -> bool {
        self.rssi(i) as i32 >= LINK_MIN_DBM
    }

    fn weak(&self, i: usize, what: &str) -> String {
        format!(
            "{what} → {}: signal {} dBm below {LINK_MIN_DBM} dBm, AP did not hear it (antenna loss {} dB, estimate)",
            self.aps[i].ssid,
            self.rssi(i),
            self.antenna_loss_db
        )
    }

    fn next_seq(&mut self) -> u16 {
        self.seq = self.seq.wrapping_add(1) & 0xfff;
        self.seq
    }

    /// Beacon / probe response body
    fn bss_frame(&mut self, i: usize, subtype: u8, da: &Mac, tsf_us: u64) -> Vec<u8> {
        let seq = self.next_seq();
        let a = &self.aps[i];
        let mut f = frame::mgmt_hdr(subtype, da, &a.bssid, &a.bssid, seq);
        f.extend_from_slice(&tsf_us.to_le_bytes());
        f.extend_from_slice(&100u16.to_le_bytes()); // Beacon interval 100 TU
        let mut cap: u16 = 0x0001 | 0x0400; // ESS, short slot time
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

    /// The chip sent a frame; returns a description (for the log), air replies, and whether it gets ACKed (unicast to an existing peer)
    pub fn on_tx(&mut self, f: &[u8], tsf_us: u64) -> (String, Vec<Air>, bool) {
        let Some(h) = frame::parse(f) else {
            return ("short frame".into(), vec![], false);
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
                    "probe request ch{} ssid={:?} → {} responses",
                    ch,
                    String::from_utf8_lossy(&ssid),
                    out.len()
                )
            }
            fc::AUTH => {
                let Some(i) = target else {
                    return ("auth → unknown BSSID".into(), out, false);
                };
                if !self.linkable(i) {
                    return (self.weak(i, "auth"), out, false);
                }
                self.channel = self.aps[i].channel;
                let alg = u16::from_le_bytes([body[0], body[1]]);
                let seq = self.next_seq();
                let a = &self.aps[i];
                let mut r = frame::mgmt_hdr(fc::AUTH, &h.a2, &a.bssid, &a.bssid, seq);
                // Open system authentication step 2, status 0 success
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
                format!("auth → {} (open system, success)", self.aps[i].ssid)
            }
            fc::ASSOC_REQ => {
                let Some(i) = target else {
                    return ("assoc → unknown BSSID".into(), out, false);
                };
                if !self.linkable(i) {
                    return (self.weak(i, "assoc"), out, false);
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
                r.extend_from_slice(&0u16.to_le_bytes()); // Status success
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
                    // On successful association the AP starts the 4-way handshake (message 1)
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
                    "assoc → {} (AID {}){}",
                    self.aps[i].ssid,
                    aid,
                    if wpa2 {
                        ", starting 4-way handshake 1/4"
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
                "deauth / disassoc".into()
            }
            fc::NULL | fc::QOS_NULL => "null data frame (power-save notice)".into(),
            x if x & 0x0c == 0x08 => {
                let Some(i) = target else {
                    return ("data frame → unknown BSSID".into(), out, false);
                };
                if !self.linkable(i) {
                    return (self.weak(i, "data frame"), out, false);
                }
                if self.sta[i] != StaState::Assoc {
                    return ("data frame (not associated, dropped)".into(), out, acked);
                }
                let wpa2 = self.aps[i].auth == Auth::Wpa2Psk;
                let mut plain = f.to_vec();
                if h.fc1 & 0x40 != 0 {
                    let Some(a) = self.wpa[i].as_mut().filter(|a| a.authorized()) else {
                        return (
                            "encrypted data frame (no key yet, dropped)".into(),
                            out,
                            acked,
                        );
                    };
                    match a.decrypt(f) {
                        Ok(p) => plain = p,
                        Err(e) => {
                            return (format!("encrypted data frame: {e}, dropped"), out, acked)
                        }
                    }
                }
                let body = &plain[h.body.min(plain.len())..];
                if body.len() < 8 || body[..6] != [0xaa, 0xaa, 0x03, 0, 0, 0] {
                    return ("data frame (not LLC/SNAP)".into(), out, acked);
                }
                let ethertype = u16::from_be_bytes([body[6], body[7]]);
                if wpa2 && ethertype == wpa::ETH_EAPOL {
                    let Some(a) = self.wpa[i].as_mut() else {
                        return ("EAPOL (no authenticator)".into(), out, acked);
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
                    // Port not authorized (or plaintext in an encrypted network): a real AP drops it too
                    return (
                        format!("data frame 0x{ethertype:04x} (WPA2 port closed / unencrypted, dropped)"),
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
                    "data frame {} 0x{:04x} {}B{}",
                    frame::mac_str(&eth.dst),
                    eth.ethertype,
                    eth.payload.len(),
                    if notes.is_empty() {
                        String::new()
                    } else {
                        format!(": {}", notes.join("; "))
                    }
                )
            }
            x => format!("frame FC=0x{x:02x}"),
        };
        (desc, out, acked)
    }

    /// Ethernet frame -> AP data frame (FromDS: a1 dest, a2 BSSID, a3 src)
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

    /// AP -> station EAPOL data frame (plaintext, LLC/SNAP ethertype 0x888E)
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

    /// Authenticator retransmit / timeout timer (TSF us)
    pub fn next_timer(&self) -> Option<u64> {
        let ap = self
            .wpa
            .iter()
            .flatten()
            .filter_map(|a| a.next_timer())
            .min();
        // 有排队要主动发的帧（真实网络的回复）：马上到期
        let ap = if self.net.pending.is_empty() {
            ap
        } else {
            Some(0)
        };
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

    /// Advance timers: resend EAPOL messages, or deauth once retries run out (reason 15 = 4-way handshake timeout)
    pub fn poll(&mut self, tsf_us: u64) -> (Vec<Air>, Vec<String>) {
        let (mut out, mut log) = (Vec::new(), Vec::new());
        let loss = self.antenna_loss_db;
        // 真实网络的回复（C-03）：经已关联的 AP 发给芯片（WPA2 已放行就加密）；没关联就丢掉
        if !self.net.pending.is_empty() {
            let pend = std::mem::take(&mut self.net.pending);
            let notes: Vec<String> = std::mem::take(&mut self.net.log);
            log.extend(notes);
            if let Some(i) = self.associated() {
                let (rssi, channel, bssid) = (self.rssi(i), self.aps[i].channel, self.aps[i].bssid);
                for (k, e) in pend.iter().enumerate() {
                    let mut f = self.data_from_ds(e, &bssid);
                    if let Some(a) = self.wpa[i].as_mut().filter(|a| a.authorized()) {
                        f = a.encrypt(&f);
                    }
                    out.push(Air {
                        delay_us: 200 * k as u64,
                        frame: f,
                        rssi,
                        channel,
                        ap_if: false,
                    });
                }
            }
        }
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
                    log.push(format!(
                        "{}: no reply to the 4-way handshake, resending",
                        self.aps[i].ssid
                    ));
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
                        "{}: 4-way handshake timed out, sending deauth (reason 15)",
                        self.aps[i].ssid
                    ));
                }
            }
        }
        (out, log)
    }

    /// Associated AP (beacons must keep coming or the chip declares beacon loss and disconnects)
    pub fn associated(&self) -> Option<usize> {
        self.sta.iter().position(|s| *s == StaState::Assoc)
    }
}
