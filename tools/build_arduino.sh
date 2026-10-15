#!/bin/bash
# 用 arduino-cli（esp32 核心 3.x）编译 firmware/arduino/<名字>/ 下的草图，产物 firmware/build/arduino-<名字>/flash.bin（合并镜像）与 app.elf。
# 用法：tools/build_arduino.sh [名字...]（默认全部）；板型默认 esp32c3，可在草图目录放 board.txt 覆盖（如 esp32:esp32:esp32s3）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  for d in "$ROOT"/firmware/arduino/*/; do names+=("$(basename "$d")"); done
fi
for n in "${names[@]}"; do
  src="$ROOT/firmware/arduino/$n"
  out="$ROOT/firmware/build/arduino-$n"
  fqbn=$(cat "$src/board.txt" 2>/dev/null || echo esp32:esp32:esp32c3)
  mkdir -p "$out"
  echo "== arduino-$n ($fqbn)"
  arduino-cli compile -b "$fqbn" --output-dir "$out/raw" "$src" > "$out/build.log" 2>&1 || { tail -20 "$out/build.log"; exit 1; }
  cp "$out/raw/$n.ino.merged.bin" "$out/flash.bin"
  cp "$out/raw/$n.ino.elf" "$out/app.elf"
  ls -la "$out/flash.bin" | awk '{print "   flash.bin", $5, "bytes"}'
done
