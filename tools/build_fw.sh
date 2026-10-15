#!/bin/bash
# 构建验收 / 示例固件，产物合并成 firmware/build/<名字>/flash.bin（4MB 镜像中实际用到的部分）。
# 用法：tools/build_fw.sh [名字...]（默认全部）
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
  echo "== $n"
  (cd "$src" && idf.py -B "$out/idf" set-target esp32c3 >/dev/null 2>&1 || true; cd "$src" && idf.py -B "$out/idf" build >"$out/build.log" 2>&1) || { tail -30 "$out/build.log"; exit 1; }
  (cd "$out/idf" && python -m esptool --chip esp32c3 merge_bin -o "$out/flash.bin" @flash_args >/dev/null)
  cp "$out/idf/$n.elf" "$out/app.elf"
  ls -la "$out/flash.bin" | awk '{print "   flash.bin", $5, "bytes"}'
done
