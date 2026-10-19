//! 802.11 frame building and parsing (only what the virtual AP needs).

pub type Mac = [u8; 6];
pub const BROADCAST: Mac = [0xff; 6];

/// First byte of the frame control field (type / subtype)
pub mod fc {
    pub const ASSOC_REQ: u8 = 0x00;
    pub const ASSOC_RESP: u8 = 0x10;
    pub const PROBE_REQ: u8 = 0x40;
    pub const PROBE_RESP: u8 = 0x50;
    pub const BEACON: u8 = 0x80;
    pub const DISASSOC: u8 = 0xa0;
    pub const AUTH: u8 = 0xb0;
    pub const DEAUTH: u8 = 0xc0;
    pub const ACTION: u8 = 0xd0;
    pub const NULL: u8 = 0x48;
    pub const QOS_NULL: u8 = 0xc8;
    pub const DATA: u8 = 0x08;
    pub const QOS_DATA: u8 = 0x88;
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for b in data {
        c ^= *b as u32;
        for _ in 0..8 {
            c = (c >> 1) ^ (0xedb8_8320 & (c & 1).wrapping_neg());
        }
    }
    !c
}

pub fn mac_str(m: &Mac) -> String {
    m.iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Parsed frame header
pub struct Hdr {
    pub fc0: u8,
    pub fc1: u8,
    pub a1: Mac,
    pub a2: Mac,
    pub a3: Mac,
    pub seq: u16,
    /// Body offset (26 with a QoS field, else 24)
    pub body: usize,
}

fn mac_at(f: &[u8], o: usize) -> Mac {
    let mut m = [0u8; 6];
    m.copy_from_slice(&f[o..o + 6]);
    m
}

pub fn parse(f: &[u8]) -> Option<Hdr> {
    if f.len() < 10 {
        return None;
    }
    let fc0 = f[0];
    let ctrl = fc0 & 0x0c == 0x04;
    if ctrl {
        return Some(Hdr {
            fc0,
            fc1: f[1],
            a1: mac_at(f, 4),
            a2: [0; 6],
            a3: [0; 6],
            seq: 0,
            body: f.len(),
        });
    }
    if f.len() < 24 {
        return None;
    }
    let qos = fc0 & 0x0c == 0x08 && fc0 & 0x80 != 0;
    Some(Hdr {
        fc0,
        fc1: f[1],
        a1: mac_at(f, 4),
        a2: mac_at(f, 10),
        a3: mac_at(f, 16),
        seq: u16::from_le_bytes([f[22], f[23]]) >> 4,
        body: if qos { 26 } else { 24 },
    })
}

/// Find an element ID in an information element list
pub fn find_ie(ies: &[u8], id: u8) -> Option<&[u8]> {
    let mut i = 0;
    while i + 2 <= ies.len() {
        let (t, l) = (ies[i], ies[i + 1] as usize);
        if i + 2 + l > ies.len() {
            return None;
        }
        if t == id {
            return Some(&ies[i + 2..i + 2 + l]);
        }
        i += 2 + l;
    }
    None
}

/// Management frame header
pub fn mgmt_hdr(fc0: u8, da: &Mac, sa: &Mac, bssid: &Mac, seq: u16) -> Vec<u8> {
    let mut f = vec![fc0, 0, 0, 0];
    f.extend_from_slice(da);
    f.extend_from_slice(sa);
    f.extend_from_slice(bssid);
    f.extend_from_slice(&(seq << 4).to_le_bytes());
    f
}

pub fn ie(f: &mut Vec<u8>, id: u8, data: &[u8]) {
    f.push(id);
    f.push(data.len() as u8);
    f.extend_from_slice(data);
}
