#!/bin/bash
# Build acceptance / example firmware, merged into firmware/build/<name>/flash.bin (the used part of the 4MB image).
# Usage: tools/build_fw.sh [name...]  (default: all)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tools/idf_env.sh"
names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  for d in "$ROOT"/firmware/*/; do [ -f "$d/CMakeLists.txt" ] && names+=("$(basename "$d")"); done
fi
for n in "${names[@]}"; do
  src="$ROOT/firmware/$n"
  out="$ROOT/firmware/build/$n"
  mkdir -p "$out"
  # Target chip comes from CONFIG_IDF_TARGET in sdkconfig.defaults, default esp32c3
  target=$(sed -n 's/^CONFIG_IDF_TARGET="\(.*\)"/\1/p' "$src/sdkconfig.defaults" 2>/dev/null | head -1)
  target=${target:-esp32c3}
  echo "== $n ($target)"
  (cd "$src" && idf.py -B "$out/idf" set-target "$target" >/dev/null 2>&1 || true; cd "$src" && idf.py -B "$out/idf" build >"$out/build.log" 2>&1) || { tail -30 "$out/build.log"; exit 1; }
  (cd "$out/idf" && python -m esptool --chip "$target" merge_bin -o "$out/flash.bin" @flash_args >/dev/null)
  cp "$out/idf/$n.elf" "$out/app.elf"
  ls -la "$out/flash.bin" | awk '{print "   flash.bin", $5, "bytes"}'
done
