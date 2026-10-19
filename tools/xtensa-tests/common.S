/* Shared by all self-tests: vectors, _start, result variables. Window handlers follow the standard windowed ABI: a0..a3
 * of a spilled frame go in the 16-byte base save area below the callee's sp, call8 / call12 extras at the end of the caller's frame.
 * test_main returns a2 = 0 on pass, else the failing case; _start stores result = 0x600D or 0xBAD00000|case.
 * SIMCALL semihosting (QEMU -semihosting and our runner) then writes result + the DUMP buffer to stdout: byte compare = QEMU diff.
 * Interrupts (level 2..7 vectors and level-1, EXCCAUSE=4) log (level, pending & enabled & level mask) to irq_log, clear those
 * INTENABLE bits so they don't re-enter, then RFI / RFE. lint: allow-long-comment */

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
    l32e    a0, a1, -12        /* a0 <- this frame's caller sp; the extra registers live below it */
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
    .org 0x280                 /* Level6 (debug) */
    break   1, 2
    .org 0x2C0                 /* NMI (level 7) */
    wsr     a2, excsave7
    j       hi7

    .org 0x300                 /* KernelExceptionVector */
    wsr     a2, excsave1
    j       exc_common

    .org 0x340                 /* UserExceptionVector */
    wsr     a2, excsave1
    j       exc_common

    .org 0x3C0                 /* DoubleExceptionVector: should never happen */
    break   1, 1
    .org 0x400

    .text
    .global _start
    .align  4
_start:
    movi    a1, 0x400ffff0     /* stack top */
    /* The bottom frame has no caller: put a fake "caller sp" at sp-12 so the overflow handler can store a4..a11 there */
    movi    a2, 0x400ff800
    addi    a3, a1, -12
    s32i    a2, a3, 0
    movi    a2, 1
    wsr     a2, windowstart
    movi    a2, 0
    wsr     a2, windowbase
    rsync
    /* ATOMCTL: QEMU's sim machine treats memory as bypass, so S32C1I faults with the reset value 0x28;
       0x2a (internal atomics on bypass too) matches what IDF actually gets on S3 */
    movi    a2, 0x2a
    wsr     a2, atomctl
    movi    a2, 0x40020        /* PS.WOE=1, UM=1, EXCM=0, INTLEVEL=0 */
    wsr     a2, ps
    rsync
    call8   test_main
    movi    a3, result
    movi    a4, 0x600D
    beqz    a10, 1f
    movi    a4, 0xBAD00000
    or      a4, a4, a10
1:  s32i    a4, a3, 0
    /* Semihosting output: result, dump length, dump contents; then exit */
    movi    a2, 0                  /* mask interrupts so output isn't interrupted */
    wsr     a2, intenable
    movi    a5, dump_end
    l32i    a5, a5, 0
    movi    a4, dump
    sub     a5, a5, a4
    movi    a3, dump_len
    s32i    a5, a3, 0
    movi    a2, 4                  /* SYS_write(1, result, 8): result + dump_len */
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

/* Generic high-priority interrupt handler: \lvl level, \mask that level's line mask (core-isa.h) */
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
    and     a3, a3, a5             /* a3 = lines pending and enabled at this level */
    xor     a4, a4, a3
    wsr     a4, intenable          /* disable them */
    movi    a5, \lvl << 24
    or      a3, a3, a5
    movi    a4, irq_log
    l32i    a5, a4, 0              /* irq_log[0] = entry count */
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

/* Exception: record EXCCAUSE and a count, skip the faulting insn (tests only fault on 24-bit insns), RFE. EXCCAUSE=4 (level-1
 * interrupt) is handled as an interrupt; EXCCAUSE=32 (CP0 disabled) with cp_lazy != 0 sets CPENABLE and retries, like FreeRTOS. */
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
    movi    a5, 0x000637FF         /* level-1 lines */
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
dump_len:   .word 0        /* right after result, printed with it */
exc_save:   .word 0        /* +0 a3 scratch */
exc_cause:  .word 0        /* +4 last EXCCAUSE */
exc_count:  .word 0        /* +8 exception count */
            .word 0, 0     /* +12 / +16 a4 / a5 scratch */
cp_lazy:    .word 0        /* non-zero: on CP-disabled exception, set CPENABLE and retry */
dump_end:   .word dump     /* DUMP write pointer */
irq_log:    .space 4 * 33  /* [0] count, then entries (level<<24)|line mask */
hisave:     .space 16 * 8
dump:       .space 4 * 16000
