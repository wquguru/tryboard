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
# F-08a display / sensor library matrix (firmware/arduino/lib-*), default-branch commits pinned 2026-10-20; licences in docs/LICENSING.md.
# OneWire and TFT_eSPI licences are unverified: local accept only, never shipped (docs/STATUS.md F-08a).
for spec in \
  bblanchon/ArduinoJson:1cd478f48e7c4cd142a0bd26ee17d63d70d04e3f \
  olikraus/U8g2_Arduino:b3a40de8822187c941b40cbbaaa77604a7ab90c7 \
  adafruit/Adafruit_SSD1306:d94f699451d72286357cba7259055ffff2c2940b \
  adafruit/Adafruit-GFX-Library:bc85af5aa4802cb85626c188cbc632343e3dae14 \
  adafruit/Adafruit_BusIO:3b8364267c3ee6e16bad91bc2101aefbd5b5915f \
  adafruit/Adafruit_Sensor:0a9127a1e886ff1adb4c1b6f5958b24108d55aa6 \
  adafruit/Adafruit_BME280_Library:ef712e95147de926b4545e379f6296ad271529b5 \
  adafruit/Adafruit_MPU6050:502a7caccda630a151dfb03ecbdd4b8452809ef7 \
  adafruit/DHT-sensor-library:f7d625462e6033f373e51f8c67f88fc429535b47 \
  adafruit/Adafruit_SHT31:5e34a20df62371150f7cb10330919e9393b884b1 \
  ThingPulse/esp8266-oled-ssd1306:c69cd07db30295428a70d6fa8bb306bbcde64d5b \
  miguelbalboa/rfid:8894b3aed318314345b075b4d436fee18b2b185b \
  PaulStoffregen/OneWire:800f26f3ee6eb446a72e013785cac3700e54cc13 \
  milesburton/Arduino-Temperature-Control-Library:dadbbf7d33f500a5785ac4ae9973b8c9083d0d39 \
  Bodmer/TFT_eSPI:16e37595040eac69cd628e4bffb56fc30cad6299 \
  adafruit/RTClib:5298434167b770c4602661d682e3b340d565073f \
  adafruit/Adafruit_ILI9341:bdd8a0f00b1c66e50c7efdfb5f1835e8df9f50cb; do
  repo=${spec%%:*}; sha=${spec#*:}; name=${repo#*/}
  [ -d "arduino-libs/$name/.git" ] || git clone -q "https://github.com/$repo" "arduino-libs/$name"
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
