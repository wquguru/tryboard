"""字体子集化（P2-19）：third_party/fonts 的可变字重 TTF → web/public/fonts 下的 WOFF2 + fonts.css + OFL.txt。

字集 = 页面实际用到的字（扫描 web/src、web/*.html、生成的授权页、发布的示例清单）∪ GB2312 一级字（3755 个常用字，
直接由 Python 自带的 gb2312 编解码器推出来，不用另外下载字表）∪ ASCII / 常用标点。字集不变就跳过。
没有字体原件或没有 fonttools 时写一份空的 fonts.css（页面退回系统字体，不出 404），并在 stderr 说明。
用法：tools/fonts/.venv/bin/python -I tools/fonts/subset.py <仓库根>
"""

import hashlib
import os
import sys

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "../.."))
SRC = os.path.join(ROOT, "third_party/fonts")
OUT = os.path.join(ROOT, "web/public/fonts")
# 子集文件名不带字体原名（OFL：改过的版本不能用保留名；Noto 的保留名是 "Source"，干脆都不用原名）
SANS = "tb-sans-sc.woff2"
MONO = "tb-mono.woff2"
SCAN_EXT = (".ts", ".tsx", ".css", ".json", ".html", ".md")


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
    chars = set()
    files = []
    for d in ("web/src",):
        for dp, dn, fn in os.walk(os.path.join(ROOT, d)):
            dn[:] = [x for x in dn if x != "node_modules"]
            files += [os.path.join(dp, f) for f in fn if f.endswith(SCAN_EXT)]
    web = os.path.join(ROOT, "web")
    files += [os.path.join(web, f) for f in os.listdir(web) if f.endswith(".html")]
    files += [os.path.join(ROOT, p) for p in ("web/public/fw/examples.json", "firmware/examples.json", "firmware/levels.json", "firmware/accept.json")]
    for f in files:
        if os.path.isfile(f):
            with open(f, encoding="utf-8", errors="ignore") as h:
                chars.update(h.read())
    return chars


def write_css(body):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "fonts.css"), "w", encoding="utf-8") as h:
        h.write(body)


def main():
    sans_src = os.path.join(SRC, "NotoSansSC-wght.ttf")
    mono_src = os.path.join(SRC, "JetBrainsMono-wght.ttf")
    try:
        from fontTools import subset  # noqa: F401
    except ImportError:
        subset = None
    if subset is None or not (os.path.isfile(sans_src) and os.path.isfile(mono_src)):
        print("[fonts] 没有字体原件或 fonttools（先跑 tools/fonts/fetch.sh；venv 见 build_web.sh），页面用系统字体", file=sys.stderr)
        write_css("/* 字体未构建：tools/fonts/fetch.sh 后重跑 tools/build_web.sh */\n")
        return
    chars = scan() | set(gb2312_level1())
    chars |= {chr(c) for c in range(0x20, 0x7F)}
    chars |= set("，。、；：？！“”‘’（）《》【】—…·「」『』〈〉￥％＋－×÷～")
    # 只要能显示的字：去掉控制符
    cps = sorted(ord(c) for c in chars if ord(c) >= 0x20 and not (0xD800 <= ord(c) < 0xE000))
    key = hashlib.sha256((",".join(map(str, cps)) + "|" + open(os.path.join(SRC, "REVISION")).read().strip()).encode()).hexdigest()
    # 戳记放在原件目录：放 public 里会被原样发布
    stamp = os.path.join(SRC, ".subset-stamp")
    outs = [os.path.join(OUT, f) for f in (SANS, MONO, "fonts.css", "OFL-NotoSansSC.txt", "OFL-JetBrainsMono.txt")]
    if all(os.path.isfile(f) for f in outs) and os.path.isfile(stamp) and open(stamp).read() == key:
        print(f"[fonts] 字集没变（{len(cps)} 个码位），跳过")
        return
    os.makedirs(OUT, exist_ok=True)
    from fontTools.subset import Options, Subsetter
    from fontTools.ttLib import TTFont

    def run(src, dst, unicodes):
        opt = Options()
        opt.flavor = "woff2"
        opt.layout_features = ["*"]
        opt.name_IDs = ["*"]
        opt.notdef_outline = True
        f = TTFont(src)
        s = Subsetter(opt)
        s.populate(unicodes=unicodes)
        s.subset(f)
        f.flavor = "woff2"
        f.save(dst)
        return os.path.getsize(dst)

    n_sans = run(sans_src, os.path.join(OUT, SANS), cps)
    # 等宽字只用来显示代码、串口、数字：整套西文 + 符号都留着（原件才 190 KB），不含汉字
    mono_cps = [c for c in TTFont(mono_src).getBestCmap()]
    n_mono = run(mono_src, os.path.join(OUT, MONO), mono_cps)
    for f in ("OFL-NotoSansSC.txt", "OFL-JetBrainsMono.txt"):
        with open(os.path.join(SRC, f), "rb") as a, open(os.path.join(OUT, f), "wb") as b:
            b.write(a.read())
    rev = open(os.path.join(SRC, "REVISION")).read().strip()
    write_css(
        f"""/* 自托管字体（P2-19）：google/fonts@{rev[:12]} 的可变字重 TTF 子集化成 WOFF2，SIL OFL 1.1（见同目录 OFL-*.txt）。
   tools/fonts/subset.py 生成，别手改。family 名沿用原名，页面里的字体栈不用改。 */
@font-face {{ font-family: 'Noto Sans SC'; src: url('./{SANS}') format('woff2'); font-weight: 100 900; font-style: normal; font-display: swap; }}
@font-face {{ font-family: 'JetBrains Mono'; src: url('./{MONO}') format('woff2'); font-weight: 100 800; font-style: normal; font-display: swap; }}
"""
    )
    with open(stamp, "w") as h:
        h.write(key)
    print(f"[fonts] {len(cps)} 个码位 → {SANS} {n_sans / 1024:.0f} KB，{MONO} {n_mono / 1024:.0f} KB")


main()
