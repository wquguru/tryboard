//! I2C bus loading (P2-11, estimate, needs real hardware): wire length -> bus capacitance -> rise time vs the I2C spec limit.
//! Deterministic, no randomness; web/src/app/harness.ts uses the same constants (cross-checked in elec.test.ts).
//! lint: allow-long-comment
//! Open-drain lines are pulled high by the pull-up, so rise time (30% -> 70% VDD) t_r = 0.8473 * R * C (UM10204 §7.1).
//! Limits: standard mode (<= 100 kHz) 1000 ns, fast mode (<= 400 kHz) 300 ns, fast-mode plus 120 ns.

/// Dupont / ribbon wire capacitance to ground + neighbours per cm (pF; a single wire in air is ~0.5-1.5 pF/cm, upper-middle picked)
pub const PF_PER_CM: f64 = 1.0;
/// Pin capacitance per device (pF, the I2C spec Ci maximum)
pub const PF_PER_DEVICE: f64 = 10.0;
/// Dev-board pin + traces + breadboard (pF, estimate)
pub const PF_BASE: f64 = 10.0;
/// Typical module on-board pull-up (ohm): one 10 kohm per module, in parallel
pub const PULLUP_PER_MODULE: f64 = 10_000.0;
/// Without module pull-ups only the ESP32 internal pull-up remains (ohm, ~45 kohm per datasheet)
pub const PULLUP_INTERNAL: f64 = 45_000.0;

/// Bus capacitance (pF)
pub fn bus_pf(wire_cm: f64, devices: usize) -> f64 {
    PF_BASE + PF_PER_DEVICE * devices as f64 + PF_PER_CM * wire_cm.max(0.0)
}

/// Effective pull-up (ohm): n modules' 10 kohm in parallel
pub fn pullup_ohm(devices: usize) -> f64 {
    if devices == 0 {
        PULLUP_INTERNAL
    } else {
        PULLUP_PER_MODULE / devices as f64
    }
}

/// Rise time (ns)
pub fn rise_ns(wire_cm: f64, devices: usize) -> f64 {
    // ohm * pF = 1e-12 s; * 1e9 converts to ns
    0.8473 * pullup_ohm(devices) * bus_pf(wire_cm, devices) * 1e-3
}

/// Maximum rise time the spec allows at this SCL frequency (ns)
pub fn limit_ns(scl_hz: f64) -> f64 {
    if scl_hz <= 100_000.5 {
        1000.0
    } else if scl_hz <= 400_000.5 {
        300.0
    } else {
        120.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Within spec
    Ok,
    /// Over spec but under 2x: SDA is sampled before it climbs high, so 0->1 bits in read bytes come back as 0
    Marginal,
    /// Over 2x: even the address byte is garbled, so the device does not ACK (NACK)
    Fail,
}

pub fn verdict(rise_ns: f64, limit_ns: f64) -> Verdict {
    if rise_ns <= limit_ns {
        Verdict::Ok
    } else if rise_ns <= 2.0 * limit_ns {
        Verdict::Marginal
    } else {
        Verdict::Fail
    }
}

/// Slow rise reads a 1 bit that follows a 0 as 0 (MSB first; the bit before the MSB is the previous ACK, taken as high)
pub fn corrupt_read(b: u8) -> u8 {
    b & ((b >> 1) | 0x80)
}

/// Longest wire that stays warning-free (cm)
pub fn max_wire_cm(devices: usize, scl_hz: f64) -> f64 {
    let c = limit_ns(scl_hz) / (0.8473 * pullup_ohm(devices) * 1e-3);
    ((c - PF_BASE - PF_PER_DEVICE * devices as f64) / PF_PER_CM).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weather_bus_thresholds() {
        // Weather station: OLED + BME280 modules at 400 kHz; web harness.ts uses the same numbers (elec.test.ts)
        assert!((rise_ns(20.0, 2) - 211.825).abs() < 0.01);
        assert_eq!(verdict(rise_ns(20.0, 2), limit_ns(400_000.0)), Verdict::Ok);
        assert_eq!(
            verdict(rise_ns(60.0, 2), limit_ns(400_000.0)),
            Verdict::Marginal
        );
        assert_eq!(
            verdict(rise_ns(150.0, 2), limit_ns(400_000.0)),
            Verdict::Fail
        );
        assert!((max_wire_cm(2, 400_000.0) - 40.81).abs() < 0.01);
        // 100 kHz is far more forgiving
        assert_eq!(verdict(rise_ns(150.0, 2), limit_ns(100_000.0)), Verdict::Ok);
    }

    #[test]
    fn corrupt_read_loses_rising_bits() {
        assert_eq!(corrupt_read(0xff), 0xff);
        assert_eq!(corrupt_read(0x00), 0x00);
        // 0101 0101: every 1 follows a 0 -> all lost
        assert_eq!(corrupt_read(0x55), 0x00);
        // 1100 0110 -> 1100 0010 (bit 2 follows a 0 and is lost; bit 1 follows a 1 and stays)
        assert_eq!(corrupt_read(0xc6), 0xc2);
        // BME280 chip ID 0x60 = 0110 0000 -> 0x20
        assert_eq!(corrupt_read(0x60), 0x20);
    }
}
