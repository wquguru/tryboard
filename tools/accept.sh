#!/bin/bash
# Full acceptance: CPU (riscv-tests) -> firmware (native core vs expected output, optional QEMU oracle) -> web smoke.
# Writes Reviews/accept.md; any failure gives a non-zero exit. Usage: tools/accept.sh [--no-web] [--no-qemu]
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
echo "# Acceptance report $(date '+%Y-%m-%d %H:%M')"
echo
echo "## CPU: riscv-tests"
echo '```'
core/target/release/tryboard riscv-test third_party/rvt-out/* | tail -1
echo '```'
} > $REPORT
core/target/release/tryboard riscv-test third_party/rvt-out/* >/dev/null || fail=1

echo -e "\n## Firmware\n| Firmware | Result | Notes |\n|---|---|---|" >> $REPORT
python3 - "$ROOT" "$NO_QEMU" >> $REPORT <<'PY' || fail=1
import json, subprocess, sys, os, re
root, no_qemu = sys.argv[1], sys.argv[2] == '1'
bad = 0
for t in json.load(open(f'{root}/firmware/accept.json')):
    # fw: firmware directory when one firmware serves several cases (e.g. temperatures); defaults to id
    fw = f"{root}/firmware/build/{t.get('fw', t['id'])}/flash.bin"
    if not os.path.exists(fw):
        print(f"| {t['id']} | ❌ | not built |"); bad += 1; continue
    cmd = [f'{root}/core/target/release/tryboard', 'run', fw, '--seconds', str(t['seconds']), '--gpio-log'] + t.get('args', [])
    if t.get('script'): cmd += ['--script', t['script']]
    if t.get('pwm'): cmd += ['--pwm-log', str(t['pwm']['pin'])]
    if t.get('ws2812'): cmd += ['--ws2812-log']
    ppm = None
    if t.get('lcd_regions'):
        os.makedirs(f'{root}/Reviews/lcd', exist_ok=True)
        ppm = f"{root}/Reviews/lcd/{t['id']}.ppm"
        if os.path.exists(ppm): os.remove(ppm)
        cmd += ['--lcd-ppm', ppm]
    p = subprocess.run(cmd, capture_output=True, text=True, errors='replace')
    out, err = p.stdout, p.stderr
    missing = [e for e in t['expect'] if e not in out]
    notes = []
    if missing: notes.append('missing output: ' + ', '.join(missing))
    # absent: output that must not appear (e.g. no brownout reset on external 5 V)
    present = [e for e in t.get('absent', []) if e in out]
    if present:
        notes.append('should not appear: ' + ', '.join(present)); missing += ['absent:' + e for e in present]
    # stderr_expect: what the simulator observed (e.g. keys decoded by the virtual USB host), not firmware prints
    for e in t.get('stderr_expect', []):
        if e not in err:
            missing.append(e)
            notes.append(f'simulator side missing: {e}')
    if t.get('stderr_expect'):
        nok = sum(e in err for e in t['stderr_expect'])
        notes.append(f'host side checks {nok}/{len(t["stderr_expect"])}')
    if re.search(r'Guru Meditation|abort\(\)|panic', out):
        # crash_expected: the case checks that a fault crashes the firmware (e.g. long I2C wire -> NACK -> ESP_ERROR_CHECK abort)
        if t.get('crash_expected'): notes.append('firmware crashed as expected (' + t['crash_expected'] + ')')
        else: notes.append('firmware crashed'); missing.append('crash')
    elif t.get('crash_expected'): notes.append('should have crashed but did not'); missing.append('crash_expected')
    g = t.get('gpio_toggles')
    if g:
        m = re.search(rf"GPIO{g['pin']} toggled (\d+) times", err)
        n = int(m.group(1)) if m else 0
        notes.append(f"GPIO{g['pin']} toggled {n} times")
        if n < g['min']: missing.append('gpio')
    pw = t.get('pwm')
    if pw:
        m = re.search(r'PWM GPIO\d+: (\d+) changes, duty ([\d.]+)\.\.([\d.]+), freq ([\d.]+)Hz', err)
        if not m:
            notes.append('no PWM output'); missing.append('pwm')
        else:
            lo, hi, f = float(m.group(2)), float(m.group(3)), float(m.group(4))
            notes.append(f"PWM {f:.0f}Hz duty {lo:.3f}..{hi:.3f}")
            if abs(f - pw['freq']) > pw['freq'] * 0.01 or abs(lo - pw['min']) > 0.01 or abs(hi - pw['max']) > 0.01:
                missing.append('pwm')
    w = t.get('ws2812')
    if w:
        # Decoded frames: '[tryboard] WS2812 GPIO8 N frames' then one '    time s #rrggbb ...' line per frame
        sec = re.search(rf"WS2812 GPIO{w['pin']} (\d+) frames\n((?:    .*\n?)*)", err)
        nf = int(sec.group(1)) if sec else 0
        frames = [l.split()[1:] for l in sec.group(2).splitlines()] if sec else []
        notes.append(f"WS2812 GPIO{w['pin']} decoded {nf} frames")
        if nf < w.get('min_frames', 1): missing.append('ws2812 frame count')
        bad_frames = [i for i, want in enumerate(w.get('frames', [])) if i >= len(frames) or frames[i] != want]
        if bad_frames:
            missing.append('ws2812 colors')
            i = bad_frames[0]
            notes.append(f"frame {i} should be {' '.join(w['frames'][i])}, got {' '.join(frames[i]) if i < len(frames) else 'none'}")
        else:
            notes.append(f"first {len(w.get('frames', []))} frames match LED by LED")
    # Numeric check: every printed reading must be within tolerance of the simulated environment value
    for nchk in t.get('numeric', []):
        vals = [float(v) for v in re.findall(nchk['regex'], out)]
        worst = max((abs(v - nchk['value']) for v in vals), default=None)
        if worst is None or worst > nchk['tol']:
            missing.append(nchk['name'])
            notes.append(f"{nchk['name']} deviation {worst} exceeds {nchk['tol']}")
        else:
            notes.append(f"{nchk['name']} {len(vals)} readings, error ≤ {worst:g}")
    if 'oled_min_pixels' in t:
        m = re.search(r'OLED lit pixels (\d+)', err)
        n = int(m.group(1)) if m else 0
        notes.append(f"OLED lit {n} pixels")
        if n < t['oled_min_pixels']: missing.append('oled')
    # Round LCD: '[tryboard] LCD GC9A01 non-black pixels N (display on)', counted inside the round visible area only
    if 'lcd_min_pixels' in t:
        m = re.search(r'LCD (?:GC9A01|CO5300) non-black pixels (\d+) \(display (\w+)\)', err)
        n = int(m.group(1)) if m else 0
        notes.append(f"LCD non-black {n} pixels (display {m.group(2) if m else 'none'})")
        if n < t['lcd_min_pixels']: missing.append('lcd')
    # lcd_regions: pixel counts in rectangles of the last frame (--lcd-ppm); 'color' matches within 'tol' per channel, else any non-black
    if ppm:
        try:
            parts = open(ppm, 'rb').read().split(b'\n', 3)
            lw, px = int(parts[1].split()[0]), parts[3]
        except (OSError, IndexError, ValueError):
            px, lw = None, 0
        for r in t['lcd_regions']:
            name = r.get('name', f"{r['x']},{r['y']} {r['w']}x{r['h']}")
            if px is None:
                missing.append(f'lcd region {name}'); notes.append('no LCD frame'); break
            c = r.get('color')
            want = (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)) if c else None
            tol = r.get('tol', 8)
            n = 0
            for y in range(r['y'], r['y'] + r['h']):
                row = px[(y * lw + r['x']) * 3:(y * lw + r['x'] + r['w']) * 3]
                for i in range(0, len(row), 3):
                    p3 = row[i:i + 3]
                    n += all(abs(p3[k] - want[k]) <= tol for k in range(3)) if want else max(p3) > 16
            ok_r = r.get('min_pixels', 0) <= n <= r.get('max_pixels', 1 << 30)
            notes.append(f"region {name}: {n} px{'' if ok_r else ' (out of range)'}")
            if not ok_r: missing.append(f'lcd region {name}')
    # Speaker: the simulator's analysis of PCM reaching the speaker (sample rate, last-second RMS, peak, dominant frequency).
    au = t.get('audio')
    if au:
        m = re.search(r'I2S speaker.*?sample rate ([\d.]+) Hz.*?RMS ([\d.]+).*?peak ([\d.]+).*?freq ([\d.]+) Hz', err)
        if not m:
            notes.append('speaker received no sound'); missing.append('audio')
        else:
            rate, rms, f = float(m.group(1)), float(m.group(2)), float(m.group(4))
            notes.append(f"speaker {rate:.1f} Hz sample rate, dominant {f:.1f} Hz, RMS {rms:.4f}")
            if abs(f - au['freq']) > au['tol'] or abs(rate - au['rate']) > 1 or rms < au.get('min_rms', 0):
                missing.append('audio')
    speed = re.search(r'simulated ([\d.]+)s / wall ([\d.]+)s', err)
    if speed: notes.append(f"simulated {speed.group(1)}s in {speed.group(2)}s")
    if t.get('qemu') and not no_qemu:
        q = subprocess.run([f'{root}/tools/oracle_qemu.sh', t['id'], str(int(t['seconds']) + 3)], capture_output=True, text=True, errors='replace').stdout
        # Our eFuse sets the chip revision, so it differs from QEMU; expectations in qemu_skip are not compared
        skip = set(t.get('qemu_skip', []))
        qm = [e for e in t['expect'] if e not in skip and e.replace('v0.4', 'v0.3') not in q]
        notes.append('QEMU oracle agrees' if not qm else 'QEMU oracle missing: ' + ', '.join(qm))
    ok = not missing
    # known_gap: a documented gap; only when "firmware crashed" is the sole failure it is ⚠️, not a fail
    gap = t.get('known_gap')
    if gap and missing == ['crash']:
        notes.append(f"known gap: {gap}")
        print(f"| {t['id']} | ⚠️ | {'; '.join(notes)} |")
    else:
        bad += not ok
        print(f"| {t['id']} | {'✅' if ok else '❌'} | {'; '.join(notes)} |")
    un = re.findall(r'^\s+(0x[0-9a-f]+)\s+(\d+) times', err, re.M)[:5]
    if un: print(f"| | | unmodeled registers top: {' '.join(a for a,_ in un)} |")
sys.exit(1 if bad else 0)
PY

# wasm export interface (R-07): web/src/wasm.gen.ts must match core/crates/wasm/src/lib.rs
echo -e "\n## wasm export interface (tools/gen_wasm_ts.py --check)" >> $REPORT
python3 tools/gen_wasm_ts.py --check >> $REPORT 2>&1 || fail=1

# Structural guardrails (R-14): file / function size, rAF outside frame.ts, chip literals, crate layering; allow list only shrinks
echo -e "\n## Structural guardrails (tools/lint_size.py)" >> $REPORT
{ python3 tools/lint_size.py && python3 tools/lint_size.py --selftest; } >> $REPORT 2>&1 || fail=1

# Config cross-check (R-13): ids in firmware/*.json and the web catalog resolve to firmware, chips, devices and parts
echo -e "\n## Config cross-check (tools/check_config.py)\n\`\`\`" >> $REPORT
{ python3 tools/check_config.py && python3 tools/check_config.py --selftest; } >> $REPORT 2>&1 || fail=1
echo '```' >> $REPORT

# Golden snapshots (R-02): byte-identical CLI output vs Reviews/golden/ (take one with `tools/golden.py save` before a refactor)
echo -e "\n## Golden snapshots (tools/golden.py)" >> $REPORT
if [ -d Reviews/golden ]; then
  python3 tools/golden.py check > Reviews/golden.log 2>&1 || fail=1
  { tail -1 Reviews/golden.log; grep -A2 DIFF Reviews/golden.log | head -30; } >> $REPORT
else
  echo "skipped: no snapshot (run tools/golden.py save on the unchanged tree first)" >> $REPORT
fi

# Circuit solver vs ngspice (P1-01): tools/elec/*.cir; skipped with a reason when ngspice is missing
echo -e "\n## Circuit solver vs ngspice (tools/elec)" >> $REPORT
python3 tools/elec/compare.py --md >> $REPORT 2>&1 || fail=1

echo -e "\n## Levels (firmware/levels.json, reference firmware)\n\`\`\`" >> $REPORT
tools/check.py --ref --all >> $REPORT 2>&1 || fail=1
echo '```' >> $REPORT

# npm local package (packages/tryboard, P1-14): pack, then `npx ./tryboard-*.tgz check` vs check.py per level
# (verdict, full output with fingerprint, exit code)
command -v node >/dev/null || { [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh >/dev/null; }
echo -e "\n## npm local package parity (npx tryboard check vs tools/check.py)" >> $REPORT
if tools/build_npm.sh > Reviews/npm-build.log 2>&1; then
  tail -1 Reviews/npm-build.log >> $REPORT
  echo >> $REPORT
  tools/npm_parity.sh >> $REPORT 2>&1 || fail=1
else
  echo "packing failed (see Reviews/npm-build.log)" >> $REPORT; fail=1
fi
# Logic analyzer events (CLI): weather for 2 s; --trace-io must show BME280 reading 8 bytes from 0xF7 and 50 Hz servo PWM
echo -e "\n## Logic analyzer events (--trace-io)" >> $REPORT
core/target/release/tryboard run firmware/build/weather/flash.bin --seconds 2 --i2c ssd1306@0x3c,bme280@0x76 --trace-io Reviews/trace-io-weather.txt >/dev/null 2>Reviews/trace-io-weather.err
if python3 - Reviews/trace-io-weather.txt >> $REPORT <<'PY'
import re, sys
L = [l.strip().split(' ', 1)[1] for l in open(sys.argv[1]) if l[0].isdigit()]
s = '|'.join(L)
burst = re.search(r'I2C0 DATA f7 W ACK\|I2C0 RESTART \d+\|I2C0 ADDR 76 R ACK\|(I2C0 DATA .. R ACK\|){7}I2C0 DATA .. R NACK\|I2C0 STOP', s)
servo = any(re.fullmatch(r'PWM 4 \d+ 50000', l) for l in L)
print(f"- {len(L)} events; 0x76 reads 8 bytes from 0xF7: {'✅' if burst else '❌'}; GPIO4 50 Hz PWM: {'✅' if servo else '❌'}")
sys.exit(0 if burst and servo else 1)
PY
then :; else fail=1; fi

# Task timeline (--trace-tasks): the s3-dual-tasks case's Perfetto file must be valid JSON, w0 only on core 0, w1 only on core 1
echo -e "\n## Task timeline (--trace-tasks)" >> $REPORT
if python3 - Reviews/tasks-s3-dual.json >> $REPORT <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
x = [e for e in d['traceEvents'] if e.get('ph') == 'X' and e.get('pid') == 1]
cores = lambda n: sorted({e['tid'] for e in x if e['name'] == n})
ok = cores('w0') == [0] and cores('w1') == [1] and cores('IDLE0') == [0] and cores('IDLE1') == [1]
print(f"- s3-dual: {len(x)} slices; w0 cores {cores('w0')}, w1 cores {cores('w1')}, IDLE0 cores {cores('IDLE0')}, IDLE1 cores {cores('IDLE1')}: {'✅' if ok else '❌'}")
sys.exit(0 if ok else 1)
PY
then :; else fail=1; fi

# Web unit tests (catalog schema, price review, rules R01–R32): plain Node, no browser, so they run with --no-web too
command -v node >/dev/null || { [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh >/dev/null; }
echo -e "\n## Web unit tests (web/test, node --test)\n\`\`\`" >> $REPORT
(cd web && npm test --silent > ../Reviews/web-unit.log 2>&1); ut=$?
grep -E '^ℹ (tests|pass|fail)|^✖' Reviews/web-unit.log >> $REPORT
echo '```' >> $REPORT
[ $ut = 0 ] || fail=1
# Price review reminder: parts unchecked for over 120 days (reminder only, not a failure; prices are reviewed quarterly)
node --input-type=module -e "
import { stalePrices } from './web/src/catalog/schema.ts';
const s = stalePrices(new Date().toISOString().slice(0, 10));
console.log(s.length ? 'Price review: ' + s.length + ' parts not reviewed for over 120 days: ' + s.map((x) => x.id).join(', ') : 'Price review: none (all within 120 days)');
" >> $REPORT 2>&1 || echo "Price review: script error" >> $REPORT

if [ $NO_WEB = 0 ]; then
  echo -e "\n## Web (headless Chrome + wasm)" >> $REPORT
  tools/build_web.sh >/dev/null 2>&1 || { echo "build failed" >> $REPORT; fail=1; }
  # Expected texts are firmware serial prints; the webtest scripts report in English
  for spec in blink:TRYBOARD_OK hello:TRYBOARD_OK rgb:TRYBOARD_OK oled:TRYBOARD_OK bme280:TRYBOARD_OK servo:TRYBOARD_OK "pot:ADC raw" s3-usb-keyboard:TRYBOARD_OK "s3-usb-cdc:USB 已连接" s3-blink:TRYBOARD_OK s3-rgb:TRYBOARD_OK s3-dual:TRYBOARD_OK weather:TRYBOARD_OK lens:TRYBOARD_OK spin:TRYBOARD_OK s3-wifi-http:TRYBOARD_OK s3-lvgl:TRYBOARD_OK "s3-encoder:ENCODER ready" "s3-ultrasonic:DIST 15.0 cm" s3-imu:TRYBOARD_OK s3-qmi8658:TRYBOARD_OK s3-touch:TRYBOARD_OK s3-co5300:TRYBOARD_OK s3-amoled-i2c:TRYBOARD_OK "usbkey:TRYBOARD_OK usbkey" "echo:串口回显" esp32-hello:TRYBOARD_OK esp32-blink:TRYBOARD_OK esp32-wifi:TRYBOARD_OK; do  # lint: allow-cjk
    ex=${spec%%:*}; want=${spec#*:}
    r=$(node tools/webtest/webtest.mjs "$ex" "$want" 2>&1 | head -3)
    echo "$r" | sed 's/^/- /' >> $REPORT
    echo "$r" | grep -q PASS || fail=1
    echo "$r" | grep -q FAIL && fail=1
    echo "$r" | grep -q 'page errors' && fail=1
  done
  r=$(node tools/webtest/levels.mjs 2>&1 | grep '^\[levels\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  # The last line must be the summary; if a script dies midway the last line is a single item's PASS, which does not count
  echo "$r" | tail -1 | grep -q '^\[levels\] PASS (' || { echo "- [levels] script did not finish" >> $REPORT; fail=1; }
  r=$(node tools/webtest/replay.mjs 2>&1 | grep '^\[replay\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  # Same rule: only the summary line ("[replay] PASS (...") counts
  echo "$r" | tail -1 | grep -q '^\[replay\] PASS (' || { echo "- [replay] script did not finish" >> $REPORT; fail=1; }
  # Real-network toggle (C-03): a local proxy stands in for the internet; replies go into the input log,
  # CLI --inputs replays them byte for byte, and rewinding stays offline
  r=$(node tools/webtest/realnet.mjs 2>&1 | grep '^\[realnet\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[realnet\] PASS (' || { echo "- [realnet] script did not finish" >> $REPORT; fail=1; }
  # Network faults (D-01): presets and scheduled faults run in the core; the web input log replays on the CLI
  r=$(node tools/webtest/netfault.mjs 2>&1 | grep '^\[netfault\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[netfault\] PASS (' || { echo "- [netfault] script did not finish" >> $REPORT; fail=1; }
  r=$(node tools/webtest/adc.mjs 2>&1 | grep '^\[adc\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[adc\] PASS (' || { echo "- [adc] script did not finish" >> $REPORT; fail=1; }
  r=$(node tools/webtest/vcd.mjs 2>&1 | grep '^\[vcd\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[vcd\] PASS (' || { echo "- [vcd] script did not finish" >> $REPORT; fail=1; }
  r=$(node tools/webtest/elec.mjs 2>&1 | grep '^\[elec\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[elec\] PASS (' || { echo "- [elec] script did not finish" >> $REPORT; fail=1; }
  r=$(node tools/webtest/interact.mjs 2>&1 | grep '^\[interact\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  # Same rule: only the summary line ("[interact] PASS (...") counts
  echo "$r" | tail -1 | grep -q '^\[interact\] PASS (' || { echo "- [interact] script did not finish" >> $REPORT; fail=1; }
  # 3D assembly (P1-07) + parametric case export (P1-08): real mouse drags, recheck ✗ / ✓, explode / section / ruler,
  # STL / 3MF download and read-back, SVG fallback
  r=$(node tools/webtest/asm3d.mjs 2>&1 | grep '^\[asm3d\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[asm3d\] PASS (' || fail=1
  # Logic analyzer events (P1-05): live web events = CLI --trace-io replay, line by line, also after rewinding
  r=$(node tools/webtest/traceio.mjs 2>&1 | grep '^\[traceio\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[traceio\] PASS (' || { echo "- [traceio] script did not finish" >> $REPORT; fail=1; }
  # Photo / 10 s recording (P2-10): PNG is 2x the canvas, webm video track = canvas, Opus track when sound is on
  r=$(node tools/webtest/media.mjs 2>&1 | grep '^\[media\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[media\] PASS (' || { echo "- [media] script did not finish" >> $REPORT; fail=1; }
  # Harness (P2-11): wire length -> W6 + drifting readings / NACK, metal near antenna -> RSSI; USB keypad (P2-12) home -> typing
  r=$(node tools/webtest/harness.mjs 2>&1 | grep '^\[harness\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[harness\] PASS (' || { echo "- [harness] script did not finish" >> $REPORT; fail=1; }
  # IMU / touch (P2-02 / P2-03): real mouse drags the IMU and taps the round LCD; readings match CLI --inputs replay
  r=$(node tools/webtest/sense.mjs 2>&1 | grep '^\[sense\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[sense\] PASS (' || { echo "- [sense] script did not finish" >> $REPORT; fail=1; }
  # AMOLED all-in-one board (E-03): CO5300 480×480 picture, square-screen taps, battery / USB / PWR; CLI --inputs replay
  r=$(node tools/webtest/amoled.mjs 2>&1 | grep '^\[amoled\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[amoled\] PASS (' || { echo "- [amoled] script did not finish" >> $REPORT; fail=1; }
  r=$(node tools/webtest/editor.mjs 2>&1 | tail -1)
  echo "- Part editor (blink example, upload bme280 firmware + place BME280 from the catalog): $r" >> $REPORT
  echo "$r" | grep -q PASS || fail=1
  # Bench rewiring (U-04): pin rings, wrong-wire cards, undo / redo, rewiring does not interrupt the simulation
  r=$(node tools/webtest/wiremode.mjs 2>&1 | grep '^\[wiremode\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[wiremode\] PASS (' || { echo "- [wiremode] script did not finish" >> $REPORT; fail=1; }
  # Phone layout (U-05): 390×844 four steps without horizontal scroll, big tappable controls, drawers, rewire loupe, device keys
  r=$(node tools/webtest/mobile.mjs 2>&1 | grep '^\[mobile\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[mobile\] PASS (' || { echo "- [mobile] script did not finish" >> $REPORT; fail=1; }
  # Dock code tab (P2-15): examples show source (app_main), an uploaded .bin says there is no source, works on phones
  r=$(node tools/webtest/code.mjs 2>&1 | grep '^\[code\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[code\] PASS (' || { echo "- [code] script did not finish" >> $REPORT; fail=1; }
  # Place parts on the bench (P2-16): LED from the catalog -> wire it -> blink really follows the GPIO, CLI parity
  r=$(node tools/webtest/place.mjs 2>&1 | grep '^\[place\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[place\] PASS (' || { echo "- [place] script did not finish" >> $REPORT; fail=1; }
  # Board-picker projects (U-17): generated checkpoints match fixtures; c3-thermo / hello verdict and fingerprint web = check.py
  r=$(node tools/webtest/custom.mjs 2>&1 | grep '^\[custom\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[custom\] PASS (' || { echo "- [custom] script did not finish" >> $REPORT; fail=1; }
  # Board picker v3 (U-14–U-16, U-18): three questions, part add / remove, confidence icons, brief, share link
  r=$(node tools/webtest/selectv3.mjs 2>&1 | grep '^\[selectv3\]')
  echo "$r" | sed 's/^/- /' >> $REPORT
  echo "$r" | tail -1 | grep -q '^\[selectv3\] PASS (0 failed)' || { echo "- [selectv3] script did not finish" >> $REPORT; fail=1; }
fi
echo -e "\nVerdict: $([ $fail = 0 ] && echo 'all passed' || echo 'some items failed')" >> $REPORT
cat $REPORT
exit $fail
