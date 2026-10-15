#!/bin/bash
# 构建 wasm 内核 → 复制 ROM（附授权）与示例固件 → 前端产物放 web/dist。
# 用法：tools/build_web.sh [--no-vite]（--no-vite 只准备 public/，给 npm run dev 用）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. ~/.cargo/env
(cd "$ROOT/core" && cargo build --release --target wasm32-unknown-unknown -p tryboard-wasm)
PUB="$ROOT/web/public"
mkdir -p "$PUB/wasm" "$PUB/rom" "$PUB/fw"
cp "$ROOT/core/target/wasm32-unknown-unknown/release/tryboard_wasm.wasm" "$PUB/wasm/tryboard.wasm"
ROMS="$ROOT/third_party/esp-rom-elfs"
cp "$ROMS/esp32c3_rev3_rom.elf" "$PUB/rom/"
cp "$ROMS/LICENSE" "$PUB/rom/LICENSE-esp-rom-elfs.txt"
cat > "$PUB/rom/NOTICE.txt" <<'TXT'
esp32c3_rev3_rom.elf comes from https://github.com/espressif/esp-rom-elfs (release 20260528),
licensed under the Apache License 2.0 (see LICENSE-esp-rom-elfs.txt). Copyright Espressif Systems.
The ROM contains third-party components (Newlib BSD, miniz, TJpgDec and others); see
https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html
TXT
# 示例清单：只发布已构建的
python3 - "$ROOT" <<'PY'
import json, os, shutil, sys
root = sys.argv[1]
catalog = json.load(open(os.path.join(root, 'firmware/examples.json')))
out = []
for ex in catalog:
    src = os.path.join(root, 'firmware/build', ex['id'], 'flash.bin')
    if not os.path.exists(src):
        print('跳过（未构建）:', ex['id']); continue
    d = os.path.join(root, 'web/public/fw', ex['id'])
    os.makedirs(d, exist_ok=True)
    shutil.copy(src, d)
    out.append(ex)
json.dump(out, open(os.path.join(root, 'web/public/fw/examples.json'), 'w'), ensure_ascii=False, indent=1)
print('示例', len(out), '个')
PY
ls -la "$PUB/wasm/tryboard.wasm" | awk '{print "wasm", $5, "bytes"}'
if [ "${1:-}" != "--no-vite" ]; then
  (cd "$ROOT/web" && npm run build --silent)
fi
