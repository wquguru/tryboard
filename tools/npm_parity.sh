#!/bin/bash
# Parity: npx runs the packed package (packages/tryboard/tryboard-*.tgz) vs tools/check.py per level, plus wrong firmware for FAIL output;
# compares verdict, full output (with fingerprint), exit code. Markdown table, exit 1 on mismatch. Run tools/build_npm.sh first.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null || { [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh >/dev/null; }
TGZ=$(ls "$ROOT"/packages/tryboard/tryboard-*.tgz 2>/dev/null | head -1)
[ -n "$TGZ" ] || { echo "no packed package: run tools/build_npm.sh first"; exit 1; }
TMP="$ROOT/Reviews/npm-parity"; rm -rf "$TMP"; mkdir -p "$TMP"; cp "$TGZ" "$TMP/"; T=./$(basename "$TGZ")
# firmware:level pairs (reference firmware from levels.json; the last few are deliberately mismatched)
CASES=$(python3 - "$ROOT" <<'PY'
import json, sys
L = json.load(open(sys.argv[1] + '/firmware/levels.json'))
for l in L:
    for v in [l] + [{**x, 'id': f"{l['id']}-{x['key']}"} for x in l.get('variants', [])]:
        if v.get('ref'): print(f"{v['ref']}:{v['id']}")
print('s3-blink:03'); print('s3-oled:04'); print('weather:07-spin')
PY
)
bad=0
echo "| Firmware | Level | check.py | npx tryboard | Fingerprint | Same |"
echo "|---|---|---|---|---|---|"
for c in $CASES; do
  fw=${c%%:*}; lv=${c#*:}; bin="$ROOT/firmware/build/$fw/flash.bin"
  py=$("$ROOT/tools/check.py" "$bin" --level "$lv" 2>&1); prc=$?
  # Run outside the repo the way users do (`npx ./tryboard-*.tgz check ...`) to prove it needs no repo files
  # Private npx cache: parallel accept runs in other worktrees reinstall the shared ~/.npm/_npx copy mid-run
  np=$(cd "$TMP" && npm_config_cache="$TMP/.npm" npm_config_update_notifier=false npx --yes "$T" check "$bin" --level "$lv" 2>&1); nrc=$?
  fp=$(echo "$np" | head -1 | sed -n 's/.*fingerprint //p')
  verdict() { [ "$1" = 0 ] && echo "PASS" || echo "FAIL ($1)"; }
  if [ "$py" = "$np" ] && [ $prc = $nrc ]; then same='✅'; else same='❌'; bad=1
    printf '%s\n' "$py" > "$TMP/$fw-$lv.py.txt"; printf '%s\n' "$np" > "$TMP/$fw-$lv.npx.txt"; fi
  echo "| $fw | $lv | $(verdict $prc) | $(verdict $nrc) | $fp | $same |"
done
exit $bad
