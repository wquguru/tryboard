/* Shifts: SLLI / SRLI / SRAI, the SAR family SSL/SSR/SSAI/SSA8L/SSA8B and SLL/SRL/SRA/SRC */
#include "check.h"
    TEST_BEGIN
    movi    a2, 0x81234567
    slli    a4, a2, 4
    EXPECT  a4, 0x12345670, 1
    slli    a4, a2, 31
    EXPECT  a4, 0x80000000, 2
    slli    a4, a2, 1
    EXPECT  a4, 0x02468ACE, 3
    srli    a4, a2, 4
    EXPECT  a4, 0x08123456, 4
    srli    a4, a2, 15
    EXPECT  a4, 0x00010246, 5
    srai    a4, a2, 4
    EXPECT  a4, 0xF8123456, 6
    srai    a4, a2, 31
    EXPECT  a4, -1, 7
    srai    a4, a2, 16
    EXPECT  a4, 0xFFFF8123, 8
    /* SSL + SLL */
    movi    a3, 8
    ssl     a3
    sll     a4, a2
    EXPECT  a4, 0x23456700, 9
    movi    a3, 0
    ssl     a3
    sll     a4, a2
    EXPECT  a4, 0x81234567, 10
    /* SSR + SRL / SRA */
    movi    a3, 12
    ssr     a3
    srl     a4, a2
    EXPECT  a4, 0x00081234, 11
    sra     a4, a2
    EXPECT  a4, 0xFFF81234, 12
    /* SSAI + SRC (funnel shift) */
    movi    a5, 0xAABBCCDD
    ssai    8
    src     a4, a5, a2
    EXPECT  a4, 0xDD812345, 13
    ssai    0
    src     a4, a5, a2
    EXPECT  a4, 0x81234567, 14
    ssai    31
    src     a4, a5, a2
    EXPECT  a4, 0x557799BB, 15
    /* SSA8L: little-endian concatenation by byte offset */
    movi    a3, 2
    ssa8l   a3
    src     a4, a5, a2
    EXPECT  a4, 0xCCDD8123, 16
    rsr     a4, sar
    EXPECT  a4, 16, 17
    ssa8b   a3
    rsr     a4, sar
    EXPECT  a4, 16, 18
    movi    a3, 1
    ssa8b   a3
    rsr     a4, sar
    EXPECT  a4, 24, 19
    /* SAR=32: SRL yields 0 */
    movi    a3, 0
    ssl     a3
    rsr     a4, sar
    EXPECT  a4, 32, 20
    srl     a4, a2
    EXPECT  a4, 0, 21
    PASS
