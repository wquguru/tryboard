// 蜂鸣器出声：worker 报来接蜂鸣器引脚上 PWM 的变化（带模拟时刻），按模拟时间排进 Web Audio。
// 一个方波振荡器 + 增益常开，响 / 停只改增益，频率跟着 LEDC 走。默认静音：浏览器要求先有用户手势才能出声，
// 所以 setMuted(false) 要在点击之类的事件处理里调用（AudioContext 在那一刻创建 / 恢复）。
// 测试读 window.__tbAudio = { muted, lastFreq, playing, sounding, peakHz, pcm, sim }。
// 同一个开关也管 I2S 喇叭（MAX98357A）：PCM 块交给 pcm.ts 的 PcmVoice（AudioWorklet），与蜂鸣器共用一个 AudioContext。

import type { AudioFrame, PcmBlock, PwmEvent } from './worker';
import { PcmVoice, type PcmState } from './pcm';

/** 音量很小：方波很刺耳，又是默认开在耳机里的 */
const VOLUME = 0.04;
/** 模拟时间领先 / 落后音频时钟超过这个范围就重新对齐（变速、卡顿、暂停后） */
const LEAD = 0.06;
const MAX_LEAD = 0.4;
/** playing 的含义：最近这么长模拟时间内响过（报警是 200ms 响 / 200ms 停，瞬时状态一半时间是停） */
const RECENT = 0.5;

export interface AudioState {
  muted: boolean;
  /** 最近一次开始发声的频率（Hz） */
  lastFreq: number;
  /** 不静音、且最近 0.5 s 模拟时间内响过 */
  playing: boolean;
  /** 此刻（最近一个变化之后）是否在响 */
  sounding: boolean;
  /** 分析节点（AnalyserNode）测到的最强频率（Hz），最近一次有声时的读数 */
  peakHz: number;
  /** I2S 喇叭：Web Audio 输出端的读数（开声音以后才有） */
  pcm: PcmState | null;
  /** I2S 喇叭：模拟器侧的读数（喇叭收到的 PCM，最近 1 秒），接了音频器件才有 */
  sim: AudioFrame | null;
}

/** 频率在人耳范围内、占空比 > 0 才响（舵机的 50Hz 不算声音） */
export const audible = (duty: number, freq: number) => duty > 0 && freq > 20 && freq < 20000;

export class BuzzerAudio {
  readonly state: AudioState = { muted: true, lastFreq: 0, playing: false, sounding: false, peakHz: 0, pcm: null, sim: null };
  private pcm: PcmVoice | null = null;
  private speaker = false;
  private lastMeasure = 0;
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private pins = new Set<number>();
  /** 每个蜂鸣器引脚当前的 [占空比, 频率] */
  private cur = new Map<number, [number, number]>();
  /** 模拟时刻 → 音频时刻的对齐点 */
  private simAnchor = 0;
  private audioAnchor = -1;
  private lastOnSim = -Infinity;
  private lastSim = 0;
  private onChange: (() => void) | null = null;

  constructor() {
    (globalThis as { __tbAudio?: AudioState }).__tbAudio = this.state;
  }

  /** 哪些引脚接了蜂鸣器（examples.json 的 scene.parts 里 type: 'buzzer'） */
  setPins(pins: number[]) {
    this.pins = new Set(pins);
    this.reset();
  }

  get hasBuzzer() {
    return this.pins.size > 0;
  }

  /** 场景里有没有 I2S 喇叭（MAX98357A） */
  setSpeaker(on: boolean) {
    this.speaker = on;
    this.state.sim = null;
    this.pcm?.reset();
    this.onChange?.();
  }

  /** 有能出声的器件（蜂鸣器或喇叭）：声音开关要不要显示 */
  get hasSound() {
    return this.pins.size > 0 || this.speaker;
  }

  /** 重新上电：清掉状态，声音停 */
  reset() {
    this.cur.clear();
    this.audioAnchor = -1;
    this.lastOnSim = -Infinity;
    this.lastSim = 0;
    this.state.sounding = false;
    this.state.playing = false;
    if (this.ctx && this.gain) this.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    this.pcm?.reset();
  }

  /** 开 / 关声音。开要在用户手势里调用；浏览器不放行时保持静音 */
  async setMuted(m: boolean) {
    if (m) {
      this.state.muted = true;
      this.state.playing = false;
      this.pcm?.reset();
      if (this.ctx) await this.ctx.suspend().catch(() => {});
      this.onChange?.();
      return;
    }
    if (!this.ctx) {
      const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.osc = this.ctx.createOscillator();
      this.osc.type = 'square';
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.osc.connect(this.gain).connect(this.analyser).connect(this.ctx.destination);
      this.osc.start();
    }
    if (!this.pcm) {
      this.pcm = await PcmVoice.create(this.ctx);
      this.state.pcm = this.pcm.state;
    }
    await this.ctx.resume().catch(() => {});
    this.state.muted = this.ctx.state !== 'running';
    this.audioAnchor = -1;
    // 打开那一刻如果正在响，马上接上
    const on = this.active();
    if (!this.state.muted && on) this.schedule(this.lastSim, on[1], true);
    this.onChange?.();
  }

  private recDest: MediaStreamAudioDestinationNode | null = null;
  /** 录屏（P2-10）要混进去的声音（蜂鸣器 + I2S 喇叭）：声音开着才有（关着就是静音视频）；同一个节点同时接扬声器和录音 */
  recordStream(): MediaStream | null {
    if (!this.ctx || !this.analyser || this.state.muted) return null;
    if (!this.recDest) {
      this.recDest = this.ctx.createMediaStreamDestination();
      this.analyser.connect(this.recDest);
      this.pcm?.tap(this.recDest);
    }
    return this.recDest.stream;
  }

  /** worker 的 tick：本 tick 内的 PWM 变化 + 当前模拟时刻 */
  push(events: PwmEvent[] | undefined, simNow: number) {
    this.lastSim = simNow;
    for (const e of events ?? []) {
      if (!this.pins.has(e.pin)) continue;
      const was = this.active();
      this.cur.set(e.pin, [e.duty, e.freq]);
      const now = this.active();
      if (now) {
        this.lastOnSim = e.t;
        if (!was || was[1] !== now[1]) this.state.lastFreq = Math.round(now[1] * 10) / 10;
      }
      if (!!was !== !!now || (was && now && was[1] !== now[1])) this.schedule(e.t, now ? now[1] : 0, !!now);
    }
    const on = this.active();
    if (on) this.lastOnSim = simNow;
    this.state.sounding = !!on;
    this.state.playing = !this.state.muted && simNow - this.lastOnSim <= RECENT;
    if (on && !this.state.muted) this.measure();
  }

  /** worker 的 pcm 消息：喇叭放出的声音（静音时丢掉，不攒） */
  pushPcm(blocks: PcmBlock[]) {
    if (!this.pcm || this.state.muted) return;
    this.pcm.push(blocks);
    const now = performance.now();
    if (now - this.lastMeasure > 100) {
      this.lastMeasure = now;
      this.pcm.measure();
    }
  }

  /** worker tick 里的模拟器侧音频读数 */
  setSim(f: AudioFrame | undefined) {
    if (f) this.state.sim = f;
  }

  /** 第一个正在响的蜂鸣器：[占空比, 频率] */
  private active(): [number, number] | null {
    for (const v of this.cur.values()) if (audible(v[0], v[1])) return v;
    return null;
  }

  /** 把模拟时刻 t 的一次变化排到音频时间线上 */
  private schedule(t: number, freq: number, on: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.osc || !this.gain || this.state.muted) return;
    let at = this.audioAnchor < 0 ? -1 : this.audioAnchor + (t - this.simAnchor);
    if (at < ctx.currentTime || at > ctx.currentTime + MAX_LEAD) {
      this.simAnchor = t;
      this.audioAnchor = ctx.currentTime + LEAD;
      at = this.audioAnchor;
      // 新的对齐点可能早于已经排好的变化：清掉，免得旧的"响"排在新的"停"后面
      this.gain.gain.cancelScheduledValues(ctx.currentTime);
      this.osc.frequency.cancelScheduledValues(ctx.currentTime);
    }
    if (on) this.osc.frequency.setValueAtTime(freq, at);
    this.gain.gain.setValueAtTime(on ? VOLUME : 0, at);
  }

  private bins: Float32Array<ArrayBuffer> | null = null;
  /** 分析节点读最强的频率分量（方波的基频最强） */
  private measure() {
    const a = this.analyser;
    if (!a || !this.ctx) return;
    this.bins ??= new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(this.bins);
    let best = -Infinity;
    let k = -1;
    for (let i = 1; i < this.bins.length; i++) if (this.bins[i] > best) [best, k] = [this.bins[i], i];
    if (k > 0 && best > -90) this.state.peakHz = Math.round((k * this.ctx.sampleRate) / a.fftSize);
  }

  /** 现成的小控件：声音开 / 关按钮（点击就是用户手势） */
  button(): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'sound';
    const sync = () => {
      b.textContent = this.state.muted ? '声音：关' : '声音：开';
      b.setAttribute('aria-pressed', String(!this.state.muted));
      b.title = this.speaker ? '喇叭出声（MAX98357A，默认静音）' : this.hasBuzzer ? '蜂鸣器出声（默认静音）' : '这个示例没有接蜂鸣器或喇叭';
    };
    this.onChange = sync;
    b.onclick = () => void this.setMuted(!this.state.muted);
    sync();
    return b;
  }
}
