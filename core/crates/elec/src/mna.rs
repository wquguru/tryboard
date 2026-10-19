//! Modified nodal analysis (MNA) + implicit Euler; a handful of nodes, so dense LU with partial pivoting is enough.
//! Non-linear parts are piecewise linear (max(0, min(lines))), solved without derivatives or step control so web and CLI match bit for bit.

/// Node number: 0 is ground
pub type Node = usize;

#[derive(Clone, Debug, PartialEq)]
pub enum Elem {
    /// Resistor
    R { a: Node, b: Node, r: f64 },
    /// Capacitor (backward-Euler companion model in transient; open at the DC operating point)
    C { a: Node, b: Node, c: f64 },
    /// Voltage source v(a) - v(b) = v; r > 0 is a source with internal resistance (Norton), r = 0 is ideal (MNA extra variable)
    V { a: Node, b: Node, v: f64, r: f64 },
    /// Current source, SPICE convention: current flows from a through the source to b (out of node a, into node b)
    I { a: Node, b: Node, i: f64 },
    /// Current-limited source (USB port, adapter) between a and ground: i = max(0, min((vs - v)/r, ilim + (vs - r*ilim - v)/rlim));
    /// above ilim the resistance goes from r to rlim (the limit switch enters constant-current mode)
    Limit {
        a: Node,
        vs: f64,
        r: f64,
        ilim: f64,
        rlim: f64,
    },
    /// Linear regulator: iout = max(0, min((vset - vout)/rout, (vin - vout)/rdo, ilim)); iin = iout + iq.
    /// The three segments are regulation, dropout (pass device fully on, rdo) and current limit
    Ldo {
        inp: Node,
        out: Node,
        vset: f64,
        rout: f64,
        rdo: f64,
        ilim: f64,
        iq: f64,
    },
    /// Constant-current load (a to ground): i = min(i, v*i/vknee); below vknee it degrades to a resistor so it can't pull the node negative
    Load { a: Node, i: f64, vknee: f64 },
    /// Servo motor supply current (a to ground): i = max(0, (min(v, vcmd) - emf)/r); vcmd = controller voltage (Kp*err,
    /// capped at supply), emf = back-EMF including direction sign
    Motor {
        a: Node,
        vcmd: f64,
        emf: f64,
        r: f64,
    },
    /// Diode (LED, pin clamp), a = anode: i = max(0, (v(a) - v(b) - vf)/rd). One linear piece instead of the exponential;
    /// accurate only near mA to tens of mA, enough to tell how much current a miswired part draws
    Diode { a: Node, b: Node, vf: f64, rd: f64 },
}

/// One PWL segment: I = g*(v_a) + c (when it depends on one node voltage)
#[derive(Clone, Copy, Debug)]
struct Seg {
    g: f64,
    c: f64,
}

/// Result: node voltages (index = node number, 0 is always 0) and element currents (positive out of the first node)
#[derive(Clone, Debug, Default)]
pub struct Solution {
    pub v: Vec<f64>,
    pub i: Vec<f64>,
    /// PWL iteration count
    pub iters: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Circuit {
    pub nodes: usize,
    pub elems: Vec<Elem>,
}

impl Circuit {
    pub fn new(nodes: usize) -> Circuit {
        Circuit {
            nodes,
            elems: Vec::new(),
        }
    }

    pub fn add(&mut self, e: Elem) -> usize {
        self.elems.push(e);
        self.elems.len() - 1
    }

    /// dt = None solves the DC operating point (caps open); Some(h) is one implicit Euler step from node voltages prev.
    /// guess seeds the PWL segment choice (usually the previous result)
    pub fn solve(&self, dt: Option<f64>, prev: &[f64], guess: &[f64]) -> Solution {
        let n = self.nodes;
        let dim = n + self.n_ideal();
        // Unknowns x = [voltages of nodes 1..n, ideal voltage source branch currents]
        let mut x: Vec<f64> = (0..dim)
            .map(|k| {
                if k < n {
                    guess.get(k + 1).copied().unwrap_or(0.0)
                } else {
                    0.0
                }
            })
            .collect();
        let volts = |x: &[f64]| {
            let mut v = vec![0.0; n + 1];
            v[1..=n].copy_from_slice(&x[..n]);
            v
        };
        let mut iters = 0;
        // Katzenelson: linearise in the current segments and solve; if the solution stays in them it is exact, otherwise walk to the
        // first segment boundary (bisection) and re-solve. One boundary per round: no Newton ping-pong, no runaway on floating nodes
        while iters < 200 {
            iters += 1;
            let segs = self.pick(&volts(&x));
            let (mut a, mut z) = self.system(dt, prev, &segs);
            let xn = lu_solve(&mut a, &mut z, dim);
            if self.pick(&volts(&xn)) == segs {
                x = xn;
                break;
            }
            let at = |lam: f64| -> Vec<f64> {
                x.iter().zip(&xn).map(|(p, q)| p + lam * (q - p)).collect()
            };
            let (mut lo, mut hi) = (0.0f64, 1.0f64);
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                if self.pick(&volts(&at(mid))) == segs {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            x = at(hi);
        }
        let v = volts(&x);
        let i = self.currents(&v, dt, prev);
        Solution { v, i, iters }
    }

    fn n_ideal(&self) -> usize {
        self.elems
            .iter()
            .filter(|e| matches!(e, Elem::V { r, .. } if *r == 0.0))
            .count()
    }

    /// Segment index of each non-linear element at these voltages, used to detect convergence
    fn pick(&self, v: &[f64]) -> Vec<u8> {
        self.elems.iter().map(|e| pwl(e, v).0).collect()
    }

    /// Build the linear system a*x = z for the given segments (a is row-major)
    fn system(&self, dt: Option<f64>, prev: &[f64], segs: &[u8]) -> (Vec<f64>, Vec<f64>) {
        let n = self.nodes;
        // Each ideal voltage source adds one variable (its branch current)
        let dim = n + self.n_ideal();
        let mut a = vec![0.0; dim * dim];
        let mut z = vec![0.0; dim];
        // Node k (1..=n) maps to row / column k-1; ground is not in the matrix
        let idx = |k: Node| if k == 0 { None } else { Some(k - 1) };
        let stamp_g = |a: &mut Vec<f64>, p: Node, q: Node, g: f64| {
            if let Some(i) = idx(p) {
                a[i * dim + i] += g;
            }
            if let Some(j) = idx(q) {
                a[j * dim + j] += g;
            }
            if let (Some(i), Some(j)) = (idx(p), idx(q)) {
                a[i * dim + j] -= g;
                a[j * dim + i] -= g;
            }
        };
        // Current i flows out of node p into node q
        let inject = |z: &mut Vec<f64>, p: Node, q: Node, i: f64| {
            if let Some(k) = idx(p) {
                z[k] -= i;
            }
            if let Some(k) = idx(q) {
                z[k] += i;
            }
        };
        let mut vk = n;
        for (e, &s) in self.elems.iter().zip(segs) {
            match *e {
                Elem::R { a: p, b: q, r } => stamp_g(&mut a, p, q, 1.0 / r),
                Elem::C { a: p, b: q, c } => {
                    if let Some(h) = dt {
                        let g = c / h;
                        stamp_g(&mut a, p, q, g);
                        let vp = prev.get(p).copied().unwrap_or(0.0)
                            - prev.get(q).copied().unwrap_or(0.0);
                        // Companion model: i = g*(v - vprev); the constant -g*vprev out of p is an injection of g*vprev into p
                        inject(&mut z, q, p, g * vp);
                    }
                }
                Elem::V {
                    a: p,
                    b: q,
                    v: vs,
                    r,
                } => {
                    if r > 0.0 {
                        let g = 1.0 / r;
                        stamp_g(&mut a, p, q, g);
                        inject(&mut z, q, p, vs * g);
                    } else {
                        // Extra row: v(p) - v(q) = vs; branch current j flows into the p terminal (SPICE convention)
                        if let Some(i) = idx(p) {
                            a[i * dim + vk] += 1.0;
                            a[vk * dim + i] += 1.0;
                        }
                        if let Some(j) = idx(q) {
                            a[j * dim + vk] -= 1.0;
                            a[vk * dim + j] -= 1.0;
                        }
                        z[vk] = vs;
                        vk += 1;
                    }
                }
                Elem::I { a: p, b: q, i } => inject(&mut z, p, q, i),
                Elem::Diode { a: p, b: q, vf, rd } => {
                    // Conducting segment: I = (v(p) - v(q))/rd - vf/rd; the constant term is a current source from p to q
                    if s == 1 {
                        stamp_g(&mut a, p, q, 1.0 / rd);
                        inject(&mut z, p, q, -vf / rd);
                    }
                }
                Elem::Limit { a: p, .. } | Elem::Load { a: p, .. } | Elem::Motor { a: p, .. } => {
                    // Single-node PWL: current from p to ground = g*v(p) + c (Limit is a source, already negated in pwl)
                    let sg = seg1(e, s);
                    stamp_g(&mut a, p, 0, sg.g);
                    inject(&mut z, p, 0, sg.c);
                }
                Elem::Ldo {
                    inp,
                    out,
                    vset,
                    rout,
                    rdo,
                    ilim,
                    iq,
                } => {
                    // Output current io flows into out, input current io + iq out of inp; regulation io = (vset - vout)/rout,
                    // dropout io = (vin - vout)/rdo, limit io = ilim, off io = 0
                    let (gi, go, c) = match s {
                        1 => (0.0, -1.0 / rout, vset / rout),
                        2 => (1.0 / rdo, -1.0 / rdo, 0.0),
                        3 => (0.0, 0.0, ilim),
                        _ => (0.0, 0.0, 0.0),
                    };
                    // io = gi*vin + go*vout + c. KCL at out: outflow -io -> row out gets -gi*vin - go*vout, rhs +c;
                    // KCL at inp: outflow io + iq -> row inp gets gi*vin + go*vout, rhs -c - iq
                    let (ii, oo) = (idx(inp), idx(out));
                    if let Some(o) = oo {
                        if let Some(i) = ii {
                            a[o * dim + i] -= gi;
                        }
                        a[o * dim + o] -= go;
                        z[o] += c;
                    }
                    if let Some(i) = ii {
                        a[i * dim + i] += gi;
                        if let Some(o) = oo {
                            a[i * dim + o] += go;
                        }
                        z[i] -= c + if s == 0 { 0.0 } else { iq };
                    }
                }
            }
        }
        // A floating node (no DC path) gets a tiny conductance so the matrix is not singular
        for k in 0..n {
            a[k * dim + k] += 1e-12;
        }
        (a, z)
    }

    /// Element currents (positive out of the first node; sources and LDO report output current)
    fn currents(&self, v: &[f64], dt: Option<f64>, prev: &[f64]) -> Vec<f64> {
        let at = |k: Node| v.get(k).copied().unwrap_or(0.0);
        let pv = |k: Node| prev.get(k).copied().unwrap_or(0.0);
        self.elems
            .iter()
            .map(|e| match *e {
                Elem::R { a, b, r } => (at(a) - at(b)) / r,
                Elem::C { a, b, c } => dt
                    .map(|h| c / h * ((at(a) - at(b)) - (pv(a) - pv(b))))
                    .unwrap_or(0.0),
                Elem::V { a, b, v: vs, r } => {
                    if r > 0.0 {
                        // Current the source delivers to the outside (out of terminal a)
                        (vs - (at(a) - at(b))) / r
                    } else {
                        f64::NAN
                    }
                }
                Elem::I { i, .. } => i,
                Elem::Limit { .. } | Elem::Load { .. } | Elem::Motor { .. } => {
                    let (_, i) = pwl(e, v);
                    i
                }
                Elem::Ldo { .. } | Elem::Diode { .. } => pwl(e, v).1,
            })
            .collect()
    }
}

/// Segment and current of an element at voltage v; Limit / Ldo return output current, Load / Motor absorbed current
fn pwl(e: &Elem, v: &[f64]) -> (u8, f64) {
    let at = |k: Node| v.get(k).copied().unwrap_or(0.0);
    match *e {
        Elem::Limit {
            a,
            vs,
            r,
            ilim,
            rlim,
        } => {
            let x = at(a);
            let i1 = (vs - x) / r;
            let i2 = ilim + (vs - r * ilim - x) / rlim;
            if i1.min(i2) < 0.0 {
                (0, 0.0)
            } else if i1 <= i2 {
                (1, i1)
            } else {
                (2, i2)
            }
        }
        Elem::Ldo {
            inp,
            out,
            vset,
            rout,
            rdo,
            ilim,
            ..
        } => {
            let (vi, vo) = (at(inp), at(out));
            let reg = (vset - vo) / rout;
            let dro = (vi - vo) / rdo;
            let m = reg.min(dro).min(ilim);
            // Exactly 0 (guess right at the set point) counts as regulation, otherwise the output node looks floating
            if m < 0.0 {
                (0, 0.0)
            } else if m == reg {
                (1, reg)
            } else if m == dro {
                (2, dro)
            } else {
                (3, ilim)
            }
        }
        Elem::Load { a, i, vknee } => {
            let x = at(a);
            if x <= 0.0 || i <= 0.0 {
                (0, 0.0)
            } else if x < vknee {
                (1, x * i / vknee)
            } else {
                (2, i)
            }
        }
        Elem::Motor { a, vcmd, emf, r } => {
            let x = at(a);
            let i_sat = (x - emf) / r;
            let i_lin = (vcmd - emf) / r;
            let m = i_sat.min(i_lin);
            if m <= 0.0 {
                (0, 0.0)
            } else if i_sat <= i_lin {
                (1, i_sat)
            } else {
                (2, i_lin)
            }
        }
        Elem::Diode { a, b, vf, rd } => {
            let x = at(a) - at(b) - vf;
            if x <= 0.0 {
                (0, 0.0)
            } else {
                (1, x / rd)
            }
        }
        _ => (0, 0.0),
    }
}

/// Linearisation of a single-node PWL element in segment s: current from node to ground = g*v + c
fn seg1(e: &Elem, s: u8) -> Seg {
    match *e {
        // Source: output i1 = (vs - v)/r -> to ground = -i1 = v/r - vs/r
        Elem::Limit {
            vs, r, ilim, rlim, ..
        } => match s {
            1 => Seg {
                g: 1.0 / r,
                c: -vs / r,
            },
            2 => Seg {
                g: 1.0 / rlim,
                c: -(ilim + (vs - r * ilim) / rlim),
            },
            _ => Seg { g: 0.0, c: 0.0 },
        },
        Elem::Load { i, vknee, .. } => match s {
            1 => Seg {
                g: i / vknee,
                c: 0.0,
            },
            2 => Seg { g: 0.0, c: i },
            _ => Seg { g: 0.0, c: 0.0 },
        },
        Elem::Motor { vcmd, emf, r, .. } => match s {
            1 => Seg {
                g: 1.0 / r,
                c: -emf / r,
            },
            2 => Seg {
                g: 0.0,
                c: (vcmd - emf) / r,
            },
            _ => Seg { g: 0.0, c: 0.0 },
        },
        _ => Seg { g: 0.0, c: 0.0 },
    }
}

/// Dense LU with partial pivoting for a*x = z; a is row-major dim x dim and both a and z are overwritten
pub fn lu_solve(a: &mut [f64], z: &mut [f64], dim: usize) -> Vec<f64> {
    let mut perm: Vec<usize> = (0..dim).collect();
    for k in 0..dim {
        // Pick the pivot
        let mut p = k;
        let mut best = a[perm[k] * dim + k].abs();
        for (i, &row) in perm.iter().enumerate().skip(k + 1) {
            let x = a[row * dim + k].abs();
            if x > best {
                best = x;
                p = i;
            }
        }
        perm.swap(k, p);
        let pk = perm[k];
        let piv = a[pk * dim + k];
        if piv == 0.0 {
            continue;
        }
        for &row in perm.iter().skip(k + 1) {
            let f = a[row * dim + k] / piv;
            if f == 0.0 {
                continue;
            }
            a[row * dim + k] = f;
            for j in k + 1..dim {
                a[row * dim + j] -= f * a[pk * dim + j];
            }
            z[row] -= f * z[pk];
        }
    }
    let mut x = vec![0.0; dim];
    for k in (0..dim).rev() {
        let row = perm[k];
        let mut s = z[row];
        for j in k + 1..dim {
            s -= a[row * dim + j] * x[j];
        }
        let d = a[row * dim + k];
        x[k] = if d == 0.0 { 0.0 } else { s / d };
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn divider_and_ideal_source() {
        let mut c = Circuit::new(2);
        c.add(Elem::V {
            a: 1,
            b: 0,
            v: 10.0,
            r: 0.0,
        });
        c.add(Elem::R {
            a: 1,
            b: 2,
            r: 1000.0,
        });
        c.add(Elem::R {
            a: 2,
            b: 0,
            r: 3000.0,
        });
        let s = c.solve(None, &[], &[]);
        assert!((s.v[2] - 7.5).abs() < 1e-6);
    }

    #[test]
    fn lu_needs_pivoting() {
        // The first column's pivot is 0
        let mut a = vec![0.0, 1.0, 1.0, 1.0];
        let mut z = vec![2.0, 3.0];
        let x = lu_solve(&mut a, &mut z, 2);
        assert!((x[0] - 1.0).abs() < 1e-12 && (x[1] - 2.0).abs() < 1e-12);
    }

    #[test]
    fn rc_charge_implicit_euler() {
        // 1 kohm / 1 uF, tau = 1 ms; 1 us steps for 1 ms should approach 1 - e^-1
        let mut c = Circuit::new(2);
        c.add(Elem::V {
            a: 1,
            b: 0,
            v: 1.0,
            r: 0.0,
        });
        c.add(Elem::R {
            a: 1,
            b: 2,
            r: 1000.0,
        });
        c.add(Elem::C {
            a: 2,
            b: 0,
            c: 1e-6,
        });
        let mut v = vec![0.0; 3];
        for _ in 0..1000 {
            v = c.solve(Some(1e-6), &v, &v).v;
        }
        assert!((v[2] - (1.0 - (-1.0f64).exp())).abs() < 1e-3, "{}", v[2]);
    }

    #[test]
    fn usb_limit_and_ldo_dropout() {
        // 5 V / 0.5 ohm / 0.5 A limit into 4 ohm: unlimited would need 1.11 A, so it lands in the rlim segment
        let mut c = Circuit::new(1);
        let src = c.add(Elem::Limit {
            a: 1,
            vs: 5.0,
            r: 0.5,
            ilim: 0.5,
            rlim: 20.0,
        });
        c.add(Elem::R { a: 1, b: 0, r: 4.0 });
        let s = c.solve(None, &[], &[0.0, 5.0]);
        // v = 4i, i = 0.5 + (4.75 - v)/20 -> i = 0.5 + (4.75 - 4i)/20 -> 1.2 i = 0.7375
        let i = 0.7375 / 1.2;
        assert!((s.i[src] - i).abs() < 1e-6, "{} vs {i}", s.i[src]);
        // LDO: 3.4 V input lands in dropout
        let mut c = Circuit::new(2);
        c.add(Elem::V {
            a: 1,
            b: 0,
            v: 3.4,
            r: 0.0,
        });
        let l = c.add(Elem::Ldo {
            inp: 1,
            out: 2,
            vset: 3.3,
            rout: 0.01,
            rdo: 0.5,
            ilim: 1.0,
            iq: 0.0,
        });
        c.add(Elem::Load {
            a: 2,
            i: 0.5,
            vknee: 1.0,
        });
        let s = c.solve(None, &[], &[0.0, 3.4, 3.3]);
        assert!(
            (s.v[2] - 3.15).abs() < 1e-6 && (s.i[l] - 0.5).abs() < 1e-6,
            "{:?}",
            s.v
        );
        // 5 V input regulates
        let mut c2 = c.clone();
        c2.elems[0] = Elem::V {
            a: 1,
            b: 0,
            v: 5.0,
            r: 0.0,
        };
        let s = c2.solve(None, &[], &[0.0, 5.0, 3.3]);
        assert!((s.v[2] - 3.295).abs() < 1e-6, "{:?}", s.v);
    }
}
