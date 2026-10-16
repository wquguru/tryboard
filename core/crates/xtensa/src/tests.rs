use super::*;

struct Ram(Vec<u8>);
impl Bus for Ram {
    fn load(&mut self, a: u32, s: u32) -> Result<u32, BusFault> {
        let a = a as usize;
        let b = self.0.get(a..a + s as usize).ok_or(BusFault)?;
        Ok(b.iter()
            .enumerate()
            .fold(0, |v, (i, x)| v | (*x as u32) << (8 * i)))
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

/// 中断测试用的 CPU：VECBASE=0x100，PS.INTLEVEL=0、EXCM=0，代码区全是 NOP.N（0xF03D）
fn irq_cpu() -> (Cpu, Ram) {
    let mut ram = Ram(vec![0; 4096]);
    for i in (0..4096).step_by(2) {
        ram.0[i] = 0x3d;
        ram.0[i + 1] = 0xf0;
    }
    let mut c = Cpu::new();
    c.pc = 0x800;
    c.write_sr(sr::VECBASE, 0x100);
    c.write_sr(sr::PS, 0);
    (c, ram)
}

#[test]
fn level_interrupt_follows_line() {
    let (mut c, mut ram) = irq_cpu();
    c.write_sr(sr::INTENABLE, 1 << 19); // 外部电平型，level 2
    c.set_irq_lines(1 << 19);
    assert_eq!(c.read_sr(sr::INTERRUPT), 1 << 19);
    c.step(&mut ram);
    assert_eq!(c.pc, 0x100 + vec::LEVEL[2]);
    assert_eq!(c.read_sr(sr::EPC2), 0x800);
    assert_eq!(c.ps() & 0x1f, 0x12); // INTLEVEL=2、EXCM=1
    // 电平型：线撤掉挂起位就没了，INTCLEAR 清不掉
    c.write_sr(sr::INTCLEAR, 1 << 19);
    assert_eq!(c.read_sr(sr::INTERRUPT), 1 << 19);
    c.set_irq_lines(0);
    assert_eq!(c.read_sr(sr::INTERRUPT), 0);
}

#[test]
fn edge_and_nmi_latch() {
    let (mut c, mut ram) = irq_cpu();
    // 边沿型 10（level 1）：上升沿锁存，线撤掉仍挂起，INTCLEAR 清
    c.set_irq_lines(1 << 10);
    c.set_irq_lines(0);
    assert_eq!(c.read_sr(sr::INTERRUPT), 1 << 10);
    c.write_sr(sr::INTCLEAR, 1 << 10);
    assert_eq!(c.read_sr(sr::INTERRUPT), 0);
    // NMI（14，level 7）：PS.INTLEVEL=6 也挡不住
    c.write_sr(sr::PS, 6);
    c.write_sr(sr::INTENABLE, 1 << 14);
    c.set_irq_lines(1 << 14);
    c.step(&mut ram);
    assert_eq!(c.pc, 0x100 + vec::LEVEL[7]);
    assert_eq!(c.read_sr(sr::EPS2 + 5), 6);
}

#[test]
fn level1_uses_kernel_vector_with_cause4() {
    let (mut c, mut ram) = irq_cpu();
    c.write_sr(sr::INTENABLE, 1 << 7);
    c.write_sr(sr::INTERRUPT, 1 << 7); // INTSET 软件中断
    c.step(&mut ram);
    assert_eq!(c.pc, 0x100 + vec::KERNEL);
    assert_eq!(c.read_sr(sr::EXCCAUSE), cause::LEVEL1_INTERRUPT);
    assert_eq!(c.read_sr(sr::EPC1), 0x800);
}

#[test]
fn waiti_fast_forward_to_ccompare() {
    let (mut c, mut ram) = irq_cpu();
    // WAITI 0（op0=0 op1=0 op2=0 r=7 s=0 t=0）
    ram.0[0x800..0x803].copy_from_slice(&[0x00, 0x70, 0x00]);
    c.write_sr(sr::CCOMPARE0, 1_000_000);
    c.write_sr(sr::INTENABLE, 1 << 6);
    assert_eq!(c.step(&mut ram), Exit::Waiti);
    assert_eq!(c.step(&mut ram), Exit::Waiti);
    // SoC 快进：直接把 cycles 推到下一个定时器事件
    let t = c.next_timer_event().unwrap();
    assert_eq!(t, 1_000_000);
    c.cycles = t;
    assert_eq!(c.step(&mut ram), Exit::Normal);
    assert_eq!(c.pc, 0x100 + vec::KERNEL);
    assert_eq!(c.read_sr(sr::EPC1), 0x803); // 返回到 WAITI 之后
    // 写 CCOMPARE0 清定时器挂起位
    c.write_sr(sr::CCOMPARE0, 5);
    assert_eq!(c.read_sr(sr::INTERRUPT) & (1 << 6), 0);
}

#[test]
fn excm_masks_up_to_level3() {
    let (mut c, mut ram) = irq_cpu();
    c.write_sr(sr::PS, PS_EXCM);
    c.write_sr(sr::INTENABLE, 1 << 29 | 1 << 26);
    c.write_sr(sr::INTERRUPT, 1 << 29); // 软件中断 29，level 3：被 EXCM 挡
    c.step(&mut ram);
    assert_eq!(c.pc, 0x803 - 1); // 执行了一条 NOP.N
    c.set_irq_lines(1 << 26); // 外部电平型 26，level 5：能进
    c.step(&mut ram);
    assert_eq!(c.pc, 0x100 + vec::LEVEL[5]);
}

#[test]
fn ccount_write_keeps_time() {
    let (mut c, mut ram) = irq_cpu();
    c.cycles = 1_000_000;
    // IDF 换频时按比例改写 CCOUNT：只改计数器，不改模拟时间
    c.write_sr(sr::CCOUNT, 0x10);
    assert_eq!(c.cycles, 1_000_000);
    assert_eq!(c.read_sr(sr::CCOUNT), 0x10);
    // CCOMPARE 按 CCOUNT 的值比较
    c.write_sr(sr::CCOMPARE0, 0x40);
    assert_eq!(c.next_timer_event(), None);
    c.write_sr(sr::INTENABLE, 1 << irq::TIMER_LINE[0]);
    assert_eq!(c.next_timer_event(), Some(1_000_000 + 0x30));
    c.cycles += 0x40;
    c.step(&mut ram);
    assert_ne!(c.read_sr(sr::INTERRUPT) & (1 << irq::TIMER_LINE[0]), 0);
}
