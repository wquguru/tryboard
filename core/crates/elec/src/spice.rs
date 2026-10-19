//! Tiny SPICE subset for the tools/elec ngspice comparison (`tryboard elec-net`): R / C / V (DC) / I (DC), `.op`,
//! `.tran step stop`, suffixes f p n u m k meg g. Custom parts are `*tb:` comment lines (ngspice skips them and uses
//! equivalent B sources, which we ignore). Syntax table (lint: allow-long-comment):
//!   *tb: LIMIT node vs r ilim rlim | LDO in out vset rout rdo ilim iq | LOAD node i vknee
//!   *tb: MOTOR node vcmd emf r | DIODE anode cathode vf rd
//! Node names are free-form; 0 / gnd is ground.

use crate::mna::{Circuit, Elem};

#[derive(Debug, Default)]
pub struct Netlist {
    pub circuit: Circuit,
    /// Node names (index = node number, 0 is ground)
    pub names: Vec<String>,
    /// .tran (step, stop); None = DC operating point only
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
    // Don't read a suffix like "1e" as an exponent: parse the longest numeric prefix and shrink it until it parses
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
            let bad = |what: &str| format!("line {}: {what}: {line}", ln + 1);
            if line.is_empty() || line.starts_with('+') {
                continue;
            }
            if let Some(rest) = line.strip_prefix("*tb:") {
                let f: Vec<&str> = rest.split_whitespace().collect();
                let num = |i: usize| {
                    f.get(i)
                        .and_then(|x| value(x))
                        .ok_or_else(|| bad("missing value"))
                };
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
                    _ => return Err(bad("unknown *tb: part")),
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
                    .ok_or_else(|| bad(".tran step"))?;
                let end = f
                    .get(2)
                    .and_then(|x| value(x))
                    .ok_or_else(|| bad(".tran stop"))?;
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
                return Err(bad("too few fields"));
            }
            let (a, b) = (nl.node(f[1]), nl.node(f[2]));
            // V / I values may be written as "DC 5"
            let vtxt = if f[3].eq_ignore_ascii_case("dc") {
                f.get(4).copied().unwrap_or("")
            } else {
                f[3]
            };
            let x = value(vtxt).ok_or_else(|| bad("value"))?;
            elems.push(match kind {
                'r' => Elem::R { a, b, r: x },
                'c' => Elem::C { a, b, c: x },
                'v' => Elem::V { a, b, v: x, r: 0.0 },
                'i' => Elem::I { a, b, i: x },
                _ => return Err(bad("unsupported part")),
            });
        }
        nl.circuit = Circuit {
            nodes: nl.names.len() - 1,
            elems,
        };
        Ok(nl)
    }

    /// .op returns one voltage set; .tran starts from all-zero (uncharged caps, like ngspice `uic`) and returns each requested time
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
        // 9 V through 1k/2k divides to 6 V; the 1 mA load pulls it down by 1k||2k = 0.667 V
        assert!((r[0].1[mid] - (6.0 - 2.0 / 3.0)).abs() < 1e-6, "{:?}", r);
    }
}
