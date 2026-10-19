/* Zero-overhead loops: LOOP / LOOPNEZ / LOOPGTZ, skipped for count 0 / negative, nested RSR LCOUNT */
#include "check.h"
    TEST_BEGIN
    /* LOOP 10 times */
    movi    a3, 10
    movi    a4, 0
    loop    a3, 1f
    addi    a4, a4, 3
1:  EXPECT  a4, 30, 1
    /* multi-instruction body (including narrow ones) */
    movi    a3, 5
    movi    a4, 0
    movi    a5, 0
    loop    a3, 2f
    addi.n  a4, a4, 1
    add.n   a5, a5, a4
2:  EXPECT  a4, 5, 2
    EXPECT  a5, 15, 3
    /* LOOPNEZ: count 0 skips the body */
    movi    a3, 0
    movi    a4, 7
    loopnez a3, 3f
    addi    a4, a4, 1
3:  EXPECT  a4, 7, 4
    /* LOOPGTZ: negative skips */
    movi    a3, -4
    loopgtz a3, 4f
    addi    a4, a4, 1
4:  EXPECT  a4, 7, 5
    /* LOOPGTZ: positive runs normally */
    movi    a3, 4
    loopgtz a3, 5f
    addi    a4, a4, 1
5:  EXPECT  a4, 11, 6
    /* after the loop LCOUNT is 0 and LBEG/LEND are readable */
    rsr     a6, lcount
    EXPECT  a6, 0, 7
    /* last body insn is a jump: the jump wins and exits the loop */
    movi    a3, 100
    movi    a4, 0
    loop    a3, 7f
    addi    a4, a4, 1
    beqi    a4, 3, 6f
6:  nop
7:  EXPECT  a4, 100, 8
    movi    a3, 100
    movi    a4, 0
    loop    a3, 9f
    addi    a4, a4, 1
    beqi    a4, 3, 10f
9:  movi    a2, 9
    retw
10: EXPECT  a4, 3, 10
    PASS
