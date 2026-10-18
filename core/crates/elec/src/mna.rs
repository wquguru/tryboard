//! 修正节点分析（MNA）+ 隐式欧拉。节点只有个位数，稠密 LU（部分主元）足够。
//!
//! 非线性元件都写成分段线性（PWL）：电流 = max(0, min(若干条直线))。每次求解先按上一次的电压选定每个元件
//! 落在哪一段，线性化后解一次，再按新电压重选，段不再变化就收敛（PWL 上的牛顿法，通常 2–4 次）。
//! 这样不需要导数、不需要步长控制，结果只取决于输入，网页和命令行逐位相同。

/// 节点编号：0 是地
pub type Node = usize;

#[derive(Clone, Debug, PartialEq)]
pub enum Elem {
    /// 电阻
    R { a: Node, b: Node, r: f64 },
    /// 电容（瞬态用后向欧拉伴随模型；直流工作点时开路）
    C { a: Node, b: Node, c: f64 },
    /// 电压源 v(a) − v(b) = v。r > 0 时是带内阻的源（诺顿等效），r = 0 是理想源（MNA 附加变量）
    V { a: Node, b: Node, v: f64, r: f64 },
    /// 电流源：SPICE 约定，电流从 a 经源流到 b（从节点 a 流出、流入节点 b）
    I { a: Node, b: Node, i: f64 },
    /// 带限流的源（USB 口、电源适配器），接在节点 a 与地之间：
    /// 电流 = max(0, min((vs − v)/r, ilim + (vs − r·ilim − v)/rlim))，超过 ilim 后内阻从 r 变成 rlim（限流开关进恒流区）
    Limit {
        a: Node,
        vs: f64,
        r: f64,
        ilim: f64,
        rlim: f64,
    },
    /// 线性稳压器：输出电流 = max(0, min((vset − vout)/rout, (vin − vout)/rdo, ilim))；输入电流 = 输出电流 + iq
    /// 三段分别是稳压、压差（调整管全开，等效 rdo）、限流
    Ldo {
        inp: Node,
        out: Node,
        vset: f64,
        rout: f64,
        rdo: f64,
        ilim: f64,
        iq: f64,
    },
    /// 恒流负载（节点 a 到地）：电流 = min(i, v·i/vknee)，电压低于 vknee 时退化成电阻，免得把节点拉成负压
    Load { a: Node, i: f64, vknee: f64 },
    /// 舵机电机从电源取的电流（节点 a 到地）：电流 = max(0, (min(v, vcmd) − emf)/r)。
    /// vcmd = 控制器想加的电压（比例控制 Kp·误差，最多到电源电压），emf = 反电动势（含方向符号）
    Motor {
        a: Node,
        vcmd: f64,
        emf: f64,
        r: f64,
    },
    /// 二极管（LED、引脚钳位二极管），a 是阳极：电流 = max(0, (v(a) − v(b) − vf)/rd)。
    /// 一段折线代替指数曲线：只在工作电流附近（mA–几十 mA）准，够算"接错线会流多大电流"
    Diode { a: Node, b: Node, vf: f64, rd: f64 },
}

/// 一条 PWL 段：I = g·(v_a) + c（只依赖一个节点电压时）
#[derive(Clone, Copy, Debug)]
struct Seg {
    g: f64,
    c: f64,
}

/// 求解结果：各节点电压（下标 = 节点号，0 号恒为 0）、各元件电流（流出第一个节点为正）
#[derive(Clone, Debug, Default)]
pub struct Solution {
    pub v: Vec<f64>,
    pub i: Vec<f64>,
    /// PWL 迭代次数
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

    /// 求一次：dt = None 是直流工作点（电容开路）；dt = Some(h) 是隐式欧拉一步，prev 是上一步的节点电压。
    /// guess 是 PWL 选段的初始电压（通常用上一步的结果）
    pub fn solve(&self, dt: Option<f64>, prev: &[f64], guess: &[f64]) -> Solution {
        let n = self.nodes;
        let dim = n + self.n_ideal();
        // 未知量 x = [节点 1..n 的电压, 理想电压源支路电流]
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
        // Katzenelson 法（分段线性网络的经典解法）：在当前段线性化 → 解线性方程；解落在同一组段里就是精确解。
        // 否则沿"当前点 → 线性解"这条线段走到第一个段边界（二分找），换段再解。每轮只跨一个边界，
        // 不会像普通牛顿那样在段之间来回跳，也不会被浮空节点的超大线性解带跑（只走到边界为止）
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

    /// 按电压选每个非线性元件所在的段（编号），用于判断收敛
    fn pick(&self, v: &[f64]) -> Vec<u8> {
        self.elems.iter().map(|e| pwl(e, v).0).collect()
    }

    /// 在给定的段上组线性方程 a·x = z（a 按行存放）
    fn system(&self, dt: Option<f64>, prev: &[f64], segs: &[u8]) -> (Vec<f64>, Vec<f64>) {
        let n = self.nodes;
        // 理想电压源各占一个附加变量（支路电流）
        let dim = n + self.n_ideal();
        let mut a = vec![0.0; dim * dim];
        let mut z = vec![0.0; dim];
        // 节点 k（1..=n）对应行 / 列 k-1；地不进矩阵
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
        // 电流 i 从节点 p 流出、流进节点 q
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
                        // 伴随模型：电流 = g·(v − vprev)，常数项 −g·vprev 从 p 流出 → 等效往 p 注入 g·vprev
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
                        // 附加行：v(p) − v(q) = vs；支路电流 j 从 p 经源内部流到 q 的反方向（SPICE：流进 p 端）
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
                    // 导通段：I = (v(p) − v(q))/rd − vf/rd，常数项当作从 p 流到 q 的电流源
                    if s == 1 {
                        stamp_g(&mut a, p, q, 1.0 / rd);
                        inject(&mut z, p, q, -vf / rd);
                    }
                }
                Elem::Limit { a: p, .. } | Elem::Load { a: p, .. } | Elem::Motor { a: p, .. } => {
                    // 单节点 PWL：电流从 p 流到地 = g·v(p) + c（Limit 是电源，pwl 里已经取了负号）
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
                    // 输出电流 io（流进 out），输入电流 io + iq（从 inp 流出）
                    // 稳压段 io = (vset − vout)/rout；压差段 io = (vin − vout)/rdo；限流段 io = ilim；关断 io = 0
                    let (gi, go, c) = match s {
                        1 => (0.0, -1.0 / rout, vset / rout),
                        2 => (1.0 / rdo, -1.0 / rdo, 0.0),
                        3 => (0.0, 0.0, ilim),
                        _ => (0.0, 0.0, 0.0),
                    };
                    // io = gi·vin + go·vout + c
                    // 节点 out 的 KCL：流出 = −io → 行 out 加 −gi·vin − go·vout，右边 +c
                    // 节点 inp 的 KCL：流出 = io + iq → 行 inp 加 gi·vin + go·vout，右边 −c − iq
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
        // 浮空节点（没有任何直流通路）给一个极小电导，矩阵才不奇异
        for k in 0..n {
            a[k * dim + k] += 1e-12;
        }
        (a, z)
    }

    /// 各元件电流（从第一个节点流出为正；电源、LDO 给的是输出电流）
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
                        // 源对外输出的电流（从 a 端流出到外电路）
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

/// 元件在电压 v 下所在的段与电流。Limit / Ldo 返回对外输出的电流，Load / Motor 返回吸收的电流
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
            // 正好为 0（猜测值恰在稳压点上）算稳压段，否则输出节点会被当成浮空
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

/// 单节点 PWL 元件在第 s 段的线性化：从节点流到地的电流 = g·v + c
fn seg1(e: &Elem, s: u8) -> Seg {
    match *e {
        // 电源：输出电流 i1 = (vs − v)/r → 流到地 = −i1 = v/r − vs/r
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

/// 稠密 LU（部分主元）解 a·x = z，a 按行存放、dim × dim；会改写 a、z
pub fn lu_solve(a: &mut [f64], z: &mut [f64], dim: usize) -> Vec<f64> {
    let mut perm: Vec<usize> = (0..dim).collect();
    for k in 0..dim {
        // 选主元
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
        // 第一列主元为 0
        let mut a = vec![0.0, 1.0, 1.0, 1.0];
        let mut z = vec![2.0, 3.0];
        let x = lu_solve(&mut a, &mut z, 2);
        assert!((x[0] - 1.0).abs() < 1e-12 && (x[1] - 2.0).abs() < 1e-12);
    }

    #[test]
    fn rc_charge_implicit_euler() {
        // 1 kΩ / 1 µF，τ = 1 ms；1 µs 步长跑 1 ms，应接近 1 − e⁻¹
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
        // 5 V / 0.5 Ω / 0.5 A 限流，接 4 Ω：不限流时要 1.11 A，限流后进 rlim 段
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
        // v = 4·i，i = 0.5 + (4.75 − v)/20 → i = 0.5 + (4.75 − 4i)/20 → 1.2 i = 0.7375
        let i = 0.7375 / 1.2;
        assert!((s.i[src] - i).abs() < 1e-6, "{} vs {i}", s.i[src]);
        // LDO：输入 3.4 V 时进压差段
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
        // 输入 5 V 时稳压
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
