// 针脚的实时值与"示波器"小窗（P0-11）。
// 数据来自实时模拟每个 tick 的引脚电平 / 输出使能 / 各引脚 PWM 占空比与频率（worker 已有），不另开采样：
// PWM 脚按记录下来的占空比、频率变化合成方波（相位是示意）；普通 GPIO 画 tick 采样到的电平；
// I2C 线只画示意波形并标"示意"；电源脚画一条直线，电压标"估算"。
import type { ElecFrame } from '../worker';
import type { BenchWire } from './wiring';

export interface PinSample {
  t: number;
  duty: number;
  freq: number;
  level: number;
  out: boolean;
}

/** 选中的那根针最近几秒的采样（只记一根，切换针脚时清空） */
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
    // 值没变就只更新时刻，省内存
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

/** 电源脚电压：有电路求解（tryboard-elec）的读数就用它，否则按板子标称写 */
export function powerVolts(id: string, ext5v: boolean, e: ElecFrame | null = null): string {
  if (id === '3V3') return e ? `${e.v3v3.toFixed(3)} V（板载 LDO）` : '3.30 V（板载 LDO）';
  if (id === '5V') return e ? `${e.v5.toFixed(3)} V（USB VBUS）` : '≈ 5.0 V（USB VBUS）';
  if (id === 'EXT5V') return ext5v ? (e ? `${e.vExt.toFixed(3)} V（外接电源）` : '≈ 5.0 V（外接电源）') : '未接';
  if (id === 'GND') return '0 V';
  return '—';
}

/** 万用表（P1-04）：量一根针对地的直流电压。电源脚取电路求解的节点电压；信号脚按逻辑电平给电压
 *  （高 = 当时的 3V3 节点电压，低 = 0），PWM 脚给平均值（万用表直流档读到的就是占空比 × 高电平） */
export function meterVolts(id: string, e: ElecFrame | null, f: { pwm: number[]; gpio: number; enable: number; gpioHi: number; enableHi: number }, ext5v: boolean): { v: number | null; note: string } {
  const v33 = e?.v3v3 ?? 3.3;
  if (id === 'GND' || id === 'G') return { v: 0, note: '地' };
  if (id === '3V3') return { v: v33, note: '3V3 节点（LDO 输出）· 电路求解' };
  if (id === '5V') return { v: e?.v5 ?? 5, note: '5V 轨（USB VBUS）· 电路求解' };
  if (id === 'EXT5V') return ext5v ? { v: e?.vExt ?? 5, note: '外接 5 V · 电路求解' } : { v: null, note: '没接外接电源' };
  if (id === 'servo:VCC') return { v: e?.vServo ?? null, note: '舵机红线（经杜邦线）· 电路求解' };
  if (id === 'RST' || id === 'EN') return { v: e?.held ? 0 : v33, note: e?.held ? '欠压复位按住中' : 'EN 上拉到 3V3' };
  const g = /^GPIO(\d+)$/.exec(id);
  if (!g) return { v: null, note: '这根针没有电压读数' };
  const pin = Number(g[1]);
  if (e?.held) return { v: 0, note: '芯片被欠压复位按住，引脚高阻' };
  const duty = f.pwm[pin] ?? -1;
  if (duty >= 0) return { v: duty * v33, note: `PWM：直流档读平均值（占空比 ${(duty * 100).toFixed(1)} % × ${v33.toFixed(2)} V）` };
  const lv = bit(f.gpio, f.gpioHi, pin);
  const out = !!bit(f.enable, f.enableHi, pin);
  return { v: lv ? v33 : 0, note: `${out ? '输出' : '输入'}${lv ? '高' : '低'}电平（逻辑电平换算，未算驱动内阻）` };
}

export function pwmText(duty: number, freq: number) {
  const ms = freq > 0 ? (duty / freq) * 1000 : 0;
  return { freq: `${freq.toFixed(freq >= 100 ? 0 : 1)} Hz`, width: ms >= 1 ? `${ms.toFixed(3)} ms` : `${(ms * 1000).toFixed(1)} µs`, duty: `${(duty * 100).toFixed(2)} %` };
}

const css = (n: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;

/** 画示波器小窗；返回窗口说明（时间跨度 + 可信度） */
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
  g.fillStyle = '#FBFBFB';
  g.fillRect(0, 0, W, H);
  // 网格：横 4 格、竖 10 格
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
    return '直流：电路求解的节点电压（估算模型，见 DECISIONS「电气模型」）';
  }
  if (kind === 'i2c') {
    // 示意：起始位 + 8 位地址 + 应答，开漏、空闲为高
    const bits = [1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 0, 1];
    const bw = W / bits.length;
    g.moveTo(0, y(3.3));
    bits.forEach((b, i) => {
      g.lineTo(i * bw, y(b ? 3.3 : 0));
      g.lineTo((i + 1) * bw, y(b ? 3.3 : 0));
    });
    g.stroke();
    g.fillText('示意 · 不是实测波形', 6, 11);
    return 'I2C 示意（逻辑分析仪解码见 P1-05）';
  }
  const last = trace.latest();
  const pwm = last && last.duty >= 0 && last.freq > 0;
  // PWM：显示 3 个周期；普通电平：最近 2 秒
  const win = pwm ? 3 / last!.freq : 2;
  const t0 = now - win;
  let prevV = -1;
  for (let x = 0; x <= W; x++) {
    const t = t0 + (x / W) * win;
    const s = trace.at(t);
    let v = 0;
    if (s && s.duty >= 0 && s.freq > 0) v = ((t * s.freq) % 1 + 1) % 1 < s.duty ? 3.3 : 0;
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
  return pwm ? `最近 ${span}：按占空比与频率合成，相位示意` : `最近 ${span}：每个 tick 采一次电平`;
}
