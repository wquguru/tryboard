//! Virtual wireless world: a few APs reacting to the chip's frames (probe response, auth, association, ...).
//! It only sees frames, not chip internals; its 'arrived over the air' frames are written into RX descriptors by the MAC model.

use super::frame::{self, fc, Mac};
use super::net::{self, Eth};
use super::netcond::{Change, FaultKind, NetCond, Preset};
use super::phone::Phone;
use super::tcp::NetRow;
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
    /// Target interface on the chip: false = STA (if 0), true = firmware hotspot (if 1, frames from the C-02 virtual phone)
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
    /// Virtual phone (C-02): only present with a phone (--ap-phone / web phone panel); without it the world is byte-identical to before
    pub phone: Option<Phone>,
    /// MAC of the firmware hotspot (learned from chip beacons): frames with this a2 go to the phone, not the STA interface
    pub ap_mac: Option<Mac>,
    /// Network conditions and scheduled faults (D-01); the default touches nothing
    pub cond: NetCond,
    /// AP a router reboot took down (None = all, when the chip was not associated)
    reboot_ap: Option<usize>,
}

/// Network summary (D-01): what the CLI prints and the web chip shows
#[derive(Clone, Debug)]
pub struct NetSummary {
    pub preset: Preset,
    pub seed: u32,
    pub faults: usize,
    pub disconnects: u32,
    /// Latest reconnect duration (us)
    pub reconnect_us: Option<u64>,
    /// Still off the network at the end
    pub lost: bool,
    pub ok: u32,
    pub failed: u32,
    pub lost_frames: u64,
}

impl NetSummary {
    pub fn line(&self) -> String {
        let rc = match (self.lost, self.reconnect_us) {
            (true, _) => ", not reconnected".to_string(),
            (false, Some(d)) => format!(", reconnected after {:.1} s", d as f64 / 1e6),
            _ => String::new(),
        };
        format!(
            "[tryboard] network: preset {} (seed {}), faults {}, disconnects {}{rc}, requests ok {} / failed {}, frames lost {}",
            self.preset.name(),
            self.seed,
            self.faults,
            self.disconnects,
            self.ok,
            self.failed,
            self.lost_frames
        )
    }
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
            cond: NetCond::default(),
            reboot_ap: None,
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
        let r = self.aps[i].rssi;
        let r = self.cond.rssi_cap().map_or(r, |c| r.min(c));
        (r as i32 - self.antenna_loss_db).clamp(-127, 0) as i8
    }

    /// AP switched off by the offline preset or a router reboot (D-01)
    fn ap_down(&self, i: usize) -> bool {
        self.cond.preset == Preset::Offline
            || (self.cond.down() && self.reboot_ap.is_none_or(|a| a == i))
    }

    fn row(
        &mut self,
        t_us: u64,
        method: &str,
        url: &str,
        status: &str,
        dur: Option<u64>,
        note: &str,
    ) {
        self.net.tcp.rows.push(NetRow {
            t_us,
            method: method.into(),
            dest: "Injected",
            url: url.into(),
            status: status.into(),
            dur_us: dur,
            note: note.into(),
        });
    }

    /// The AP forgets the station (router reboot / offline): beacons stop, so the chip's own beacon timeout fires
    fn forget(&mut self, i: usize, now_us: u64) {
        if self.sta[i] == StaState::Assoc && self.cond.lose(now_us) {
            let ssid = self.aps[i].ssid.clone();
            self.row(now_us, "Wi-Fi", &ssid, "Disconnected", None, "");
        }
        self.sta[i] = StaState::Idle;
        if let Some(a) = self.wpa[i].as_mut() {
            a.state = wpa::Hs::Idle;
        }
    }

    /// Network preset (D-01, action net=)
    pub fn set_preset(&mut self, p: Preset, now_us: u64) {
        self.advance_cond(now_us);
        self.cond.set_preset(p, now_us);
        self.row(now_us, "NET", p.label(), "Applied", None, "");
        if p == Preset::Offline {
            for i in 0..self.aps.len() {
                self.forget(i, now_us);
            }
        }
    }

    /// Schedule a fault (D-01, action netfault= / --net-fault)
    pub fn add_fault(&mut self, k: FaultKind, start_us: u64, dur_us: u64) {
        self.cond.add_fault(k, start_us, dur_us);
    }

    /// Cross fault boundaries up to now (AP state changes and timeline rows)
    fn advance_cond(&mut self, now_us: u64) {
        if self.cond.next_boundary().is_none_or(|t| t > now_us) {
            return;
        }
        for c in self.cond.advance(now_us) {
            match c {
                Change::Start(f) => {
                    let note = if f.auto {
                        "Random drop (flaky preset)"
                    } else {
                        ""
                    };
                    let d = f.end_us - f.start_us;
                    self.row(
                        f.start_us,
                        "FAULT",
                        f.kind.label(),
                        "Injected",
                        Some(d),
                        note,
                    );
                    if f.kind == FaultKind::Reboot {
                        self.reboot_ap = self.associated();
                        for i in 0..self.aps.len() {
                            if self.reboot_ap.is_none_or(|a| a == i) {
                                self.forget(i, f.start_us);
                            }
                        }
                    }
                }
                Change::End(f) => {
                    self.row(f.end_us, "FAULT", f.kind.label(), "Recovered", None, "");
                    if f.kind == FaultKind::Reboot && !self.cond.down() {
                        self.reboot_ap = None;
                    }
                }
            }
        }
    }

    /// Summary of conditions and their effect; None while untouched (normal, no faults)
    pub fn net_summary(&self) -> Option<NetSummary> {
        if !self.cond.active() {
            return None;
        }
        let (mut ok, mut failed) = (0, 0);
        for r in &self.net.tcp.rows {
            match (r.status.parse::<u16>(), r.status.as_str()) {
                (Ok(c), _) if c < 400 => ok += 1,
                (Ok(_), _) | (_, "Failed" | "No reply" | "Timed out") => failed += 1,
                _ => {}
            }
        }
        let st = &self.cond.stats;
        Some(NetSummary {
            preset: self.cond.preset,
            seed: self.cond.seed,
            faults: self.cond.faults.len(),
            disconnects: st.disconnects,
            reconnect_us: st.reconnects.last().copied(),
            lost: st.lost_at.is_some(),
            ok,
            failed,
            lost_frames: st.lost_frames,
        })
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
        self.advance_cond(tsf_us);
        // Frames from the firmware hotspot (AP interface): beacons teach the MAC, the rest go to the phone; STA state untouched
        if h.fc0 == fc::BEACON && self.ap_mac != Some(h.a2) && self.phone.is_some() {
            self.ap_mac = Some(h.a2);
        }
        if self.ap_mac == Some(h.a2) {
            let loss = self.antenna_loss_db;
            let Some(p) = self.phone.as_mut() else {
                return ("firmware hotspot frame (no phone)".into(), vec![], false);
            };
            let (d, acked) = p.on_frame(f, tsf_us);
            let out = Self::phone_air(p, loss);
            return (d, out, acked);
        }
        let mut out = Vec::new();
        let body = &f[h.body.min(f.len())..];
        let unicast = h.a1[0] & 1 == 0;
        let target = self.aps.iter().position(|a| a.bssid == h.a1);
        self.sta_mac = h.a2;
        if self.cond.active() {
            if target.is_some_and(|i| self.ap_down(i)) {
                return ("frame → AP is off (injected fault)".into(), out, false);
            }
            // The preset's loss: the AP did not hear this frame (no ACK, no reply; the chip retries)
            if (target.is_some() || h.fc0 == fc::PROBE_REQ) && self.cond.uplink_lost() {
                return ("frame lost (network preset)".into(), out, false);
            }
        }
        let acked = unicast && target.is_some_and(|i| self.linkable(i));
        // A rebooted AP gets data from a station it no longer knows: like a real AP it answers
        // deauth reason 7 (class 3 frame from a non-associated station). Only under D-01 conditions
        if let Some(i) = target.filter(|i| {
            self.cond.active()
                && h.fc0 & 0x0c == 0x08
                && self.sta[*i] != StaState::Assoc
                && self.linkable(*i)
        }) {
            let seq = self.next_seq();
            let (sta, bssid) = (h.a2, self.aps[i].bssid);
            let mut d = frame::mgmt_hdr(fc::DEAUTH, &sta, &bssid, &bssid, seq);
            d.extend_from_slice(&7u16.to_le_bytes());
            out.push(Air {
                delay_us: 500,
                frame: d,
                rssi: self.rssi(i),
                channel: self.aps[i].channel,
                ap_if: false,
            });
            return (
                "data frame from a station the AP does not know → deauth (reason 7)".into(),
                out,
                acked,
            );
        }
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
                        || self.ap_down(i)
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
                    if self.sta[i] == StaState::Assoc
                        && self.cond.active()
                        && self.cond.lose(tsf_us)
                    {
                        let ssid = self.aps[i].ssid.clone();
                        self.row(tsf_us, "Wi-Fi", &ssid, "Disconnected", None, "");
                    }
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
                let acks = self.net.acks;
                self.net.tcp.dns_fail = self.cond.dns_fail();
                self.net.tcp.silent = self.cond.silent();
                let replies = self.net.on_eth(&eth, tsf_us);
                if self.net.acks != acks {
                    if let Some(d) = self.cond.regained(tsf_us) {
                        let ssid = self.aps[i].ssid.clone();
                        self.row(tsf_us, "Wi-Fi", &ssid, "Reconnected", Some(d), "");
                    }
                }
                let (rssi, channel, bssid) = (self.rssi(i), self.aps[i].channel, self.aps[i].bssid);
                let extra = if replies.is_empty() {
                    0
                } else {
                    self.cond.latency_us(tsf_us, 300)
                };
                for (k, r) in replies.into_iter().enumerate() {
                    let mut f = self.data_from_ds(&r, &bssid);
                    if let Some(a) = self.wpa[i].as_mut().filter(|a| wpa2 && a.authorized()) {
                        f = a.encrypt(&f);
                    }
                    out.push(Air {
                        delay_us: extra + 300 + 200 * k as u64,
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
        // Frames queued to push (real-network replies): due immediately
        let ap = if self.net.pending.is_empty() {
            ap
        } else {
            Some(0)
        };
        let ap = match (ap, self.cond.next_boundary()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        match self.phone.as_ref().and_then(|p| p.next_timer()) {
            Some(t) => Some(ap.map_or(t, |a| a.min(t))),
            None => ap,
        }
    }

    /// Frames the phone sends: signal attenuated by antenna blockage (symmetric link)
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
        self.advance_cond(tsf_us);
        let loss = self.antenna_loss_db;
        // Real-network reply (C-03): to the chip via the associated AP (encrypted once WPA2 is up); dropped when not associated
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
