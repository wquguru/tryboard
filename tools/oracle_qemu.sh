#!/bin/bash
# 用乐鑫 QEMU（独立进程，仅本机对照，不分发）跑同一份固件，输出串口日志到 Reviews/qemu/<名字>.log
# 用法：tools/oracle_qemu.sh <名字> [秒数=5] [芯片=按 sdkconfig.defaults 的 CONFIG_IDF_TARGET，缺省 esp32c3]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
n="$1"; secs="${2:-5}"
chip="${3:-$(sed -n 's/^CONFIG_IDF_TARGET="\(.*\)"/\1/p' "$ROOT/firmware/$n/sdkconfig.defaults" 2>/dev/null | head -1)}"
chip="${chip:-esp32c3}"
case "$chip" in
  esp32c3) Q=$(ls -d ~/.espressif/tools/qemu-riscv32/*/qemu/bin | tail -1); exe=qemu-system-riscv32; size=$((4<<20)) ;;
  esp32s3) Q=$(ls -d ~/.espressif/tools/qemu-xtensa/*/qemu/bin | tail -1); exe=qemu-system-xtensa; size=$((16<<20)) ;;
  *) echo "不支持的芯片 $chip"; exit 2 ;;
esac
mkdir -p "$ROOT/Reviews/qemu"
img="$ROOT/Reviews/qemu/$n.flash.bin"
# QEMU 要求镜像正好是 flash 大小（C3 示例 4MB，S3 示例 16MB）
python3 -c "import sys;d=open(sys.argv[1],'rb').read();n=int(sys.argv[3]);open(sys.argv[2],'wb').write(d+b'\xff'*(n-len(d)))" "$ROOT/firmware/build/$n/flash.bin" "$img" "$size"
"$Q/$exe" -nographic -machine "$chip" -drive "file=$img,if=mtd,format=raw" -serial file:"$ROOT/Reviews/qemu/$n.log" -monitor none &
pid=$!
sleep "$secs"; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
cat "$ROOT/Reviews/qemu/$n.log"
