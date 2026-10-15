/* 单精度 FPU：主要靠与 QEMU 的差分对照（所有结果都 DUMP）。
 * 输入取 18 个特殊值（±0、±1、1.5、3、0.1、−2.5、最小 / 最大非规格数、最小规格数、最大有限值、±∞、
 * qNaN、sNaN、2^24+2、2^−24），两两组合 × 4 种舍入模式。
 * 另外跑 libgcc __divsf3 与 libm __ieee754_sqrtf 的原样指令序列（由 DIV0/NEXP01/MKDADJ/ADDEXP/DIVN 等组成），
 * 以及协处理器禁用异常（含 FreeRTOS 式的惰性打开后重试）。自检部分只验少量确定的值。 */
#include "check.h"

#define NV 18

/* a9 = dump 写指针（整个测试期间独占），结束时写回 dump_end */
    .macro OUT reg
    s32i    \reg, a9, 0
    addi    a9, a9, 4
    .endm
    .macro OUTF freg
    ssi     \freg, a9, 0
    addi    a9, a9, 4
    .endm

/* 对 vals 中每对 (x, y)：f1=x、f2=y、f0 预置为 f3（1.5），执行 \op，输出 f0 */
    .macro PAIRS op
    movi    a7, 0
    wur.fsr a7
    movi    a3, vals
    movi    a4, NV
.Lo\@:
    lsi     f1, a3, 0
    movi    a5, vals
    movi    a6, NV
.Li\@:
    lsi     f2, a5, 0
    mov.s   f0, f3
    \op     f0, f1, f2
    OUTF    f0
    addi    a5, a5, 4
    addi    a6, a6, -1
    bnez    a6, .Li\@
    addi    a3, a3, 4
    addi    a4, a4, -1
    bnez    a4, .Lo\@
    rur.fsr a7
    OUT     a7
    .endm

/* 两操作数（fr 兼作输入）：对每对 (x, y)，f0=x 后执行 \op f0, y，输出 f0 */
    .macro PAIRS2 op
    movi    a7, 0
    wur.fsr a7
    movi    a3, vals
    movi    a4, NV
.Lm\@:
    movi    a5, vals
    movi    a6, NV
.Ln\@:
    lsi     f0, a3, 0
    lsi     f2, a5, 0
    \op     f0, f2
    OUTF    f0
    addi    a5, a5, 4
    addi    a6, a6, -1
    bnez    a6, .Ln\@
    addi    a3, a3, 4
    addi    a4, a4, -1
    bnez    a4, .Lm\@
    rur.fsr a7
    OUT     a7
    .endm

/* 对 vals 中每个 x：f1=x，f0 预置 f3，执行 \op f0, f1，输出 f0 */
    .macro UNARY op
    movi    a7, 0
    wur.fsr a7
    movi    a3, vals
    movi    a4, NV
.Lu\@:
    lsi     f1, a3, 0
    mov.s   f0, f3
    \op     f0, f1
    OUTF    f0
    addi    a3, a3, 4
    addi    a4, a4, -1
    bnez    a4, .Lu\@
    rur.fsr a7
    OUT     a7
    .endm

/* f→int：\op a7, f1, \scale */
    .macro TOINT op, scale
    movi    a7, 0
    wur.fsr a7
    movi    a3, vals
    movi    a4, NV
.Lt\@:
    lsi     f1, a3, 0
    \op     a7, f1, \scale
    OUT     a7
    addi    a3, a3, 4
    addi    a4, a4, -1
    bnez    a4, .Lt\@
    rur.fsr a7
    OUT     a7
    .endm

/* int→f：\op f0, a7, \scale */
    .macro TOFLT op, scale
    movi    a7, 0
    wur.fsr a7
    movi    a3, ints
    movi    a4, 10
.Lf\@:
    l32i    a7, a3, 0
    \op     f0, a7, \scale
    OUTF    f0
    addi    a3, a3, 4
    addi    a4, a4, -1
    bnez    a4, .Lf\@
    rur.fsr a7
    OUT     a7
    .endm

/* 比较：每对输出一个 0/1 */
    .macro CMP op
    movi    a7, 0
    wur.fsr a7
    movi    a3, vals
    movi    a4, NV
.Lc\@:
    lsi     f1, a3, 0
    movi    a5, vals
    movi    a6, NV
.Ld\@:
    lsi     f2, a5, 0
    \op     b1, f1, f2
    movi    a7, 0
    movi    a8, 1
    movt    a7, a8, b1
    OUT     a7
    addi    a5, a5, 4
    addi    a6, a6, -1
    bnez    a6, .Ld\@
    addi    a3, a3, 4
    addi    a4, a4, -1
    bnez    a4, .Lc\@
    rur.fsr a7
    OUT     a7
    .endm

/* 所有舍入模式下跑一遍 \what（宏名）\arg */
    .macro ALLRM what, a1, a2
    movi    a10, 0
.Lr\@:
    wur.fcr a10
    .ifb \a2
    \what   \a1
    .else
    \what   \a1, \a2
    .endif
    addi    a10, a10, 1
    blti    a10, 4, .Lr\@
    movi    a10, 0
    wur.fcr a10
    .endm

/* libgcc __divsf3 的指令序列：f0 = f1 / f2（会改 f2..f8） */
    .macro DIVSEQ
    div0.s  f3, f2
    nexp01.s f4, f2
    const.s f5, 1
    maddn.s f5, f4, f3
    mov.s   f6, f3
    mov.s   f7, f2
    nexp01.s f2, f1
    maddn.s f6, f5, f6
    const.s f5, 1
    const.s f0, 0
    neg.s   f8, f2
    maddn.s f5, f4, f6
    maddn.s f0, f8, f3
    mkdadj.s f7, f1
    maddn.s f6, f5, f6
    maddn.s f8, f4, f0
    const.s f3, 1
    maddn.s f3, f4, f6
    maddn.s f0, f8, f6
    neg.s   f2, f2
    maddn.s f6, f3, f6
    maddn.s f2, f4, f0
    addexpm.s f0, f7
    addexp.s f6, f7
    divn.s  f0, f2, f6
    .endm

/* libm __ieee754_sqrtf 的指令序列：f0 = sqrt(f1)（会改 f1..f7） */
    .macro SQRTSEQ
    sqrt0.s f2, f1
    const.s f3, 0
    maddn.s f3, f2, f2
    nexp01.s f4, f1
    const.s f0, 3
    addexp.s f4, f0
    maddn.s f0, f3, f4
    nexp01.s f3, f1
    neg.s   f5, f3
    maddn.s f2, f0, f2
    const.s f0, 0
    const.s f6, 0
    const.s f7, 0
    maddn.s f0, f5, f2
    maddn.s f6, f2, f4
    const.s f4, 3
    maddn.s f7, f4, f2
    maddn.s f3, f0, f0
    maddn.s f4, f6, f2
    neg.s   f2, f7
    maddn.s f0, f3, f2
    maddn.s f7, f4, f7
    mksadj.s f2, f1
    nexp01.s f1, f1
    maddn.s f1, f0, f0
    neg.s   f3, f7
    addexpm.s f0, f2
    addexp.s f3, f2
    divn.s  f0, f1, f3
    .endm

/* 与 PAIRS 相同的循环，但跑整段 DIVSEQ（会改 f3：每次重设） */
    .macro PAIRS_DIV
    movi    a3, vals
    movi    a4, NV
.Lp\@:
    movi    a5, vals
    movi    a6, NV
.Lq\@:
    lsi     f1, a3, 0
    lsi     f2, a5, 0
    DIVSEQ
    OUTF    f0
    addi    a5, a5, 4
    addi    a6, a6, -1
    bnez    a6, .Lq\@
    addi    a3, a3, 4
    addi    a4, a4, -1
    bnez    a4, .Lp\@
    .endm

    .macro UNARY_SQRT
    movi    a3, vals
    movi    a4, NV
.Ls\@:
    lsi     f1, a3, 0
    SQRTSEQ
    OUTF    f0
    addi    a3, a3, 4
    addi    a4, a4, -1
    bnez    a4, .Ls\@
    .endm

    TEST_BEGIN
    /* ---- 协处理器禁用：CPENABLE=0 时 FP 指令进 EXCCAUSE 32 */
    movi    a3, 0
    wsr     a3, cpenable
    rsync
    EXC_COUNT a5
    add.s   f0, f1, f2
    EXC_COUNT a6
    sub     a6, a6, a5
    EXPECT  a6, 1, 1
    EXC_CAUSE a6
    EXPECT  a6, 32, 2
    /* RFR 同样受门控 */
    rfr     a7, f0
    EXC_CAUSE a6
    EXPECT  a6, 32, 3
    /* 惰性打开：处理程序置 CPENABLE 后重新执行 WFR */
    movi    a3, cp_lazy
    movi    a4, 1
    s32i    a4, a3, 0
    movi    a7, 0x40490fdb
    wfr     f5, a7
    rfr     a8, f5
    EXPECT  a8, 0x40490fdb, 4
    rsr     a8, cpenable
    EXPECT  a8, 1, 5
    movi    a4, 0
    s32i    a4, a3, 0

    movi    a9, dump_end
    l32i    a9, a9, 0
    movi    a3, 0x3fc00000         /* f3 = 1.5：PAIRS / UNARY 里 f0 的初值 */
    wfr     f3, a3

    /* 少量自检：1.5 + 1.5 = 3，1/3 的 DIV 序列 */
    add.s   f0, f3, f3
    rfr     a4, f0
    EXPECT  a4, 0x40400000, 6
    movi    a3, 0x3f800000
    wfr     f1, a3
    movi    a3, 0x40400000
    wfr     f2, a3
    DIVSEQ
    rfr     a4, f0
    EXPECT  a4, 0x3eaaaaab, 7
    movi    a3, 0x40000000
    wfr     f1, a3
    SQRTSEQ
    rfr     a4, f0
    EXPECT  a4, 0x3fb504f3, 8
    movi    a3, 0x3fc00000
    wfr     f3, a3

    /* FCR / FSR 可写位 */
    movi    a3, -1
    wur.fcr a3
    rur.fcr a4
    OUT     a4
    wur.fsr a3
    rur.fsr a4
    OUT     a4
    movi    a3, 0
    wur.fcr a3
    wur.fsr a3

    /* 二元运算 × 舍入模式 */
    ALLRM   PAIRS, add.s
    ALLRM   PAIRS, sub.s
    ALLRM   PAIRS, mul.s
    ALLRM   PAIRS, madd.s
    ALLRM   PAIRS, msub.s
    ALLRM   PAIRS, maddn.s
    ALLRM   PAIRS, divn.s
    /* 运算后 FSR 的异常标志（看 QEMU 是否维护） */
    rur.fsr a4
    OUT     a4

    /* 单操作数 */
    UNARY   mov.s
    UNARY   abs.s
    UNARY   neg.s
    UNARY   div0.s
    UNARY   sqrt0.s
    UNARY   nexp01.s
    UNARY   mksadj.s
    PAIRS2  mkdadj.s
    PAIRS2  addexp.s
    PAIRS2  addexpm.s

    /* CONST.S 0..15 */
    const.s f0, 0
    OUTF    f0
    const.s f0, 1
    OUTF    f0
    const.s f0, 2
    OUTF    f0
    const.s f0, 3
    OUTF    f0
    const.s f0, 4
    OUTF    f0
    const.s f0, 5
    OUTF    f0
    const.s f0, 6
    OUTF    f0
    const.s f0, 7
    OUTF    f0
    const.s f0, 8
    OUTF    f0
    const.s f0, 15
    OUTF    f0

    /* 转换 */
    TOINT   round.s, 0
    TOINT   round.s, 3
    TOINT   trunc.s, 0
    TOINT   trunc.s, 5
    TOINT   floor.s, 0
    TOINT   ceil.s, 0
    TOINT   utrunc.s, 0
    TOINT   utrunc.s, 2
    ALLRM   TOFLT, float.s, 0
    ALLRM   TOFLT, ufloat.s, 0
    TOFLT   float.s, 7
    TOFLT   ufloat.s, 15

    /* 比较 */
    CMP     un.s
    CMP     oeq.s
    CMP     ueq.s
    CMP     olt.s
    CMP     ult.s
    CMP     ole.s
    CMP     ule.s

    /* 条件传送 */
    movi    a3, 0
    movi    a4, 0x40000000
    wfr     f1, a4
    mov.s   f0, f3
    moveqz.s f0, f1, a3
    OUTF    f0
    mov.s   f0, f3
    movnez.s f0, f1, a3
    OUTF    f0
    movi    a3, -5
    mov.s   f0, f3
    movltz.s f0, f1, a3
    OUTF    f0
    mov.s   f0, f3
    movgez.s f0, f1, a3
    OUTF    f0
    const.s f4, 0
    oeq.s   b2, f4, f4
    mov.s   f0, f3
    movt.s  f0, f1, b2
    OUTF    f0
    mov.s   f0, f3
    movf.s  f0, f1, b2
    OUTF    f0

    /* 装载 / 存储：LSI/SSI/LSIP/SSIP/LSX/SSX/LSXP/SSXP（输出数据与指针变化） */
    movi    a3, fbuf
    movi    a4, 0x11111111
    wfr     f1, a4
    ssi     f1, a3, 8
    lsi     f2, a3, 8
    OUTF    f2
    mov     a5, a3
    ssip    f1, a5, 4
    sub     a6, a5, a3
    OUT     a6
    mov     a5, a3
    lsip    f2, a5, 8
    sub     a6, a5, a3
    OUT     a6
    OUTF    f2
    movi    a7, 12
    ssx     f1, a3, a7
    lsx     f2, a3, a7
    OUTF    f2
    mov     a5, a3
    ssxp    f1, a5, a7
    sub     a6, a5, a3
    OUT     a6
    mov     a5, a3
    lsxp    f2, a5, a7
    sub     a6, a5, a3
    OUT     a6
    OUTF    f2

    /* 除法与开方序列：所有组合 × 舍入模式 */
    ALLRM   PAIRS_DIV
    ALLRM   UNARY_SQRT

    movi    a3, dump_end
    s32i    a9, a3, 0
    PASS


    .data
    .align  4
vals:
    .word 0x00000000, 0x80000000, 0x3f800000, 0xbf800000, 0x3fc00000, 0x40400000
    .word 0x3dcccccd, 0xc0200000, 0x00000001, 0x007fffff, 0x00800000, 0x7f7fffff
    .word 0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 0x4b800001, 0x33800000
ints:
    .word 0, 1, -1, 3, 0x7fffffff, 0x80000000, 0x01000001, 0x0fffffff, 12345679, -7
fbuf:
    .space 64
