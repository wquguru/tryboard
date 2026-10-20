#!/usr/bin/env python3
"""Bundle published firmware sources into web/public/fw/<id>/src.json (P2-15, read-only "Code" tab in the lab's bottom dock).

One file per firmware, fetched on demand, not part of the first load. Collected: main/*.c *.h, sources of other
projects that main/CMakeLists.txt SRCS points to (s3-* reuse the C3 sources), double-quoted #include headers found in
main/, INCLUDE_DIRS or firmware/common (system / IDF component headers are skipped), plus main/CMakeLists.txt and
sdkconfig.defaults (pin macros and STAGE often live there). Arduino examples (arduino-<name>) take firmware/arduino/<name>/*.ino.
Usage: tools/gen_fw_src.py <repo root> <id>...
"""
import json
import os
import re
import sys

MAX_BYTES = 400_000  # per-firmware cap: exceeding it means a large file slipped in; better not to publish than bloat downloads


def rel(root, p):
    return os.path.relpath(p, os.path.join(root, 'firmware')).replace(os.sep, '/')


def idf_paths(root, fid):
    """Files of an IDF project to show / pack (absolute, sorted) and the main/CMakeLists.txt text; gen_fw_zip.py uses it too."""
    proj = os.path.join(root, 'firmware', fid)
    main = os.path.join(proj, 'main')
    cm = os.path.join(main, 'CMakeLists.txt')
    if not os.path.isfile(cm):
        return None
    cmake = open(cm, encoding='utf-8').read()
    srcs, incs = [], [main]
    m = re.search(r'SRCS((?:\s+"[^"]+")+)', cmake)
    if m:
        srcs = [os.path.normpath(os.path.join(main, s)) for s in re.findall(r'"([^"]+)"', m.group(1))]
    m = re.search(r'INCLUDE_DIRS((?:\s+"[^"]+")+)', cmake)
    if m:
        incs += [os.path.normpath(os.path.join(main, s)) for s in re.findall(r'"([^"]+)"', m.group(1))]
    incs.append(os.path.join(root, 'firmware', 'common'))
    # main/'s own .c / .h count too (some projects list one SRCS entry and reach headers via include)
    own = sorted(os.path.join(main, f) for f in os.listdir(main) if f.endswith(('.c', '.h')))
    files, seen, queue = [], set(), [*srcs, *own]
    while queue:
        p = queue.pop(0)
        if p in seen or not os.path.isfile(p):
            continue
        seen.add(p)
        text = open(p, encoding='utf-8', errors='replace').read()
        files.append(p)
        here = os.path.dirname(p)
        for h in re.findall(r'^\s*#\s*include\s+"([^"]+)"', text, re.M):
            for d in [here, *incs]:
                q = os.path.normpath(os.path.join(d, h))
                if os.path.isfile(q):
                    queue.append(q)
                    break
    if not files:
        return None
    # .c first (where app_main lives), then headers, build config last
    files.sort(key=lambda p: (not p.endswith('.c'), p not in srcs, rel(root, p)))
    extra = [cm, os.path.join(proj, 'sdkconfig.defaults')]
    return files + [x for x in extra if os.path.isfile(x)], cmake


def collect_idf(root, fid):
    got = idf_paths(root, fid)
    if not got:
        return None
    paths, cmake = got
    out = []
    for p in paths:
        out.append({'path': rel(root, p), 'text': open(p, encoding='utf-8', errors='replace').read()})
    # Pin / stage macros are defined in CMake (variants sharing C3 sources only override pins); show them atop the tab
    defs = re.findall(r'target_compile_definitions\([^)]*PRIVATE\s+([^)]+)\)', cmake)
    return {'files': out, 'defines': ' '.join(' '.join(defs).split())}


def collect_arduino(root, fid):
    d = os.path.join(root, 'firmware', 'arduino', fid[len('arduino-'):])
    # arduino-<name>-<variant> (boards.txt) shares the sketch of arduino-<name>
    if not os.path.isdir(d) and os.path.isfile(os.path.join(d.rsplit('-', 1)[0], 'boards.txt')):
        d = d.rsplit('-', 1)[0]
    if not os.path.isdir(d):
        return None
    files = sorted(f for f in os.listdir(d) if f.endswith(('.ino', '.h', '.cpp', '.c')))
    if not files:
        return None
    return {'files': [{'path': rel(root, os.path.join(d, f)), 'text': open(os.path.join(d, f), encoding='utf-8').read()} for f in files], 'defines': ''}


def main():
    root, ids = sys.argv[1], sys.argv[2:]
    n = 0
    for fid in ids:
        src = collect_arduino(root, fid) if fid.startswith('arduino-') else collect_idf(root, fid)
        if not src:
            print('no source:', fid)
            continue
        body = json.dumps({'id': fid, **src}, ensure_ascii=False)
        if len(body.encode()) > MAX_BYTES:
            print('source too large, not published:', fid, len(body.encode()))
            continue
        d = os.path.join(root, 'web/public/fw', fid)
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, 'src.json'), 'w', encoding='utf-8').write(body)
        n += 1
    print('sources:', n)


if __name__ == '__main__':
    main()
