#!/usr/bin/env python3
"""把已发布固件的源码打包成 web/public/fw/<id>/src.json（P2-15，实验台底部坞「代码」页签只读显示）。

每个固件一个文件、网页按需 fetch，不进首包。收集：main/*.c *.h、main/CMakeLists.txt 里 SRCS 指到别的
工程的源文件（s3-* 复用 C3 版源码）、双引号 #include 能在 main/、INCLUDE_DIRS、firmware/common 找到的头
文件（系统头、IDF 组件头找不到就跳过），再加 main/CMakeLists.txt 和 sdkconfig.defaults（引脚宏、STAGE 常在这里）。
Arduino 示例（arduino-<名>）取 firmware/arduino/<名>/*.ino。
用法：tools/gen_fw_src.py <仓库根> <id>...
"""
import json
import os
import re
import sys

MAX_BYTES = 400_000  # 单个固件源码上限：超了说明误收了大文件，宁可不发也不撑大下载


def rel(root, p):
    return os.path.relpath(p, os.path.join(root, 'firmware')).replace(os.sep, '/')


def collect_idf(root, fid):
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
    # main/ 里自己的 .c / .h 也算（有的工程 SRCS 只列了一个，头文件靠 include 找）
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
    # .c 在前（app_main 所在），头文件其次，构建配置最后
    files.sort(key=lambda p: (not p.endswith('.c'), p not in srcs, rel(root, p)))
    extra = [cm, os.path.join(proj, 'sdkconfig.defaults')]
    out = []
    for p in files + [x for x in extra if os.path.isfile(x)]:
        out.append({'path': rel(root, p), 'text': open(p, encoding='utf-8', errors='replace').read()})
    # 引脚 / 阶段宏在 CMake 里定义（与 C3 版共用源码时只覆盖引脚），单独摘出来放在页签顶上
    defs = re.findall(r'target_compile_definitions\([^)]*PRIVATE\s+([^)]+)\)', cmake)
    return {'files': out, 'defines': ' '.join(' '.join(defs).split())}


def collect_arduino(root, fid):
    d = os.path.join(root, 'firmware', 'arduino', fid[len('arduino-'):])
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
            print('没有源码:', fid)
            continue
        body = json.dumps({'id': fid, **src}, ensure_ascii=False)
        if len(body.encode()) > MAX_BYTES:
            print('源码太大，不发布:', fid, len(body.encode()))
            continue
        d = os.path.join(root, 'web/public/fw', fid)
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, 'src.json'), 'w', encoding='utf-8').write(body)
        n += 1
    print('源码', n, '份')


if __name__ == '__main__':
    main()
