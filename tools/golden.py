#!/usr/bin/env python3
"""Golden snapshot of every acceptance case (R-02): stdout + stderr of `tryboard run`, byte-compared.

Usage: tools/golden.py save | check [ids...]   (snapshots in Reviews/golden/, report on stdout)
Wall-clock lines are dropped from stderr; everything else (serial, traces, fingerprints) must match exactly.
"""
import hashlib, json, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = f'{ROOT}/core/target/release/tryboard'
DIR = f'{ROOT}/Reviews/golden'
# Host timing varies run to run; strip only the wall-time parts.
WALL = re.compile(r'wall [\d.]+ ?s|[\d.]+ MIPS|[\d.]+x real ?time|took [\d.]+ ?ms \(host\)')


def cmd_of(t):
    fw = f"{ROOT}/firmware/build/{t.get('fw', t['id'])}/flash.bin"
    c = [BIN, 'run', fw, '--seconds', str(t['seconds']), '--gpio-log'] + t.get('args', [])
    if t.get('script'): c += ['--script', t['script']]
    if t.get('pwm'): c += ['--pwm-log', str(t['pwm']['pin'])]
    if t.get('ws2812'): c += ['--ws2812-log']
    return fw, c


def run(t):
    fw, c = cmd_of(t)
    if not os.path.exists(fw):
        return t['id'], None
    p = subprocess.run(c, capture_output=True, cwd=ROOT)
    err = WALL.sub('<wall>', p.stderr.decode('utf-8', 'replace'))
    return t['id'], p.stdout.decode('utf-8', 'replace') + '\n--stderr--\n' + err + f'\n--exit {p.returncode}--\n'


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'check'
    only = set(sys.argv[2:])
    cases = [t for t in json.load(open(f'{ROOT}/firmware/accept.json')) if not only or t['id'] in only]
    os.makedirs(DIR, exist_ok=True)
    with ThreadPoolExecutor(max(2, (os.cpu_count() or 4) - 2)) as ex:
        results = list(ex.map(run, cases))
    bad = 0
    for cid, text in results:
        path = f'{DIR}/{cid}.txt'
        if text is None:
            print(f'{cid}: not built'); bad += 1; continue
        if mode == 'save':
            open(path, 'w', newline='').write(text); continue
        if not os.path.exists(path):
            print(f'{cid}: no snapshot'); bad += 1; continue
        old = open(path, newline='').read()
        if old != text:
            bad += 1
            a, b = old.split('\n'), text.split('\n')
            i = next((k for k in range(min(len(a), len(b))) if a[k] != b[k]), min(len(a), len(b)))
            print(f'{cid}: DIFF at line {i + 1}\n  was: {a[i][:160] if i < len(a) else "<eof>"}\n  now: {b[i][:160] if i < len(b) else "<eof>"}')
    n = len(results)
    if mode == 'save':
        h = hashlib.sha256(''.join(t or '' for _, t in results).encode()).hexdigest()[:12]
        print(f'[golden] saved {n} cases, digest {h}')
    else:
        print(f'[golden] {n - bad}/{n} identical')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
