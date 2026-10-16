//! 虚拟 AP 的 WPA2-PSK 认证方（IEEE 802.11 §12.7.6 四次握手）与 CCMP 数据通路。
//! 只做 AKM = PSK、成对 / 组加密 = CCMP、密钥描述符版本 2（HMAC-SHA1 MIC + AES Key Wrap）。

use super::crypto;
use super::frame::Mac;

pub const ETH_EAPOL: u16 = 0x888e;

// EAPOL-Key 密钥信息位
const KI_VER2: u16 = 2;
const KI_PAIRWISE: u16 = 1 << 3;
const KI_INSTALL: u16 = 1 << 6;
const KI_ACK: u16 = 1 << 7;
const KI_MIC: u16 = 1 << 8;
const KI_SECURE: u16 = 1 << 9;
const KI_ENC_DATA: u16 = 1 << 12;

/// 802.1X 帧内各字段偏移（从 802.1X 头开始算）
const OFF_KEYINFO: usize = 5;
const OFF_REPLAY: usize = 9;
const OFF_NONCE: usize = 17;
const OFF_MIC: usize = 81;
const OFF_DATA: usize = 99;

/// hostapd 的缺省重传节奏：第一次 100ms，之后每次 1s，共发 4 次
const RETRY_FIRST_US: u64 = 100_000;
const RETRY_US: u64 = 1_000_000;
const MAX_TRIES: u32 = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Hs {
    Idle,
    /// 已发消息 1，等消息 2
    Msg1,
    /// 已发消息 3，等消息 4
    Msg3,
    Done,
}

/// poll 的结果
pub enum Timer {
    /// 重发上一条 EAPOL 消息
    Resend(Vec<u8>),
    /// 重试用完：AP 踢掉终端（原因码 15 = 四次握手超时）
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
    /// 发给终端的单播 / 组播 PN，以及收到的最大 PN（防重放）
    tx_pn: u64,
    gtk_pn: u64,
    rx_pn: u64,
    /// 消息 2 / 4 的 MIC 校验失败次数（口令错时会增加）
    pub mic_failures: u32,
    rsn_ie: Vec<u8>,
}

impl Authenticator {
    pub fn new(passphrase: &str, ssid: &[u8], aa: Mac, rsn_ie: &[u8]) -> Self {
        let pmk = crypto::wpa_pmk(passphrase, ssid);
        // GTK 固定由 PMK 派生，结果可复现
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

    /// 关联成功：开始四次握手，返回消息 1（802.1X 帧）
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
        // 重发要用新的重放计数器（终端按计数器去重）
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

    /// 构造 EAPOL-Key 帧（802.1X 头起）；mic = 是否用 KCK 计算 MIC
    fn key_frame(&self, info: u16, data: &[u8], mic: bool) -> Vec<u8> {
        let body_len = OFF_DATA - 4 + data.len();
        let mut f = vec![2, 3];
        f.extend_from_slice(&(body_len as u16).to_be_bytes());
        f.push(2); // 描述符类型 RSN
        f.extend_from_slice(&info.to_be_bytes());
        f.extend_from_slice(&16u16.to_be_bytes()); // 成对密钥长度（CCMP）
        f.extend_from_slice(&self.replay.to_be_bytes());
        f.extend_from_slice(&self.anonce);
        f.extend_from_slice(&[0; 16]); // Key IV
        f.extend_from_slice(&[0; 8]); // Key RSC：组密钥 PN 从 0 起
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

    /// 收到终端的 EAPOL 帧（802.1X 头起）；返回 (日志, 要回的帧)
    pub fn on_eapol(&mut self, f: &[u8], now_us: u64) -> (String, Option<Vec<u8>>) {
        if f.len() < OFF_DATA || f[1] != 3 {
            return ("EAPOL（非 Key 帧，忽略）".into(), None);
        }
        let len = (u16::from_be_bytes([f[2], f[3]]) as usize + 4).min(f.len());
        let f = &f[..len];
        let info = u16::from_be_bytes([f[OFF_KEYINFO], f[OFF_KEYINFO + 1]]);
        let replay = u64::from_be_bytes(f[OFF_REPLAY..OFF_REPLAY + 8].try_into().unwrap());
        if info & KI_MIC == 0 || replay != self.replay {
            return (
                format!("EAPOL-Key（info 0x{info:04x}、计数器 {replay}，不是在等的消息）"),
                None,
            );
        }
        match self.state {
            Hs::Msg1 if info & KI_SECURE == 0 => {
                let snonce: [u8; 32] = f[OFF_NONCE..OFF_NONCE + 32].try_into().unwrap();
                let ptk = crypto::wpa_ptk(&self.pmk, &self.aa, &self.spa, &self.anonce, &snonce);
                if !self.mic_ok(f, &ptk[..16]) {
                    // 口令不对：PTK 不同，MIC 必然对不上。真 AP 静默丢弃，靠重传超时踢人
                    self.mic_failures += 1;
                    return (
                        "四次握手 2/4：MIC 校验失败（口令不对？），丢弃".into(),
                        None,
                    );
                }
                self.ptk = ptk;
                self.replay += 1;
                let m3 = self.msg3();
                self.state = Hs::Msg3;
                self.arm(m3.clone(), now_us);
                (
                    "四次握手 2/4 MIC 正确 → 发 3/4（安装 PTK、带 GTK）".into(),
                    Some(m3),
                )
            }
            Hs::Msg3 if info & KI_SECURE != 0 => {
                if !self.mic_ok(f, &self.ptk[..16]) {
                    self.mic_failures += 1;
                    return ("四次握手 4/4：MIC 校验失败，丢弃".into(), None);
                }
                self.state = Hs::Done;
                ("四次握手 4/4 完成，端口放行".into(), None)
            }
            _ => (
                format!(
                    "EAPOL-Key（info 0x{info:04x}，状态 {:?}，忽略）",
                    self.state
                ),
                None,
            ),
        }
    }

    fn msg3(&self) -> Vec<u8> {
        // 密钥数据 = AP 的 RSN IE + GTK KDE（OUI 00-0F-AC 类型 1，密钥号 1）
        let mut kd = self.rsn_ie.clone();
        kd.extend_from_slice(&[0xdd, 22, 0x00, 0x0f, 0xac, 0x01, 0x01, 0x00]);
        kd.extend_from_slice(&self.gtk);
        // Key Wrap 要 8 字节对齐：按 §12.7.2 用 0xdd 0x00... 填充
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

    /// AP → 终端的数据帧加密：单播用 TK，组播 / 广播用 GTK（密钥号 1）
    pub fn encrypt(&mut self, f: &[u8]) -> Vec<u8> {
        if f[4] & 1 != 0 {
            self.gtk_pn += 1;
            crypto::ccmp_encrypt(&self.gtk, f, self.gtk_pn, 1)
        } else {
            self.tx_pn += 1;
            crypto::ccmp_encrypt(&self.tk(), f, self.tx_pn, 0)
        }
    }

    /// 终端 → AP 的加密帧：解密并检查 PN 递增
    pub fn decrypt(&mut self, f: &[u8]) -> Result<Vec<u8>, &'static str> {
        let (p, pn) = crypto::ccmp_decrypt(&self.tk(), f).ok_or("CCMP MIC 校验失败")?;
        if pn <= self.rx_pn {
            return Err("CCMP 重放（PN 未递增）");
        }
        self.rx_pn = pn;
        Ok(p)
    }
}

/// 终端（请求方）一侧的参考实现：只给单元测试用，验证认证方的消息格式自洽
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
        let m3 = m3.expect("应回消息 3");
        // 消息 3 的 MIC 用同一个 KCK 能验过，密钥数据能用 KEK 解封并含 GTK
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
        // 数据通路：AP 加密 → 终端解密
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
                None => panic!("应有定时动作"),
            }
        }
        assert_eq!(resends, 3);
        assert_eq!(a.mic_failures, 4);
        assert_eq!(a.state, Hs::Idle);
        assert_eq!(t, 3_100_000);
    }
}
