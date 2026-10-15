//! 单精度 FPU（协处理器 0，受 CPENABLE 位 0 门控）。
//!
//! 舍入：FCR[1:0] = 0 就近偶数 / 1 向零 / 2 向 +∞ / 3 向 −∞。为了在任意舍入模式下都精确，
//! 运算先在 f64 里做"精确值 = hi + lo"（乘积在 f64 里精确，加法用 TwoSum 取回误差），再一次性舍入到 f32。
//! FSR 的异常标志不维护（读写只保存值）。NaN 结果统一为默认 NaN（与 QEMU 对照确认，见 tools/xtensa-tests）。
//!
//! 除法 / 开方由 libgcc 的 __divsf3、libm 的 sqrtf 用 DIV0 / NEXP01 / MKDADJ / ADDEXP / DIVN 等
//! "分步指令"组合实现；这些指令的语义按 Xtensa ISA 手册的描述实现，并逐条与 QEMU 做黑盒对照。

use crate::{cause, sr, Bus, Cpu, Exit, Flow};

/// FCR 可写位：RM[1:0]、异常使能 [6:2]
pub const FCR_MASK: u32 = 0x7f;
/// FSR 可写位：异常标志 [11:7]
pub const FSR_MASK: u32 = 0xf80;

pub fn is_fp_ur(n: u32) -> bool {
    n == sr::UR_FCR || n == sr::UR_FSR
}

/// 默认（规范）NaN
pub const DEFAULT_NAN: u32 = 0x7fc0_0000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rm {
    Nearest,
    Zero,
    Up,
    Down,
}

impl Rm {
    fn from_fcr(fcr: u32) -> Rm {
        match fcr & 3 {
            0 => Rm::Nearest,
            1 => Rm::Zero,
            2 => Rm::Up,
            _ => Rm::Down,
        }
    }
}

#[inline]
fn f(b: u32) -> f32 {
    f32::from_bits(b)
}

pub fn next_up(x: f32) -> f32 {
    let b = x.to_bits();
    if x.is_nan() || x == f32::INFINITY {
        return x;
    }
    if x == 0.0 {
        return f32::from_bits(1);
    }
    f32::from_bits(if b >> 31 == 0 { b + 1 } else { b - 1 })
}

pub fn next_down(x: f32) -> f32 {
    -next_up(-x)
}

/// TwoSum：hi + lo 精确等于 a + b（不溢出时）
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    if !s.is_finite() {
        return (s, 0.0);
    }
    let bb = s - a;
    let err = (a - (s - bb)) + (b - bb);
    (s, err)
}

/// 把精确值 hi + lo（|lo| ≤ hi 的 f64 半 ulp）按 rm 舍入成 f32
pub fn round_exact(hi: f64, lo: f64, rm: Rm) -> f32 {
    if hi.is_nan() {
        return f(DEFAULT_NAN);
    }
    if hi.is_infinite() {
        return hi as f32;
    }
    let r0 = hi as f32; // 就近偶数
    if r0.is_infinite() {
        // 溢出：向零 / 背离方向时给最大有限值
        let pos = hi > 0.0;
        return match (rm, pos) {
            (Rm::Nearest, _) => r0,
            (Rm::Zero, true) | (Rm::Down, true) => f32::MAX,
            (Rm::Zero, false) | (Rm::Up, false) => -f32::MAX,
            _ => r0,
        };
    }
    let d = r0 as f64 - hi; // 精确
    // 精确值相对 r0 的方向：>0 表示精确值比 r0 大
    let dir = if d != 0.0 {
        if d < 0.0 {
            1
        } else {
            -1
        }
    } else if lo > 0.0 {
        1
    } else if lo < 0.0 {
        -1
    } else {
        0
    };
    if dir == 0 {
        return r0;
    }
    match rm {
        Rm::Nearest => {
            // 只有 hi 正好落在两个 f32 中点、lo 又非零时，第一次舍入可能选错
            if d != 0.0 && lo != 0.0 {
                let other = if d > 0.0 { next_down(r0) } else { next_up(r0) };
                if other as f64 - hi == -d {
                    // hi 是中点：按 lo 的方向选
                    return if (lo > 0.0) == (other > r0) { other } else { r0 };
                }
            }
            r0
        }
        Rm::Zero => {
            let away = (r0 > 0.0 && dir < 0) || (r0 < 0.0 && dir > 0);
            if away {
                if r0 > 0.0 {
                    next_down(r0)
                } else {
                    next_up(r0)
                }
            } else if r0 == 0.0 {
                // 精确值是极小的非零数但 RNE 舍成了 0：向零仍是 0（保留符号）
                r0
            } else {
                r0
            }
        }
        Rm::Up => {
            if dir > 0 {
                next_up(r0)
            } else {
                r0
            }
        }
        Rm::Down => {
            if dir < 0 {
                next_down(r0)
            } else {
                r0
            }
        }
    }
}

/// 结果为精确 0 时的符号（IEEE 754：异号相加得 +0，向 −∞ 舍入时得 −0；同号 0 相加保留符号）
fn zero_sign(a: f64, b: f64, rm: Rm) -> f32 {
    if a == 0.0 && b == 0.0 && a.is_sign_negative() == b.is_sign_negative() {
        return if a.is_sign_negative() { -0.0 } else { 0.0 };
    }
    if rm == Rm::Down {
        -0.0
    } else {
        0.0
    }
}

pub fn add(a: f32, b: f32, rm: Rm) -> f32 {
    if a.is_nan() || b.is_nan() {
        return f(DEFAULT_NAN);
    }
    let (x, y) = (a as f64, b as f64);
    let (hi, lo) = two_sum(x, y);
    if hi == 0.0 && lo == 0.0 {
        return zero_sign(x, y, rm);
    }
    round_exact(hi, lo, rm)
}

pub fn mul(a: f32, b: f32, rm: Rm) -> f32 {
    if a.is_nan() || b.is_nan() {
        return f(DEFAULT_NAN);
    }
    let p = a as f64 * b as f64; // 精确
    round_exact(p, 0.0, rm)
}

/// acc + a*b，一次舍入（融合乘加）
pub fn fma(acc: f32, a: f32, b: f32, rm: Rm) -> f32 {
    if acc.is_nan() || a.is_nan() || b.is_nan() {
        return f(DEFAULT_NAN);
    }
    let p = a as f64 * b as f64;
    if p.is_nan() {
        return f(DEFAULT_NAN); // ∞ × 0
    }
    let c = acc as f64;
    let (hi, lo) = two_sum(c, p);
    if hi.is_nan() {
        return f(DEFAULT_NAN); // ∞ − ∞
    }
    if hi == 0.0 && lo == 0.0 {
        return zero_sign(c, p, rm);
    }
    round_exact(hi, lo, rm)
}

/// f32 → 整数（先乘 2^scale），按给定方式取整并饱和
fn to_int(x: f32, scale: u32, mode: Rm, unsigned: bool) -> u32 {
    if x.is_nan() {
        return if unsigned { 0xffff_ffff } else { 0x7fff_ffff };
    }
    let v = x as f64 * (1u64 << scale) as f64;
    let r = match mode {
        Rm::Nearest => {
            // 就近偶数
            let fl = v.floor();
            let diff = v - fl;
            if diff > 0.5 || (diff == 0.5 && (fl as i64) % 2 != 0) {
                fl + 1.0
            } else {
                fl
            }
        }
        Rm::Zero => v.trunc(),
        Rm::Up => v.ceil(),
        Rm::Down => v.floor(),
    };
    if unsigned {
        if r < 0.0 {
            0
        } else if r >= 4294967296.0 {
            0xffff_ffff
        } else {
            r as u32
        }
    } else if r >= 2147483648.0 {
        0x7fff_ffff
    } else if r < -2147483648.0 {
        0x8000_0000
    } else {
        r as i64 as i32 as u32
    }
}

/// 整数 → f32，再除以 2^scale
fn from_int(v: u32, scale: u32, unsigned: bool, rm: Rm) -> f32 {
    let x = if unsigned { v as f64 } else { v as i32 as f64 };
    round_exact(x / (1u64 << scale) as f64, 0.0, rm)
}

fn exp_of(b: u32) -> i32 {
    ((b >> 23) & 0xff) as i32
}

impl Cpu {
    pub(crate) fn cp0_enabled(&self) -> bool {
        self.sr[sr::CPENABLE as usize] & 1 != 0
    }

    pub(crate) fn cp0_disabled(&mut self) -> Result<Flow, Exit> {
        self.exception(cause::COPROCESSOR0_DISABLED, 0);
        Ok(Flow::Done)
    }

    fn rm(&self) -> Rm {
        Rm::from_fcr(self.fcr)
    }

    fn fset(&mut self, i: u32, v: f32) {
        self.fr[i as usize] = v.to_bits();
    }

    fn fget(&self, i: u32) -> f32 {
        f(self.fr[i as usize])
    }

    /// op0=3：LSI / SSI / LSIP / SSIP
    pub(crate) fn exec_lsci<B: Bus>(&mut self, bus: &mut B, t: u32, s: u32, r: u32, imm8: u32) -> Result<Flow, Exit> {
        if !self.cp0_enabled() {
            return self.cp0_disabled();
        }
        let base = self.a(s);
        let off = imm8 << 2;
        match r {
            0 | 8 => {
                let addr = if r == 0 { base.wrapping_add(off) } else { base };
                let Some(v) = self.load(bus, addr, 4) else {
                    return Ok(Flow::Done);
                };
                self.fr[t as usize] = v;
                if r == 8 {
                    self.set_a(s, base.wrapping_add(off));
                }
            }
            4 | 12 => {
                let addr = if r == 4 { base.wrapping_add(off) } else { base };
                if !self.store(bus, addr, 4, self.fr[t as usize]) {
                    return Ok(Flow::Done);
                }
                if r == 12 {
                    self.set_a(s, base.wrapping_add(off));
                }
            }
            _ => return self.illegal(),
        }
        Ok(Flow::Next)
    }

    /// op0=0 op1=8：LSX / LSXP / SSX / SSXP
    pub(crate) fn exec_lscx<B: Bus>(&mut self, bus: &mut B, t: u32, s: u32, r: u32, op2: u32) -> Result<Flow, Exit> {
        if !self.cp0_enabled() {
            return self.cp0_disabled();
        }
        let (base, idx) = (self.a(s), self.a(t));
        let post = op2 & 1 != 0;
        let addr = if post { base } else { base.wrapping_add(idx) };
        match op2 {
            0 | 1 => {
                let Some(v) = self.load(bus, addr, 4) else {
                    return Ok(Flow::Done);
                };
                self.fr[r as usize] = v;
            }
            4 | 5 => {
                if !self.store(bus, addr, 4, self.fr[r as usize]) {
                    return Ok(Flow::Done);
                }
            }
            _ => return self.illegal(),
        }
        if post {
            self.set_a(s, base.wrapping_add(idx));
        }
        Ok(Flow::Next)
    }

    /// op0=0 op1=10：FP0 组
    pub(crate) fn exec_fp0(&mut self, t: u32, s: u32, r: u32, op2: u32) -> Result<Flow, Exit> {
        if !self.cp0_enabled() {
            return self.cp0_disabled();
        }
        let rm = self.rm();
        let (fs, ft) = (self.fget(s), self.fget(t));
        let fr = self.fget(r);
        match op2 {
            0 => self.fset(r, add(fs, ft, rm)),
            1 => self.fset(r, add(fs, -ft, rm)),
            2 => self.fset(r, mul(fs, ft, rm)),
            4 => self.fset(r, fma(fr, fs, ft, rm)),
            5 => self.fset(r, fma(fr, -fs, ft, rm)),
            6 => self.fset(r, fma(fr, fs, ft, Rm::Nearest)),
            7 => {
                let v = self.divn(fr, fs, ft, rm);
                self.fset(r, v);
            }
            8..=11 | 14 => {
                let mode = match op2 {
                    8 => Rm::Nearest,
                    9 | 14 => Rm::Zero,
                    10 => Rm::Down,
                    _ => Rm::Up,
                };
                self.set_a(r, to_int(fs, t, mode, op2 == 14));
            }
            12 | 13 => {
                let v = from_int(self.a(s), t, op2 == 13, rm);
                self.fset(r, v);
            }
            15 => return self.exec_fp1op(t, s, r),
            _ => return self.illegal(),
        }
        Ok(Flow::Next)
    }

    /// FP0 op2=15：按 t 区分的单操作数指令
    fn exec_fp1op(&mut self, t: u32, s: u32, r: u32) -> Result<Flow, Exit> {
        let bs = self.fr[s as usize];
        let v = match t {
            0 => bs,
            1 => bs & 0x7fff_ffff,
            3 => const_s(s),
            4 => {
                self.set_a(r, bs);
                return Ok(Flow::Next);
            }
            5 => self.a(s),
            6 => bs ^ 0x8000_0000,
            7 => div0(bs),
            8 => recip0(bs),
            9 => sqrt0(bs),
            10 => rsqrt0(bs),
            11 => nexp01(bs),
            12 => mksadj(bs),
            13 => mkdadj(self.fr[r as usize], bs),
            14 => addexp(self.fr[r as usize], bs, false),
            15 => addexp(self.fr[r as usize], bs, true),
            _ => return self.illegal(),
        };
        self.fr[r as usize] = v;
        Ok(Flow::Next)
    }

    /// op0=0 op1=11：比较与条件传送
    pub(crate) fn exec_fp1(&mut self, t: u32, s: u32, r: u32, op2: u32) -> Result<Flow, Exit> {
        if !self.cp0_enabled() {
            return self.cp0_disabled();
        }
        let (a, b) = (self.fget(s), self.fget(t));
        let un = a.is_nan() || b.is_nan();
        match op2 {
            1..=7 => {
                let v = match op2 {
                    1 => un,
                    2 => !un && a == b,
                    3 => un || a == b,
                    4 => !un && a < b,
                    5 => un || a < b,
                    6 => !un && a <= b,
                    _ => un || a <= b,
                };
                let br = &mut self.sr[sr::BR as usize];
                *br = (*br & !(1 << r)) | ((v as u32) << r);
            }
            8..=11 => {
                let at = self.a(t);
                let c = match op2 {
                    8 => at == 0,
                    9 => at != 0,
                    10 => (at as i32) < 0,
                    _ => at as i32 >= 0,
                };
                if c {
                    self.fr[r as usize] = self.fr[s as usize];
                }
            }
            12 | 13 => {
                let bt = self.sr[sr::BR as usize] >> t & 1 != 0;
                if bt == (op2 == 13) {
                    self.fr[r as usize] = self.fr[s as usize];
                }
            }
            _ => return self.illegal(),
        }
        Ok(Flow::Next)
    }

    /// DIVN.S：除法序列的最后一步 fr + fs*ft，按 FCR 舍入
    fn divn(&self, fr: f32, fs: f32, ft: f32, rm: Rm) -> f32 {
        fma(fr, fs, ft, rm)
    }
}

/// CONST.S 常数表
fn const_s(i: u32) -> u32 {
    match i {
        0 => 0.0f32.to_bits(),
        1 => 1.0f32.to_bits(),
        2 => 2.0f32.to_bits(),
        3 => 0.5f32.to_bits(),
        _ => 0,
    }
}

/// NEXP01.S：取 |尾数|，指数换成 0 或 1（保留原指数奇偶），再取负；结果落在 (−4, −1]
fn nexp01(b: u32) -> u32 {
    let e = exp_of(b);
    let m = b & 0x7f_ffff;
    let sign = b & 0x8000_0000;
    if e == 0xff {
        return b ^ 0x8000_0000;
    }
    if e == 0 {
        if m == 0 {
            return b ^ 0x8000_0000;
        }
        // 非规格数：规格化
        let sh = m.leading_zeros() - 8;
        let mm = (m << sh) & 0x7f_ffff;
        let ue = 1 - 127 - sh as i32;
        let ne = (ue & 1) + 127;
        return (sign ^ 0x8000_0000) | ((ne as u32) << 23) | mm;
    }
    let ue = e - 127;
    let ne = (ue & 1) + 127;
    (sign ^ 0x8000_0000) | ((ne as u32) << 23) | m
}

/// 尾数（指数置 0）的倒数近似
fn mant_recip(b: u32) -> f64 {
    let m = f32::from_bits((b & 0x7f_ffff) | (127 << 23)) as f64;
    1.0 / m
}

/// DIV0.S：除数尾数倒数的种子
fn div0(b: u32) -> u32 {
    (mant_recip(b) as f32).to_bits()
}

/// RECIP0.S：倒数近似
fn recip0(b: u32) -> u32 {
    (1.0 / f32::from_bits(b)).to_bits()
}

/// SQRT0.S：开方种子（对 NEXP01 后的尾数开方近似）
fn sqrt0(b: u32) -> u32 {
    (f32::from_bits(b).abs().sqrt()).to_bits()
}

/// RSQRT0.S：倒数平方根近似
fn rsqrt0(b: u32) -> u32 {
    (1.0 / f32::from_bits(b).sqrt()).to_bits()
}

/// MKSADJ.S：开方的指数调整量（指数的一半）
fn mksadj(b: u32) -> u32 {
    let e = exp_of(b) - 127;
    let half = e >> 1;
    (((half + 127) as u32) & 0xff) << 23
}

/// MKDADJ.S：除法的指数调整量 exp(被除数) − exp(除数)
fn mkdadj(divisor: u32, dividend: u32) -> u32 {
    let d = exp_of(dividend) - exp_of(divisor);
    (((d + 127) as u32) & 0xff) << 23
}

/// ADDEXP.S / ADDEXPM.S：把 fs 的指数（减偏置）加到 fr 的指数上
fn addexp(fr: u32, fs: u32, _m: bool) -> u32 {
    let e = exp_of(fr) + exp_of(fs) - 127;
    (fr & 0x807f_ffff) | (((e as u32) & 0xff) << 23)
}
