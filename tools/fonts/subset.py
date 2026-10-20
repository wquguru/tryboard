"""Font subsetting (P2-19, R-17): variable TTFs in third_party/fonts -> WOFF2 slices + fonts.css + OFL.txt in web/public/fonts.
Chars = scanned text (web/src incl. i18n dictionaries, *.html, examples) | GB2312 level 1 | kana | ASCII; usage: subset.py <repo root>."""

import collections
import glob
import hashlib
import os
import sys
import tempfile

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "../.."))
SRC = os.path.join(ROOT, "third_party/fonts")
OUT = os.path.join(ROOT, "web/public/fonts")
# Subset files avoid the original names (OFL Reserved Font Names may not label modified versions).
SANS = "tb-sans-sc-{}.woff2"
MONO = "tb-mono.woff2"
SCAN_EXT = (".ts", ".tsx", ".css", ".json", ".html", ".md")
# Only weights 400-700 appear in the CSS (font-medium / semibold / bold); narrowing the axis shrinks every slice.
WGHT = (400, 700)
# Bump when the slicing scheme changes so the stamp forces a rebuild.
LAYOUT = "r17-v3"
# Hanzi per slice (~250 B each with two wght masters, so ~100 KB files); a page fetches only slices it renders.
HANZI_CHUNK = 400
# Horizontal text only: vertical, width and ornament alternates (vert, hwid, pwid, ...) tripled the kana slice.
# tnum is kept for the CSS tabular-nums, should a later Noto build add it (this one has none).
FEATURES = ["ccmp", "locl", "kern", "liga", "clig", "calt", "rlig", "rvrn", "mark", "mkmk", "tnum"]


def gb2312_level1():
    out = []
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                out.append(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return out


def scan():
    chars = collections.Counter()
    files = []
    # web/src includes web/src/i18n/**, so every translated string (zh / ja / ko) is covered.
    for d in ("web/src",):
        for dp, dn, fn in os.walk(os.path.join(ROOT, d)):
            dn[:] = [x for x in dn if x != "node_modules"]
            files += [os.path.join(dp, f) for f in fn if f.endswith(SCAN_EXT)]
    web = os.path.join(ROOT, "web")
    files += [os.path.join(web, f) for f in os.listdir(web) if f.endswith(".html")]
    files += [os.path.join(ROOT, p) for p in ("web/public/fw/examples.json", "firmware/examples.json", "firmware/levels.json", "firmware/accept.json")]
    for f in sorted(files):
        if os.path.isfile(f):
            with open(f, encoding="utf-8", errors="ignore") as h:
                chars.update(h.read())
    return chars


def write_css(body):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "fonts.css"), "w", encoding="utf-8") as h:
        h.write(body)


def ranges(cps):
    """unicode-range value for a sorted code point list, consecutive runs collapsed."""
    out, i = [], 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        out.append(f"U+{cps[i]:X}" if i == j else f"U+{cps[i]:X}-{cps[j]:X}")
        i = j + 1
    return ",".join(out)


def is_cjk_punct(c):
    return 0x3000 <= c < 0x3040 or 0xFF00 <= c < 0xFFF0


def slices(cps, freq):
    """Latin (incl. symbols / general punctuation) | CJK punctuation | kana | hanzi by scan frequency, then the rest."""
    latin = [c for c in cps if c < 0x2E80]
    punct = [c for c in cps if is_cjk_punct(c)]
    kana = [c for c in cps if 0x3040 <= c < 0x3100]
    taken = set(latin) | set(punct) | set(kana)
    rest = [c for c in cps if c not in taken]
    # Most-used hanzi first so a zh / ja page usually needs only the first hanzi slices.
    used = sorted((c for c in rest if freq[chr(c)]), key=lambda c: (-freq[chr(c)], c))
    unused = [c for c in rest if not freq[chr(c)]]
    out = [("latin", latin), ("cjk-punct", punct), ("kana", kana)]
    for n, i in enumerate(range(0, len(used), HANZI_CHUNK)):
        out.append((f"hanzi-used-{n}", sorted(used[i : i + HANZI_CHUNK])))
    for n, i in enumerate(range(0, len(unused), HANZI_CHUNK)):
        out.append((f"hanzi-{n}", unused[i : i + HANZI_CHUNK]))
    return [(name, s) for name, s in out if s]


def main():
    sans_src = os.path.join(SRC, "NotoSansSC-wght.ttf")
    mono_src = os.path.join(SRC, "JetBrainsMono-wght.ttf")
    try:
        from fontTools import subset  # noqa: F401
    except ImportError:
        subset = None
    if subset is None or not (os.path.isfile(sans_src) and os.path.isfile(mono_src)):
        print("[fonts] no source fonts or fonttools (run tools/fonts/fetch.sh; venv in build_web.sh); pages use system fonts", file=sys.stderr)
        write_css("/* Fonts not built: run tools/fonts/fetch.sh, then tools/build_web.sh again. */\n")
        return
    freq = scan()
    chars = set(freq) | set(gb2312_level1())
    chars |= {chr(c) for c in range(0x20, 0x7F)}
    chars |= set("，。、；：？！“”‘’（）《》【】—…·「」『』〈〉￥％＋－×÷～")  # lint: allow-cjk
    # All hiragana and katakana (U+3040–30FF, incl. ー・) so ja text never mixes in fallback glyphs; Hangul is not in Noto Sans SC.
    chars |= {chr(c) for c in range(0x3040, 0x3100)}
    from fontTools.ttLib import TTFont

    cmap = TTFont(sans_src).getBestCmap()
    # Printable characters the font has: drop control codes, surrogates and code points it would only draw as .notdef.
    cps = sorted(ord(c) for c in chars if ord(c) >= 0x20 and not (0xD800 <= ord(c) < 0xE000) and ord(c) in cmap)
    plan = slices(cps, freq)
    sig = ";".join(name + ":" + ",".join(map(str, s)) for name, s in plan)
    key = hashlib.sha256((LAYOUT + "|" + sig + "|" + open(os.path.join(SRC, "REVISION")).read().strip()).encode()).hexdigest()
    # The stamp lives next to the sources: anything in public would be shipped.
    stamp = os.path.join(SRC, ".subset-stamp")
    sans_files = [SANS.format(name) for name, _ in plan]
    outs = [os.path.join(OUT, f) for f in sans_files + [MONO, "fonts.css", "OFL-NotoSansSC.txt", "OFL-JetBrainsMono.txt"]]
    if all(os.path.isfile(f) for f in outs) and os.path.isfile(stamp) and open(stamp).read() == key:
        print(f"[fonts] character set unchanged ({len(cps)} code points, {len(plan)} slices), skipping")
        return
    os.makedirs(OUT, exist_ok=True)
    # Old single-file or stale slice outputs would still be shipped from public: remove them first.
    for f in glob.glob(os.path.join(OUT, "tb-sans-sc*.woff2")):
        os.remove(f)
    from fontTools.subset import Options, Subsetter
    from fontTools.varLib import instancer

    def run(font, dst, unicodes, features):
        opt = Options()
        opt.flavor = "woff2"
        opt.layout_features = features
        opt.name_IDs = ["*"]
        opt.notdef_outline = True
        s = Subsetter(opt)
        s.populate(unicodes=unicodes)
        s.subset(font)
        font.flavor = "woff2"
        font.save(dst)
        return os.path.getsize(dst)

    # Private temp file: third_party/fonts may be shared by several worktrees building at once.
    fd, narrowed = tempfile.mkstemp(suffix=".ttf")
    os.close(fd)
    instancer.instantiateVariableFont(TTFont(sans_src), {"wght": WGHT}).save(narrowed)
    faces, report = [], []
    w = f"{WGHT[0]} {WGHT[1]}"
    for (name, s), fname in zip(plan, sans_files):
        n = run(TTFont(narrowed), os.path.join(OUT, fname), s, FEATURES)
        report.append(f"{name} {len(s)}cp {n / 1024:.0f}KB")
        src = f"url('./{fname}') format('woff2')"
        faces.append(f"@font-face {{ font-family: 'Noto Sans SC'; src: {src}; font-weight: {w}; font-style: normal; font-display: swap; unicode-range: {ranges(s)}; }}")
        if name == "latin":
            # Latin-only alias: stacks put it first, then system CJK fonts, so Latin looks the same in every language.
            faces.append(f"@font-face {{ font-family: 'TB Sans'; src: {src}; font-weight: {w}; font-style: normal; font-display: swap; unicode-range: {ranges(s)}; }}")
    os.remove(narrowed)
    # Mono is only for code, serial and numbers: keep its whole Latin + symbol set (190 KB source), no CJK.
    mono_cps = [c for c in TTFont(mono_src).getBestCmap()]
    n_mono = run(TTFont(mono_src), os.path.join(OUT, MONO), mono_cps, ["*"])
    for f in ("OFL-NotoSansSC.txt", "OFL-JetBrainsMono.txt"):
        with open(os.path.join(SRC, f), "rb") as a, open(os.path.join(OUT, f), "wb") as b:
            b.write(a.read())
    rev = open(os.path.join(SRC, "REVISION")).read().strip()
    head = f"""/* Self-hosted fonts (P2-19, R-17): google/fonts@{rev[:12]} variable TTFs subset to WOFF2 slices, SIL OFL 1.1 (see OFL-*.txt).
   Generated by tools/fonts/subset.py, do not edit; a browser fetches a slice only when the page renders a character in its unicode-range. */
"""
    mono = f"@font-face {{ font-family: 'JetBrains Mono'; src: url('./{MONO}') format('woff2'); font-weight: 100 800; font-style: normal; font-display: swap; }}\n"
    write_css(head + "\n".join(faces) + "\n" + mono)
    with open(stamp, "w") as h:
        h.write(key)
    print(f"[fonts] {len(cps)} code points -> {len(plan)} sans slices ({'; '.join(report)}), {MONO} {n_mono / 1024:.0f} KB")


main()
