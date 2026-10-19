/* Arithmetic / logic / immediates / conditional moves / NSA / SEXT / CLAMPS / MIN / MAX / EXTUI */
#include "check.h"
    TEST_BEGIN
    movi    a2, 100
    movi    a3, 23
    add     a4, a2, a3
    EXPECT  a4, 123, 1
    sub     a4, a2, a3
    EXPECT  a4, 77, 2
    addx2   a4, a3, a2
    EXPECT  a4, 146, 3
    addx4   a4, a3, a2
    EXPECT  a4, 192, 4
    addx8   a4, a3, a2
    EXPECT  a4, 284, 5
    subx2   a4, a3, a2
    EXPECT  a4, -54, 6
    subx4   a4, a3, a2
    EXPECT  a4, -8, 7
    subx8   a4, a3, a2
    EXPECT  a4, 84, 8
    movi    a5, 0xF0F0
    movi    a6, 0x0FF0
    and     a4, a5, a6
    EXPECT  a4, 0x00F0, 9
    or      a4, a5, a6
    EXPECT  a4, 0xFFF0, 10
    xor     a4, a5, a6
    EXPECT  a4, 0xFF00, 11
    neg     a4, a3
    EXPECT  a4, -23, 12
    movi    a7, -9
    abs     a4, a7
    EXPECT  a4, 9, 13
    addi    a4, a2, -100
    EXPECT  a4, 0, 14
    addmi   a4, a2, 0x1200
    EXPECT  a4, 0x1264, 15
    movi    a4, -2048
    EXPECT  a4, -2048, 16
    movi.n  a4, -32
    EXPECT  a4, -32, 17
    movi.n  a4, 95
    EXPECT  a4, 95, 18
    add.n   a4, a2, a3
    EXPECT  a4, 123, 19
    addi.n  a4, a2, -1
    EXPECT  a4, 99, 20
    addi.n  a4, a2, 15
    EXPECT  a4, 115, 21
    mov.n   a4, a3
    EXPECT  a4, 23, 22
    mov     a4, a2
    EXPECT  a4, 100, 23
    /* EXTUI */
    movi    a5, 0x12345678
    extui   a4, a5, 8, 12
    EXPECT  a4, 0x456, 24
    extui   a4, a5, 28, 4
    EXPECT  a4, 0x1, 25
    extui   a4, a5, 16, 16
    EXPECT  a4, 0x1234, 26
    /* SEXT / CLAMPS */
    movi    a5, 0x80
    sext    a4, a5, 7
    EXPECT  a4, -128, 27
    movi    a5, 0x7fff
    sext    a4, a5, 15
    EXPECT  a4, 0x7fff, 28
    movi    a5, 300
    clamps  a4, a5, 7
    EXPECT  a4, 127, 29
    movi    a5, -300
    clamps  a4, a5, 7
    EXPECT  a4, -128, 30
    movi    a5, 50
    clamps  a4, a5, 7
    EXPECT  a4, 50, 31
    /* MIN / MAX */
    movi    a5, -5
    movi    a6, 3
    min     a4, a5, a6
    EXPECT  a4, -5, 32
    max     a4, a5, a6
    EXPECT  a4, 3, 33
    minu    a4, a5, a6
    EXPECT  a4, 3, 34
    maxu    a4, a5, a6
    EXPECT  a4, -5, 35
    /* MOVxxZ */
    movi    a4, 1
    movi    a5, 2
    movi    a6, 0
    moveqz  a4, a5, a6
    EXPECT  a4, 2, 36
    movi    a4, 1
    movnez  a4, a5, a6
    EXPECT  a4, 1, 37
    movi    a6, -1
    movltz  a4, a5, a6
    EXPECT  a4, 2, 38
    movi    a4, 1
    movgez  a4, a5, a6
    EXPECT  a4, 1, 39
    /* NSA / NSAU */
    movi    a5, 1
    nsa     a4, a5
    EXPECT  a4, 30, 40
    movi    a5, -1
    nsa     a4, a5
    EXPECT  a4, 31, 41
    movi    a5, 0
    nsa     a4, a5
    EXPECT  a4, 31, 42
    movi    a5, 0x00800000
    nsau    a4, a5
    EXPECT  a4, 8, 43
    movi    a5, 0
    nsau    a4, a5
    EXPECT  a4, 32, 44
    movi    a5, -2
    nsa     a4, a5
    EXPECT  a4, 30, 45
    PASS
