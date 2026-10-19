#!/usr/bin/env python3
"""Gzip size of a page's first-screen static closure (R-12): entry scripts, modulepreloads, static imports.

Usage: python3 tools/webtest/closure.py [--dist web/dist] [--page app.html] [--top 15]
"""
import argparse
import gzip
import os
import re


def closure(dist, page):
    t = open(os.path.join(dist, page)).read()
    refs = set(re.findall(r'(?:src|href)="\./(assets/[^"]+\.(?:js|css))"', t))
    seen = {}

    def walk(f):
        if f in seen:
            return
        b = open(os.path.join(dist, f), 'rb').read()
        seen[f] = len(gzip.compress(b))
        # Static imports only: `import("./x.js")` has a paren, so it does not match.
        for r in re.findall(r'(?:from|import)\s*"\./([^"]+\.js)"', b.decode('utf8', 'replace')):
            if os.path.exists(os.path.join(dist, 'assets', r)):
                walk('assets/' + r)

    for r in sorted(refs):
        walk(r)
    return seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dist', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../web/dist'))
    ap.add_argument('--page', default='app.html')
    ap.add_argument('--top', type=int, default=15)
    a = ap.parse_args()
    seen = closure(a.dist, a.page)
    for f, n in sorted(seen.items(), key=lambda kv: -kv[1])[: a.top]:
        print(f'{n / 1000:8.1f} KB  {f}')
    print(f'{sum(seen.values()) / 1000:8.1f} KB  total ({len(seen)} files, {a.page})')


if __name__ == '__main__':
    main()
