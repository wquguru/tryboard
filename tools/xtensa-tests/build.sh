#!/bin/bash
# 构建 Xtensa 自检测试：每个 <名字>.S 与 common.S 链接成 build/<名字>.elf
# 用法：tools/xtensa-tests/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin=$(ls -d ~/.espressif/tools/xtensa-esp-elf/*/xtensa-esp-elf/bin | tail -1)
cc="$bin/xtensa-esp32s3-elf-gcc"
mkdir -p "$here/build"
for f in "$here"/*.S; do
  n=$(basename "$f" .S)
  [ "$n" = common ] && continue
  "$cc" -nostdlib -nostartfiles -I"$here" -T "$here/link.ld" \
    "$here/common.S" "$f" -o "$here/build/$n.elf"
done
echo "built $(ls "$here"/build/*.elf | wc -l | tr -d ' ') tests"
