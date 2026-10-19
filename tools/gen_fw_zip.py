#!/usr/bin/env python3
"""Pack checkpoint reference firmware sources into web/public/fw/<id>/src.zip, ready for `idf.py build` (U-22, lab "Download source").

Files come from gen_fw_src.idf_paths (same list as the "Code" tab), plus the project's top-level CMakeLists.txt and
main/idf_component.yml. The zip keeps the layout under firmware/ (<id>/..., common/..., other projects' sources that
SRCS points to), so existing relative includes and SRCS compile unchanged. Components (gc9a01, led_strip, ...) are
downloaded by the component manager from idf_component.yml, not shipped; build/, sdkconfig, managed_components are left out.
Timestamps are fixed so the same sources produce the same bytes.
Usage: tools/gen_fw_zip.py <repo root> [id...]  (no id: every ref in levels.json + the custom-build demo firmware)
"""
import json
import os
import sys
import zipfile

sys.dont_write_bytecode = True  # keep tools/ free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_fw_src import idf_paths, rel  # noqa: E402

# Custom-build demo firmware (plan.demo values in web/src/app/custom.ts); not listed in levels.json
DEMOS = ['c3-thermo']
STAMP = (1980, 1, 1, 0, 0, 0)
MAX_BYTES = 400_000


def target_of(root, fid):
    """Same as tools/build_fw.sh: CONFIG_IDF_TARGET from sdkconfig.defaults, default esp32c3."""
    p = os.path.join(root, 'firmware', fid, 'sdkconfig.defaults')
    if os.path.isfile(p):
        for line in open(p, encoding='utf-8'):
            line = line.strip()
            if line.startswith('CONFIG_IDF_TARGET="'):
                return line.split('"')[1]
    return 'esp32c3'


def checkpoints(root):
    """ref -> checkpoint ids using it (checkpoint 07's variants are written 07-spin, matching the check command)."""
    out = {}
    for lv in json.load(open(os.path.join(root, 'firmware/levels.json'), encoding='utf-8')):
        if lv.get('ref'):
            out.setdefault(lv['ref'], []).append(lv['id'])
        for v in lv.get('variants', []):
            if v.get('ref'):
                out.setdefault(v['ref'], []).append(f"{lv['id']}-{v['key']}")
    return out


def readme(fid, target, levels):
    lines = [
        f'# {fid}',
        '',
        'TryBoard reference firmware source. Environment: ESP-IDF v5.5.1.',
        '',
        '## Build and flash',
        '',
        '```sh',
        f'cd {fid}',
        f'idf.py set-target {target}',
        'idf.py build flash monitor',
        '```',
        '',
        f'The layout matches the repo\'s firmware/ directory: the project is in `{fid}/`, shared headers in `common/`, '
        'and source files shared with other projects keep their original relative paths, so CMakeLists.txt needs no changes.',
        'Components listed in `main/idf_component.yml` are downloaded by the component manager on the first build (needs network).',
        '',
        '## Check it in the simulator',
        '',
    ]
    if levels:
        lines += ['```sh'] + [f'npx tryboard check build/{fid}.bin --level {lv}' for lv in levels] + ['```']
    else:
        lines += ['This is the demo firmware of a custom build and has no fixed checkpoints; use "Export checkpoints" in the lab, then:', '',
                  '```sh', f'npx tryboard check build/{fid}.bin --level-json checkpoints.json', '```']
    lines += ['', '`npx tryboard` is a local package for now and is not published to npm yet.', '']
    return '\n'.join(lines)


def build_zip(root, fid, levels):
    got = idf_paths(root, fid)
    if not got:
        return None
    proj = os.path.join(root, 'firmware', fid)
    paths = list(got[0])
    for p in (os.path.join(proj, 'CMakeLists.txt'), os.path.join(proj, 'main', 'idf_component.yml')):
        if os.path.isfile(p) and p not in paths:
            paths.append(p)
    names = sorted({rel(root, p): p for p in paths}.items())
    for n, _ in names:
        assert not n.startswith('../'), f'{fid}: {n} is outside firmware/'
    d = os.path.join(root, 'web/public/fw', fid)
    os.makedirs(d, exist_ok=True)
    out = os.path.join(d, 'src.zip')
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        def put(name, data):
            info = zipfile.ZipInfo(name, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, data)
        put('README.md', readme(fid, target_of(root, fid), levels).encode())
        for n, p in names:
            put(n, open(p, 'rb').read())
    size = os.path.getsize(out)
    if size > MAX_BYTES:
        os.remove(out)
        print('source zip too large, not published:', fid, size)
        return None
    return size


def main():
    root = sys.argv[1]
    cps = checkpoints(root)
    ids = sys.argv[2:] or [*cps, *[x for x in DEMOS if x not in cps]]
    n = 0
    for fid in ids:
        size = build_zip(root, fid, cps.get(fid, []))
        if size is None:
            print('no source zip:', fid)
            continue
        print(f'  {fid}/src.zip {size} bytes')
        n += 1
    print('source zips:', n)


if __name__ == '__main__':
    main()
