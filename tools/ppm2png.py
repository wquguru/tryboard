#!/usr/bin/env python3
"""Convert a P6 PPM (output of tryboard run --lcd-ppm) to PNG with the standard library only. Usage: tools/ppm2png.py in.ppm out.png [scale]"""
import struct
import sys
import zlib


def read_ppm(path):
    data = open(path, 'rb').read()
    # Header: P6 width height maxval, whitespace-separated
    parts, pos = [], 0
    while len(parts) < 4:
        while data[pos:pos + 1].isspace():
            pos += 1
        start = pos
        while not data[pos:pos + 1].isspace():
            pos += 1
        parts.append(data[start:pos])
    pos += 1
    assert parts[0] == b'P6', 'only P6 is supported'
    w, h = int(parts[1]), int(parts[2])
    return w, h, data[pos:pos + w * h * 3]


def write_png(path, w, h, rgb, scale=1):
    rows = []
    for y in range(h):
        line = rgb[y * w * 3:(y + 1) * w * 3]
        if scale > 1:
            line = b''.join(line[i:i + 3] * scale for i in range(0, len(line), 3))
        rows.extend([b'\x00' + line] * scale)
    raw = b''.join(rows)

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w * scale, h * scale, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)


if __name__ == '__main__':
    w, h, px = read_ppm(sys.argv[1])
    write_png(sys.argv[2], w, h, px, int(sys.argv[3]) if len(sys.argv) > 3 else 1)
