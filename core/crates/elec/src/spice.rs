//! 读 SPICE 网表的一个小子集，给 tools/elec 与 ngspice 对照用（`tryboard elec-net`）。
//! 支持：R / C / V（DC）/ I（DC）、`.op`、`.tran 步长 终止`，数值后缀 f p n u m k meg g。
//! 自定义元件写成以 `*tb:` 开头的注释行（ngspice 当注释跳过，它那边用等价的 B 源）：
//!   *tb: LIMIT 节点 vs r ilim rlim
//!   *tb: LDO 输入 输出 vset rout rdo ilim iq
//!   *tb: LOAD 节点 电流 vknee
//!   *tb: MOTOR 节点 vcmd emf r
//!   *tb: DIODE 阳极 阴极 vf rd
//! B 源行在这里被忽略。节点名任意，0 / gnd 是地。

use crate::mna::{Circuit, Elem};

#[derive(Debug, Default)]
pub struct Netlist {
    pub circuit: Circuit,
    /// 节点名（下标 = 节点号，0 号是地）
    pub names: Vec<String>,
    /// .tran（步长, 终止）；None = 只算直流工作点
    pub tran: Option<(f64, f64)>,
}

pub fn value(s: &str) -> Option<f64> {
    let t = s.trim().to_ascii_lowercase();
    let t = t
        .strip_prefix("dc")
        .map(|x| x.trim())
        .unwrap_or(&t)
        .to_string();
    let n = t
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e'))
        .unwrap_or(t.len());
    // "1e" 之类不能把后缀里的 e 当指数：先按最长数字前缀解析，失败就往回缩
    let (mut num, mut rest) = (&t[..n], &t[n..]);
    while !num.is_empty() && num.parse::<f64>().is_err() {
        let k = num.len() - 1;
        rest = &t[k..];
        num = &t[..k];
    }
    let base: f64 = num.parse().ok()?;
    let mul = if rest.starts_with("meg") {
        1e6
    } else {
        match rest.chars().next() {
            Some('f') => 1e-15,
            Some('p') => 1e-12,
            Some('n') => 1e-9,
            Some('u') => 1e-6,
            Some('m') => 1e-3,
            Some('k') => 1e3,
            Some('g') => 1e9,
            _ => 1.0,
        }
    };
    Some(base * mul)
}

impl Netlist {
    fn node(&mut self, name: &str) -> usize {
        let n = name.to_ascii_lowercase();
        if n == "0" || n == "gnd" {
            return 0;
        }
        if let Some(i) = self.names.iter().position(|x| *x == n) {
            return i;
        }
        self.names.push(n);
        self.names.len() - 1
    }

    pub fn parse(text: &str) -> Result<Netlist, String> {
        let mut nl = Netlist {
            names: vec!["0".into()],
            ..Default::default()
        };
        let mut elems = Vec::new();
        for (ln, raw) in text.lines().enumerate().skip(1) {
            let line = raw.trim();
            let bad = |what: &str| format!("第 {} 行：{what}：{line}", ln + 1);
            if line.is_empty() || line.starts_with('+') {
                continue;
            }
            if let Some(rest) = line.strip_prefix("*tb:") {
                let f: Vec<&str> = rest.split_whitespace().collect();
                let num = |i: usize| f.get(i).and_then(|x| value(x)).ok_or_else(|| bad("缺数值"));
                let e = match f.first().map(|s| s.to_ascii_uppercase()).as_deref() {
                    Some("LIMIT") => Elem::Limit {
                        a: nl.node(f[1]),
                        vs: num(2)?,
                        r: num(3)?,
                        ilim: num(4)?,
                        rlim: num(5)?,
                    },
                    Some("LDO") => {
                        let (inp, out) = (nl.node(f[1]), nl.node(f[2]));
                        Elem::Ldo {
                            inp,
                            out,
                            vset: num(3)?,
                            rout: num(4)?,
                            rdo: num(5)?,
                            ilim: num(6)?,
                            iq: num(7)?,
                        }
                    }
                    Some("LOAD") => Elem::Load {
                        a: nl.node(f[1]),
                        i: num(2)?,
                        vknee: num(3)?,
                    },
                    Some("MOTOR") => Elem::Motor {
                        a: nl.node(f[1]),
                        vcmd: num(2)?,
                        emf: num(3)?,
                        r: num(4)?,
                    },
                    Some("DIODE") => Elem::Diode {
                        a: nl.node(f[1]),
                        b: nl.node(f[2]),
                        vf: num(3)?,
                        rd: num(4)?,
                    },
                    _ => return Err(bad("不认识的 *tb: 元件")),
                };
                elems.push(e);
                continue;
            }
            if line.starts_with('*') {
                continue;
            }
            let f: Vec<&str> = line.split_whitespace().collect();
            let lower = f[0].to_ascii_lowercase();
            if lower == ".tran" {
                let st = f
                    .get(1)
                    .and_then(|x| value(x))
                    .ok_or_else(|| bad(".tran 步长"))?;
                let end = f
                    .get(2)
                    .and_then(|x| value(x))
                    .ok_or_else(|| bad(".tran 终止"))?;
                nl.tran = Some((st, end));
                continue;
            }
            if lower.starts_with('.') {
                continue;
            }
            let kind = lower.chars().next().unwrap_or(' ');
            if kind == 'b' {
                continue;
            }
            if f.len() < 4 {
                return Err(bad("字段不够"));
            }
            let (a, b) = (nl.node(f[1]), nl.node(f[2]));
            // V / I 的值可以写成 "DC 5"
            let vtxt = if f[3].eq_ignore_ascii_case("dc") {
                f.get(4).copied().unwrap_or("")
            } else {
                f[3]
            };
            let x = value(vtxt).ok_or_else(|| bad("数值"))?;
            elems.push(match kind {
                'r' => Elem::R { a, b, r: x },
                'c' => Elem::C { a, b, c: x },
                'v' => Elem::V { a, b, v: x, r: 0.0 },
                'i' => Elem::I { a, b, i: x },
                _ => return Err(bad("不支持的元件")),
            });
        }
        nl.circuit = Circuit {
            nodes: nl.names.len() - 1,
            elems,
        };
        Ok(nl)
    }

    /// 跑一遍：.op 返回一组电压；.tran 从全 0（电容未充电，同 ngspice `uic`）开始，返回每个时刻的电压
    pub fn run(&self, at: &[f64]) -> Vec<(f64, Vec<f64>)> {
        match self.tran {
            None => vec![(0.0, self.circuit.solve(None, &[], &[]).v)],
            Some((h, end)) => {
                let mut out = Vec::new();
                let mut v = vec![0.0; self.circuit.nodes + 1];
                let steps = (end / h).round() as usize;
                let mut want: Vec<f64> = if at.is_empty() {
                    vec![end]
                } else {
                    at.to_vec()
                };
                want.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let mut wi = 0;
                for k in 1..=steps {
                    v = self.circuit.solve(Some(h), &v, &v).v;
                    let t = k as f64 * h;
                    while wi < want.len() && want[wi] <= t + h * 1e-6 {
                        out.push((want[wi], v.clone()));
                        wi += 1;
                    }
                }
                out
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values() {
        let near = |s: &str, x: f64| (value(s).unwrap() - x).abs() <= x.abs() * 1e-12;
        assert!(near("4.7k", 4700.0) && near("10u", 10e-6) && near("1meg", 1e6));
        assert!(near("2.5", 2.5) && near("1e-3", 1e-3) && near("100m", 0.1) && near("DC 5", 5.0));
    }

    #[test]
    fn parse_divider() {
        let nl = Netlist::parse("title\nV1 in 0 DC 9\nR1 in mid 1k\nR2 mid 0 2k\n*tb: LOAD mid 1m 0.5\nB1 mid 0 I=1m\n.op\n.end\n").unwrap();
        let r = nl.run(&[]);
        let mid = nl.names.iter().position(|x| x == "mid").unwrap();
        // 9 V 经 1k/2k 分压 6 V，再被 1 mA 拉低 1k∥2k = 0.667 V
        assert!((r[0].1[mid] - (6.0 - 2.0 / 3.0)).abs() < 1e-6, "{:?}", r);
    }
}
