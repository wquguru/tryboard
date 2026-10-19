// I2S speaker (MAX98357A): the worker sends PCM blocks with sim time; an AudioWorklet ring buffer addressed by absolute frame plays them.
// Falls back to per-block AudioBufferSourceNode without AudioWorklet; aligned like audio.ts (lead LEAD, re-align outside [0, MAX_LEAD]).

import type { PcmBlock } from './worker';

const LEAD = 0.12;
const MAX_LEAD = 0.6;
/** Speaker volume: even a full-scale sine is not startling. */
const VOLUME = 0.3;
/** Ring buffer length (frames): about 2.7 s at 48 kHz, far longer than MAX_LEAD. */
const RING = 1 << 17;

const WORKLET = `
class TbPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${RING});
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.clear) { this.buf.fill(0); return; }
      const d = m.data;
      for (let i = 0; i < d.length; i++) {
        const f = m.at + i;
        // Skip frames already played or far outside the ring (they would play one lap later).
        if (f < currentFrame || f >= currentFrame + ${RING}) continue;
        this.buf[f & ${RING - 1}] = d[i];
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    for (let i = 0; i < ch0.length; i++) {
      const k = (currentFrame + i) & ${RING - 1};
      ch0[i] = this.buf[k];
      this.buf[k] = 0;
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    return true;
  }
}
registerProcessor('tb-pcm', TbPcm);
`;

/** Readings: remove DC, RMS, zero-crossing pitch (interpolated rising crossings); same algorithm as core devices/audio.rs analyze. */
export function analyze(x: ArrayLike<number>, rate: number): { rms: number; freq: number } {
  const n = x.length;
  if (!n || rate <= 0) return { rms: 0, freq: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let sum = 0;
  let first = -1, last = -1, ups = 0, prev = 0, armed = false;
  for (let i = 0; i < n; i++) {
    const v = x[i] - mean;
    sum += v * v;
    if (v < -1e-4) armed = true;
    if (i > 0 && armed && prev < 0 && v >= 0) {
      const t = i - 1 + prev / (prev - v);
      if (first < 0) first = t;
      last = t;
      ups++;
      armed = false;
    }
    prev = v;
  }
  return { rms: Math.sqrt(sum / n), freq: ups >= 2 && last > first ? ((ups - 1) * rate) / (last - first) : 0 };
}

/** Linear resampling: the first sample lands on fractional frame f0 and covers [ceil(f0), ceil(f0 + duration)), so blocks abut;
 *  rounding per block would leave a 1-frame gap (a click that also adds a zero crossing). */
function resample(src: Int16Array, from: number, to: number, f0: number): { start: number; data: Float32Array } {
  const start = Math.ceil(f0);
  const end = Math.ceil(f0 + (src.length * to) / from);
  const out = new Float32Array(Math.max(0, end - start));
  const step = from / to;
  const last = src.length - 1;
  for (let j = 0; j < out.length; j++) {
    const p = (start + j - f0) * step;
    const i = Math.floor(p);
    const a = src[Math.min(i, last)];
    const b = src[Math.min(i + 1, last)];
    out[j] = ((a + (b - a) * (p - i)) / 32768) * VOLUME;
  }
  return { start, data: out };
}

export interface PcmState {
  /** Sound was scheduled within the last 0.5 s of wall time. */
  playing: boolean;
  /** Blocks scheduled into Web Audio / re-alignments. */
  blocks: number;
  realigns: number;
  /** Pitch and RMS measured at the output (AnalyserNode; full scale = 1, volume divided out). */
  hz: number;
  rms: number;
  /** Playback: worklet / buffer (fallback) / none (sound not on yet). */
  mode: 'worklet' | 'buffer' | 'none';
}

export class PcmVoice {
  readonly state: PcmState = { playing: false, blocks: 0, realigns: 0, hz: 0, rms: 0, mode: 'none' };
  private node: AudioWorkletNode | null = null;
  private gain: GainNode;
  private analyser: AnalyserNode;
  private simAnchor = 0;
  private audioAnchor = -1;
  private lastWall = -Infinity;
  private td: Float32Array<ArrayBuffer> | null = null;

  private ctx: AudioContext;
  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 1;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.gain.connect(this.analyser).connect(ctx.destination);
  }

  /** Screen recording (P2-10): also connect the speaker path to the recorder node. */
  tap(dest: AudioNode) {
    this.analyser.connect(dest);
  }

  static async create(ctx: AudioContext): Promise<PcmVoice> {
    const v = new PcmVoice(ctx);
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      v.node = new AudioWorkletNode(ctx, 'tb-pcm', { numberOfInputs: 0, outputChannelCount: [1] });
      v.node.connect(v.gain);
      v.state.mode = 'worklet';
    } catch {
      v.state.mode = 'buffer';
    }
    return v;
  }

  /** Power cycle / mute: drop scheduled sound. */
  reset() {
    this.audioAnchor = -1;
    this.node?.port.postMessage({ clear: true });
    this.state.playing = false;
  }

  push(blocks: PcmBlock[]) {
    const ctx = this.ctx;
    for (const b of blocks) {
      if (!b.data.length || b.rate <= 0) continue;
      let at = this.audioAnchor < 0 ? -1 : this.audioAnchor + (b.t - this.simAnchor);
      if (at < ctx.currentTime + 0.005 || at > ctx.currentTime + MAX_LEAD) {
        this.simAnchor = b.t;
        this.audioAnchor = ctx.currentTime + LEAD;
        at = this.audioAnchor;
        this.state.realigns++;
      }
      if (this.node) {
        const r = resample(b.data, b.rate, ctx.sampleRate, at * ctx.sampleRate);
        this.node.port.postMessage({ at: r.start, data: r.data }, [r.data.buffer]);
      } else {
        // Fallback: AudioBuffer at the source rate (the browser resamples), started on schedule.
        const buf = ctx.createBuffer(1, b.data.length, b.rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < b.data.length; i++) ch[i] = (b.data[i] / 32768) * VOLUME;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.gain);
        src.start(at);
      }
      this.state.blocks++;
      this.lastWall = performance.now();
    }
    this.state.playing = performance.now() - this.lastWall < 500;
  }

  /** Read the output waveform to get pitch and RMS (for tests and the panel). */
  measure() {
    const a = this.analyser;
    this.td ??= new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.td);
    const r = analyze(this.td, this.ctx.sampleRate);
    this.state.rms = r.rms / VOLUME;
    this.state.hz = r.rms > 1e-4 ? Math.round(r.freq * 10) / 10 : 0;
    this.state.playing = performance.now() - this.lastWall < 500;
  }
}
