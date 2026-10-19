//! MAC16: 16x16 multiply(-accumulate) into the 40-bit ACC (ACCLO 32 bits + ACCHI low 8, sign-extended) plus
//! m0..m3 LDINC / LDDEC and parallel loads. newlib / libgcc / IDF never emit these; esp-dsp hand-written asm does.
//! Encoding (op0=4): op2 = operand source and load mode, op1[3:2] = UMUL/MUL/MULA/MULS, op1[1:0] = half-word select. lint: allow-long-comment

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
    pub(crate) fn exec_mac16<B: Bus>(
        &mut self,
        bus: &mut B,
        t: u32,
        s: u32,
        r: u32,
        op1: u32,
        op2: u32,
    ) -> Result<Flow, Exit> {
        let m = |c: &Cpu, i: u32| c.sr[(sr::M0 + i) as usize];
        // x comes from as or m0/m1 (bit 2 of r), y from at or m2/m3 (bit 2 of t)
        let (x, y, load) = match op2 {
            7 => (self.a(s), self.a(t), None),
            3 => (self.a(s), m(self, 2 + ((t >> 2) & 1)), None),
            6 => (m(self, (r >> 2) & 1), self.a(t), None),
            2 => (m(self, (r >> 2) & 1), m(self, 2 + ((t >> 2) & 1)), None),
            // MAC + parallel load: 0/1 = DD LDINC/LDDEC, 4/5 = DA LDINC/LDDEC
            0 | 1 => (
                m(self, (r >> 2) & 1),
                m(self, 2 + ((t >> 2) & 1)),
                Some(op2 & 1 != 0),
            ),
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
            0 => (xs as i64) * (ys as i64), // UMUL: unsigned
            _ => (xs as u16 as i16 as i64) * (ys as u16 as i16 as i64),
        };
        let acc = self.acc();
        let v = match kind {
            0 | 1 => prod,
            2 => acc.wrapping_add(prod),
            _ => acc.wrapping_sub(prod),
        };
        // Parallel load: compute the MAC with the old m value first, then update mw and as
        if let Some(dec) = load {
            if let Ok(Flow::Done) = self.mac16_load(bus, r & 3, s, dec) {
                return Ok(Flow::Done);
            }
        }
        self.set_acc(v);
        Ok(Flow::Next)
    }

    fn mac16_load<B: Bus>(&mut self, bus: &mut B, w: u32, s: u32, dec: bool) -> Result<Flow, Exit> {
        let a = if dec {
            self.a(s).wrapping_sub(4)
        } else {
            self.a(s).wrapping_add(4)
        };
        let Some(v) = self.load(bus, a, 4) else {
            return Ok(Flow::Done);
        };
        self.sr[(sr::M0 + w) as usize] = v;
        self.set_a(s, a);
        Ok(Flow::Next)
    }
}

#[cfg(test)]
mod tests {
    use crate::{sr, Bus, BusFault, Cpu};

    struct Ram(Vec<u8>);
    impl Bus for Ram {
        fn load(&mut self, a: u32, s: u32) -> Result<u32, BusFault> {
            let o = a as usize;
            let b = self.0.get(o..o + s as usize).ok_or(BusFault)?;
            Ok(b.iter()
                .enumerate()
                .fold(0, |v, (i, x)| v | (*x as u32) << (8 * i)))
        }
        fn store(&mut self, _: u32, _: u32, _: u32) -> Result<(), BusFault> {
            Ok(())
        }
    }

    /// MAC + parallel load: compute with the current m values, then load new ones and bump the pointer
    #[test]
    fn mula_ldinc_uses_current_m() {
        let mut ram = Ram(vec![0; 64]);
        ram.0[4..8].copy_from_slice(&0x3333_4444u32.to_le_bytes());
        let mut c = Cpu::new();
        c.sr[(sr::M0 + 1) as usize] = 0x1111_2222;
        c.sr[(sr::M0 + 2) as usize] = 0x0005_0006;
        c.set_a(8, 0);
        // mula.dd.ll.ldinc m0, a8, m1, m2: op2=0 op1=8 r=4 (w=0, x=m1) s=8 t=0 (y=m2)
        let _ = c.exec_mac16(&mut ram, 0, 8, 4, 8, 0);
        assert_eq!(c.sr[sr::ACCLO as usize], 0x2222 * 6);
        assert_eq!(c.sr[sr::M0 as usize], 0x3333_4444);
        assert_eq!(c.a(8), 4);
    }
}
