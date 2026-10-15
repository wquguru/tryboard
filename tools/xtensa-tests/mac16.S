/* MAC16（乘、乘累加 / 减到 40 位 ACC，四种操作数来源，LDINC/LDDEC 与并行装载），
 * 以及 IDF 在 S3 上用到的 SALT/SALTU、区域保护 TLB 指令。结果全部 DUMP，与 QEMU 对照。 */
#include "check.h"

    .macro DACC
    rsr     a7, acclo
    DUMP    a7
    rsr     a7, acchi
    DUMP    a7
    .endm

    TEST_BEGIN
    movi    a2, 0x7fff8000         /* 高半 0x7fff，低半 −32768 */
    movi    a3, 0xffff0003         /* 高半 −1，低半 3 */
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
    /* 累加溢出 32 位进 ACCHI，再回绕 40 位 */
    movi    a4, 0x7fff7fff
    movi    a6, 300
1:  mula.aa.ll a4, a4
    addi    a6, a6, -1
    bnez    a6, 1b
    DACC
    /* m 寄存器来源 */
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
    /* 乘累加 + 并行装载：用旧 m 值计算，再装入 */
    movi    a8, tab
    movi    a7, 0
    wsr     a7, acclo
    wsr     a7, acchi
    mula.dd.ll.ldinc m0, a8, m1, m2
    /* 并行装载形式的 ACC 不与 QEMU 对照：QEMU 用的是前面 LDINC/LDDEC 之前的 m 值（RSR 却读到新值），
       不像硬件行为。我们"用当前 m 值"的语义由 crates/xtensa 的单元测试覆盖。这里只对照装载结果 */
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

    /* 区域保护：复位属性、写后读回 */
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
