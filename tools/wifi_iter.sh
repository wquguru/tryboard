#!/bin/bash
# 调试迭代：重编 CLI → 跑固件 → 打印非 I 日志、停止位置、最热未建模寄存器，并反汇编停止点
# 用法：tools/wifi_iter.sh <固件名> [秒数=3] [额外参数...]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
n="$1"; secs="${2:-3}"; shift; shift || true
~/.cargo/bin/cargo build --release -q -p tryboard-cli --manifest-path core/Cargo.toml 2>&1 | grep -E '^error' -A7
out=$(core/target/release/tryboard run "firmware/build/$n/flash.bin" --seconds "$secs" --trace 4 "$@" 2>&1)
echo "$out" | grep -vE '^I \(|^    0x[0-9a-f]+ [a-zA-Z_].*\+0x' | tail -25
pc=$(echo "$out" | grep -oE '\] pc 0x[0-9a-f]+' | grep -oE '0x[0-9a-f]+')
echo "--- trace"; echo "$out" | grep -A4 '最近的跳转目标' | tail -4
if [ -n "$pc" ]; then
  if [ $((pc)) -lt $((0x40060000)) ]; then e=rom; else e="firmware/build/$n/app.elf"; fi
  tools/disas.sh "$e" "$pc" 28
fi
