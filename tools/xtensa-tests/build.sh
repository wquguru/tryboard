#!/bin/bash
# Build the Xtensa self-tests: link each <name>.S with common.S into build/<name>.elf
# Usage: tools/xtensa-tests/build.sh
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
