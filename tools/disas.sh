#!/bin/bash
# Disassemble around an address: tools/disas.sh <elf|rom> <address> [bytes each side=48]
# Passing rom as the elf means the C3 ROM
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OD=$(ls -d ~/.espressif/tools/riscv32-esp-elf/*/riscv32-esp-elf/bin | tail -1)/riscv32-esp-elf-objdump
elf="$1"; [ "$elf" = rom ] && elf="$ROOT/third_party/esp-rom-elfs/esp32c3_rev3_rom.elf"
a=$(( $2 )); w=$(( ${3:-48} ))
"$OD" -d "$elf" --start-address=$((a - w)) --stop-address=$((a + w)) | grep -E '^\s*[0-9a-f]+:|>:'
