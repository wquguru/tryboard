//! CLI flags for the F-04d tutorial parts

use super::opt;
use tryboard_machine::Machine;

/// F-04d parts: --pir GPIO[,hold s], --relay GPIO[,low], --ldr GPIO[,lux]; true when a PIR or relay (timed pin parts) was attached
pub fn parts_args(m: &mut Machine, args: &[String]) -> bool {
    let fail = |msg: &str| -> ! {
        eprintln!("{msg}");
        std::process::exit(2)
    };
    let gpio = |s: &str| s.trim().trim_start_matches("GPIO").parse::<u32>().ok();
    let mut any = false;
    if let Some(spec) = opt(args, "--pir") {
        let mut it = spec.split(',');
        let pin = it.next().and_then(gpio);
        let hold = it.next().map(|h| h.trim().parse::<f64>().ok());
        match (pin, hold) {
            (Some(p), None) => m.pir_attach(p, 5.0),
            (Some(p), Some(Some(h))) => m.pir_attach(p, h),
            _ => fail("--pir needs GPIO[,hold seconds]"),
        }
        any = true;
    }
    if let Some(spec) = opt(args, "--relay") {
        match spec.split_once(',') {
            None => m.relay_attach(
                gpio(&spec).unwrap_or_else(|| fail("--relay needs a GPIO")),
                true,
            ),
            Some((p, "low")) => m.relay_attach(
                gpio(p).unwrap_or_else(|| fail("--relay needs a GPIO")),
                false,
            ),
            _ => fail("--relay needs GPIO or GPIO,low"),
        }
        any = true;
    }
    if let Some(spec) = opt(args, "--ldr") {
        let (p, lux) = match spec.split_once(',') {
            Some((p, l)) => (gpio(p), l.trim().parse::<f64>().ok()),
            None => (gpio(&spec), Some(300.0)),
        };
        let (Some(p), Some(lux)) = (p, lux) else {
            fail("--ldr needs GPIO[,lux]")
        };
        if let Err(e) = m.ldr_attach(p, lux) {
            fail(&format!("--ldr: {e}"));
        }
    }
    any
}

/// Script actions pir=1|0 (motion / gone), lux=N, card=<uid hex>|none; false when `act` is none of them
pub fn parts_action(m: &mut Machine, act: &str) -> bool {
    if let Some(v) = act.strip_prefix("pir=") {
        m.pir_motion(v.trim() == "1");
    } else if let Some(v) = act.strip_prefix("lux=") {
        if let Ok(l) = v.trim().parse::<f64>() {
            m.ldr_lux(l);
        }
    } else if let Some(v) = act.strip_prefix("card=") {
        if let Err(e) = m.rc522_card(v) {
            eprintln!("[tryboard] {e}");
        }
    } else {
        return false;
    }
    true
}

/// Relay switch events since the last slice, stamped in simulated seconds
pub fn parts_events(m: &mut Machine) {
    for (t, pin, on) in m.relay_events_take() {
        let s = if on { "ON (closed)" } else { "OFF (open)" };
        eprintln!("[tryboard] {t:.3}s relay GPIO{pin} {s}");
    }
}

/// End-of-run lines for the pin-level parts (encoder, HC-SR04, DHT11, F-04d parts), kept out of `run`
pub fn pin_reports(m: &mut Machine) {
    if let Some(p) = m.encoder_position() {
        let c = m
            .pcnt_count(0)
            .map(|c| format!(", PCNT unit 0 count {c}"))
            .unwrap_or_default();
        eprintln!("[tryboard] encoder turned {p} detents (clockwise positive){c}");
    }
    if let Some((pings, echoes, us)) = m.sonar_stats() {
        eprintln!("[tryboard] ultrasonic triggers {pings}, echoes {echoes}, last Echo {us:.1} µs");
    }
    crate::report_wire_sensors(m);
    for l in m.parts_report() {
        eprintln!("[tryboard] {l}");
    }
}
