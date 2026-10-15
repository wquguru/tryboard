/* 所有自检测试共用：向量表（窗口溢出 / 下溢、User / Kernel / Double 异常）、_start、结果变量。
 * 窗口处理程序按 Xtensa 窗口 ABI 的标准做法自行编写：被溢出帧的 a0..a3 存在被调用者 sp 下方
 * 16 字节的"基本保存区"，call8 / call12 帧多出的寄存器存在本帧调用者的栈帧末尾。
 *
 * 约定：每个测试提供窗口函数 test_main，返回 a2 = 0 表示通过，否则为失败用例编号。
 * _start 把结果写到 result：0x600D 通过，0xBAD00000|编号 失败，然后 BREAK 结束。 */

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
    movi    a2, 0x40020        /* PS.WOE=1、UM=1、EXCM=0、INTLEVEL=0 */
    wsr     a2, ps
    rsync
    call8   test_main
    movi    a3, result
    beqz    a10, 1f
    movi    a4, 0xBAD00000
    or      a4, a4, a10
    s32i    a4, a3, 0
    break   1, 15
1:  movi    a4, 0x600D
    s32i    a4, a3, 0
    break   1, 15

/* 异常：记录 EXCCAUSE、计数，跳过出错指令（测试只在 24 位指令上制造异常），RFE 返回 */
    .align  4
exc_common:
    movi    a2, exc_save
    s32i    a3, a2, 0
    rsr     a3, exccause
    s32i    a3, a2, 4
    l32i    a3, a2, 8
    addi    a3, a3, 1
    s32i    a3, a2, 8
    rsr     a3, epc1
    addi    a3, a3, 3
    wsr     a3, epc1
    l32i    a3, a2, 0
    rsr     a2, excsave1
    rfe

    .data
    .global result, exc_save
    .align  4
result:     .word 0
exc_save:   .word 0        /* +0 a3 暂存 */
exc_cause:  .word 0        /* +4 最近一次 EXCCAUSE */
exc_count:  .word 0        /* +8 异常次数 */
