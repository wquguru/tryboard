//! WPA2-PSK crypto primitives implemented from public standards (no third-party crates): SHA-1 (FIPS 180-4), HMAC (RFC 2104),
//! PBKDF2 (RFC 8018), 802.11 PRF (IEEE 802.11 §12.7.1.2), AES (FIPS 197), Key Wrap (RFC 3394), CCM (RFC 3610 / NIST SP 800-38C).
//! Correct but not constant-time: it only protects simulated air frames, not real secrets. lint: allow-long-comment

// ---------------- SHA-1 ----------------

pub struct Sha1 {
    h: [u32; 5],
    buf: [u8; 64],
    n: usize,
    len: u64,
}

impl Default for Sha1 {
    fn default() -> Self {
        Sha1 {
            h: [
                0x6745_2301,
                0xefcd_ab89,
                0x98ba_dcfe,
                0x1032_5476,
                0xc3d2_e1f0,
            ],
            buf: [0; 64],
            n: 0,
            len: 0,
        }
    }
}

/// Compress one 64-byte block (the hardware SHA accelerator model uses it directly)
pub fn sha1_block(h: &mut [u32; 5], b: &[u8]) {
    let mut w = [0u32; 80];
    for i in 0..16 {
        w[i] = u32::from_be_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]);
    }
    for i in 16..80 {
        w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
    }
    let [mut a, mut bb, mut c, mut d, mut e] = *h;
    for (i, wi) in w.iter().enumerate() {
        let (f, k) = match i {
            0..=19 => ((bb & c) | (!bb & d), 0x5a82_7999),
            20..=39 => (bb ^ c ^ d, 0x6ed9_eba1),
            40..=59 => ((bb & c) | (bb & d) | (c & d), 0x8f1b_bcdc),
            _ => (bb ^ c ^ d, 0xca62_c1d6),
        };
        let t = a
            .rotate_left(5)
            .wrapping_add(f)
            .wrapping_add(e)
            .wrapping_add(k)
            .wrapping_add(*wi);
        e = d;
        d = c;
        c = bb.rotate_left(30);
        bb = a;
        a = t;
    }
    for (x, y) in h.iter_mut().zip([a, bb, c, d, e]) {
        *x = x.wrapping_add(y);
    }
}

impl Sha1 {
    pub fn update(&mut self, mut d: &[u8]) {
        self.len += d.len() as u64;
        while !d.is_empty() {
            let k = (64 - self.n).min(d.len());
            self.buf[self.n..self.n + k].copy_from_slice(&d[..k]);
            self.n += k;
            d = &d[k..];
            if self.n == 64 {
                let b = self.buf;
                sha1_block(&mut self.h, &b);
                self.n = 0;
            }
        }
    }

    pub fn finish(mut self) -> [u8; 20] {
        let bits = self.len * 8;
        self.update(&[0x80]);
        while self.n != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        let mut out = [0u8; 20];
        for (i, w) in self.h.iter().enumerate() {
            out[4 * i..4 * i + 4].copy_from_slice(&w.to_be_bytes());
        }
        out
    }
}

pub fn sha1(d: &[u8]) -> [u8; 20] {
    let mut s = Sha1::default();
    s.update(d);
    s.finish()
}

/// HMAC-SHA1 over a message given in parts (PRF and EAPOL MIC both concatenate several)
pub fn hmac_sha1(key: &[u8], parts: &[&[u8]]) -> [u8; 20] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..20].copy_from_slice(&sha1(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha1::default();
    inner.update(&k.map(|b| b ^ 0x36));
    for p in parts {
        inner.update(p);
    }
    let ih = inner.finish();
    let mut outer = Sha1::default();
    outer.update(&k.map(|b| b ^ 0x5c));
    outer.update(&ih);
    outer.finish()
}

pub fn pbkdf2_sha1(pw: &[u8], salt: &[u8], iters: u32, out: &mut [u8]) {
    for (bi, chunk) in out.chunks_mut(20).enumerate() {
        let idx = (bi as u32 + 1).to_be_bytes();
        let mut u = hmac_sha1(pw, &[salt, &idx]);
        let mut t = u;
        for _ in 1..iters {
            u = hmac_sha1(pw, &[&u]);
            for (x, y) in t.iter_mut().zip(u) {
                *x ^= y;
            }
        }
        chunk.copy_from_slice(&t[..chunk.len()]);
    }
}

/// WPA2-PSK: PMK = PBKDF2-HMAC-SHA1(passphrase, SSID, 4096, 32)
pub fn wpa_pmk(passphrase: &str, ssid: &[u8]) -> [u8; 32] {
    let mut pmk = [0u8; 32];
    pbkdf2_sha1(passphrase.as_bytes(), ssid, 4096, &mut pmk);
    pmk
}

/// 802.11 PRF-n: concatenated blocks of HMAC-SHA1(K, A || 0 || B || i)
pub fn prf(key: &[u8], label: &[u8], data: &[u8], out: &mut [u8]) {
    for (i, chunk) in out.chunks_mut(20).enumerate() {
        let h = hmac_sha1(key, &[label, &[0], data, &[i as u8]]);
        chunk.copy_from_slice(&h[..chunk.len()]);
    }
}

/// PTK = PRF-384(PMK, "Pairwise key expansion", min(AA,SPA) || max(AA,SPA) || min(ANonce,SNonce) || max(...))
/// Returns KCK(16) || KEK(16) || TK(16)
pub fn wpa_ptk(
    pmk: &[u8; 32],
    aa: &[u8; 6],
    spa: &[u8; 6],
    anonce: &[u8; 32],
    snonce: &[u8; 32],
) -> [u8; 48] {
    let mut d = Vec::with_capacity(76);
    let (m1, m2) = if aa < spa { (aa, spa) } else { (spa, aa) };
    d.extend_from_slice(m1);
    d.extend_from_slice(m2);
    let (n1, n2) = if anonce < snonce {
        (anonce, snonce)
    } else {
        (snonce, anonce)
    };
    d.extend_from_slice(n1);
    d.extend_from_slice(n2);
    let mut ptk = [0u8; 48];
    prf(pmk, b"Pairwise key expansion", &d, &mut ptk);
    ptk
}

// ---------------- AES ----------------

const SBOX: [u8; 256] = {
    // Generated at compile time from GF(2^8) inverse + affine transform (FIPS 197 §5.1.1) instead of hand-copying 256 constants
    let mut s = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        let inv = if i == 0 { 0 } else { gf_inv(i as u8) };
        let mut x = inv;
        let mut r = inv;
        let mut k = 0;
        while k < 4 {
            x = x.rotate_left(1);
            r ^= x;
            k += 1;
        }
        s[i] = r ^ 0x63;
        i += 1;
    }
    s
};

const INV_SBOX: [u8; 256] = {
    let mut s = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        s[SBOX[i] as usize] = i as u8;
        i += 1;
    }
    s
};

const fn gf_mul(mut a: u8, mut b: u8) -> u8 {
    let mut p = 0u8;
    while b != 0 {
        if b & 1 != 0 {
            p ^= a;
        }
        let hi = a & 0x80;
        a <<= 1;
        if hi != 0 {
            a ^= 0x1b;
        }
        b >>= 1;
    }
    p
}

/// a^254 = a^-1 (the GF(2^8) multiplicative group has order 255)
const fn gf_inv(a: u8) -> u8 {
    let mut r = 1u8;
    let mut k = 0;
    while k < 254 {
        r = gf_mul(r, a);
        k += 1;
    }
    r
}

/// Expanded AES round keys (128 / 192 / 256 bit)
pub struct Aes {
    rk: Vec<[u8; 16]>,
}

impl Aes {
    pub fn new(key: &[u8]) -> Aes {
        let nk = key.len() / 4;
        assert!(matches!(nk, 4 | 6 | 8), "AES key must be 16/24/32 bytes");
        let nr = nk + 6;
        let mut w: Vec<[u8; 4]> = key.chunks(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();
        let mut rcon = 1u8;
        for i in nk..4 * (nr + 1) {
            let mut t = w[i - 1];
            if i % nk == 0 {
                t = [
                    SBOX[t[1] as usize] ^ rcon,
                    SBOX[t[2] as usize],
                    SBOX[t[3] as usize],
                    SBOX[t[0] as usize],
                ];
                rcon = gf_mul(rcon, 2);
            } else if nk > 6 && i % nk == 4 {
                t = t.map(|b| SBOX[b as usize]);
            }
            let p = w[i - nk];
            w.push([p[0] ^ t[0], p[1] ^ t[1], p[2] ^ t[2], p[3] ^ t[3]]);
        }
        let rk = w
            .chunks(4)
            .map(|c| {
                let mut k = [0u8; 16];
                for (j, x) in c.iter().enumerate() {
                    k[4 * j..4 * j + 4].copy_from_slice(x);
                }
                k
            })
            .collect();
        Aes { rk }
    }

    pub fn encrypt(&self, b: &mut [u8; 16]) {
        let nr = self.rk.len() - 1;
        xor16(b, &self.rk[0]);
        for r in 1..=nr {
            for x in b.iter_mut() {
                *x = SBOX[*x as usize];
            }
            shift_rows(b);
            if r != nr {
                mix_columns(b);
            }
            xor16(b, &self.rk[r]);
        }
    }

    pub fn decrypt(&self, b: &mut [u8; 16]) {
        let nr = self.rk.len() - 1;
        xor16(b, &self.rk[nr]);
        for r in (0..nr).rev() {
            inv_shift_rows(b);
            for x in b.iter_mut() {
                *x = INV_SBOX[*x as usize];
            }
            xor16(b, &self.rk[r]);
            if r != 0 {
                inv_mix_columns(b);
            }
        }
    }
}

fn xor16(a: &mut [u8; 16], b: &[u8; 16]) {
    for (x, y) in a.iter_mut().zip(b) {
        *x ^= y;
    }
}

// State is column-major: b[4c + r] is row r, column c
fn shift_rows(b: &mut [u8; 16]) {
    let s = *b;
    for c in 0..4 {
        for r in 0..4 {
            b[4 * c + r] = s[4 * ((c + r) % 4) + r];
        }
    }
}

fn inv_shift_rows(b: &mut [u8; 16]) {
    let s = *b;
    for c in 0..4 {
        for r in 0..4 {
            b[4 * ((c + r) % 4) + r] = s[4 * c + r];
        }
    }
}

fn mix_columns(b: &mut [u8; 16]) {
    for c in 0..4 {
        let a = [b[4 * c], b[4 * c + 1], b[4 * c + 2], b[4 * c + 3]];
        for r in 0..4 {
            b[4 * c + r] =
                gf_mul(a[r], 2) ^ gf_mul(a[(r + 1) % 4], 3) ^ a[(r + 2) % 4] ^ a[(r + 3) % 4];
        }
    }
}

fn inv_mix_columns(b: &mut [u8; 16]) {
    for c in 0..4 {
        let a = [b[4 * c], b[4 * c + 1], b[4 * c + 2], b[4 * c + 3]];
        for r in 0..4 {
            b[4 * c + r] = gf_mul(a[r], 14)
                ^ gf_mul(a[(r + 1) % 4], 11)
                ^ gf_mul(a[(r + 2) % 4], 13)
                ^ gf_mul(a[(r + 3) % 4], 9);
        }
    }
}

/// RFC 3394 AES Key Wrap (default IV A6A6...); input length is a multiple of 8
pub fn key_wrap(kek: &[u8], p: &[u8]) -> Vec<u8> {
    let aes = Aes::new(kek);
    let n = p.len() / 8;
    let mut a = [0xa6u8; 8];
    // Infallible: the only caller (wpa msg3) pads p to a multiple of 8.
    let mut r: Vec<[u8; 8]> = p.chunks(8).map(|c| c.try_into().unwrap()).collect();
    for j in 0..6 {
        for (i, ri) in r.iter_mut().enumerate() {
            let mut b = [0u8; 16];
            b[..8].copy_from_slice(&a);
            b[8..].copy_from_slice(ri);
            aes.encrypt(&mut b);
            let t = ((n * j + i + 1) as u64).to_be_bytes();
            for k in 0..8 {
                a[k] = b[k] ^ t[k];
            }
            ri.copy_from_slice(&b[8..]);
        }
    }
    let mut out = a.to_vec();
    for x in r {
        out.extend_from_slice(&x);
    }
    out
}

/// RFC 3394 unwrap; None if the integrity check fails
pub fn key_unwrap(kek: &[u8], c: &[u8]) -> Option<Vec<u8>> {
    if c.len() < 16 || !c.len().is_multiple_of(8) {
        return None;
    }
    let aes = Aes::new(kek);
    let n = c.len() / 8 - 1;
    // Infallible: c.len() >= 16 and a multiple of 8 (checked above).
    let mut a: [u8; 8] = c[..8].try_into().unwrap();
    let mut r: Vec<[u8; 8]> = c[8..].chunks(8).map(|x| x.try_into().unwrap()).collect();
    for j in (0..6).rev() {
        for i in (0..n).rev() {
            let t = ((n * j + i + 1) as u64).to_be_bytes();
            let mut b = [0u8; 16];
            for k in 0..8 {
                b[k] = a[k] ^ t[k];
            }
            b[8..].copy_from_slice(&r[i]);
            aes.decrypt(&mut b);
            a.copy_from_slice(&b[..8]);
            r[i].copy_from_slice(&b[8..]);
        }
    }
    (a == [0xa6; 8]).then(|| r.concat())
}

// ---------------- CCM ----------------

/// CCM authenticated encryption (L = 15 - nonce length, M = tag length); returns ciphertext || tag
pub fn ccm_encrypt(key: &[u8], nonce: &[u8], aad: &[u8], msg: &[u8], m: usize) -> Vec<u8> {
    let aes = Aes::new(key);
    let tag = ccm_mac(&aes, nonce, aad, msg, m);
    let mut out = msg.to_vec();
    ccm_ctr(&aes, nonce, &mut out);
    let s0 = ctr_block(&aes, nonce, 0);
    out.extend(tag.iter().zip(s0).map(|(t, s)| t ^ s));
    out
}

/// CCM decrypt and verify; None on tag mismatch
pub fn ccm_decrypt(key: &[u8], nonce: &[u8], aad: &[u8], ct: &[u8], m: usize) -> Option<Vec<u8>> {
    if ct.len() < m {
        return None;
    }
    let aes = Aes::new(key);
    let (c, t) = ct.split_at(ct.len() - m);
    let mut msg = c.to_vec();
    ccm_ctr(&aes, nonce, &mut msg);
    let s0 = ctr_block(&aes, nonce, 0);
    let want: Vec<u8> = t.iter().zip(s0).map(|(t, s)| t ^ s).collect();
    (ccm_mac(&aes, nonce, aad, &msg, m) == want).then_some(msg)
}

fn ctr_block(aes: &Aes, nonce: &[u8], i: u64) -> [u8; 16] {
    let l = 15 - nonce.len();
    let mut a = [0u8; 16];
    a[0] = (l - 1) as u8;
    a[1..1 + nonce.len()].copy_from_slice(nonce);
    let ib = i.to_be_bytes();
    a[16 - l..].copy_from_slice(&ib[8 - l..]);
    aes.encrypt(&mut a);
    a
}

fn ccm_ctr(aes: &Aes, nonce: &[u8], d: &mut [u8]) {
    for (i, chunk) in d.chunks_mut(16).enumerate() {
        let s = ctr_block(aes, nonce, i as u64 + 1);
        for (x, y) in chunk.iter_mut().zip(s) {
            *x ^= y;
        }
    }
}

fn ccm_mac(aes: &Aes, nonce: &[u8], aad: &[u8], msg: &[u8], m: usize) -> Vec<u8> {
    let l = 15 - nonce.len();
    let mut b0 = [0u8; 16];
    b0[0] = (if aad.is_empty() { 0 } else { 0x40 }) | ((((m - 2) / 2) as u8) << 3) | (l - 1) as u8;
    b0[1..1 + nonce.len()].copy_from_slice(nonce);
    let lb = (msg.len() as u64).to_be_bytes();
    b0[16 - l..].copy_from_slice(&lb[8 - l..]);
    let mut x = b0;
    aes.encrypt(&mut x);
    let absorb = |data: &[u8], x: &mut [u8; 16]| {
        for chunk in data.chunks(16) {
            for (a, b) in x.iter_mut().zip(chunk) {
                *a ^= b;
            }
            aes.encrypt(x);
        }
    };
    if !aad.is_empty() {
        // 802.11 AAD is at most 30 bytes, so only the 2-byte length prefix form is needed
        let mut a = (aad.len() as u16).to_be_bytes().to_vec();
        a.extend_from_slice(aad);
        absorb(&a, &mut x);
    }
    absorb(msg, &mut x);
    x[..m].to_vec()
}

// ---------------- CCMP (IEEE 802.11 §12.5.3) ----------------

/// 802.11 header length (data frame: 24 + optional A4 + optional QoS)
fn hdr_len(f: &[u8]) -> usize {
    let mut n = 24;
    if f[1] & 3 == 3 {
        n += 6;
    }
    if f[0] & 0x0c == 0x08 && f[0] & 0x80 != 0 {
        n += 2;
    }
    n
}

fn ccmp_nonce_aad(f: &[u8], hl: usize, pn: &[u8; 6]) -> ([u8; 13], Vec<u8>) {
    let qos = f[0] & 0x0c == 0x08 && f[0] & 0x80 != 0;
    let a4 = f[1] & 3 == 3;
    let mut nonce = [0u8; 13];
    nonce[0] = if qos { f[hl - 2] & 0x0f } else { 0 };
    nonce[1..7].copy_from_slice(&f[10..16]);
    // PN goes into the nonce big-endian (PN5 first)
    for i in 0..6 {
        nonce[7 + i] = pn[5 - i];
    }
    let mut aad = Vec::with_capacity(30);
    // FC: data frames clear subtype bits 4..6; clear Retry, PwrMgt, MoreData; set Protected
    let fc0 = if f[0] & 0x0c == 0x08 {
        f[0] & 0x8f
    } else {
        f[0]
    };
    aad.push(fc0);
    aad.push((f[1] & !0x38) | 0x40);
    aad.extend_from_slice(&f[4..22]);
    // Sequence control keeps only the fragment number
    aad.push(f[22] & 0x0f);
    aad.push(0);
    if a4 {
        aad.extend_from_slice(&f[24..30]);
    }
    if qos {
        aad.push(f[hl - 2] & 0x0f);
        aad.push(0);
    }
    (nonce, aad)
}

/// Plain 802.11 frame -> CCMP frame (insert 8-byte CCMP header, append 8-byte MIC, set Protected)
pub fn ccmp_encrypt(tk: &[u8; 16], f: &[u8], pn: u64, key_id: u8) -> Vec<u8> {
    let hl = hdr_len(f);
    // Infallible: 6-byte prefix of an 8-byte array.
    let p: [u8; 6] = pn.to_le_bytes()[..6].try_into().unwrap();
    let mut out = f[..hl].to_vec();
    out[1] |= 0x40;
    let (nonce, aad) = ccmp_nonce_aad(&out, hl, &p);
    out.extend_from_slice(&[p[0], p[1], 0, 0x20 | (key_id << 6), p[2], p[3], p[4], p[5]]);
    out.extend(ccm_encrypt(tk, &nonce, &aad, &f[hl..], 8));
    out
}

/// CCMP frame -> plain frame (strip CCMP header and MIC, clear Protected) and PN; None on MIC mismatch
pub fn ccmp_decrypt(tk: &[u8; 16], f: &[u8]) -> Option<(Vec<u8>, u64)> {
    let hl = hdr_len(f);
    if f.len() < hl + 16 || f[hl + 3] & 0x20 == 0 {
        return None;
    }
    let h = &f[hl..hl + 8];
    let p = [h[0], h[1], h[4], h[5], h[6], h[7]];
    let (nonce, aad) = ccmp_nonce_aad(f, hl, &p);
    let msg = ccm_decrypt(tk, &nonce, &aad, &f[hl + 8..], 8)?;
    let mut out = f[..hl].to_vec();
    out[1] &= !0x40;
    out.extend_from_slice(&msg);
    let mut pb = [0u8; 8];
    pb[..6].copy_from_slice(&p);
    Some((out, u64::from_le_bytes(pb)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn sha1_fips180() {
        assert_eq!(
            sha1(b"abc").to_vec(),
            hex("a9993e364706816aba3e25717850c26c9cd0d89d")
        );
        assert_eq!(
            sha1(b"").to_vec(),
            hex("da39a3ee5e6b4b0d3255bfef95601890afd80709")
        );
        assert_eq!(
            sha1(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq").to_vec(),
            hex("84983e441c3bd26ebaae4aa1f95129e5e54670f1")
        );
        let mut s = Sha1::default();
        for _ in 0..10_000 {
            s.update(&[b'a'; 100]);
        }
        assert_eq!(
            s.finish().to_vec(),
            hex("34aa973cd4c4daa4f61eeb2bdbad27316534016f")
        );
    }

    #[test]
    fn hmac_sha1_rfc2202() {
        assert_eq!(
            hmac_sha1(&[0x0b; 20], &[b"Hi There"]).to_vec(),
            hex("b617318655057264e28bc0b6fb378c8ef146be00")
        );
        assert_eq!(
            hmac_sha1(b"Jefe", &[b"what do ya ", b"want for nothing?"]).to_vec(),
            hex("effcdf6ae5eb2fa2d27416d5f184df9c259a7c79")
        );
        // Case 6: 80-byte key (longer than the block, hashed first)
        assert_eq!(
            hmac_sha1(
                &[0xaa; 80],
                &[b"Test Using Larger Than Block-Size Key - Hash Key First"]
            )
            .to_vec(),
            hex("aa4ae5e15272d00e95705637ce8a3b55ed402112")
        );
    }

    #[test]
    fn pbkdf2_rfc6070() {
        let mut o = [0u8; 20];
        pbkdf2_sha1(b"password", b"salt", 1, &mut o);
        assert_eq!(o.to_vec(), hex("0c60c80f961f0e71f3a9b524af6012062fe037a6"));
        pbkdf2_sha1(b"password", b"salt", 4096, &mut o);
        assert_eq!(o.to_vec(), hex("4b007901b765489abead49d926f721d065a429c1"));
        let mut o = [0u8; 25];
        pbkdf2_sha1(
            b"passwordPASSWORDpassword",
            b"saltSALTsaltSALTsaltSALTsaltSALTsalt",
            4096,
            &mut o,
        );
        assert_eq!(
            o.to_vec(),
            hex("3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038")
        );
    }

    #[test]
    fn wpa_psk_ieee80211_annex() {
        // IEEE 802.11 Annex J.4 (passphrase -> PSK)
        assert_eq!(
            wpa_pmk("password", b"IEEE").to_vec(),
            hex("f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e")
        );
        assert_eq!(
            wpa_pmk("ThisIsAPassword", b"ThisIsASSID").to_vec(),
            hex("0dc0d6eb90555ed6419756b9a15ec3e3209b63df707dd508d14581f8982721af")
        );
    }

    #[test]
    fn prf_ieee80211_annex() {
        // IEEE 802.11 Annex J.3 PRF test vector 1
        let mut o = [0u8; 64];
        prf(&[0x0b; 20], b"prefix", b"Hi There", &mut o);
        assert_eq!(
            o.to_vec(),
            hex("bcd4c650b30b9684951829e0d75f9d54b862175ed9f00606e17d8da35402ffee75df78c3d31e0f889f012120c0862beb67753e7439ae242edb8373698356cf5a")
        );
    }

    #[test]
    fn aes_fips197() {
        let pt: [u8; 16] = hex("00112233445566778899aabbccddeeff").try_into().unwrap();
        for (key, ct) in [
            (
                "000102030405060708090a0b0c0d0e0f",
                "69c4e0d86a7b0430d8cdb78070b4c55a",
            ),
            (
                "000102030405060708090a0b0c0d0e0f1011121314151617",
                "dda97ca4864cdfe06eaf70a0ec0d7191",
            ),
            (
                "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
                "8ea2b7ca516745bfeafc49904b496089",
            ),
        ] {
            let aes = Aes::new(&hex(key));
            let mut b = pt;
            aes.encrypt(&mut b);
            assert_eq!(b.to_vec(), hex(ct));
            aes.decrypt(&mut b);
            assert_eq!(b, pt);
        }
    }

    #[test]
    fn key_wrap_rfc3394() {
        let kek = hex("000102030405060708090A0B0C0D0E0F");
        let key = hex("00112233445566778899AABBCCDDEEFF");
        let c = key_wrap(&kek, &key);
        assert_eq!(c, hex("1FA68B0A8112B447 AEF34BD8FB5A7B82 9D3E862371D2CFE5"));
        assert_eq!(key_unwrap(&kek, &c).unwrap(), key);
        // 4.6: 256-bit KEK wrapping a 256-bit key
        let kek = hex("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F");
        let key = hex("00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F");
        let c = key_wrap(&kek, &key);
        assert_eq!(c, hex("28C9F404C4B810F4 CBCCB35CFB87F826 3F5786E2D80ED326 CBC7F0E71A99F43B FB988B9B7A02DD21"));
        let mut bad = c.clone();
        bad[3] ^= 1;
        assert!(key_unwrap(&kek, &bad).is_none());
    }

    #[test]
    fn ccm_rfc3610() {
        // RFC 3610 packet vector #1
        let key = hex("C0C1C2C3C4C5C6C7C8C9CACBCCCDCECF");
        let nonce = hex("00000003020100A0A1A2A3A4A5");
        let aad = hex("0001020304050607");
        let msg = hex("08090A0B0C0D0E0F101112131415161718191A1B1C1D1E");
        let ct = ccm_encrypt(&key, &nonce, &aad, &msg, 8);
        assert_eq!(
            ct,
            hex("588C979A61C663D2F066D0C2C0F989806D5F6B61DAC38417E8D12CFDF926E0")
        );
        assert_eq!(ccm_decrypt(&key, &nonce, &aad, &ct, 8).unwrap(), msg);
        // Packet vector #2 (31 bytes, crosses a block boundary)
        let nonce = hex("00000004030201A0A1A2A3A4A5");
        let msg = hex("08090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F");
        let ct = ccm_encrypt(&key, &nonce, &aad, &msg, 8);
        assert_eq!(
            ct,
            hex("72C91A36E135F8CF291CA894085C87E3CC15C439C9E43A3BA091D56E10400916")
        );
        let mut bad = ct.clone();
        bad[0] ^= 1;
        assert!(ccm_decrypt(&key, &nonce, &aad, &bad, 8).is_none());
    }

    #[test]
    fn ccmp_ieee80211_annex() {
        // IEEE 802.11 Annex J.6.4 CCMP test vector (data frame, no A4, non-QoS)
        let tk: [u8; 16] = hex("c9 7c 1f 67 ce 37 11 85 51 4a 8a 19 f2 bd d5 2f")
            .try_into()
            .unwrap();
        let pn = 0xB5039776E70Cu64;
        let plain = hex(
            "08 48 c3 2c 0f d2 e1 28 a5 7c 50 30 f1 84 44 08 ab ae a5 b8 fc ba 80 33
             f8 ba 1a 55 d0 2f 85 ae 96 7b b6 2f b6 cd a8 eb 7e 78 a0 50",
        );
        let want = hex(
            "08 48 c3 2c 0f d2 e1 28 a5 7c 50 30 f1 84 44 08 ab ae a5 b8 fc ba 80 33
             0c e7 00 20 76 97 03 b5
             f3 d0 a2 fe 9a 3d bf 23 42 a6 43 e4 32 46 e8 0c 3c 04 d0 19
             78 45 ce 0b 16 f9 76 23",
        );
        let enc = ccmp_encrypt(&tk, &plain, pn, 0);
        assert_eq!(enc, want);
        let (dec, p) = ccmp_decrypt(&tk, &enc).unwrap();
        // After decryption the Protected bit is cleared, everything else matches the original
        let mut exp = plain.clone();
        exp[1] &= !0x40;
        assert_eq!(dec, exp);
        assert_eq!(p, pn);
    }
}
