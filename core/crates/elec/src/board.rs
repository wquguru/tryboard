//! 开发板供电网络（P1-01 / P1-02）：USB 或外接 5 V → 5V 轨 → 板载 LDO → 3V3 轨 → 芯片 + 模块；舵机挂 5V 轨或外接 5 V。
//! 按模拟时间固定 100 µs 一步推进（隐式欧拉），3V3 低于欠压门限持续超过去抖时间就报告欠压复位。
//!
//! 所有数值的来源见 DECISIONS 2026-10-16「电气模型」；没有数据手册出处的都标了"估算"。
//!
//! 节点：1 = 板上 5V 轨（USB VBUS），2 = 3V3，3 = 舵机红线，4 = 外接 5 V（面包板电源轨）

use crate::mna::{Circuit, Elem, Solution};
use crate::servo::{Servo, ServoParams};

pub const CPU_HZ: u64 = 160_000_000;
/// 一步 100 µs：舵机机械时间常数约 25 ms、去抖 0.12 ms 量级，100 µs 足够；电容回路时间常数更短，隐式欧拉照样稳定
pub const STEP_CYCLES: u64 = CPU_HZ / 10_000;
const DT: f64 = STEP_CYCLES as f64 / CPU_HZ as f64;

pub const N5V: usize = 1;
pub const N3V3: usize = 2;
pub const NSERVO: usize = 3;
pub const NEXT: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Power {
    /// 只有电脑 USB：舵机也从 5V 轨取电
    Usb,
    /// 开发板仍插 USB（看串口），舵机改由外接 5 V 2 A 供电，共地
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
}

/// 供电网络参数。每个数的来源写在 `for_chip` 里
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
    /// 芯片：全部核 WAITI 时 / 每个核满负荷增加 / Wi-Fi 打开（接收监听）增加 / 发射时总电流 / 复位保持时
    pub chip_idle: f64,
    pub chip_core: f64,
    pub chip_rx: f64,
    pub chip_tx: f64,
    pub chip_reset: f64,
    /// 板上其它 3V3 负载（电源灯、USB 转串口芯片、板载彩灯静态）
    pub board_3v3: f64,
    /// 欠压门限（V）与去抖（s）；复位保持到电压回到门限 + 回差
    pub bod_v: f64,
    pub bod_debounce: f64,
    pub bod_hyst: f64,
    /// 一个 Wi-Fi 帧算多长的发射时间（s）
    pub tx_airtime: f64,
}

impl Params {
    pub fn for_chip(chip: ChipKind) -> Params {
        let s3 = chip == ChipKind::S3;
        Params {
            // USB 2.0 主机口：5 V，额定 500 mA（规范值；真机口多数能给更多，这里按规范、估算）。
            // 内阻 = 口内 0.1 Ω + 1 m 线两根 28AWG 电源线约 0.43 Ω 加插头（估算 0.4 Ω）
            usb_v: 5.0,
            usb_r: 0.5,
            usb_ilim: 0.5,
            // 超过限流后按 20 Ω 斜率掉压（限流开关进恒流区的分段线性近似，估算）
            usb_rlim: 20.0,
            // 外接 5 V 2 A 适配器 + DC 母座 + 面包板电源轨（估算）
            ext_v: 5.0,
            ext_r: 0.15,
            ext_ilim: 2.0,
            ext_rlim: 2.0,
            // 杜邦线两根 20 cm + 面包板接触（估算）
            servo_wire_r: 0.15,
            // 去耦：5V 轨 10 µF、3V3 轨 22 µF（开发板输入 / 输出电容 + 模组内电容，估算）
            c5v: 10e-6,
            c3v3: 22e-6,
            // 板载 LDO SGM2212-3.3（ESP32-S3-DevKitC-1，乐鑫论坛工程师答复；C3-DevKitM-1 按同款，待核）：
            // 数据手册 800 mA、压差 420 mV @ 800 mA → 调整管全开等效 0.525 Ω；限流值手册未给，取 1.2 A（估算）
            ldo_vset: 3.3,
            ldo_rout: 0.01,
            ldo_rdo: 0.42 / 0.8,
            ldo_ilim: 1.2,
            ldo_iq: 0.0001,
            // 芯片电流（估算，量级取自 ESP32-S3 / C3 数据手册"功耗"表：modem-sleep 数十 mA、
            // 802.11b 1 Mbps 21 dBm 发射约 340 mA（S3）/ 335 mA（C3）、接收约 90 mA）
            chip_idle: if s3 { 0.020 } else { 0.014 },
            chip_core: if s3 { 0.012 } else { 0.010 },
            chip_rx: if s3 { 0.075 } else { 0.065 },
            chip_tx: if s3 { 0.340 } else { 0.335 },
            chip_reset: 0.005,
            // 电源灯约 2 mA + CP2102N 约 8 mA + 板载 WS2812 静态约 1 mA（估算）
            board_3v3: 0.011,
            // IDF 5.5 默认档 ESP_BROWNOUT_DET_LVL_SEL_7：S3 2.44 V、C3 2.51 V（Kconfig.power，乐鑫标注为估计值）。
            // 去抖：brownout_hal_config 写 rst_wait = 0x3ff，计数时钟未核实，按约 8.75 MHz 估 ≈ 0.12 ms（估算）
            bod_v: if s3 { 2.44 } else { 2.51 },
            bod_debounce: 0.000_12,
            bod_hyst: 0.05,
            tx_airtime: 0.0006,
        }
    }
}

/// 一段时间里的芯片活动（由机器在每次 run 之后给出）
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Activity {
    /// 忙的核数（0..=2）：执行的指令数 / 经过的周期数，两核相加
    pub busy: f64,
    /// Wi-Fi 已打开（收发过帧）
    pub wifi_on: bool,
    /// 这段时间里发射所占比例（0..1）
    pub tx: f64,
    /// 舵机脉宽（µs）；None = 没有 PWM
    pub servo_pw_us: Option<f64>,
}

/// 此刻的读数（电压 V、电流 A）
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
    pub resets: u32,
    /// 每次欠压复位的模拟时刻（s）与当时 3V3 的最低值
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
    /// 舵机信号接哪个 GPIO
    pub servo_pin: Option<u32>,
    /// 模块从 3V3 取的电流（A），由挂上的器件累加
    pub modules_3v3: f64,
    pub now: Readings,
    pub stats: Stats,
    /// 已经积分到的模拟时刻（周期，STEP_CYCLES 的整数倍）
    pub t: u64,
    /// 芯片被欠压复位按住（电压回升前不运行）
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

    /// 上电时的稳态（电容已充好）
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
        // 舵机上电前停在哪不知道，按 90°（中位）算
        self.servo = Some(Servo::new(ServoParams::sg90(), 90.0));
        self.servo_pin = Some(pin);
        self.settle();
    }

    /// 已知器件的 3V3 电流（A），数值取自 web/src/catalog/parts.ts 的 currentMa.typ（同一来源、同样标注）
    pub fn module_current(kind: &str) -> Option<f64> {
        match kind {
            // BME280 数据手册：1 Hz 温湿压 3.6 µA
            "bme280" => Some(0.000_003_6),
            // SSD1306：估算，随点亮像素数，10 mA 量级
            "ssd1306" => Some(0.010),
            // GC9A01 圆屏：估算，主要是背光 25 mA
            "gc9a01" => Some(0.025),
            _ => None,
        }
    }

    pub fn add_module(&mut self, kind: &str) {
        self.modules_3v3 += Self::module_current(kind).unwrap_or(0.0);
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
        // 发射期间整颗芯片的电流就是发射电流
        let tx = act.tx.clamp(0.0, 1.0);
        base * (1.0 - tx) + p.chip_tx.max(base) * tx
    }

    fn circuit(&self, act: &Activity) -> Circuit {
        let p = &self.p;
        let mut c = Circuit::new(4);
        // 0：USB 源（下标在 readings 里用到）
        c.add(Elem::Limit {
            a: N5V,
            vs: p.usb_v,
            r: p.usb_r,
            ilim: p.usb_ilim,
            rlim: p.usb_rlim,
        });
        // 1：外接源（USB 模式下也放着，接在没人用的节点上，保持元件下标固定）
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
        // 2：LDO
        c.add(Elem::Ldo {
            inp: N5V,
            out: N3V3,
            vset: p.ldo_vset,
            rout: p.ldo_rout,
            rdo: p.ldo_rdo,
            ilim: p.ldo_ilim,
            iq: p.ldo_iq,
        });
        // 3：芯片，4：板上其它 + 模块
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
        // 5：舵机电机，6：舵机控制电路静态电流，7：舵机电源线
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
    }

    /// 积分到模拟时刻 now（周期）。只走整步（100 µs），余下的留到下次，所以结果只取决于每次调用时给的活动，
    /// 与调用间隔无关以外的因素无关。返回 true = 这段时间里触发了欠压复位（调用方让芯片复位，原因 15）
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
                // 复位按住，直到电压回到门限以上（加回差）
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

    /// 节点电压（V）：给万用表 / wasm 用。0 = 地，1 = 5V 轨，2 = 3V3，3 = 舵机红线，4 = 外接 5 V
    pub fn node_v(&self, n: usize) -> f64 {
        match n {
            N5V => self.now.v5,
            N3V3 => self.now.v3v3,
            NSERVO => self.now.v_servo,
            NEXT => self.now.v_ext,
            _ => 0.0,
        }
    }

    /// `--elec-report` 的文字（CLI 与 wasm 同一份）
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
            "[tryboard] 电气 供电={} 舵机={}",
            self.power.name(),
            self.servo_pin
                .map(|p| format!("GPIO{p}"))
                .unwrap_or_else(|| "无".into())
        );
        let _ = writeln!(
            o,
            "[tryboard] 电气 最低电压 5V={} 3V3={} 舵机={}",
            fmt_min(s.min_v5),
            fmt_min(s.min_v3v3),
            fmt_min(s.min_v_servo)
        );
        let _ = writeln!(
            o,
            "[tryboard] 电气 峰值电流 USB={:.3} A 外接={:.3} A 舵机={:.3} A 3V3={:.3} A",
            s.peak_i_usb, s.peak_i_ext, s.peak_i_servo, s.peak_i_3v3
        );
        let _ = writeln!(o, "[tryboard] 电气 欠压复位 {} 次", s.resets);
        for (t, v) in &s.brownouts {
            let _ = writeln!(o, "[tryboard] 电气 欠压复位 @{t:.4}s 3V3 最低 {v:.3} V");
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
        // 约 50 mA：USB 端 5 − 0.05·0.5
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
        };
        assert!(!b.advance(CPU_HZ / 10, &act));
        assert!(b.now.v3v3 > 3.2, "{:?}", b.now);
    }

    #[test]
    fn deterministic_independent_of_call_grain() {
        // 活动不变时，1 ms 调一次和 10 ms 调一次积分到同一时刻，结果逐位相同（只走 100 µs 整步）
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
        // 0↔180° 每 0.15 s 换向（没到位就反转，电流最大的情形）
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
            "{name}: 5V≥{:.3} 3V3≥{:.3} USB≤{:.3} A 舵机≤{:.3} A 复位 {}",
            b.stats.min_v5,
            b.stats.min_v3v3,
            b.stats.peak_i_usb,
            b.stats.peak_i_servo,
            b.stats.resets
        );
        b.stats.clone()
    }
    /// P1-02 的依据：USB 0.5 A 限流下，舵机从静止起步（哪怕 180° 跳变）5V 轨只掉到约 3.0 V，3V3 仍高于 2.44 V；
    /// 只有"没到位就反向"（反接制动，电流 ≈ (V + 反电动势)/R）才把 5V 轨拉垮、触发欠压复位
    #[test]
    fn scenarios() {
        let weather = scen("weather 1675us", 1.0, &|_| Some(1675.0));
        assert_eq!(weather.resets, 0);
        assert!(weather.min_v3v3 > 3.25, "{weather:?}");
        let l05 = scen("05 0→45→…→180", 3.0, &|t| {
            let a = [0.0, 45.0, 90.0, 135.0, 180.0, 90.0][((t / 0.4) as usize) % 6];
            Some(500.0 + a / 180.0 * 2000.0)
        });
        assert_eq!(l05.resets, 0);
        assert!(l05.min_v3v3 > 2.9 && l05.min_v3v3 < 3.2, "{l05:?}");
        let jump = scen("0↔180 停 0.6 s", 3.0, &|t| {
            Some(if ((t / 0.6) as u64).is_multiple_of(2) {
                500.0
            } else {
                2500.0
            })
        });
        assert_eq!(jump.resets, 0);
        let rev = scen("0↔180 每 0.15 s 反向", 3.0, &|t| {
            Some(if ((t / 0.15) as u64).is_multiple_of(2) {
                2500.0
            } else {
                500.0
            })
        });
        assert!(rev.resets > 0 && rev.min_v3v3 < 2.44, "{rev:?}");
    }
}
