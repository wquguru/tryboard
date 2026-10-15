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
