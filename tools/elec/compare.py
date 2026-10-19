#!/usr/bin/env python3
"""Compare the DC/transient solver (tryboard-elec) with ngspice: solve every tools/elec/*.cir both ways, compare all node voltages.

.op compares the operating point; .tran compares 1/4, 1/2 and 1 of the stop time (from uncharged caps, ngspice uses uic).
Error = |ours - ngspice| / max(|ngspice|, 0.1 V); all must be < 2%. Custom parts (USB limit, LDO, load, servo motor) are
written twice: `*tb:` lines for us and equivalent B sources for ngspice (each side ignores the other's).
Usage: tools/elec/compare.py [--md] (--md prints a Markdown table). Without ngspice it prints why and exits 0 (accept.sh skips).
"""
import glob, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CLI = os.path.join(ROOT, 'core/target/release/tryboard')
LIMIT = 0.02


def ours(path, times):
    args = [CLI, 'elec-net', path]
    if times:
        args += ['--at', ','.join(f'{t:g}' for t in times)]
    out = subprocess.run(args, capture_output=True, text=True, check=True).stdout
    res = {}
    for m in re.finditer(r'v\((\S+)\)@(\S+) = (\S+)', out):
        res[(m.group(1), float(m.group(2)))] = float(m.group(3))
    return res


def spice(path, nodes, times, tran):
    text = open(path).read()
    ctl = ['.control', 'set noaskquit']
    if tran:
        st, end = tran
        ctl.append(f'tran {st} {end} 0 {st} uic')
        for i, t in enumerate(times):
            for n in nodes:
                ctl.append(f'meas tran m_{i}_{n} find v({n}) at={t:g}')
    else:
        ctl.append('op')
        for n in nodes:
            ctl.append(f'print v({n})')
    ctl.append('.endc')
    body = re.sub(r'^\.end\s*$', '\n'.join(ctl) + '\n.end', text, flags=re.M)
    with tempfile.NamedTemporaryFile('w', suffix='.cir', delete=False) as f:
        f.write(body)
        tmp = f.name
    try:
        out = subprocess.run(['ngspice', '-b', tmp], capture_output=True, text=True, timeout=120).stdout
    finally:
        os.unlink(tmp)
    res = {}
    if tran:
        for m in re.finditer(r'^m_(\d+)_(\S+)\s*=\s*(\S+)', out, re.M):
            res[(m.group(2), times[int(m.group(1))])] = float(m.group(3))
    else:
        for m in re.finditer(r'^v\((\S+)\)\s*=\s*(\S+)', out, re.M):
            res[(m.group(1), 0.0)] = float(m.group(2))
    return res


def main():
    md = '--md' in sys.argv
    if not shutil.which('ngspice'):
        print('ngspice comparison: skipped (ngspice not installed; brew install ngspice and rerun)')
        return 0
    rows, worst_all, bad = [], 0.0, 0
    for path in sorted(glob.glob(os.path.join(HERE, '*.cir'))):
        name = os.path.basename(path)[:-4]
        text = open(path).read()
        title = text.splitlines()[0].lstrip('* ').strip()
        m = re.search(r'^\.tran\s+(\S+)\s+(\S+)', text, re.M | re.I)
        tran = (m.group(1), m.group(2)) if m else None
        times = []
        if tran:
            end = float(subprocess.run([CLI, 'elec-net', path], capture_output=True, text=True).stdout.split('@')[1].split()[0])
            times = [end / 4, end / 2, end]
        a = ours(path, times)
        nodes = sorted({k[0] for k in a})
        b = spice(path, nodes, times, tran)
        worst, detail = 0.0, ''
        missing = [k for k in a if k not in b]
        for k, va in a.items():
            if k not in b:
                continue
            vb = b[k]
            e = abs(va - vb) / max(abs(vb), 0.1)
            if e >= worst:
                worst, detail = e, f'v({k[0]})@{k[1]:g}s: {va:.5f} / {vb:.5f} V'
        ok = worst < LIMIT and not missing
        bad += not ok
        worst_all = max(worst_all, worst)
        rows.append((name, title, len(a), worst, detail, ok, missing))
    if md:
        print('| Netlist | Circuit | Points | Max error | At max error (ours / ngspice) | Result |')
        print('|---|---|---|---|---|---|')
    for name, title, n, worst, detail, ok, missing in rows:
        if md:
            print(f'| {name} | {title} | {n} | {worst * 100:.4f}% | {detail} | {"✅" if ok else "❌"} |')
        else:
            print(f'{"PASS" if ok else "FAIL"} {name}: {n} points, max error {worst * 100:.4f}% ({detail})' + (f' ngspice missing {missing}' if missing else ''))
    print(f'{"" if not md else chr(10)}ngspice comparison: {len(rows)} circuits, max error {worst_all * 100:.4f}%, {"all < 2%" if not bad else f"{bad} over limit"}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
