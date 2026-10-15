/* 零开销循环：LOOP / LOOPNEZ / LOOPGTZ，计数为 0 / 负数时跳过，嵌套 RSR LCOUNT */
#include "check.h"
    TEST_BEGIN
    /* LOOP 10 次 */
    movi    a3, 10
    movi    a4, 0
    loop    a3, 1f
    addi    a4, a4, 3
1:  EXPECT  a4, 30, 1
    /* 循环体多条指令（含窄指令） */
    movi    a3, 5
    movi    a4, 0
    movi    a5, 0
    loop    a3, 2f
    addi.n  a4, a4, 1
    add.n   a5, a5, a4
2:  EXPECT  a4, 5, 2
    EXPECT  a5, 15, 3
    /* LOOPNEZ：计数 0 直接跳过 */
    movi    a3, 0
    movi    a4, 7
    loopnez a3, 3f
    addi    a4, a4, 1
3:  EXPECT  a4, 7, 4
    /* LOOPGTZ：负数跳过 */
    movi    a3, -4
    loopgtz a3, 4f
    addi    a4, a4, 1
4:  EXPECT  a4, 7, 5
    /* LOOPGTZ 正数正常执行 */
    movi    a3, 4
    loopgtz a3, 5f
    addi    a4, a4, 1
5:  EXPECT  a4, 11, 6
    /* 循环结束后 LCOUNT 为 0，LBEG/LEND 可读 */
    rsr     a6, lcount
    EXPECT  a6, 0, 7
    /* 循环体最后一条是跳转：跳转优先，退出循环 */
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
