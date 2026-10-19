//! Single-precision FPU (coprocessor 0, gated by CPENABLE bit 0). Ops form the exact value hi + lo in f64 (TwoSum for
//! adds) and round once per FCR[1:0] (0 nearest-even, 1 zero, 2 +inf, 3 -inf), so every mode is exact; no denormal flush.
//! FSR flags (bit 7 inexact, 8 underflow, 9 overflow, 10 div0, 11 invalid) only accumulate; underflow = tiny before rounding + inexact.
//! Divide / sqrt step ops follow Espressif QEMU (real per-step semantics are unpublished): MKDADJ.S yields the rounded fs/fr,
//! MKSADJ.S sqrt(fs), ADDEXPM.S moves it, other steps leave the target alone, so only compiler-standard sequences are exact.
//! RECIP0 / RSQRT0 (-ffast-math __recipsf2 / __rsqrtsf2 only) return 1/x, 1/sqrt(x) where QEMU is a no-op. lint: allow-long-comment

use crate::{cause, sr, Bus, Cpu, Exit, Flow};

/// FCR writable bits: RM[1:0], exception enables [6:2] (stored only, they never trap)
pub const FCR_MASK: u32 = 0x7f;
/// FSR writable bits: exception flags [11:7]
pub const FSR_MASK: u32 = 0xf80;

pub const FL_INEXACT: u32 = 1 << 7;
pub const FL_UNDERFLOW: u32 = 1 << 8;
pub const FL_OVERFLOW: u32 = 1 << 9;
pub const FL_DIVZERO: u32 = 1 << 10;
pub const FL_INVALID: u32 = 1 << 11;

pub fn is_fp_ur(n: u32) -> bool {
    n == sr::UR_FCR || n == sr::UR_FSR
}

/// Default (canonical) NaN for invalid ops (inf-inf, 0*inf, 0/0, sqrt of a negative), matched against QEMU
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

/// Quiets a NaN (keeps sign and payload)
fn quiet(b: u32) -> u32 {
    b | 0x0040_0000
}

/// NaN propagation for two inputs: the second operand (ft) wins; any signalling NaN sets the invalid flag
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

/// TwoSum: hi + lo equals a + b exactly (absent overflow)
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    if !s.is_finite() {
        return (s, 0.0);
    }
    let bb = s - a;
    let err = (a - (s - bb)) + (b - bb);
    (s, err)
}

/// Rounds the exact value hi + lo (|lo| <= half an f64 ulp of hi) to f32 per rm, accumulating inexact / overflow / underflow flags
pub fn round_exact(hi: f64, lo: f64, rm: Rm, fl: &mut u32) -> f32 {
    if hi.is_nan() {
        return f(DEFAULT_NAN);
    }
    if hi.is_infinite() {
        return hi as f32;
    }
    let r0 = hi as f32; // nearest-even
    if r0.is_infinite() {
        *fl |= FL_OVERFLOW | FL_INEXACT;
        // Overflow: toward zero / away from the direction gives the largest finite value
        let pos = hi > 0.0;
        return match (rm, pos) {
            (Rm::Nearest, _) => r0,
            (Rm::Zero, true) | (Rm::Down, true) => f32::MAX,
            (Rm::Zero, false) | (Rm::Up, false) => -f32::MAX,
            _ => r0,
        };
    }
    let d = r0 as f64 - hi; // exact
                            // Direction of the exact value relative to r0: >0 means the exact value is larger
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
            // Only when hi sits exactly on an f32 midpoint with nonzero lo can the first rounding pick wrong
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
    // Directed rounding pushed the largest finite value to inf: that is overflow too
    if r.is_infinite() {
        *fl |= FL_OVERFLOW;
    }
    // After toward-zero / toward +-inf adjustment, keep the zero's sign consistent with the exact value
    if r == 0.0 && hi < 0.0 {
        -0.0
    } else {
        r
    }
}

/// Sign of an exact-zero result (IEEE 754: opposite signs give +0, -0 when rounding toward -inf; same-signed zeros keep it)
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

/// a + b (neg_b: a - b)
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
    let p = a as f64 * b as f64; // exact
    round_exact(p, 0.0, rm, fl)
}

/// acc +- a*b with one rounding (fused multiply-add; neg: acc - a*b)
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

/// IEEE division a / b rounded per rm (f64 quotient and remainder decide the direction)
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
    // The sign of r = x - q*y (exact via f64 fma) tells which side of q the true value lies; the f64 quotient is far from
    // the f32 grid, so any value much smaller than half an f64 ulp of q can stand for that direction
    let r = (-q).mul_add(y, x);
    let lo = if r == 0.0 {
        0.0
    } else {
        (r / y).signum() * q.abs() * f64::EPSILON * f64::EPSILON
    };
    round_exact(q, lo, rm, fl)
}

/// IEEE square root rounded per rm
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

/// f32 -> integer (after multiplying by 2^scale), rounded the given way and saturated. UTRUNC: negatives give the
/// two's complement of the signed truncation, -inf gives 0x80000000, NaN / overflow 0xFFFFFFFF (matched against QEMU)
fn to_int(x: f32, scale: u32, mode: Rm, unsigned: bool, fl: &mut u32) -> u32 {
    if x.is_nan() {
        *fl |= FL_INVALID;
        return if unsigned { 0xffff_ffff } else { 0x7fff_ffff };
    }
    let v = x as f64 * (1u64 << scale) as f64;
    // Scale by 2^scale in single precision first: finite values that overflow also set overflow (+inexact); UTRUNC does not (per QEMU)
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

/// Integer -> f32, then divide by 2^scale
fn from_int(v: u32, scale: u32, unsigned: bool, rm: Rm, fl: &mut u32) -> f32 {
    let x = if unsigned { v as f64 } else { v as i32 as f64 };
    round_exact(x / (1u64 << scale) as f64, 0.0, rm, fl)
}

/// Compare: returns (result, invalid set). OLT/OLE/ULT/ULE signal on any NaN, UN/OEQ/UEQ only on signalling NaN
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

    /// op0=3: LSI / SSI / LSIP / SSIP (P: access at as, then as += imm)
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

    /// op0=0 op1=8: LSX / LSXP / SSX / SSXP
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

    /// op0=0 op1=10: FP0 group
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
            // MADDN.S / DIVN.S: steps of the divide / sqrt sequence; MKDADJ / MKSADJ already produced the result (see module docs)
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

    /// FP0 op2=15: single-operand ops selected by t
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
            // Sequence steps that leave the target register unchanged (see module docs)
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

    /// op0=0 op1=11: compares and conditional moves
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

/// CONST.S constant table (matched against QEMU: low 2 bits of imm cycle 0, 1, 2, 0.5)
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
        let x = 1.0f64 + f64::powi(2.0, -30); // between 1 and the next f32
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
        // Nearest 1/3 is 0x3EAAAAAB, above the true value: rounding up keeps it, down / toward zero is one ulp less
        assert_eq!(div(1.0, 3.0, Rm::Up, &mut fl).to_bits(), 0x3eaa_aaab);
        assert_eq!(div(1.0, 3.0, Rm::Down, &mut fl).to_bits(), 0x3eaa_aaaa);
        assert_eq!(div(1.0, 3.0, Rm::Zero, &mut fl).to_bits(), 0x3eaa_aaaa);
        assert_eq!(div(-1.0, 3.0, Rm::Down, &mut fl).to_bits(), 0xbeaa_aaab);
        // RECIP0 / RSQRT0 go through the same divide / sqrt path
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
