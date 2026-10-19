/* Special registers RSR/WSR/XSR, user registers RUR/WUR (THREADPTR), boolean registers, sync insns,
 * illegal-instruction and SYSCALL exceptions, MOVSP, RSIL */
#include "check.h"
    TEST_BEGIN
    /* SAR read / write and XSR swap */
    movi    a3, 13
    wsr     a3, sar
    rsr     a4, sar
    EXPECT  a4, 13, 1
    movi    a5, 7
    xsr     a5, sar
    EXPECT  a5, 13, 2
    rsr     a4, sar
    EXPECT  a4, 7, 3
    /* plain read / write of SCOMPARE1, EXCSAVE1, MISC0 */
    movi    a3, 0x12345678
    wsr     a3, scompare1
    rsr     a4, scompare1
    EXPECT  a4, 0x12345678, 4
    wsr     a3, misc0
    rsr     a4, misc0
    EXPECT  a4, 0x12345678, 5
    /* PRID: 0xCDCD on ESP32-S3 core 0; QEMU's sim machine leaves it 0, so accept 0 as well */
    rsr     a4, prid
    beqz    a4, 1f
    EXPECT  a4, 0xCDCD, 6
1:
    /* THREADPTR */
    movi    a3, 0x3FC90000
    wur     a3, threadptr
    rur     a4, threadptr
    EXPECT  a4, 0x3FC90000, 7
    /* CCOUNT increases monotonically (QEMU sim counts 40MHz virtual time, so run a while before comparing) */
    rsr     a5, ccount
    movi    a7, 200
2:  addi    a7, a7, -1
    bnez    a7, 2b
    rsr     a6, ccount
    sub     a7, a6, a5
    bgei    a7, 2, 1f
    movi    a2, 8
    retw
1:  /* sync-class insns are all no-ops */
    isync
    rsync
    esync
    dsync
    memw
    extw
    nop.n
    /* boolean registers: BR = 0b0101, b0 true, b1 false */
    movi    a3, 5
    wsr     a3, br
    movi    a4, 0
    bt      b0, 2f
    movi    a2, 9
    retw
2:  bf      b1, 3f
    movi    a2, 10
    retw
3:  andb    b4, b0, b2       /* 1&1 = 1 */
    orb     b5, b1, b3       /* 0|0 = 0 */
    xorb    b6, b0, b1       /* 1^0 = 1 */
    andbc   b7, b0, b1       /* 1&!0 = 1 */
    orbc    b8, b1, b0       /* 0|!1 = 0 */
    rsr     a4, br
    extui   a4, a4, 4, 5
    EXPECT  a4, 0b01101, 11
    any4    b12, b4          /* some of b4..b7 set */
    all4    b13, b4          /* b5 is 0 -> false */
    rsr     a4, br
    extui   a4, a4, 12, 2
    EXPECT  a4, 0b01, 12
    movi    a5, 77
    movi    a6, 1
    movt    a6, a5, b12
    EXPECT  a6, 77, 13
    movi    a6, 1
    movf    a6, a5, b12
    EXPECT  a6, 1, 14
    /* illegal instruction: EXCCAUSE 0, the handler skips 3 bytes */
    .byte   0x00, 0x00, 0x00   /* ILL (all zeros) */
    EXC_CAUSE a4
    EXPECT  a4, 0, 15
    EXC_COUNT a4
    EXPECT  a4, 1, 16
    syscall
    EXC_CAUSE a4
    EXPECT  a4, 1, 17
    EXC_COUNT a4
    EXPECT  a4, 2, 18
    /* RSIL: returns the old PS and sets INTLEVEL */
    rsil    a4, 3
    extui   a5, a4, 0, 4
    EXPECT  a5, 0, 19
    rsr     a5, ps
    extui   a5, a5, 0, 4
    EXPECT  a5, 3, 20
    wsr     a4, ps
    rsync
    /* MOVSP: the caller frame (_start, WINDOWSTART at wb-2) is still in registers -> plain move, no exception */
    EXC_COUNT a6
    movsp   a3, a1
    EXC_COUNT a4
    sub     a4, a4, a6
    EXPECT  a4, 0, 21
    sub     a4, a3, a1
    EXPECT  a4, 0, 22
    /* clear the caller's WINDOWSTART bit (pretend it spilled to the stack) -> Alloca exception (cause 5) */
    rsr     a7, windowstart
    rsr     a4, windowbase
    movi    a5, 1
    ssl     a4
    sll     a5, a5
    wsr     a5, windowstart
    rsync
    movsp   a3, a1
    wsr     a7, windowstart
    rsync
    EXC_CAUSE a4
    EXPECT  a4, 5, 23
    PASS
