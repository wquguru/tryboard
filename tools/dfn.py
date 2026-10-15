#!/usr/bin/env python3
"""从 objdump 反汇编文本里取出指定函数：tools/dfn.py <反汇编.txt> 函数名...
函数名可带 * 通配。只打印指令行（去掉地址前的空白），便于阅读。"""
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
