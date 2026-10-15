#!/bin/bash
# 下载第三方输入到 third_party/（git 忽略）：乐鑫 ROM ELF（Apache-2.0）与 riscv-tests（BSD）。
set -euo pipefail
cd "$(dirname "$0")/../third_party" 2>/dev/null || { mkdir -p "$(dirname "$0")/../third_party"; cd "$(dirname "$0")/../third_party"; }
ROM_VER=20260528
if [ ! -f esp-rom-elfs/esp32c3_rev3_rom.elf ]; then
  mkdir -p esp-rom-elfs && cd esp-rom-elfs
  gh release download "$ROM_VER" -R espressif/esp-rom-elfs --clobber
  shasum -a 256 -c "esp-rom-elfs-$ROM_VER-checksum.sha256"
  tar xzf "esp-rom-elfs-$ROM_VER.tar.gz"
  cd ..
fi
# 授权文件单独补（发布包里没有），分发 ROM 时要随附
for f in LICENSE README.md; do
  [ -f "esp-rom-elfs/$f" ] || curl -fsSL --retry 5 --retry-all-errors "https://raw.githubusercontent.com/espressif/esp-rom-elfs/master/$f" -o "esp-rom-elfs/$f"
done
[ -d riscv-tests ] || git clone -q --depth 1 --recursive --shallow-submodules https://github.com/riscv-software-src/riscv-tests.git
echo "third_party ready"
