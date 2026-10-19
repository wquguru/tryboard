/* Self-check macro: return the case number when reg != expected. a14 / a15 are scratch, so tests must not keep values there. */
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

/* Read the exception record (EXC_CAUSE / EXC_COUNT) into reg */
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

/* Append a value to the dump (compared byte for byte with QEMU). Clobbers a14 / a15 */
    .macro DUMP reg
    movi    a15, dump_end
    l32i    a14, a15, 0
    s32i    \reg, a14, 0
    addi    a14, a14, 4
    s32i    a14, a15, 0
    .endm

/* Read the irq_log entry count / entry n */
    .macro IRQ_COUNT reg
    movi    a15, irq_log
    l32i    \reg, a15, 0
    .endm
