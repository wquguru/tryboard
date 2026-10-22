#!/bin/bash
# Build firmware/arduino/<name>/ with arduino-cli into firmware/build/arduino-<name>/{flash.bin,app.elf}. Usage: tools/build_arduino.sh [name[:variant]...]
# Sketch dir: board.txt (fqbn, default esp32c3), boards.txt ("<variant> <fqbn>"), libs.txt (pinned third_party libs), flags.txt (defines); BUILD_INFO.txt per bin.
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
    echo "licence: arduino-esp32 LGPL-2.1 (LICENSE.md at the release tag); ESP-IDF libs Apache-2.0; libraries per docs/LICENSING.md; notices in THIRD_PARTY_NOTICES.txt"
    echo "sketch: firmware/arduino/$n @ $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "core: esp32:esp32 $CORE_VER (arduino-esp32 release tag $CORE_VER)"
    for lib in $(each_lib "$src"); do
      local sha url
      sha=$(git -C "$LIBS/$lib" rev-parse HEAD)
      url=$(git -C "$LIBS/$lib" config remote.origin.url)
      # Pinned source tree: the "library source" part of the LGPL three-piece (F-08e)
      echo "library: $lib $sha ${url%.git} source ${url%.git}/tree/$sha"
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
