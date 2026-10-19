#!/bin/bash
# Downloads Noto Sans SC and JetBrains Mono variable TTFs + OFL.txt to third_party/fonts/ (ignored), pinned to one
# google/fonts commit and sha256-checked so the subset build is reproducible (P2-19, LICENSING.md fonts row ✅ OFL-1.1).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/third_party/fonts"
REV=47d54ca1ebb14fd864695f1d39dc734f39017c33
BASE="https://raw.githubusercontent.com/google/fonts/$REV/ofl"
mkdir -p "$OUT"
# name | repo path | sha256
while IFS='|' read -r name src sum; do
  [ -n "$name" ] || continue
  f="$OUT/$name"
  if [ ! -f "$f" ] || ! echo "$sum  $f" | shasum -a 256 -c - >/dev/null 2>&1; then
    curl -fsSL --retry 5 --retry-all-errors "$BASE/$src" -o "$f.part"
    mv "$f.part" "$f"
    echo "$sum  $f" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch: $name" >&2; rm -f "$f"; exit 1; }
  fi
done <<EOF
NotoSansSC-wght.ttf|notosanssc/NotoSansSC%5Bwght%5D.ttf|a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da
OFL-NotoSansSC.txt|notosanssc/OFL.txt|1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9
JetBrainsMono-wght.ttf|jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf|48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda
OFL-JetBrainsMono.txt|jetbrainsmono/OFL.txt|b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d
EOF
echo "$REV" > "$OUT/REVISION"
echo "fonts ready ($OUT)"
