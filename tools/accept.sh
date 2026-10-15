#!/bin/bash
# 全量验收：CPU（riscv-tests）→ 固件（原生内核跑验收固件，比对期望输出，可选 QEMU 对照）→ 网页冒烟。
# 输出 Reviews/accept.md。任何一项失败退出码非 0。
# 用法：tools/accept.sh [--no-web] [--no-qemu]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
. ~/.cargo/env
NO_WEB=0; NO_QEMU=0
for a in "$@"; do [ "$a" = --no-web ] && NO_WEB=1; [ "$a" = --no-qemu ] && NO_QEMU=1; done
mkdir -p Reviews
(cd core && cargo build --release -q -p tryboard-cli) || exit 1
REPORT=Reviews/accept.md
fail=0
{
echo "# 验收报告 $(date '+%Y-%m-%d %H:%M')"
echo
echo "## CPU：riscv-tests"
echo '```'
core/target/release/tryboard riscv-test third_party/rvt-out/* | tail -1
echo '```'
} > $REPORT
core/target/release/tryboard riscv-test third_party/rvt-out/* >/dev/null || fail=1

echo -e "\n## 固件\n| 固件 | 结果 | 说明 |\n|---|---|---|" >> $REPORT
python3 - "$ROOT" "$NO_QEMU" >> $REPORT <<'PY' || fail=1
import json, subprocess, sys, os, re
root, no_qemu = sys.argv[1], sys.argv[2] == '1'
bad = 0
for t in json.load(open(f'{root}/firmware/accept.json')):
    fw = f"{root}/firmware/build/{t['id']}/flash.bin"
    if not os.path.exists(fw):
        print(f"| {t['id']} | ❌ | 未构建 |"); bad += 1; continue
    p = subprocess.run([f'{root}/core/target/release/tryboard', 'run', fw, '--seconds', str(t['seconds']), '--gpio-log', '--ws2812-log'],
                       capture_output=True, text=True, errors='replace')
    out, err = p.stdout, p.stderr
    missing = [e for e in t['expect'] if e not in out]
    notes = []
    if missing: notes.append('缺少输出: ' + ', '.join(missing))
    if re.search(r'Guru Meditation|abort\(\)|panic', out): notes.append('固件崩溃'); missing.append('crash')
    g = t.get('gpio_toggles')
    if g:
        m = re.search(rf"GPIO{g['pin']} 翻转 (\d+) 次", err)
        n = int(m.group(1)) if m else 0
        notes.append(f"GPIO{g['pin']} 翻转 {n} 次")
        if n < g['min']: missing.append('gpio')
    w = t.get('ws2812')
    if w:
        # 解码出的帧：'[tryboard] WS2812 GPIO8 共 N 帧' 之后每行 '    时间s #rrggbb ...'
        sec = re.search(rf"WS2812 GPIO{w['pin']} 共 (\d+) 帧\n((?:    .*\n?)*)", err)
        nf = int(sec.group(1)) if sec else 0
        frames = [l.split()[1:] for l in sec.group(2).splitlines()] if sec else []
        notes.append(f"WS2812 GPIO{w['pin']} 解码 {nf} 帧")
        if nf < w.get('min_frames', 1): missing.append('ws2812 帧数')
        bad_frames = [i for i, want in enumerate(w.get('frames', [])) if i >= len(frames) or frames[i] != want]
        if bad_frames:
            missing.append('ws2812 颜色')
            i = bad_frames[0]
            notes.append(f"第 {i} 帧应为 {' '.join(w['frames'][i])}，实际 {' '.join(frames[i]) if i < len(frames) else '无'}")
        else:
            notes.append(f"前 {len(w.get('frames', []))} 帧颜色逐颗一致")
    speed = re.search(r'模拟 ([\d.]+)s / 实际 ([\d.]+)s', err)
    if speed: notes.append(f"模拟 {speed.group(1)}s 用时 {speed.group(2)}s")
    if t.get('qemu') and not no_qemu:
        q = subprocess.run([f'{root}/tools/oracle_qemu.sh', t['id'], str(int(t['seconds']) + 3)], capture_output=True, text=True, errors='replace').stdout
        qm = [e for e in t['expect'] if e.replace('v0.4', 'v0.3') not in q]
        notes.append('QEMU 对照一致' if not qm else 'QEMU 对照缺: ' + ', '.join(qm))
    ok = not missing
    bad += not ok
    print(f"| {t['id']} | {'✅' if ok else '❌'} | {'；'.join(notes)} |")
    un = re.findall(r'^\s+(0x[0-9a-f]+)\s+(\d+) 次', err, re.M)[:5]
    if un: print(f"| | | 未建模寄存器 Top: {' '.join(a for a,_ in un)} |")
sys.exit(1 if bad else 0)
PY

if [ $NO_WEB = 0 ]; then
  echo -e "\n## 网页（Chrome 无头 + wasm）" >> $REPORT
  tools/build_web.sh >/dev/null 2>&1 || { echo "构建失败" >> $REPORT; fail=1; }
  for ex in blink hello rgb; do
    r=$(node tools/webtest/webtest.mjs $ex TRYBOARD_OK 2>&1 | head -3)
    echo "- $r" >> $REPORT
    echo "$r" | grep -q PASS || fail=1
    echo "$r" | grep -q 页面错误 && fail=1
  done
fi
echo -e "\n结论：$([ $fail = 0 ] && echo '全部通过' || echo '有失败项')" >> $REPORT
cat $REPORT
exit $fail
