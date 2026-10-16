#!/bin/bash
# 对拍：npx 跑打好的本地包（packages/tryboard/tryboard-*.tgz），与 tools/check.py 逐关比结论、整段输出（含指纹）和退出码。
# 参考固件逐关比；再拿错的固件跑几关，确认"未通过"的输出和退出码也一致。输出 Markdown 表，有不一致退出 1。
# 用法：tools/npm_parity.sh（先 tools/build_npm.sh）
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null || { [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh >/dev/null; }
TGZ=$(ls "$ROOT"/packages/tryboard/tryboard-*.tgz 2>/dev/null | head -1)
[ -n "$TGZ" ] || { echo "没有打好的包：先跑 tools/build_npm.sh"; exit 1; }
TMP="$ROOT/Reviews/npm-parity"; rm -rf "$TMP"; mkdir -p "$TMP"; cp "$TGZ" "$TMP/"; T=./$(basename "$TGZ")
# 用到的固件 : 关卡（参考固件来自 levels.json；后几行是故意配错的）
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
echo "| 固件 | 关卡 | check.py | npx tryboard | 指纹 | 一致 |"
echo "|---|---|---|---|---|---|"
for c in $CASES; do
  fw=${c%%:*}; lv=${c#*:}; bin="$ROOT/firmware/build/$fw/flash.bin"
  py=$("$ROOT/tools/check.py" "$bin" --level "$lv" 2>&1); prc=$?
  # 在仓库之外的目录照用户的用法 `npx ./tryboard-*.tgz check …` 跑，确认不依赖仓库里的文件
  np=$(cd "$TMP" && npx --yes "$T" check "$bin" --level "$lv" 2>&1); nrc=$?
  fp=$(echo "$np" | head -1 | sed -n 's/.*指纹 //p')
  verdict() { [ "$1" = 0 ] && echo "通过" || echo "未通过（$1）"; }
  if [ "$py" = "$np" ] && [ $prc = $nrc ]; then same='✅'; else same='❌'; bad=1
    printf '%s\n' "$py" > "$TMP/$fw-$lv.py.txt"; printf '%s\n' "$np" > "$TMP/$fw-$lv.npx.txt"; fi
  echo "| $fw | $lv | $(verdict $prc) | $(verdict $nrc) | $fp | $same |"
done
exit $bad
