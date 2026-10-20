#!/bin/bash
# Compile sketches in firmware/arduino/<name>/ with arduino-cli (esp32 core 3.x) into firmware/build/arduino-<name>/flash.bin (merged) + app.elf.
# Usage: tools/build_arduino.sh [name[:variant]...]  (default: all); board defaults to esp32c3, override via board.txt in the sketch dir (e.g. esp32:esp32:esp32s3).
# boards.txt ("<variant> <fqbn>" per line) builds one output per variant into arduino-<name>-<variant>.
# libs.txt lists pinned libraries under third_party/arduino-libs (tools/fetch_third_party.sh); BUILD_INFO.txt records licence + sources + config for each bin; optional flags.txt adds C++ defines.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIBS="$ROOT/third_party/arduino-libs"
CORE_VER=$(arduino-cli core list 2>/dev/null | awk '$1=="esp32:esp32"{print $2}')

each_lib() { # sketch-dir: prints library names from libs.txt
  [ -f "$1/libs.txt" ] || return 0
  grep -v -e '^#' -e '^[[:space:]]*$' "$1/libs.txt" || true
}

build_one() { # name variant fqbn
  local n=$1 v=$2 fqbn=$3 src="$ROOT/firmware/arduino/$1" id out lib
  id="$n${v:+-$v}"
  out="$ROOT/firmware/build/arduino-$id"
  local extra=()
  if [ -f "$src/libs.txt" ]; then
    for lib in $(each_lib "$src"); do
      [ -d "$LIBS/$lib" ] || { echo "missing $LIBS/$lib: run tools/fetch_third_party.sh" >&2; exit 1; }
    done
    extra=(--libraries "$LIBS")
  fi
  # flags.txt: extra C++ defines for libraries configured by macros (e.g. TFT_eSPI panel setup), kept out of the pinned sources
  local flags=""
  [ -f "$src/flags.txt" ] && flags=$(grep -v -e '^#' -e '^[[:space:]]*$' "$src/flags.txt" | tr '\n' ' ')
  [ -n "$flags" ] && extra+=(--build-property "compiler.cpp.extra_flags=$flags")
  rm -rf "$out/raw"
  mkdir -p "$out"
  echo "== arduino-$id ($fqbn)"
  arduino-cli compile -b "$fqbn" ${extra[@]+"${extra[@]}"} --output-dir "$out/raw" "$src" > "$out/build.log" 2>&1 || { tail -20 "$out/build.log"; exit 1; }
  cp "$out/raw/$n.ino.merged.bin" "$out/flash.bin"
  cp "$out/raw/$n.ino.elf" "$out/app.elf"
  {
    echo "licence: arduino-esp32 LGPL-2.1 (LICENSE.md in the core package); ESP-IDF libs Apache-2.0; see docs/LICENSING.md"
    echo "sketch: firmware/arduino/$n @ $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "core: esp32:esp32 $CORE_VER (arduino-esp32 release tag $CORE_VER)"
    for lib in $(each_lib "$src"); do
      echo "library: $lib $(git -C "$LIBS/$lib" rev-parse HEAD) $(git -C "$LIBS/$lib" config remote.origin.url)"
    done
    echo "config: fqbn=$fqbn; $(arduino-cli version | head -1)${flags:+; extra flags: $flags}"
  } > "$out/BUILD_INFO.txt"
  ls -la "$out/flash.bin" | awk '{print "   flash.bin", $5, "bytes"}'
}

names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  for d in "$ROOT"/firmware/arduino/*/; do names+=("$(basename "$d")"); done
fi
for spec in "${names[@]}"; do
  n=${spec%%:*}
  only=""
  [ "$spec" != "$n" ] && only=${spec#*:}
  src="$ROOT/firmware/arduino/$n"
  if [ -f "$src/boards.txt" ]; then
    while read -r v fqbn; do
      case "$v" in ''|\#*) continue ;; esac
      [ -z "$only" ] || [ "$only" = "$v" ] || continue
      build_one "$n" "$v" "$fqbn"
    done < "$src/boards.txt"
  else
    build_one "$n" "" "$(cat "$src/board.txt" 2>/dev/null || echo esp32:esp32:esp32c3)"
  fi
done
