/* MAC16 (multiply, multiply-accumulate / subtract into the 40-bit ACC, four operand sources, LDINC/LDDEC and parallel loads),
 * plus SALT/SALTU and the region protection TLB insns IDF uses on S3. Everything is DUMPed for QEMU diff. */
#include "check.h"

    .macro DACC
    rsr     a7, acclo
    DUMP    a7
    rsr     a7, acchi
    DUMP    a7
    .endm

    TEST_BEGIN
    movi    a2, 0x7fff8000         /* high half 0x7fff, low half -32768 */
    movi    a3, 0xffff0003         /* high half -1, low half 3 */
    umul.aa.ll a2, a3
    DACC
    mul.aa.ll a2, a3
    DACC
    mul.aa.hl a2, a3
    DACC
    mul.aa.lh a2, a3
    DACC
    mul.aa.hh a2, a3
    DACC
    mula.aa.hh a2, a3
    DACC
    muls.aa.ll a2, a3
    DACC
    /* accumulate past 32 bits into ACCHI, then wrap at 40 bits */
    movi    a4, 0x7fff7fff
    movi    a6, 300
1:  mula.aa.ll a4, a4
    addi    a6, a6, -1
    bnez    a6, 1b
    DACC
    /* m-register sources */
    wsr     a2, m0
    wsr     a3, m1
    movi    a5, 0x00050006
    wsr     a5, m2
    wsr     a3, m3
    mul.ad.ll a2, m2
    DACC
    mul.da.lh m1, a3
    DACC
    mul.dd.hh m0, m3
    DACC
    mula.dd.hl m1, m2
    DACC
    /* LDINC / LDDEC */
    movi    a8, tab
    ldinc   m0, a8
    rsr     a7, m0
    DUMP    a7
    movi    a9, tab
    sub     a7, a8, a9
    DUMP    a7
    lddec   m1, a8
    rsr     a7, m1
    DUMP    a7
    sub     a7, a8, a9
    DUMP    a7
    /* multiply-accumulate + parallel load: compute with the old m value, then load */
    movi    a8, tab
    movi    a7, 0
    wsr     a7, acclo
    wsr     a7, acchi
    mula.dd.ll.ldinc m0, a8, m1, m2
    /* ACC from the parallel-load forms isn't compared: QEMU uses the m value from before the earlier LDINC/LDDEC (yet RSR reads the new one),
       unlike hardware. Our "use the current m" semantics is covered by crates/xtensa unit tests; only the loaded values are compared */
    rsr     a7, m0
    DUMP    a7
    sub     a7, a8, a9
    DUMP    a7
    movi    a8, tab + 12
    mula.da.hh.lddec m2, a8, m0, a3
    rsr     a7, m2
    DUMP    a7
    sub     a7, a8, a9
    DUMP    a7

    /* SALT / SALTU */
    movi    a3, -5
    movi    a4, 3
    salt    a5, a3, a4
    DUMP    a5
    saltu   a5, a3, a4
    DUMP    a5
    salt    a5, a4, a3
    DUMP    a5
    saltu   a5, a4, a3
    DUMP    a5
    EXPECT  a5, 1, 1

    /* region protection: reset attributes, read back after write */
    movi    a3, 0x20000000
    rdtlb1  a4, a3
    DUMP    a4
    ritlb1  a4, a3
    DUMP    a4
    movi    a5, 0xf
    wdtlb   a5, a3
    isync
    rdtlb1  a4, a3
    DUMP    a4
    movi    a5, 2
    wdtlb   a5, a3
    movi    a3, 0x60001234
    rdtlb0  a4, a3
    DUMP    a4
    pdtlb   a4, a3
    DUMP    a4
    pitlb   a4, a3
    DUMP    a4
    PASS

    .data
    .align  4
tab: .word 0x11112222, 0x33334444, 0x55556666, 0x77778888
