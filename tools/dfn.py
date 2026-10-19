#!/usr/bin/env python3
"""Extract functions from objdump disassembly text: tools/dfn.py <disasm.txt> name...
Names may use * wildcards. Prints only those functions' lines, for easier reading."""
import fnmatch
import re
import sys

text = open(sys.argv[1]).read().split('\n')
pats = sys.argv[2:]
head = re.compile(r'^([0-9a-f]+) <([^>]+)>:$')
out, on = [], False
for line in text:
    m = head.match(line)
    if m:
        on = any(fnmatch.fnmatch(m.group(2), p) for p in pats)
        if on:
            out.append(line)
        continue
    if on and line.strip():
        out.append(line.rstrip())
print('\n'.join(out))
