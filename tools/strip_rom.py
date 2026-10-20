#!/usr/bin/env python3
"""Drop non-alloc Xtensa attribute sections (.xt.prop / .xt.lit) from a ROM ELF.

Usage: strip_rom.py IN.elf OUT.elf [--verify]
The simulator reads only loadable content and .symtab, so those tables are dead
weight on the web. Section data is compacted and offsets are rewritten; the
removed range must not overlap any PT_LOAD file range. No third-party deps.
"""
import struct
import sys

DROP = (".xt.prop", ".xt.lit")


def parse(b):
    assert b[:4] == b"\x7fELF" and b[4] == 1 and b[5] == 1, "ELF32 LE only"
    phoff, shoff = struct.unpack_from("<II", b, 28)
    phentsize, phnum, shentsize, shnum, shstrndx = struct.unpack_from("<HHHHH", b, 42)
    sh = [list(struct.unpack_from("<10I", b, shoff + i * shentsize)) for i in range(shnum)]
    ph = [list(struct.unpack_from("<8I", b, phoff + i * phentsize)) for i in range(phnum)]
    so = sh[shstrndx][4]
    names = [b[so + s[0]:b.index(b"\0", so + s[0])].decode() for s in sh]
    return phoff, shoff, phentsize, shentsize, shstrndx, sh, ph, names


def strip(b):
    phoff, shoff, phentsize, shentsize, shstrndx, sh, ph, names = parse(b)
    drop = [i for i, n in enumerate(names) if n in DROP]
    ranges = sorted((sh[i][4], sh[i][4] + sh[i][5]) for i in drop)
    for p in ph:
        for lo, hi in ranges:
            assert not (p[1] < hi and lo < p[1] + p[4]), "dropped section overlaps a segment"
    assert all(hi <= shoff for _, hi in ranges)

    def new_off(o):
        return o - sum(hi - lo for lo, hi in ranges if hi <= o)

    out = bytearray()
    pos = 0
    for lo, hi in ranges:
        out += b[pos:lo]
        pos = hi
    out += b[pos:shoff]
    new_shoff = len(out)
    keep = [i for i in range(len(sh)) if i not in drop]
    remap = {old: new for new, old in enumerate(keep)}
    for i in keep:
        s = list(sh[i])
        s[4] = new_off(s[4])
        if s[6] in remap and s[6] != 0:
            s[6] = remap[s[6]]
        elif s[6] != 0:
            raise AssertionError("link to dropped section")
        out += struct.pack("<10I", *s)
    out += b[shoff + len(sh) * shentsize:]
    out = bytearray(out)
    struct.pack_into("<I", out, 32, new_shoff)
    struct.pack_into("<H", out, 48, len(keep))
    struct.pack_into("<H", out, 50, remap[shstrndx])
    for i, p in enumerate(ph):
        struct.pack_into("<I", out, phoff + i * phentsize + 4, new_off(p[1]))
    return bytes(out)


def view(b):
    phoff, shoff, phentsize, shentsize, shstrndx, sh, ph, names = parse(b)
    loads = [(p[2], p[3], p[5], b[p[1]:p[1] + p[4]]) for p in ph if p[0] == 1]
    secs = {(n, s[3]): b[s[4]:s[4] + s[5]] for n, s in zip(names, sh) if s[1] == 1 and s[2] & 2 or s[1] == 1 and s[3]}
    symi = next(i for i, s in enumerate(sh) if s[1] == 2)
    st = sh[symi]
    strs = sh[st[6]]
    syms = set()
    for k in range(st[5] // 16):
        nm, val, size, info, other, shndx = struct.unpack_from("<IIIBBH", b, st[4] + k * 16)
        e = b.index(b"\0", strs[4] + nm)
        syms.add((b[strs[4] + nm:e].decode(), val))
    return loads, secs, syms


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    a = open(src, "rb").read()
    o = strip(a)
    open(dst, "wb").write(o)
    la, sa, ya = view(a)
    lo, so_, yo = view(o)
    # The first segment maps the ELF header itself; only e_shoff/e_shnum/e_shstrndx may change.
    mask = set(range(32, 36)) | set(range(48, 52))
    for x, y in zip(la, lo):
        assert x[:3] == y[:3] and len(x[3]) == len(y[3]), "PT_LOAD layout differs"
        diff = {i for i in range(len(x[3])) if x[3][i] != y[3][i]}
        assert diff <= mask, "PT_LOAD bytes differ"
    assert len(la) == len(lo)
    assert {k: v for k, v in sa.items()} == {k: v for k, v in so_.items()}, "section data differ"
    assert ya == yo and ya, "symbols differ"
    print(f"{src}: {len(a)} -> {len(o)} bytes; {len(la)} PT_LOAD identical, {len(ya)} symbols identical")
