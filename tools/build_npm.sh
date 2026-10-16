#!/bin/bash
# 打本地 npm 包 packages/tryboard（不发布）：esbuild 把 cli.ts + 网页的 checks.ts / simrun.ts / inputlog.ts 打成一个 .mjs，
# 拷 wasm 内核、两颗芯片的 ROM ELF（附 Apache-2.0 全文、版权行与 ROM 第三方清单）、levels.json，再 npm pack。
# 用法：tools/build_npm.sh [--no-wasm]（--no-wasm 用已有的 wasm 产物）
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
cp "$ROMS/esp32c3_rev3_rom.elf" "$ROMS/esp32s3_rev0_rom.elf" "$PKG/rom/"
cp "$ROMS/LICENSE" "$PKG/LICENSE-esp-rom-elfs.txt"
REL=$(ls "$ROMS" | sed -n 's/^esp-rom-elfs-\([0-9]*\)\.tar\.gz$/\1/p' | head -1)
COPY=$(sed -n "s/.*chips are \(Copyright.*\)$/\1/p" "$ROMS/README.md" 2>/dev/null | head -1)
cat > "$PKG/NOTICE.txt" <<TXT
tryboard 本地包 · 第三方声明

rom/esp32c3_rev3_rom.elf、rom/esp32s3_rev0_rom.elf
  来源：https://github.com/espressif/esp-rom-elfs（release ${REL:-unknown}）
  许可证：Apache License 2.0（全文见 LICENSE-esp-rom-elfs.txt）
  ${COPY:-Copyright (c) 2015-2022 Espressif Systems (Shanghai) Co. Ltd.}
  ROM 内含第三方组件（清单见 https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html#rom-source-code-copyrights）：
    Newlib（BSD）、Xtensa libhal（MIT）、TinyBasic Plus（MIT）、miniz（公有领域）、TJpgDec（TJpgDec 许可，BSD 风格）、
    Zephyr USB 协议栈（Apache-2.0 / BSD-3-Clause）

wasm/tryboard.wasm、dist/cli.mjs：TryBoard 自己的代码，无第三方 crate / npm 依赖。
TXT
cp "$ROOT/firmware/levels.json" "$PKG/levels.json"
(cd "$PKG" && npm pack --silent >/dev/null)
ls -l "$PKG"/tryboard-*.tgz | awk '{print "npm 包", $NF, $5, "bytes"}'
