// I2S 喇叭（MAX98357A）出声：worker 送来带模拟时刻的 PCM 块，按模拟时间排进 Web Audio 的时间轴。
// 播放走 AudioWorklet：工作线程里一个按"绝对帧号"寻址的环形缓冲，主线程把每块重采样到 AudioContext 的采样率、
// 连同它该在第几帧开始播一起发过去；工作线程每个渲染量子读出对应帧、读完清零（没数据就是静音）。
// 浏览器没有 AudioWorklet（老 Safari、非安全上下文）时退回 AudioBufferSourceNode 逐块定时播放。
// 对齐方式与蜂鸣器（audio.ts）相同：模拟时刻 → 音频时刻领先 LEAD，偏离超过 [0, MAX_LEAD] 就重新对齐。

import type { PcmBlock } from './worker';

const LEAD = 0.12;
const MAX_LEAD = 0.6;
/** 喇叭音量：满量程正弦也不至于吓人 */
const VOLUME = 0.3;
/** 环形缓冲长度（帧）：约 2.7 秒 @ 48 kHz，比 MAX_LEAD 长得多 */
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
        // 已经播过的帧、或远在环形缓冲之外的帧不写（写了会在一圈之后才被播出来）
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

/** 读数：去直流、RMS、过零主频（相邻上升过零点线性插值），与内核 devices/audio.rs 的 analyze 同一算法 */
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

/**
 * 线性插值重采样：块的第一个样本落在输出帧 f0（带小数），输出覆盖 [ceil(f0), ceil(f0 + 时长)) 这些整数帧，
 * 相邻块首尾正好接上——按块取整长度会在块边界留下 1 帧空白（0），既是咔哒声，又会被过零测频多数一次
 */
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
  /** 最近 0.5 秒（墙钟）内排过声音 */
  playing: boolean;
  /** 已排进 Web Audio 的块数 / 重新对齐次数 */
  blocks: number;
  realigns: number;
  /** 输出端（AnalyserNode）测到的主频与 RMS（满量程 = 1，已除掉音量） */
  hz: number;
  rms: number;
  /** 播放方式：worklet / buffer（退回）/ none（还没开声音） */
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

  /** 录屏（P2-10）：把喇叭这一路也接到录音节点 */
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

  /** 重新上电 / 静音：清掉排好的声音 */
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
        // 退回方案：AudioBuffer 按原采样率建（浏览器负责重采样），定时开播
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

  /** 读输出端的时域波形，算主频与 RMS（给测试和面板读数） */
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
