#!/usr/bin/env python3
"""Compute masked signatures of the VHCI boundary functions from Espressif's prebuilt BLE controller libs (libbtdm_app*.a) (C-01 route a').

Usage:
  tools/ble_sigs.py gen   <out.rs> <lib.a>...                 generate core/crates/soc/src/ble/sigs.rs
  tools/ble_sigs.py check <flash.bin> <app.elf> <lib.a>...    against ELF symbols, check each signature hits exactly once in the .bin at the right address
  tools/ble_sigs.py dump  <lib.a>...                          print per-function sizes
  tools/ble_cover.sh [ver...]   links each third_party/btlib commit bare and runs check / check-xt on it (F-08c coverage)
  tools/ble_sigs.py gen-xt   <out.rs> <lib.a>...              ESP32-S3 (Xtensa) libs -> core/crates/soc/src/ble/sigs_xt.rs (E-04)
  tools/ble_sigs.py check-xt <flash.bin> <app.elf> <lib.a>... same check for an S3 build (matcher: ble/sig_xt.rs)
  tools/ble_sigs.py gen-lx6   <out.rs> <lib.a>...             classic ESP32 lib_esp32/esp32/libbtdm_app.a -> ble/sigs_lx6.rs (E-09)
  tools/ble_sigs.py check-lx6 <flash.bin> <app.elf> <lib.a>... same check for a classic ESP32 build

A signature is the function's bytes with relocation fields removed. The repo stores only each instruction's masked value,
mask and length (relocated immediate bits zeroed), never the library's raw bytes or disassembly. To survive linker relaxation
(R_RISCV_RELAX: auipc+jalr -> jal, lui+lw -> gp-relative) matching works on instruction sequences, see core/crates/soc/src/ble/sig.rs.
"""
import struct
import sys

# Functions to locate (libbtdm symbols). Xtensa (S3) is listed separately.
FUNCS_RV = [
    'btdm_osi_funcs_register',
    'btdm_controller_init',
    'btdm_controller_enable',
    'btdm_controller_get_mode',
    'API_vhci_host_check_send_available',
    'API_vhci_host_send_packet',
    'API_vhci_host_register_callback',
    'sdk_config_extend_set_pll_track',
]
# Same signature as other setters in its object file; Rust confirms it from the esp_bt_controller_enable call site (see sig.rs)
AMBIGUOUS_OK = {'sdk_config_extend_set_pll_track'}


def ar_members(path):
    """GNU ar: return [(name, bytes)]"""
    data = open(path, 'rb').read()
    assert data[:8] == b'!<arch>\n', path
    p = 8
    longnames = b''
    out = []
    while p + 60 <= len(data):
        hdr = data[p:p + 60]
        name = hdr[:16].decode().strip()
        size = int(hdr[48:58].decode().strip())
        body = data[p + 60:p + 60 + size]
        if name == '//':
            longnames = body
        elif name.startswith('/') and name[1:].isdigit():
            o = int(name[1:])
            e = longnames.index(b'/\n', o)
            out.append((longnames[o:e].decode(), body))
        elif name not in ('/', '/SYM64/'):
            out.append((name.rstrip('/'), body))
        p += 60 + size + (size & 1)
    return out


class Elf:
    def __init__(self, b):
        self.b = b
        assert b[:4] == b'\x7fELF' and b[4] == 1
        (self.type, self.machine, _, _, _, self.shoff, _, _, _, _, shentsize, shnum, shstrndx) = struct.unpack_from(
            '<HHIIIIIHHHHHH', b, 16)
        self.sh = []
        for i in range(shnum):
            name, typ, flags, addr, off, size, link, info, align, entsize = struct.unpack_from(
                '<IIIIIIIIII', b, self.shoff + i * shentsize)
            self.sh.append(dict(name=name, type=typ, flags=flags, addr=addr, off=off, size=size, link=link,
                                info=info, entsize=entsize))
        strtab = self.sh[shstrndx]
        for s in self.sh:
            s['nm'] = self.cstr(strtab['off'] + s['name'])
        self.syms = []
        for i, s in enumerate(self.sh):
            if s['type'] == 2:  # SYMTAB
                st = self.sh[s['link']]
                for j in range(s['size'] // 16):
                    name, value, size, info, other, shndx = struct.unpack_from('<IIIBBH', b, s['off'] + j * 16)
                    self.syms.append(dict(name=self.cstr(st['off'] + name), value=value, size=size, info=info,
                                          shndx=shndx))

    def cstr(self, o):
        e = self.b.index(b'\0', o)
        return self.b[o:e].decode()

    def sec_data(self, i):
        s = self.sh[i]
        return self.b[s['off']:s['off'] + s['size']]

    def relocs_for(self, i):
        """Relocations in RELA sections that apply to section i: [(offset, type, symbol name)]"""
        out = []
        for s in self.sh:
            if s['type'] == 4 and s['info'] == i:
                symsec = self.sh[s['link']]
                st = self.sh[symsec['link']]
                for j in range(s['size'] // 12):
                    off, info, addend = struct.unpack_from('<IIi', self.b, s['off'] + j * 12)
                    si = info >> 8
                    name_off = struct.unpack_from('<I', self.b, symsec['off'] + si * 16)[0]
                    out.append((off, info & 0xff, self.cstr(st['off'] + name_off)))
        return out


# RISC-V relocation types
R_BRANCH, R_JAL, R_CALL, R_CALL_PLT = 16, 17, 18, 19
R_HI20, R_LO12_I, R_LO12_S = 26, 27, 28
R_RVC_BRANCH, R_RVC_JUMP, R_RELAX = 44, 45, 51
R_PCREL_HI20, R_PCREL_LO12_I, R_PCREL_LO12_S = 23, 24, 25
R_ALIGN = 43

# Instruction kinds (match Kind in sig.rs)
K_EXACT, K_CALL, K_HI20, K_LO12 = 0, 1, 2, 3


def insns(code):
    """Split into instructions by RVC length: [(offset, length, word)]"""
    out = []
    p = 0
    while p < len(code):
        h = code[p] | (code[p + 1] << 8)
        if h & 3 == 3:
            w = struct.unpack_from('<I', code, p)[0]
            out.append((p, 4, w))
            p += 4
        else:
            out.append((p, 2, h))
            p += 2
    return out


def rv_signature(elf, secidx):
    code = elf.sec_data(secidx)
    rel = {}
    relax = set()
    for off, typ, sym in elf.relocs_for(secidx):
        if typ == R_RELAX:
            relax.add(off)
        elif typ == R_ALIGN:
            raise ValueError('contains R_RISCV_ALIGN, cannot sign')
        else:
            rel[off] = typ
    units = []  # (kind, value, mask, len)
    ins = insns(code)
    i = 0
    while i < len(ins):
        off, ln, w = ins[i]
        t = rel.get(off)
        if t in (R_CALL, R_CALL_PLT):
            # auipc ra + jalr ra: may be relaxed into jal ra (4 bytes)
            assert ins[i + 1][1] == 4
            rd = (w >> 7) & 31
            units.append((K_CALL, rd, 0, 8))
            i += 2
            continue
        if t == R_HI20:
            # lui rd: relaxation may delete it entirely (the following lo12 becomes gp-relative)
            units.append((K_HI20, w & 0xfff, 0xfff, 4))
            i += 1
            continue
        if t in (R_LO12_I, R_LO12_S):
            if t == R_LO12_I:
                m = 0x000fffff
            else:
                m = 0x01fff07f
            # Relaxing to gp-relative turns rs1 into gp (x3), so mask rs1 too
            m &= ~(31 << 15)
            units.append((K_LO12, w & m, m, 4))
            i += 1
            continue
        if t in (R_BRANCH, R_RVC_BRANCH, R_JAL, R_RVC_JUMP, R_PCREL_HI20, R_PCREL_LO12_I, R_PCREL_LO12_S):
            # In-section jump offsets change with relaxation: mask the immediate, keep opcode and registers
            if ln == 4:
                if t == R_BRANCH:
                    m = 0x01fff07f
                elif t == R_JAL:
                    m = 0x00000fff
                elif t == R_PCREL_HI20:
                    m = 0x00000fff
                elif t == R_PCREL_LO12_I:
                    m = 0x000fffff
                else:
                    m = 0x01fff07f
            else:
                m = 0xe383 if t == R_RVC_BRANCH else 0xe003
            units.append((K_EXACT, w & m, m, ln))
            i += 1
            continue
        if t is not None:
            raise ValueError(f'unhandled relocation type {t} @ {off:#x}')
        m = 0xffffffff if ln == 4 else 0xffff
        units.append((K_EXACT, w & m, m, ln))
        i += 1
    return units


def find_funcs(libs, funcs):
    """Find each function's section in the libs (-ffunction-sections: .text.<name> or .iram1.<n>)"""
    found = {}
    for lib in libs:
        for mname, body in ar_members(lib):
            if not body.startswith(b'\x7fELF'):
                continue
            e = Elf(body)
            for s in e.syms:
                if s['name'] in funcs and s['shndx'] not in (0, 0xfff1) and (s['info'] & 0xf) == 2:
                    if s['value'] != 0:
                        raise ValueError(f"{s['name']} is not at section start")
                    found.setdefault(s['name'], (lib, mname, e, s['shndx']))
    return found


MAX_UNITS = 96


def app_segments(flash):
    """flash image -> app code segments [(load address, bytes)]"""
    off = 0
    if len(flash) > 0x8020 and flash[0x8000:0x8002] == b'\xaa\x50':
        for o in range(0x8000, 0x9000, 32):
            if flash[o:o + 2] != b'\xaa\x50':
                break
            ty, sub, poff = flash[o + 2], flash[o + 3], struct.unpack_from('<I', flash, o + 4)[0]
            if ty == 0 and sub in (0, 0x10):
                off = poff
                break
    assert flash[off] == 0xE9
    n = flash[off + 1]
    p = off + 24
    segs = []
    for _ in range(n):
        load, ln = struct.unpack_from('<II', flash, p)
        segs.append((load, flash[p + 8:p + 8 + ln]))
        p += 8 + ln
    return [(a, b) for a, b in segs if 0x40000000 <= a < 0x44000000]


def match_at(b, p, units):
    want_gp = False
    for k, v, m, ln in units:
        if p + 2 > len(b):
            return False
        h = b[p] | (b[p + 1] << 8)
        is4 = h & 3 == 3
        w = struct.unpack_from('<I', b, p)[0] if is4 and p + 4 <= len(b) else h
        if k == K_EXACT:
            if (4 if is4 else 2) != ln or (w & m) != v:
                return False
            p += ln
        elif k == K_CALL:
            rd = v
            if is4 and (w & 0x7f) == 0x17 and ((w >> 7) & 31) == rd:
                if p + 8 > len(b):
                    return False
                w2 = struct.unpack_from('<I', b, p + 4)[0]
                if (w2 & 0x707f) != 0x0067 or ((w2 >> 7) & 31) != rd or ((w2 >> 15) & 31) != rd:
                    return False
                p += 8
            elif is4 and (w & 0x7f) == 0x6f and ((w >> 7) & 31) == rd:
                p += 4
            elif not is4 and rd == 1 and (h & 0xe003) == 0x2001:
                p += 2
            elif not is4 and rd == 0 and (h & 0xe003) == 0xa001:
                p += 2
            else:
                return False
        elif k == K_HI20:
            if is4 and (w & m) == v:
                p += 4
            else:
                # Treat the lui as relaxed away: the next lo12 access must then be gp-relative
                want_gp = True
        elif k == K_LO12:
            if not is4 or (w & m) != v:
                return False
            if want_gp and ((w >> 15) & 31) != 3:
                return False
            want_gp = False
            p += 4
    return True


def match_all(segs, units):
    hits = []
    for a, b in segs:
        for p in range(0, len(b) - 1, 2):
            if match_at(b, p, units):
                hits.append(a + p)
    return hits


def lib_version(path):
    # third_party/btlib/<version>/<chip>/<lib>
    parts = path.replace('\\', '/').split('/')
    return parts[-3] if len(parts) >= 3 else path


MIN_UNITS = 24


def variants(libs):
    """Dedupe each function's signatures across lib versions, cut to the shortest prefix unique among all function starts (>= MIN_UNITS)"""
    corpus = []  # signature of every function section in all libs (-ffunction-sections: one function per section)
    full = {}  # function name -> {signature: [versions]}
    for lib in libs:
        ver = lib_version(lib)
        for mname, body in ar_members(lib):
            if not body.startswith(b'\x7fELF'):
                continue
            e = Elf(body)
            names = {}
            for sy in e.syms:
                if (sy['info'] & 0xf) == 2 and sy['value'] == 0 and sy['shndx'] not in (0, 0xfff1):
                    names[sy['shndx']] = sy['name']
            for si, nm in names.items():
                try:
                    u = rv_signature(e, si)
                except (ValueError, AssertionError, IndexError):
                    continue
                corpus.append((nm, u))
                if nm in FUNCS_RV:
                    lst = full.setdefault(nm, {}).setdefault(tuple(u), [])
                    if ver not in lst:
                        lst.append(ver)
    out = {}
    for fn, vs in full.items():
        res = []
        for u, vers in vs.items():
            u = list(u)
            n = min(len(u), MIN_UNITS)
            while n < len(u) and any(nm != fn and cu[:n] == u[:n] for nm, cu in corpus):
                n += 4
            n = min(n, len(u))
            if any(nm != fn and cu[:n] == u[:n] for nm, cu in corpus):
                if fn not in AMBIGUOUS_OK:
                    raise SystemExit(f'{fn} has the same signature as {sorted({nm for nm, cu in corpus if nm != fn and cu[:n] == u[:n]})[:5]}, cannot tell apart')
                dup = sorted({nm for nm, cu in corpus if nm != fn and cu[:n] == u[:n]})
                print(f'{fn}: same shape as {dup}, located via call site', file=sys.stderr)
            pre = u[:n]
            for r in res:
                if r[0] == pre:
                    r[1].extend(v for v in vers if v not in r[1])
                    break
            else:
                res.append((pre, list(vers)))
        out[fn] = res
    return out


# ---- Xtensa (ESP32-S3 libbtdm, E-04) ----
# Literal pool precedes each function; SLOT0_OP / ASM_EXPAND (relaxable longcall) relocs. Details: DECISIONS 2026-10-20 E-04
R_XT_SLOT0_OP, R_XT_ASM_EXPAND = 20, 11
EM_XTENSA = 94

# Kinds (match sig_xt.rs): exact under mask / longcall (n << 4 | reg) / unreachable fill (0-3 zero bytes) /
# literal constant of the preceding L32R (tells apart look-alikes, e.g. osi_funcs_register vs r_h4tl_eif_register)
X_EXACT, X_LONGCALL, X_FILL, X_LIT = 0, 1, 2, 3


def xt_len(b0):
    """Instruction length from op0 (8..13 are the 16-bit density forms)"""
    return 2 if 8 <= (b0 & 0xf) <= 13 else 3


def xt_reloc_mask(w, ln):
    """Mask that keeps opcode / registers and drops the PC-relative field of a SLOT0_OP-relocated instruction"""
    op0 = w & 0xf
    if ln == 2:
        if op0 == 0xc and (w >> 7) & 1:  # BEQZ.N / BNEZ.N (RI6): keep op0, i/z, s
            return 0x0fcf
        raise ValueError(f'unhandled narrow relocated insn {w:04x}')
    if op0 == 1:  # L32R: keep at
        return 0x0000ff
    if op0 == 5:  # CALLn: keep n
        return 0x00003f
    if op0 == 6:
        n = (w >> 4) & 3
        if n == 0:  # J
            return 0x00003f
        if n == 1:  # BZ (BRI12)
            return 0x000fff
        if n == 3 and (w >> 6) & 3 == 0:
            raise ValueError(f'relocated ENTRY {w:06x}')
        return 0x00ffff  # BI0 / BI1 / LOOP* (BRI8)
    if op0 == 7:  # B (RRI8)
        return 0x00ffff
    raise ValueError(f'unhandled relocated insn {w:06x}')


def xt_word(b, p):
    ln = xt_len(b[p])
    w = 0
    for i in range(ln):
        w |= b[p + i] << (8 * i)
    return w, ln


def xt_fills(e, si):
    """Unreachable fill ranges of section si from the .xt.prop property table: {offset: size}"""
    out = {}
    for i, s in enumerate(e.sh):
        if s['nm'] != '.xt.prop' and not s['nm'].startswith('.xt.prop.'):
            continue
        d = e.sec_data(i)
        for rs in e.sh:
            if rs['type'] != 4 or rs['info'] != i:
                continue
            symsec = e.sh[rs['link']]
            for j in range(rs['size'] // 12):
                off, info, addend = struct.unpack_from('<IIi', e.b, rs['off'] + j * 12)
                shndx = struct.unpack_from('<H', e.b, symsec['off'] + (info >> 8) * 16 + 14)[0]
                if shndx != si or off % 12:
                    continue
                a, n, flags = struct.unpack_from('<III', d, off)
                if flags & 8:
                    out[a + addend] = n
    return out


def xt_relocs(e, i):
    """Relocations applying to section i: [(offset, type, symbol section, symbol value, addend)]"""
    out = []
    for s in e.sh:
        if s['type'] == 4 and s['info'] == i:
            symsec = e.sh[s['link']]
            for j in range(s['size'] // 12):
                off, info, addend = struct.unpack_from('<IIi', e.b, s['off'] + j * 12)
                _, value, _, _, _, shndx = struct.unpack_from('<IIIBBH', e.b, symsec['off'] + (info >> 8) * 16)
                out.append((off, info & 0xff, shndx, value, addend))
    return out


def xt_signature(e, si, start, size):
    sec = e.sec_data(si)
    code = sec[start:start + size]
    fills = xt_fills(e, si)
    rel = {}
    expand = set()
    for off, typ, shndx, value, addend in xt_relocs(e, si):
        if not start <= off < start + size:
            continue
        if typ == R_XT_ASM_EXPAND:
            expand.add(off - start)
        elif typ == R_XT_SLOT0_OP:
            rel[off - start] = (shndx, value + addend)
        else:
            raise ValueError(f'unhandled relocation type {typ} @ {off:#x}')
    units = []
    p = 0
    filled = set()
    while p < len(code):
        if start + p in fills and p not in filled:
            filled.add(p)
            n = fills[start + p]
            assert n <= 3 and code[p:p + n] == bytes(n), (p, n)
            units.append((X_FILL, 0, 0, n))
            p += n
            continue
        w, ln = xt_word(code, p)
        if p in expand:
            # l32r aR, lit ; callxN aR
            w2, ln2 = xt_word(code, p + ln)
            assert w & 0xf == 1 and ln2 == 3 and w2 & 0xff00cf == 0xc0, (hex(w), hex(w2))
            reg = (w >> 4) & 0xf
            assert (w2 >> 8) & 0xf == reg
            units.append((X_LONGCALL, ((w2 >> 4) & 3) << 4 | reg, 0, 6))
            p += 6
            continue
        m = xt_reloc_mask(w, ln) if p in rel else (0xffff if ln == 2 else 0xffffff)
        units.append((X_EXACT, w & m, m, ln))
        if p in rel and w & 0xf == 1 and rel[p][0] not in (0, 0xfff1):
            lsec, loff = rel[p]
            if not any(o == loff for o, *_ in xt_relocs(e, lsec)):
                units.append((X_LIT, struct.unpack_from('<I', e.sec_data(lsec), loff)[0], 0xffffffff, 0))
        p += ln
    return units


def xt_funcs(e):
    """All function symbols of an object: [(name, section, start, size)]"""
    return [(s['name'], s['shndx'], s['value'], s['size']) for s in e.syms
            if (s['info'] & 0xf) == 2 and s['shndx'] not in (0, 0xfff1) and s['size'] > 0]


def xt_match_at(b, p, units, base):
    lit = None
    for i, (k, v, m, ln) in enumerate(units):
        if k == X_FILL:
            # Try every fill size; zero bytes only
            return any(p + n <= len(b) and b[p:p + n] == bytes(n) and xt_match_at(b, p + n, units[i + 1:], base)
                       for n in range(4))
        if k == X_LIT:
            if lit is None or not 0 <= lit <= len(b) - 4 or struct.unpack_from('<I', b, lit)[0] != v:
                return False
            continue
        if p >= len(b):
            return False
        n = xt_len(b[p])
        if p + n > len(b):
            return False
        w, _ = xt_word(b, p)
        if k == X_EXACT:
            if not xt_same(w, n, v, m, ln):
                return False
            if w & 0xf == 1:
                # L32R literal (segment-relative): ((pc + 3) & ~3) + (sign-extended imm16 << 2), imm16 always negative
                pc = base + p
                lit = ((pc + 3) & ~3) + (((w >> 8) | ~0xffff) << 2) - base
            p += n
        elif k == X_LONGCALL:
            cn, reg = v >> 4, v & 0xf
            if n == 3 and w & 0x3f == (cn << 4) | 5:
                p += 3
            elif n == 3 and w & 0xff == (reg << 4) | 1 and p + 6 <= len(b):
                w2 = b[p + 3] | b[p + 4] << 8 | b[p + 5] << 16
                if w2 != (0xc0 | cn << 4 | reg << 8):
                    return False
                p += 6
            else:
                return False
    return True


def xt_wide(w, ln):
    """24-bit equivalent of a density instruction, so narrow / wide forms compare equal (ld may widen or narrow when
    relaxing a longcall); None for branches and anything without one. Wide input comes back unchanged"""
    if ln == 3:
        return w
    op0, t, s, r = w & 0xf, (w >> 4) & 0xf, (w >> 8) & 0xf, (w >> 12) & 0xf
    if op0 == 0x8:  # L32I.N -> L32I
        return 0x2 | t << 4 | s << 8 | 0x2 << 12 | r << 16
    if op0 == 0x9:  # S32I.N -> S32I
        return 0x2 | t << 4 | s << 8 | 0x6 << 12 | r << 16
    if op0 == 0xa:  # ADD.N -> ADD
        return t << 4 | s << 8 | r << 12 | 0x8 << 20
    if op0 == 0xb:  # ADDI.N -> ADDI (imm 0 encodes -1)
        return 0x2 | r << 4 | s << 8 | 0xc << 12 | (t if t else 0xff) << 16
    if op0 == 0xc and not t & 8:  # MOVI.N -> MOVI (imm7 in -32..95)
        imm = (t & 7) << 4 | r
        imm = (imm - 128 if imm >= 96 else imm) & 0xfff
        return 0x2 | s << 4 | (imm >> 8) << 8 | 0xa << 12 | (imm & 0xff) << 16
    if op0 == 0xd and r == 0:  # MOV.N -> OR
        return s << 4 | s << 8 | t << 12 | 0x2 << 20
    if op0 == 0xd and r == 0xf and s == 0:
        return {0: 0x000080, 1: 0x000090, 3: 0x0020f0}.get(t)  # RET.N / RETW.N / NOP.N
    return None


def xt_same(w, n, v, m, ln):
    """Unit (v, m, ln) matches instruction w of length n, allowing narrow <-> wide only for fully exact units"""
    if n == ln:
        return w & m == v
    if m != (0xffff if ln == 2 else 0xffffff):
        return False
    a, b = xt_wide(w, n), xt_wide(v, ln)
    return a is not None and a == b


def xt_match_all(segs, units):
    hits = []
    for a, b in segs:
        for p in range((-a) & 3, len(b) - 1, 4):
            if xt_match_at(b, p, units, a):
                hits.append(a + p)
    return hits


def xt_variants(libs, funcs=FUNCS_RV, ambiguous=AMBIGUOUS_OK):
    """As variants(), for Xtensa: dedupe across versions, shortest prefix unique among all function starts"""
    corpus = []
    full = {}
    for lib in libs:
        ver = lib_version(lib)
        for mname, body in ar_members(lib):
            if not body.startswith(b'\x7fELF'):
                continue
            e = Elf(body)
            if e.machine != EM_XTENSA:
                continue
            for nm, si, start, size in xt_funcs(e):
                try:
                    u = xt_signature(e, si, start, size)
                except (ValueError, AssertionError, IndexError):
                    continue
                corpus.append((nm, u))
                if nm in funcs:
                    lst = full.setdefault(nm, {}).setdefault(tuple(u), [])
                    if ver not in lst:
                        lst.append(ver)
    out = {}
    for fn, vs in full.items():
        res = []
        for u, vers in vs.items():
            u = list(u)
            n = min(len(u), MIN_UNITS)
            while n < len(u) and any(nm != fn and cu[:n] == u[:n] for nm, cu in corpus):
                n += 4
            n = min(n, len(u))
            if any(nm != fn and cu[:n] == u[:n] for nm, cu in corpus):
                if fn not in ambiguous:
                    raise SystemExit(f'{fn} has the same signature as {sorted({nm for nm, cu in corpus if nm != fn and cu[:n] == u[:n]})[:5]}, cannot tell apart')
                dup = sorted({nm for nm, cu in corpus if nm != fn and cu[:n] == u[:n]})
                print(f'{fn}: same shape as {dup[:6]}..., located via call site', file=sys.stderr)
            pre = u[:n]
            for r in res:
                if r[0] == pre:
                    r[1].extend(v for v in vers if v not in r[1])
                    break
            else:
                res.append((pre, list(vers)))
        out[fn] = res
    return out


XT_HEAD = [
    '//! Generated by tools/ble_sigs.py gen-xt, do not edit. Source: ESP32-S3 libbtdm_app*.a shipped with ESP-IDF 5.1.0-5.5.1',
    '//! (esp32c3-bt-lib, Apache-2.0). Masked instruction values only; each entry: (kind, masked value, mask, length), kind per sig_xt.rs.',
]
# Classic ESP32 (LX6, dual-mode BTDM controller, E-09): no extend pll_track (sdk_config_set_bt_pll_track_enable only stores a
# flag, runs natively); get_mode has the same shape as get_sleep_mode and is told apart by its call site (sig_xt.rs)
# btdm_in_wakeup_requesting_set: bt.c calls it around every VHCI send; it takes a semaphore through the controller's own
# osi pointer, which stays NULL because registration is hooked, so it becomes a no-op (Hooks.pll_track slot)
FUNCS_LX6 = [f for f in FUNCS_RV if f != 'sdk_config_extend_set_pll_track'] + ['btdm_in_wakeup_requesting_set']
AMBIGUOUS_LX6 = {'btdm_controller_get_mode'}
LX6_HEAD = [
    '//! Generated by tools/ble_sigs.py gen-lx6, do not edit. Source: classic ESP32 components/bt/controller/lib_esp32/esp32/libbtdm_app.a',
    '//! shipped with ESP-IDF 5.5.1 (Apache-2.0). Masked instruction values only; each entry: (kind, masked value, mask, length), see sig_xt.rs.',
]


def xt_gen(out, libs, funcs=FUNCS_RV, ambiguous=AMBIGUOUS_OK, head=XT_HEAD):
    var = xt_variants(libs, funcs, ambiguous)
    lines = head + [
        '',
        'use super::sig::Unit;',
        '',
    ]
    total = 0
    for fn in funcs:
        vs = var.get(fn)
        if not vs:
            raise SystemExit(f'{fn} not found in the library')
        lines.append(f'/// {fn}: {len(vs)} version variant{"s" if len(vs) != 1 else ""}')
        lines.append(f'pub const {fn.upper()}: &[&[Unit]] = &[')
        for units, vers in vs:
            total += len(units)
            lines.append(f'    // {", ".join(vers)}')
            lines.append('    &[')
            for k, v, m, ln in units:
                lines.append(f'        Unit({k}, 0x{v:06x}, 0x{m:06x}, {ln}),')
            lines.append('    ],')
        lines.append('];')
        lines.append('')
    open(out, 'w').write('\n'.join(lines))
    print(f'wrote {out}: {len(funcs)} functions, {total} units')


def xt_call_targets(segs, b, p, pc):
    """Target of the call at p: CALLn, or an unrelaxed `l32r aR, lit; callxN aR` (as call_target in sig_xt.rs)"""
    if p + 3 > len(b) or xt_len(b[p]) != 3:
        return None
    w = b[p] | b[p + 1] << 8 | b[p + 2] << 16
    if w & 0xf == 5 and (w >> 4) & 3:
        off = ((w >> 6) ^ 0x20000) - 0x20000
        return ((pc & ~3) + (off << 2) + 4) & 0xffffffff, 3
    if w & 0xf == 1 and p + 6 <= len(b):
        reg, w2 = (w >> 4) & 0xf, b[p + 3] | b[p + 4] << 8 | b[p + 5] << 16
        if w2 & 0xff00cf == 0xc0 and w2 & 0x30 and (w2 >> 8) & 0xf == reg:
            lit = (((pc + 3) & ~3) + (((w >> 8) | ~0xffff) << 2)) & 0xffffffff
            for a, sb in segs:
                if a <= lit < a + len(sb) - 3:
                    return struct.unpack_from('<I', sb, lit - a)[0], 6
    return None


def lx6_mode_by_call(segs, enable, cands):
    """LX6 get_mode: the earliest candidate called within MODE_BACK bytes before each call of btdm_controller_enable"""
    found = set()
    for a, b in segs:
        for p in range(len(b)):
            t = xt_call_targets(segs, b, p, a + p)
            if not t or t[0] != enable:
                continue
            for q in range(max(0, p - MODE_BACK), p):
                c = xt_call_targets(segs, b, q, a + q)
                if c and q + c[1] <= p and c[0] in cands:
                    found.add(c[0])
                    break
    return sorted(found)


# Bytes searched back from the btdm_controller_enable call in esp_bt_controller_enable (sig_xt.rs MODE_BACK)
MODE_BACK = 96


def xt_check(binp, elfp, libs, funcs=FUNCS_RV, ambiguous=AMBIGUOUS_OK):
    """Each full-length object signature must hit exactly once, at the ELF symbol address"""
    segs = app_segments(open(binp, 'rb').read())
    e = Elf(open(elfp, 'rb').read())
    truth = {s['name']: s['value'] for s in e.syms if s['name'] in funcs and (s['info'] & 0xf) == 2}
    lx6 = funcs is FUNCS_LX6
    ok = True
    for fn in funcs:
        hits = None
        for lib in libs:
            for mname, body in ar_members(lib):
                if not body.startswith(b'\x7fELF'):
                    continue
                oe = Elf(body)
                for nm, si, start, size in xt_funcs(oe):
                    if nm == fn:
                        h = xt_match_all(segs, xt_signature(oe, si, start, size)[:MAX_UNITS])
                        if h:
                            hits = h
        if lx6 and fn in ambiguous and hits:
            # Resolved the way sig_xt.rs does it: by the call site before btdm_controller_enable
            hits = lx6_mode_by_call(segs, truth['btdm_controller_enable'], set(hits))
        good = hits == [truth.get(fn)] or (fn in ambiguous and truth.get(fn) in (hits or []))
        ok &= good
        print(('OK ' if good else 'BAD'), fn, [hex(h) for h in hits or []], 'elf', hex(truth.get(fn, 0)))
    sys.exit(0 if ok else 1)


def main():
    cmd = sys.argv[1]
    if cmd == 'gen-xt':
        return xt_gen(sys.argv[2], sys.argv[3:])
    if cmd == 'check-xt':
        return xt_check(sys.argv[2], sys.argv[3], sys.argv[4:])
    if cmd == 'gen-lx6':
        return xt_gen(sys.argv[2], sys.argv[3:], FUNCS_LX6, AMBIGUOUS_LX6, LX6_HEAD)
    if cmd == 'check-lx6':
        return xt_check(sys.argv[2], sys.argv[3], sys.argv[4:], FUNCS_LX6, AMBIGUOUS_LX6)
    if cmd == 'gen':
        out, libs = sys.argv[2], sys.argv[3:]
        var = variants(libs)
        lines = [
            '//! Generated by tools/ble_sigs.py, do not edit. Source: libbtdm_app*.a shipped with ESP-IDF 5.1.0-5.5.1 (esp32c3-bt-lib, Apache-2.0).',
            '//! Masked instruction values only, no raw library bytes; each entry: (kind, masked value, mask, length), kind per Kind in sig.rs.',
            '',
            'use super::sig::Unit;',
            '',
        ]
        total = 0
        for fn in FUNCS_RV:
            vs = var.get(fn)
            if not vs:
                raise SystemExit(f'{fn} not found in the library')
            lines.append(f'/// {fn}: {len(vs)} version variant{"s" if len(vs) != 1 else ""}')
            lines.append(f'pub const {fn.upper()}: &[&[Unit]] = &[')
            for units, vers in vs:
                total += len(units)
                lines.append(f'    // {", ".join(vers)}')
                lines.append('    &[')
                for k, v, m, ln in units:
                    lines.append(f'        Unit({k}, 0x{v:08x}, 0x{m:08x}, {ln}),')
                lines.append('    ],')
            lines.append('];')
            lines.append('')
        open(out, 'w').write('\n'.join(lines))
        print(f'wrote {out}: {len(FUNCS_RV)} functions, {total} units')
    elif cmd == 'check':
        binp, elfp, libs = sys.argv[2], sys.argv[3], sys.argv[4:]
        found = find_funcs(libs, FUNCS_RV)
        segs = app_segments(open(binp, 'rb').read())
        e = Elf(open(elfp, 'rb').read())
        truth = {s['name']: s['value'] for s in e.syms if s['name'] in FUNCS_RV and (s['info'] & 0xf) == 2}
        ok = True
        for fn in FUNCS_RV:
            lib, mname, oe, si = found[fn]
            u = rv_signature(oe, si)[:MAX_UNITS]
            hits = match_all(segs, u)
            good = hits == [truth.get(fn)] or (fn in AMBIGUOUS_OK and truth.get(fn) in hits)
            ok &= good
            print(('OK ' if good else 'BAD'), fn, [hex(h) for h in hits], 'elf', hex(truth.get(fn, 0)))
        sys.exit(0 if ok else 1)
    elif cmd == 'dump':
        libs = sys.argv[2:]
        found = find_funcs(libs, FUNCS_RV)
        for fn in FUNCS_RV:
            lib, mname, e, si = found[fn]
            u = rv_signature(e, si)
            print(fn, mname, len(e.sec_data(si)), 'bytes', len(u), 'units',
                  sum(1 for x in u if x[0] != K_EXACT), 'reloc')


if __name__ == '__main__':
    main()
