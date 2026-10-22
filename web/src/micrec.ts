// Live-mic recording for exact CLI replay (F-09c): chunks are quantized to 16 bit before the core hears them, and kept at
// the sample index the core placed them on (simulated-time grid), so a 16-bit WAV of them is what `--mic` reads back.

/** Round to 16-bit PCM; `f` holds the same values as floats (q / 32768, exact in f32, as the CLI's WAV parser makes them) */
export function quantize(x: Float32Array): { q: Int16Array; f: Float32Array } {
  const q = new Int16Array(x.length);
  const f = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768)));
    q[i] = v;
    f[i] = v / 32768;
  }
  return { q, f };
}

/** Longest live recording kept (simulated seconds of audio); later chunks still play but the export is refused */
export const MIC_REC_MAX_S = 600;

export class MicRecord {
  rate = 0;
  chunks: [start: number, q: Int16Array][] = [];
  full = false;
  private samples = 0;

  clear() {
    this.rate = 0;
    this.chunks = [];
    this.full = false;
    this.samples = 0;
  }

  /** A chunk the core placed at `start`: anything recorded at or after it was never heard (the core only appends) */
  add(start: number, rate: number, q: Int16Array) {
    if (rate !== this.rate) this.clear();
    this.rate = rate;
    if (this.full) return;
    while (this.chunks.length && this.chunks[this.chunks.length - 1][0] >= start) this.samples -= this.chunks.pop()![1].length;
    const last = this.chunks[this.chunks.length - 1];
    if (last && last[0] + last[1].length > start) {
      const keep = last[1].subarray(0, start - last[0]);
      this.samples -= last[1].length - keep.length;
      last[1] = keep;
    }
    if (this.samples + q.length > MIC_REC_MAX_S * rate) {
      this.full = true;
      return;
    }
    this.chunks.push([start, q]);
    this.samples += q.length;
  }

  /** Samples held (for "is there anything to export") */
  get length() {
    return this.samples;
  }

  /** 16-bit mono WAV covering index 0 .. max(end, until): zeros where the mic heard nothing live */
  wav(until: number): ArrayBuffer {
    const last = this.chunks[this.chunks.length - 1];
    const n = Math.max(last ? last[0] + last[1].length : 0, Math.ceil(until)) + 1;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    tag(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, this.rate, true);
    v.setUint32(28, this.rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    tag(36, 'data');
    v.setUint32(40, n * 2, true);
    const pcm = new Int16Array(buf, 44, n);
    for (const [s, q] of this.chunks) pcm.set(q, s);
    return buf;
  }
}
