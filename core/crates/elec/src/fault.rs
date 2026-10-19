//! Miswiring currents (P2-14): each fault the lab wiring check finds becomes a small netlist solved once at DC with MNA,
//! reporting how much current flows and what limits it. The web calls this via wasm; tools/elec/11-17 mirror it for ngspice.
//! All values are estimates (shown with an "estimate" badge on the web). lint: allow-long-comment
//! Red 5 mm LED: typ V_F = 2.0 V @ 20 mA -> 1.8 V knee + 10 ohm. Pin ESD clamp (pin -> VDD3P3): 0.6 V + 10 ohm (Espressif
//! publishes no injection data). Jumper: 20 cm Dupont + two breadboard contacts ~ 0.05 ohm. Supply reuses board.rs Params.

use crate::board::{ChipKind, Params};
use crate::mna::{Circuit, Elem, Solution};

pub const VDD: f64 = 3.3;
/// GPIO output-high resistance (ohm): C3 datasheet v2.4 table 5-4 at PAD_DRIVER = 3 gives 0.66 V / 40 mA; IDF's default
/// GPIO_DRIVE_CAP_2 halves the drive, hence 2x. Real stages saturate, so linear R overstates short current: a worst case.
pub const GPIO_R_HIGH: f64 = 33.0;
/// GPIO output-low resistance (ohm): 2 x 0.495 V / 28 mA (I_OL at PAD_DRIVER = 3; the S3 datasheet table matches)
pub const GPIO_R_LOW: f64 = 35.36;
pub const LED_VF: f64 = 1.8;
pub const LED_RD: f64 = 10.0;
pub const CLAMP_VF: f64 = 0.6;
pub const CLAMP_RD: f64 = 10.0;
pub const JUMPER_R: f64 = 0.05;

/// What limits the current
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limiter {
    /// Only wire / output stage / part resistance (no protection, current is just V/R)
    Resistance = 0,
    /// PC USB port current limit (the 5V rail collapses)
    Usb = 1,
    /// External 5 V supply current limit
    Ext = 2,
    /// On-board LDO current limit
    Ldo = 3,
    /// LDO input pulled into dropout (the upstream USB gave out first)
    LdoDropout = 4,
}

/// Result (A / V)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FaultOut {
    /// Current in the miswired branch
    pub i: f64,
    /// Key node voltage: the pin for fights / LED / clamp, the shorted rail for shorts
    pub v_pin: f64,
    pub v5: f64,
    pub v33: f64,
    pub limiter: Limiter,
}

/// Supply rail shorted to GND
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rail {
    V3v3,
    V5,
    Ext5v,
}

/// Two push-pull outputs fighting on one pin: A is va via ra, B is vb via rb. Node 1 = A internal, 2 = pin, 3 = B internal
pub fn fight_circuit(va: f64, ra: f64, vb: f64, rb: f64) -> Circuit {
    let mut c = Circuit::new(3);
    c.add(Elem::V {
        a: 1,
        b: 0,
        v: va,
        r: 0.0,
    });
    c.add(Elem::R { a: 1, b: 2, r: ra });
    c.add(Elem::R { a: 2, b: 3, r: rb });
    c.add(Elem::V {
        a: 3,
        b: 0,
        v: vb,
        r: 0.0,
    });
    c
}

pub fn fight(va: f64, ra: f64, vb: f64, rb: f64) -> FaultOut {
    let s = fight_circuit(va, ra, vb, rb).solve(None, &[], &[]);
    FaultOut {
        i: s.i[1],
        v_pin: s.v[2],
        v5: f64::NAN,
        v33: f64::NAN,
        limiter: Limiter::Resistance,
    }
}

/// A part's output (vd via rd) against a GPIO output: the GPIO takes the opposite level (worst case)
pub fn fight_gpio(vd: f64, rd: f64) -> FaultOut {
    if vd > VDD / 2.0 {
        fight(vd, rd, 0.0, GPIO_R_LOW)
    } else {
        // Part pulls low, GPIO drives high: the current reverses, report its magnitude
        let mut o = fight(VDD, GPIO_R_HIGH, vd, rd);
        o.i = o.i.abs();
        o
    }
}

/// GPIO drives an LED high (series ohm, 0 = direct). Node 1 = GPIO internal, 2 = pin, 3 = LED anode
pub fn led_circuit(series: f64) -> Circuit {
    let mut c = Circuit::new(3);
    c.add(Elem::V {
        a: 1,
        b: 0,
        v: VDD,
        r: 0.0,
    });
    c.add(Elem::R {
        a: 1,
        b: 2,
        r: GPIO_R_HIGH,
    });
    // Without a resistor the pin is the anode: link them with a tiny resistor so the netlist shape stays the same
    c.add(Elem::R {
        a: 2,
        b: 3,
        r: series.max(1e-3),
    });
    c.add(Elem::Diode {
        a: 3,
        b: 0,
        vf: LED_VF,
        rd: LED_RD,
    });
    c
}

pub fn led(series: f64) -> FaultOut {
    let s = led_circuit(series).solve(None, &[], &[0.0, VDD, VDD, VDD]);
    FaultOut {
        i: s.i[3],
        v_pin: s.v[2],
        v5: f64::NAN,
        v33: f64::NAN,
        limiter: Limiter::Resistance,
    }
}

/// Board supply (same params as board.rs): node 1 = 5V rail, 2 = 3V3, 3 = external 5 V. Elems 0 = USB, 1 = LDO, 2 = 3V3 load, 3 = ext
fn supply(c: &mut Circuit, p: &Params, ext: bool) {
    c.add(Elem::Limit {
        a: 1,
        vs: p.usb_v,
        r: p.usb_r,
        ilim: p.usb_ilim,
        rlim: p.usb_rlim,
    });
    c.add(Elem::Ldo {
        inp: 1,
        out: 2,
        vset: p.ldo_vset,
        rout: p.ldo_rout,
        rdo: p.ldo_rdo,
        ilim: p.ldo_ilim,
        iq: p.ldo_iq,
    });
    c.add(Elem::Load {
        a: 2,
        i: p.chip_idle + p.chip_core + p.board_3v3,
        vknee: 1.0,
    });
    c.add(if ext {
        Elem::Limit {
            a: 3,
            vs: p.ext_v,
            r: p.ext_r,
            ilim: p.ext_ilim,
            rlim: p.ext_rlim,
        }
    } else {
        Elem::R { a: 3, b: 0, r: 1e6 }
    });
}

fn limiter_of(p: &Params, s: &Solution, rail: Rail) -> Limiter {
    let (i_usb, i_ldo, i_ext) = (s.i[0], s.i[1], s.i[3]);
    if rail == Rail::Ext5v && i_ext > p.ext_ilim {
        return Limiter::Ext;
    }
    if i_ldo >= p.ldo_ilim - 1e-9 {
        return Limiter::Ldo;
    }
    if i_usb > p.usb_ilim {
        // On a 3V3 short USB gives out first and the LDO input drops into dropout; on a 5V short USB limits by itself
        return if rail == Rail::V3v3 {
            Limiter::LdoDropout
        } else {
            Limiter::Usb
        };
    }
    Limiter::Resistance
}

/// A jumper tying a supply rail straight to GND
pub fn short_circuit(rail: Rail, chip: ChipKind) -> Circuit {
    let p = Params::for_chip(chip);
    let mut c = Circuit::new(3);
    supply(&mut c, &p, rail == Rail::Ext5v);
    let n = match rail {
        Rail::V5 => 1,
        Rail::V3v3 => 2,
        Rail::Ext5v => 3,
    };
    c.add(Elem::R {
        a: n,
        b: 0,
        r: JUMPER_R,
    });
    c
}

pub fn short(rail: Rail, chip: ChipKind) -> FaultOut {
    let p = Params::for_chip(chip);
    let c = short_circuit(rail, chip);
    let s = c.solve(None, &[], &[0.0, 5.0, 3.3, 5.0]);
    let n = match rail {
        Rail::V5 => 1,
        Rail::V3v3 => 2,
        Rail::Ext5v => 3,
    };
    FaultOut {
        i: s.i[4],
        v_pin: s.v[n],
        v5: s.v[1],
        v33: s.v[2],
        limiter: limiter_of(&p, &s, rail),
    }
}

/// A 5 V module output (via src ohm) into a GPIO: current flows through the pin clamp diode into 3V3. Node 1 = 5V, 2 = 3V3, 3 = pin
pub fn clamp_circuit(src: f64, chip: ChipKind) -> Circuit {
    let p = Params::for_chip(chip);
    let mut c = Circuit::new(3);
    supply(&mut c, &p, false);
    // Node 3 in supply is the external 5 V; reuse it as the pin by swapping its 1 Mohm for module resistance + clamp diode
    c.elems.pop();
    c.add(Elem::R { a: 1, b: 3, r: src });
    c.add(Elem::Diode {
        a: 3,
        b: 2,
        vf: CLAMP_VF,
        rd: CLAMP_RD,
    });
    c
}

pub fn clamp(src: f64, chip: ChipKind) -> FaultOut {
    let s = clamp_circuit(src, chip).solve(None, &[], &[0.0, 5.0, 3.3, 3.3]);
    FaultOut {
        i: s.i[4],
        v_pin: s.v[3],
        v5: s.v[1],
        v33: s.v[2],
        limiter: Limiter::Resistance,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spice::Netlist;

    const C3: ChipKind = ChipKind::C3;

    /// tools/elec netlists must be the same circuits built here (so ngspice checks what the web uses)
    fn net(name: &str) -> (Netlist, Vec<f64>) {
        let path = format!("{}/../../../tools/elec/{name}", env!("CARGO_MANIFEST_DIR"));
        let nl = Netlist::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let v = nl.run(&[])[0].1.clone();
        (nl, v)
    }
    fn at(nl: &(Netlist, Vec<f64>), node: &str) -> f64 {
        nl.1[nl.0.names.iter().position(|x| x == node).unwrap()]
    }
    fn near(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn gpio_fight() {
        // Pot wiper at the end (~3V3, 1 ohm contact) against a GPIO driving low: 3.3 / (1 + 35.36)
        let o = fight_gpio(VDD, 1.0);
        assert!(near(o.i, 3.3 / 36.36, 1e-9), "{o:?}");
        assert!(o.i > 0.04, "exceeds I_OH 40 mA");
        // Encoder contact closed to ground (1 ohm) against a GPIO driving high
        let o2 = fight_gpio(0.0, 1.0);
        assert!(near(o2.i, 3.3 / 34.0, 1e-9), "{o2:?}");
        let n = net("11-gpio-fight.cir");
        assert!(
            near(at(&n, "pin"), o2.v_pin, 1e-9),
            "{} {}",
            at(&n, "pin"),
            o2.v_pin
        );
    }

    #[test]
    fn led_without_resistor() {
        // PWL LED is linear once on: (3.3 - 1.8) / (33 + 10) ~ 34.9 mA, above the LED's 20 mA rating
        let o = led(0.0);
        let want = (VDD - LED_VF) / (GPIO_R_HIGH + 1e-3 + LED_RD);
        assert!(near(o.i, want, 1e-9), "{o:?}");
        assert!(o.i > 0.02 && o.i < 0.04);
        // With 220 ohm in series: ~5.9 mA
        let ok = led(220.0);
        assert!(near(ok.i, 1.5 / 263.0, 1e-9), "{ok:?}");
        let n = net("12-led-nores.cir");
        assert!(near(at(&n, "pin"), o.v_pin, 1e-9));
    }

    #[test]
    fn rail_shorts() {
        let p = Params::for_chip(C3);
        // 3V3 to ground: USB limits at 0.5 A then drops along a 20 ohm slope; the LDO input follows into dropout.
        // i ~ 0.5 + (4.75 - v5)/20, v5 = I*(rdo + 0.05) + the chip-load drop -> about 0.7 A
        let s = short(Rail::V3v3, C3);
        assert_eq!(s.limiter, Limiter::LdoDropout, "{s:?}");
        assert!(s.i > 0.6 && s.i < 0.8 && s.v5 < 1.0 && s.v33 < 0.1, "{s:?}");
        // LDO input current = short + load (load degrades to a resistor below vknee): the solution satisfies the USB source equation
        let i_in = s.i + (p.chip_idle + p.chip_core + p.board_3v3) * s.v33 + p.ldo_iq;
        let usb = p.usb_ilim + (p.usb_v - p.usb_r * p.usb_ilim - s.v5) / p.usb_rlim;
        assert!(near(i_in, usb, 1e-6), "{i_in} {usb}");
        // 5V to ground: only the USB limit left, ~ 0.7375 / 1.0025
        let f = short(Rail::V5, C3);
        assert_eq!(f.limiter, Limiter::Usb);
        assert!(near(f.i, 0.7375 / (1.0 + 0.05 / 20.0), 2e-3), "{f:?}");
        // External 5 V 2 A to ground: adapter limits at 2 A then a 2 ohm slope -> 2 + (5 - 0.3 - 0.05 I)/2
        let e = short(Rail::Ext5v, C3);
        assert_eq!(e.limiter, Limiter::Ext);
        assert!(near(e.i, 4.35 / 1.025, 1e-6), "{e:?}");
        let n3 = net("13-short-3v3.cir");
        assert!(near(at(&n3, "v5"), s.v5, 1e-9) && near(at(&n3, "v33"), s.v33, 1e-9));
        let n5 = net("14-short-5v.cir");
        assert!(near(at(&n5, "v5"), f.v5, 1e-9));
        // S3 board (higher chip current): most lab projects are S3, so these two are cross-checked too
        let (s3, f3) = (
            short(Rail::V3v3, ChipKind::S3),
            short(Rail::V5, ChipKind::S3),
        );
        let n = net("16-short-3v3-s3.cir");
        assert!(near(at(&n, "v5"), s3.v5, 1e-9) && near(at(&n, "v33"), s3.v33, 1e-9));
        let n = net("17-short-5v-s3.cir");
        assert!(near(at(&n, "v5"), f3.v5, 1e-9) && near(at(&n, "v33"), f3.v33, 1e-9));
    }

    #[test]
    fn five_volt_into_gpio() {
        // HC-SR04 Echo wired direct (5 V push-pull ~50 ohm): through the clamp into 3V3, which the LDO still holds
        let o = clamp(50.0, C3);
        let want = (o.v5 - o.v33 - CLAMP_VF) / (50.0 + CLAMP_RD);
        assert!(near(o.i, want, 1e-9), "{o:?}");
        assert!(o.i > 0.01 && o.v_pin > 3.6, "{o:?}");
        // Module 10 kohm pull-up to 5 V: only ~0.1 mA
        let pu = clamp(10_000.0, C3);
        assert!(pu.i > 5e-5 && pu.i < 2e-4, "{pu:?}");
        let n = net("15-clamp-5v.cir");
        assert!(near(at(&n, "pin"), o.v_pin, 1e-9));
    }
}
