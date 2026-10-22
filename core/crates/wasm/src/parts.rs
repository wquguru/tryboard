//! Bench part exports (F-04c / F-04d models, wired on the web by F-04a).

use super::{with, REPORT};

/// Attach a 1-Wire bus with `count` DS18B20s on `pin` (F-04c, = CLI --ds18b20 pin,count); call tb_env_set afterwards
#[no_mangle]
pub extern "C" fn tb_ds18b20_attach(pin: u32, count: u32) {
    with((), |m| m.ds18b20_attach(pin, count.clamp(1, 8) as usize))
}

/// Attach an HC-SR501 PIR output on `pin` with `hold_s` seconds of hold (F-04d, = CLI --pir pin,hold)
#[no_mangle]
pub extern "C" fn tb_pir_attach(pin: u32, hold_s: f64) {
    with((), |m| m.pir_attach(pin, hold_s))
}

/// Attach a relay module IN on `pin`; active_high 0 = closes on a low input (= CLI --relay pin[,low])
#[no_mangle]
pub extern "C" fn tb_relay_attach(pin: u32, active_high: u32) {
    with((), |m| m.relay_attach(pin, active_high != 0))
}

/// Attach a photoresistor divider on ADC pad `pin` at `lux` (= CLI --ldr pin,lux); 0 = ok, 1 = not an ADC pin
#[no_mangle]
pub extern "C" fn tb_ldr_attach(pin: u32, lux: f64) -> i32 {
    with(1, |m| m.ldr_attach(pin, lux).map_or(1, |_| 0))
}

/// Attach the IR link (F-10c / F-08f, = CLI --ir RX[,TX]): receiver output on rx, IR LED eye on tx; negative = none
#[no_mangle]
pub extern "C" fn tb_ir_attach(rx: i32, tx: i32) -> u32 {
    let pin = |p: i32| u32::try_from(p).ok();
    with(1, |m| m.ir_attach(pin(rx), pin(tx)).map_or(1, |_| 0))
}

/// Frames the IR LED eye decoded since the last call, one "seconds\tGPIO\ttext" line each (= CLI stderr); length, via tb_report_ptr
#[no_mangle]
pub extern "C" fn tb_ir_events() -> usize {
    let r = with(String::new(), |m| {
        m.ir_events_take()
            .iter()
            .map(|(t, pin, txt)| format!("{t:.3}\t{pin}\t{txt}\n"))
            .collect::<String>()
    });
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

/// # Safety
/// Part script action pir=1|0 / lux=N / card=<uid hex>|none / ir=ADDR,CMD|repeat (same parsing as CLI parts_action); 0 ok, 1 rejected. p/len valid UTF-8
#[no_mangle]
pub unsafe extern "C" fn tb_part_action(p: *const u8, len: usize) -> u32 {
    let s = String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned();
    with(1, |m| {
        if let Some(v) = s.strip_prefix("pir=") {
            m.pir_motion(v.trim() == "1");
            0
        } else if let Some(v) = s.strip_prefix("lux=") {
            match v.trim().parse::<f64>() {
                Ok(l) => {
                    m.ldr_lux(l);
                    0
                }
                Err(_) => 1,
            }
        } else if let Some(v) = s.strip_prefix("card=") {
            m.rc522_card(v).map_or(1, |_| 0)
        } else if let Some(v) = s.strip_prefix("ir=") {
            m.ir_press(v).map_or(1, |_| 0)
        } else {
            1
        }
    })
}

/// End-of-run lines for the F-04d parts (PIR / relay / LDR / RC522) and the IR link, newline separated; length, read via tb_report_ptr
#[no_mangle]
pub extern "C" fn tb_parts_report() -> usize {
    let r = with(String::new(), |m| {
        m.parts_report()
            .into_iter()
            .chain(m.ir_report())
            .collect::<Vec<_>>()
            .join("\n")
    });
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}
