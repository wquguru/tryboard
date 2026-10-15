/* 特殊寄存器 RSR/WSR/XSR、用户寄存器 RUR/WUR（THREADPTR）、布尔寄存器、同步指令、
 * 非法指令与 SYSCALL 异常、MOVSP、RSIL */
#include "check.h"
    TEST_BEGIN
    /* SAR 读写与 XSR 交换 */
    movi    a3, 13
    wsr     a3, sar
    rsr     a4, sar
    EXPECT  a4, 13, 1
    movi    a5, 7
    xsr     a5, sar
    EXPECT  a5, 13, 2
    rsr     a4, sar
    EXPECT  a4, 7, 3
    /* SCOMPARE1、EXCSAVE1、MISC0 普通读写 */
    movi    a3, 0x12345678
    wsr     a3, scompare1
    rsr     a4, scompare1
    EXPECT  a4, 0x12345678, 4
    wsr     a3, misc0
    rsr     a4, misc0
    EXPECT  a4, 0x12345678, 5
    /* PRID：ESP32-S3 核 0 为 0xCDCD；QEMU 的 sim 机器不设 PRID（读 0），对照时也接受 0 */
    rsr     a4, prid
    beqz    a4, 1f
    EXPECT  a4, 0xCDCD, 6
1:
    /* THREADPTR */
    movi    a3, 0x3FC90000
    wur     a3, threadptr
    rur     a4, threadptr
    EXPECT  a4, 0x3FC90000, 7
    /* CCOUNT 单调递增 */
    rsr     a5, ccount
    nop
    nop
    rsr     a6, ccount
    sub     a7, a6, a5
    bgei    a7, 2, 1f
    movi    a2, 8
    retw
1:  /* 同步类指令都是空操作 */
    isync
    rsync
    esync
    dsync
    memw
    extw
    nop.n
    /* 布尔寄存器：BR 写 0b0101，b0 真 b1 假 */
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
    any4    b12, b4          /* b4..b7 有 1 */
    all4    b13, b4          /* b5 是 0 → 假 */
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
    /* 非法指令：EXCCAUSE 0，处理程序跳过 3 字节 */
    .byte   0x00, 0x00, 0x00   /* ILL（全 0） */
    EXC_CAUSE a4
    EXPECT  a4, 0, 15
    EXC_COUNT a4
    EXPECT  a4, 1, 16
    syscall
    EXC_CAUSE a4
    EXPECT  a4, 1, 17
    EXC_COUNT a4
    EXPECT  a4, 2, 18
    /* RSIL：返回旧 PS 并设 INTLEVEL */
    rsil    a4, 3
    extui   a5, a4, 0, 4
    EXPECT  a5, 0, 19
    rsr     a5, ps
    extui   a5, a5, 0, 4
    EXPECT  a5, 3, 20
    wsr     a4, ps
    rsync
    /* MOVSP：调用者帧（_start，WINDOWSTART 在 wb-2）还在寄存器里 → 直接传送，无异常 */
    EXC_COUNT a6
    movsp   a3, a1
    EXC_COUNT a4
    sub     a4, a4, a6
    EXPECT  a4, 0, 21
    sub     a4, a3, a1
    EXPECT  a4, 0, 22
    /* 把调用者的 WINDOWSTART 位清掉（假装已溢出到栈上）→ Alloca 异常（cause 5） */
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
