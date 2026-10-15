use super::*;

struct Ram(Vec<u8>);
impl Bus for Ram {
    fn load(&mut self, a: u32, s: u32) -> Result<u32, BusFault> {
        let a = a as usize;
        let b = self.0.get(a..a + s as usize).ok_or(BusFault)?;
        Ok(b.iter().enumerate().fold(0, |v, (i, x)| v | (*x as u32) << (8 * i)))
    }
    fn store(&mut self, a: u32, s: u32, v: u32) -> Result<(), BusFault> {
        let a = a as usize;
        let b = self.0.get_mut(a..a + s as usize).ok_or(BusFault)?;
        for (i, x) in b.iter_mut().enumerate() {
            *x = (v >> (8 * i)) as u8;
        }
        Ok(())
    }
}

fn run(code: &[u8], steps: usize) -> Cpu {
    let mut ram = Ram(vec![0; 4096]);
    ram.0[..code.len()].copy_from_slice(code);
    let mut cpu = Cpu::new();
    cpu.pc = 0;
    for _ in 0..steps {
        cpu.step(&mut ram);
    }
    cpu
}

#[test]
fn movi_add() {
    // movi a2, 5：RRI8 op0=2 t=2 s=0 r=10 imm8=5 → 字节 22 a0 05
    // movi.n a3, 7：op0=12 t=0 s=3 r=7 → 字节 0c 73
    // add.n a4, a2, a3：op0=10 t=3 s=2 r=4 → 字节 3a 42
    let c = run(&[0x22, 0xa0, 0x05, 0x0c, 0x73, 0x3a, 0x42], 3);
    assert_eq!(c.a(2), 5);
    assert_eq!(c.a(3), 7);
    assert_eq!(c.a(4), 12);
}

#[test]
fn window_rotation() {
    let mut c = Cpu::new();
    c.windowbase = 2;
    c.set_a(1, 0x1234);
    assert_eq!(c.ar[9], 0x1234);
    c.windowbase = 0;
    assert_eq!(c.a(9), 0x1234);
}
