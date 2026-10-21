//! Voice assistant exports (F-09b-2): I2S parts on explicit pins and the virtual xiaozhi-protocol server.

use super::{json_str, with};
use std::cell::RefCell;

/// Same as tb_i2s_attach on explicit pins (= CLI --i2s kind@bclk:ws:data, F-09b-2). Returns 0 on success
#[no_mangle]
pub extern "C" fn tb_i2s_attach_at(kind: u32, bclk: u32, ws: u32, data: u32) -> i32 {
    let k = match kind {
        0 => "max98357a",
        1 => "inmp441",
        _ => return 1,
    };
    with(1, |m| {
        if m.i2s_attach_at(k, bclk, ws, data) {
            0
        } else {
            1
        }
    })
}

thread_local! {
    static XZ_JSON: RefCell<String> = const { RefCell::new(String::new()) };
}

/// # Safety
/// p/len must describe a valid buffer. Voice server action (same text as after CLI `xz=`); 0 = accepted, 1 = refused
#[no_mangle]
pub unsafe extern "C" fn tb_xz_cmd(p: *const u8, len: usize) -> u32 {
    let s = String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned();
    with(1, |m| (!m.xz_cmd(&s)) as u32)
}

/// Voice server log length, -1 when the server is off: fetch the JSON only when it changes
#[no_mangle]
pub extern "C" fn tb_xz_seq() -> f64 {
    with(-1.0, |m| {
        m.wifi()
            .world
            .xz
            .as_ref()
            .map_or(-1.0, |x| x.log.len() as f64)
    })
}

/// Server state + `[xz]` log lines from index `from` as JSON; length, read via tb_xz_json_ptr (0 = server off)
#[no_mangle]
pub extern "C" fn tb_xz_json(from: f64) -> usize {
    let j = with(String::new(), |m| {
        let Some(x) = m.wifi().world.xz.as_ref() else {
            return String::new();
        };
        let log: Vec<String> = x
            .log
            .iter()
            .skip(from as usize)
            .map(|(t, l)| format!("[{t},{}]", json_str(l)))
            .collect();
        format!(
            "{{\"script\":{},\"sessions\":{},\"turns\":{},\"up\":{},\"down\":{},\"log\":[{}]}}",
            json_str(x.script.name),
            x.sessions(),
            x.turns,
            x.up_frames,
            x.down_frames,
            log.join(",")
        )
    });
    let n = j.len();
    XZ_JSON.with(|b| *b.borrow_mut() = j);
    n
}

#[no_mangle]
pub extern "C" fn tb_xz_json_ptr() -> *const u8 {
    XZ_JSON.with(|b| b.borrow().as_ptr())
}
