//! Register-level tests of the shared SHA / AES models driven through the C3 bus (moved out of crypto_hw, R-05).

use crate::SocBus;
use tryboard_soc::crypto_hw::aes_stream;
use tryboard_soc::wifi::crypto::Aes;

fn hex(s: &str) -> Vec<u8> {
    let s: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// Drive the registers the way the driver does: message words little-endian into TEXT, digest bytes from H
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
    // FIPS 197 C.1, single-block mode
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
    // NIST SP 800-38A F.2.1 CBC-AES128 encrypt / F.5.1 CTR-AES128
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
    // F.3.13 CFB128-AES128 encrypt
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
