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
# 乐鑫 BLE 控制器预编译库（esp32c3-bt-lib，Apache-2.0）各 IDF 版本的 libbtdm_app*.a：只给 tools/ble_sigs.py
# 生成签名用（C-01），不进仓库、不进网站。提交号取自 esp-idf 各 tag 的子模块指针。
for pair in 5.1-5.2:ed99228396aaa18935b575d600bc19da38dc4746 5.3:daab5dbba958a13041bd496e4a6ed506c9284a06 \
            5.4:72599d583c232ea78d6461b5b502426c6e5a1ec9 5.5.0:3ff529142f6e2707d57b10eb87ac8d86e9098b88 \
            5.5.1:0c68809d62e432427de97b5294f6619307f62f40; do
  ver=${pair%%:*}; sha=${pair#*:}
  for chip in esp32c3 esp32s3; do
    for lib in libbtdm_app.a libbtdm_app_flash.a; do
      out="btlib/$ver/$chip/$lib"
      [ -f "$out" ] && continue
      mkdir -p "btlib/$ver/$chip"
      curl -fsSL --retry 3 "https://raw.githubusercontent.com/espressif/esp32c3-bt-lib/$sha/$chip/$lib" -o "$out" || rm -f "$out"
    done
  done
done
[ -d riscv-tests ] || git clone -q --depth 1 --recursive --shallow-submodules https://github.com/riscv-software-src/riscv-tests.git
echo "third_party ready"
