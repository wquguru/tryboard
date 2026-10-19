#!/usr/bin/env python3
"""从乐鑫预编译 BLE 控制器库（libbtdm_app*.a）算出 VHCI 边界函数的掩码签名（C-01 路线 a′）。

用法：
  tools/ble_sigs.py gen  <输出.rs> <库.a>...        生成 core/crates/soc/src/ble/sigs.rs
  tools/ble_sigs.py check <app.elf> <库.a>...        对照 ELF 符号，检查每个签名在 .bin 里命中唯一且地址正确

签名 = 函数字节在"去掉重定位字段"后的样子。仓库里只存：每条指令的 掩码后取值、掩码、长度
（重定位立即数位一律清零），不存库的原始二进制、不存反汇编。为对付链接器松弛（R_RISCV_RELAX：
auipc+jalr → jal、lui+lw → gp 相对），按指令序列匹配，见 core/crates/soc/src/ble/sig.rs。
"""
import struct
import sys

# 要定位的函数（libbtdm 里的符号）。Xtensa（S3）另列。
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
# 签名和同目标文件里别的 setter 一样，Rust 侧从 esp_bt_controller_enable 的调用点确认（见 sig.rs）
AMBIGUOUS_OK = {'sdk_config_extend_set_pll_track'}


def ar_members(path):
    """GNU ar：返回 [(名字, 字节)]"""
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
        """RELA 段里作用于第 i 段的重定位：[(偏移, 类型, 符号名)]"""
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


# RISC-V 重定位类型
R_BRANCH, R_JAL, R_CALL, R_CALL_PLT = 16, 17, 18, 19
R_HI20, R_LO12_I, R_LO12_S = 26, 27, 28
R_RVC_BRANCH, R_RVC_JUMP, R_RELAX = 44, 45, 51
R_PCREL_HI20, R_PCREL_LO12_I, R_PCREL_LO12_S = 23, 24, 25
R_ALIGN = 43

# 指令种类（与 sig.rs 的 Kind 对应）
K_EXACT, K_CALL, K_HI20, K_LO12 = 0, 1, 2, 3


def insns(code):
    """按 RVC 长度切指令：[(偏移, 长度, 字)]"""
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
            raise ValueError('含 R_RISCV_ALIGN，无法签名')
        else:
            rel[off] = typ
    units = []  # (kind, value, mask, len)
    ins = insns(code)
    i = 0
    while i < len(ins):
        off, ln, w = ins[i]
        t = rel.get(off)
        if t in (R_CALL, R_CALL_PLT):
            # auipc ra + jalr ra：可能被松弛成 jal ra（4 字节）
            assert ins[i + 1][1] == 4
            rd = (w >> 7) & 31
            units.append((K_CALL, rd, 0, 8))
            i += 2
            continue
        if t == R_HI20:
            # lui rd：松弛时可能整条删掉（随后的 lo12 改成 gp 相对）
            units.append((K_HI20, w & 0xfff, 0xfff, 4))
            i += 1
            continue
        if t in (R_LO12_I, R_LO12_S):
            if t == R_LO12_I:
                m = 0x000fffff
            else:
                m = 0x01fff07f
            # 松弛成 gp 相对时 rs1 变成 gp（x3），所以 rs1 也掩掉
            m &= ~(31 << 15)
            units.append((K_LO12, w & m, m, 4))
            i += 1
            continue
        if t in (R_BRANCH, R_RVC_BRANCH, R_JAL, R_RVC_JUMP, R_PCREL_HI20, R_PCREL_LO12_I, R_PCREL_LO12_S):
            # 段内跳转的位移会随松弛改变：掩掉立即数，只留操作码与寄存器
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
            raise ValueError(f'未处理的重定位类型 {t} @ {off:#x}')
        m = 0xffffffff if ln == 4 else 0xffff
        units.append((K_EXACT, w & m, m, ln))
        i += 1
    return units


def find_funcs(libs, funcs):
    """在库里找函数所在段（-ffunction-sections：.text.<名字> 或 .iram1.<n>）"""
    found = {}
    for lib in libs:
        for mname, body in ar_members(lib):
            if not body.startswith(b'\x7fELF'):
                continue
            e = Elf(body)
            for s in e.syms:
                if s['name'] in funcs and s['shndx'] not in (0, 0xfff1) and (s['info'] & 0xf) == 2:
                    if s['value'] != 0:
                        raise ValueError(f"{s['name']} 不在段首")
                    found.setdefault(s['name'], (lib, mname, e, s['shndx']))
    return found


MAX_UNITS = 96


def app_segments(flash):
    """flash 镜像 → app 的代码段 [(加载地址, 字节)]"""
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
                # 视为松弛删掉了这条 lui：紧接着的低 12 位访问必须改成 gp 相对
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
    # third_party/btlib/<版本>/<芯片>/<库>
    parts = path.replace('\\', '/').split('/')
    return parts[-3] if len(parts) >= 3 else path


MIN_UNITS = 24


def variants(libs):
    """每个函数在各版本库里的签名去重，截到"在全部库的函数开头里唯一"的最短前缀（至少 MIN_UNITS 条）"""
    corpus = []  # 所有库里每个函数段的签名（-ffunction-sections，一段一个函数）
    full = {}  # 函数名 → {签名: [版本]}
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
                    raise SystemExit(f'{fn} 的签名与其它函数相同，无法区分')
                dup = sorted({nm for nm, cu in corpus if nm != fn and cu[:n] == u[:n]})
                print(f'{fn}: 与 {dup} 同形，靠调用点定位', file=sys.stderr)
            pre = u[:n]
            for r in res:
                if r[0] == pre:
                    r[1].extend(v for v in vers if v not in r[1])
                    break
            else:
                res.append((pre, list(vers)))
        out[fn] = res
    return out


def main():
    cmd = sys.argv[1]
    if cmd == 'gen':
        out, libs = sys.argv[2], sys.argv[3:]
        var = variants(libs)
        lines = [
            '//! 由 tools/ble_sigs.py 生成，勿手改。',
            '//! 来源：ESP-IDF 5.1–5.5.1 自带的 libbtdm_app*.a（esp32c3-bt-lib，Apache-2.0）。只含掩码后的指令值，',
            '//! 不含库的原始字节；每个函数只取够区分的前若干条指令。',
            '//! 每项：(种类, 掩码后取值, 掩码, 长度)；种类见 sig.rs 的 Kind。',
            '',
            'use super::sig::Unit;',
            '',
        ]
        total = 0
        for fn in FUNCS_RV:
            vs = var.get(fn)
            if not vs:
                raise SystemExit(f'库里找不到 {fn}')
            lines.append(f'/// {fn}：{len(vs)} 个版本变体')
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
        print(f'写出 {out}：{len(FUNCS_RV)} 个函数，共 {total} 条')
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
            good = hits == [truth.get(fn)]
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
