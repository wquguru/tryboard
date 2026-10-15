/* 访存：L8UI/L16UI/L16SI/L32I/S8I/S16I/S32I、窄指令 L32I.N/S32I.N、L32R、L32AI/S32RI、S32C1I、非对齐 */
#include "check.h"
    TEST_BEGIN
    movi    a2, buf
    movi    a3, 0x8899AABB
    s32i    a3, a2, 0
    l32i    a4, a2, 0
    EXPECT  a4, 0x8899AABB, 1
    l8ui    a4, a2, 0
    EXPECT  a4, 0xBB, 2
    l8ui    a4, a2, 3
    EXPECT  a4, 0x88, 3
    l16ui   a4, a2, 2
    EXPECT  a4, 0x8899, 4
    l16si   a4, a2, 2
    EXPECT  a4, 0xFFFF8899, 5
    l16si   a4, a2, 0
    EXPECT  a4, 0xFFFFAABB, 6
    movi    a3, 0x12
    s8i     a3, a2, 1
    l32i    a4, a2, 0
    EXPECT  a4, 0x889912BB, 7
    movi    a3, 0x3456
    s16i    a3, a2, 2
    l32i    a4, a2, 0
    EXPECT  a4, 0x345612BB, 8
    /* 大偏移：l32i 偏移 1020 */
    movi    a3, 0xCAFE
    s32i    a3, a2, 1020
    l32i    a4, a2, 1020
    EXPECT  a4, 0xCAFE, 9
    /* 窄指令 */
    movi    a3, 77
    s32i.n  a3, a2, 60
    l32i.n  a4, a2, 60
    EXPECT  a4, 77, 10
    /* L32R：取字面量池里的常数 */
    l32r    a4, lit_const
    EXPECT  a4, 0xDEADBEEF, 11
    /* L32AI / S32RI */
    movi    a3, 0x1111
    s32ri   a3, a2, 8
    l32ai   a4, a2, 8
    EXPECT  a4, 0x1111, 12
    /* S32C1I：相等才写入，at 总拿到旧值 */
    movi    a3, 5
    s32i    a3, a2, 16
    movi    a5, 5
    wsr     a5, scompare1
    movi    a6, 9
    s32c1i  a6, a2, 16
    EXPECT  a6, 5, 13
    l32i    a4, a2, 16
    EXPECT  a4, 9, 14
    movi    a6, 11
    s32c1i  a6, a2, 16
    EXPECT  a6, 9, 15
    l32i    a4, a2, 16
    EXPECT  a4, 9, 16
    /* 非对齐（S3 硬件支持） */
    movi    a3, 0x44332211
    s32i    a3, a2, 32
    movi    a3, 0x88776655
    s32i    a3, a2, 36
    addi    a7, a2, 33
    l32i    a4, a7, 0
    EXPECT  a4, 0x55443322, 17
    PASS

    .literal_position
    .section .literal, "a"
    .align 4
lit_const: .word 0xDEADBEEF

    .data
    .align 4
buf: .space 1100
