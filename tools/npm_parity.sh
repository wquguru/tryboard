#!/bin/bash
# Parity: npx runs the packed package (packages/tryboard/tryboard-*.tgz) vs tools/check.py per level, plus wrong firmware for FAIL output;
# compares verdict, full output (with fingerprint), exit code. Markdown table, exit 1 on mismatch. Run tools/build_npm.sh first.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Re-run under run_bounded.pl so INT / TERM / HUP also kill the npx / node children (bash defers traps while one runs)
[ -n "${NPM_PARITY_SUPERVISED:-}" ] || NPM_PARITY_SUPERVISED=1 exec perl "$ROOT/tools/run_bounded.pl" 0 "$ROOT/tools/npm_parity.sh" "$@"
command -v node >/dev/null || { [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh >/dev/null; }
TGZ=$(ls "$ROOT"/packages/tryboard/tryboard-*.tgz 2>/dev/null | head -1)
[ -n "$TGZ" ] || { echo "no packed package: run tools/build_npm.sh first"; exit 1; }
TMP="$ROOT/Reviews/npm-parity"; rm -rf "$TMP"; mkdir -p "$TMP"; cp "$TGZ" "$TMP/"; T=./$(basename "$TGZ")
# NPM_PARITY_TIMEOUT (seconds) bounds each npx check; NPM_PARITY_HANG=<level id> swaps that check for a hang (test hook, off by default)
TO=${NPM_PARITY_TIMEOUT:-120}
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
# Seconds since the epoch, or since $1 when given (macOS bash 3.2 has no $EPOCHREALTIME)
now() { perl -MTime::HiRes=time -e 'printf "%.1f", time - ($ARGV[0] || 0)' "$@"; }
verdict() { [ "$1" = 124 ] && echo "TIMEOUT (${TO} s)" && return; [ "$1" = 0 ] && echo "PASS" || echo "FAIL ($1)"; }
# npm debug logs written during the killed check (newer than its start marker); the hang hook never starts npm, so say why
save_diag() {
  mkdir -p "$1"; local logs; logs=$(find "$TMP/.npm/_logs" -name '*.log' -newer "$TMP/.check-start" 2>/dev/null)
  if [ -n "$logs" ]; then cp $logs "$1/"; else echo "no npm debug log in .npm/_logs since this check started (npm never ran, e.g. NPM_PARITY_HANG)" > "$1/npm-logs.txt"; fi
}
bad=0; timeouts=''; TIMES="$TMP/timings.tsv"; printf 'firmware\tlevel\tseconds\texit\n' > "$TIMES"
echo "| Firmware | Level | check.py | npx tryboard | Fingerprint | Same |"
echo "|---|---|---|---|---|---|"
for c in $CASES; do
  fw=${c%%:*}; lv=${c#*:}; bin="$ROOT/firmware/build/$fw/flash.bin"
  py=$("$ROOT/tools/check.py" "$bin" --level "$lv" 2>&1); prc=$?
  # Run outside the repo the way users do (`npx ./tryboard-*.tgz check ...`) to prove it needs no repo files
  # Private npx cache: parallel accept runs in other worktrees reinstall the shared ~/.npm/_npx copy mid-run
  if [ "${NPM_PARITY_HANG:-}" = "$lv" ]; then run=(bash -c 'sleep 3600 & wait'); else
    # Offline, no audit: each npx call reinstalls and POSTs an audit to the registry; a stalled one blocks for ~15 min (H-37)
    run=(env npm_config_cache="$TMP/.npm" npm_config_update_notifier=false npm_config_audit=false npm_config_fund=false
      npm_config_offline=true npx --yes "$T" check "$bin" --level "$lv"); fi
  # On timeout run_bounded.pl snapshots ps into the diag dir before killing; npm's debug logs are copied next to it (H-44)
  diag="$TMP/diag-$fw-$lv"; touch "$TMP/.check-start"; t0=$(now)
  np=$(cd "$TMP" && RUN_BOUNDED_PS="$diag/ps.txt" perl "$ROOT/tools/run_bounded.pl" "$TO" "${run[@]}" </dev/null 2>&1); nrc=$?
  printf '%s\t%s\t%s\t%s\n' "$fw" "$lv" "$(now "$t0")" $nrc >> "$TIMES"
  fp=$(echo "$np" | head -1 | sed -n 's/.*fingerprint //p')
  if [ $nrc = 124 ]; then save_diag "$diag"
    timeouts="$timeouts- npx check timed out after ${TO} s: $fw --level $lv (killed, counted as a mismatch; ps + npm logs: Reviews/npm-parity/${diag##*/}/)"$'\n'; fi
  if [ "$py" = "$np" ] && [ $prc = $nrc ]; then same='✅'; else same='❌'; bad=1
    printf '%s\n' "$py" > "$TMP/$fw-$lv.py.txt"; printf '%s\n' "$np" > "$TMP/$fw-$lv.npx.txt"; fi
  echo "| $fw | $lv | $(verdict $prc) | $(verdict $nrc) | $fp | $same |"
done
echo; tail -n +2 "$TIMES" | sort -t$'\t' -k3,3 -rn | awk -F'\t' '{t += $3; if (NR <= 3) s = s (NR > 1 ? ", " : "") $1 " " $2 " " $3 " s"}
  END {printf "npx check time: %.0f s over %d checks; slowest: %s (Reviews/npm-parity/timings.tsv)\n", t, NR, s}'
[ -z "$timeouts" ] || printf '\n%s' "$timeouts"
exit $bad
