//! SHA（0x6003B000）与 AES（0x6003A000）硬件加速器。
//!
//! 为什么要模拟：IDF 默认打开 MBEDTLS_HARDWARE_SHA / AES，Wi-Fi 的 WPA2 四次握手（PBKDF2、
//! HMAC-SHA1 MIC、AES Key Unwrap）全经过它们；不建模时寄存器读回 0，sha_hal 发现全零摘要直接 abort。
//! C3 与 S3 的寄存器排布相同（hwcrypto_reg.h），模型不依赖具体 SoC：寄存器写时由 SoC 先从 GDMA 取链头，再借总线（`DmaMem`）。
//! 两者的 DMA 模式要从 GDMA 描述符取 / 写数据：通过 SoC 的 GDMA 模型（`gdma.rs`，按芯片排布）按
//! OUT/IN_PERI_SEL 找到接到本外设的通道、取它配置的链表头。搬数据仍走本文件的 gather / scatter：
//! IDF 的 AES / SHA 驱动先配链表、再启动加速器，GDMA 的 start 位不一定在触发之前置上，
//! 不能用 `Gdma::take_out`（它只认已启动的通道）。

use crate::gdma::{DmaMem, Gdma};
use crate::wifi::crypto::{sha1_block, Aes};

pub const SHA_BASE: u32 = 0x6003_b000;
pub const AES_BASE: u32 = 0x6003_a000;

/// GDMA 外设编号（soc/gdma_channel.h）
const PERI_AES: u32 = 6;
const PERI_SHA: u32 = 7;

#[derive(Default)]
pub struct ShaHw {
    mode: u32,
    block_num: u32,
    /// H 寄存器（按总线上的字存，即摘要字节按小端装载）
    h: [u32; 8],
    text: [u32; 16],
    pub blocks: u64,
}

#[derive(Default)]
pub struct AesHw {
    key: [u32; 8],
    text_in: [u32; 4],
    text_out: [u32; 4],
    iv: [u32; 4],
    mode: u32,
    block_mode: u32,
    block_num: u32,
    dma_enable: u32,
    /// 0 空闲、1 忙、2 DMA 完成（等 DMA_EXIT）
    state: u32,
    int_ena: u32,
    pub blocks: u64,
}

const SHA1_IV: [u32; 5] = [
    0x6745_2301,
    0xefcd_ab89,
    0x98ba_dcfe,
    0x1032_5476,
    0xc3d2_e1f0,
];
const SHA224_IV: [u32; 8] = [
    0xc105_9ed8,
    0x367c_d507,
    0x3070_dd17,
    0xf70e_5939,
    0xffc0_0b31,
    0x6858_1511,
    0x64f9_8fa7,
    0xbefa_4fa4,
];
const SHA256_IV: [u32; 8] = [
    0x6a09_e667,
    0xbb67_ae85,
    0x3c6e_f372,
    0xa54f_f53a,
    0x510e_527f,
    0x9b05_688c,
    0x1f83_d9ab,
    0x5be0_cd19,
];

const K256: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// SHA-256 压缩函数（FIPS 180-4 §6.2.2），SHA-224 共用
pub fn sha256_block(h: &mut [u32; 8], b: &[u8]) {
    let mut w = [0u32; 64];
    for i in 0..16 {
        w[i] = u32::from_be_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]);
    }
    for i in 16..64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16]
            .wrapping_add(s0)
            .wrapping_add(w[i - 7])
            .wrapping_add(s1);
    }
    let mut s = *h;
    for i in 0..64 {
        let [a, b, c, d, e, f, g, hh] = s;
        let t1 = hh
            .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
            .wrapping_add((e & f) ^ (!e & g))
            .wrapping_add(K256[i])
            .wrapping_add(w[i]);
        let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
            .wrapping_add((a & b) ^ (a & c) ^ (b & c));
        s = [t1.wrapping_add(t2), a, b, c, d.wrapping_add(t1), e, f, g];
    }
    for (x, y) in h.iter_mut().zip(s) {
        *x = x.wrapping_add(y);
    }
}

impl ShaHw {
    /// 压缩一块；first = 先装初值（START / DMA_START）
    fn process(&mut self, block: &[u8], first: bool) {
        // 寄存器里的字是内存字节按小端装载的，算法要大端字：H 进出都要字节翻转
        match self.mode {
            0 => {
                let mut h = SHA1_IV;
                if !first {
                    for (x, y) in h.iter_mut().zip(&self.h) {
                        *x = y.swap_bytes();
                    }
                }
                sha1_block(&mut h, block);
                for (x, y) in self.h.iter_mut().zip(h) {
                    *x = y.swap_bytes();
                }
            }
            1 | 2 => {
                let mut h = if first {
                    if self.mode == 1 {
                        SHA224_IV
                    } else {
                        SHA256_IV
                    }
                } else {
                    self.h.map(|x| x.swap_bytes())
                };
                sha256_block(&mut h, block);
                self.h = h.map(|x| x.swap_bytes());
            }
            // SHA-384/512 在 C3 上没有
            _ => {}
        }
        self.blocks += 1;
    }
}

/// 某个外设接到的 GDMA 通道的描述符链头（out = 内存 → 外设）
fn gdma_link(gdma: &Gdma, peri: u32, out: bool) -> Option<u32> {
    let ch = gdma.channel_for_peri(peri, out)?;
    Some(gdma.configured_link(ch, out))
}

/// SHA 的 DMA 输入链头（寄存器写之前从 GDMA 取，免得同时借用 GDMA 和总线）
pub fn sha_link(gdma: &Gdma) -> Option<u32> {
    gdma_link(gdma, PERI_SHA, true)
}

/// AES 的 DMA（输入, 输出）链头
pub fn aes_links(gdma: &Gdma) -> (Option<u32>, Option<u32>) {
    (
        gdma_link(gdma, PERI_AES, true),
        gdma_link(gdma, PERI_AES, false),
    )
}

/// 沿发送描述符链（lldesc）读出最多 n 字节
fn dma_gather(mem: &mut dyn DmaMem, mut d: u32, n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n);
    for _ in 0..256 {
        if out.len() >= n || d < 0x3fc0_0000 {
            break;
        }
        let w0 = mem.rd32(d);
        let buf = mem.rd32(d + 4);
        let len = (w0 >> 12) & 0xfff;
        for i in 0..len {
            out.push(mem.rd8(buf + i));
        }
        // 用完交还软件
        mem.wr32(d, w0 & !(1 << 31));
        let next = mem.rd32(d + 8);
        if w0 & (1 << 30) != 0 || next == 0 {
            break;
        }
        d = next;
    }
    out.truncate(n);
    out
}

/// 沿接收描述符链写入数据，最后一个置 EOF，全部交还软件
fn dma_scatter(mem: &mut dyn DmaMem, mut d: u32, data: &[u8]) {
    let mut off = 0usize;
    for _ in 0..256 {
        if d < 0x3fc0_0000 {
            break;
        }
        let w0 = mem.rd32(d);
        let buf = mem.rd32(d + 4);
        let size = (w0 & 0xfff) as usize;
        let k = size.min(data.len() - off);
        for i in 0..k {
            mem.wr8(buf + i as u32, data[off + i]);
        }
        off += k;
        let next = mem.rd32(d + 8);
        let last = off >= data.len() || next == 0;
        let w0n = (w0 & 0xfff) | ((k as u32) << 12) | if last { 1 << 30 } else { 0 };
        mem.wr32(d, w0n);
        if last {
            break;
        }
        d = next;
    }
}

impl ShaHw {
    pub fn read(&self, off: u32) -> u32 {
        match off {
            0x00 => self.mode,
            0x0c => self.block_num,
            0x18 => 0, // BUSY：瞬间完成
            0x2c => 0x2007_0000,
            0x40..=0x5f => self.h[((off - 0x40) / 4) as usize],
            0x80..=0xbf => self.text[((off - 0x80) / 4) as usize],
            _ => 0,
        }
    }

    /// 寄存器写；DMA 模式按 GDMA 里接到 SHA 的通道取数据
    pub fn write(&mut self, off: u32, v: u32, link: Option<u32>, mem: &mut dyn DmaMem) {
        match off {
            0x00 => self.mode = v & 7,
            0x0c => self.block_num = v & 0x3f,
            0x10 | 0x14 => {
                let mut b = [0u8; 64];
                for (i, w) in self.text.iter().enumerate() {
                    b[4 * i..4 * i + 4].copy_from_slice(&w.to_le_bytes());
                }
                self.process(&b, off == 0x10);
            }
            0x1c | 0x20 => {
                let n = self.block_num as usize;
                let data = match link {
                    Some(d) => dma_gather(mem, d, n * 64),
                    None => Vec::new(),
                };
                for (i, blk) in data.as_chunks::<64>().0.iter().enumerate() {
                    self.process(blk, off == 0x1c && i == 0);
                }
            }
            0x40..=0x5f => self.h[((off - 0x40) / 4) as usize] = v,
            0x80..=0xbf => self.text[((off - 0x80) / 4) as usize] = v,
            _ => {}
        }
    }
}

impl AesHw {
    pub fn read(&self, off: u32) -> u32 {
        let a = self;
        match off {
            0x00..=0x1f => a.key[(off / 4) as usize],
            0x20..=0x2f => a.text_in[((off - 0x20) / 4) as usize],
            0x30..=0x3f => a.text_out[((off - 0x30) / 4) as usize],
            0x40 => a.mode,
            0x4c => a.state,
            0x50..=0x5f => a.iv[((off - 0x50) / 4) as usize],
            0x90 => a.dma_enable,
            0x94 => a.block_mode,
            0x98 => a.block_num,
            0xb0 => a.int_ena,
            0xb4 => 0x2019_1210,
            _ => 0,
        }
    }

    pub fn write(
        &mut self,
        off: u32,
        v: u32,
        links: (Option<u32>, Option<u32>),
        mem: &mut dyn DmaMem,
    ) {
        if off == 0x48 {
            return self.trigger(links, mem);
        }
        let a = self;
        match off {
            0x00..=0x1f => a.key[(off / 4) as usize] = v,
            0x20..=0x2f => a.text_in[((off - 0x20) / 4) as usize] = v,
            0x40 => a.mode = v & 7,
            0x50..=0x5f => a.iv[((off - 0x50) / 4) as usize] = v,
            0x90 => a.dma_enable = v & 1,
            0x94 => a.block_mode = v & 7,
            0x98 => a.block_num = v,
            0xb0 => a.int_ena = v & 1,
            0xb8 => a.state = 0, // DMA_EXIT
            _ => {}
        }
    }

    fn cipher(&self) -> (Aes, bool) {
        // MODE：位 2 = 解密，低 2 位 0 = 128 位、2 = 256 位（C3 / S3 都没有 192）
        let klen = if self.mode & 3 == 2 { 32 } else { 16 };
        let mut key = Vec::with_capacity(32);
        for w in &self.key[..klen / 4] {
            key.extend_from_slice(&w.to_le_bytes());
        }
        (Aes::new(&key), self.mode & 4 != 0)
    }

    fn trigger(&mut self, links: (Option<u32>, Option<u32>), mem: &mut dyn DmaMem) {
        let (aes, dec) = self.cipher();
        if self.dma_enable == 0 {
            // 单块模式：TEXT_IN → TEXT_OUT，只有 ECB
            let mut b = words_to_block(&self.text_in);
            if dec {
                aes.decrypt(&mut b);
            } else {
                aes.encrypt(&mut b);
            }
            self.text_out = block_to_words(&b);
            self.blocks += 1;
            return;
        }
        let n = self.block_num as usize * 16;
        let input = match links.0 {
            Some(d) => dma_gather(mem, d, n),
            None => vec![0; n],
        };
        let mut iv = words_to_block(&self.iv);
        let out = aes_stream(&aes, dec, self.block_mode, &mut iv, &input);
        self.iv = block_to_words(&iv);
        if let Some(d) = links.1 {
            dma_scatter(mem, d, &out);
        }
        self.blocks += self.block_num as u64;
        self.state = 2;
    }
}

fn words_to_block(w: &[u32; 4]) -> [u8; 16] {
    let mut b = [0u8; 16];
    for i in 0..4 {
        b[4 * i..4 * i + 4].copy_from_slice(&w[i].to_le_bytes());
    }
    b
}

fn block_to_words(b: &[u8; 16]) -> [u32; 4] {
    [0, 1, 2, 3].map(|i| u32::from_le_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]))
}

/// DMA 模式下按分组模式处理（BLOCK_MODE：0 ECB、1 CBC、2 OFB、3 CTR、4 CFB8、5 CFB128）；iv 原地更新
pub fn aes_stream(aes: &Aes, dec: bool, mode: u32, iv: &mut [u8; 16], input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    if mode == 4 {
        for &x in input {
            let mut k = *iv;
            aes.encrypt(&mut k);
            let y = x ^ k[0];
            let fb = if dec { x } else { y };
            iv.copy_within(1.., 0);
            iv[15] = fb;
            out.push(y);
        }
        return out;
    }
    for chunk in input.chunks(16) {
        let mut b = [0u8; 16];
        b[..chunk.len()].copy_from_slice(chunk);
        let r = match mode {
            0 => {
                if dec {
                    aes.decrypt(&mut b)
                } else {
                    aes.encrypt(&mut b)
                }
                b
            }
            1 => {
                if dec {
                    let c = b;
                    aes.decrypt(&mut b);
                    xor(&mut b, iv);
                    *iv = c;
                    b
                } else {
                    xor(&mut b, iv);
                    aes.encrypt(&mut b);
                    *iv = b;
                    b
                }
            }
            2 => {
                aes.encrypt(iv);
                xor(&mut b, iv);
                b
            }
            3 => {
                let mut k = *iv;
                aes.encrypt(&mut k);
                xor(&mut b, &k);
                // INC_SEL = 0：计数器是最后 32 位（大端）
                let c = u32::from_be_bytes([iv[12], iv[13], iv[14], iv[15]]).wrapping_add(1);
                iv[12..].copy_from_slice(&c.to_be_bytes());
                b
            }
            _ => {
                let mut k = *iv;
                aes.encrypt(&mut k);
                let c_in = b;
                xor(&mut b, &k);
                *iv = if dec { c_in } else { b };
                b
            }
        };
        out.extend_from_slice(&r[..chunk.len()]);
    }
    out
}

fn xor(a: &mut [u8; 16], b: &[u8; 16]) {
    for (x, y) in a.iter_mut().zip(b) {
        *x ^= y;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SocBus;

    fn hex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// 按驱动的用法喂寄存器：消息字按小端写进 TEXT，读 H 得到摘要字节
    fn hw_hash(bus: &mut SocBus, mode: u32, msg: &[u8], out_words: usize) -> Vec<u8> {
        let mut m = msg.to_vec();
        let bits = (msg.len() as u64) * 8;
        m.push(0x80);
        while m.len() % 64 != 56 {
            m.push(0);
        }
        m.extend_from_slice(&bits.to_be_bytes());
        bus.sha_write(0, mode);
        for (i, blk) in m.chunks(64).enumerate() {
            for j in 0..16 {
                let w = u32::from_le_bytes(blk[4 * j..4 * j + 4].try_into().unwrap());
                bus.sha_write(0x80 + 4 * j as u32, w);
            }
            bus.sha_write(if i == 0 { 0x10 } else { 0x14 }, 1);
        }
        (0..out_words)
            .flat_map(|i| bus.sha_read(0x40 + 4 * i as u32).to_le_bytes())
            .collect()
    }

    #[test]
    fn sha_hw_fips180() {
        let mut bus = SocBus::default();
        assert_eq!(
            hw_hash(&mut bus, 0, b"abc", 5),
            hex("a9993e364706816aba3e25717850c26c9cd0d89d")
        );
        assert_eq!(
            hw_hash(&mut bus, 2, b"abc", 8),
            hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(
            hw_hash(
                &mut bus,
                2,
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
                8
            ),
            hex("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
        );
        assert_eq!(
            hw_hash(&mut bus, 1, b"abc", 7),
            hex("23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7")
        );
    }

    #[test]
    fn aes_hw_block_and_modes() {
        let mut bus = SocBus::default();
        // FIPS 197 C.1，单块模式
        let key = hex("000102030405060708090a0b0c0d0e0f");
        for i in 0..4 {
            bus.aes_write(
                4 * i,
                u32::from_le_bytes(key[4 * i as usize..4 * i as usize + 4].try_into().unwrap()),
            );
        }
        let pt = hex("00112233445566778899aabbccddeeff");
        for i in 0..4 {
            bus.aes_write(
                0x20 + 4 * i,
                u32::from_le_bytes(pt[4 * i as usize..4 * i as usize + 4].try_into().unwrap()),
            );
        }
        bus.aes_write(0x40, 0);
        bus.aes_write(0x48, 1);
        let ct: Vec<u8> = (0..4)
            .flat_map(|i| bus.aes_read(0x30 + 4 * i).to_le_bytes())
            .collect();
        assert_eq!(ct, hex("69c4e0d86a7b0430d8cdb78070b4c55a"));
        // NIST SP 800-38A F.2.1 CBC-AES128 加密 / F.5.1 CTR-AES128
        let aes = Aes::new(&hex("2b7e151628aed2a6abf7158809cf4f3c"));
        let p = hex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51");
        let mut iv: [u8; 16] = hex("000102030405060708090a0b0c0d0e0f").try_into().unwrap();
        assert_eq!(
            aes_stream(&aes, false, 1, &mut iv, &p),
            hex("7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2")
        );
        let mut iv: [u8; 16] = hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff").try_into().unwrap();
        assert_eq!(
            aes_stream(&aes, false, 3, &mut iv, &p),
            hex("874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff")
        );
        // F.3.13 CFB128-AES128 加密
        let mut iv: [u8; 16] = hex("000102030405060708090a0b0c0d0e0f").try_into().unwrap();
        assert_eq!(
            aes_stream(&aes, false, 5, &mut iv, &p),
            hex("3b3fd92eb72dad20333449f8e83cfb4ac8a64537a0b3a93fcde3cdad9f1ce58b")
        );
        // F.4.1 OFB-AES128
        let mut iv: [u8; 16] = hex("000102030405060708090a0b0c0d0e0f").try_into().unwrap();
        assert_eq!(
            aes_stream(&aes, false, 2, &mut iv, &p),
            hex("3b3fd92eb72dad20333449f8e83cfb4a7789508d16918f03f53c52dac54ed825")
        );
    }
}
