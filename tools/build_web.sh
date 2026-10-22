#!/bin/bash
# Build the wasm core -> copy ROMs (with licence) and example firmware -> front-end output in web/dist.
# Usage: tools/build_web.sh [--no-vite]  (--no-vite only prepares public/, for npm run dev)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. ~/.cargo/env
(cd "$ROOT/core" && cargo build --release --target wasm32-unknown-unknown -p tryboard-wasm)
PUB="$ROOT/web/public"
mkdir -p "$PUB/wasm" "$PUB/rom" "$PUB/fw"
cp "$ROOT/core/target/wasm32-unknown-unknown/release/tryboard_wasm.wasm" "$PUB/wasm/tryboard.wasm"
ROMS="$ROOT/third_party/esp-rom-elfs"
for r in esp32_rev300 esp32c3_rev3 esp32s3_rev0; do python3 "$ROOT/tools/strip_rom.py" "$ROMS/${r}_rom.elf" "$PUB/rom/${r}_rom.elf" >/dev/null; done
cp "$ROMS/LICENSE" "$PUB/rom/LICENSE-esp-rom-elfs.txt"
cat > "$PUB/rom/NOTICE.txt" <<'TXT'
esp32_rev300_rom.elf, esp32c3_rev3_rom.elf and esp32s3_rev0_rom.elf come from https://github.com/espressif/esp-rom-elfs (release 20260528),
licensed under the Apache License 2.0 (see LICENSE-esp-rom-elfs.txt). Copyright Espressif Systems.
The ROM contains third-party components (Newlib BSD, miniz, TJpgDec and others); see
https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html
Modification (Apache-2.0 section 4(b)): the .xt.prop and .xt.lit sections (Xtensa toolchain attribute tables) were
removed from these files by tools/strip_rom.py to cut download size; all loadable content and symbols are unchanged.
TXT
# Microphone test sounds (our own, synthesized by tools/audio/gen_wav.py; see tools/audio/SOURCES.md)
mkdir -p "$PUB/audio"
[ -f "$ROOT/tools/audio/sine1k.wav" ] || python3 "$ROOT/tools/audio/gen_wav.py" >/dev/null
cp "$ROOT/tools/audio/sine1k.wav" "$ROOT/tools/audio/sweep.wav" "$ROOT/tools/audio/xz_mic.wav" "$PUB/audio/"
# Example list: publish only what has been built
python3 - "$ROOT" <<'PY'
import json, os, shutil, sys
root = sys.argv[1]
def publish(src, d):
    # R-18: drop the erased (0xFF) tail, 4 KB aligned; every SoC boot pads flash back to >= 4 MB with 0xFF
    data = open(src, 'rb').read()
    n = (len(data.rstrip(b'\xff')) + 4095) & ~4095
    open(os.path.join(d, 'flash.bin'), 'wb').write(data[:n])
    # LGPL three-piece (F-08e): Arduino bins carry their BUILD_INFO.txt (core / library commits, build config)
    info = os.path.join(os.path.dirname(src), 'BUILD_INFO.txt')
    if os.path.basename(d).startswith('arduino-') and os.path.exists(info):
        shutil.copyfile(info, os.path.join(d, 'BUILD_INFO.txt'))
catalog = json.load(open(os.path.join(root, 'firmware/examples.json')))
out = []
for ex in catalog:
    src = os.path.join(root, 'firmware/build', ex['id'], 'flash.bin')
    if not os.path.exists(src):
        print('skipped (not built):', ex['id']); continue
    d = os.path.join(root, 'web/public/fw', ex['id'])
    os.makedirs(d, exist_ok=True)
    publish(src, d)
    out.append(ex)
json.dump(out, open(os.path.join(root, 'web/public/fw/examples.json'), 'w'), ensure_ascii=False, indent=1)
print('examples:', len(out))
# Level reference firmware (not necessarily in the example list)
for lv in json.load(open(os.path.join(root, 'firmware/levels.json'))):
    ref = lv.get('ref')
    src = os.path.join(root, 'firmware/build', ref or '', 'flash.bin')
    if not ref: continue
    if not os.path.exists(src):
        print('level reference firmware not built:', ref); continue
    d = os.path.join(root, 'web/public/fw', ref)
    os.makedirs(d, exist_ok=True)
    publish(src, d)
PY
# R-18: gzip -9 sidecars (fetchBuf inflates with DecompressionStream, falls back to the plain file); -n keeps builds byte-identical
gzip -9 -n -k -f "$PUB/wasm/tryboard.wasm" "$PUB"/rom/*.elf "$PUB"/fw/*/flash.bin
# Fetch font originals first (P2-19): the licences page includes their full OFL text
"$ROOT/tools/fonts/fetch.sh" || echo "font download failed, skipping (pages use system fonts)" >&2
# Sources of published firmware (bottom-dock "Code" tab, loaded on demand): fw/<id>/src.json
python3 "$ROOT/tools/gen_fw_src.py" "$ROOT" $(ls "$PUB/fw" | grep -v '\.json$')
# Buildable source zips for checkpoint refs + custom-build demo (U-22, lab "Download source"): fw/<ref>/src.zip
python3 "$ROOT/tools/gen_fw_zip.py" "$ROOT"
# Third-party licences page (LICENSING.md rule 8): reads dependency lists, ROMs, published firmware components, SOURCES.md
node "$ROOT/tools/gen_licenses.mjs"
# F-12: changelog page, Atom feed, sitemap.xml and robots.txt from web/changelog.yaml (audit failures stop the build)
node "$ROOT/tools/gen_changelog.mjs"
# Self-hosted fonts (P2-19): originals (third_party/fonts) -> WOFF2 subsets via fonttools in a venv (web/public/fonts).
# Download / venv failures don't block the build: subset.py writes an empty fonts.css and pages fall back to system fonts
VENV="$ROOT/tools/fonts/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  PY312="$(command -v python3.12 || echo /opt/homebrew/bin/python3.12)"
  "$PY312" -m venv "$VENV" && "$VENV/bin/pip" install -q fonttools==4.60.1 brotli==1.1.0 || echo "font subsetting tools failed to install, skipping" >&2
fi
if [ -x "$VENV/bin/python" ]; then "$VENV/bin/python" -I "$ROOT/tools/fonts/subset.py" "$ROOT"; else python3 -I "$ROOT/tools/fonts/subset.py" "$ROOT"; fi
# R-19: content-hash manifest of the fixed-name files above (inlined into each page by vite.config.ts, URLs get ?v=<hash>)
python3 "$ROOT/tools/asset_hashes.py" "$PUB" "$ROOT/web/asset-hashes.json"
ls -la "$PUB/wasm/tryboard.wasm" | awk '{print "wasm", $5, "bytes"}'
# F-06: public numbers (web/public/stats.json + README markers) from real data
python3 "$ROOT/tools/stats.py" >/dev/null
if [ "${1:-}" != "--no-vite" ]; then
  (cd "$ROOT/web" && npm run build --silent)
  # Site-wide static OG image (DESIGN_V2 §8.5): render dist/og.png from tools/webtest/og.html and fail if any entry lacks og tags
  [ -d "$ROOT/tools/webtest/node_modules" ] || (cd "$ROOT/tools/webtest" && npm ci --silent)
  node "$ROOT/tools/webtest/og.mjs"
fi
