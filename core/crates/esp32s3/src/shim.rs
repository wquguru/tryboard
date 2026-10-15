//! 临时垫片：核还没实现、但 IDF 启动必经的少数指令，在"非法指令异常刚进向量"时由 SoC 代为执行。
//!
//! TODO(合并 Xtensa 后续切片后删除)：这些指令应在 tryboard-xtensa 里实现；核实现后这里永远不会命中。
//! 只处理 EXCCAUSE=0（非法指令）且 EPC1 处是下表指令的情况，其余异常照常交给固件的处理程序。

use crate::SocBus;
use tryboard_xtensa::{sr, Bus, Cpu, PS_EXCM, PS_UM};

/// 返回 true 表示已代为执行并回到 EPC1 之后
pub fn fixup_illegal(cpu: &mut Cpu, bus: &mut SocBus) -> bool {
    let vb = cpu.read_sr(sr::VECBASE);
    let pc = cpu.pc;
    let ps = cpu.ps();
    let want = vb + if ps & PS_UM != 0 { 0x340 } else { 0x300 };
    if pc != want || ps & PS_EXCM == 0 {
        return false;
    }
    let epc = cpu.read_sr(sr::EPC1);
    if cpu.read_sr(sr::EXCCAUSE) == 5 {
        // TODO(核 bug)：tryboard-xtensa 的 MOVSP 在 WINDOWSTART[WB-1..WB-3] "有任一位为 1"时报 Alloca，
        // ISA 规定的是"三位全为 0"（调用者的帧已不在寄存器里）才报。这里把多报的 Alloca 撤回、照常执行 MOVSP。
        // 少报的那种情况（三位全 0 却没报）垫片救不回来，必须在核里改。
        let Ok(insn) = bus.fetch(epc) else { return false };
        if insn & 0xff_f00f != 0x00_1000 {
            return false;
        }
        let wb = cpu.windowbase;
        let caller_in_regs = (1..=3).any(|k| cpu.windowstart >> ((wb + 16 - k) & 15) & 1 != 0);
        if !caller_in_regs {
            return false;
        }
        let (s, t) = ((insn >> 8) & 0xf, (insn >> 4) & 0xf);
        cpu.set_a(t, cpu.a(s));
        cpu.write_sr(sr::PS, ps & !PS_EXCM);
        cpu.pc = epc.wrapping_add(3);
        return true;
    }
    if cpu.read_sr(sr::EXCCAUSE) != 0 {
        return false;
    }
    let Ok(insn) = bus.fetch(epc) else { return false };
    let (op0, op1, op2) = (insn & 0xf, (insn >> 16) & 0xf, (insn >> 20) & 0xf);
    let (r, s, t) = ((insn >> 12) & 0xf, (insn >> 8) & 0xf, (insn >> 4) & 0xf);
    match (op0, op1, op2) {
        // SALT / SALTU（LX7 "set if less than"）：RRR，op1=2，op2=7 / 6
        (0, 2, 7) => cpu.set_a(r, ((cpu.a(s) as i32) < (cpu.a(t) as i32)) as u32),
        (0, 2, 6) => cpu.set_a(r, (cpu.a(s) < cpu.a(t)) as u32),
        // TLB 族（op1=0，op2=5）：S3 用区域保护属性，IDF 启动时 WITLB / WDTLB 设访问权限。
        // 模拟器不做访问权限检查：写 / 失效当空操作，读（RITLB0/1、RDTLB0/1、PITLB、PDTLB）返回 0
        (0, 0, 5) => match r {
            3 | 5 | 7 | 0xb | 0xd | 0xf => cpu.set_a(t, 0),
            _ => {}
        },
        // RER / WER（外部寄存器，op1=0，op2=4，r=6 / 7）：调试 / 跟踪模块，读 0、写忽略
        (0, 0, 4) if r == 6 => cpu.set_a(t, 0),
        (0, 0, 4) if r == 7 => {}
        _ => return false,
    }
    cpu.write_sr(sr::PS, ps & !PS_EXCM);
    cpu.pc = epc.wrapping_add(3);
    true
}
