/* 中断：软件中断（level 1 / 3）、INTLEVEL 与 EXCM 屏蔽、CCOMPARE 定时器（level 1 / 3 / 5）、WAITI 唤醒、
 * INTCLEAR、写 CCOMPARE 清定时器挂起位。处理程序在 common.S：记 irq_log、关掉对应 INTENABLE 位后返回。
 * irq_log 的每条和关键寄存器都 DUMP 出来与 QEMU 对照。 */
#include "check.h"

/* 等 irq_log 条数变成 \n（最多转 20000 圈），条数留在 \reg */
    .macro WAIT_IRQ n, reg
    movi    a13, 20000
.Lw\@:
    IRQ_COUNT \reg
    bgei    \reg, \n, .Ld\@
    addi    a13, a13, -1
    bnez    a13, .Lw\@
.Ld\@:
    .endm

/* 最近一条 irq_log → \reg */
    .macro LAST_IRQ reg
    movi    a15, irq_log
    l32i    a14, a15, 0
    addx4   a15, a14, a15
    l32i    \reg, a15, 0
    .endm

    TEST_BEGIN
    /* ---- 1. 软件中断 7（level 1）：INTSET 后立即进入，EXCCAUSE=4 */
    movi    a3, 1 << 7
    wsr     a3, intenable
    wsr     a3, intset
    rsync
    nop
    WAIT_IRQ 1, a4
    EXPECT  a4, 1, 1
    LAST_IRQ a5
    DUMP    a5
    EXPECT  a5, (1 << 24) | (1 << 7), 2
    EXC_CAUSE a6
    EXPECT  a6, 4, 3
    /* 软件中断挂起位要靠 INTCLEAR 清 */
    rsr     a6, interrupt
    extui   a6, a6, 7, 1
    DUMP    a6
    EXPECT  a6, 1, 4
    wsr     a3, intclear
    rsr     a6, interrupt
    extui   a6, a6, 7, 1
    EXPECT  a6, 0, 5

    /* ---- 2. INTLEVEL=1 屏蔽 level 1；降回 0 后进入 */
    rsil    a7, 1
    wsr     a3, intenable
    wsr     a3, intset
    rsync
    nop
    nop
    IRQ_COUNT a4
    EXPECT  a4, 1, 6
    wsr     a7, ps
    rsync
    WAIT_IRQ 2, a4
    EXPECT  a4, 2, 7
    wsr     a3, intclear

    /* ---- 3. 软件中断 29（level 3）：INTLEVEL=2 时可进入，INTLEVEL=3 时被屏蔽 */
    movi    a3, 1 << 29
    rsil    a7, 3
    wsr     a3, intenable
    wsr     a3, intset
    rsync
    nop
    IRQ_COUNT a4
    EXPECT  a4, 2, 8
    rsil    a8, 2
    rsync
    WAIT_IRQ 3, a4
    EXPECT  a4, 3, 9
    LAST_IRQ a5
    DUMP    a5
    EXPECT  a5, (3 << 24) | (1 << 29), 10
    /* RFI 3 恢复了进中断前的 PS（INTLEVEL=2） */
    rsr     a6, ps
    extui   a6, a6, 0, 5
    DUMP    a6
    EXPECT  a6, 2, 11
    wsr     a7, ps
    rsync
    wsr     a3, intclear

    /* ---- 4. CCOMPARE0（中断 6，level 1）：到点挂起；写 CCOMPARE0 清除 */
    movi    a3, 1 << 6
    rsr     a4, ccount
    addi    a4, a4, 60
    wsr     a4, ccompare0
    wsr     a3, intenable
    rsync
    WAIT_IRQ 4, a4
    EXPECT  a4, 4, 12
    LAST_IRQ a5
    DUMP    a5
    EXPECT  a5, (1 << 24) | (1 << 6), 13
    rsr     a6, interrupt
    extui   a6, a6, 6, 1
    DUMP    a6
    EXPECT  a6, 1, 14
    rsr     a4, ccompare0
    wsr     a4, ccompare0
    rsr     a6, interrupt
    extui   a6, a6, 6, 1
    EXPECT  a6, 0, 15

    /* ---- 5. PS.EXCM=1 屏蔽 ≤3 级：level-3 的 CCOMPARE1 不进，level-5 的 CCOMPARE2 能进 */
    rsr     a7, ps
    movi    a3, (1 << 15) | (1 << 16)
    rsr     a4, ccount
    addi    a4, a4, 40
    wsr     a4, ccompare1
    wsr     a4, ccompare2
    movi    a5, 0x10               /* EXCM=1、INTLEVEL=0 */
    or      a5, a7, a5
    wsr     a5, ps
    wsr     a3, intenable
    rsync
    WAIT_IRQ 5, a4
    EXPECT  a4, 5, 16
    LAST_IRQ a5
    DUMP    a5
    EXPECT  a5, (5 << 24) | (1 << 16), 17
    /* 中断 15 仍挂着（被 EXCM 挡住）；回到 EXCM=0 后进入 level 3 */
    rsr     a6, interrupt
    extui   a6, a6, 15, 1
    DUMP    a6
    EXPECT  a6, 1, 18
    wsr     a7, ps
    rsync
    WAIT_IRQ 6, a4
    EXPECT  a4, 6, 19
    LAST_IRQ a5
    DUMP    a5
    EXPECT  a5, (3 << 24) | (1 << 15), 20
    rsr     a4, ccompare1
    wsr     a4, ccompare1
    rsr     a4, ccompare2
    wsr     a4, ccompare2

    /* ---- 6. WAITI：睡到 CCOMPARE1 到点，处理完回到 WAITI 之后 */
    movi    a3, 1 << 15
    rsr     a4, ccount
    addi    a4, a4, 100
    wsr     a4, ccompare1
    wsr     a3, intenable
    rsync
    waiti   0
    IRQ_COUNT a4
    DUMP    a4
    EXPECT  a4, 7, 21
    LAST_IRQ a5
    EXPECT  a5, (3 << 24) | (1 << 15), 22
    rsr     a4, ccompare1
    wsr     a4, ccompare1

    /* ---- 7. INTSET 只能置软件中断位 */
    movi    a3, 0
    wsr     a3, intenable
    movi    a3, -1
    wsr     a3, intset
    rsr     a6, interrupt
    movi    a5, (1 << 7) | (1 << 29)
    and     a5, a6, a5
    DUMP    a5
    EXPECT  a5, (1 << 7) | (1 << 29), 23
    wsr     a3, intclear
    rsr     a6, interrupt
    movi    a5, (1 << 7) | (1 << 29)
    and     a6, a6, a5
    EXPECT  a6, 0, 24
    PASS
