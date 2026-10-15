//! MAC16：16×16 乘（累加）到 40 位累加器 ACC（ACCLO 32 位 + ACCHI 低 8 位，符号扩展），
//! 以及 m0..m3 的 LDINC / LDDEC 与乘累加并行装载。newlib / libgcc / IDF 本身都不生成这些指令，
//! 主要给 esp-dsp 之类的手写汇编用。
//!
//! 编码（op0=4）：op2 选操作数来源与装载方式，op1[3:2] 选 UMUL/MUL/MULA/MULS，op1[1:0] 选高低半字。

use crate::{sr, Bus, Cpu, Exit, Flow};

impl Cpu {
    fn acc(&self) -> i64 {
        let lo = self.sr[sr::ACCLO as usize] as u64;
        let hi = (self.sr[sr::ACCHI as usize] & 0xff) as u64;
        (((hi << 32) | lo) << 24) as i64 >> 24
    }

    fn set_acc(&mut self, v: i64) {
        self.sr[sr::ACCLO as usize] = v as u32;
        self.sr[sr::ACCHI as usize] = ((v >> 32) as i8) as i32 as u32;
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn exec_mac16<B: Bus>(&mut self, bus: &mut B, t: u32, s: u32, r: u32, op1: u32, op2: u32) -> Result<Flow, Exit> {
        let m = |c: &Cpu, i: u32| c.sr[(sr::M0 + i) as usize];
        // 操作数：x 来自 as 或 m0/m1（r 的位 2），y 来自 at 或 m2/m3（t 的位 2）
        let (x, y, load) = match op2 {
            7 => (self.a(s), self.a(t), None),
            3 => (self.a(s), m(self, 2 + ((t >> 2) & 1)), None),
            6 => (m(self, (r >> 2) & 1), self.a(t), None),
            2 => (m(self, (r >> 2) & 1), m(self, 2 + ((t >> 2) & 1)), None),
            // 乘累加 + 并行装载：0/1 = DD 的 LDINC/LDDEC，4/5 = DA 的 LDINC/LDDEC
            0 | 1 => (m(self, (r >> 2) & 1), m(self, 2 + ((t >> 2) & 1)), Some(op2 & 1 != 0)),
            4 | 5 => (m(self, (r >> 2) & 1), self.a(t), Some(op2 & 1 != 0)),
            8 | 9 => {
                // LDINC / LDDEC mw, as
                if op1 != 0 {
                    return self.illegal();
                }
                return self.mac16_load(bus, r & 3, s, op2 == 9);
            }
            _ => return self.illegal(),
        };
        let xh = op1 & 1 != 0;
        let yh = op1 & 2 != 0;
        let xs = if xh { x >> 16 } else { x & 0xffff };
        let ys = if yh { y >> 16 } else { y & 0xffff };
        let kind = op1 >> 2;
        if load.is_some() && kind < 2 {
            return self.illegal();
        }
        let prod = match kind {
            0 => (xs as i64) * (ys as i64), // UMUL：无符号
            _ => (xs as u16 as i16 as i64) * (ys as u16 as i16 as i64),
        };
        let acc = self.acc();
        let v = match kind {
            0 | 1 => prod,
            2 => acc.wrapping_add(prod),
            _ => acc.wrapping_sub(prod),
        };
        // 并行装载：先算乘累加（用旧的 m 值），再更新 mw 与 as
        if let Some(dec) = load {
            if let Ok(Flow::Done) = self.mac16_load(bus, r & 3, s, dec) {
                return Ok(Flow::Done);
            }
        }
        self.set_acc(v);
        Ok(Flow::Next)
    }

    fn mac16_load<B: Bus>(&mut self, bus: &mut B, w: u32, s: u32, dec: bool) -> Result<Flow, Exit> {
        let a = if dec { self.a(s).wrapping_sub(4) } else { self.a(s).wrapping_add(4) };
        let Some(v) = self.load(bus, a, 4) else {
            return Ok(Flow::Done);
        };
        self.sr[(sr::M0 + w) as usize] = v;
        self.set_a(s, a);
        Ok(Flow::Next)
    }
}
