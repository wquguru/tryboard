#!/usr/bin/env python3
"""Pack web/dist into a directory publishable as an Artifact: the lab app.html becomes the home page (replacing the landing index.html), the document skeleton is stripped, side safe areas added, binaries turned into base64 text.
Usage: python3 tools/pack_artifact.py <output dir>; prints the files-mapping JSON (pass it to the Artifact tool when publishing)."""
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
# Publishing rewrites the body tag, and the lab lays out by body class / data-step, so a script restores them
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
        if fn.endswith(('.bin.gz', '.elf.gz', '.wasm.gz')):
            # R-18 gzip sidecars are binary too; packed pages skip them and read .b64.txt / plain wasm
            os.remove(full)
            continue
        if fn.endswith(('.bin', '.elf')):
            data = open(full, 'rb').read()
            if fn.endswith('.bin'):
                # Merged images are often padded to full flash size with 0xFF; the simulator pads again on load
                data = data.rstrip(b'\xff')
            os.remove(full)
            full += '.b64.txt'
            rel += '.b64.txt'
            open(full, 'w').write(base64.b64encode(data).decode())
        files[rel] = rel
print(json.dumps(files, ensure_ascii=False))
