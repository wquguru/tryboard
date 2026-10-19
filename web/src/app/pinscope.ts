// Live pin values and the mini "scope" (P0-11), from per-tick level / enable / PWM duty+freq the worker already sends.
// PWM is synthesized from duty and freq (phase illustrative); GPIO shows tick samples; I2C is illustrative; power is a flat estimate.
import { t } from '../i18n/index.ts';
import type { ElecFrame } from '../simmsg';
import type { BenchWire } from './wiring';

export interface PinSample {
  t: number;
  duty: number;
  freq: number;
  level: number;
  out: boolean;
}

/** Recent samples of the selected pin (one pin only; cleared on switch). */
export class PinTrace {
  pin = -1;
  samples: PinSample[] = [];
  watch(pin: number) {
    if (pin === this.pin) return;
    this.pin = pin;
    this.samples = [];
  }
  push(s: PinSample) {
    const last = this.samples[this.samples.length - 1];
    if (last && s.t < last.t) this.samples = [];
    // Unchanged value: only bump the timestamp to save memory.
    if (last && last.duty === s.duty && last.freq === s.freq && last.level === s.level && last.out === s.out && this.samples.length > 1) {
      const prev = this.samples[this.samples.length - 2];
      if (prev.duty === s.duty && prev.freq === s.freq && prev.level === s.level && prev.out === s.out) {
        last.t = s.t;
        return;
      }
    }
    this.samples.push(s);
    const cut = s.t - 5;
    while (this.samples.length > 2 && this.samples[1].t < cut) this.samples.shift();
  }
  at(t: number): PinSample | null {
    let r: PinSample | null = null;
    for (const s of this.samples) {
      if (s.t > t) break;
      r = s;
    }
    return r ?? this.samples[0] ?? null;
  }
  latest() {
    return this.samples[this.samples.length - 1] ?? null;
  }
}

export const bit = (lo: number, hi: number, pin: number) => (pin < 32 ? (lo >>> pin) & 1 : (hi >>> (pin - 32)) & 1);

export type PinKind = 'gpio' | 'i2c' | 'power' | 'gnd';
export function pinKind(id: string, wires: BenchWire[]): PinKind {
  if (id === 'GND') return 'gnd';
  if (!/^GPIO\d+$/.test(id)) return 'power';
  return wires.some((w) => w.a === id && w.pinRole === 'bus') ? 'i2c' : 'gpio';
}

/** Power-pin voltage: the circuit solver (tryboard-elec) reading if present, else the board's nominal value. */
export function powerVolts(id: string, ext5v: boolean, e: ElecFrame | null = null): string {
  if (id === '3V3') return t('{v} V (onboard LDO)', { v: e ? e.v3v3.toFixed(3) : '3.30' });
  if (id === '5V') return e ? t('{v} V (USB VBUS)', { v: e.v5.toFixed(3) }) : t('{v} V (USB VBUS)', { v: '≈ 5.0' });
  if (id === 'EXT5V') return ext5v ? t('{v} V (external supply)', { v: e ? e.vExt.toFixed(3) : '≈ 5.0' }) : t('Not connected');
  if (id === 'GND') return '0 V';
  return '—';
}

/** Multimeter (P1-04): DC volts to ground. Power pins use solver node voltages; signal pins use logic level (high = 3V3 node),
 *  PWM pins the average a DC range reads (duty × high level). */
export function meterVolts(id: string, e: ElecFrame | null, f: { pwm: number[]; gpio: number; enable: number; gpioHi: number; enableHi: number }, ext5v: boolean): { v: number | null; note: string } {
  const v33 = e?.v3v3 ?? 3.3;
  if (id === 'GND' || id === 'G') return { v: 0, note: t('Ground') };
  if (id === '3V3') return { v: v33, note: t('3V3 (LDO output) · estimate') };
  if (id === '5V') return { v: e?.v5 ?? 5, note: t('5V rail (USB VBUS) · estimate') };
  if (id === 'EXT5V') return ext5v ? { v: e?.vExt ?? 5, note: t('External 5 V · estimate') } : { v: null, note: t('No external supply connected') };
  if (id === 'servo:VCC') return { v: e?.vServo ?? null, note: t('Servo red wire (through the jumper) · estimate') };
  if (id === 'RST' || id === 'EN') return { v: e?.held ? 0 : v33, note: e?.held ? t('In brown-out reset') : t('EN pulled up to 3V3') };
  const g = /^GPIO(\d+)$/.exec(id);
  if (!g) return { v: null, note: t('No voltage reading for this pin') };
  const pin = Number(g[1]);
  if (e?.held) return { v: 0, note: t('In brown-out reset, pins are high-Z') };
  const duty = f.pwm[pin] ?? -1;
  if (duty >= 0) return { v: duty * v33, note: t('PWM: the DC range reads the average, {duty} % duty × {v} V', { duty: (duty * 100).toFixed(1), v: v33.toFixed(2) }) };
  const lv = bit(f.gpio, f.gpioHi, pin);
  const out = !!bit(f.enable, f.enableHi, pin);
  const note = out
    ? lv
      ? t('Output high (from the logic level, drive resistance ignored)')
      : t('Output low (from the logic level, drive resistance ignored)')
    : lv
      ? t('Input high (from the logic level, drive resistance ignored)')
      : t('Input low (from the logic level, drive resistance ignored)');
  return { v: lv ? v33 : 0, note };
}

export function pwmText(duty: number, freq: number) {
  const ms = freq > 0 ? (duty / freq) * 1000 : 0;
  return { freq: `${freq.toFixed(freq >= 100 ? 0 : 1)} Hz`, width: ms >= 1 ? `${ms.toFixed(3)} ms` : `${(ms * 1000).toFixed(1)} µs`, duty: `${(duty * 100).toFixed(2)} %` };
}

const css = (n: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;

/** Draw the mini scope; returns its caption (time span + confidence). */
export function drawScope(cv: HTMLCanvasElement, kind: PinKind, trace: PinTrace, now: number, volts: number): string {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 280, H = cv.clientHeight || 96;
  if (cv.width !== Math.round(W * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = css('--scope-bg', '#FBFBFB');
  g.fillRect(0, 0, W, H);
  // Grid: 4 rows, 10 columns.
  g.strokeStyle = css('--line-soft', '#F0F0F0');
  g.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    g.beginPath();
    g.moveTo((W * i) / 10 + 0.5, 0);
    g.lineTo((W * i) / 10 + 0.5, H);
    g.stroke();
  }
  for (let i = 1; i < 4; i++) {
    g.beginPath();
    g.moveTo(0, (H * i) / 4 + 0.5);
    g.lineTo(W, (H * i) / 4 + 0.5);
    g.stroke();
  }
  const top = 14, bot = H - 14;
  const y = (v: number) => bot - (v / 3.3) * (bot - top);
  g.strokeStyle = css('--accent', '#0D99FF');
  g.lineWidth = 1.6;
  g.font = '10px "JetBrains Mono", monospace';
  g.fillStyle = css('--muted', '#8C8C8C');
  let span = '';
  g.beginPath();
  if (kind === 'power' || kind === 'gnd') {
    const v = Math.min(3.3, volts);
    g.moveTo(0, y(v));
    g.lineTo(W, y(v));
    g.stroke();
    g.fillText(`${volts.toFixed(2)} V`, 6, 11);
    return t('DC voltage (estimate)');
  }
  if (kind === 'i2c') {
    // Illustration: start + 8-bit address + ACK, open drain, idle high.
    const bits = [1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 0, 1];
    const bw = W / bits.length;
    g.moveTo(0, y(3.3));
    bits.forEach((b, i) => {
      g.lineTo(i * bw, y(b ? 3.3 : 0));
      g.lineTo((i + 1) * bw, y(b ? 3.3 : 0));
    });
    g.stroke();
    g.fillText(t('Illustration · not a measured waveform'), 6, 11);
    return t('I2C illustration; see the logic analyzer for real decoding');
  }
  const last = trace.latest();
  const pwm = last && last.duty >= 0 && last.freq > 0;
  // PWM: 3 periods; plain levels: the last 2 s.
  const win = pwm ? 3 / last!.freq : 2;
  const t0 = now - win;
  let prevV = -1;
  for (let x = 0; x <= W; x++) {
    const tt = t0 + (x / W) * win;
    const s = trace.at(tt);
    let v = 0;
    if (s && s.duty >= 0 && s.freq > 0) v = ((tt * s.freq) % 1 + 1) % 1 < s.duty ? 3.3 : 0;
    else if (s && s.out) v = s.level ? 3.3 : 0;
    else v = s && s.level ? 3.3 : 0;
    if (x === 0) g.moveTo(x, y(v));
    else if (v !== prevV) {
      g.lineTo(x, y(prevV));
      g.lineTo(x, y(v));
    }
    prevV = v;
  }
  g.lineTo(W, y(prevV));
  g.stroke();
  span = pwm ? (win >= 0.001 ? `${(win * 1000).toFixed(1)} ms` : `${(win * 1e6).toFixed(0)} µs`) : '2 s';
  g.fillText(`3.3 V`, 6, 11);
  g.fillText(span, W - 6 - g.measureText(span).width, H - 3);
  return pwm ? t('Last {span}: drawn from duty and frequency, phase is illustrative', { span }) : t('Last {span}: coarse sampling', { span });
}
