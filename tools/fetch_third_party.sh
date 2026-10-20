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
# never in the repo or site. Commits are the submodule pointers of each esp-idf tag (5.1.4 = 5.2.1; F-08c added 5.1.0-5.3.1).
for pair in 5.1-5.2:ed99228396aaa18935b575d600bc19da38dc4746 5.3:daab5dbba958a13041bd496e4a6ed506c9284a06 \
            5.4:72599d583c232ea78d6461b5b502426c6e5a1ec9 5.5.0:3ff529142f6e2707d57b10eb87ac8d86e9098b88 \
            5.5.1:0c68809d62e432427de97b5294f6619307f62f40 \
            5.1.0:d7513ebe88d7d207f6c062ce9381d347a0a70918 5.1.1:b438f60a295183e7c67eb42ae05f4580f4b1ced0 \
            5.1.2:0cfac1b21ebc995e8e9aa040ab1ab29deee4f580 5.1.3:9d40b3bc0ac38d72b66fe0f612a8dda64c7330d7 \
            5.1.4:e5c0f7256ecf5b5f8eb28c1793051a6b88f95124 5.1.5:061e70c319576bf28b5695f5478dbe01ad18b18d \
            5.2.0:393ac4c33b419226aac9d1e8f1b5d553b7f3bc97 5.2.2:76ed4114ee7d081435a3c65793b4c8eb1dfaf199 \
            5.2.3:b8ef2c474d392a88ea7e6626f89acf1fa5f30e4a 5.3.0:4b1338827fa19fbacc02dd9e46e76be2b0dd17a9 \
            5.3.1:bfdfe8f851c99ced8316b133b0b15521917ea049; do
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
# Optional (--micropython): official MicroPython C3 image for the mpy-c3-rawpaste accept case (F-07a).
# Never shipped or committed (distribution is a human decision, RS-1); without it the case is skipped.
if [ "${1:-}" = "--micropython" ]; then
  MPY=ESP32_GENERIC_C3-20260824-v1.29.0.bin
  mkdir -p micropython
  [ -f "micropython/$MPY" ] || curl -fsSL --retry 3 "https://micropython.org/resources/firmware/$MPY" -o "micropython/$MPY"
  echo "bf72ed9eb88ad3a8f49d02c3d371f9ea34c90a8a303aeb9e324d8efd4a2a655a  micropython/$MPY" | shasum -a 256 -c - \
    || { rm -f "micropython/$MPY"; exit 1; }
fi
echo "third_party ready"
