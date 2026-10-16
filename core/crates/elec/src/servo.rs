//! 舵机二阶动力学（P1-03）。只决定电流和 3D 里的角度，不回写固件能读到的任何东西。
//!
//! 模型：位置伺服 = 比例控制器 + 有刷直流电机 + 减速箱，全部折算到输出轴。
//!   控制器：电机电压 vm = clamp(Kp·误差, ±电源电压)，误差在死区内为 0（不驱动）
//!   电机：  i = (vm − k·ω)/R；输出扭矩 = η·k·i
//!   机械：  J·ω' = η·k·i − b·ω − τ负载；碰到机械限位就停住（堵转）
//! 从电源取的电流 = 静态电流 + max(0, sign(vm)·i)（H 桥：驱动时从电源取电；回馈时电流经体二极管回电源，这里记 0）。
//! 所以电流自然分成：静态 + 加速度项（J·ω'/ηk）+ 摩擦 / 负载项 + 起步尖峰（ω=0 时 i = V/R，就是堵转电流）。
//!
//! 参数（SG90，全部是估算，见 DECISIONS 2026-10-16「电气模型」）：
//!   规格书：4.8 V 时 0.1 s/60°（空载 10.47 rad/s）、堵转扭矩 1.8 kgf·cm（0.176 N·m）、死区 10 µs
//!   堵转电流 0.7 A（catalog sg90.currentMa.peak，估算）→ R = 4.8/0.7 = 6.86 Ω
//!   空载运行电流 0.15 A（catalog typ，估算）→ k = (4.8 − 0.15·R)/10.47 = 0.360 V·s/rad
//!   η 取 0.7，使 η·k·0.7 A = 0.176 N·m 与规格书堵转扭矩一致；b = η·k·0.15/10.47
//!   J：按"起步约 25 ms 到全速"反推 J = 0.025·η·k²/R（机械时间常数，估算）
//!   比例带 10°：误差超过 10° 时满电压（模拟舵机芯片的典型做法，估算）

/// 一种舵机的参数（全部折算到输出轴，SI 单位）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ServoParams {
    pub r: f64,
    pub k: f64,
    pub eta: f64,
    pub b: f64,
    pub j: f64,
    /// 满电压对应的误差（rad）
    pub band: f64,
    /// 死区（rad）
    pub dead: f64,
    /// 控制电路静态电流（A）
    pub iq: f64,
    /// 机械限位（rad）
    pub stop_lo: f64,
    pub stop_hi: f64,
    /// 脉宽 → 角度：pw_lo µs = 0°，pw_hi µs = 180°
    pub pw_lo: f64,
    pub pw_hi: f64,
}

const DEG: f64 = std::f64::consts::PI / 180.0;

impl ServoParams {
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
    /// 输出轴角度（rad）与角速度（rad/s）
    pub theta: f64,
    pub omega: f64,
    /// 目标角度（rad）；None = 没有脉冲（不驱动）
    pub target: Option<f64>,
    /// 外加负载扭矩（N·m，与转动方向相反的摩擦型负载）
    pub load: f64,
    /// 外力卡住（堵转测试 / 网页上用手按住）
    pub blocked: bool,
    /// 本步的电机电流（A，带符号）与从电源取的电流（A，含静态）
    pub i_motor: f64,
    pub i_supply: f64,
    /// 本步加速度（rad/s²），给 3D 观感用
    pub alpha: f64,
}

/// 比例带满量程电压：取 SG90 允许的最高电源电压，实际再被电源电压夹住
const VFULL: f64 = 6.0;

/// 控制器想加的电机电压大小（夹到电源电压之前）与方向
pub fn command(p: &ServoParams, theta: f64, target: Option<f64>) -> (f64, f64) {
    let Some(t) = target else { return (0.0, 0.0) };
    let e = t - theta;
    if e.abs() <= p.dead {
        return (0.0, 0.0);
    }
    let s = e.signum();
    // 比例带内按误差比例给电压，超出就是满电压（再被实际电源电压夹住）
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

    /// 由 PWM 设目标：脉宽（µs）；None = 没有脉冲
    pub fn set_pulse(&mut self, pw_us: Option<f64>) {
        self.target = pw_us.map(|pw| {
            let a = (pw - self.p.pw_lo) / (self.p.pw_hi - self.p.pw_lo) * 180.0;
            a * DEG
        });
    }

    /// 给 MNA 的电机元件参数：(vcmd, emf, r)。电源电流 = max(0, (min(v, vcmd) − emf)/r)，见 mna::Elem::Motor。
    /// 反方向驱动时把方向折进去：sign·i = (|vm| − sign·k·ω)/R
    pub fn motor_elem(&self) -> (f64, f64, f64) {
        let (v, s) = command(&self.p, self.theta, self.target);
        (v, s * self.p.k * self.omega, self.p.r)
    }

    /// 用解出来的电源电压 vs 推进 dt 秒
    pub fn step(&mut self, vs: f64, dt: f64) {
        let p = self.p;
        let (v, s) = command(&p, self.theta, self.target);
        let vm = s * v.min(vs.max(0.0));
        let i = if s == 0.0 {
            0.0
        } else {
            (vm - p.k * self.omega) / p.r
        };
        // 驱动时从电源取电；回馈（i 与 vm 反向）记 0
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
        // 半隐式欧拉：先更新速度再更新角度（对这种阻尼系统稳定）
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

    /// 是否顶在机械限位上还在使劲（堵转）
    pub fn stalled(&self) -> bool {
        let at_stop = self.theta <= self.p.stop_lo + 1e-9 || self.theta >= self.p.stop_hi - 1e-9;
        (self.blocked || at_stop) && self.i_motor.abs() > 0.3 * 4.8 / self.p.r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 理想 5 V 电源下跑 t 秒，返回 (最大角, 峰值电流, 最后角度, 到达目标 ±1° 的时刻)
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
        // 5 V 下 180° 约 0.3 s（规格 0.1 s/60° @4.8 V）
        let t = reach.unwrap();
        eprintln!("SG90 0→180°：到位 {t:.3} s，最大 {mx:.2}°，峰值 {ip:.3} A，最后 {end:.2}°");
        assert!((0.24..0.40).contains(&t), "到位 {t}");
        // 有过冲但不大，最后停在目标附近（死区内）
        assert!(mx > 180.2 && mx < 186.0, "最大 {mx}");
        assert!((end - 180.0).abs() < 1.0, "最后 {end}");
        // 起步尖峰 ≈ 堵转电流（5 V / 6.86 Ω ≈ 0.73 A）
        assert!((0.65..0.8).contains(&ip), "峰值 {ip}");
        // 停下以后只剩静态电流
        assert!((s.i_supply - s.p.iq).abs() < 1e-9);
    }

    #[test]
    fn small_move_stays_in_band() {
        // 5° 小幅动作在比例带内：电压只给一半，电流远小于堵转电流
        let mut s = Servo::new(ServoParams::sg90(), 90.0);
        let (_, ip, end, _) = run(&mut s, 0.3, 95.0);
        assert!(ip < 0.45, "峰值 {ip}");
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
