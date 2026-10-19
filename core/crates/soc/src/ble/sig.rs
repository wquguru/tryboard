//! 在用户固件里按掩码签名找 libbtdm 的 VHCI 边界函数（C-01 路线 a′）。
//!
//! 签名由 tools/ble_sigs.py 从各版本 libbtdm_app*.a 的目标文件算出：重定位字段清零、
//! 跳转位移掩掉，所以仓库里没有库的原始字节。链接器松弛会改变指令序列（auipc+jalr → jal / c.jal，
//! lui 被删、随后的访存改成 gp 相对），这里逐条指令匹配而不是逐字节。

/// (种类, 掩码后取值, 掩码, 长度)
#[derive(Clone, Copy, Debug)]
pub struct Unit(pub u8, pub u32, pub u32, pub u8);

const K_EXACT: u8 = 0;
const K_CALL: u8 = 1;
const K_HI20: u8 = 2;
const K_LO12: u8 = 3;

/// 一段代码（加载地址, 字节）
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
                    // 视为被松弛删掉的 lui：紧接着的低 12 位访问必须是 gp 相对
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

/// 所有变体在 [lo, hi) 范围里的命中地址（去重、升序）
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

/// 找到的 VHCI 边界函数入口
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Hooks {
    pub osi_funcs_register: u32,
    pub controller_init: u32,
    pub controller_enable: u32,
    pub get_mode: u32,
    pub check_send_available: u32,
    pub send_packet: u32,
    pub register_callback: u32,
    /// sdk_config_extend_set_pll_track：它经 sdk_config 指针写字段，而该指针本由真 btdm_controller_init 设置，
    /// 我们跳过了 init，所以它也得空转。IDF 5.1–5.5.1 的 bt.c 都在 btdm_controller_enable 前一行调用它
    pub pll_track: u32,
}

/// 短函数（几条指令）只在同一目标文件的邻居附近找，避免在别处误中
const NEAR: u32 = 0x1_0000;

/// 在固件代码段里定位全部边界函数。任何一个找不到或不唯一都算失败（走 app.elf 路线）。
pub fn locate(segs: &[Seg]) -> Result<Hooks, String> {
    use super::sigs::*;
    let one = |name: &str, v: &[&[Unit]], lo: u32, hi: u32| -> Result<u32, String> {
        let h = find(segs, v, lo, hi);
        match h.len() {
            1 => Ok(h[0]),
            0 => Err(format!("没找到 {name}")),
            n => Err(format!("{name} 命中 {n} 处，不唯一")),
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
    let pll_track = pll_track_near_enable_call(segs, enable);
    if pll_track == 0 {
        return Err(
            "没找到 btdm_controller_enable 之前的 sdk_config_extend_set_pll_track 调用".into(),
        );
    }
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

/// 解出 p 处的调用指令（jal ra / c.jal / auipc ra + jalr ra）的目标
fn call_target(b: &[u8], p: usize, pc: u32) -> Option<u32> {
    if p + 2 > b.len() {
        return None;
    }
    let h = half(b, p);
    if h & 3 != 3 {
        if h & 0xe003 != 0x2001 {
            return None;
        }
        // c.jal：CJ 型立即数
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

/// 在 esp_bt_controller_enable（bt.c，用户编译，没法做签名）里找"调 btdm_controller_enable 之前那一次调用"，
/// 目标必须同时命中 pll_track 的签名（这个签名单独看和十来个 setter 同形，靠调用点才唯一）。
/// 两次调用之间在 -Os 下只隔一条 mv（6 字节），往回看 24 字节给其它优化级别留余量
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

/// 固件里有没有 BLE 控制器的迹象（用来区分"没用蓝牙"和"用了但签名没认出来"）：
/// 看 IDF bt 组件 bt.c 的日志标签（5.x 是 BLE_INIT，更早是 BTDM_INIT），在只读数据段里
pub fn mentions_btdm(segs: &[Seg]) -> bool {
    const TAGS: [&[u8]; 2] = [b"\0BLE_INIT\0", b"\0BTDM_INIT\0"];
    segs.iter()
        .any(|(_, b)| TAGS.iter().any(|t| b.windows(t.len()).any(|w| w == *t)))
}
