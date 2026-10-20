#!/bin/bash
# Download third-party inputs into third_party/ (git-ignored): Espressif ROM ELFs (Apache-2.0) and riscv-tests (BSD).
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
# Licence files are fetched separately (not in the release archive); they must ship with the ROMs
for f in LICENSE README.md; do
  [ -f "esp-rom-elfs/$f" ] || curl -fsSL --retry 5 --retry-all-errors "https://raw.githubusercontent.com/espressif/esp-rom-elfs/master/$f" -o "esp-rom-elfs/$f"
done
# Espressif BLE controller blobs (esp32c3-bt-lib, Apache-2.0) per IDF version, only for tools/ble_sigs.py signatures (C-01);
# never in the repo or site. Commits are the submodule pointers of each esp-idf tag.
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
# Arduino libraries for firmware/arduino/*/libs.txt (MIT; M5GFX bundles LovyanGFX BSD-2), pinned to full commits; sources never enter the repo
mkdir -p arduino-libs
for pair in M5Unified:35903583211e1f39ca88920714525fbcd1eb714a M5GFX:a8ebd7bdaae2e9bdc2f3c69c25b83a84d819af72; do
  name=${pair%%:*}; sha=${pair#*:}
  [ -d "arduino-libs/$name/.git" ] || git clone -q "https://github.com/m5stack/$name" "arduino-libs/$name"
  [ "$(git -C "arduino-libs/$name" rev-parse HEAD)" = "$sha" ] || { git -C "arduino-libs/$name" fetch -q origin && git -C "arduino-libs/$name" checkout -q "$sha"; }
done
echo "third_party ready"
