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
cp "$ROMS/esp32c3_rev3_rom.elf" "$ROMS/esp32s3_rev0_rom.elf" "$PUB/rom/"
cp "$ROMS/LICENSE" "$PUB/rom/LICENSE-esp-rom-elfs.txt"
cat > "$PUB/rom/NOTICE.txt" <<'TXT'
esp32c3_rev3_rom.elf and esp32s3_rev0_rom.elf come from https://github.com/espressif/esp-rom-elfs (release 20260528),
licensed under the Apache License 2.0 (see LICENSE-esp-rom-elfs.txt). Copyright Espressif Systems.
The ROM contains third-party components (Newlib BSD, miniz, TJpgDec and others); see
https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html
TXT
# 麦克风测试声音（tools/audio/gen_wav.py 合成，我们自己的，见 tools/audio/SOURCES.md）
mkdir -p "$PUB/audio"
[ -f "$ROOT/tools/audio/sine1k.wav" ] || python3 "$ROOT/tools/audio/gen_wav.py" >/dev/null
cp "$ROOT/tools/audio/sine1k.wav" "$ROOT/tools/audio/sweep.wav" "$PUB/audio/"
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
# 关卡页的参考固件（不一定在示例清单里）
for lv in json.load(open(os.path.join(root, 'firmware/levels.json'))):
    ref = lv.get('ref')
    src = os.path.join(root, 'firmware/build', ref or '', 'flash.bin')
    if not ref: continue
    if not os.path.exists(src):
        print('关卡参考固件未构建:', ref); continue
    d = os.path.join(root, 'web/public/fw', ref)
    os.makedirs(d, exist_ok=True)
    shutil.copy(src, d)
PY
# 字体原件（P2-19）先下好：授权页要附它们的 OFL 全文
"$ROOT/tools/fonts/fetch.sh" || echo "字体原件下载失败，跳过（页面用系统字体）" >&2
# 已发布固件的源码（底部坞「代码」页签，按需加载）：fw/<id>/src.json
python3 "$ROOT/tools/gen_fw_src.py" "$ROOT" $(ls "$PUB/fw" | grep -v '\.json$')
# 第三方授权页（LICENSING.md 规则 8）：读依赖清单、ROM、已发布固件的组件、SOURCES.md
node "$ROOT/tools/gen_licenses.mjs"
# 自托管字体（P2-19）：下载原件（third_party/fonts）→ venv 里的 fonttools 子集化成 WOFF2（web/public/fonts）。
# 下载或装 venv 失败不挡构建：subset.py 会写空的 fonts.css，页面退回系统字体
VENV="$ROOT/tools/fonts/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  PY312="$(command -v python3.12 || echo /opt/homebrew/bin/python3.12)"
  "$PY312" -m venv "$VENV" && "$VENV/bin/pip" install -q fonttools==4.60.1 brotli==1.1.0 || echo "字体子集化工具装不上，跳过" >&2
fi
if [ -x "$VENV/bin/python" ]; then "$VENV/bin/python" -I "$ROOT/tools/fonts/subset.py" "$ROOT"; else python3 -I "$ROOT/tools/fonts/subset.py" "$ROOT"; fi
ls -la "$PUB/wasm/tryboard.wasm" | awk '{print "wasm", $5, "bytes"}'
if [ "${1:-}" != "--no-vite" ]; then
  (cd "$ROOT/web" && npm run build --silent)
  # 全站静态 OG 图（DESIGN_V2 §8.5）：从 tools/webtest/og.html 渲染 dist/og.png，并查每个入口都有 og 标签；不对就让构建失败
  [ -d "$ROOT/tools/webtest/node_modules" ] || (cd "$ROOT/tools/webtest" && npm ci --silent)
  node "$ROOT/tools/webtest/og.mjs"
fi
