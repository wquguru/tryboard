//! Xtensa (ESP32-S3) counterpart of sig.rs (E-04): locates libbtdm's VHCI boundary functions by masked signatures.
//! Signatures come from `tools/ble_sigs.py gen-xt` / `gen-lx6` (classic ESP32, E-09); masking scheme in DECISIONS 2026-10-20 E-04.

use super::sig::{Hooks, Seg, Unit};

const X_EXACT: u8 = 0;
const X_LONGCALL: u8 = 1;
const X_FILL: u8 = 2;
const X_LIT: u8 = 3;

/// Instruction length from op0 (8..13 are the 16-bit density forms)
fn len(b0: u8) -> usize {
    if (8..=13).contains(&(b0 & 0xf)) {
        2
    } else {
        3
    }
}

fn insn(b: &[u8], p: usize, n: usize) -> u32 {
    (0..n).fold(0, |w, i| w | (b[p + i] as u32) << (8 * i))
}

fn word(b: &[u8], p: usize) -> u32 {
    u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]])
}

/// 24-bit equivalent of a density instruction (ld widens or narrows them while relaxing longcalls, E-09);
/// None for narrow branches and forms without one. Wide input comes back unchanged
fn wide(w: u32, n: usize) -> Option<u32> {
    if n == 3 {
        return Some(w);
    }
    let (op0, t, s, r) = (w & 0xf, (w >> 4) & 0xf, (w >> 8) & 0xf, (w >> 12) & 0xf);
    match op0 {
        // L32I.N / S32I.N -> L32I / S32I
        0x8 => Some(0x2 | t << 4 | s << 8 | 0x2 << 12 | r << 16),
        0x9 => Some(0x2 | t << 4 | s << 8 | 0x6 << 12 | r << 16),
        // ADD.N -> ADD; ADDI.N -> ADDI (imm 0 encodes -1)
        0xa => Some(t << 4 | s << 8 | r << 12 | 0x8 << 20),
        0xb => Some(0x2 | r << 4 | s << 8 | 0xc << 12 | if t == 0 { 0xff } else { t } << 16),
        // MOVI.N -> MOVI (imm7 spans -32..95)
        0xc if t & 8 == 0 => {
            let i = (t & 7) << 4 | r;
            let i = if i >= 96 { i.wrapping_sub(128) } else { i } & 0xfff;
            Some(0x2 | s << 4 | (i >> 8) << 8 | 0xa << 12 | (i & 0xff) << 16)
        }
        // MOV.N -> OR; RET.N / RETW.N / NOP.N
        0xd if r == 0 => Some(s << 4 | s << 8 | t << 12 | 0x2 << 20),
        0xd if r == 0xf && s == 0 => match t {
            0 => Some(0x80),
            1 => Some(0x90),
            3 => Some(0x20f0),
            _ => None,
        },
        _ => None,
    }
}

/// Unit (v, m, ln) matches instruction w of length n; narrow and wide forms are equal only for fully exact units
fn same(w: u32, n: usize, v: u32, m: u32, ln: u8) -> bool {
    if n == ln as usize {
        return w & m == v;
    }
    let full = if ln == 2 { 0xffff } else { 0xff_ffff };
    m == full && wide(w, n).is_some_and(|x| Some(x) == wide(v, ln as usize))
}

/// L32R literal address relative to the segment start (imm16 is always negative)
fn l32r_lit(base: u32, p: usize, w: u32) -> i64 {
    let pc = base.wrapping_add(p as u32);
    let imm = ((w >> 8) | 0xffff_0000) as i32 as i64;
    ((pc.wrapping_add(3) & !3) as i64) + (imm << 2) - base as i64
}

/// Match units at offset p of a segment loaded at base
pub fn match_at(b: &[u8], mut p: usize, units: &[Unit], base: u32) -> bool {
    let mut lit: Option<i64> = None;
    for (i, &Unit(k, v, m, ln)) in units.iter().enumerate() {
        match k {
            X_FILL => {
                // Relaxation changes the alignment fill after a jump, so try every size (zero bytes only)
                return (0..4).any(|n| {
                    p + n <= b.len()
                        && b[p..p + n].iter().all(|&x| x == 0)
                        && match_at(b, p + n, &units[i + 1..], base)
                });
            }
            X_LIT => {
                match lit {
                    Some(l) if l >= 0 && l as usize + 4 <= b.len() && word(b, l as usize) == v => {}
                    _ => return false,
                }
                continue;
            }
            _ => {}
        }
        if p >= b.len() {
            return false;
        }
        let n = len(b[p]);
        if p + n > b.len() {
            return false;
        }
        let w = insn(b, p, n);
        if k == X_EXACT {
            if !same(w, n, v, m, ln) {
                return false;
            }
            if w & 0xf == 1 {
                lit = Some(l32r_lit(base, p, w));
            }
            p += n;
        } else if k == X_LONGCALL {
            let (cn, reg) = (v >> 4, v & 0xf);
            if n == 3 && w & 0x3f == (cn << 4) | 5 {
                p += 3;
            } else if n == 3 && w & 0xff == (reg << 4) | 1 && p + 6 <= b.len() {
                if insn(b, p + 3, 3) != 0xc0 | cn << 4 | reg << 8 {
                    return false;
                }
                p += 6;
            } else {
                return false;
            }
        } else {
            return false;
        }
    }
    true
}

/// Hit addresses of all variants within [lo, hi), 4-aligned (deduplicated, ascending)
pub fn find(segs: &[Seg], variants: &[&[Unit]], lo: u32, hi: u32) -> Vec<u32> {
    let mut hits = Vec::new();
    for &(a, b) in segs {
        let end = a.wrapping_add(b.len() as u32);
        if end <= lo || a >= hi {
            continue;
        }
        let mut addr = (lo.max(a).wrapping_add(3)) & !3;
        let stop = hi.min(end);
        while addr < stop && ((addr - a) as usize) + 2 <= b.len() {
            let p = (addr - a) as usize;
            if variants.iter().any(|u| match_at(b, p, u, a)) {
                hits.push(addr);
            }
            addr += 4;
        }
    }
    hits.sort_unstable();
    hits.dedup();
    hits
}

/// Short functions are only searched near their object-file neighbours to avoid false hits
const NEAR: u32 = 0x1_0000;

type Sig = &'static [&'static [Unit]];

/// One controller library's signatures (S3 / classic ESP32)
pub struct Set {
    pub send: Sig,
    pub check: Sig,
    pub init: Sig,
    pub enable: Sig,
    pub osi: Sig,
    pub reg: Sig,
    pub mode: Sig,
    /// S3 extend pll_track setter (call site); None on LX6, whose setter only stores a flag and runs natively
    pub pll: Option<Sig>,
    /// get_mode has look-alikes (LX6: get_sleep_mode): take it from its call site before btdm_controller_enable
    pub mode_by_call: bool,
    /// LX6 btdm_in_wakeup_requesting_set (unique match): takes a semaphore via the controller's osi pointer, which stays
    /// NULL because registration is hooked; it goes into the Nop slot Hooks.pll_track
    pub wake: Option<Sig>,
}

pub const S3: Set = {
    use super::sigs_xt::*;
    Set {
        send: API_VHCI_HOST_SEND_PACKET,
        check: API_VHCI_HOST_CHECK_SEND_AVAILABLE,
        init: BTDM_CONTROLLER_INIT,
        enable: BTDM_CONTROLLER_ENABLE,
        osi: BTDM_OSI_FUNCS_REGISTER,
        reg: API_VHCI_HOST_REGISTER_CALLBACK,
        mode: BTDM_CONTROLLER_GET_MODE,
        pll: Some(SDK_CONFIG_EXTEND_SET_PLL_TRACK),
        mode_by_call: false,
        wake: None,
    }
};

pub const LX6: Set = {
    use super::sigs_lx6::*;
    Set {
        send: API_VHCI_HOST_SEND_PACKET,
        check: API_VHCI_HOST_CHECK_SEND_AVAILABLE,
        init: BTDM_CONTROLLER_INIT,
        enable: BTDM_CONTROLLER_ENABLE,
        osi: BTDM_OSI_FUNCS_REGISTER,
        reg: API_VHCI_HOST_REGISTER_CALLBACK,
        mode: BTDM_CONTROLLER_GET_MODE,
        pll: None,
        mode_by_call: true,
        wake: Some(BTDM_IN_WAKEUP_REQUESTING_SET),
    }
};

/// Locate every S3 boundary function; any missing or ambiguous one fails
pub fn locate(segs: &[Seg]) -> Result<Hooks, String> {
    locate_set(segs, &S3)
}

/// Locate every boundary function of `set`; any missing or ambiguous one fails
pub fn locate_set(segs: &[Seg], set: &Set) -> Result<Hooks, String> {
    let one = |name: &str, v: &[&[Unit]], lo: u32, hi: u32| -> Result<u32, String> {
        let h = find(segs, v, lo, hi);
        match h.len() {
            1 => Ok(h[0]),
            0 => Err(format!("{name} not found")),
            n => Err(format!("{name} matched {n} places, not unique")),
        }
    };
    let all = (0u32, u32::MAX);
    let send_packet = one("API_vhci_host_send_packet", set.send, all.0, all.1)?;
    let check = one(
        "API_vhci_host_check_send_available",
        set.check,
        all.0,
        all.1,
    )?;
    let init = one("btdm_controller_init", set.init, all.0, all.1)?;
    let enable = one("btdm_controller_enable", set.enable, all.0, all.1)?;
    let osi = one("btdm_osi_funcs_register", set.osi, all.0, all.1)?;
    let near = |a: u32| (a.saturating_sub(NEAR), a.saturating_add(NEAR));
    let (lo, hi) = near(send_packet);
    let reg = one("API_vhci_host_register_callback", set.reg, lo, hi)?;
    let (lo, hi) = near(init);
    let mode = if set.mode_by_call {
        let m = mode_before_enable_call(segs, enable, set.mode, lo, hi);
        match m.len() {
            1 => m[0],
            n => {
                return Err(format!(
                    "btdm_controller_get_mode: {n} call-site candidates"
                ))
            }
        }
    } else {
        one("btdm_controller_get_mode", set.mode, lo, hi)?
    };
    // 0 = no call found: fine for IDF 5.1.0 / 5.1.1 bt.c (osi 0x10006, never calls it); the HLE rejects newer tables then
    let pll_track = match (set.pll, set.wake) {
        (Some(sig), _) => pll_track_near_enable_call(segs, enable, sig),
        (None, Some(sig)) => one("btdm_in_wakeup_requesting_set", sig, all.0, all.1)?,
        (None, None) => 0,
    };
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

fn read_word(segs: &[Seg], addr: u32) -> Option<u32> {
    segs.iter().find_map(|&(a, b)| {
        let off = addr.wrapping_sub(a) as usize;
        (addr >= a && off + 4 <= b.len()).then(|| word(b, off))
    })
}

/// Target of the call at p: CALLn, or an unrelaxed longcall `l32r aR, lit; callxN aR`
fn call_target(segs: &[Seg], b: &[u8], p: usize, pc: u32) -> Option<(u32, usize)> {
    if p + 3 > b.len() || len(b[p]) != 3 {
        return None;
    }
    let w = insn(b, p, 3);
    if w & 0xf == 5 && (w >> 4) & 3 != 0 {
        let off = ((w >> 6) << 14) as i32 >> 14;
        return Some(((pc & !3).wrapping_add((off << 2) as u32).wrapping_add(4), 3));
    }
    if w & 0xf == 1 && p + 6 <= b.len() {
        let reg = (w >> 4) & 0xf;
        let w2 = insn(b, p + 3, 3);
        if w2 & 0xff00cf == 0xc0 && w2 & 0x30 != 0 && (w2 >> 8) & 0xf == reg {
            let pcl = pc.wrapping_add(3) & !3;
            let lit = pcl.wrapping_add(((w >> 8) | 0xffff_0000) << 2);
            return read_word(segs, lit).map(|t| (t, 6));
        }
    }
    None
}

/// Same idea as sig.rs: in esp_bt_controller_enable (user-compiled bt.c) take the call just before btdm_controller_enable
/// whose target matches pll_track's (ambiguous) signature. Instructions are byte-aligned here, so scan every offset
fn pll_track_near_enable_call(segs: &[Seg], enable: u32, sig: Sig) -> u32 {
    const BACK: usize = 24;
    let mut found = Vec::new();
    for &(a, b) in segs {
        for p in 0..b.len() {
            if call_target(segs, b, p, a + p as u32).map(|c| c.0) != Some(enable) {
                continue;
            }
            let mut best = 0;
            for q in p.saturating_sub(BACK)..p {
                if let Some((t, n)) = call_target(segs, b, q, a + q as u32) {
                    if q + n <= p && t != enable && find(segs, sig, t, t + 1).len() == 1 {
                        best = t;
                    }
                }
            }
            if best != 0 {
                found.push(best);
            }
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

/// Bytes searched back from a btdm_controller_enable call (bt.c checks the mode first; PM locks and phy / coex sit between)
const MODE_BACK: usize = 96;

/// LX6 (E-09): in esp_bt_controller_enable the first call before btdm_controller_enable whose target matches get_mode's
/// signature within [lo, hi) is get_mode; get_sleep_mode, same shape, comes later
fn mode_before_enable_call(segs: &[Seg], enable: u32, sig: Sig, lo: u32, hi: u32) -> Vec<u32> {
    let mut found = Vec::new();
    for &(a, b) in segs {
        for p in 0..b.len() {
            if call_target(segs, b, p, a + p as u32).map(|c| c.0) != Some(enable) {
                continue;
            }
            for q in p.saturating_sub(MODE_BACK)..p {
                if let Some((t, n)) = call_target(segs, b, q, a + q as u32) {
                    if q + n <= p && (lo..hi).contains(&t) && find(segs, sig, t, t + 1).len() == 1 {
                        found.push(t);
                        break;
                    }
                }
            }
        }
    }
    found.sort_unstable();
    found.dedup();
    found
}
