use super::*;

struct Ram(Vec<u8>);
impl Bus for Ram {
    fn load(&mut self, a: u32, s: u32) -> Result<u32, BusFault> {
        let a = a as usize;
        let b = self.0.get(a..a + s as usize).ok_or(BusFault)?;
        let mut v = 0u32;
        for (i, x) in b.iter().enumerate() {
            v |= (*x as u32) << (8 * i);
        }
        Ok(v)
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

fn run(words: &[u32], steps: usize) -> Cpu {
    let mut ram = Ram(vec![0; 4096]);
    for (i, w) in words.iter().enumerate() {
        ram.store(i as u32 * 4, 4, *w).unwrap();
    }
    let mut cpu = Cpu::new();
    for _ in 0..steps {
        cpu.step(&mut ram);
    }
    cpu
}

#[test]
fn addi_lui_add() {
    // addi x1,x0,5 ; lui x2,0x12345 ; add x3,x1,x2
    let c = run(&[0x0050_0093, 0x1234_5137, 0x0020_81b3], 3);
    assert_eq!(c.x[1], 5);
    assert_eq!(c.x[2], 0x1234_5000);
    assert_eq!(c.x[3], 0x1234_5005);
}

#[test]
fn div_edge_cases() {
    // li x1,-1 ; li x2,0 ; div x3,x1,x2 ; rem x4,x1,x2
    let c = run(&[0xfff0_0093, 0x0000_0113, 0x0220_c1b3, 0x0220_e233], 4);
    assert_eq!(c.x[3], u32::MAX);
    assert_eq!(c.x[4], u32::MAX);
}

#[test]
fn compressed_li_addi() {
    // c.li a0,7 (0x451d) ; c.addi a0,-1 (0x157d)
    let mut ram = Ram(vec![0; 64]);
    ram.store(0, 2, 0x451d).unwrap();
    ram.store(2, 2, 0x157d).unwrap();
    let mut cpu = Cpu::new();
    cpu.step(&mut ram);
    cpu.step(&mut ram);
    assert_eq!(cpu.x[10], 6);
    assert_eq!(cpu.pc, 4);
}

#[test]
fn vectored_interrupt() {
    let mut ram = Ram(vec![0; 4096]);
    let mut cpu = Cpu::new();
    cpu.csr.mtvec = 0x100 | 1;
    cpu.csr.mstatus = 1 << 3;
    cpu.irq_line = 5;
    cpu.step(&mut ram);
    assert_eq!(cpu.pc, 0x100 + 20);
    assert_eq!(cpu.csr.mcause, 0x8000_0005);
    assert!(!cpu.irq_enabled());
}
