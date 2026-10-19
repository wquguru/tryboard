// Browser microphone -> simulated INMP441: getUserMedia plus AudioWorklet (or ScriptProcessor) chunks pushed to the worker (micPush).
// For play only, not acceptance (live audio cannot be replayed or logged); start() returns an error so callers fall back to the test WAV.
import { t } from './i18n';

const CAPTURE = `
class TbCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tb-capture', TbCapture);
`;

export interface MicState {
  on: boolean;
  /** Reason of the last failure (empty = none). */
  error: string;
  rate: number;
  /** RMS of the latest chunk (full scale = 1), for the level meter. */
  level: number;
}

export class MicInput {
  readonly state: MicState = { on: false, error: '', rate: 0, level: 0 };
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];

  /** Open the mic; calls onChunk(rate, samples) per full chunk. Returns null on success, else the failure reason. */
  async start(onChunk: (rate: number, data: Float32Array) => void): Promise<string | null> {
    this.stop();
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.getUserMedia) return this.fail(t('This browser cannot use the microphone (needs https or localhost)'));
    try {
      this.stream = await md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      return this.fail(t('Microphone permission was not granted ({err})', { err: (e as Error).name || String(e) }));
    }
    const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return this.fail(t('This browser cannot process audio; try a newer browser'));
    const ctx = (this.ctx = new AC());
    await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(this.stream);
    const deliver = (x: Float32Array) => {
      let s = 0;
      for (let i = 0; i < x.length; i++) s += x[i] * x[i];
      this.state.level = Math.sqrt(s / x.length);
      onChunk(ctx.sampleRate, x);
    };
    try {
      const url = URL.createObjectURL(new Blob([CAPTURE], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'tb-capture', { numberOfOutputs: 0 });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => deliver(e.data);
      src.connect(node);
      this.nodes = [src, node];
    } catch {
      // Fallback: ScriptProcessor (deprecated but universal); its output goes to a muted gain so it never plays back.
      const sp = ctx.createScriptProcessor(1024, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      sp.onaudioprocess = (e) => deliver(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(sp).connect(mute).connect(ctx.destination);
      this.nodes = [src, sp, mute];
    }
    Object.assign(this.state, { on: true, error: '', rate: ctx.sampleRate });
    return null;
  }

  stop() {
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.state.on = false;
    this.state.level = 0;
  }

  private fail(msg: string) {
    this.stop();
    this.state.error = msg;
    return msg;
  }
}
