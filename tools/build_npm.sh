#!/bin/bash
# Build the unpublished npm package packages/tryboard: esbuild bundles cli.ts + web checks / simrun / inputlog, copies wasm,
# ROM ELFs (with Apache-2.0 text / ROM third-party list) and levels.json, then npm pack. Usage: tools/build_npm.sh [--no-wasm]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/tryboard"
if [ "${1:-}" != "--no-wasm" ]; then
  . ~/.cargo/env
  (cd "$ROOT/core" && cargo build --release -q --target wasm32-unknown-unknown -p tryboard-wasm)
fi
command -v node >/dev/null || { [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh >/dev/null; }
rm -rf "$PKG/dist" "$PKG/wasm" "$PKG/rom" "$PKG"/tryboard-*.tgz
mkdir -p "$PKG/dist" "$PKG/wasm" "$PKG/rom"
"$ROOT/web/node_modules/.bin/esbuild" "$PKG/src/cli.ts" --bundle --platform=node --format=esm --target=node18 \
  --banner:js='#!/usr/bin/env node' --outfile="$PKG/dist/cli.mjs" --log-level=warning
chmod +x "$PKG/dist/cli.mjs"
cp "$ROOT/core/target/wasm32-unknown-unknown/release/tryboard_wasm.wasm" "$PKG/wasm/tryboard.wasm"
ROMS="$ROOT/third_party/esp-rom-elfs"
cp "$ROMS/esp32_rev300_rom.elf" "$ROMS/esp32c3_rev3_rom.elf" "$ROMS/esp32s3_rev0_rom.elf" "$PKG/rom/"
cp "$ROMS/LICENSE" "$PKG/LICENSE-esp-rom-elfs.txt"
REL=$(ls "$ROMS" | sed -n 's/^esp-rom-elfs-\([0-9]*\)\.tar\.gz$/\1/p' | head -1)
COPY=$(sed -n "s/.*chips are \(Copyright.*\)$/\1/p" "$ROMS/README.md" 2>/dev/null | head -1)
cat > "$PKG/NOTICE.txt" <<TXT
tryboard local package - third-party notices

rom/esp32_rev300_rom.elf, rom/esp32c3_rev3_rom.elf, rom/esp32s3_rev0_rom.elf
  Source: https://github.com/espressif/esp-rom-elfs (release ${REL:-unknown})
  License: Apache License 2.0 (full text in LICENSE-esp-rom-elfs.txt)
  ${COPY:-Copyright (c) 2015-2022 Espressif Systems (Shanghai) Co. Ltd.}
  The ROM contains third-party components (list: https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html#rom-source-code-copyrights):
    Newlib (BSD), Xtensa libhal (MIT), TinyBasic Plus (MIT), miniz (public domain), TJpgDec (TJpgDec license, BSD-style),
    Zephyr USB stack (Apache-2.0 / BSD-3-Clause)

wasm/tryboard.wasm, dist/cli.mjs: TryBoard's own code, no third-party crate / npm dependencies.
TXT
cp "$ROOT/firmware/levels.json" "$PKG/levels.json"
(cd "$PKG" && npm pack --silent >/dev/null)
ls -l "$PKG"/tryboard-*.tgz | awk '{print "npm package", $NF, $5, "bytes"}'
