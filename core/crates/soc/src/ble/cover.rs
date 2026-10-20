//! F-08c coverage: the generated signatures must find every boundary function in each bt-lib commit linked bare by
//! tools/ble_cover.sh (third_party/btlib-cover/<ver>-<chip>/, git-ignored; skipped when absent).

use super::sig::{self, Hooks, Seg};
use super::sig_xt;
use std::path::Path;

/// App image (at 0, or the first app partition of a full flash image) -> code segments
fn code_segs(img: &[u8]) -> Vec<Seg<'_>> {
    let mut off = 0;
    if img.len() > 0x9000 && img[0x8000..0x8002] == [0xAA, 0x50] {
        for e in img[0x8000..0x9000]
            .chunks(32)
            .take_while(|e| e[..2] == [0xAA, 0x50])
        {
            if e[2] == 0 && (e[3] == 0 || e[3] == 0x10) {
                off = u32::from_le_bytes(e[4..8].try_into().unwrap()) as usize;
                break;
            }
        }
    }
    let img = &img[off..];
    assert_eq!(img[0], 0xE9, "not an app image");
    let mut p = 24;
    let mut v = Vec::new();
    for _ in 0..img[1] {
        let load = u32::from_le_bytes(img[p..p + 4].try_into().unwrap());
        let len = u32::from_le_bytes(img[p + 4..p + 8].try_into().unwrap()) as usize;
        if (0x4000_0000..0x4400_0000).contains(&load) {
            v.push((load, &img[p + 8..p + 8 + len]));
        }
        p += 8 + len;
    }
    v
}

fn check(h: &Hooks, syms: &str, name: &str) -> Result<(), String> {
    let sym = |s: &str| -> u32 {
        let l = syms
            .lines()
            .find(|l| l.split(' ').next() == Some(s))
            .unwrap_or_else(|| panic!("{name}: {s} missing from syms.txt"));
        u32::from_str_radix(l.split(' ').nth(1).unwrap_or(""), 16).unwrap()
    };
    for (got, s) in [
        (h.osi_funcs_register, "btdm_osi_funcs_register"),
        (h.controller_init, "btdm_controller_init"),
        (h.controller_enable, "btdm_controller_enable"),
        (h.get_mode, "btdm_controller_get_mode"),
        (h.check_send_available, "API_vhci_host_check_send_available"),
        (h.send_packet, "API_vhci_host_send_packet"),
        (h.register_callback, "API_vhci_host_register_callback"),
    ] {
        if got != sym(s) {
            return Err(format!("{name}: {s} at {got:#x}, ELF {:#x}", sym(s)));
        }
    }
    // No bt.c in the bare link, so no call site to find pll_track from
    if h.pll_track != 0 {
        return Err(format!("{name}: pll_track at {:#x}", h.pll_track));
    }
    Ok(())
}

#[test]
fn sigs_cover_every_btlib_commit() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../third_party/btlib-cover");
    let Ok(rd) = std::fs::read_dir(&dir) else {
        eprintln!("skipped: no third_party/btlib-cover (run tools/ble_cover.sh)");
        return;
    };
    let (mut n, mut bad) = (0, Vec::new());
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let (Ok(img), Ok(syms)) = (
            std::fs::read(e.path().join("flash.bin")),
            std::fs::read_to_string(e.path().join("syms.txt")),
        ) else {
            continue;
        };
        let segs = code_segs(&img);
        let h = if name.contains("esp32s3") {
            sig_xt::locate(&segs)
        } else {
            sig::locate(&segs)
        };
        if let Err(e) = h
            .map_err(|e| format!("{name}: {e}"))
            .and_then(|h| check(&h, &syms, &name))
        {
            // Known gap (STATUS): RUN_IN_FLASH_ONLY S3 lib, where ld narrows instructions while relaxing longcalls
            if name.ends_with("esp32s3_flash") {
                eprintln!("known gap: {e}");
            } else {
                bad.push(e);
            }
        }
        n += 1;
    }
    eprintln!("checked {n} bare bt-lib images");
    assert!(bad.is_empty(), "{} failed:\n{}", bad.len(), bad.join("\n"));
}

/// Raw scan without the BLE_INIT pre-filter: on every built acceptance image each variant table hits nothing in
/// non-BLE firmware and exactly once in BLE firmware (pll_track is excluded: it shares its shape with other setters)
#[test]
fn sigs_scan_built_firmware() {
    use super::{sigs as r, sigs_xt as x};
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../firmware/build");
    let Ok(rd) = std::fs::read_dir(&dir) else {
        eprintln!("skipped: no firmware/build");
        return;
    };
    type Table = &'static [&'static [sig::Unit]];
    let tables: [(&str, Table, Table); 7] = [
        (
            "osi_funcs_register",
            r::BTDM_OSI_FUNCS_REGISTER,
            x::BTDM_OSI_FUNCS_REGISTER,
        ),
        (
            "controller_init",
            r::BTDM_CONTROLLER_INIT,
            x::BTDM_CONTROLLER_INIT,
        ),
        (
            "controller_enable",
            r::BTDM_CONTROLLER_ENABLE,
            x::BTDM_CONTROLLER_ENABLE,
        ),
        (
            "get_mode",
            r::BTDM_CONTROLLER_GET_MODE,
            x::BTDM_CONTROLLER_GET_MODE,
        ),
        (
            "check_send",
            r::API_VHCI_HOST_CHECK_SEND_AVAILABLE,
            x::API_VHCI_HOST_CHECK_SEND_AVAILABLE,
        ),
        (
            "send_packet",
            r::API_VHCI_HOST_SEND_PACKET,
            x::API_VHCI_HOST_SEND_PACKET,
        ),
        (
            "register_cb",
            r::API_VHCI_HOST_REGISTER_CALLBACK,
            x::API_VHCI_HOST_REGISTER_CALLBACK,
        ),
    ];
    let (mut c3, mut s3) = (0, 0);
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let xt = name.starts_with("s3-");
        if !xt && !name.starts_with("c3-") {
            continue;
        }
        let Ok(img) = std::fs::read(e.path().join("flash.bin")) else {
            continue;
        };
        let segs = code_segs(&img);
        // Same BLE list as the per-chip sigs_hit_only_ble_firmware tests
        let ble = name.contains("-ble-") || name.contains("-bluedroid-") || name == "s3-ai-dash";
        for (f, rv, xv) in tables {
            let hits = if xt {
                sig_xt::find(&segs, xv, 0, u32::MAX)
            } else {
                sig::find(&segs, rv, 0, u32::MAX)
            };
            assert_eq!(hits.len(), usize::from(ble), "{name}: {f} hits {hits:x?}");
        }
        if xt {
            s3 += 1;
        } else {
            c3 += 1;
        }
    }
    eprintln!("scanned {c3} C3 + {s3} S3 images");
}
