//! Second-order servo dynamics (P1-03). Only drives current draw and the 3D angle; nothing the firmware can read.
//! Model (lint: allow-long-comment): P controller vm = clamp(Kp*err, +-supply) with a dead band; motor i = (vm - k*w)/R;
//! mechanics J*w' = eta*k*i - b*w - tau_load, stopping at the end stops (stall).
//! Supply current = quiescent + max(0, sign(vm)*i): an H-bridge draws while driving; regenerated current returns via body
//! diodes and is counted as 0. So current splits naturally into quiescent + acceleration + friction/load + the start
//! spike (at w=0, i = V/R, the stall current).

/// Servo parameters, all referred to the output shaft, SI units
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ServoParams {
    pub r: f64,
    pub k: f64,
    pub eta: f64,
    pub b: f64,
    pub j: f64,
    /// Error that maps to full voltage (rad)
    pub band: f64,
    /// Dead band (rad)
    pub dead: f64,
    /// Control circuit quiescent current (A)
    pub iq: f64,
    /// Mechanical end stops (rad)
    pub stop_lo: f64,
    pub stop_hi: f64,
    /// Pulse width -> angle: pw_lo us = 0 deg, pw_hi us = 180 deg
    pub pw_lo: f64,
    pub pw_hi: f64,
}

const DEG: f64 = std::f64::consts::PI / 180.0;

impl ServoParams {
    // SG90 estimates (DECISIONS 2026-10-16 electrical model): 0.1 s/60 deg @4.8 V, 1.8 kgf*cm stall, 0.7 A stall -> R,
    // 0.15 A no-load -> k; eta = 0.7 matches stall torque; J from ~25 ms to full speed; 10 deg proportional band.
    pub fn sg90() -> ServoParams {
        let r = 4.8 / 0.7;
        let w0 = 60.0 * DEG / 0.1;
        let k = (4.8 - 0.15 * r) / w0;
        let eta = 0.7;
        ServoParams {
            r,
            k,
            eta,
            b: eta * k * 0.15 / w0,
            j: 0.025 * eta * k * k / r,
            band: 10.0 * DEG,
            dead: 0.9 * DEG,
            iq: 0.006,
            stop_lo: -8.0 * DEG,
            stop_hi: 188.0 * DEG,
            pw_lo: 500.0,
            pw_hi: 2500.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Servo {
    pub p: ServoParams,
    /// Output shaft angle (rad) and angular velocity (rad/s)
    pub theta: f64,
    pub omega: f64,
    /// Target angle (rad); None = no pulse (not driven)
    pub target: Option<f64>,
    /// External load torque (N*m, friction-like, opposes rotation)
    pub load: f64,
    /// Held by an external force (stall test / held by hand on the web page)
    pub blocked: bool,
    /// This step's motor current (A, signed) and supply current (A, including quiescent)
    pub i_motor: f64,
    pub i_supply: f64,
    /// This step's acceleration (rad/s^2), for the 3D look
    pub alpha: f64,
}

/// Full-scale voltage of the proportional band: SG90's max supply, then clamped by the actual supply
const VFULL: f64 = 6.0;

/// Motor voltage magnitude the controller wants (before supply clamping) and its direction
pub fn command(p: &ServoParams, theta: f64, target: Option<f64>) -> (f64, f64) {
    let Some(t) = target else { return (0.0, 0.0) };
    let e = t - theta;
    if e.abs() <= p.dead {
        return (0.0, 0.0);
    }
    let s = e.signum();
    // Proportional inside the band, full voltage outside it (then clamped by the actual supply)
    ((e.abs() / p.band).min(1.0) * VFULL, s)
}

impl Servo {
    pub fn new(p: ServoParams, theta_deg: f64) -> Servo {
        Servo {
            p,
            theta: theta_deg * DEG,
            omega: 0.0,
            target: None,
            load: 0.0,
            blocked: false,
            i_motor: 0.0,
            i_supply: p.iq,
            alpha: 0.0,
        }
    }

    pub fn angle_deg(&self) -> f64 {
        self.theta / DEG
    }

    /// Set the target from PWM pulse width (us); None = no pulse
    pub fn set_pulse(&mut self, pw_us: Option<f64>) {
        self.target = pw_us.map(|pw| {
            let a = (pw - self.p.pw_lo) / (self.p.pw_hi - self.p.pw_lo) * 180.0;
            a * DEG
        });
    }

    /// Motor element for MNA: (vcmd, emf, r); supply current = max(0, (min(v, vcmd) - emf)/r), see mna::Elem::Motor.
    /// Reverse drive folds the sign in: sign*i = (|vm| - sign*k*w)/R
    pub fn motor_elem(&self) -> (f64, f64, f64) {
        let (v, s) = command(&self.p, self.theta, self.target);
        (v, s * self.p.k * self.omega, self.p.r)
    }

    /// Advance dt seconds using the solved supply voltage vs
    pub fn step(&mut self, vs: f64, dt: f64) {
        let p = self.p;
        let (v, s) = command(&p, self.theta, self.target);
        let vm = s * v.min(vs.max(0.0));
        let i = if s == 0.0 {
            0.0
        } else {
            (vm - p.k * self.omega) / p.r
        };
        // Draws from the supply while driving; regeneration (i opposite to vm) counts as 0
        let isup = if s == 0.0 { 0.0 } else { (s * i).max(0.0) };
        self.i_motor = i;
        self.i_supply = p.iq + isup;
        if self.blocked {
            self.omega = 0.0;
            self.alpha = 0.0;
            return;
        }
        let tau = p.eta * p.k * i - p.b * self.omega - self.load * self.omega.signum();
        let alpha = tau / p.j;
        // Semi-implicit Euler (velocity first, then angle) is stable for this damped system
        let mut w = self.omega + alpha * dt;
        let mut th = self.theta + w * dt;
        if th <= p.stop_lo {
            th = p.stop_lo;
            w = w.max(0.0);
        } else if th >= p.stop_hi {
            th = p.stop_hi;
            w = w.min(0.0);
        }
        self.alpha = (w - self.omega) / dt;
        self.omega = w;
        self.theta = th;
    }

    /// Pushing against an end stop or held (stall)
    pub fn stalled(&self) -> bool {
        let at_stop = self.theta <= self.p.stop_lo + 1e-9 || self.theta >= self.p.stop_hi - 1e-9;
        (self.blocked || at_stop) && self.i_motor.abs() > 0.3 * 4.8 / self.p.r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run on an ideal 5 V supply; returns (max angle, peak current, final angle, time within +-1 deg of target)
    fn run(s: &mut Servo, secs: f64, target_deg: f64) -> (f64, f64, f64, Option<f64>) {
        s.set_pulse(Some(500.0 + target_deg / 180.0 * 2000.0));
        let dt = 1e-4;
        let (mut mx, mut ip, mut reach) = (f64::MIN, 0.0f64, None);
        for n in 0..(secs / dt) as usize {
            s.step(5.0, dt);
            mx = mx.max(s.angle_deg());
            ip = ip.max(s.i_supply);
            if reach.is_none() && (s.angle_deg() - target_deg).abs() < 1.0 {
                reach = Some(n as f64 * dt);
            }
        }
        (mx, ip, s.angle_deg(), reach)
    }

    #[test]
    fn sg90_speed_overshoot_and_spike() {
        let mut s = Servo::new(ServoParams::sg90(), 0.0);
        let (mx, ip, end, reach) = run(&mut s, 0.6, 180.0);
        // 180 deg takes ~0.3 s at 5 V (spec 0.1 s/60 deg @4.8 V)
        let t = reach.unwrap();
        eprintln!("SG90 0->180 deg: reached {t:.3} s, max {mx:.2} deg, peak {ip:.3} A, final {end:.2} deg");
        assert!((0.24..0.40).contains(&t), "reached {t}");
        // Small overshoot, settles near the target (inside the dead band)
        assert!(mx > 180.2 && mx < 186.0, "max {mx}");
        assert!((end - 180.0).abs() < 1.0, "final {end}");
        // Start spike ~ stall current (5 V / 6.86 ohm ~ 0.73 A)
        assert!((0.65..0.8).contains(&ip), "peak {ip}");
        // Once stopped only quiescent current remains
        assert!((s.i_supply - s.p.iq).abs() < 1e-9);
    }

    #[test]
    fn small_move_stays_in_band() {
        // A 5 deg move stays in the band: half voltage, current well under stall
        let mut s = Servo::new(ServoParams::sg90(), 90.0);
        let (_, ip, end, _) = run(&mut s, 0.3, 95.0);
        assert!(ip < 0.45, "peak {ip}");
        assert!((end - 95.0).abs() < 1.0);
    }

    #[test]
    fn stall_draws_stall_current() {
        let mut s = Servo::new(ServoParams::sg90(), 90.0);
        s.blocked = true;
        let (_, ip, end, _) = run(&mut s, 0.1, 180.0);
        assert!((end - 90.0).abs() < 1e-9);
        assert!((ip - (s.p.iq + 5.0 / s.p.r)).abs() < 1e-6);
        assert!(s.stalled());
    }

    #[test]
    fn no_pulse_no_drive() {
        let mut s = Servo::new(ServoParams::sg90(), 45.0);
        s.set_pulse(None);
        s.step(5.0, 1e-3);
        assert_eq!(s.i_supply, s.p.iq);
    }
}
