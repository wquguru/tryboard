#!/usr/bin/env python3
"""把 web/dist 打包成 Artifact 可发布的目录：工作台 app.html 当主页（旧 index.html 只是跳转页）、去掉文档骨架、加侧边安全区、二进制转 base64 文本。
用法：python3 tools/pack_artifact.py <输出目录>；打印 files 映射 JSON（发布时传给 Artifact 工具）。"""
import base64, json, os, re, shutil, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dist = os.path.join(root, 'web/dist')
out = sys.argv[1]
shutil.rmtree(out, ignore_errors=True)
shutil.copytree(dist, out)

s = open(os.path.join(out, 'app.html')).read()
os.remove(os.path.join(out, 'app.html'))
head = re.search(r'<head>(.*?)</head>', s, re.S).group(1)
m = re.search(r'<body([^>]*)>(.*?)</body>', s, re.S)
battrs, body = m.group(1), m.group(2)
head = re.sub(r'<meta charset[^>]*>\s*', '', head)
head = re.sub(r'<meta name="viewport"[^>]*>\s*', '', head)
head = head.replace('<title>', '<meta name="claude:viewport-fit-sides" content="cover" />\n<meta name="tryboard-pack" content="b64" />\n<title>', 1)
extra = '''<style>
  html, body { height: 100%; }
  #root {
    padding-left: env(safe-area-inset-left, 0px);
    padding-right: env(safe-area-inset-right, 0px);
    box-sizing: border-box;
  }
</style>'''
# 发布时 body 标签会被重写，工作台靠 body 的 class / data-step 排版，所以用脚本补回去
attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', battrs))
fix = '<script>' + ''.join(f'document.body.setAttribute({json.dumps(k)},{json.dumps(v)});' for k, v in attrs.items()) + '</script>'
open(os.path.join(out, 'index.html'), 'w').write(head.strip() + '\n' + extra + '\n' + fix + '\n' + body.strip() + '\n')

files = {}
for dp, _, fns in os.walk(out):
    for fn in fns:
        full = os.path.join(dp, fn)
        rel = os.path.relpath(full, out)
        if rel == 'index.html':
            continue
        if fn.endswith(('.bin', '.elf')):
            data = open(full, 'rb').read()
            if fn.endswith('.bin'):
                # 合并镜像常被补齐到整片 flash 大小，尾部全是 0xFF；模拟器加载时会自动补齐
                data = data.rstrip(b'\xff')
            os.remove(full)
            full += '.b64.txt'
            rel += '.b64.txt'
            open(full, 'w').write(base64.b64encode(data).decode())
        files[rel] = rel
print(json.dumps(files, ensure_ascii=False))
