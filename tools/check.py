#!/usr/bin/env python3
"""关卡验收：用原生内核跑固件，按 firmware/levels.json 里这一关的条件逐条判定，并算出运行指纹。

网页（web/src/checks.ts）用同一份 levels.json、同样的判定规则和指纹算法；同一个固件在两边应得到同一个指纹。

用法：
  tools/check.py <flash.bin> --level 04      验收你的固件
  tools/check.py --ref --level 04            验收参考固件（firmware/build/<ref>/flash.bin）
  tools/check.py --ref --all                 所有关卡的参考固件
退出码：全部通过 0，否则 1。
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, 'core/target/release/tryboard')


def fnv1a(data: bytes) -> int:
    h = 0x811C9DC5
    for b in data:
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def fingerprint(stdout: str, report: str) -> str:
    """指纹 = 串口输出 + 规范化观察记录 的 FNV-1a，显示成 xxxx·xxxx"""
    h = '%08x' % fnv1a((stdout + '\n#report\n' + report).encode('utf-8'))
    return h[:4] + '·' + h[4:]


def canonical_report(err: str) -> str:
    """从命令行 stderr 里取出与 wasm tb_report 同格式的部分，按 GPIO → WS2812 → OLED → PWM 排好"""
    lines = err.splitlines()
    gpio = [l for l in lines if re.match(r'\[tryboard\] GPIO\d+ 翻转 \d+ 次$', l)]
    ws = []
    for i, l in enumerate(lines):
        if re.match(r'\[tryboard\] WS2812 GPIO\d+ 共 \d+ 帧$', l):
            ws.append(l)
            for k in lines[i + 1:]:
                if not k.startswith('    '):
                    break
                ws.append(k)
    oled = [re.sub(r'（.*$', '', l) for l in lines if l.startswith('[tryboard] OLED 点亮像素')]
    pwm = [l for l in lines if re.match(r'\[tryboard\] PWM GPIO\d+:', l)]
    return ''.join(l + '\n' for l in gpio + ws + oled + pwm)


def evaluate(t: dict, out: str, report: str):
    """返回 [(通过?, 说明)]；规则与 web/src/checks.ts 一致"""
    res = []
    for e in t.get('expect', []):
        res.append((e in out, f'串口出现 “{e}”'))
    if re.search(r'Guru Meditation|abort\(\)|panic', out):
        res.append((False, '固件崩溃'))
    g = t.get('gpio_toggles')
    if g:
        m = re.search(rf"GPIO{g['pin']} 翻转 (\d+) 次", report)
        n = int(m.group(1)) if m else 0
        ok = n >= g['min'] and ('max' not in g or n <= g['max'])
        want = f"{g['min']}" if g.get('max') == g['min'] else f"≥ {g['min']}" + (f" 且 ≤ {g['max']}" if 'max' in g else '')
        res.append((ok, f"GPIO{g['pin']} 翻转 {n} 次（要 {want}）"))
    pw = t.get('pwm')
    if pw:
        m = re.search(rf"PWM GPIO{pw['pin']}: (\d+) 次变化，占空比 ([\d.]+)\.\.([\d.]+)，频率 ([\d.]+)Hz", report)
        if not m:
            res.append((False, f"GPIO{pw['pin']} 没有 PWM 输出"))
        else:
            lo, hi, f = float(m.group(2)), float(m.group(3)), float(m.group(4))
            tol = pw.get('tol', 0.01)
            ok = abs(f - pw['freq']) <= pw['freq'] * 0.01 and abs(lo - pw['min']) <= tol and abs(hi - pw['max']) <= tol
            res.append((ok, f"GPIO{pw['pin']} PWM {f:.0f} Hz，脉宽 {lo * 1000 / f:.3f}–{hi * 1000 / f:.3f} ms"))
    w = t.get('ws2812')
    if w:
        sec = re.search(rf"WS2812 GPIO{w['pin']} 共 (\d+) 帧\n((?:    .*\n?)*)", report)
        nf = int(sec.group(1)) if sec else 0
        frames = [l.split()[1:] for l in sec.group(2).splitlines()] if sec else []
        ok = nf >= w.get('min_frames', 1)
        for i, want in enumerate(w.get('frames', [])):
            ok = ok and i < len(frames) and frames[i] == want
        desc = f"WS2812 GPIO{w['pin']} {nf} 帧"
        if 'dominant' in w:
            last = frames[-1][0] if frames and frames[-1] else '#000000'
            rgb = [int(last[1 + 2 * k:3 + 2 * k], 16) for k in range(3)]
            k = 'rgb'.index(w['dominant'])
            ok = ok and rgb[k] > 0 and rgb[k] == max(rgb) and rgb.count(rgb[k]) == 1
            desc += f"，最后一帧 {last}（要{ {'r': '红', 'g': '绿', 'b': '蓝'}[w['dominant']] }色）"
        res.append((ok, desc))
    for n in t.get('numeric', []):
        vals = [float(v) for v in re.findall(n['regex'], out)]
        worst = max((abs(v - n['value']) for v in vals), default=None)
        ok = worst is not None and worst <= n['tol']
        res.append((ok, f"{n['name']} {len(vals)} 次读数，最大偏差 {'—' if worst is None else f'{worst:g}'}（容差 {n['tol']}）"))
    if 'oled_min_pixels' in t:
        m = re.search(r'OLED 点亮像素 (\d+)', report)
        n = int(m.group(1)) if m else 0
        res.append((n >= t['oled_min_pixels'], f"OLED 点亮 {n} 像素（要 ≥ {t['oled_min_pixels']}）"))
    return res


def run(fw: str, t: dict):
    cmd = [CLI, 'run', fw, '--seconds', str(t['seconds']), '--gpio-log', '--ws2812-log'] + t.get('args', [])
    if t.get('script'):
        cmd += ['--script', t['script']]
    if t.get('pwm'):
        cmd += ['--pwm-log', str(t['pwm']['pin'])]
    # 按字节读、不做换行转换：指纹要和网页逐字节一致（固件输出是 \r\n）
    p = subprocess.run(cmd, capture_output=True)
    out, err = p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')
    report = canonical_report(err)
    return evaluate(t, out, report), fingerprint(out, report)


def main():
    a = sys.argv[1:]
    levels = [l for l in json.load(open(os.path.join(ROOT, 'firmware/levels.json'))) if l.get('ref')]
    ref = '--ref' in a
    if '--all' in a:
        pick = levels
    else:
        lv = a[a.index('--level') + 1]
        pick = [l for l in levels if l['id'] == lv.zfill(2)]
        if not pick:
            sys.exit(f'没有第 {lv} 关（或这一关没有命令行验收）')
    skip = {a.index('--level') + 1} if '--level' in a else set()
    pos = [x for i, x in enumerate(a) if not x.startswith('--') and i not in skip]
    if not ref and not pos:
        sys.exit(__doc__)
    user_fw = pos[0] if pos else ''
    bad = 0
    for t in pick:
        fw = os.path.join(ROOT, 'firmware/build', t['ref'], 'flash.bin') if ref else user_fw
        if not os.path.exists(fw):
            print(f"第 {t['id']} 关 {t['title']}：找不到 {fw}")
            bad += 1
            continue
        res, fp = run(fw, t)
        ok = all(r[0] for r in res)
        bad += not ok
        print(f"第 {t['id']} 关 {t['title']}：{'通过' if ok else '未通过'}  指纹 {fp}")
        for r, d in res:
            print(f"  {'✓' if r else '✗'} {d}")
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
