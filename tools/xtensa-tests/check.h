/* 自检宏：寄存器不等于期望值时返回用例编号。a14 / a15 作临时寄存器，测试不要用它们存值。 */
    .macro EXPECT reg, val, case
    movi    a14, \val
    beq     \reg, a14, .Lok\@
    movi    a2, \case
    retw
.Lok\@:
    .endm

    .macro PASS
    movi    a2, 0
    retw
    .endm

/* 读异常记录：EXC_CAUSE / EXC_COUNT 到 reg */
    .macro EXC_CAUSE reg
    movi    a15, exc_save
    l32i    \reg, a15, 4
    .endm
    .macro EXC_COUNT reg
    movi    a15, exc_save
    l32i    \reg, a15, 8
    .endm

    .macro TEST_BEGIN
    .text
    .global test_main
    .align  4
test_main:
    entry   a1, 64
    .endm

/* 追加一个值到 dump（与 QEMU 逐字节对照）。用 a14 / a15 */
    .macro DUMP reg
    movi    a15, dump_end
    l32i    a14, a15, 0
    s32i    \reg, a14, 0
    addi    a14, a14, 4
    s32i    a14, a15, 0
    .endm

/* 读 irq_log 条数 / 第 n 条 */
    .macro IRQ_COUNT reg
    movi    a15, irq_log
    l32i    \reg, a15, 0
    .endm
