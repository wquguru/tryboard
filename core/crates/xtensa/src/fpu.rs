//! 单精度 FPU（协处理器 0，受 CPENABLE 位 0 门控）。
//!
//! 舍入：FCR[1:0] = 0 就近偶数 / 1 向零 / 2 向 +∞ / 3 向 −∞。为了在任意舍入模式下都精确，
//! 运算先在 f64 里得到"精确值 = hi + lo"（乘积在 f64 里精确，加法用 TwoSum 取回误差），再一次性舍入到 f32。
//! 非规格数按 IEEE 处理（不冲零）。
//!
//! FSR 异常标志（位 7 不精确 / 8 下溢 / 9 上溢 / 10 除零 / 11 无效）只累加，不触发异常（FCR 使能位只保存）。
//! 下溢按"舍入前判断微小 + 不精确"。
//!
//! NaN（与 QEMU 逐值对照得出）：无效运算（∞−∞、0×∞、0/0、负数开方）给默认 NaN 0x7FC00000；
//! 输入里有 NaN 时，第二操作数（ft）是 NaN 就取它，否则取第一操作数，并置静默位、保留符号与载荷。
//!
//! 除法 / 开方的"分步指令"：libgcc __divsf3 与 libm __ieee754_sqrtf 用 DIV0 / NEXP01 / MADDN / MKDADJ /
//! ADDEXP / ADDEXPM / DIVN（开方用 SQRT0 / MKSADJ）组成牛顿迭代序列。逐步的真实硬件语义没有公开到可逐位复现的程度，
//! 这里与对照用的乐鑫 QEMU 采用同一模型：MKDADJ.S fr, fs 直接给出 fs/fr 的正确舍入商，MKSADJ.S 给出 sqrt(fs)，
//! ADDEXPM.S 把它搬进结果寄存器，其余分步指令（DIV0 / SQRT0 / NEXP01 / MADDN / ADDEXP / DIVN）不改目标寄存器。
//! 于是编译器生成的标准序列得到正确的 IEEE 结果；手写的、不按标准序列使用这些指令的代码不保证与真机一致。
//! 例外：RECIP0 / RSQRT0（只在 -ffast-math 的 __recipsf2 / __rsqrtsf2 里用）这里直接给出 1/x、1/√x，
//! 让这两个函数结果正确（QEMU 把它们当空操作，结果是寄存器里的旧值）。

use crate::{cause, sr, Bus, Cpu, Exit, Flow};

/// FCR 可写位：RM[1:0]、异常使能 [6:2]
pub const FCR_MASK: u32 = 0x7f;
/// FSR 可写位：异常标志 [11:7]
pub const FSR_MASK: u32 = 0xf80;

pub const FL_INEXACT: u32 = 1 << 7;
pub const FL_UNDERFLOW: u32 = 1 << 8;
pub const FL_OVERFLOW: u32 = 1 << 9;
pub const FL_DIVZERO: u32 = 1 << 10;
pub const FL_INVALID: u32 = 1 << 11;

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

fn is_snan(x: f32) -> bool {
    x.is_nan() && x.to_bits() & 0x0040_0000 == 0
}

/// 把 NaN 变成静默 NaN（保留符号与载荷）
fn quiet(b: u32) -> u32 {
    b | 0x0040_0000
}

/// 两个输入里的 NaN 怎么传播：第二操作数优先；任一是信号 NaN 置无效标志
fn nan2(a: f32, b: f32, fl: &mut u32) -> Option<f32> {
    if is_snan(a) || is_snan(b) {
        *fl |= FL_INVALID;
    }
    if b.is_nan() {
        Some(f(quiet(b.to_bits())))
    } else if a.is_nan() {
        Some(f(quiet(a.to_bits())))
    } else {
        None
    }
}

fn invalid(fl: &mut u32) -> f32 {
    *fl |= FL_INVALID;
    f(DEFAULT_NAN)
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

/// 把精确值 hi + lo（|lo| ≤ hi 的 f64 半 ulp）按 rm 舍入成 f32，并累加不精确 / 上溢 / 下溢标志
pub fn round_exact(hi: f64, lo: f64, rm: Rm, fl: &mut u32) -> f32 {
    if hi.is_nan() {
        return f(DEFAULT_NAN);
    }
    if hi.is_infinite() {
        return hi as f32;
    }
    let r0 = hi as f32; // 就近偶数
    if r0.is_infinite() {
        *fl |= FL_OVERFLOW | FL_INEXACT;
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
    *fl |= FL_INEXACT;
    if hi.abs() < f32::MIN_POSITIVE as f64 {
        *fl |= FL_UNDERFLOW;
    }
    let r = match rm {
        Rm::Nearest => {
            // 只有 hi 正好落在两个 f32 中点、lo 又非零时，第一次舍入可能选错
            if d != 0.0 && lo != 0.0 {
                let other = if d > 0.0 { next_down(r0) } else { next_up(r0) };
                if other as f64 - hi == -d {
                    return if (lo > 0.0) == (other > r0) {
                        other
                    } else {
                        r0
                    };
                }
            }
            r0
        }
        Rm::Zero => {
            let away = (r0 > 0.0 && dir < 0) || (r0 < 0.0 && dir > 0);
            match (away, r0 > 0.0) {
                (true, true) => next_down(r0),
                (true, false) => next_up(r0),
                _ => r0,
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
    };
    // 定向舍入把最大有限值推到了 ∞：也是上溢
    if r.is_infinite() {
        *fl |= FL_OVERFLOW;
    }
    // 向零 / 向 ±∞ 调整后保持零的符号与精确值一致
    if r == 0.0 && hi < 0.0 {
        -0.0
    } else {
        r
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

/// a + b（neg_b：a − b）
pub fn add(a: f32, b: f32, neg_b: bool, rm: Rm, fl: &mut u32) -> f32 {
    if let Some(n) = nan2(a, b, fl) {
        return n;
    }
    let b = if neg_b { -b } else { b };
    if a.is_infinite() && b.is_infinite() && a != b {
        return invalid(fl);
    }
    let (x, y) = (a as f64, b as f64);
    let (hi, lo) = two_sum(x, y);
    if hi == 0.0 && lo == 0.0 {
        return zero_sign(x, y, rm);
    }
    round_exact(hi, lo, rm, fl)
}

pub fn mul(a: f32, b: f32, rm: Rm, fl: &mut u32) -> f32 {
    if let Some(n) = nan2(a, b, fl) {
        return n;
    }
    if (a.is_infinite() && b == 0.0) || (a == 0.0 && b.is_infinite()) {
        return invalid(fl);
    }
    let p = a as f64 * b as f64; // 精确
    round_exact(p, 0.0, rm, fl)
}

/// acc ± a*b，一次舍入（融合乘加；neg：acc − a*b）
pub fn fma(acc: f32, a: f32, b: f32, neg: bool, rm: Rm, fl: &mut u32) -> f32 {
    if is_snan(acc) {
        *fl |= FL_INVALID;
    }
    if let Some(n) = nan2(a, b, fl) {
        return n;
    }
    if (a.is_infinite() && b == 0.0) || (a == 0.0 && b.is_infinite()) {
        return invalid(fl);
    }
    if acc.is_nan() {
        return f(quiet(acc.to_bits()));
    }
    let a = if neg { -a } else { a };
    let p = a as f64 * b as f64;
    let c = acc as f64;
    if c.is_infinite() && p.is_infinite() && c != p {
        return invalid(fl);
    }
    let (hi, lo) = two_sum(c, p);
    if hi == 0.0 && lo == 0.0 {
        return zero_sign(c, p, rm);
    }
    round_exact(hi, lo, rm, fl)
}

/// IEEE 除法 a / b，按 rm 舍入（f64 商与余数判定方向）
pub fn div(a: f32, b: f32, rm: Rm, fl: &mut u32) -> f32 {
    if let Some(n) = nan2(a, b, fl) {
        return n;
    }
    if (a == 0.0 && b == 0.0) || (a.is_infinite() && b.is_infinite()) {
        return invalid(fl);
    }
    if b == 0.0 && a.is_finite() {
        *fl |= FL_DIVZERO;
    }
    let (x, y) = (a as f64, b as f64);
    let q = x / y;
    if !q.is_finite() || q == 0.0 {
        return round_exact(q, 0.0, rm, fl);
    }
    // 余数 r = x − q·y（f64 的 fma 精确），其符号给出真值相对 q 的方向；f64 商离 f32 网格远，
    // 用一个远小于 q 的 f64 半 ulp 的数代表这个方向即可
    let r = (-q).mul_add(y, x);
    let lo = if r == 0.0 {
        0.0
    } else {
        (r / y).signum() * q.abs() * f64::EPSILON * f64::EPSILON
    };
    round_exact(q, lo, rm, fl)
}

/// IEEE 开方，按 rm 舍入
pub fn sqrt(a: f32, rm: Rm, fl: &mut u32) -> f32 {
    if a.is_nan() {
        if is_snan(a) {
            *fl |= FL_INVALID;
        }
        return f(quiet(a.to_bits()));
    }
    if a == 0.0 {
        return a;
    }
    if a < 0.0 {
        return invalid(fl);
    }
    let x = a as f64;
    let s = x.sqrt();
    let r = (-s).mul_add(s, x);
    let lo = if r == 0.0 {
        0.0
    } else {
        r.signum() * s * f64::EPSILON * f64::EPSILON
    };
    round_exact(s, lo, rm, fl)
}

/// f32 → 整数（先乘 2^scale），按给定方式取整并饱和。
/// UTRUNC：负数给有符号截断的补码，−∞ 给 0x80000000，NaN / 上溢给 0xFFFFFFFF（与 QEMU 对照）
fn to_int(x: f32, scale: u32, mode: Rm, unsigned: bool, fl: &mut u32) -> u32 {
    if x.is_nan() {
        *fl |= FL_INVALID;
        return if unsigned { 0xffff_ffff } else { 0x7fff_ffff };
    }
    let v = x as f64 * (1u64 << scale) as f64;
    // 先按单精度乘 2^scale：有限值乘出界时另有上溢（+不精确）标志；UTRUNC 没有（均与 QEMU 对照）
    if !unsigned && x.is_finite() && v.abs() > f32::MAX as f64 {
        *fl |= FL_OVERFLOW | FL_INEXACT;
    }
    let r = match mode {
        Rm::Nearest => {
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
    let inexact = r != v;
    let out = if unsigned && r >= 0.0 {
        if r >= 4294967296.0 {
            None
        } else {
            Some(r as u32)
        }
    } else if r >= 2147483648.0 {
        None
    } else if r < -2147483648.0 {
        return {
            *fl |= FL_INVALID;
            0x8000_0000
        };
    } else {
        Some(r as i64 as i32 as u32)
    };
    match out {
        Some(v) => {
            if inexact {
                *fl |= FL_INEXACT;
            }
            v
        }
        None => {
            *fl |= FL_INVALID;
            if unsigned {
                0xffff_ffff
            } else {
                0x7fff_ffff
            }
        }
    }
}

/// 整数 → f32，再除以 2^scale
fn from_int(v: u32, scale: u32, unsigned: bool, rm: Rm, fl: &mut u32) -> f32 {
    let x = if unsigned { v as f64 } else { v as i32 as f64 };
    round_exact(x / (1u64 << scale) as f64, 0.0, rm, fl)
}

/// 比较：返回（结果, 是否置无效）。OLT/OLE/ULT/ULE 遇 NaN 发信号，UN/OEQ/UEQ 只在信号 NaN 时置无效
fn compare(op: u32, a: f32, b: f32) -> (bool, bool) {
    let un = a.is_nan() || b.is_nan();
    let sig = is_snan(a) || is_snan(b);
    let v = match op {
        1 => un,
        2 => !un && a == b,
        3 => un || a == b,
        4 => !un && a < b,
        5 => un || a < b,
        6 => !un && a <= b,
        _ => un || a <= b,
    };
    let inv = sig || (un && (4..=7).contains(&op));
    (v, inv)
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

    /// op0=3：LSI / SSI / LSIP / SSIP（P：先用 as 访存，再 as += imm）
    pub(crate) fn exec_lsci<B: Bus>(
        &mut self,
        bus: &mut B,
        t: u32,
        s: u32,
        r: u32,
        imm8: u32,
    ) -> Result<Flow, Exit> {
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
    pub(crate) fn exec_lscx<B: Bus>(
        &mut self,
        bus: &mut B,
        t: u32,
        s: u32,
        r: u32,
        op2: u32,
    ) -> Result<Flow, Exit> {
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
        let mut fl = 0u32;
        match op2 {
            0 => self.fset(r, add(fs, ft, false, rm, &mut fl)),
            1 => self.fset(r, add(fs, ft, true, rm, &mut fl)),
            2 => self.fset(r, mul(fs, ft, rm, &mut fl)),
            4 => self.fset(r, fma(fr, fs, ft, false, rm, &mut fl)),
            5 => self.fset(r, fma(fr, fs, ft, true, rm, &mut fl)),
            // MADDN.S / DIVN.S：分步除法 / 开方序列里的步骤，结果已由 MKDADJ / MKSADJ 给出（见模块说明）
            6 | 7 => {}
            8..=11 | 14 => {
                let mode = match op2 {
                    8 => Rm::Nearest,
                    9 | 14 => Rm::Zero,
                    10 => Rm::Down,
                    _ => Rm::Up,
                };
                let v = to_int(fs, t, mode, op2 == 14, &mut fl);
                self.set_a(r, v);
            }
            12 | 13 => {
                let v = from_int(self.a(s), t, op2 == 13, rm, &mut fl);
                self.fset(r, v);
            }
            15 => return self.exec_fp1op(t, s, r),
            _ => return self.illegal(),
        }
        self.fsr |= fl;
        Ok(Flow::Next)
    }

    /// FP0 op2=15：按 t 区分的单操作数指令
    fn exec_fp1op(&mut self, t: u32, s: u32, r: u32) -> Result<Flow, Exit> {
        let bs = self.fr[s as usize];
        let br = self.fr[r as usize];
        let rm = self.rm();
        let mut fl = 0u32;
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
            // 分步序列里不改目标寄存器的步骤（见模块说明）
            7 | 9 | 11 | 14 => br,
            8 => div(1.0, f(bs), rm, &mut fl).to_bits(),
            10 => {
                let q = sqrt(f(bs), Rm::Nearest, &mut fl);
                if q.is_nan() {
                    q.to_bits()
                } else {
                    div(1.0, q, rm, &mut fl).to_bits()
                }
            }
            12 => sqrt(f(bs), rm, &mut fl).to_bits(),
            13 => div(f(bs), f(br), rm, &mut fl).to_bits(),
            15 => bs,
            _ => return self.illegal(),
        };
        self.fr[r as usize] = v;
        self.fsr |= fl;
        Ok(Flow::Next)
    }

    /// op0=0 op1=11：比较与条件传送
    pub(crate) fn exec_fp1(&mut self, t: u32, s: u32, r: u32, op2: u32) -> Result<Flow, Exit> {
        if !self.cp0_enabled() {
            return self.cp0_disabled();
        }
        match op2 {
            1..=7 => {
                let (v, inv) = compare(op2, self.fget(s), self.fget(t));
                if inv {
                    self.fsr |= FL_INVALID;
                }
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
}

/// CONST.S 常数表（与 QEMU 对照：按 imm 的低 2 位循环 0、1、2、0.5）
fn const_s(i: u32) -> u32 {
    [0.0f32, 1.0, 2.0, 0.5][(i & 3) as usize].to_bits()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(hi: f64, rm: Rm) -> f32 {
        round_exact(hi, 0.0, rm, &mut 0)
    }

    #[test]
    fn directed_rounding() {
        let x = 1.0f64 + f64::powi(2.0, -30); // 1 与下一个 f32 之间
        assert_eq!(r(x, Rm::Nearest), 1.0);
        assert_eq!(r(x, Rm::Zero), 1.0);
        assert_eq!(r(x, Rm::Up), next_up(1.0));
        assert_eq!(r(-x, Rm::Down), -next_up(1.0));
        assert_eq!(r(-x, Rm::Zero), -1.0);
        assert_eq!(r(1e300, Rm::Zero), f32::MAX);
        assert_eq!(r(-1e300, Rm::Up), -f32::MAX);
    }

    #[test]
    fn division_and_sqrt_correctly_rounded() {
        let mut fl = 0;
        for &(a, b) in &[
            (1.0f32, 3.0f32),
            (2.0, 7.0),
            (1e-40, 3.0),
            (3.4e38, 0.1),
            (-5.0, 9.0),
        ] {
            assert_eq!(div(a, b, Rm::Nearest, &mut fl), a / b, "{a}/{b}");
        }
        // 1/3 的就近结果 0x3EAAAAAB 比真值大：向上不变，向下 / 向零少一个 ulp
        assert_eq!(div(1.0, 3.0, Rm::Up, &mut fl).to_bits(), 0x3eaa_aaab);
        assert_eq!(div(1.0, 3.0, Rm::Down, &mut fl).to_bits(), 0x3eaa_aaaa);
        assert_eq!(div(1.0, 3.0, Rm::Zero, &mut fl).to_bits(), 0x3eaa_aaaa);
        assert_eq!(div(-1.0, 3.0, Rm::Down, &mut fl).to_bits(), 0xbeaa_aaab);
        // RECIP0 / RSQRT0 走同一套除法 / 开方
        let mut c = Cpu::new();
        c.sr[sr::CPENABLE as usize] = 1;
        c.fr[1] = 4.0f32.to_bits();
        c.exec_fp1op(8, 1, 2).ok();
        assert_eq!(f(c.fr[2]), 0.25);
        c.exec_fp1op(10, 1, 3).ok();
        assert_eq!(f(c.fr[3]), 0.5);
        for &x in &[2.0f32, 3.0, 1e-42, 0.5, 1e30] {
            assert_eq!(sqrt(x, Rm::Nearest, &mut fl), x.sqrt());
        }
        let mut fl = 0;
        assert_eq!(div(1.0, 0.0, Rm::Nearest, &mut fl), f32::INFINITY);
        assert_eq!(fl, FL_DIVZERO);
    }

    #[test]
    fn nan_propagation() {
        let mut fl = 0;
        let q = f(0x7fc0_0000);
        let s = f(0x7f80_0001);
        assert_eq!(
            add(q, s, false, Rm::Nearest, &mut fl).to_bits(),
            0x7fc0_0001
        );
        assert_eq!(
            add(s, q, false, Rm::Nearest, &mut fl).to_bits(),
            0x7fc0_0000
        );
        assert_eq!(
            add(1.0, q, true, Rm::Nearest, &mut fl).to_bits(),
            0x7fc0_0000
        );
        assert_eq!(fl & FL_INVALID, FL_INVALID);
    }
}
