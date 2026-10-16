// 浏览器麦克风 → 模拟的 INMP441：getUserMedia 拿到声音，AudioWorklet（退回 ScriptProcessor）按块收集，
// 交给调用方推进 worker（micPush）。只给人玩，不进验收：实时声音没法复现，也不记进输入日志。
// 没有权限 / 没有设备 / 非安全上下文时 start() 返回错误说明，调用方换回测试 WAV。

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
  /** 最近一次失败的原因（空 = 没失败） */
  error: string;
  rate: number;
  /** 最近一块的 RMS（满量程 = 1），给面板电平条 */
  level: number;
}

export class MicInput {
  readonly state: MicState = { on: false, error: '', rate: 0, level: 0 };
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];

  /** 开麦克风；每收满一块调 onChunk(采样率, 样本)。返回 null 表示成功，否则是失败原因 */
  async start(onChunk: (rate: number, data: Float32Array) => void): Promise<string | null> {
    this.stop();
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.getUserMedia) return this.fail('浏览器不支持麦克风（需要 https 或 localhost）');
    try {
      this.stream = await md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      return this.fail(`没有拿到麦克风权限（${(e as Error).name || e}）`);
    }
    const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return this.fail('浏览器不支持 Web Audio');
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
      // 退回：ScriptProcessor（已废弃但到处能用），输出接一个静音增益免得回放到喇叭
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
