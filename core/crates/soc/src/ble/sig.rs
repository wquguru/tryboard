//! Finds libbtdm's VHCI boundary functions in user firmware by masked signatures (C-01 route a'). lint: allow-long-comment
//! Signatures come from tools/ble_sigs.py over each libbtdm_app*.a version with relocation fields and branch offsets masked,
//! so the repo holds no raw library bytes. Linker relaxation rewrites sequences (auipc+jalr -> jal / c.jal, lui dropped
//! and the following access made gp-relative), so matching is per instruction, not per byte.

/// (kind, masked value, mask, length)
#[derive(Clone, Copy, Debug)]
pub struct Unit(pub u8, pub u32, pub u32, pub u8);

const K_EXACT: u8 = 0;
const K_CALL: u8 = 1;
const K_HI20: u8 = 2;
const K_LO12: u8 = 3;

/// A code segment (load address, bytes)
pub type Seg<'a> = (u32, &'a [u8]);

fn half(b: &[u8], p: usize) -> u32 {
    b[p] as u32 | (b[p + 1] as u32) << 8
}

fn word(b: &[u8], p: usize) -> u32 {
    u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]])
}

pub fn match_at(b: &[u8], mut p: usize, units: &[Unit]) -> bool {
    let mut want_gp = false;
    for &Unit(k, v, m, ln) in units {
        if p + 2 > b.len() {
            return false;
        }
        let h = half(b, p);
        let is4 = h & 3 == 3;
        if is4 && p + 4 > b.len() {
            return false;
        }
        let w = if is4 { word(b, p) } else { h };
        match k {
            K_EXACT => {
                if (if is4 { 4 } else { 2 }) != ln || w & m != v {
                    return false;
                }
                p += ln as usize;
            }
            K_CALL => {
                let rd = v;
                if is4 && w & 0x7f == 0x17 && (w >> 7) & 31 == rd {
                    if p + 8 > b.len() {
                        return false;
                    }
                    let w2 = word(b, p + 4);
                    if w2 & 0x707f != 0x67 || (w2 >> 7) & 31 != rd || (w2 >> 15) & 31 != rd {
                        return false;
                    }
                    p += 8;
                } else if is4 && w & 0x7f == 0x6f && (w >> 7) & 31 == rd {
                    p += 4;
                } else if !is4
                    && ((rd == 1 && h & 0xe003 == 0x2001) || (rd == 0 && h & 0xe003 == 0xa001))
                {
                    p += 2;
                } else {
                    return false;
                }
            }
            K_HI20 => {
                if is4 && w & m == v {
                    p += 4;
                } else {
                    // Treat as an lui removed by relaxation: the next low-12-bit access must be gp-relative
                    want_gp = true;
                }
            }
            K_LO12 => {
                if !is4 || w & m != v || (want_gp && (w >> 15) & 31 != 3) {
                    return false;
                }
                want_gp = false;
                p += 4;
            }
            _ => return false,
        }
    }
    true
}

/// Hit addresses of all variants within [lo, hi) (deduplicated, ascending)
pub fn find(segs: &[Seg], variants: &[&[Unit]], lo: u32, hi: u32) -> Vec<u32> {
    let mut hits = Vec::new();
    for &(a, b) in segs {
        let end = a.wrapping_add(b.len() as u32);
        if end <= lo || a >= hi {
            continue;
        }
        let from = lo.saturating_sub(a) as usize & !1;
        let to = (hi.min(end) - a) as usize;
        let mut p = from;
        while p + 2 <= to {
            if variants.iter().any(|u| match_at(b, p, u)) {
                hits.push(a + p as u32);
            }
            p += 2;
        }
    }
    hits.sort_unstable();
    hits.dedup();
    hits
}

/// Located VHCI boundary function entry points
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Hooks {
    pub osi_funcs_register: u32,
    pub controller_init: u32,
    pub controller_enable: u32,
    pub get_mode: u32,
    pub check_send_available: u32,
    pub send_packet: u32,
    pub register_callback: u32,
    /// sdk_config_extend_set_pll_track writes through the sdk_config pointer set by the real btdm_controller_init, which we skip,
    /// so it must be a no-op too. IDF 5.1.2-5.5.1 bt.c call it right before btdm_controller_enable; 0 = no call (5.1.0 / 5.1.1)
    pub pll_track: u32,
}

/// Short functions (a few instructions) are only searched near their object-file neighbours to avoid false hits
const NEAR: u32 = 0x1_0000;

/// Locate every boundary function in the firmware code; any missing or ambiguous one fails (fall back to the app.elf route).
pub fn locate(segs: &[Seg]) -> Result<Hooks, String> {
    use super::sigs::*;
    let one = |name: &str, v: &[&[Unit]], lo: u32, hi: u32| -> Result<u32, String> {
        let h = find(segs, v, lo, hi);
        match h.len() {
            1 => Ok(h[0]),
            0 => Err(format!("{name} not found")),
            n => Err(format!("{name} matched {n} places, not unique")),
        }
    };
    let all = (0u32, u32::MAX);
    let send_packet = one(
        "API_vhci_host_send_packet",
        API_VHCI_HOST_SEND_PACKET,
        all.0,
        all.1,
    )?;
    let check = one(
        "API_vhci_host_check_send_available",
        API_VHCI_HOST_CHECK_SEND_AVAILABLE,
        all.0,
        all.1,
    )?;
    let init = one("btdm_controller_init", BTDM_CONTROLLER_INIT, all.0, all.1)?;
    let enable = one(
        "btdm_controller_enable",
        BTDM_CONTROLLER_ENABLE,
        all.0,
        all.1,
    )?;
    let osi = one(
        "btdm_osi_funcs_register",
        BTDM_OSI_FUNCS_REGISTER,
        all.0,
        all.1,
    )?;
    let near = |a: u32| (a.saturating_sub(NEAR), a.saturating_add(NEAR));
    let (lo, hi) = near(send_packet);
    let reg = one(
        "API_vhci_host_register_callback",
        API_VHCI_HOST_REGISTER_CALLBACK,
        lo,
        hi,
    )?;
    let (lo, hi) = near(init);
    let mode = one("btdm_controller_get_mode", BTDM_CONTROLLER_GET_MODE, lo, hi)?;
    // 0 = no call found: fine for IDF 5.1.0 / 5.1.1 bt.c (osi 0x10006, never calls it); the HLE rejects newer tables then
    let pll_track = pll_track_near_enable_call(segs, enable);
    Ok(Hooks {
        pll_track,
        osi_funcs_register: osi,
        controller_init: init,
        controller_enable: enable,
        get_mode: mode,
        check_send_available: check,
        send_packet,
        register_callback: reg,
    })
}

/// Target of the call instruction at p (jal ra / c.jal / auipc ra + jalr ra)
fn call_target(b: &[u8], p: usize, pc: u32) -> Option<u32> {
    if p + 2 > b.len() {
        return None;
    }
    let h = half(b, p);
    if h & 3 != 3 {
        if h & 0xe003 != 0x2001 {
            return None;
        }
        // c.jal: CJ-format immediate
        let bit = |i: u32| (h >> i) & 1;
        let imm = (bit(12) << 11)
            | (bit(11) << 4)
            | (((h >> 9) & 3) << 8)
            | (bit(8) << 10)
            | (bit(7) << 6)
            | (bit(6) << 7)
            | (((h >> 3) & 7) << 1)
            | (bit(2) << 5);
        let imm = ((imm << 20) as i32 >> 20) as u32;
        return Some(pc.wrapping_add(imm));
    }
    if p + 4 > b.len() {
        return None;
    }
    let w = word(b, p);
    if w & 0xfff == 0x0ef {
        let imm = ((w >> 31) << 20)
            | (((w >> 12) & 0xff) << 12)
            | (((w >> 20) & 1) << 11)
            | (((w >> 21) & 0x3ff) << 1);
        let imm = ((imm << 11) as i32 >> 11) as u32;
        return Some(pc.wrapping_add(imm));
    }
    if w & 0xfff == 0x097 && p + 8 <= b.len() {
        let w2 = word(b, p + 4);
        if w2 & 0xfffff == 0x080e7 {
            let lo = (w2 as i32 >> 20) as u32;
            return Some(pc.wrapping_add(w & 0xffff_f000).wrapping_add(lo));
        }
    }
    None
}

/// In esp_bt_controller_enable (bt.c, user-compiled, so no signature) find the call just before btdm_controller_enable whose
/// target matches pll_track's signature (alone it matches a dozen setters). At -Os only a 6-byte mv separates them; look back 24 for other levels
fn pll_track_near_enable_call(segs: &[Seg], enable: u32) -> u32 {
    use super::sigs::SDK_CONFIG_EXTEND_SET_PLL_TRACK as SIG;
    const BACK: usize = 24;
    let mut found = Vec::new();
    for &(a, b) in segs {
        let mut p = 0;
        while p + 2 <= b.len() {
            if call_target(b, p, a + p as u32) == Some(enable) {
                let mut best = 0;
                let mut q = p.saturating_sub(BACK);
                while q < p {
                    if let Some(t) = call_target(b, q, a + q as u32) {
                        if t != enable && find(segs, SIG, t, t + 2).len() == 1 {
                            best = t;
                        }
                    }
                    q += 2;
                }
                if best != 0 {
                    found.push(best);
                }
            }
            p += 2;
        }
    }
    found.sort_unstable();
    found.dedup();
    if found.len() == 1 {
        found[0]
    } else {
        0
    }
}

/// Whether the firmware shows signs of a BLE controller (tells 'no Bluetooth' apart from 'used but signature not recognised'):
/// looks for the IDF bt.c log tag in rodata (BLE_INIT in 5.x, BTDM_INIT earlier)
pub fn mentions_btdm(segs: &[Seg]) -> bool {
    const TAGS: [&[u8]; 2] = [b"\0BLE_INIT\0", b"\0BTDM_INIT\0"];
    segs.iter()
        .any(|(_, b)| TAGS.iter().any(|t| b.windows(t.len()).any(|w| w == *t)))
}
