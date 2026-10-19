//! Virtual AP's WPA2-PSK authenticator (IEEE 802.11 §12.7.6 4-way handshake) and CCMP data path.
//! Only AKM = PSK, pairwise / group cipher = CCMP, key descriptor version 2 (HMAC-SHA1 MIC + AES Key Wrap).

use super::crypto;
use super::frame::Mac;

pub const ETH_EAPOL: u16 = 0x888e;

// EAPOL-Key key information bits
const KI_VER2: u16 = 2;
const KI_PAIRWISE: u16 = 1 << 3;
const KI_INSTALL: u16 = 1 << 6;
const KI_ACK: u16 = 1 << 7;
const KI_MIC: u16 = 1 << 8;
const KI_SECURE: u16 = 1 << 9;
const KI_ENC_DATA: u16 = 1 << 12;

/// Field offsets inside the 802.1X frame (from the 802.1X header)
const OFF_KEYINFO: usize = 5;
const OFF_REPLAY: usize = 9;
const OFF_NONCE: usize = 17;
const OFF_MIC: usize = 81;
const OFF_DATA: usize = 99;

/// hostapd default retransmit pacing: first after 100 ms, then every 1 s, 4 sends in total
const RETRY_FIRST_US: u64 = 100_000;
const RETRY_US: u64 = 1_000_000;
const MAX_TRIES: u32 = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Hs {
    Idle,
    /// Message 1 sent, waiting for message 2
    Msg1,
    /// Message 3 sent, waiting for message 4
    Msg3,
    Done,
}

/// Result of poll
pub enum Timer {
    /// Resend the last EAPOL message
    Resend(Vec<u8>),
    /// Retries exhausted: the AP kicks the station (reason 15 = 4-way handshake timeout)
    Timeout,
}

pub struct Authenticator {
    pub pmk: [u8; 32],
    pub aa: Mac,
    pub spa: Mac,
    pub state: Hs,
    anonce: [u8; 32],
    /// KCK(16) | KEK(16) | TK(16)
    ptk: [u8; 48],
    replay: u64,
    pub gtk: [u8; 16],
    last: Vec<u8>,
    tries: u32,
    retry_at: u64,
    nonce_ctr: u32,
    /// Unicast / group PN sent to the station, and the highest PN received (replay protection)
    tx_pn: u64,
    gtk_pn: u64,
    rx_pn: u64,
    /// MIC check failures on messages 2 / 4 (grows when the passphrase is wrong)
    pub mic_failures: u32,
    rsn_ie: Vec<u8>,
}

impl Authenticator {
    pub fn new(passphrase: &str, ssid: &[u8], aa: Mac, rsn_ie: &[u8]) -> Self {
        let pmk = crypto::wpa_pmk(passphrase, ssid);
        // GTK is derived from the PMK so results are reproducible
        let mut gtk = [0u8; 16];
        crypto::prf(&pmk, b"Group key expansion", &aa, &mut gtk);
        Authenticator {
            pmk,
            aa,
            spa: [0; 6],
            state: Hs::Idle,
            anonce: [0; 32],
            ptk: [0; 48],
            replay: 0,
            gtk,
            last: Vec::new(),
            tries: 0,
            retry_at: 0,
            nonce_ctr: 0,
            tx_pn: 0,
            gtk_pn: 0,
            rx_pn: 0,
            mic_failures: 0,
            rsn_ie: rsn_ie.to_vec(),
        }
    }

    pub fn tk(&self) -> [u8; 16] {
        self.ptk[32..48].try_into().unwrap()
    }

    pub fn authorized(&self) -> bool {
        self.state == Hs::Done
    }

    /// Association succeeded: start the 4-way handshake, return message 1 (802.1X frame)
    pub fn start(&mut self, spa: Mac, now_us: u64) -> Vec<u8> {
        self.spa = spa;
        self.nonce_ctr += 1;
        let mut seed = self.aa.to_vec();
        seed.extend_from_slice(&spa);
        seed.extend_from_slice(&self.nonce_ctr.to_be_bytes());
        seed.extend_from_slice(&now_us.to_le_bytes());
        let mut n = [0u8; 32];
        crypto::prf(&self.pmk, b"Init Counter", &seed, &mut n);
        self.anonce = n;
        self.tx_pn = 0;
        self.rx_pn = 0;
        self.replay += 1;
        let m1 = self.key_frame(KI_VER2 | KI_PAIRWISE | KI_ACK, &[], false);
        self.state = Hs::Msg1;
        self.arm(m1.clone(), now_us);
        m1
    }

    fn arm(&mut self, f: Vec<u8>, now_us: u64) {
        self.last = f;
        self.tries = 1;
        self.retry_at = now_us + RETRY_FIRST_US;
    }

    pub fn next_timer(&self) -> Option<u64> {
        matches!(self.state, Hs::Msg1 | Hs::Msg3).then_some(self.retry_at)
    }

    pub fn poll(&mut self, now_us: u64) -> Option<Timer> {
        if !matches!(self.state, Hs::Msg1 | Hs::Msg3) || now_us < self.retry_at {
            return None;
        }
        if self.tries >= MAX_TRIES {
            self.state = Hs::Idle;
            return Some(Timer::Timeout);
        }
        self.tries += 1;
        self.retry_at = now_us + RETRY_US;
        // Resends need a new replay counter (the station deduplicates by it)
        self.replay += 1;
        let mut f = self.last.clone();
        f[OFF_REPLAY..OFF_REPLAY + 8].copy_from_slice(&self.replay.to_be_bytes());
        if u16::from_be_bytes([f[OFF_KEYINFO], f[OFF_KEYINFO + 1]]) & KI_MIC != 0 {
            f[OFF_MIC..OFF_MIC + 16].fill(0);
            let mic = crypto::hmac_sha1(&self.ptk[..16], &[&f]);
            f[OFF_MIC..OFF_MIC + 16].copy_from_slice(&mic[..16]);
        }
        self.last = f.clone();
        Some(Timer::Resend(f))
    }

    /// Build an EAPOL-Key frame (from the 802.1X header); mic = compute the MIC with the KCK
    fn key_frame(&self, info: u16, data: &[u8], mic: bool) -> Vec<u8> {
        let body_len = OFF_DATA - 4 + data.len();
        let mut f = vec![2, 3];
        f.extend_from_slice(&(body_len as u16).to_be_bytes());
        f.push(2); // Descriptor type RSN
        f.extend_from_slice(&info.to_be_bytes());
        f.extend_from_slice(&16u16.to_be_bytes()); // Pairwise key length (CCMP)
        f.extend_from_slice(&self.replay.to_be_bytes());
        f.extend_from_slice(&self.anonce);
        f.extend_from_slice(&[0; 16]); // Key IV
        f.extend_from_slice(&[0; 8]); // Key RSC: group key PN starts at 0
        f.extend_from_slice(&[0; 8]);
        f.extend_from_slice(&[0; 16]); // MIC
        f.extend_from_slice(&(data.len() as u16).to_be_bytes());
        f.extend_from_slice(data);
        if mic {
            let m = crypto::hmac_sha1(&self.ptk[..16], &[&f]);
            f[OFF_MIC..OFF_MIC + 16].copy_from_slice(&m[..16]);
        }
        f
    }

    fn mic_ok(&self, f: &[u8], kck: &[u8]) -> bool {
        let mut z = f.to_vec();
        z[OFF_MIC..OFF_MIC + 16].fill(0);
        let m = crypto::hmac_sha1(kck, &[&z]);
        m[..16] == f[OFF_MIC..OFF_MIC + 16]
    }

    /// EAPOL frame from the station (from the 802.1X header); returns (log, reply frame)
    pub fn on_eapol(&mut self, f: &[u8], now_us: u64) -> (String, Option<Vec<u8>>) {
        if f.len() < OFF_DATA || f[1] != 3 {
            return ("EAPOL (not a Key frame, ignored)".into(), None);
        }
        let len = (u16::from_be_bytes([f[2], f[3]]) as usize + 4).min(f.len());
        let f = &f[..len];
        let info = u16::from_be_bytes([f[OFF_KEYINFO], f[OFF_KEYINFO + 1]]);
        let replay = u64::from_be_bytes(f[OFF_REPLAY..OFF_REPLAY + 8].try_into().unwrap());
        if info & KI_MIC == 0 || replay != self.replay {
            return (
                format!("EAPOL-Key (info 0x{info:04x}, replay counter {replay}, not the expected message)"),
                None,
            );
        }
        match self.state {
            Hs::Msg1 if info & KI_SECURE == 0 => {
                let snonce: [u8; 32] = f[OFF_NONCE..OFF_NONCE + 32].try_into().unwrap();
                let ptk = crypto::wpa_ptk(&self.pmk, &self.aa, &self.spa, &self.anonce, &snonce);
                if !self.mic_ok(f, &ptk[..16]) {
                    // Wrong passphrase gives a different PTK so the MIC can't match; a real AP drops silently and kicks on retransmit timeout
                    self.mic_failures += 1;
                    return (
                        "4-way handshake 2/4: MIC check failed (wrong passphrase?), dropped".into(),
                        None,
                    );
                }
                self.ptk = ptk;
                self.replay += 1;
                let m3 = self.msg3();
                self.state = Hs::Msg3;
                self.arm(m3.clone(), now_us);
                (
                    "4-way handshake 2/4 MIC ok → send 3/4 (install PTK, carry GTK)".into(),
                    Some(m3),
                )
            }
            Hs::Msg3 if info & KI_SECURE != 0 => {
                if !self.mic_ok(f, &self.ptk[..16]) {
                    self.mic_failures += 1;
                    return (
                        "4-way handshake 4/4: MIC check failed, dropped".into(),
                        None,
                    );
                }
                self.state = Hs::Done;
                ("4-way handshake 4/4 done, port open".into(), None)
            }
            _ => (
                format!(
                    "EAPOL-Key (info 0x{info:04x}, state {:?}, ignored)",
                    self.state
                ),
                None,
            ),
        }
    }

    fn msg3(&self) -> Vec<u8> {
        // Key data = AP RSN IE + GTK KDE (OUI 00-0F-AC type 1, key id 1)
        let mut kd = self.rsn_ie.clone();
        kd.extend_from_slice(&[0xdd, 22, 0x00, 0x0f, 0xac, 0x01, 0x01, 0x00]);
        kd.extend_from_slice(&self.gtk);
        // Key Wrap needs 8-byte alignment: pad with 0xdd 0x00... per §12.7.2
        if !kd.len().is_multiple_of(8) {
            kd.push(0xdd);
            while !kd.len().is_multiple_of(8) {
                kd.push(0);
            }
        }
        let wrapped = crypto::key_wrap(&self.ptk[16..32], &kd);
        let info = KI_VER2 | KI_PAIRWISE | KI_INSTALL | KI_ACK | KI_MIC | KI_SECURE | KI_ENC_DATA;
        self.key_frame(info, &wrapped, true)
    }

    /// Encrypt AP -> station data frames: TK for unicast, GTK (key id 1) for multicast / broadcast
    pub fn encrypt(&mut self, f: &[u8]) -> Vec<u8> {
        if f[4] & 1 != 0 {
            self.gtk_pn += 1;
            crypto::ccmp_encrypt(&self.gtk, f, self.gtk_pn, 1)
        } else {
            self.tx_pn += 1;
            crypto::ccmp_encrypt(&self.tk(), f, self.tx_pn, 0)
        }
    }

    /// Encrypted station -> AP frame: decrypt and check the PN increases
    pub fn decrypt(&mut self, f: &[u8]) -> Result<Vec<u8>, &'static str> {
        let (p, pn) = crypto::ccmp_decrypt(&self.tk(), f).ok_or("CCMP MIC check failed")?;
        if pn <= self.rx_pn {
            return Err("CCMP replay (PN did not increase)");
        }
        self.rx_pn = pn;
        Ok(p)
    }
}

/// Supplicant-side reference implementation, test only: checks the authenticator's messages are self-consistent
#[cfg(test)]
pub(crate) fn supplicant_reply(
    pmk: &[u8; 32],
    aa: &Mac,
    spa: &Mac,
    msg: &[u8],
    snonce: &[u8; 32],
) -> (Vec<u8>, [u8; 48]) {
    let anonce: [u8; 32] = msg[OFF_NONCE..OFF_NONCE + 32].try_into().unwrap();
    let ptk = crypto::wpa_ptk(pmk, aa, spa, &anonce, snonce);
    let info = u16::from_be_bytes([msg[OFF_KEYINFO], msg[OFF_KEYINFO + 1]]);
    let secure = info & KI_SECURE != 0;
    let mut f = msg[..OFF_DATA].to_vec();
    f[2..4].copy_from_slice(&((OFF_DATA - 4) as u16).to_be_bytes());
    let ri = KI_VER2 | KI_PAIRWISE | KI_MIC | if secure { KI_SECURE } else { 0 };
    f[OFF_KEYINFO..OFF_KEYINFO + 2].copy_from_slice(&ri.to_be_bytes());
    f[OFF_NONCE..OFF_NONCE + 32].copy_from_slice(if secure { &[0; 32] } else { snonce });
    f[OFF_MIC..OFF_MIC + 16].fill(0);
    f[OFF_DATA - 2..OFF_DATA].fill(0);
    let m = crypto::hmac_sha1(&ptk[..16], &[&f]);
    f[OFF_MIC..OFF_MIC + 16].copy_from_slice(&m[..16]);
    (f, ptk)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AA: Mac = [2, 0x54, 0x42, 0xa0, 0, 2];
    const SPA: Mac = [0x58, 0xcf, 0x79, 1, 2, 3];

    fn auth() -> Authenticator {
        let rsn = [0x30, 2, 1, 0];
        Authenticator::new("tryboard123", b"TryBoard-WPA2", AA, &rsn)
    }

    #[test]
    fn four_way_handshake_good_password() {
        let mut a = auth();
        let pmk = crypto::wpa_pmk("tryboard123", b"TryBoard-WPA2");
        let m1 = a.start(SPA, 0);
        let sn = [7u8; 32];
        let (m2, ptk) = supplicant_reply(&pmk, &AA, &SPA, &m1, &sn);
        let (_, m3) = a.on_eapol(&m2, 10);
        let m3 = m3.expect("should reply with message 3");
        // Message 3's MIC verifies with the same KCK, and its key data unwraps with the KEK and contains the GTK
        let mut z = m3.clone();
        z[OFF_MIC..OFF_MIC + 16].fill(0);
        assert_eq!(
            &crypto::hmac_sha1(&ptk[..16], &[&z])[..16],
            &m3[OFF_MIC..OFF_MIC + 16]
        );
        let kd = crypto::key_unwrap(&ptk[16..32], &m3[OFF_DATA..]).unwrap();
        let gtk_at = kd
            .windows(4)
            .position(|w| w == [0x00, 0x0f, 0xac, 0x01])
            .unwrap()
            + 6;
        assert_eq!(&kd[gtk_at..gtk_at + 16], &a.gtk);
        let (m4, _) = supplicant_reply(&pmk, &AA, &SPA, &m3, &sn);
        a.on_eapol(&m4, 20);
        assert!(a.authorized());
        assert_eq!(a.tk(), ptk[32..48]);
        // Data path: AP encrypts -> station decrypts
        let mut f = vec![0x08, 0x02, 0, 0];
        f.extend_from_slice(&SPA);
        f.extend_from_slice(&AA);
        f.extend_from_slice(&AA);
        f.extend_from_slice(&[0x10, 0]);
        f.extend_from_slice(b"\xaa\xaa\x03\0\0\0\x08\x00hello");
        let e = a.encrypt(&f);
        let (d, pn) = crypto::ccmp_decrypt(&a.tk(), &e).unwrap();
        assert_eq!(&d[24..], &f[24..]);
        assert_eq!(pn, 1);
    }

    #[test]
    fn wrong_password_times_out() {
        let mut a = auth();
        let bad = crypto::wpa_pmk("wrongpass1", b"TryBoard-WPA2");
        let mut m = a.start(SPA, 0);
        let mut t = 0;
        let mut resends = 0;
        loop {
            let (m2, _) = supplicant_reply(&bad, &AA, &SPA, &m, &[9; 32]);
            let (_, r) = a.on_eapol(&m2, t);
            assert!(r.is_none());
            t = a.next_timer().unwrap();
            match a.poll(t) {
                Some(Timer::Resend(f)) => {
                    resends += 1;
                    m = f;
                }
                Some(Timer::Timeout) => break,
                None => panic!("expected a timed action"),
            }
        }
        assert_eq!(resends, 3);
        assert_eq!(a.mic_failures, 4);
        assert_eq!(a.state, Hs::Idle);
        assert_eq!(t, 3_100_000);
    }
}
