//! 接错线的电流（P2-14）：实验台接线检查找到的错接，在这里建一个小网表用 MNA 求一次直流工作点，
//! 给出"会流多大电流、被谁限住"。网页经 wasm 调同一份代码，tools/elec/11–15 是同样的电路给 ngspice 对照。
//!
//! 参数来源（数值都是估算，网页上带"估算"徽章）：
//! - GPIO 推挽输出内阻：ESP32-C3 数据手册 v2.4 表 5-4（DC 特性，3.3 V、25 °C）PAD_DRIVER = 3 时
//!   I_OH = 40 mA @ V_OH ≥ 2.64 V → 0.66 V / 40 mA = 16.5 Ω；I_OL = 28 mA @ V_OL = 0.495 V → 17.7 Ω。
//!   IDF 默认驱动档是 GPIO_DRIVE_CAP_2，按驱动电流减半折算成 33 Ω / 35.4 Ω（估算；S3 手册同表数值相同）。
//!   真实输出级在大电流下会饱和（电流封顶），线性内阻算出来的短路电流偏大，按"最坏情况"用。
//! - 红色 5 mm LED：规格书典型 V_F = 2.0 V @ 20 mA，折线化成 1.8 V 起导 + 10 Ω（估算）。
//! - 引脚 ESD 钳位二极管（引脚 → VDD3P3）：0.6 V 起导 + 10 Ω（估算，乐鑫没有公布注入电流参数）。
//! - 跳线：20 cm 杜邦线 + 两处面包板接触，约 0.05 Ω（估算）。
//! - 供电（USB 限流、LDO）沿用 board.rs 的 Params，芯片按一个核满负荷 + 板上其它负载。

use crate::board::{ChipKind, Params};
use crate::mna::{Circuit, Elem, Solution};

pub const VDD: f64 = 3.3;
/// GPIO 输出高时的内阻（Ω）：2 × 0.66 V / 40 mA
pub const GPIO_R_HIGH: f64 = 33.0;
/// GPIO 输出低时的内阻（Ω）：2 × 0.495 V / 28 mA
pub const GPIO_R_LOW: f64 = 35.36;
pub const LED_VF: f64 = 1.8;
pub const LED_RD: f64 = 10.0;
pub const CLAMP_VF: f64 = 0.6;
pub const CLAMP_RD: f64 = 10.0;
pub const JUMPER_R: f64 = 0.05;

/// 电流被谁限住
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limiter {
    /// 只有导线 / 输出级 / 器件内阻（没有保护，电流就是 V/R）
    Resistance = 0,
    /// 电脑 USB 口限流（5V 轨被拉垮）
    Usb = 1,
    /// 外接 5 V 电源限流
    Ext = 2,
    /// 板载 LDO 限流
    Ldo = 3,
    /// LDO 输入被拉低进了压差区（上游 USB 先顶不住）
    LdoDropout = 4,
}

/// 求解结果（A / V）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FaultOut {
    /// 错接那条支路的电流
    pub i: f64,
    /// 关键节点电压：对打 / LED / 钳位时是引脚，短路时是被短路的电源轨
    pub v_pin: f64,
    pub v5: f64,
    pub v33: f64,
    pub limiter: Limiter,
}

/// 被短路到 GND 的电源
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rail {
    V3v3,
    V5,
    Ext5v,
}

/// 两个推挽输出对打：A 侧 va 经 ra，B 侧 vb 经 rb，接在同一个引脚上。节点 1 = A 内部，2 = 引脚，3 = B 内部
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

/// 零件的输出（vd 经 rd）对上 GPIO 的输出：GPIO 取相反电平（零件推高就当 GPIO 拉低），算最坏情况
pub fn fight_gpio(vd: f64, rd: f64) -> FaultOut {
    if vd > VDD / 2.0 {
        fight(vd, rd, 0.0, GPIO_R_LOW)
    } else {
        // 零件拉低、GPIO 推高：电流方向反过来，报绝对值
        let mut o = fight(VDD, GPIO_R_HIGH, vd, rd);
        o.i = o.i.abs();
        o
    }
}

/// GPIO 输出高电平点 LED（串 series Ω，0 = 直接接）。节点 1 = GPIO 内部，2 = 引脚，3 = LED 阳极
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
    // 没有电阻时引脚就是阳极：用一段极小电阻连上，网表结构不变
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

/// 开发板供电（与 board.rs 同参数）：节点 1 = 5V 轨，2 = 3V3，3 = 外接 5 V。元件 0 = USB，1 = LDO，2 = 3V3 负载，3 = 外接源
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
        // 3V3 短路时 USB 先顶不住，LDO 输入跟着掉、进压差区；5V 短路就是 USB 自己限流
        return if rail == Rail::V3v3 {
            Limiter::LdoDropout
        } else {
            Limiter::Usb
        };
    }
    Limiter::Resistance
}

/// 一根跳线把电源轨直接接到 GND
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

/// 5 V 模块的输出（经 src Ω）进 GPIO：电流经引脚的钳位二极管灌进 3V3 轨。节点 1 = 5V，2 = 3V3，3 = 引脚
pub fn clamp_circuit(src: f64, chip: ChipKind) -> Circuit {
    let p = Params::for_chip(chip);
    let mut c = Circuit::new(3);
    supply(&mut c, &p, false);
    // supply 里节点 3 是外接 5 V；这里借来当引脚：把那颗 1 MΩ 换成模块输出电阻 + 钳位二极管
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

    /// tools/elec 的网表和这里的构造必须是同一个电路（ngspice 对照的才是网页用的）
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
        // 电位器滑片转到头（≈ 3V3，接触 1 Ω）对上 GPIO 拉低：3.3 / (1 + 35.36)
        let o = fight_gpio(VDD, 1.0);
        assert!(near(o.i, 3.3 / 36.36, 1e-9), "{o:?}");
        assert!(o.i > 0.04, "超过 I_OH 40 mA");
        // 编码器触点闭合接地（1 Ω）对上 GPIO 推高
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
        // 折线 LED 导通后线性：(3.3 − 1.8) / (33 + 10) ≈ 34.9 mA，超过 LED 额定 20 mA
        let o = led(0.0);
        let want = (VDD - LED_VF) / (GPIO_R_HIGH + 1e-3 + LED_RD);
        assert!(near(o.i, want, 1e-9), "{o:?}");
        assert!(o.i > 0.02 && o.i < 0.04);
        // 串 220 Ω：约 5.9 mA
        let ok = led(220.0);
        assert!(near(ok.i, 1.5 / 263.0, 1e-9), "{ok:?}");
        let n = net("12-led-nores.cir");
        assert!(near(at(&n, "pin"), o.v_pin, 1e-9));
    }

    #[test]
    fn rail_shorts() {
        let p = Params::for_chip(C3);
        // 3V3 接地：USB 口限流在 0.5 A 后按 20 Ω 斜率掉压，LDO 输入跟着塌、进压差区，
        // 电流 ≈ 0.5 + (4.75 − v5)/20、v5 = I·(rdo + 0.05) + 芯片负载那点压降 → 0.7 A 左右
        let s = short(Rail::V3v3, C3);
        assert_eq!(s.limiter, Limiter::LdoDropout, "{s:?}");
        assert!(s.i > 0.6 && s.i < 0.8 && s.v5 < 1.0 && s.v33 < 0.1, "{s:?}");
        // LDO 输入电流 = 短路 + 负载（负载在 v33 < vknee 时退化成电阻）：解出的点满足 USB 源的方程
        let i_in = s.i + (p.chip_idle + p.chip_core + p.board_3v3) * s.v33 + p.ldo_iq;
        let usb = p.usb_ilim + (p.usb_v - p.usb_r * p.usb_ilim - s.v5) / p.usb_rlim;
        assert!(near(i_in, usb, 1e-6), "{i_in} {usb}");
        // 5V 接地：只剩 USB 限流，≈ 0.7375 / 1.0025
        let f = short(Rail::V5, C3);
        assert_eq!(f.limiter, Limiter::Usb);
        assert!(near(f.i, 0.7375 / (1.0 + 0.05 / 20.0), 2e-3), "{f:?}");
        // 外接 5 V 2 A 接地：适配器限流 2 A 后按 2 Ω 斜率 → 2 + (5 − 0.3 − 0.05 I)/2
        let e = short(Rail::Ext5v, C3);
        assert_eq!(e.limiter, Limiter::Ext);
        assert!(near(e.i, 4.35 / 1.025, 1e-6), "{e:?}");
        let n3 = net("13-short-3v3.cir");
        assert!(near(at(&n3, "v5"), s.v5, 1e-9) && near(at(&n3, "v33"), s.v33, 1e-9));
        let n5 = net("14-short-5v.cir");
        assert!(near(at(&n5, "v5"), f.v5, 1e-9));
        // S3 开发板（芯片电流大一点）：网页实验台上的作品多是 S3，对拍用这两份
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
        // HC-SR04 Echo 直连（5 V 推挽输出约 50 Ω）：经钳位二极管灌进 3V3，3V3 仍由 LDO 稳住
        let o = clamp(50.0, C3);
        let want = (o.v5 - o.v33 - CLAMP_VF) / (50.0 + CLAMP_RD);
        assert!(near(o.i, want, 1e-9), "{o:?}");
        assert!(o.i > 0.01 && o.v_pin > 3.6, "{o:?}");
        // 模块 10 kΩ 上拉接 5 V：只有约 0.1 mA
        let pu = clamp(10_000.0, C3);
        assert!(pu.i > 5e-5 && pu.i < 2e-4, "{pu:?}");
        let n = net("15-clamp-5v.cir");
        assert!(near(at(&n, "pin"), o.v_pin, 1e-9));
    }
}
