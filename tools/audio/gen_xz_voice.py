#!/usr/bin/env python3
"""Speech-like test sounds for the voice assistant example (F-09b-1), synthesized here: no recordings, no TTS output.
A glottal pulse train (harmonics with a -12 dB/octave tilt) through three formant resonators, vowel by vowel, with
syllable envelopes. Outputs (16 kHz mono):
- tools/audio/xz_mic.wav: the "user" (pitch ~120 Hz, 1.5 s, loops) for `tryboard run --mic`
- core/crates/soc/src/wifi/xz_voice.bin: the "assistant" (pitch ~210 Hz, 20 x 60 ms) as Opus packets, each prefixed by
  a u16 little-endian length; the virtual xiaozhi server plays it with script action `xz=voice,demo`
Encoder: `opus_demo` built on the host from the libopus inside esphome/micro-opus 0.4.1 (BSD-3, already in LICENSING):
  cp -R firmware/s3-xiaozhi-lite/managed_components/esphome__micro-opus/lib/opus Reviews/xz-opus
  make -C Reviews/xz-opus -f Makefile.unix opus_demo
Usage: tools/audio/gen_xz_voice.py [path to opus_demo]  (default Reviews/xz-opus/opus_demo)
"""
import math, os, struct, subprocess, sys, tempfile, wave

RATE = 16000
FRAME = 960  # 60 ms at 16 kHz
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# (F1, F2, F3) in Hz for a few vowels, textbook adult averages
VOWELS = {
    'a': (730, 1090, 2440),
    'i': (270, 2290, 3010),
    'u': (300, 870, 2240),
    'e': (530, 1840, 2480),
    'o': (570, 840, 2410),
}
BANDWIDTHS = (80, 100, 140)


class Resonator:
    """Two-pole resonator (Klatt style), unity gain at DC"""

    def __init__(self):
        self.y1 = self.y2 = 0.0

    def step(self, x, f, bw):
        c = -math.exp(-2 * math.pi * bw / RATE)
        b = 2 * math.exp(-math.pi * bw / RATE) * math.cos(2 * math.pi * f / RATE)
        a = 1 - b - c
        y = a * x + b * self.y1 + c * self.y2
        self.y2, self.y1 = self.y1, y
        return y


def voice(syllables, f0_start, f0_end, total, rms):
    """syllables: [(vowel, start s, length s)]; pitch glides linearly over the whole clip"""
    out = [0.0] * total
    phase = 0.0
    res = [Resonator() for _ in range(3)]
    for i in range(total):
        t = i / RATE
        f0 = f0_start + (f0_end - f0_start) * i / total
        f0 *= 1 + 0.01 * math.sin(2 * math.pi * 5 * t)
        phase += f0 / RATE
        phase -= math.floor(phase)
        # Harmonics below 4 kHz, amplitude 1/k^2 for the glottal tilt
        src = sum(math.sin(2 * math.pi * k * phase) / (k * k) for k in range(1, int(4000 / f0) + 1))
        env, fs = 0.0, VOWELS['a']
        for k, (v, s, d) in enumerate(syllables):
            if s <= t < s + d:
                u = (t - s) / d
                env = min(1.0, u / 0.12, (1 - u) / 0.25)
                # Glide from the previous vowel over the first 30 % of the syllable
                prev = VOWELS[syllables[k - 1][0]] if k else VOWELS[v]
                g = min(1.0, u / 0.3)
                fs = tuple(p + (q - p) * g for p, q in zip(prev, VOWELS[v]))
        y = src
        for r, f, bw in zip(res, fs, BANDWIDTHS):
            y = r.step(y, f, bw)
        out[i] = env * y
    cur = math.sqrt(sum(x * x for x in out) / total)
    return [x * rms / cur for x in out]


def write_wav(path, xs):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm(xs))
    print(path, len(xs), 'samples', f'rms {math.sqrt(sum(x * x for x in xs) / len(xs)):.4f}')


def pcm(xs):
    return b''.join(struct.pack('<h', max(-32768, min(32767, round(x * 32767)))) for x in xs)


def encode(opus_demo, xs):
    """opus_demo -e output: per packet a big-endian u32 length, a u32 final range, then the payload"""
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, 'in.pcm'), os.path.join(d, 'out.bit')
        open(src, 'wb').write(pcm(xs))
        subprocess.run([opus_demo, '-e', 'voip', str(RATE), '1', '16000', '-framesize', '60', '-complexity', '10',
                        src, dst], check=True, capture_output=True)
        b = open(dst, 'rb').read()
    frames, i = [], 0
    while i < len(b):
        n = struct.unpack('>I', b[i:i + 4])[0]
        frames.append(b[i + 8:i + 8 + n])
        i += 8 + n
    return frames


def main():
    opus_demo = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'Reviews/xz-opus/opus_demo')
    mic = voice([('a', 0.05, 0.25), ('i', 0.35, 0.22), ('o', 0.65, 0.3), ('e', 1.05, 0.3)], 130, 110,
                int(1.5 * RATE), 0.15)
    write_wav(os.path.join(ROOT, 'tools/audio/xz_mic.wav'), mic)
    n = 20 * FRAME
    say = voice([('e', 0.04, 0.2), ('a', 0.27, 0.18), ('i', 0.48, 0.2), ('u', 0.72, 0.16), ('o', 0.92, 0.24)], 230,
                190, n, 0.2)
    frames = encode(opus_demo, say)
    out = os.path.join(ROOT, 'core/crates/soc/src/wifi/xz_voice.bin')
    with open(out, 'wb') as f:
        for p in frames:
            f.write(struct.pack('<H', len(p)) + p)
    tocs = sorted({p[0] >> 3 for p in frames})
    print(out, len(frames), 'Opus frames,', sum(len(p) for p in frames), 'bytes, TOC configs', tocs,
          f'source rms {math.sqrt(sum(x * x for x in say) / n):.4f}')


if __name__ == '__main__':
    main()
