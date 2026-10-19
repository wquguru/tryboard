#!/usr/bin/env python3
"""把检查点参考固件的源码打成可直接 `idf.py build` 的包 web/public/fw/<id>/src.zip（U-22，实验台「下载源码」）。

文件收集复用 gen_fw_src.idf_paths（与「代码」页签同一份清单），再补工程顶层 CMakeLists.txt 和
main/idf_component.yml。zip 内保持 firmware/ 下的相对布局（<id>/…、common/…、跨工程 SRCS 指到的
别的工程源文件），原有的相对 include 和 SRCS 不用改就能编译。组件（gc9a01、led_strip 等）由组件管理器
按 idf_component.yml 下载，不随包分发；build/、sdkconfig、managed_components 不进包。
日期戳固定，同样的源码打出同样的字节。
用法：tools/gen_fw_zip.py <仓库根> [id...]（不给 id：levels.json 里全部 ref + 选板作品演示固件）
"""
import json
import os
import sys
import zipfile

sys.dont_write_bytecode = True  # 不在 tools/ 下留 __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_fw_src import idf_paths, rel  # noqa: E402

# 选板作品的演示固件（web/src/app/custom.ts 里 plan.demo 的取值），不在 levels.json 里
DEMOS = ['c3-thermo']
STAMP = (1980, 1, 1, 0, 0, 0)
MAX_BYTES = 400_000


def target_of(root, fid):
    """与 tools/build_fw.sh 相同：取 sdkconfig.defaults 的 CONFIG_IDF_TARGET，缺省 esp32c3。"""
    p = os.path.join(root, 'firmware', fid, 'sdkconfig.defaults')
    if os.path.isfile(p):
        for line in open(p, encoding='utf-8'):
            line = line.strip()
            if line.startswith('CONFIG_IDF_TARGET="'):
                return line.split('"')[1]
    return 'esp32c3'


def checkpoints(root):
    """ref → 用到它的检查点 id（检查点 07 的分支写成 07-spin，与 check 命令一致）。"""
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
        'TryBoard 试板的参考固件源码。环境：ESP-IDF v5.5.1。',
        '',
        '## 编译、烧录',
        '',
        '```sh',
        f'cd {fid}',
        f'idf.py set-target {target}',
        'idf.py build flash monitor',
        '```',
        '',
        f'目录布局与仓库 firmware/ 相同：工程在 `{fid}/`，共用的头文件在 `common/`，'
        '与别的工程共用的源文件放在原来的相对路径上。CMakeLists.txt 里的相对路径不用改。',
        '`main/idf_component.yml` 里列的组件第一次编译时由组件管理器联网下载（需要网络）。',
        '',
        '## 在模拟器里验收',
        '',
    ]
    if levels:
        lines += ['```sh'] + [f'npx tryboard check build/{fid}.bin --level {lv}' for lv in levels] + ['```']
    else:
        lines += ['这是选板作品的演示固件，没有固定的检查点；在实验台「导出检查点」后用：', '',
                  '```sh', f'npx tryboard check build/{fid}.bin --level-json checkpoints.json', '```']
    lines += ['', '`npx tryboard` 目前是本地包，尚未发布到 npm。', '']
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
        assert not n.startswith('../'), f'{fid}: {n} 不在 firmware/ 下'
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
        print('源码包太大，不发布:', fid, size)
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
            print('没有源码包:', fid)
            continue
        print(f'  {fid}/src.zip {size} bytes')
        n += 1
    print('源码包', n, '份')


if __name__ == '__main__':
    main()
