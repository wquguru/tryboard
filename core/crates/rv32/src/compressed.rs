//! C extension: expand 16-bit compressed instructions into their 32-bit equivalents so there is only one execute path.

#[inline(always)]
fn r_type(f7: u32, rs2: u32, rs1: u32, f3: u32, rd: u32, op: u32) -> u32 {
    (f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op
}
#[inline(always)]
fn i_type(imm: u32, rs1: u32, f3: u32, rd: u32, op: u32) -> u32 {
    ((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op
}
#[inline(always)]
fn s_type(imm: u32, rs2: u32, rs1: u32, f3: u32, op: u32) -> u32 {
    (((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 31) << 7) | op
}
#[inline(always)]
fn b_type(imm: u32, rs2: u32, rs1: u32, f3: u32) -> u32 {
    (((imm >> 12) & 1) << 31)
        | (((imm >> 5) & 0x3f) << 25)
        | (rs2 << 20)
        | (rs1 << 15)
        | (f3 << 12)
        | (((imm >> 1) & 0xf) << 8)
        | (((imm >> 11) & 1) << 7)
        | 0x63
}
#[inline(always)]
fn j_type(imm: u32, rd: u32) -> u32 {
    (((imm >> 20) & 1) << 31)
        | (((imm >> 1) & 0x3ff) << 21)
        | (((imm >> 11) & 1) << 20)
        | (((imm >> 12) & 0xff) << 12)
        | (rd << 7)
        | 0x6f
}
#[inline(always)]
fn sext(v: u32, bits: u32) -> u32 {
    let s = 32 - bits;
    (((v << s) as i32) >> s) as u32
}
#[inline(always)]
fn bit(v: u32, n: u32) -> u32 {
    (v >> n) & 1
}

/// None means an illegal compressed instruction (including all zeros).
pub fn expand(c: u16) -> Option<u32> {
    let c = c as u32;
    let op = c & 3;
    let f3 = c >> 13;
    let rd_p = ((c >> 2) & 7) + 8; // rd'/rs2'
    let rs1_p = ((c >> 7) & 7) + 8;
    let rd = (c >> 7) & 31;
    let rs2 = (c >> 2) & 31;
    Some(match (op, f3) {
        (0, 0) => {
            // C.ADDI4SPN
            let imm = (((c >> 7) & 0xf) << 6)
                | (((c >> 11) & 3) << 4)
                | (bit(c, 5) << 3)
                | (bit(c, 6) << 2);
            if imm == 0 {
                return None;
            }
            i_type(imm, 2, 0, rd_p, 0x13)
        }
        (0, 2) => {
            // C.LW
            let imm = (((c >> 10) & 7) << 3) | (bit(c, 6) << 2) | (bit(c, 5) << 6);
            i_type(imm, rs1_p, 2, rd_p, 0x03)
        }
        (0, 6) => {
            // C.SW
            let imm = (((c >> 10) & 7) << 3) | (bit(c, 6) << 2) | (bit(c, 5) << 6);
            s_type(imm, rd_p, rs1_p, 2, 0x23)
        }
        (1, 0) => {
            // C.ADDI / C.NOP
            let imm = sext((bit(c, 12) << 5) | ((c >> 2) & 31), 6);
            i_type(imm, rd, 0, rd, 0x13)
        }
        (1, 1) => {
            // C.JAL (RV32)
            j_type(cj_imm(c), 1)
        }
        (1, 2) => {
            // C.LI
            let imm = sext((bit(c, 12) << 5) | ((c >> 2) & 31), 6);
            i_type(imm, 0, 0, rd, 0x13)
        }
        (1, 3) => {
            if rd == 2 {
                // C.ADDI16SP
                let imm = (bit(c, 12) << 9)
                    | (bit(c, 6) << 4)
                    | (bit(c, 5) << 6)
                    | (((c >> 3) & 3) << 7)
                    | (bit(c, 2) << 5);
                if imm == 0 {
                    return None;
                }
                i_type(sext(imm, 10), 2, 0, 2, 0x13)
            } else {
                // C.LUI
                let imm = (bit(c, 12) << 17) | (((c >> 2) & 31) << 12);
                if imm == 0 {
                    return None;
                }
                (sext(imm, 18) & 0xffff_f000) | (rd << 7) | 0x37
            }
        }
        (1, 4) => {
            let f2 = (c >> 10) & 3;
            let shamt = (bit(c, 12) << 5) | ((c >> 2) & 31);
            match f2 {
                0 => {
                    if shamt >= 32 {
                        return None;
                    }
                    i_type(shamt, rs1_p, 5, rs1_p, 0x13)
                }
                1 => {
                    if shamt >= 32 {
                        return None;
                    }
                    i_type(shamt | 0x400, rs1_p, 5, rs1_p, 0x13)
                }
                2 => i_type(sext(shamt, 6), rs1_p, 7, rs1_p, 0x13),
                _ => {
                    if bit(c, 12) != 0 {
                        return None;
                    }
                    let (f7, f3) = match (c >> 5) & 3 {
                        0 => (0x20, 0),
                        1 => (0, 4),
                        2 => (0, 6),
                        _ => (0, 7),
                    };
                    r_type(f7, rd_p, rs1_p, f3, rs1_p, 0x33)
                }
            }
        }
        (1, 5) => j_type(cj_imm(c), 0),
        (1, 6) | (1, 7) => {
            let imm = (bit(c, 12) << 8)
                | (((c >> 10) & 3) << 3)
                | (((c >> 5) & 3) << 6)
                | (((c >> 3) & 3) << 1)
                | (bit(c, 2) << 5);
            b_type(sext(imm, 9), 0, rs1_p, if f3 == 6 { 0 } else { 1 })
        }
        (2, 0) => {
            let shamt = (bit(c, 12) << 5) | rs2;
            if shamt >= 32 {
                return None;
            }
            i_type(shamt, rd, 1, rd, 0x13)
        }
        (2, 2) => {
            // C.LWSP
            if rd == 0 {
                return None;
            }
            let imm = (bit(c, 12) << 5) | (((c >> 4) & 7) << 2) | (((c >> 2) & 3) << 6);
            i_type(imm, 2, 2, rd, 0x03)
        }
        (2, 4) => {
            if bit(c, 12) == 0 {
                if rs2 == 0 {
                    // C.JR
                    if rd == 0 {
                        return None;
                    }
                    i_type(0, rd, 0, 0, 0x67)
                } else {
                    // C.MV
                    r_type(0, rs2, 0, 0, rd, 0x33)
                }
            } else if rs2 == 0 {
                if rd == 0 {
                    0x0010_0073 // C.EBREAK
                } else {
                    i_type(0, rd, 0, 1, 0x67) // C.JALR
                }
            } else {
                r_type(0, rs2, rd, 0, rd, 0x33) // C.ADD
            }
        }
        (2, 6) => {
            // C.SWSP
            let imm = (((c >> 9) & 0xf) << 2) | (((c >> 7) & 3) << 6);
            s_type(imm, rs2, 2, 2, 0x23)
        }
        _ => return None,
    })
}

fn cj_imm(c: u32) -> u32 {
    let imm = (bit(c, 12) << 11)
        | (bit(c, 11) << 4)
        | (((c >> 9) & 3) << 8)
        | (bit(c, 8) << 10)
        | (bit(c, 7) << 6)
        | (bit(c, 6) << 7)
        | (((c >> 3) & 7) << 1)
        | (bit(c, 2) << 5);
    sext(imm, 12)
}
