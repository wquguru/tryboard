// Buzzer sound: the worker reports PWM changes on buzzer pins (with sim time); a square oscillator plays them on the sim clock.
// Muted by default (browsers need a user gesture first); the same switch drives the I2S speaker via pcm.ts. Tests read window.__tbAudio.

import type { AudioFrame, PcmBlock, PwmEvent } from './worker';
import { PcmVoice, type PcmState } from './pcm';
import { t } from './i18n';

/** Very quiet: square waves are harsh and may be playing in headphones. */
const VOLUME = 0.04;
/** Re-align when sim time leads / lags the audio clock beyond this (speed change, stalls, pause). */
const LEAD = 0.06;
const MAX_LEAD = 0.4;
/** `playing` means sounded within this much sim time (alarms beep 200 ms on / 200 ms off). */
const RECENT = 0.5;

export interface AudioState {
  muted: boolean;
  /** Frequency of the last sound start (Hz). */
  lastFreq: number;
  /** Not muted and sounded within the last 0.5 s of sim time. */
  playing: boolean;
  /** Sounding right now (after the latest change). */
  sounding: boolean;
  /** Strongest frequency seen by the AnalyserNode (Hz), from the last audible moment. */
  peakHz: number;
  /** I2S speaker: readings at the Web Audio output (only once sound is on). */
  pcm: PcmState | null;
  /** I2S speaker: sim-side readings (PCM the speaker got in the last second), only with an audio device. */
  sim: AudioFrame | null;
}

/** Audible only within human hearing and duty > 0 (a servo's 50 Hz is not sound). */
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
  /** Current [duty, frequency] per buzzer pin. */
  private cur = new Map<number, [number, number]>();
  /** Alignment point: sim time -> audio time. */
  private simAnchor = 0;
  private audioAnchor = -1;
  private lastOnSim = -Infinity;
  private lastSim = 0;
  private onChange: (() => void) | null = null;

  constructor() {
    (globalThis as { __tbAudio?: AudioState }).__tbAudio = this.state;
  }

  /** Pins wired to a buzzer (type: 'buzzer' in examples.json scene.parts). */
  setPins(pins: number[]) {
    this.pins = new Set(pins);
    this.reset();
  }

  get hasBuzzer() {
    return this.pins.size > 0;
  }

  /** Whether the scene has an I2S speaker (MAX98357A). */
  setSpeaker(on: boolean) {
    this.speaker = on;
    this.state.sim = null;
    this.pcm?.reset();
    this.onChange?.();
  }

  /** Has something that can sound (buzzer or speaker): whether to show the sound switch. */
  get hasSound() {
    return this.pins.size > 0 || this.speaker;
  }

  /** Power cycle: clear state and stop sound. */
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

  /** Sound on / off. Turning on must happen in a user gesture; stays muted if the browser refuses. */
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
    // If it is sounding when switched on, start right away.
    const on = this.active();
    if (!this.state.muted && on) this.schedule(this.lastSim, on[1], true);
    this.onChange?.();
  }

  private recDest: MediaStreamAudioDestinationNode | null = null;
  /** Sound to mix into screen recordings (P2-10): only while sound is on; one node feeds both speakers and recorder. */
  recordStream(): MediaStream | null {
    if (!this.ctx || !this.analyser || this.state.muted) return null;
    if (!this.recDest) {
      this.recDest = this.ctx.createMediaStreamDestination();
      this.analyser.connect(this.recDest);
      this.pcm?.tap(this.recDest);
    }
    return this.recDest.stream;
  }

  /** Worker tick: PWM changes in this tick plus the current sim time. */
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

  /** Worker pcm message: speaker output (dropped while muted, not queued). */
  pushPcm(blocks: PcmBlock[]) {
    if (!this.pcm || this.state.muted) return;
    this.pcm.push(blocks);
    const now = performance.now();
    if (now - this.lastMeasure > 100) {
      this.lastMeasure = now;
      this.pcm.measure();
    }
  }

  /** Sim-side audio readings from the worker tick. */
  setSim(f: AudioFrame | undefined) {
    if (f) this.state.sim = f;
  }

  /** First sounding buzzer: [duty, frequency]. */
  private active(): [number, number] | null {
    for (const v of this.cur.values()) if (audible(v[0], v[1])) return v;
    return null;
  }

  /** Schedule a change at sim time t on the audio timeline. */
  private schedule(t: number, freq: number, on: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.osc || !this.gain || this.state.muted) return;
    let at = this.audioAnchor < 0 ? -1 : this.audioAnchor + (t - this.simAnchor);
    if (at < ctx.currentTime || at > ctx.currentTime + MAX_LEAD) {
      this.simAnchor = t;
      this.audioAnchor = ctx.currentTime + LEAD;
      at = this.audioAnchor;
      // A new alignment point may precede already scheduled changes: clear them so an old 'on' never lands after a new 'off'.
      this.gain.gain.cancelScheduledValues(ctx.currentTime);
      this.osc.frequency.cancelScheduledValues(ctx.currentTime);
    }
    if (on) this.osc.frequency.setValueAtTime(freq, at);
    this.gain.gain.setValueAtTime(on ? VOLUME : 0, at);
  }

  private bins: Float32Array<ArrayBuffer> | null = null;
  /** Strongest frequency component from the analyser (a square wave's fundamental is strongest). */
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

  /** Ready-made control: sound on / off button (the click is the user gesture). */
  button(): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'sound';
    const sync = () => {
      b.textContent = this.state.muted ? t('Sound: off') : t('Sound: on');
      b.setAttribute('aria-pressed', String(!this.state.muted));
      b.title = this.speaker ? t('Speaker sound (MAX98357A, muted by default)') : this.hasBuzzer ? t('Buzzer sound (muted by default)') : t('This example has no buzzer or speaker');
    };
    this.onChange = sync;
    b.onclick = () => void this.setMuted(!this.state.muted);
    sync();
    return b;
  }
}
