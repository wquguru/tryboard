//! Board power network (P1-01 / P1-02): USB or external 5 V -> 5V rail -> on-board LDO -> 3V3 -> chip + modules; the servo
//! hangs off the 5V rail or external 5 V. Fixed 100 us implicit-Euler steps; 3V3 below the brownout threshold for longer
//! than the debounce time reports a brownout reset. Sources: DECISIONS 2026-10-16 electrical model; unsourced values are estimates.
//! Nodes (lint: allow-long-comment): 1 = board 5V rail (USB VBUS), 2 = 3V3, 3 = servo red wire, 4 = external 5 V (breadboard rail)

use crate::mna::{Circuit, Elem, Solution};
use crate::servo::{Servo, ServoParams};

pub const CPU_HZ: u64 = 160_000_000;
/// 100 us per step: servo mechanical time constant ~25 ms and debounce ~0.12 ms; faster RC loops stay stable under implicit Euler
pub const STEP_CYCLES: u64 = CPU_HZ / 10_000;
const DT: f64 = STEP_CYCLES as f64 / CPU_HZ as f64;

pub const N5V: usize = 1;
pub const N3V3: usize = 2;
pub const NSERVO: usize = 3;
pub const NEXT: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Power {
    /// PC USB only: the servo also draws from the 5V rail
    Usb,
    /// Board still on USB (for serial), servo powered by an external 5 V 2 A supply, common ground
    Ext,
}

impl Power {
    pub fn parse(s: &str) -> Option<Power> {
        match s {
            "usb" => Some(Power::Usb),
            "ext" => Some(Power::Ext),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Power::Usb => "usb",
            Power::Ext => "ext",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChipKind {
    S3,
    C3,
    /// Classic ESP32 (ESP32-DevKitC V4 + WROOM-32)
    Esp32,
}

/// Supply network parameters; each value's source is noted in `for_chip`
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Params {
    pub usb_v: f64,
    pub usb_r: f64,
    pub usb_ilim: f64,
    pub usb_rlim: f64,
    pub ext_v: f64,
    pub ext_r: f64,
    pub ext_ilim: f64,
    pub ext_rlim: f64,
    pub servo_wire_r: f64,
    pub c5v: f64,
    pub c3v3: f64,
    pub ldo_vset: f64,
    pub ldo_rout: f64,
    pub ldo_rdo: f64,
    pub ldo_ilim: f64,
    pub ldo_iq: f64,
    /// Chip: all cores in WAITI / extra per fully loaded core / extra with Wi-Fi on (RX listening) / total while transmitting / held in reset
    pub chip_idle: f64,
    pub chip_core: f64,
    pub chip_rx: f64,
    pub chip_tx: f64,
    pub chip_reset: f64,
    /// Other on-board 3V3 loads (power LED, USB-serial chip, idle on-board RGB LED)
    pub board_3v3: f64,
    /// Brownout threshold (V) and debounce (s); reset is held until the voltage returns above threshold + hysteresis
    pub bod_v: f64,
    pub bod_debounce: f64,
    pub bod_hyst: f64,
    /// Transmit time counted per Wi-Fi frame (s)
    pub tx_airtime: f64,
}

impl Params {
    pub fn for_chip(chip: ChipKind) -> Params {
        Params {
            // USB 2.0 host port: 5 V, 500 mA rated (spec; real ports often give more, estimate). Resistance = 0.1 ohm in the port
            // + ~0.43 ohm for two 28AWG power wires in a 1 m cable plus plugs (estimate 0.4 ohm)
            usb_v: 5.0,
            usb_r: 0.5,
            usb_ilim: 0.5,
            // Past the limit the voltage drops along a 20 ohm slope (PWL approximation of a limit switch in constant-current mode, estimate)
            usb_rlim: 20.0,
            // External 5 V 2 A adapter + DC jack + breadboard power rail (estimate)
            ext_v: 5.0,
            ext_r: 0.15,
            ext_ilim: 2.0,
            ext_rlim: 2.0,
            // Two 20 cm Dupont wires + breadboard contacts (estimate)
            servo_wire_r: 0.15,
            // Decoupling: 10 uF on 5V, 22 uF on 3V3 (board input / output caps + module caps, estimate)
            c5v: 10e-6,
            c3v3: 22e-6,
            // On-board LDO SGM2212-3.3 (ESP32-S3-DevKitC-1 per an Espressif forum engineer; C3-DevKitM-1 assumed the same, unverified):
            // 800 mA, 420 mV dropout @ 800 mA -> 0.525 ohm fully on; current limit not in the datasheet, 1.2 A assumed (estimate)
            ldo_vset: 3.3,
            ldo_rout: 0.01,
            ldo_rdo: 0.42 / 0.8,
            ldo_ilim: 1.2,
            ldo_iq: 0.0001,
            // Chip current (estimate, from the S3 / C3 / ESP32 datasheet power tables): modem-sleep tens of mA, 802.11b TX ~340 mA (S3),
            // 335 mA (C3), 240 mA (ESP32 at 19.5 dBm), RX ~90-95 mA
            chip_idle: match chip {
                ChipKind::S3 => 0.020,
                ChipKind::C3 => 0.014,
                ChipKind::Esp32 => 0.025,
            },
            chip_core: match chip {
                ChipKind::S3 => 0.012,
                ChipKind::C3 => 0.010,
                ChipKind::Esp32 => 0.015,
            },
            chip_rx: match chip {
                ChipKind::S3 => 0.075,
                ChipKind::C3 => 0.065,
                ChipKind::Esp32 => 0.095,
            },
            chip_tx: match chip {
                ChipKind::S3 => 0.340,
                ChipKind::C3 => 0.335,
                ChipKind::Esp32 => 0.240,
            },
            chip_reset: 0.005,
            // Power LED ~2 mA + CP2102N ~8 mA + idle on-board WS2812 ~1 mA (estimate)
            board_3v3: 0.011,
            // IDF 5.5 default ESP_BROWNOUT_DET_LVL_SEL_7: S3 2.44 V, C3 2.51 V; classic ESP32 LVL_SEL_0: 2.43 V (Kconfig, Espressif estimates).
            // Debounce: brownout_hal_config sets rst_wait = 0x3ff; counter clock unverified, ~8.75 MHz assumed -> ~0.12 ms (estimate)
            bod_v: match chip {
                ChipKind::S3 => 2.44,
                ChipKind::C3 => 2.51,
                ChipKind::Esp32 => 2.43,
            },
            bod_debounce: 0.000_12,
            bod_hyst: 0.05,
            tx_airtime: 0.0006,
        }
    }
}

/// Chip activity over an interval (given by the machine after each run)
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Activity {
    /// Busy cores (0..=2): instructions executed / cycles elapsed, summed over both cores
    pub busy: f64,
    /// Wi-Fi is on (has sent or received frames)
    pub wifi_on: bool,
    /// Fraction of this interval spent transmitting (0..1)
    pub tx: f64,
    /// Servo pulse width (us); None = no PWM
    pub servo_pw_us: Option<f64>,
    /// Current (A) of the amp on the 5 V rail (MAX98357A) right now, varies with output volume
    pub amp_i: f64,
}

/// Readings right now (voltage V, current A)
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Readings {
    pub v5: f64,
    pub v3v3: f64,
    pub v_servo: f64,
    pub v_ext: f64,
    pub i_usb: f64,
    pub i_ext: f64,
    pub i_servo: f64,
    pub i_3v3: f64,
    pub i_chip: f64,
    /// Module (amp) current on the 5 V rail
    pub i_amp: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    pub min_v5: f64,
    pub min_v3v3: f64,
    pub min_v_servo: f64,
    pub peak_i_usb: f64,
    pub peak_i_ext: f64,
    pub peak_i_servo: f64,
    pub peak_i_3v3: f64,
    pub peak_i_amp: f64,
    pub resets: u32,
    /// Simulated time (s) of each brownout reset and the lowest 3V3 at that moment
    pub brownouts: Vec<(f64, f64)>,
}

impl Default for Stats {
    fn default() -> Stats {
        Stats {
            min_v5: f64::MAX,
            min_v3v3: f64::MAX,
            min_v_servo: f64::MAX,
            peak_i_usb: 0.0,
            peak_i_ext: 0.0,
            peak_i_servo: 0.0,
            peak_i_3v3: 0.0,
            peak_i_amp: 0.0,
            resets: 0,
            brownouts: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Board {
    pub chip: ChipKind,
    pub p: Params,
    pub power: Power,
    pub servo: Option<Servo>,
    /// GPIO the servo signal is wired to
    pub servo_pin: Option<u32>,
    /// Current modules draw from 3V3 (A), summed over attached parts
    pub modules_3v3: f64,
    /// Current modules draw from the 5V rail (A), e.g. HC-SR04 (a 5 V part)
    pub modules_5v: f64,
    /// Whether a module (amp) sits on the 5 V rail
    pub amp: bool,
    pub now: Readings,
    pub stats: Stats,
    /// Simulated time integrated so far (cycles, a multiple of STEP_CYCLES)
    pub t: u64,
    /// Chip held in reset by brownout (does not run until the voltage recovers)
    pub held: bool,
    v: Vec<f64>,
    below: f64,
    vmin_episode: f64,
}

impl Board {
    pub fn new(chip: ChipKind) -> Board {
        let mut b = Board {
            chip,
            p: Params::for_chip(chip),
            power: Power::Usb,
            servo: None,
            servo_pin: None,
            modules_3v3: 0.0,
            modules_5v: 0.0,
            amp: false,
            now: Readings::default(),
            stats: Stats::default(),
            t: 0,
            held: false,
            v: vec![0.0; 5],
            below: 0.0,
            vmin_episode: f64::MAX,
        };
        b.settle();
        b
    }

    /// Power-on steady state (caps already charged)
    pub fn settle(&mut self) {
        let act = Activity {
            busy: 1.0,
            ..Default::default()
        };
        let c = self.circuit(&act);
        let s = c.solve(None, &[], &[0.0, 5.0, 3.3, 5.0, 5.0]);
        self.v = s.v;
    }

    pub fn attach_servo(&mut self, pin: u32) {
        // The servo's position before power-on is unknown; assume 90 deg (center)
        self.servo = Some(Servo::new(ServoParams::sg90(), 90.0));
        self.servo_pin = Some(pin);
        self.settle();
    }

    /// 3V3 current (A) of known parts, from currentMa.typ in web/src/catalog/parts.ts (same source, same labelling)
    pub fn module_current(kind: &str) -> Option<f64> {
        match kind {
            // BME280 datasheet: 3.6 uA at 1 Hz T/H/P
            "bme280" => Some(0.000_003_6),
            // SSD1306: estimate, scales with lit pixels, ~10 mA
            "ssd1306" => Some(0.010),
            // GC9A01 round display: estimate, mostly the 25 mA backlight
            "gc9a01" => Some(0.025),
            // CO5300 AMOLED 480x480: estimate, panel current depends on the image (~40 mA typical bright UI)
            "co5300" => Some(0.040),
            // MPU6050: estimate, datasheet gyro 3.6 mA + accel 0.5 mA
            "mpu6050" => Some(0.0039),
            // QMI8658: estimate, ~1.7 mA in 6-axis high-performance mode per datasheet (to verify verbatim)
            "qmi8658" => Some(0.0017),
            // CST816S: estimate, mA-level scan current (the round touch display backlight is counted in gc9a01)
            "cst816s" => Some(0.0025),
            // FT6236: estimate, mA-level active scan current (display backlight not included)
            "ft6236" => Some(0.004),
            // CST9220: estimate, mA-level active scan current (AMOLED panel not included)
            "cst9220" => Some(0.003),
            // EC11 encoder module: estimate, two 10 kohm pull-ups at 3.3 V (contacts closed)
            "encoder" => Some(0.000_66),
            // INMP441 datasheet: 1.4 mA operating current
            "inmp441" => Some(0.0014),
            // DHT11 datasheet: 0.2-1 mA average while sampling (upper end used)
            "dht11" => Some(0.001),
            // MFRC522 datasheet: ~10 mA operating plus the antenna drivers (module typical ~13 mA)
            "rc522" => Some(0.013),
            // Photoresistor + 10 kohm divider: <= 0.33 mA (worst case, LDR near 0 ohm)
            "ldr" => Some(0.000_33),
            _ => None,
        }
    }

    /// Parts powered from the 5V rail (A), also from currentMa.typ in parts.ts
    pub fn module_current_5v(kind: &str) -> Option<f64> {
        match kind {
            // HC-SR04 module spec: 15 mA operating current
            "hcsr04" => Some(0.015),
            // HC-SR501 module: < 65 uA quiescent
            "pir" => Some(0.000_065),
            // Relay module: ~70 mA coil, worst case counted as always energized (see DECISIONS F-04d)
            "relay" => Some(0.070),
            _ => None,
        }
    }

    pub fn add_module(&mut self, kind: &str) {
        // MAX98357A runs on 5 V (VIN to the 5V header): current comes per interval from the machine by volume (Activity::amp_i)
        if kind == "max98357a" {
            self.amp = true;
            return;
        }
        self.modules_3v3 += Self::module_current(kind).unwrap_or(0.0);
        self.modules_5v += Self::module_current_5v(kind).unwrap_or(0.0);
    }

    pub fn set_power(&mut self, p: Power) {
        self.power = p;
    }

    fn chip_current(&self, act: &Activity) -> f64 {
        let p = &self.p;
        if self.held {
            return p.chip_reset;
        }
        let rx = if act.wifi_on { p.chip_rx } else { 0.0 };
        let base = p.chip_idle + p.chip_core * act.busy.clamp(0.0, 2.0) + rx;
        // While transmitting the whole chip draws the TX current
        let tx = act.tx.clamp(0.0, 1.0);
        base * (1.0 - tx) + p.chip_tx.max(base) * tx
    }

    fn circuit(&self, act: &Activity) -> Circuit {
        let p = &self.p;
        let mut c = Circuit::new(4);
        // 0: USB source (its index is used in readings)
        c.add(Elem::Limit {
            a: N5V,
            vs: p.usb_v,
            r: p.usb_r,
            ilim: p.usb_ilim,
            rlim: p.usb_rlim,
        });
        // 1: external source (present even in USB mode on an unused node so element indices stay fixed)
        c.add(match self.power {
            Power::Ext => Elem::Limit {
                a: NEXT,
                vs: p.ext_v,
                r: p.ext_r,
                ilim: p.ext_ilim,
                rlim: p.ext_rlim,
            },
            Power::Usb => Elem::Load {
                a: NEXT,
                i: 0.0,
                vknee: 1.0,
            },
        });
        // 2: LDO
        c.add(Elem::Ldo {
            inp: N5V,
            out: N3V3,
            vset: p.ldo_vset,
            rout: p.ldo_rout,
            rdo: p.ldo_rdo,
            ilim: p.ldo_ilim,
            iq: p.ldo_iq,
        });
        // 3: chip, 4: other board loads + modules
        c.add(Elem::Load {
            a: N3V3,
            i: self.chip_current(act),
            vknee: 1.0,
        });
        c.add(Elem::Load {
            a: N3V3,
            i: p.board_3v3 + self.modules_3v3,
            vknee: 1.0,
        });
        // 5: servo motor, 6: servo control quiescent current, 7: servo supply wire
        let (vcmd, emf, r) = self
            .servo
            .as_ref()
            .map(|s| s.motor_elem())
            .unwrap_or((0.0, 0.0, 1.0));
        c.add(Elem::Motor {
            a: NSERVO,
            vcmd,
            emf,
            r,
        });
        c.add(Elem::Load {
            a: NSERVO,
            i: self.servo.as_ref().map(|s| s.p.iq).unwrap_or(0.0),
            vknee: 1.0,
        });
        let feed = if self.power == Power::Ext { NEXT } else { N5V };
        c.add(Elem::R {
            a: feed,
            b: NSERVO,
            r: p.servo_wire_r,
        });
        c.add(Elem::C {
            a: N5V,
            b: 0,
            c: p.c5v,
        });
        c.add(Elem::C {
            a: N3V3,
            b: 0,
            c: p.c3v3,
        });
        // 10: amp on the 5 V rail
        c.add(Elem::Load {
            a: N5V,
            i: if self.amp { act.amp_i } else { 0.0 },
            vknee: 1.0,
        });
        // 5V-rail modules: only added when attached (otherwise the network is bit-identical to before)
        if self.modules_5v > 0.0 {
            c.add(Elem::Load {
                a: N5V,
                i: self.modules_5v,
                vknee: 1.0,
            });
        }
        c
    }

    fn read(&mut self, s: &Solution) {
        let i = &s.i;
        self.now = Readings {
            v5: s.v[N5V],
            v3v3: s.v[N3V3],
            v_servo: if self.servo.is_some() {
                s.v[NSERVO]
            } else {
                0.0
            },
            v_ext: if self.power == Power::Ext {
                s.v[NEXT]
            } else {
                0.0
            },
            i_usb: i[0],
            i_ext: if self.power == Power::Ext { i[1] } else { 0.0 },
            i_servo: if self.servo.is_some() {
                i[5] + i[6]
            } else {
                0.0
            },
            i_3v3: i[2],
            i_chip: i[3],
            i_amp: if self.amp { i[10] } else { 0.0 },
        };
        let st = &mut self.stats;
        let n = &self.now;
        st.min_v5 = st.min_v5.min(n.v5);
        st.min_v3v3 = st.min_v3v3.min(n.v3v3);
        if self.servo.is_some() {
            st.min_v_servo = st.min_v_servo.min(n.v_servo);
        }
        st.peak_i_usb = st.peak_i_usb.max(n.i_usb);
        st.peak_i_ext = st.peak_i_ext.max(n.i_ext);
        st.peak_i_servo = st.peak_i_servo.max(n.i_servo);
        st.peak_i_3v3 = st.peak_i_3v3.max(n.i_3v3);
        st.peak_i_amp = st.peak_i_amp.max(n.i_amp);
    }

    /// Integrate up to simulated time now (cycles) in whole 100 us steps, carrying the rest, so results depend only on the
    /// activity given and not on call spacing. Returns true if a brownout reset fired (caller resets the chip, reason 15)
    pub fn advance(&mut self, now: u64, act: &Activity) -> bool {
        if let (Some(s), Some(_)) = (self.servo.as_mut(), self.servo_pin) {
            s.set_pulse(act.servo_pw_us);
        }
        let mut fired = false;
        while self.t + STEP_CYCLES <= now {
            self.t += STEP_CYCLES;
            let c = self.circuit(act);
            let prev = std::mem::take(&mut self.v);
            let sol = c.solve(Some(DT), &prev, &prev);
            self.v = sol.v.clone();
            let vs = self.v[NSERVO];
            if let Some(s) = self.servo.as_mut() {
                s.step(vs, DT);
            }
            self.read(&sol);
            let v3 = self.now.v3v3;
            let p = self.p;
            if self.held {
                // Hold reset until the voltage climbs back above threshold (plus hysteresis)
                if v3 >= p.bod_v + p.bod_hyst {
                    self.held = false;
                }
                continue;
            }
            if v3 < p.bod_v {
                self.below += DT;
                self.vmin_episode = self.vmin_episode.min(v3);
                if self.below >= p.bod_debounce - 1e-12 && !fired {
                    fired = true;
                    self.held = true;
                    self.stats.resets += 1;
                    self.stats
                        .brownouts
                        .push((self.t as f64 / CPU_HZ as f64, self.vmin_episode));
                    self.below = 0.0;
                    self.vmin_episode = f64::MAX;
                }
            } else {
                self.below = 0.0;
                self.vmin_episode = f64::MAX;
            }
        }
        fired
    }

    /// Node voltages (V) for the multimeter / wasm: 0 = ground, 1 = 5V rail, 2 = 3V3, 3 = servo red wire, 4 = external 5 V
    pub fn node_v(&self, n: usize) -> f64 {
        match n {
            N5V => self.now.v5,
            N3V3 => self.now.v3v3,
            NSERVO => self.now.v_servo,
            NEXT => self.now.v_ext,
            _ => 0.0,
        }
    }

    /// `--elec-report` text (shared by CLI and wasm)
    pub fn report(&self) -> String {
        use std::fmt::Write;
        let s = &self.stats;
        let mut o = String::new();
        let fmt_min = |x: f64| {
            if x == f64::MAX {
                "—".to_string()
            } else {
                format!("{x:.3} V")
            }
        };
        let _ = writeln!(
            o,
            "[tryboard] elec power={} servo={}",
            self.power.name(),
            self.servo_pin
                .map(|p| format!("GPIO{p}"))
                .unwrap_or_else(|| "none".into())
        );
        let _ = writeln!(
            o,
            "[tryboard] elec min voltage 5V={} 3V3={} servo={}",
            fmt_min(s.min_v5),
            fmt_min(s.min_v3v3),
            fmt_min(s.min_v_servo)
        );
        let _ = writeln!(
            o,
            "[tryboard] elec peak current USB={:.3} A ext={:.3} A servo={:.3} A 3V3={:.3} A",
            s.peak_i_usb, s.peak_i_ext, s.peak_i_servo, s.peak_i_3v3
        );
        if self.amp {
            let _ = writeln!(
                o,
                "[tryboard] elec amp (5V) peak current {:.3} A",
                s.peak_i_amp
            );
        }
        let _ = writeln!(o, "[tryboard] elec {} brownout resets", s.resets);
        for (t, v) in &s.brownouts {
            let _ = writeln!(
                o,
                "[tryboard] elec brownout reset @{t:.4}s 3V3 min {v:.3} V"
            );
        }
        o
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(b: &mut Board, secs: f64, pw: &dyn Fn(f64) -> Option<f64>) -> Vec<f64> {
        let mut resets = Vec::new();
        let ms = (secs * 1000.0) as u64;
        for k in 1..=ms {
            let t = k * CPU_HZ / 1000;
            let act = Activity {
                busy: 1.0,
                servo_pw_us: if b.held {
                    None
                } else {
                    pw(t as f64 / CPU_HZ as f64)
                },
                ..Default::default()
            };
            if b.advance(t, &act) {
                resets.push(t as f64 / CPU_HZ as f64);
            }
        }
        resets
    }

    #[test]
    fn idle_board_regulates() {
        let mut b = Board::new(ChipKind::S3);
        b.add_module("ssd1306");
        b.add_module("bme280");
        run(&mut b, 0.05, &|_| None);
        assert!((b.now.v3v3 - 3.3).abs() < 0.01, "{:?}", b.now);
        // ~50 mA: USB side 5 - 0.05*0.5
        assert!(b.now.v5 > 4.95 && b.now.v5 < 5.0, "{:?}", b.now);
        assert_eq!(b.stats.resets, 0);
    }

    #[test]
    fn wifi_tx_on_usb_does_not_brown_out() {
        let mut b = Board::new(ChipKind::C3);
        let act = Activity {
            busy: 1.0,
            wifi_on: true,
            tx: 1.0,
            servo_pw_us: None,
            amp_i: 0.0,
        };
        assert!(!b.advance(CPU_HZ / 10, &act));
        assert!(b.now.v3v3 > 3.2, "{:?}", b.now);
    }

    #[test]
    fn deterministic_independent_of_call_grain() {
        // With constant activity, calling every 1 ms or every 10 ms reaches the same state bit for bit (only whole 100 us steps)
        let act = Activity {
            busy: 1.0,
            servo_pw_us: Some(2500.0),
            ..Default::default()
        };
        let mut a = Board::new(ChipKind::S3);
        a.attach_servo(4);
        let mut b = a.clone();
        for k in 1..=200u64 {
            a.advance(k * CPU_HZ / 1000 + 7, &act);
        }
        for k in 1..=20u64 {
            b.advance(k * 10 * CPU_HZ / 1000 + 7, &act);
        }
        assert_eq!(a.now, b.now);
        assert_eq!(a.stats, b.stats);
        assert_eq!(a.servo, b.servo);
    }

    #[test]
    fn servo_ext_power_never_resets() {
        let mut b = Board::new(ChipKind::S3);
        b.attach_servo(4);
        b.set_power(Power::Ext);
        // Reverse 0<->180 deg every 0.15 s (before reaching the target: the worst-current case)
        let r = run(&mut b, 2.0, &|t| {
            Some(if ((t / 0.15) as u64).is_multiple_of(2) {
                2500.0
            } else {
                500.0
            })
        });
        assert!(r.is_empty(), "{r:?} {:?}", b.stats);
        assert!(b.stats.min_v3v3 > 3.25, "{:?}", b.stats);
        assert!(b.stats.peak_i_usb < 0.1, "{:?}", b.stats);
    }

    /// A 5 V part (HC-SR04) on the 5V rail: USB current rises by 15 mA, the 3V3 branch is unchanged
    #[test]
    fn hcsr04_draws_from_5v() {
        let act = Activity {
            busy: 1.0,
            ..Default::default()
        };
        let mut a = Board::new(ChipKind::S3);
        let mut b = Board::new(ChipKind::S3);
        b.add_module("hcsr04");
        b.add_module("encoder");
        a.advance(CPU_HZ / 100, &act);
        b.advance(CPU_HZ / 100, &act);
        let d = b.now.i_usb - a.now.i_usb;
        assert!((d - 0.015 - 0.000_66).abs() < 0.001, "extra {d} A");
        assert!((b.now.i_3v3 - a.now.i_3v3 - 0.000_66).abs() < 0.0001);
    }
}

#[cfg(test)]
mod scenarios {
    use super::*;
    fn scen(name: &str, secs: f64, pw: &dyn Fn(f64) -> Option<f64>) -> Stats {
        let mut b = Board::new(ChipKind::S3);
        b.add_module("ssd1306");
        b.attach_servo(4);
        let ms = (secs * 1000.0) as u64;
        let mut boot = 0.0;
        for k in 1..=ms {
            let t = k * CPU_HZ / 1000;
            let ts = t as f64 / CPU_HZ as f64;
            let act = Activity {
                busy: 1.0,
                servo_pw_us: if b.held { None } else { pw(ts - boot) },
                ..Default::default()
            };
            if b.advance(t, &act) {
                boot = ts;
            }
        }
        eprintln!(
            "{name}: 5V>={:.3} 3V3>={:.3} USB<={:.3} A servo<={:.3} A resets {}",
            b.stats.min_v5,
            b.stats.min_v3v3,
            b.stats.peak_i_usb,
            b.stats.peak_i_servo,
            b.stats.resets
        );
        b.stats.clone()
    }
    /// Basis for P1-02: under the 0.5 A USB limit a servo starting from rest (even a 180 deg jump) only drops 5V to ~3.0 V, 3V3 stays
    /// above 2.44 V; only reversing before arrival (plugging, i ~ (V + back-EMF)/R) collapses 5V and triggers a brownout reset
    #[test]
    fn scenarios() {
        let weather = scen("weather 1675us", 1.0, &|_| Some(1675.0));
        assert_eq!(weather.resets, 0);
        assert!(weather.min_v3v3 > 3.25, "{weather:?}");
        let l05 = scen("05 0->45->...->180", 3.0, &|t| {
            let a = [0.0, 45.0, 90.0, 135.0, 180.0, 90.0][((t / 0.4) as usize) % 6];
            Some(500.0 + a / 180.0 * 2000.0)
        });
        assert_eq!(l05.resets, 0);
        assert!(l05.min_v3v3 > 2.9 && l05.min_v3v3 < 3.2, "{l05:?}");
        let jump = scen("0<->180 hold 0.6 s", 3.0, &|t| {
            Some(if ((t / 0.6) as u64).is_multiple_of(2) {
                500.0
            } else {
                2500.0
            })
        });
        assert_eq!(jump.resets, 0);
        let rev = scen("0<->180 reverse every 0.15 s", 3.0, &|t| {
            Some(if ((t / 0.15) as u64).is_multiple_of(2) {
                2500.0
            } else {
                500.0
            })
        });
        assert!(rev.resets > 0 && rev.min_v3v3 < 2.44, "{rev:?}");
    }
}
