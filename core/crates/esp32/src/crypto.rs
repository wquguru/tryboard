//! Classic ESP32 SHA (0x3FF03000) and AES (0x3FF01000) accelerators; IDF uses them for the whole WPA2 handshake.
//! Previous IP generation from C3 / S3 (no DMA, digest read back via LOAD); register notes in docs/WIFI.md.

use tryboard_soc::crypto_hw::sha256_block;
use tryboard_soc::wifi::crypto::{sha1_block, Aes};

pub const SHA_BASE: u32 = 0x3ff0_3000;
pub const AES_BASE: u32 = 0x3ff0_1000;

/// 0 = SHA-1, 1 = SHA-256, 2 = SHA-384, 3 = SHA-512 (register groups 0x10 apart)
#[derive(Default)]
pub struct ShaHw {
    /// Text registers: big-endian message words on input (driver byte-swaps), state words after LOAD
    text: [u32; 32],
    h1: [u32; 5],
    h256: [u32; 8],
    h512: [u64; 8],
    pub blocks: u64,
}

const H1: [u32; 5] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
const H256: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const H384: [u64; 8] = [
    0xcbbb9d5dc1059ed8,
    0x629a292a367cd507,
    0x9159015a3070dd17,
    0x152fecd8f70e5939,
    0x67332667ffc00b31,
    0x8eb44a8768581511,
    0xdb0c2e0d64f98fa7,
    0x47b5481dbefa4fa4,
];
const H512: [u64; 8] = [
    0x6a09e667f3bcc908,
    0xbb67ae8584caa73b,
    0x3c6ef372fe94f82b,
    0xa54ff53a5f1d36f1,
    0x510e527fade682d1,
    0x9b05688c2b3e6c1f,
    0x1f83d9abfb41bd6b,
    0x5be0cd19137e2179,
];
const K512: [u64; 80] = [
    0x428a2f98d728ae22,
    0x7137449123ef65cd,
    0xb5c0fbcfec4d3b2f,
    0xe9b5dba58189dbbc,
    0x3956c25bf348b538,
    0x59f111f1b605d019,
    0x923f82a4af194f9b,
    0xab1c5ed5da6d8118,
    0xd807aa98a3030242,
    0x12835b0145706fbe,
    0x243185be4ee4b28c,
    0x550c7dc3d5ffb4e2,
    0x72be5d74f27b896f,
    0x80deb1fe3b1696b1,
    0x9bdc06a725c71235,
    0xc19bf174cf692694,
    0xe49b69c19ef14ad2,
    0xefbe4786384f25e3,
    0x0fc19dc68b8cd5b5,
    0x240ca1cc77ac9c65,
    0x2de92c6f592b0275,
    0x4a7484aa6ea6e483,
    0x5cb0a9dcbd41fbd4,
    0x76f988da831153b5,
    0x983e5152ee66dfab,
    0xa831c66d2db43210,
    0xb00327c898fb213f,
    0xbf597fc7beef0ee4,
    0xc6e00bf33da88fc2,
    0xd5a79147930aa725,
    0x06ca6351e003826f,
    0x142929670a0e6e70,
    0x27b70a8546d22ffc,
    0x2e1b21385c26c926,
    0x4d2c6dfc5ac42aed,
    0x53380d139d95b3df,
    0x650a73548baf63de,
    0x766a0abb3c77b2a8,
    0x81c2c92e47edaee6,
    0x92722c851482353b,
    0xa2bfe8a14cf10364,
    0xa81a664bbc423001,
    0xc24b8b70d0f89791,
    0xc76c51a30654be30,
    0xd192e819d6ef5218,
    0xd69906245565a910,
    0xf40e35855771202a,
    0x106aa07032bbd1b8,
    0x19a4c116b8d2d0c8,
    0x1e376c085141ab53,
    0x2748774cdf8eeb99,
    0x34b0bcb5e19b48a8,
    0x391c0cb3c5c95a63,
    0x4ed8aa4ae3418acb,
    0x5b9cca4f7763e373,
    0x682e6ff3d6b2b8a3,
    0x748f82ee5defb2fc,
    0x78a5636f43172f60,
    0x84c87814a1f0ab72,
    0x8cc702081a6439ec,
    0x90befffa23631e28,
    0xa4506cebde82bde9,
    0xbef9a3f7b2c67915,
    0xc67178f2e372532b,
    0xca273eceea26619c,
    0xd186b8c721c0c207,
    0xeada7dd6cde0eb1e,
    0xf57d4f7fee6ed178,
    0x06f067aa72176fba,
    0x0a637dc5a2c898a6,
    0x113f9804bef90dae,
    0x1b710b35131c471b,
    0x28db77f523047d84,
    0x32caab7b40c72493,
    0x3c9ebe0a15c9bebc,
    0x431d67c49c100d4c,
    0x4cc5d4becb3e42b6,
    0x597f299cfc657e2a,
    0x5fcb6fab3ad6faec,
    0x6c44198c4a475817,
];

/// SHA-512 compression (FIPS 180-4 §6.4.2), shared with SHA-384
pub fn sha512_block(h: &mut [u64; 8], w16: &[u64; 16]) {
    let mut w = [0u64; 80];
    w[..16].copy_from_slice(w16);
    for i in 16..80 {
        let s0 = w[i - 15].rotate_right(1) ^ w[i - 15].rotate_right(8) ^ (w[i - 15] >> 7);
        let s1 = w[i - 2].rotate_right(19) ^ w[i - 2].rotate_right(61) ^ (w[i - 2] >> 6);
        w[i] = w[i - 16]
            .wrapping_add(s0)
            .wrapping_add(w[i - 7])
            .wrapping_add(s1);
    }
    let mut s = *h;
    for i in 0..80 {
        let [a, b, c, d, e, f, g, hh] = s;
        let t1 = hh
            .wrapping_add(e.rotate_right(14) ^ e.rotate_right(18) ^ e.rotate_right(41))
            .wrapping_add((e & f) ^ (!e & g))
            .wrapping_add(K512[i])
            .wrapping_add(w[i]);
        let t2 = (a.rotate_right(28) ^ a.rotate_right(34) ^ a.rotate_right(39))
            .wrapping_add((a & b) ^ (a & c) ^ (b & c));
        s = [t1.wrapping_add(t2), a, b, c, d.wrapping_add(t1), e, f, g];
    }
    for (x, y) in h.iter_mut().zip(s) {
        *x = x.wrapping_add(y);
    }
}

impl ShaHw {
    pub fn read(&self, off: u32) -> u32 {
        match off {
            0..=0x7c => self.text[(off / 4) as usize],
            // BUSY: each write completes immediately
            _ => 0,
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        if off < 0x80 {
            self.text[(off / 4) as usize] = v;
            return;
        }
        if !(0x80..0xc0).contains(&off) {
            return;
        }
        let ty = (off - 0x80) / 0x10;
        match (off - 0x80) % 0x10 {
            0 => self.block(ty, true),
            4 => self.block(ty, false),
            8 => self.load(ty),
            _ => {}
        }
    }

    /// Message block in the text registers (big-endian bytes)
    fn block_bytes(&self, words: usize) -> Vec<u8> {
        self.text[..words]
            .iter()
            .flat_map(|w| w.to_be_bytes())
            .collect()
    }

    fn block(&mut self, ty: u32, first: bool) {
        self.blocks += 1;
        match ty {
            0 => {
                if first {
                    self.h1 = H1;
                }
                let b = self.block_bytes(16);
                sha1_block(&mut self.h1, &b);
            }
            1 => {
                if first {
                    self.h256 = H256;
                }
                let b = self.block_bytes(16);
                sha256_block(&mut self.h256, &b);
            }
            _ => {
                if first {
                    self.h512 = if ty == 2 { H384 } else { H512 };
                }
                let mut w = [0u64; 16];
                for (i, x) in w.iter_mut().enumerate() {
                    *x = (self.text[2 * i] as u64) << 32 | self.text[2 * i + 1] as u64;
                }
                sha512_block(&mut self.h512, &w);
            }
        }
    }

    /// LOAD: copy internal state into text registers (driver reads native words, high word first for 64-bit)
    fn load(&mut self, ty: u32) {
        match ty {
            0 => self.text[..5].copy_from_slice(&self.h1),
            1 => self.text[..8].copy_from_slice(&self.h256),
            _ => {
                for (i, x) in self.h512.iter().enumerate() {
                    self.text[2 * i] = (x >> 32) as u32;
                    self.text[2 * i + 1] = *x as u32;
                }
            }
        }
    }
}

#[derive(Default)]
pub struct AesHw {
    key: [u32; 8],
    text: [u32; 4],
    mode: u32,
    pub blocks: u64,
}

impl AesHw {
    pub fn read(&self, off: u32) -> u32 {
        match off {
            // IDLE: computed synchronously
            0x04 => 1,
            0x08 => self.mode,
            0x10..=0x2c => self.key[((off - 0x10) / 4) as usize],
            0x30..=0x3c => self.text[((off - 0x30) / 4) as usize],
            _ => 0,
        }
    }

    pub fn write(&mut self, off: u32, v: u32) {
        match off {
            0x00 if v & 1 != 0 => self.start(),
            0x08 => self.mode = v & 7,
            0x10..=0x2c => self.key[((off - 0x10) / 4) as usize] = v,
            0x30..=0x3c => self.text[((off - 0x30) / 4) as usize] = v,
            _ => {}
        }
    }

    /// MODE: bit 2 = decrypt, bits 1..0 = 0/1/2 for 128/192/256-bit keys.
    /// Key and text load in memory byte order (driver memcpys in and out); AES_ENDIAN stays at reset value
    fn start(&mut self) {
        let klen = match self.mode & 3 {
            0 => 16,
            1 => 24,
            _ => 32,
        };
        let key: Vec<u8> = self.key.iter().flat_map(|w| w.to_le_bytes()).collect();
        let aes = Aes::new(&key[..klen]);
        let mut b = [0u8; 16];
        for (i, w) in self.text.iter().enumerate() {
            b[4 * i..4 * i + 4].copy_from_slice(&w.to_le_bytes());
        }
        if self.mode & 4 != 0 {
            aes.decrypt(&mut b);
        } else {
            aes.encrypt(&mut b);
        }
        for (i, w) in self.text.iter_mut().enumerate() {
            *w = u32::from_le_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]);
        }
        self.blocks += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Feed a padded single-block "abc" the way the driver does and read back the digest
    fn hash_abc(ty: u32, block_bytes: usize, out_words: usize) -> Vec<u8> {
        let mut m = vec![0u8; block_bytes];
        m[..3].copy_from_slice(b"abc");
        m[3] = 0x80;
        m[block_bytes - 1] = 24;
        let mut sha = ShaHw::default();
        for (i, c) in m.chunks(4).enumerate() {
            // sha_ll_fill_text_block: little-endian word byte-swapped = big-endian word
            sha.write(4 * i as u32, u32::from_be_bytes([c[0], c[1], c[2], c[3]]));
        }
        let base = 0x80 + 0x10 * ty;
        sha.write(base, 1);
        sha.write(base + 8, 1);
        let words: Vec<u32> = (0..out_words).map(|i| sha.read(4 * i as u32)).collect();
        // mbedtls outputs native state words big-endian; 64-bit state is read high word first
        words.iter().flat_map(|w| w.to_be_bytes()).collect()
    }

    #[test]
    fn sha_fips180_abc() {
        assert_eq!(
            hash_abc(0, 64, 5),
            hex("a9993e364706816aba3e25717850c26c9cd0d89d")
        );
        assert_eq!(
            hash_abc(1, 64, 8),
            hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(
            hash_abc(3, 128, 16),
            hex(concat!(
                "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a",
                "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
            ))
        );
        assert_eq!(
            hash_abc(2, 128, 12),
            hex(concat!(
                "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed",
                "8086072ba1e7cc2358baeca134c825a7"
            ))
        );
    }

    #[test]
    fn aes_fips197() {
        let mut aes = AesHw::default();
        let key = hex("000102030405060708090a0b0c0d0e0f");
        let pt = hex("00112233445566778899aabbccddeeff");
        for (i, c) in key.chunks(4).enumerate() {
            aes.write(
                0x10 + 4 * i as u32,
                u32::from_le_bytes(c.try_into().unwrap()),
            );
        }
        for (i, c) in pt.chunks(4).enumerate() {
            aes.write(
                0x30 + 4 * i as u32,
                u32::from_le_bytes(c.try_into().unwrap()),
            );
        }
        aes.write(0x08, 0);
        aes.write(0x00, 1);
        let ct: Vec<u8> = (0..4)
            .flat_map(|i| aes.read(0x30 + 4 * i).to_le_bytes())
            .collect();
        assert_eq!(ct, hex("69c4e0d86a7b0430d8cdb78070b4c55a"));
        aes.write(0x08, 4);
        aes.write(0x00, 1);
        let back: Vec<u8> = (0..4)
            .flat_map(|i| aes.read(0x30 + 4 * i).to_le_bytes())
            .collect();
        assert_eq!(back, pt);
    }
}
