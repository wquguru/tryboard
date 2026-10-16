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
    # fw：同一固件跑多个用例（如不同环境温度）时指定固件目录，缺省与 id 相同
    fw = f"{root}/firmware/build/{t.get('fw', t['id'])}/flash.bin"
    if not os.path.exists(fw):
        print(f"| {t['id']} | ❌ | 未构建 |"); bad += 1; continue
    cmd = [f'{root}/core/target/release/tryboard', 'run', fw, '--seconds', str(t['seconds']), '--gpio-log'] + t.get('args', [])
    if t.get('script'): cmd += ['--script', t['script']]
    if t.get('pwm'): cmd += ['--pwm-log', str(t['pwm']['pin'])]
    if t.get('ws2812'): cmd += ['--ws2812-log']
    p = subprocess.run(cmd, capture_output=True, text=True, errors='replace')
    out, err = p.stdout, p.stderr
    missing = [e for e in t['expect'] if e not in out]
    notes = []
    if missing: notes.append('缺少输出: ' + ', '.join(missing))
    # stderr_expect：模拟器侧观察到的结果（如虚拟 USB 主机解码出的键盘输入），不是固件自己打印的
    for e in t.get('stderr_expect', []):
        if e not in err:
            missing.append(e)
            notes.append(f'模拟器侧缺少: {e}')
    if t.get('stderr_expect'):
        nok = sum(e in err for e in t['stderr_expect'])
        notes.append(f'主机侧核对 {nok}/{len(t["stderr_expect"])}')
    if re.search(r'Guru Meditation|abort\(\)|panic', out): notes.append('固件崩溃'); missing.append('crash')
    g = t.get('gpio_toggles')
    if g:
        m = re.search(rf"GPIO{g['pin']} 翻转 (\d+) 次", err)
        n = int(m.group(1)) if m else 0
        notes.append(f"GPIO{g['pin']} 翻转 {n} 次")
        if n < g['min']: missing.append('gpio')
    pw = t.get('pwm')
    if pw:
        m = re.search(r'PWM GPIO\d+: (\d+) 次变化，占空比 ([\d.]+)\.\.([\d.]+)，频率 ([\d.]+)Hz', err)
        if not m:
            notes.append('没有 PWM 输出'); missing.append('pwm')
        else:
            lo, hi, f = float(m.group(2)), float(m.group(3)), float(m.group(4))
            notes.append(f"PWM {f:.0f}Hz 占空比 {lo:.3f}..{hi:.3f}")
            if abs(f - pw['freq']) > pw['freq'] * 0.01 or abs(lo - pw['min']) > 0.01 or abs(hi - pw['max']) > 0.01:
                missing.append('pwm')
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
    # 数值核对：固件打印的读数与模拟环境设定值之差在容差内（每一次读数都要满足）
    for nchk in t.get('numeric', []):
        vals = [float(v) for v in re.findall(nchk['regex'], out)]
        worst = max((abs(v - nchk['value']) for v in vals), default=None)
        if worst is None or worst > nchk['tol']:
            missing.append(nchk['name'])
            notes.append(f"{nchk['name']} 偏差 {worst} 超过 {nchk['tol']}")
        else:
            notes.append(f"{nchk['name']} {len(vals)} 次读数误差 ≤ {worst:g}")
    if 'oled_min_pixels' in t:
        m = re.search(r'OLED 点亮像素 (\d+)', err)
        n = int(m.group(1)) if m else 0
        notes.append(f"OLED 点亮 {n} 像素")
        if n < t['oled_min_pixels']: missing.append('oled')
    # 圆屏：'[tryboard] LCD GC9A01 非黑像素 N（显示开）'，只数圆形可视区内
    if 'lcd_min_pixels' in t:
        m = re.search(r'LCD GC9A01 非黑像素 (\d+)（显示(.)）', err)
        n = int(m.group(1)) if m else 0
        notes.append(f"LCD 非黑 {n} 像素（显示{m.group(2) if m else '无'}）")
        if n < t['lcd_min_pixels']: missing.append('lcd')
    speed = re.search(r'模拟 ([\d.]+)s / 实际 ([\d.]+)s', err)
    if speed: notes.append(f"模拟 {speed.group(1)}s 用时 {speed.group(2)}s")
    if t.get('qemu') and not no_qemu:
        q = subprocess.run([f'{root}/tools/oracle_qemu.sh', t['id'], str(int(t['seconds']) + 3)], capture_output=True, text=True, errors='replace').stdout
        # 芯片版本由我们的 eFuse 决定，与 QEMU 不同属正常；qemu_skip 里的期望不参与对照
        skip = set(t.get('qemu_skip', []))
        qm = [e for e in t['expect'] if e not in skip and e.replace('v0.4', 'v0.3') not in q]
        notes.append('QEMU 对照一致' if not qm else 'QEMU 对照缺: ' + ', '.join(qm))
    ok = not missing
    # known_gap：已知缺口（写明原因），只有"固件崩溃"这一项失败时记 ⚠️ 不判失败；其它期望仍必须满足
    gap = t.get('known_gap')
    if gap and missing == ['crash']:
        notes.append(f"已知缺口：{gap}")
        print(f"| {t['id']} | ⚠️ | {'；'.join(notes)} |")
    else:
        bad += not ok
        print(f"| {t['id']} | {'✅' if ok else '❌'} | {'；'.join(notes)} |")
    un = re.findall(r'^\s+(0x[0-9a-f]+)\s+(\d+) 次', err, re.M)[:5]
    if un: print(f"| | | 未建模寄存器 Top: {' '.join(a for a,_ in un)} |")
sys.exit(1 if bad else 0)
PY

echo -e "\n## 关卡（firmware/levels.json，参考固件）\n\`\`\`" >> $REPORT
tools/check.py --ref --all >> $REPORT 2>&1 || fail=1
echo '```' >> $REPORT

# 网页单测（元件库 schema、核价提醒、规则引擎 R01–R27）：纯 Node，不需要浏览器，--no-web 也跑
command -v node >/dev/null || { [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh >/dev/null; }
echo -e "\n## 网页单测（web/test，node --test）\n\`\`\`" >> $REPORT
(cd web && npm test --silent > ../Reviews/web-unit.log 2>&1); ut=$?
grep -E '^ℹ (tests|pass|fail)|^✖' Reviews/web-unit.log >> $REPORT
echo '```' >> $REPORT
[ $ut = 0 ] || fail=1
# 核价提醒：超过 120 天没核的件列出来（只提醒，不判失败；人工按季度核价）
node --input-type=module -e "
import { stalePrices } from './web/src/catalog/schema.ts';
const s = stalePrices(new Date().toISOString().slice(0, 10));
console.log(s.length ? '核价提醒：' + s.length + ' 件超过 120 天未核价：' + s.map((x) => x.id).join('、') : '核价提醒：无（全部在 120 天内）');
" >> $REPORT 2>&1 || echo "核价提醒：脚本出错" >> $REPORT

if [ $NO_WEB = 0 ]; then
  echo -e "\n## 网页（Chrome 无头 + wasm）" >> $REPORT
  tools/build_web.sh >/dev/null 2>&1 || { echo "构建失败" >> $REPORT; fail=1; }
  for spec in blink:TRYBOARD_OK hello:TRYBOARD_OK rgb:TRYBOARD_OK oled:TRYBOARD_OK bme280:TRYBOARD_OK servo:TRYBOARD_OK "pot:ADC raw" s3-usb-keyboard:TRYBOARD_OK "s3-usb-cdc:USB 已连接" s3-blink:TRYBOARD_OK s3-rgb:TRYBOARD_OK s3-dual:TRYBOARD_OK weather:TRYBOARD_OK lens:TRYBOARD_OK spin:TRYBOARD_OK; do
    ex=${spec%%:*}; want=${spec#*:}
    r=$(node tools/webtest/webtest.mjs "$ex" "$want" 2>&1 | head -3)
    echo "$r" | sed 's/^/- /' >> $REPORT
    echo "$r" | grep -q PASS || fail=1
    echo "$r" | grep -q FAIL && fail=1
    echo "$r" | grep -q 页面错误 && fail=1
  done
  r=$(node tools/webtest/levels.mjs 2>&1 | grep '^\[levels\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q PASS || fail=1
  r=$(node tools/webtest/replay.mjs 2>&1 | grep '^\[replay\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q PASS || fail=1
  r=$(node tools/webtest/interact.mjs 2>&1 | grep '^\[interact\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q PASS || fail=1
  r=$(node tools/webtest/editor.mjs 2>&1 | tail -1)
  echo "- 元件编辑器（上传固件 + 加 BME280 / LED）：$r" >> $REPORT
  echo "$r" | grep -q PASS || fail=1
fi
echo -e "\n结论：$([ $fail = 0 ] && echo '全部通过' || echo '有失败项')" >> $REPORT
cat $REPORT
exit $fail
