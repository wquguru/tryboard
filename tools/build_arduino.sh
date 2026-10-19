#!/bin/bash
# Compile sketches in firmware/arduino/<name>/ with arduino-cli (esp32 core 3.x) into firmware/build/arduino-<name>/flash.bin (merged) + app.elf.
# Usage: tools/build_arduino.sh [name...]  (default: all); board defaults to esp32c3, override via board.txt in the sketch dir (e.g. esp32:esp32:esp32s3)
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
