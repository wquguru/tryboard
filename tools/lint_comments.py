"""Comment lint (docs/I18N.md §5): flag Chinese text and comment runs longer than 2 lines.

Usage: python3 tools/lint_comments.py [paths...]   (default: all tracked source files). Exit 1 on findings.
Opt-outs: `lint: allow-long-comment` inside a run (license headers, layout tables, diagrams);
`lint: allow-cjk` on a line or in the first 5 lines (whole file). Firmware C string literals are exempt (printf stays Chinese).
"""

import re
import subprocess
import sys

EXT = {
    ".rs": "c", ".ts": "c", ".tsx": "c", ".mjs": "c", ".js": "c", ".c": "c", ".h": "c", ".S": "c", ".css": "c",
    ".py": "hash", ".sh": "hash", ".toml": "hash", ".yml": "hash",
}
SKIP = re.compile(r"^(docs/|Reviews/|third_party/)|/i18n/(zh|ja|ko)/|/node_modules/|/dist/")
HAN = re.compile("[\u4e00-\u9fff]")
MAX_RUN = 2


def kind(path):
    for ext, k in EXT.items():
        if path.endswith(ext):
            return k
    return None


def comment_lines(lines, k):
    """Yield (index, is_comment) per line; block comments count every line they span."""
    in_block = False
    for i, raw in enumerate(lines):
        s = raw.strip()
        if k == "hash":
            yield i, s.startswith("#") and not s.startswith("#!")
            continue
        if in_block:
            yield i, True
            if "*/" in s:
                in_block = False
            continue
        if s.startswith("//"):
            yield i, True
        elif s.startswith("/*"):
            in_block = "*/" not in s
            yield i, True
        else:
            yield i, False


def lint(path):
    k = kind(path)
    try:
        lines = open(path, encoding="utf-8").read().split("\n")
    except (UnicodeDecodeError, FileNotFoundError):
        return []
    out = []
    run = []
    flags = list(comment_lines(lines, k)) if k else []
    for i, is_c in flags + [(len(lines), False)]:
        if is_c:
            run.append(i)
            continue
        if len(run) > MAX_RUN and not any("lint: allow-long-comment" in lines[j] for j in run):
            out.append(f"{path}:{run[0] + 1}: comment run of {len(run)} lines (max {MAX_RUN})")
        run = []
    if any("lint: allow-cjk" in l for l in lines[:5]):
        return out
    fw_c = path.startswith("firmware/") and k == "c"
    for i, line in enumerate(lines):
        if "lint: allow-cjk" in line:
            continue
        if fw_c and not line.strip().startswith(("//", "/*", "*")) and '"' in line:
            continue
        if HAN.search(line):
            out.append(f"{path}:{i + 1}: Chinese text: {line.strip()[:80]}")
    return out


def main():
    # Directory arguments expand to their tracked files, so `lint core` checks the whole crate tree
    git = ["git", "ls-files", "--", *sys.argv[1:]]
    paths = subprocess.run(git, capture_output=True, text=True, check=True).stdout.split()
    findings = []
    for p in paths:
        if SKIP.search(p) or not kind(p):
            continue
        findings += lint(p)
    print("\n".join(findings))
    print(f"{len(findings)} finding(s)", file=sys.stderr)
    sys.exit(1 if findings else 0)


if __name__ == "__main__":
    main()
