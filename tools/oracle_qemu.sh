#!/bin/bash
# 用乐鑫 QEMU（独立进程，仅本机对照，不分发）跑同一份固件，输出串口日志到 Reviews/qemu/<名字>.log
# 用法：tools/oracle_qemu.sh <名字> [秒数=5]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
n="$1"; secs="${2:-5}"
Q=$(ls -d ~/.espressif/tools/qemu-riscv32/*/qemu/bin | tail -1)
mkdir -p "$ROOT/Reviews/qemu"
img="$ROOT/Reviews/qemu/$n.flash.bin"
# QEMU 要求镜像正好是 flash 大小
python3 -c "import sys;d=open(sys.argv[1],'rb').read();open(sys.argv[2],'wb').write(d+b'\xff'*((4<<20)-len(d)))" "$ROOT/firmware/build/$n/flash.bin" "$img"
"$Q/qemu-system-riscv32" -nographic -machine esp32c3 -drive "file=$img,if=mtd,format=raw" -serial file:"$ROOT/Reviews/qemu/$n.log" -monitor none &
pid=$!
sleep "$secs"; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
cat "$ROOT/Reviews/qemu/$n.log"
