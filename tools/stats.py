#!/usr/bin/env python3
"""Public numbers (README, home page) generated from real data (F-06).

  tools/stats.py          write web/public/stats.json and rewrite the README markers
  tools/stats.py --check  exit 1 if either is stale (nothing is written)

README numbers sit between <!-- stats:KEY -->..<!-- /stats --> markers.
"""
import gzip, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web/public/stats.json"
READMES = [ROOT / "README.md"] + [ROOT / f"docs/readme/README.{l}.md" for l in ("zh-CN", "ja", "ko")]
WASM_CANDIDATES = [ROOT / "web/public/wasm/tryboard.wasm",
                   ROOT / "core/target/wasm32-unknown-unknown/release/tryboard_wasm.wasm"]


def load(p):
    return json.loads((ROOT / p).read_text(encoding="utf-8"))


def collect():
    examples = load("firmware/examples.json")
    parts = {p["type"] for e in examples for p in e.get("scene", {}).get("parts", [])}
    chips = [d.name for d in (ROOT / "core/crates").iterdir() if d.name.startswith("esp32")]
    s = {"accept": len(load("firmware/accept.json")), "examples": len(examples),
         "devices": len(parts), "chips": len(chips), "wasm_bytes": None, "wasm_gzip_bytes": None}
    wasm = next((w for w in WASM_CANDIDATES if w.exists()), None)
    if wasm is None:
        print("stats: wasm not built (run tools/build_web.sh); wasm sizes keep previous values", file=sys.stderr)
        if OUT.exists():
            old = json.loads(OUT.read_text())
            s["wasm_bytes"], s["wasm_gzip_bytes"] = old.get("wasm_bytes"), old.get("wasm_gzip_bytes")
    else:
        raw = wasm.read_bytes()
        s["wasm_bytes"], s["wasm_gzip_bytes"] = len(raw), len(gzip.compress(raw, 9, mtime=0))
    return s


def rewrite(text, s):
    return re.sub(r"(<!-- stats:(\w+) -->)(.*?)(<!-- /stats -->)",
                  lambda m: f"{m[1]}{s[m[2]]}{m[4]}", text)


def main():
    check = "--check" in sys.argv
    s = collect()
    stale = []
    want = json.dumps(s, indent=1) + "\n"
    if not OUT.exists() or OUT.read_text() != want:
        stale.append(str(OUT.relative_to(ROOT)))
        if not check:
            OUT.write_text(want)
    for r in READMES:
        t = r.read_text(encoding="utf-8")
        n = rewrite(t, s)
        if n != t:
            stale.append(str(r.relative_to(ROOT)))
            if not check:
                r.write_text(n, encoding="utf-8")
    print(json.dumps(s))
    if check and stale:
        print("stats: stale: " + ", ".join(stale) + " (run tools/stats.py)", file=sys.stderr)
        return 1
    return 0


sys.exit(main())
