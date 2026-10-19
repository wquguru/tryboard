/* Branches and jumps: every B* form, BEQZ.N/BNEZ.N, J/JX, CALL0/CALLX0/RET (RET.N) */
#include "check.h"

/* Expect the branch taken: fail if it falls through */
    .macro TAKEN insn:vararg
    \insn, .Lt\@
    movi    a2, 100
    retw
.Lt\@:
    .endm
/* Expect the branch not taken */
    .macro NOTTAKEN case, insn:vararg
    \insn, .Lnt\@
    j       .Lnt_ok\@
.Lnt\@:
    movi    a2, \case
    retw
.Lnt_ok\@:
    .endm

    TEST_BEGIN
    movi    a3, 5
    movi    a4, -3
    movi    a5, 5
    movi    a6, 0
    movi    a7, 0x0C
    movi    a8, 0x04
    TAKEN   beq a3, a5
    NOTTAKEN 1, beq a3, a4
    TAKEN   bne a3, a4
    NOTTAKEN 2, bne a3, a5
    TAKEN   blt a4, a3
    NOTTAKEN 3, blt a3, a4
    TAKEN   bge a3, a4
    TAKEN   bge a3, a5
    NOTTAKEN 4, bge a4, a3
    TAKEN   bltu a3, a4
    NOTTAKEN 5, bltu a4, a3
    TAKEN   bgeu a4, a3
    NOTTAKEN 6, bgeu a3, a4
    TAKEN   beqz a6
    NOTTAKEN 7, beqz a3
    TAKEN   bnez a3
    TAKEN   bltz a4
    NOTTAKEN 8, bltz a3
    TAKEN   bgez a6
    NOTTAKEN 9, bgez a4
    TAKEN   beqi a3, 5
    NOTTAKEN 10, beqi a3, 4
    TAKEN   bnei a3, 4
    TAKEN   blti a4, -1
    NOTTAKEN 11, blti a3, 5
    TAKEN   bgei a3, 5
    movi    a9, -1
    TAKEN   beqi a9, -1
    movi    a9, 256
    TAKEN   beqi a9, 256
    TAKEN   bltui a3, 6
    NOTTAKEN 12, bltui a4, 256
    TAKEN   bgeui a4, 65536
    /* bit tests */
    TAKEN   bany a7, a8
    NOTTAKEN 13, bnone a7, a8
    movi    a9, 3
    TAKEN   bnone a7, a9
    TAKEN   ball a7, a8
    NOTTAKEN 14, bnall a7, a8
    TAKEN   bnall a8, a7
    movi    a9, 3
    TAKEN   bbs a7, a9
    movi    a9, 0
    TAKEN   bbc a7, a9
    TAKEN   bbsi a7, 2
    TAKEN   bbci a7, 0
    movi    a10, 0x80000000
    TAKEN   bbsi a10, 31
    NOTTAKEN 15, bbci a10, 31
    /* narrow branches */
    TAKEN   beqz.n a6
    TAKEN   bnez.n a3
    NOTTAKEN 16, beqz.n a3
    /* J / JX */
    j       1f
    movi    a2, 17
    retw
1:  movi    a9, 2f
    jx      a9
    movi    a2, 18
    retw
2:
    /* CALL0 / CALLX0 / RET: leaf functions return via a0 without touching the window */
    movi    a11, 0
    mov     a12, a0          /* call0 clobbers a0 (this window's return address), so save it */
    call0   leaf_inc
    call0   leaf_inc
    movi    a9, leaf_inc
    callx0  a9
    mov     a0, a12
    EXPECT  a11, 3, 19
    PASS

    .align 4
leaf_inc:
    addi    a11, a11, 1
    ret.n
