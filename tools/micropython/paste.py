#!/usr/bin/env python3
"""Turn a file into a `tryboard run --script` body that writes it to a MicroPython board as main.py (F-07a).

Usage: tools/micropython/paste.py <file> [--start s] [--gap s]   -> script on stdout, expected lines on stderr
Flow: one 195-byte REPL line (more than a FIFO in a single push) -> Ctrl-C x2 -> Ctrl-A raw REPL -> Ctrl-E A Ctrl-A raw-paste -> 128-byte windows -> Ctrl-D -> Ctrl-B -> Ctrl-D soft reset.
Timed sends, not a prompt-driven state machine: the gap per window is far more than the board needs to drain it.
"""
import sys

WINDOW = 128  # raw-paste window the v1.29 firmware advertises (R\x01 + 0x0080)


def esc(chunk: bytes) -> str:
    # The script splits on ';' and newlines and trims each action, so those and edge spaces travel as \xNN
    out = []
    for i, c in enumerate(chunk):
        edge = i == 0 or i == len(chunk) - 1
        if c == 0x0A:
            out.append('\\n')
        elif c in (0x5C, 0x3B, 0x23) or c < 0x20 or c > 0x7E or (c == 0x20 and edge):
            out.append(f'\\x{c:02x}')
        else:
            out.append(chr(c))
    return ''.join(out)


def digest(text: str) -> int:
    h = 0
    for c in text:
        h = (h * 31 + ord(c)) & 0xFFFFFFFF
    return h


def script(src: str, start: float, gap: float) -> str:
    assert "'''" not in src and '\\' not in src, 'keep the file free of backslashes and triple quotes'
    prog = f"open('main.py','w').write('''{src}''')\n".encode()
    probe = 'x' * 170
    steps = [f"print('mpy line', len('{probe}'))\\n", r'\x03\x03', r'\x01', r'\x05A\x01']
    steps += [esc(prog[i:i + WINDOW]) for i in range(0, len(prog), WINDOW)]
    steps += [r'\x04', r'\x02', r'\x04']
    return '; '.join(f'{start + k * gap:.2f}:uart={s}' for k, s in enumerate(steps))


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    opt = lambda k, d: float(a[a.index(k) + 1]) if k in a else d
    src = open(a[0], encoding='utf-8').read()
    print(script(src, opt('--start', 1.5), opt('--gap', 0.1)))
    print('mpy line 170', file=sys.stderr)
    print(f'mpy self {len(src)} {digest(src)}', file=sys.stderr)


if __name__ == '__main__':
    main()
