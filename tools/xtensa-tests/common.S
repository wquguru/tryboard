/* 所有自检测试共用：向量表（窗口溢出 / 下溢、User / Kernel / Double 异常）、_start、结果变量。
 * 窗口处理程序按 Xtensa 窗口 ABI 的标准做法自行编写：被溢出帧的 a0..a3 存在被调用者 sp 下方
 * 16 字节的"基本保存区"，call8 / call12 帧多出的寄存器存在本帧调用者的栈帧末尾。
 *
 * 约定：每个测试提供窗口函数 test_main，返回 a2 = 0 表示通过，否则为失败用例编号。
 * _start 把结果写到 result：0x600D 通过，0xBAD00000|编号 失败。
 *
 * 结束时用半主机调用（SIMCALL，QEMU -semihosting 与我们的测试运行器都支持）把
 * result 和 dump 缓冲区写到 stdout，再 SYS_exit。两边的输出逐字节比较 = 与 QEMU 的差分对照。
 * 测试用 DUMP 宏（check.h）往 dump 里追加任意要对照的值。
 *
 * 中断：level 2..7 向量与 level-1（EXCCAUSE=4）都走通用处理：记下（级别, 挂起&使能&本级别掩码）
 * 到 irq_log，再从 INTENABLE 里关掉这些位（避免反复进入），然后 RFI / RFE 返回。 */

    .section .vectors, "ax"
    .global _vectors
_vectors:
    .org 0x000                 /* WindowOverflow4 */
    s32e    a0, a5, -16
    s32e    a1, a5, -12
    s32e    a2, a5, -8
    s32e    a3, a5, -4
    rfwo

    .org 0x040                 /* WindowUnderflow4 */
    l32e    a0, a5, -16
    l32e    a1, a5, -12
    l32e    a2, a5, -8
    l32e    a3, a5, -4
    rfwu

    .org 0x080                 /* WindowOverflow8 */
    s32e    a0, a9, -16
    l32e    a0, a1, -12        /* a0 ← 本帧调用者的 sp，扩展寄存器存在它下面 */
    s32e    a1, a9, -12
    s32e    a2, a9, -8
    s32e    a3, a9, -4
    s32e    a4, a0, -32
    s32e    a5, a0, -28
    s32e    a6, a0, -24
    s32e    a7, a0, -20
    rfwo

    .org 0x0C0                 /* WindowUnderflow8 */
    l32e    a1, a9, -12
    l32e    a0, a9, -16
    l32e    a7, a1, -12
    l32e    a2, a9, -8
    l32e    a4, a7, -32
    l32e    a3, a9, -4
    l32e    a5, a7, -28
    l32e    a6, a7, -24
    l32e    a7, a7, -20
    rfwu

    .org 0x100                 /* WindowOverflow12 */
    s32e    a0, a13, -16
    l32e    a0, a1, -12
    s32e    a1, a13, -12
    s32e    a2, a13, -8
    s32e    a3, a13, -4
    s32e    a4, a0, -48
    s32e    a5, a0, -44
    s32e    a6, a0, -40
    s32e    a7, a0, -36
    s32e    a8, a0, -32
    s32e    a9, a0, -28
    s32e    a10, a0, -24
    s32e    a11, a0, -20
    rfwo

    .org 0x140                 /* WindowUnderflow12 */
    l32e    a1, a13, -12
    l32e    a0, a13, -16
    l32e    a11, a1, -12
    l32e    a2, a13, -8
    l32e    a4, a11, -48
    l32e    a8, a11, -32
    l32e    a3, a13, -4
    l32e    a5, a11, -44
    l32e    a6, a11, -40
    l32e    a7, a11, -36
    l32e    a9, a11, -28
    l32e    a10, a11, -24
    l32e    a11, a11, -20
    rfwu

    .org 0x180                 /* Level2InterruptVector */
    wsr     a2, excsave2
    j       hi2
    .org 0x1C0                 /* Level3 */
    wsr     a2, excsave3
    j       hi3
    .org 0x200                 /* Level4 */
    wsr     a2, excsave4
    j       hi4
    .org 0x240                 /* Level5 */
    wsr     a2, excsave5
    j       hi5
    .org 0x280                 /* Level6（调试） */
    break   1, 2
    .org 0x2C0                 /* NMI（level 7） */
    wsr     a2, excsave7
    j       hi7

    .org 0x300                 /* KernelExceptionVector */
    wsr     a2, excsave1
    j       exc_common

    .org 0x340                 /* UserExceptionVector */
    wsr     a2, excsave1
    j       exc_common

    .org 0x3C0                 /* DoubleExceptionVector：不应发生 */
    break   1, 1
    .org 0x400

    .text
    .global _start
    .align  4
_start:
    movi    a1, 0x400ffff0     /* 栈顶 */
    /* 最底层帧没有调用者：在 sp-12 放一个假的"调用者 sp"，溢出处理程序把本帧的 a4..a11 存到那里 */
    movi    a2, 0x400ff800
    addi    a3, a1, -12
    s32i    a2, a3, 0
    movi    a2, 1
    wsr     a2, windowstart
    movi    a2, 0
    wsr     a2, windowbase
    rsync
    /* ATOMCTL：QEMU sim 机器的内存按 bypass 属性，复位值 0x28 下 S32C1I 会异常；
       改成 0x2a（bypass 区也做内部原子操作），与 S3 上 IDF 的实际行为一致 */
    movi    a2, 0x2a
    wsr     a2, atomctl
    movi    a2, 0x40020        /* PS.WOE=1、UM=1、EXCM=0、INTLEVEL=0 */
    wsr     a2, ps
    rsync
    call8   test_main
    movi    a3, result
    movi    a4, 0x600D
    beqz    a10, 1f
    movi    a4, 0xBAD00000
    or      a4, a4, a10
1:  s32i    a4, a3, 0
    /* 半主机输出：result、dump 长度、dump 内容；然后退出 */
    movi    a2, 0                  /* 关中断，免得输出途中被打断 */
    wsr     a2, intenable
    movi    a5, dump_end
    l32i    a5, a5, 0
    movi    a4, dump
    sub     a5, a5, a4
    movi    a3, dump_len
    s32i    a5, a3, 0
    movi    a2, 4                  /* SYS_write(1, result, 8)：result + dump_len */
    movi    a3, 1
    movi    a4, result
    movi    a5, 8
    simcall
    movi    a2, 4                  /* SYS_write(1, dump, len) */
    movi    a3, 1
    movi    a4, dump
    movi    a5, dump_len
    l32i    a5, a5, 0
    simcall
    movi    a2, 1                  /* SYS_exit(0) */
    movi    a3, 0
    simcall
    break   1, 15

/* 高优先级中断通用处理：\lvl 级别，\mask 该级别的中断线掩码（core-isa.h） */
    .macro HI_HANDLER lvl, mask
    .align  4
hi\lvl:
    movi    a2, hisave + \lvl * 16
    s32i    a3, a2, 0
    s32i    a4, a2, 4
    s32i    a5, a2, 8
    rsr     a3, interrupt
    rsr     a4, intenable
    and     a3, a3, a4
    movi    a5, \mask
    and     a3, a3, a5             /* a3 = 本级别挂起且使能的线 */
    xor     a4, a4, a3
    wsr     a4, intenable          /* 关掉它们 */
    movi    a5, \lvl << 24
    or      a3, a3, a5
    movi    a4, irq_log
    l32i    a5, a4, 0              /* irq_log[0] = 条数 */
    addi    a5, a5, 1
    s32i    a5, a4, 0
    addx4   a4, a5, a4
    s32i    a3, a4, 0
    movi    a2, hisave + \lvl * 16
    l32i    a3, a2, 0
    l32i    a4, a2, 4
    l32i    a5, a2, 8
    rsr     a2, excsave\lvl
    rfi     \lvl
    .endm

    HI_HANDLER 2, 0x00380000
    HI_HANDLER 3, 0x28C08800
    HI_HANDLER 4, 0x53000000
    HI_HANDLER 5, 0x84010000
    HI_HANDLER 7, 0x00004000

/* 异常：记录 EXCCAUSE、计数，跳过出错指令（测试只在 24 位指令上制造异常），RFE 返回。
 * EXCCAUSE=4（level-1 中断）：按中断处理，不跳指令。
 * EXCCAUSE=32（协处理器 0 禁用）且 cp_lazy≠0：像 FreeRTOS 那样打开 CPENABLE 后重新执行该指令。 */
    .align  4
exc_common:
    movi    a2, exc_save
    s32i    a3, a2, 0
    rsr     a3, exccause
    s32i    a3, a2, 4
    beqi    a3, 4, lvl1_irq
    l32i    a3, a2, 8
    addi    a3, a3, 1
    s32i    a3, a2, 8
    l32i    a3, a2, 4
    bnei    a3, 32, 2f
    movi    a3, cp_lazy
    l32i    a3, a3, 0
    beqz    a3, 2f
    movi    a3, 1
    wsr     a3, cpenable
    rsync
    j       3f
2:  rsr     a3, epc1
    addi    a3, a3, 3
    wsr     a3, epc1
3:  l32i    a3, a2, 0
    rsr     a2, excsave1
    rfe

lvl1_irq:
    s32i    a4, a2, 12
    s32i    a5, a2, 16
    rsr     a3, interrupt
    rsr     a4, intenable
    and     a3, a3, a4
    movi    a5, 0x000637FF         /* level-1 线 */
    and     a3, a3, a5
    xor     a4, a4, a3
    wsr     a4, intenable
    movi    a5, 1 << 24
    or      a3, a3, a5
    movi    a4, irq_log
    l32i    a5, a4, 0
    addi    a5, a5, 1
    s32i    a5, a4, 0
    addx4   a4, a5, a4
    s32i    a3, a4, 0
    movi    a2, exc_save
    l32i    a3, a2, 0
    l32i    a4, a2, 12
    l32i    a5, a2, 16
    rsr     a2, excsave1
    rfe

    .data
    .global result, exc_save, dump, dump_end, irq_log, cp_lazy
    .align  4
result:     .word 0
dump_len:   .word 0        /* 紧跟 result，一起输出 */
exc_save:   .word 0        /* +0 a3 暂存 */
exc_cause:  .word 0        /* +4 最近一次 EXCCAUSE */
exc_count:  .word 0        /* +8 异常次数 */
            .word 0, 0     /* +12 / +16 a4 / a5 暂存 */
cp_lazy:    .word 0        /* 非 0：协处理器禁用异常时打开 CPENABLE 并重试 */
dump_end:   .word dump     /* DUMP 写指针 */
irq_log:    .space 4 * 33  /* [0] 条数，之后每条 (级别<<24)|线掩码 */
hisave:     .space 16 * 8
dump:       .space 4 * 6000
