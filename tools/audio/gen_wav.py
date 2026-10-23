#!/usr/bin/env python3
"""Generate test sounds for acceptance / examples (synthesized by us, no external assets).
Usage: tools/audio/gen_wav.py [output dir]  (default tools/audio/)
- sine1k.wav: 1000 Hz sine, amplitude 0.5 (RMS 0.3536), 48 kHz 16-bit mono, 1 s (whole periods, loops seamlessly)
- sweep.wav: 200 -> 2000 Hz exponential sweep, amplitude 0.5, 48 kHz 16-bit mono, 2 s (10 ms fade in / out)
- saw50.wav: 50 Hz rising sawtooth, -0.5 -> 0.5, 48 kHz 16-bit mono, 1 s (sample order checks, G-12)
"""
import math, os, struct, sys, wave

RATE = 48000

def write(path, xs):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', max(-32768, min(32767, round(x * 32767)))) for x in xs))
    print(path, len(xs), 'samples')

def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    os.makedirs(out, exist_ok=True)
    write(os.path.join(out, 'sine1k.wav'), [0.5 * math.sin(2 * math.pi * 1000 * i / RATE) for i in range(RATE)])
    n, f0, f1 = 2 * RATE, 200.0, 2000.0
    k = math.log(f1 / f0) / (n / RATE)
    fade = int(0.01 * RATE)
    xs = []
    for i in range(n):
        t = i / RATE
        ph = 2 * math.pi * f0 * (math.exp(k * t) - 1) / k
        g = min(1.0, i / fade, (n - 1 - i) / fade)
        xs.append(0.5 * g * math.sin(ph))
    write(os.path.join(out, 'sweep.wav'), xs)
    write(os.path.join(out, 'saw50.wav'), [(i % 960) / 960 - 0.5 for i in range(RATE)])

if __name__ == '__main__':
    main()
