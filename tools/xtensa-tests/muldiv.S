/* Multiply / divide: MUL16U/S, MULL, MULUH, MULSH, QUOU/QUOS/REMU/REMS and divide-by-zero (EXCCAUSE 6) */
#include "check.h"
    TEST_BEGIN
    movi    a2, 0x12340003
    movi    a3, 0x5678FFFE
    mul16u  a4, a2, a3
    EXPECT  a4, 0x0002FFFA, 1
    mul16s  a4, a2, a3
    EXPECT  a4, -6, 2
    movi    a2, 100000
    movi    a3, 70000
    mull    a4, a2, a3
    EXPECT  a4, 0xA13B8600, 3
    muluh   a4, a2, a3
    EXPECT  a4, 1, 4
    movi    a2, -100000
    mulsh   a4, a2, a3
    EXPECT  a4, -2, 5
    muluh   a4, a2, a3
    EXPECT  a4, 69998, 6
    movi    a2, 1000
    movi    a3, 7
    quou    a4, a2, a3
    EXPECT  a4, 142, 7
    remu    a4, a2, a3
    EXPECT  a4, 6, 8
    movi    a2, -1000
    quos    a4, a2, a3
    EXPECT  a4, -142, 9
    rems    a4, a2, a3
    EXPECT  a4, -6, 10
    quou    a4, a2, a3
    EXPECT  a4, 613566613, 11
    /* -2^31 / -1: hardware defines the result as -2^31, remainder 0 */
    movi    a2, 0x80000000
    movi    a3, -1
    quos    a4, a2, a3
    EXPECT  a4, 0x80000000, 12
    rems    a4, a2, a3
    EXPECT  a4, 0, 13
    /* Divide by zero: IntegerDivideByZero, the handler skips the insn; the destination stays unchanged */
    movi    a3, 0
    movi    a4, 55
    quou    a4, a2, a3
    EXPECT  a4, 55, 14
    EXC_CAUSE a5
    EXPECT  a5, 6, 15
    EXC_COUNT a5
    EXPECT  a5, 1, 16
    rems    a4, a2, a3
    EXC_COUNT a5
    EXPECT  a5, 2, 17
    PASS
