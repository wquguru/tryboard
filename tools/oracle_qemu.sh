#!/bin/bash
# Run the same firmware in Espressif QEMU (separate process, local comparison only, not shipped); serial log to Reviews/qemu/<name>.log
# Usage: tools/oracle_qemu.sh <name> [seconds=5] [chip=CONFIG_IDF_TARGET from sdkconfig.defaults, default esp32c3]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
n="$1"; secs="${2:-5}"
chip="${3:-$(sed -n 's/^CONFIG_IDF_TARGET="\(.*\)"/\1/p' "$ROOT/firmware/$n/sdkconfig.defaults" 2>/dev/null | head -1)}"
chip="${chip:-esp32c3}"
case "$chip" in
  esp32c3) Q=$(ls -d ~/.espressif/tools/qemu-riscv32/*/qemu/bin | tail -1); exe=qemu-system-riscv32; size=$((4<<20)) ;;
  esp32) Q=$(ls -d ~/.espressif/tools/qemu-xtensa/*/qemu/bin | tail -1); exe=qemu-system-xtensa; size=$((4<<20)) ;;
  esp32s3) Q=$(ls -d ~/.espressif/tools/qemu-xtensa/*/qemu/bin | tail -1); exe=qemu-system-xtensa; size=$((16<<20)) ;;
  *) echo "unsupported chip $chip"; exit 2 ;;
esac
mkdir -p "$ROOT/Reviews/qemu"
img="$ROOT/Reviews/qemu/$n.flash.bin"
# QEMU needs the image to be exactly the flash size: the chip default (C3 / ESP32 4MB, S3 16MB), or larger
# when the bootloader header (at 0 or 0x1000) says so, as QEMU derives the flash ID from the image size
python3 -c "
import sys
d = open(sys.argv[1], 'rb').read(); n = int(sys.argv[3])
h = next((o for o in (0, 0x1000) if d[o:o + 1] == b'\xe9'), None)
if h is not None and (d[h + 3] >> 4) <= 4:
    n = max(n, 1 << (20 + (d[h + 3] >> 4)))
open(sys.argv[2], 'wb').write(d + b'\xff' * (n - len(d)))" "$ROOT/firmware/build/$n/flash.bin" "$img" "$size"
# Optional per-firmware machine options (e.g. '-m 4M' for PSRAM) in firmware/<name>/qemu.args
extra=()
[ -f "$ROOT/firmware/$n/qemu.args" ] && read -r -a extra < "$ROOT/firmware/$n/qemu.args"
"$Q/$exe" -nographic -machine "$chip" ${extra[@]+"${extra[@]}"} -drive "file=$img,if=mtd,format=raw" -serial file:"$ROOT/Reviews/qemu/$n.log" -monitor none &
pid=$!
sleep "$secs"; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
cat "$ROOT/Reviews/qemu/$n.log"
