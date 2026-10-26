#!/usr/bin/env python3
"""Level check: run firmware on the native core, judge each criterion of the level in firmware/levels.json, compute the run fingerprint.

The web (web/src/checks.ts) uses the same levels.json, the same rules and the same fingerprint; one firmware gets one fingerprint on both.

Usage:
  tools/check.py <flash.bin> --level 04      check your firmware (checkpoint 07 uses --level 07-spin / 07-lens; product checkpoints use ids like spin-1, lens-2)
  tools/check.py --ref --level 04            check the reference firmware (firmware/build/<ref>/flash.bin)
  tools/check.py --ref --all                 reference firmware of every checkpoint
  tools/check.py <flash.bin> --level-json cp.json
                                             check against the JSON from the web's "Export checkpoints" (board-generated checkpoints; manual items listed, not judged)
  tools/check.py <flash.bin> --level 06 --inputs log.txt
                                             replace the checkpoint's own input script with an input log exported by the web
                                             (bench "Export inputs", or InputLog JSON), replayed cycle by cycle like `tryboard run --inputs`
  tools/check.py --ref --level fault-wire     fault checkpoint (F-05): runs the bench as found (must FAIL) and the reference fix (must PASS)
  tools/check.py --ref --level fault-wire --i2c-wire 20
                                             fault checkpoint with your bench fix: the bench firmware plus your switches
                                             (--i2c-wire / --antenna-loss / --power / --servo replace the as-found values)
  tools/check.py app.bin --level fault-adc   fault checkpoint with your firmware on the bench as found
  tools/check.py --ref --level 05 --servo 4 --power usb --elec-report
                                             attach an SG90 to GPIO4 on USB power only (ext = external 5 V), print per-node minimum voltage /
                                             peak current / brownout resets (electrical data is not part of the fingerprint)
Exit code: 0 if everything passes, else 1.
"""
import json, math, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, 'core/target/release/tryboard')

# Transition: the USB host state names come from esp32s3 usb/host.rs (core agent); old names map to the English ones


def fnv1a(data: bytes) -> int:
    h = 0x811C9DC5
    for b in data:
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def fingerprint(stdout: str, report: str) -> str:
    """Fingerprint = FNV-1a of serial output + canonical report, shown as xxxx·xxxx"""
    h = '%08x' % fnv1a((stdout + '\n#report\n' + report).encode('utf-8'))
    return h[:4] + '·' + h[4:]


def canonical_report(err: str) -> str:
    """Pick the CLI stderr lines that match wasm tb_report, ordered GPIO -> WS2812 -> OLED -> LCD -> USB -> I2C acks -> PWM"""
    lines = err.splitlines()
    gpio = [l for l in lines if re.match(r'\[tryboard\] GPIO\d+ toggled \d+ times$', l)]
    ws = []
    for i, l in enumerate(lines):
        if re.match(r'\[tryboard\] WS2812 GPIO\d+ \d+ frames$', l):
            ws.append(l)
            for k in lines[i + 1:]:
                if not k.startswith('    '):
                    break
                ws.append(k)
    oled = [re.sub(r' \(.*$', '', l) for l in lines if l.startswith('[tryboard] OLED lit pixels')]
    # Any controller name: tb_report prints the same line for GC9107 / ST7789 / ILI9342 on M5 presets (M5-09b)
    lcd = [re.sub(r' \(.*$', '', l) for l in lines if re.match(r'\[tryboard\] LCD \S+ non-black pixels', l)]
    # Transition: both spellings of the LCD color line (emitter gc9a01.rs is owned by the core agent)
    lcd += [l for l in lines if l.startswith('[tryboard] LCD color #')]
    # USB virtual host (only with --usb-log): state + typed text, same text as wasm tb_usb_report; old and new spellings
    usb = [l for l in lines if re.match(r'\[tryboard\] USB (host: |keyboard typed: )', l)]
    # Acks per address (only with --i2c-log, U-17), same text as wasm tb_i2c_report; old and new spellings
    ack = [l for l in lines if re.match(r'\[tryboard\] I2C 0x[0-9a-f]{2} acked \d+ times$', l)]
    pwm = [l for l in lines if re.match(r'\[tryboard\] PWM GPIO\d+(:| steps| tones)', l)]
    return ''.join(l + '\n' for l in gpio + ws + oled + lcd + usb + ack + pwm)


def jsnum(v) -> str:
    """Number to string like JS String(x): integers without a decimal point"""
    return str(int(v)) if float(v).is_integer() else repr(float(v))


def evaluate(t: dict, out: str, report: str):
    """Return [(passed?, text)]; rules and text identical to web/src/checks.ts"""
    res = []
    for e in t.get('expect', []):
        res.append((e in out, f'serial shows "{e}"'))
    if re.search(r'Guru Meditation|abort\(\)|panic', out):
        res.append((False, 'firmware crashed'))
    if t.get('boots'):
        # Non-empty line: something left after stripping spaces, tabs and CRs (same test as checks.ts)
        n = len([x for x in out.split('\n') if x.strip(' \t\r')])
        crashed = re.search(r'Guru Meditation|abort\(\)|panic', out) is not None
        res.append((n >= 1 and not crashed, f"boot: {n} serial lines within {jsnum(t.get('seconds', 2))} s"))
    for c in t.get('i2c_ack', []):
        a = '%02x' % c['addr']
        m = re.search(rf'I2C 0x{a} acked (\d+) times', report)
        n = int(m.group(1)) if m else 0
        res.append((n >= c['min'], f"I2C 0x{a} acked {n} times (need ≥ {c['min']})"))
    g = t.get('gpio_toggles')
    if g:
        m = re.search(rf"GPIO{g['pin']} toggled (\d+) times", report)
        n = int(m.group(1)) if m else 0
        ok = n >= g['min'] and ('max' not in g or n <= g['max'])
        want = f"{g['min']}" if g.get('max') == g['min'] else f"≥ {g['min']}" + (f" and ≤ {g['max']}" if 'max' in g else '')
        res.append((ok, f"GPIO{g['pin']} toggled {n} times (need {want})"))
    pw = t.get('pwm')
    if pw:
        m = re.search(rf"PWM GPIO{pw['pin']}: (\d+) changes, duty ([\d.]+)\.\.([\d.]+), freq ([\d.]+)Hz", report)
        if not m or float(m.group(4)) == 0:
            res.append((False, f"GPIO{pw['pin']} has no PWM output"))
        else:
            lo, hi, f = float(m.group(2)), float(m.group(3)), float(m.group(4))
            sm = re.search(rf"PWM GPIO{pw['pin']} steps (.*)", report)
            ch = [(float(d), float(t)) for d, t in re.findall(r'([\d.]+)@([\d.]+)', sm.group(1))] if sm else []
            if 'from' in pw and ch:
                # Settled part only: the value being output at `from` plus later changes
                win = [d for d, t in ch if t > pw['from']]
                before = [d for d, t in ch if t <= pw['from']]
                win = before[-1:] + win
                lo, hi = min(win), max(win)
            tol = pw.get('tol', 0.01)
            # A melody (tones) changes pitch on purpose: the tones row judges it, not the note playing at the end
            f_bad = 'tones' not in pw and abs(f - pw['freq']) > pw['freq'] * 0.01
            ok = not f_bad and abs(lo - pw['min']) <= tol and abs(hi - pw['max']) <= tol
            # Numbers formatted the JS way (1.0 -> 1) so text matches the web / npm package byte for byte
            when = f", after {jsnum(pw['from'])} s" if 'from' in pw else ''
            # Pulse width first (what a servo cares about); on failure state the target directly
            span = lambda a, b: a if a == b else f"{a}–{b}"
            ms = lambda d, hz: f"{d * 1000 / hz:.2f}"
            want = '' if ok else f"; need {span(ms(pw['min'], pw['freq']), ms(pw['max'], pw['freq']))} ms" + (f", {jsnum(pw['freq'])} Hz" if f_bad else '')
            res.append((ok, f"GPIO{pw['pin']} PWM {f:.0f} Hz{when}, pulse {span(ms(lo, f), ms(hi, f))} ms (duty {span(f'{lo:.3f}', f'{hi:.3f}')}){want}"))
            if 'steps' in pw:
                seq, i, miss = [d for d, _ in ch], 0, []
                for want in pw['steps']:
                    j = i
                    while j < len(seq) and abs(seq[j] - want) > 0.002:
                        j += 1
                    if j == len(seq):
                        miss.append(want)  # not found: keep the cursor so later steps can still match
                    else:
                        i = j + 1
                ms = lambda d: f'{d * 1000 / pw["freq"]:.1f}'
                res.append((not miss, f"pulse widths in order {' → '.join(ms(d) for d in pw['steps'])} ms" + (f": missing {', '.join(ms(d) for d in miss)} ms" if miss else '')))
            if 'tones' in pw:
                tm = re.search(rf"PWM GPIO{pw['pin']} tones (.*)", report)
                hz = sorted({int(x) for x in re.findall(r'(\d+)@', tm.group(1))}) if tm else [int(f + 0.5)]
                res.append((len(hz) >= pw['tones'], f"GPIO{pw['pin']} played {len(hz)} different tones: {', '.join(f'{x} Hz' for x in hz)} (need ≥ {pw['tones']})"))
            for b in pw.get('beeps', []):
                # Beeps: times duty goes from 0 (or no output) to > 0 inside the window (buzzer rhythm, "faster when closer")
                n, prev = 0, 0.0
                for d, at in ch:
                    if d > 0 and prev == 0 and b['from'] <= at <= b['to']:
                        n += 1
                    prev = d
                want = f"{b['min']}" if b['min'] == b['max'] else f"{b['min']}–{b['max']}"
                res.append((b['min'] <= n <= b['max'], f"GPIO{pw['pin']} {jsnum(b['from'])}–{jsnum(b['to'])} s beeped {n} times (need {want})"))
    w = t.get('ws2812')
    if w:
        sec = re.search(rf"WS2812 GPIO{w['pin']} (\d+) frames\n((?:    .*\n?)*)", report)
        nf = int(sec.group(1)) if sec else 0
        frames = [l.split()[1:] for l in sec.group(2).splitlines()] if sec else []
        ok = nf >= w.get('min_frames', 1)
        for i, want in enumerate(w.get('frames', [])):
            ok = ok and i < len(frames) and frames[i] == want
        desc = f"WS2812 GPIO{w['pin']} {nf} frames"
        if 'dominant' in w:
            last = frames[-1][0] if frames and frames[-1] else '#000000'
            rgb = [int(last[1 + 2 * k:3 + 2 * k], 16) for k in range(3)]
            k = 'rgb'.index(w['dominant'])
            ok = ok and rgb[k] > 0 and rgb[k] == max(rgb) and rgb.count(rgb[k]) == 1
            desc += f", last frame {last} (need { {'r': 'red', 'g': 'green', 'b': 'blue'}[w['dominant']] })"
        if 'last' in w:
            # Last frame LED by LED: count, how many lit, lit color (±tol per channel)
            L = w['last']
            last = frames[-1] if frames else []
            want, tol, lit_want = int(L['rgb'][1:], 16), L.get('tol', 0), L.get('lit', L['count'])
            lit = [c for c in last if c != '#000000']
            near = lambda c: max(abs(((int(c[1:], 16) >> s) & 255) - ((want >> s) & 255)) for s in (16, 8, 0)) <= tol
            good = len(last) == L['count'] and len(lit) == lit_want and all(near(c) for c in lit)
            ok = ok and good
            desc += f", last frame {len(last)} LEDs, {len(lit)} lit (need {L['count']} LEDs, {lit_want} lit {L['rgb']} ±{tol})"
            if not good:
                desc += f": {' '.join(last) or '(no frames)'}"
        res.append((ok, desc))
    for n in t.get('numeric', []):
        vals = [float(v) for v in re.findall(n['regex'], out)]
        worst = max((abs(v - n['value']) for v in vals), default=None)
        ok = worst is not None and worst <= n['tol']
        res.append((ok, f"{n['name']} {len(vals)} readings, max deviation {'—' if worst is None else f'{worst:g}'} (tolerance {n['tol']})"))
    if 'oled_min_pixels' in t:
        m = re.search(r'OLED lit pixels (\d+)', report)
        n = int(m.group(1)) if m else 0
        res.append((n >= t['oled_min_pixels'], f"OLED lit {n} pixels (need ≥ {t['oled_min_pixels']})"))
    if 'lcd_min_pixels' in t:
        m = re.search(r'LCD (?:GC9A01|CO5300) non-black pixels (\d+)', report)
        n = int(m.group(1)) if m else 0
        res.append((n >= t['lcd_min_pixels'], f"round LCD lit {n} pixels (need ≥ {t['lcd_min_pixels']})"))
    for c in t.get('serial_count', []):
        n = out.count(c['text'])
        res.append((n >= c['min'], f"serial \"{c['text']}\" appeared {n} times (need ≥ {c['min']})"))
    au = t.get('audio')
    if au:
        # Same parse as accept.sh; the audio line rides along for judging only, it is not in the fingerprint
        m = re.search(r'I2S (?:speaker|buzzer).*?RMS ([\d.]+).*?freq ([\d.]+) Hz', report)
        rms, f = (float(m.group(1)), float(m.group(2))) if m else (0.0, 0.0)
        ok = m is not None and abs(f - au['freq']) <= au['tol'] and rms >= au.get('min_rms', 0)
        res.append((ok, f"sound {f:.1f} Hz, RMS {rms:.4f} (need {jsnum(au['freq'])} ± {jsnum(au['tol'])} Hz, RMS ≥ {jsnum(au.get('min_rms', 0))})"))
    u = t.get('usb')
    if u:
        m = re.search(r'USB host: (.+)$', report, re.M)
        st = m.group(1) if m else 'no USB device'
        if 'state' in u:
            need = u['state']
            res.append((st == need, f"USB device seen by the PC: {st} (need {need})"))
        if 'typed' in u:
            m = re.search(r'^\[tryboard\] USB keyboard typed: (".*")$', report, re.M)
            got = json.loads(m.group(1)) if m else ''
            shown = lambda x: x.replace('\n', '↵')
            res.append((got == u['typed'], f"typed on the PC \"{shown(got)}\" (need \"{shown(u['typed'])}\")"))
    if t.get('lcd_colors'):
        color_re = r'LCD color #([0-9a-f]{6}) (\d+) px, centroid ([\d.]+),([\d.]+)'
        seen = [(k, int(n), float(x), float(y)) for k, n, x, y in re.findall(color_re, report)]
        top = ', '.join(f'#{k} {n}' for k, n, _, _ in seen[:4]) or '(all black)'
        for c in t['lcd_colors']:
            want = int(c['rgb'][1:], 16)
            tol = c.get('tol', 24)
            near = lambda k: max(abs(((int(k, 16) >> s) & 255) - ((want >> s) & 255)) for s in (16, 8, 0)) <= tol
            hit = [(n, x, y) for k, n, x, y in seen if near(k)]
            n = sum(h[0] for h in hit)
            ok = n >= c['min'] and ('max' not in c or n <= c['max'])
            want_n = f"≥ {c['min']}" + (f" and ≤ {c['max']}" if 'max' in c else '')
            desc = f"round LCD {c['name']} ({c['rgb']} ±{tol}) {n} px (need {want_n})"
            if 'cx' in c:
                cx = sum(a * b for a, b, _ in hit) / n if n else -1
                ok = ok and c['cx'][0] <= cx <= c['cx'][1]
                desc += f", horizontal centroid {'—' if n == 0 else f'{cx:.1f}'} (need {c['cx'][0]}–{c['cx'][1]})"
            if 'cy' in c:
                cy = sum(a * y for a, _, y in hit) / n if n else -1
                ok = ok and c['cy'][0] <= cy <= c['cy'][1]
                desc += f", vertical centroid {'—' if n == 0 else f'{cy:.1f}'} (need {c['cy'][0]}–{c['cy'][1]})"
            if not ok:
                desc += f"; main colors {top}"
            res.append((ok, desc))
    return res


def expand(levels):
    """Levels with several products (level 07) expand into sub-levels like 07-spin, 07-lens; same as expandLevels in web/src/checks.ts"""
    out = []
    for l in levels:
        out.append(l)
        for v in l.get('variants', []):
            out.append({**v, 'id': f"{l['id']}-{v['key']}", 'title': f"{l['title']} · {v['title']}"})
    return out


def inputs_file(path: str) -> str:
    """--inputs takes CLI script text (used as is) or the web's InputLog JSON (turned into a script like toScript in web/src/inputlog.ts)"""
    text = open(path, encoding='utf-8').read()
    if not text.lstrip().startswith('{'):
        return path
    log = json.loads(text)
    esc = lambda x: x.replace('\n', '\\n')
    # Same number formatting as JS: integers without a decimal point
    num = jsnum
    lines = ['# converted by check.py from InputLog JSON']
    for e in log['events']:
        k = e['kind']
        act = {
            'gpio': lambda: f"gpio{e['pin']}={'z' if e['level'] < 0 else 1 if e['level'] else 0}",
            'env': lambda: f"env={num(e['temp'])},{num(e['humidity'])},{num(e['pressure'])}",
            'pot': lambda: f"mv{e['pin']}={num(e['mv'])}",
            'uart': lambda: f"uart={esc(e['text'])}",
            'usbcdc': lambda: f"usbcdc={esc(e['text'])}",
            'i2cwire': lambda: f"i2cwire={num(e['cm'])}",
            'antenna': lambda: f"antenna={num(e['db'])}",
            'supply': lambda: f"power={e['mode']}",
            'realnet': lambda: f"realnet={1 if e['on'] else 0}",
            'netreply': lambda: f"netreply={e['reply']}",
            'seed': lambda: f"seed={e['seed']}",
            'net': lambda: f"net={e['preset']}",
            'netfault': lambda: f"netfault={e['fault']}" + ('' if e.get('dur') is None else f",{num(e['dur'])}"),
        }.get(k)
        if act:
            # Same as the web: seconds, floored to the microsecond
            lines.append(f"{math.floor(e['tMs'] * 1000) / 1e6:.6f}:{act()}")
    out = os.path.join(ROOT, 'Reviews', os.path.basename(path) + '.txt')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    return out


# Bench switches a player may change (F-05 knobs); each takes one value
KNOB_FLAGS = ('--i2c-wire', '--antenna-loss', '--power', '--servo', '--i2c-bus')


def merge_args(base, overlay):
    """Lay flag/value pairs over args: a flag already there gets the new value, others append (= mergeArgs in web/src/faults.ts)"""
    out = list(base)
    for i in range(0, len(overlay) - 1, 2):
        k, v = overlay[i], overlay[i + 1]
        if k in out and out.index(k) + 1 < len(out):
            out[out.index(k) + 1] = v
        else:
            out += [k, v]
    return out


def fault_level(t: dict, knobs=(), fix=False):
    """Fault checkpoint as a plain one: bench as found (or the reference fix), then the player's switches on top"""
    f = t['fault']
    args = merge_args(t.get('args', []), f.get('args', []))
    if fix:
        args = merge_args(args, f.get('fix', []))
    return {**t, 'args': merge_args(args, list(knobs))}


def fault_self_check(t: dict, fw: str, inputs: str, extra, show_elec: bool) -> bool:
    """Reference check of a fault checkpoint: the bench as found must FAIL, every reference fix must PASS"""
    f = t['fault']
    base = t.get('args', [])
    flags = lambda lv: ' '.join(lv['args'][len(base):]) or 'bench as found'
    runs = [('as found', fw, fault_level(t), False)]
    if f.get('fix'):
        runs.append(('fixed', fw, fault_level(t, fix=True), True))
    if f.get('fix_ref'):
        runs.append((f"fixed firmware {f['fix_ref']}", os.path.join(ROOT, 'firmware/build', f['fix_ref'], 'flash.bin'), fault_level(t), True))
    out, good, head = [], True, None
    for name, path, lv, want in runs:
        if not os.path.exists(path):
            good = False
            out.append(f"  {name}: {path} not found")
            continue
        res, fp, elec = run(path, lv, inputs, extra)
        ok = all(r[0] for r in res)
        good = good and ok == want
        if want and head is None:
            head = fp
        tag = ('PASS' if ok else 'FAIL') + ('' if ok == want else f" (expected {'PASS' if want else 'FAIL'})")
        out.append(f"  {name} ({flags(lv)}): {tag}  fingerprint {fp}")
        out += [f"    {'✓' if r else '✗'} {d}" for r, d in res]
        if show_elec:
            out += ['    ' + l.replace('[tryboard] ', '') for l in elec]
    # Headline fingerprint = the first reference fix, which a web run with the same fix reproduces
    print(f"Checkpoint {t['id']} {t['title']}: {'PASS' if good else 'FAIL'}  fingerprint {head or '-'}  (fault reproduces, reference fix passes)")
    print('\n'.join(out))
    return good


def run(fw: str, t: dict, inputs: str = '', extra=()):
    cmd = [CLI, 'run', fw, '--seconds', str(t.get('seconds', 2)), '--gpio-log', '--ws2812-log'] + t.get('args', []) + list(extra)
    if inputs:
        cmd += ['--inputs', inputs_file(inputs)]
    elif t.get('script'):
        cmd += ['--script', t['script']]
    if t.get('pwm'):
        cmd += ['--pwm-log', str(t['pwm']['pin'])]
    # Read raw bytes without newline translation: the fingerprint must match the web byte for byte (firmware prints \r\n)
    p = subprocess.run(cmd, capture_output=True)
    out, err = p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')
    report = canonical_report(err)
    audio = ''.join(l + '\n' for l in err.splitlines() if re.match(r'\[tryboard\] I2S (speaker|buzzer)', l))
    res = evaluate(t, out, report + audio)
    # The simulator itself failing to start (missing ROM, broken image) is not the firmware's fault
    if p.returncode != 0 or 'boot failed' in err:
        lines = [l for l in err.splitlines() if l.strip()]
        tail = [l for l in lines if 'panicked' in l or 'boot failed' in l][:1] or lines[-1:] or ['(no output)']
        res.insert(0, (False, f'simulator did not start: {tail[0][:120]}'))
    # Transition: electrical lines come from the elec crate (core agent); accept both prefixes
    elec = [l for l in err.splitlines() if l.startswith('[tryboard] elec') or 'brownout reset (' in l]
    return res, fingerprint(out, report), elec


def main():
    a = sys.argv[1:]
    ref = '--ref' in a
    # --level-json: Level JSON from the web's "Export checkpoints" (array or single; board-generated custom-<n> checkpoints, U-17)
    custom = None
    if '--level-json' in a:
        d = json.load(open(a[a.index('--level-json') + 1], encoding='utf-8'))
        custom = d if isinstance(d, list) else [d]
    levels = custom if custom is not None else [l for l in expand(json.load(open(os.path.join(ROOT, 'firmware/levels.json')))) if l.get('ref')]
    if '--all' in a or (custom is not None and '--level' not in a):
        pick = levels
    else:
        lv = a[a.index('--level') + 1]
        pick = [l for l in levels if l['id'] == (lv.zfill(2) if lv.isdigit() else lv)]
        if not pick:
            sys.exit(f'no checkpoint {lv} (or it has no command-line check)')
    skip = {a.index(k) + 1 for k in ('--level', '--level-json', '--inputs') + KNOB_FLAGS if k in a}
    # Power (P1-02) and harness: passed through to tryboard run; fault checkpoints merge them into the bench instead
    knobs = []
    for k in KNOB_FLAGS:
        if k in a:
            knobs += [k, a[a.index(k) + 1]]
    extra = []
    show_elec = '--elec-report' in a
    if show_elec:
        extra.append('--elec-report')
    inputs = a[a.index('--inputs') + 1] if '--inputs' in a else ''
    pos = [x for i, x in enumerate(a) if not x.startswith('--') and i not in skip]
    if not ref and not pos:
        sys.exit(__doc__)
    user_fw = pos[0] if pos else ''
    bad = 0
    for t in pick:
        if t.get('manual'):
            print(f"Checkpoint {t['id']} {t['title']}: needs real hardware, not judged")
            continue
        if ref and not t.get('ref'):
            print(f"Checkpoint {t['id']} {t['title']}: no reference firmware")
            bad += 1
            continue
        fw = os.path.join(ROOT, 'firmware/build', t['ref'], 'flash.bin') if ref else user_fw
        if not os.path.exists(fw):
            print(f"Checkpoint {t['id']} {t['title']}: {fw} not found")
            bad += 1
            continue
        if t.get('fault') and ref and not knobs:
            bad += not fault_self_check(t, fw, inputs, extra, show_elec)
            continue
        if t.get('fault'):
            t = fault_level(t, knobs)
            res, fp, elec = run(fw, t, inputs, extra)
        else:
            res, fp, elec = run(fw, t, inputs, extra + knobs)
        ok = all(r[0] for r in res)
        bad += not ok
        print(f"Checkpoint {t['id']} {t['title']}: {'PASS' if ok else 'FAIL'}  fingerprint {fp}")
        for r, d in res:
            print(f"  {'✓' if r else '✗'} {d}")
        if show_elec:
            for l in elec:
                print('  ' + l.replace('[tryboard] ', ''))
        if t.get('assembly'):
            print('  · assembly check (geometric estimate) runs only on the web')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
