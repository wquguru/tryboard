/* Windowed ABI: CALL4/8/12, CALLX8, ENTRY/RETW, deep recursion (overflow / underflow), MOVSP, ROTW, RETW.N */
#include "check.h"
    TEST_BEGIN
    /* deep recursion fib(20) via call8: depth 20, far beyond 16 quads */
    movi    a10, 20
    call8   fib8
    EXPECT  a10, 6765, 1
    /* call12 recursive sum 1..40 */
    movi    a14, 40
    call12  sum12
    EXPECT  a14, 820, 2
    /* call4 recursive sum 1..30 */
    movi    a6, 30
    call4   sum4
    EXPECT  a6, 465, 3
    /* mixed: call8 -> call4 -> call12 chain */
    movi    a10, 12
    call8   mix8
    EXPECT  a10, 12 * 7, 4
    /* CALLX8 */
    movi    a9, fib8
    movi    a10, 10
    callx8  a9
    EXPECT  a10, 55, 5
    /* this frame's registers survive the recursion */
    movi    a3, 0x5A5A
    movi    a10, 18
    call8   fib8
    EXPECT  a3, 0x5A5A, 6
    EXPECT  a10, 2584, 7
    /* WINDOWBASE / WINDOWSTART are readable */
    rsr     a4, windowbase
    rsr     a5, windowstart
    movi    a6, 1
    ssl     a4
    sll     a6, a6
    and     a6, a6, a5
    bnez    a6, 1f
    movi    a2, 8
    retw
1:  /* ROTW: after rotating by one, a3 / a4 are the old a7 / a8 */
    movi    a7, 0
    movi    a8, 0xABCD
    rotw    1
    mov     a3, a4
    rotw    -1
    EXPECT  a7, 0xABCD, 9
    PASS

/* fib(n): a2 = n, returns a2 */
    .align 4
fib8:
    entry   a1, 32
    bltui   a2, 2, 1f
    addi    a10, a2, -1
    call8   fib8
    mov     a3, a10
    addi    a10, a2, -2
    call8   fib8
    add     a2, a3, a10
1:  retw

    .align 4
sum12:
    entry   a1, 48
    beqz    a2, 1f
    addi    a14, a2, -1
    call12  sum12
    add     a2, a2, a14
1:  retw

    .align 4
sum4:
    entry   a1, 32
    beqz    a2, 1f
    addi    a6, a2, -1
    call4   sum4
    add     a2, a2, a6
1:  retw.n

/* mix: returns 7 + mix4(n-1) for n>0, alternating the three call kinds */
    .align 4
mix8:
    entry   a1, 32
    beqz    a2, 1f
    addi    a6, a2, -1
    call4   mix4
    addi    a2, a6, 7
1:  retw
    .align 4
mix4:
    entry   a1, 48
    beqz    a2, 1f
    addi    a14, a2, -1
    call12  mix12
    addi    a2, a14, 7
1:  retw
    .align 4
mix12:
    entry   a1, 48
    beqz    a2, 1f
    addi    a10, a2, -1
    call8   mix8
    addi    a2, a10, 7
1:  retw
