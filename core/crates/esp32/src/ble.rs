//! Classic ESP32 BLE hookup (E-09): the S3 windowed-ABI VHCI HLE (esp32s3::ble) with LX6 signatures and this bt.c's
//! osi table. The controller is dual-mode (BTDM); only ESP_BT_MODE_BLE is offered, BR/EDR commands get "unknown command".

use crate::SocBus;
use tryboard_esp32s3::ble::{Bus, Osi, Slot};
use tryboard_soc::ble::sig::{self, Hooks, Seg};
use tryboard_soc::ble::sig_xt;

pub use tryboard_esp32s3::ble::{call_at, now_us, BleHle};

/// components/bt/controller/esp32/bt.c (OSI_VERSION 0x10005, IDF 5.5.1): _magic is the last field, not the first
pub const OSI_ESP32: Osi = Osi {
    magic_at: 248,
    version_at: 0,
    versions: 0x0001_0005..=0x0001_0005,
    pll_from: None,
    semphr_create: 28,
    semphr_take: 44,
    semphr_give: 48,
    task_create: 92,
    malloc_internal: 112,
};

impl Bus for SocBus {
    fn rd32(&self, a: u32) -> u32 {
        self.mem_read(a, 4).unwrap_or(0)
    }
    fn rd8(&self, a: u32) -> u8 {
        self.mem_read(a, 1).unwrap_or(0) as u8
    }
    fn wr8(&mut self, a: u32, v: u8) {
        self.mem_write(a, 1, v as u32);
    }
    fn ble_slot(&mut self) -> &mut Slot {
        &mut self.ble
    }
}

/// Find signatures in app segments. Ok(None) = no BLE; Err = uses BLE but unrecognized
pub fn locate(segs: &[Seg]) -> Result<Option<Hooks>, String> {
    if !sig::mentions_btdm(segs) {
        return Ok(None);
    }
    let code: Vec<Seg> = segs
        .iter()
        .copied()
        .filter(|(a, _)| (0x4000_0000..0x4400_0000).contains(a))
        .collect();
    sig_xt::locate_set(&code, &sig_xt::LX6).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boot::{find_app, parse_app};
    use tryboard_soc::ble::sigs_lx6;

    /// No false matches: of all built classic ESP32 firmware (other chips skipped by chip ID) only BLE firmware is recognised
    #[test]
    fn sigs_hit_only_ble_firmware() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../firmware/build");
        let Ok(rd) = std::fs::read_dir(&dir) else {
            eprintln!("skipped: no firmware/build");
            return;
        };
        let (mut n, mut ble) = (0, 0);
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(flash) = std::fs::read(e.path().join("flash.bin")) else {
                continue;
            };
            let Ok(app) = find_app(&flash).and_then(|o| parse_app(&flash, o)) else {
                continue;
            };
            let segs: Vec<Seg> = app
                .segments
                .iter()
                .filter_map(|&(load, data, len)| {
                    flash
                        .get(data as usize..(data + len) as usize)
                        .map(|b| (load, b))
                })
                .collect();
            let r = locate(&segs);
            n += 1;
            if name.starts_with("esp32-ble") || name.starts_with("esp32-bluedroid-") {
                let h = r
                    .unwrap_or_else(|e| panic!("{name}: {e}"))
                    .expect("BLE should be recognized");
                for a in [
                    h.osi_funcs_register,
                    h.controller_init,
                    h.controller_enable,
                    h.get_mode,
                    h.check_send_available,
                    h.send_packet,
                    h.register_callback,
                ] {
                    assert!(a != 0 && a & 3 == 0, "{name}: {h:x?}");
                }
                assert!(h.pll_track != 0, "{name}: wakeup-request hook missing");
                ble += 1;
            } else {
                assert!(
                    matches!(r, Ok(None)),
                    "{name} wrongly detected as using BLE: {r:?}"
                );
                // Without the BTDM_INIT gate the signatures alone must still find nothing (non-BLE code has no libbtdm)
                for (fname, v) in [
                    ("send", sigs_lx6::API_VHCI_HOST_SEND_PACKET),
                    ("init", sigs_lx6::BTDM_CONTROLLER_INIT),
                    ("enable", sigs_lx6::BTDM_CONTROLLER_ENABLE),
                    ("osi", sigs_lx6::BTDM_OSI_FUNCS_REGISTER),
                    ("check", sigs_lx6::API_VHCI_HOST_CHECK_SEND_AVAILABLE),
                ] {
                    let hits = sig_xt::find(&segs, v, 0, u32::MAX);
                    assert!(hits.is_empty(), "{name}: {fname} false hit {hits:x?}");
                }
            }
        }
        eprintln!("checked {n} firmware images, {ble} with BLE");
    }
}
