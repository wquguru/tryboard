#!/usr/bin/env python3
"""Batch rewrite of CJK lines: extract to JSON, edit the batch in one pass, apply back.

  tools/cjk_sweep.py extract <paths...> > batch.json   # [{file, line, old, new}], new = old
  tools/cjk_sweep.py apply batch.json                  # writes `new` where the line still equals `old`
"""
import json
import re
import subprocess
import sys

HAN = re.compile("[\u3400-\u9fff\uf900-\ufaff]")
SKIP = re.compile(r"^(docs/|Reviews/|third_party/)|/i18n/(zh|ja|ko)/|/node_modules/|/dist/")


def extract(args):
    files = subprocess.run(["git", "ls-files", "--", *args], capture_output=True, text=True, check=True).stdout.split()
    out = []
    for f in files:
        if SKIP.search(f):
            continue
        try:
            lines = open(f, encoding="utf-8").read().split("\n")
        except (UnicodeDecodeError, OSError):
            continue
        for i, s in enumerate(lines, 1):
            if HAN.search(s) and "allow-cjk" not in s:
                out.append({"file": f, "line": i, "old": s, "new": s})
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)


def apply(path):
    by_file = {}
    for e in json.load(open(path, encoding="utf-8")):
        by_file.setdefault(e["file"], []).append(e)
    stale = 0
    for f, es in by_file.items():
        lines = open(f, encoding="utf-8").read().split("\n")
        # Bottom-up so a `new` spanning several lines does not shift later line numbers
        for e in sorted(es, key=lambda e: -e["line"]):
            i = e["line"] - 1
            if i < len(lines) and lines[i] == e["old"]:
                lines[i] = e["new"]
            elif e["old"] != e["new"]:
                stale += 1
                print(f"stale: {f}:{e['line']}", file=sys.stderr)
        open(f, "w", encoding="utf-8").write("\n".join(lines))
    print(f"{len(by_file)} file(s), {stale} stale line(s)", file=sys.stderr)
    return 1 if stale else 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "extract":
        extract(sys.argv[2:])
    elif len(sys.argv) == 3 and sys.argv[1] == "apply":
        sys.exit(apply(sys.argv[2]))
    else:
        sys.exit(__doc__)
