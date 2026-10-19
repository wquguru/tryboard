#!/usr/bin/env python3
"""R-14 guardrails: keep the structural fixes of R-05..R-12 from eroding.

Rules (web/src TS/TSX and core/crates Rust):
  size    file > 1500 lines, function > 400 lines
  raf     requestAnimationFrame outside web/src/ui/frame.ts
  chip    chip id string literals ('esp32' / 'esp32c3' / 'esp32s3') outside web/src/chips.ts / chipid.ts
  layer   `esp32c3::` in another chip crate or in soc / machine
Existing offenders live in tools/lint_size.allow.json with their current size / count: they may shrink, never grow.
Usage: tools/lint_size.py            report, exit 1 on any new or grown violation
       tools/lint_size.py --update   rewrite the allow list from the current tree (only after shrinking something)
       tools/lint_size.py --selftest plant one violation per rule in a temp tree and confirm each is reported
"""
import json
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALLOW = ROOT / "tools/lint_size.allow.json"
MAX_FILE, MAX_FN = 1500, 400
CHIP_HOME = {"web/src/chips.ts", "web/src/chipid.ts"}
FRAME_HOME = "web/src/ui/frame.ts"
CHIP_LIT = re.compile(r"""['"](esp32|esp32c3|esp32s3)['"]""")
# A line that opens a function body: TS function / method / arrow, or Rust fn
TS_FN = re.compile(r"^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|(?:const|let)\s+(\w+)\s*=.*=>\s*\{$|(\w+)\s*\([^;]*\)\s*(?::[^=]*)?\{$)")
RS_FN = re.compile(r"^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+\"C\"\s+)?fn\s+(\w+)")
KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "else", "do", "with"}


def sources(root):
    web = [p for p in (root / "web/src").rglob("*") if p.suffix in (".ts", ".tsx") and "node_modules" not in p.parts]
    rs = [p for p in (root / "core/crates").rglob("*.rs") if "target" not in p.parts]
    return web + rs


def functions(lines, rust):
    """(name, length) for each function, closed by the first `}` line at the opening line's indent."""
    out = []
    for i, line in enumerate(lines):
        m = (RS_FN if rust else TS_FN).match(line)
        if not m:
            continue
        name = next((g for g in m.groups()[1:] if g), "?")
        if name in KEYWORDS:
            continue
        indent = m.group(1)
        for j in range(i + 1, len(lines)):
            if lines[j].startswith(indent + "}") and not lines[j].startswith(indent + " "):
                out.append((f"{name}@{i + 1}", j - i + 1))
                break
    return out


def scan(root):
    """{key: measure} for every violation in the tree at root."""
    found = {}
    for p in sources(root):
        rel = p.relative_to(root).as_posix()
        text = p.read_text(errors="replace")
        lines = text.split("\n")
        rust = p.suffix == ".rs"
        if len(lines) > MAX_FILE:
            found[f"size:{rel}"] = len(lines)
        for name, n in functions(lines, rust):
            if n > MAX_FN:
                # Line numbers move with every edit: key on the name, keep the largest of same-named functions
                key = f"fn:{rel}:{name.split('@')[0]}"
                found[key] = max(found.get(key, 0), n)
        if rust:
            crate = rel.split("/")[2] if rel.startswith("core/crates/") else ""
            if crate in ("esp32s3", "esp32", "soc", "machine") and (n := len(re.findall(r"\b(?:tryboard_)?esp32c3::", text))):
                found[f"layer:{rel}"] = n
            continue
        code = "\n".join(l for l in lines if not l.lstrip().startswith(("//", "*", "/*")))
        if rel != FRAME_HOME and (n := len(re.findall(r"\brequestAnimationFrame\b", code))):
            found[f"raf:{rel}"] = n
        if rel not in CHIP_HOME and "/test/" not in rel and (n := len(CHIP_LIT.findall(code))):
            found[f"chip:{rel}"] = n
    return found


def check(found, allow):
    errs = []
    for k, v in sorted(found.items()):
        if k not in allow:
            errs.append(f"new: {k} = {v}")
        elif v > allow[k]:
            errs.append(f"grew: {k} {allow[k]} -> {v}")
    return errs


def selftest():
    plant = {
        "size": ("web/src/big.ts", "\n".join(f"export const a{i} = {i};" for i in range(MAX_FILE + 1))),
        "fn": ("web/src/longfn.ts", "export function huge() {\n" + "  x();\n" * (MAX_FN + 1) + "}\n"),
        "raf": ("web/src/loop.ts", "export const go = () => requestAnimationFrame(() => {});\n"),
        "chip": ("web/src/chipy.ts", "export const c = 'esp32s3';\n"),
        "layer": ("core/crates/esp32s3/src/bad.rs", "use tryboard_esp32c3::periph;\n"),
    }
    missed = []
    for rule, (rel, body) in plant.items():
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / rel
            f.parent.mkdir(parents=True)
            f.write_text(body)
            (Path(d) / "core/crates").mkdir(parents=True, exist_ok=True)
            if not check(scan(Path(d)), {}):
                missed.append(rule)
    print(f"selftest: {len(plant) - len(missed)}/{len(plant)} planted violations reported" + (f"; missed {missed}" if missed else ""))
    return not missed


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest() else 1)
    found = scan(ROOT)
    if "--update" in sys.argv:
        ALLOW.write_text(json.dumps(dict(sorted(found.items())), indent=1, ensure_ascii=False) + "\n")
        print(f"wrote {ALLOW.relative_to(ROOT)}: {len(found)} allowed offenders")
        sys.exit(0)
    allow = json.loads(ALLOW.read_text()) if ALLOW.exists() else {}
    errs = check(found, allow)
    for e in errs:
        print("✗", e)
    gone = sorted(set(allow) - set(found))
    shrunk = [k for k in allow if k in found and found[k] < allow[k]]
    by = {}
    for k in found:
        by[k.split(":")[0]] = by.get(k.split(":")[0], 0) + 1
    print(f"lint_size: {len(errs)} new / grown; allowed offenders by rule {by}" + (f"; {len(gone) + len(shrunk)} fixed or shrunk (run --update to lock in)" if gone or shrunk else ""))
    sys.exit(1 if errs else 0)
