#!/usr/bin/env python3
"""把 web/dist 打包成 Artifact 可发布的目录：去掉文档骨架、加侧边安全区、二进制转 base64 文本。
用法：python3 tools/pack_artifact.py <输出目录>；打印 files 映射 JSON（发布时传给 Artifact 工具）。"""
import base64, json, os, re, shutil, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dist = os.path.join(root, 'web/dist')
out = sys.argv[1]
shutil.rmtree(out, ignore_errors=True)
shutil.copytree(dist, out)

s = open(os.path.join(out, 'index.html')).read()
head = re.search(r'<head>(.*?)</head>', s, re.S).group(1)
body = re.search(r'<body>(.*?)</body>', s, re.S).group(1)
head = re.sub(r'<meta charset[^>]*>\s*', '', head)
head = re.sub(r'<meta name="viewport"[^>]*>\s*', '', head)
head = head.replace('<title>', '<meta name="claude:viewport-fit-sides" content="cover" />\n<meta name="tryboard-pack" content="b64" />\n<title>', 1)
extra = '''<style>
  html, body { height: 100%; }
  .bar, footer, .panel-head, #console, #uartIn, .info #about, #controls, #editor {
    padding-left: max(16px, env(safe-area-inset-left, 0px)) !important;
    padding-right: max(16px, env(safe-area-inset-right, 0px)) !important;
  }
  :root { color-scheme: dark; }
  body { background: var(--bg); }
</style>'''
open(os.path.join(out, 'index.html'), 'w').write(head.strip() + '\n' + extra + '\n' + body.strip() + '\n')

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
