// Logic analyzer data layer (P1-05): decode tb_io_take 16-byte records, group by channel, decode I2C with plain notes.
// eventLine text must match core/crates/esp32c3/src/iotrace.rs byte for byte (traceio.mjs diffs it against `--trace-io`).
import { t } from '../i18n/index.ts';

export const CPU_HZ = 160_000_000;

export const K = { GPIO: 1, PWM: 2, WS2812: 3, I2C_START: 10, I2C_ADDR: 11, I2C_DATA: 12, I2C_STOP: 13 } as const;
export const B_READ = 1;
export const B_NACK = 2;
export const B_RESTART = 4;
export const B_PORT1 = 1 << 15;
export const EVENT_BYTES = 16;

export interface IoEvent {
  /** CPU cycles (160 MHz) */
  t: number;
  kind: number;
  a: number;
  b: number;
  v: number;
}

/** Decode bytes copied by tb_io_take (n × 16 bytes, little-endian) */
export function decodeEvents(buf: Uint8Array): IoEvent[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: IoEvent[] = [];
  for (let o = 0; o + EVENT_BYTES <= buf.byteLength; o += EVENT_BYTES) {
    const t = dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;
    out.push({ t, kind: dv.getUint8(o + 8), a: dv.getUint8(o + 9), b: dv.getUint16(o + 10, true), v: dv.getUint32(o + 12, true) });
  }
  return out;
}

const h2 = (n: number) => n.toString(16).padStart(2, '0');

/** One text line, identical to Rust IoEvent::line */
export function eventLine(e: IoEvent): string {
  const port = e.b & B_PORT1 ? 'I2C1' : 'I2C0';
  const dir = e.b & B_READ ? 'R' : 'W';
  const ack = e.b & B_NACK ? 'NACK' : 'ACK';
  switch (e.kind) {
    case K.GPIO:
      return `${e.t} GPIO ${e.a} ${e.b}`;
    case K.PWM:
      return `${e.t} PWM ${e.a} ${e.b} ${e.v}`;
    case K.WS2812:
      return `${e.t} WS2812 ${e.a} ${e.b} ${e.v.toString(16).padStart(6, '0')}`;
    case K.I2C_START:
      return `${e.t} ${port} ${e.b & B_RESTART ? 'RESTART' : 'START'} ${e.v}`;
    case K.I2C_ADDR:
      return `${e.t} ${port} ADDR ${h2(e.a)} ${dir} ${ack}`;
    case K.I2C_DATA:
      return `${e.t} ${port} DATA ${h2(e.a)} ${dir} ${ack}`;
    case K.I2C_STOP:
      return `${e.t} ${port} STOP`;
    default:
      return `${e.t} ? ${e.kind} ${e.a} ${e.b} ${e.v}`;
  }
}

// ------------------------------------------------------------ I2C transactions

export interface I2cItem {
  kind: 'start' | 'restart' | 'addr' | 'data' | 'stop';
  t: number;
  byte: number;
  read: boolean;
  nack: boolean;
}

export interface I2cTxn {
  port: number;
  t0: number;
  /** After the stop bit (before STOP = last item + 9 bits) */
  t1: number;
  /** Cycles per SCL bit */
  bit: number;
  items: I2cItem[];
  done: boolean;
}

export const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

/** Bubble text: START 0x76 W · 0xF7 · RESTART 0x76 R · 8 B · STOP */
export function txnText(x: I2cTxn): string {
  const parts: string[] = [];
  let run: I2cItem[] = [];
  const flush = () => {
    if (!run.length) return;
    const read = run[0].read;
    // Short writes (register address, command) list each byte; reads and long writes show only the count
    if (!read && run.length <= 3) parts.push(...run.map((d) => hex(d.byte) + (d.nack ? ' NACK' : '')));
    else parts.push(`${run.length} B`);
    run = [];
  };
  for (const it of x.items) {
    if (it.kind === 'data') {
      if (run.length && run[0].read !== it.read) flush();
      run.push(it);
      continue;
    }
    flush();
    if (it.kind === 'start') parts.push('START');
    else if (it.kind === 'restart') parts.push('RESTART');
    else if (it.kind === 'stop') parts.push('STOP');
    else {
      const last = parts.pop();
      parts.push(`${last ? last + ' ' : ''}${hex(it.byte)} ${it.read ? 'R' : 'W'}${it.nack ? ' NACK' : ''}`);
    }
  }
  flush();
  return parts.join(' · ');
}

/** [lo, hi, note when written, note when read back (config registers only)] */
const BME_REG: [number, number, string, string?][] = [
  [0xd0, 0xd0, t('Read chip ID (BME280 should be 0x60)')],
  [0xe0, 0xe0, t('Soft reset')],
  [0x88, 0xa1, t('Read temperature / pressure calibration')],
  [0xe1, 0xe7, t('Read humidity calibration')],
  [0xf2, 0xf2, t('Set humidity oversampling'), t('Read humidity oversampling')],
  [0xf3, 0xf3, t('Check status (measuring or not)')],
  [0xf4, 0xf4, t('Set temperature / pressure oversampling and mode'), t('Read temperature / pressure oversampling and mode')],
  [0xf5, 0xf5, t('Set standby time and filter'), t('Read standby time and filter')],
  [0xf7, 0xf9, t('Read raw pressure')],
  [0xfa, 0xfc, t('Read raw temperature')],
  [0xfd, 0xfe, t('Read raw humidity')],
];

const OLED_CMD: Record<number, string> = {
  0xae: t('Display off'),
  0xaf: t('Display on'),
  0x8d: t('Charge pump'),
  0x20: t('Addressing mode'),
  0x21: t('Column address range'),
  0x22: t('Page address range'),
  0x81: t('Contrast'),
  0xa8: t('Multiplex ratio'),
  0xd3: t('Display offset'),
  0xa1: t('Column remap'),
  0xa0: t('No column remap'),
  0xc8: t('Reverse row scan'),
  0xc0: t('Normal row scan'),
  0xda: t('COM pin config'),
  0xd5: t('Clock divide'),
  0xd9: t('Pre-charge period'),
  0xdb: t('VCOMH level'),
  0xa4: t('Display from RAM'),
  0xa5: t('All-on test'),
  0xa6: t('Normal (not inverted)'),
  0xa7: t('Inverted'),
};

/** One plain-language note for known device registers (BME280 0x76 / 0x77, SSD1306 0x3C / 0x3D); '' if unknown */
export function txnNote(x: I2cTxn): string {
  const addr = x.items.find((i) => i.kind === 'addr');
  if (!addr) return '';
  if (addr.nack) return t('No device answered (address scan or wiring problem)');
  const a = addr.byte;
  const w = x.items.filter((i) => i.kind === 'data' && !i.read);
  const r = x.items.filter((i) => i.kind === 'data' && i.read);
  if (a === 0x76 || a === 0x77) {
    const reg = w[0]?.byte;
    if (reg === undefined) return '';
    if (r.length) {
      if (reg === 0xf7 && r.length >= 8) return t('Read raw pressure, temperature and humidity (one 8-byte read)');
      if (reg === 0xf7 && r.length >= 6) return t('Read raw pressure and temperature');
      const hit = BME_REG.find(([lo, hi]) => reg >= lo && reg <= hi);
      if (!hit) return t('Read register {reg}', { reg: hex(reg) });
      return hit[3] ?? hit[2];
    }
    const hit = BME_REG.find(([lo, hi]) => reg >= lo && reg <= hi);
    if (reg === 0xe0 && w[1]?.byte === 0xb6) return t('Soft reset');
    if (reg === 0xf4 && w[1]) return t('Set oversampling and mode ({mode})', { mode: [t('sleep'), t('forced'), t('forced'), t('normal')][w[1].byte & 3] });
    if (w.length === 1) return t('Select register {reg}', { reg: hex(reg) });
    return hit ? hit[2] : t('Write register {reg}', { reg: hex(reg) });
  }
  if (a === 0x3c || a === 0x3d) {
    const ctl = w[0]?.byte;
    if (ctl === undefined) return '';
    const body = w.slice(1);
    if (ctl === 0x40) return t('Write display RAM, {n} bytes', { n: body.length });
    if (ctl === 0x00 || ctl === 0x80) {
      const c = body[0]?.byte;
      if (c === undefined) return t('OLED command');
      if (c >= 0xb0 && c <= 0xb7) return t('OLED command: select page {n}', { n: c - 0xb0 });
      if (c >= 0x40 && c <= 0x7f && body.length === 1) return t('OLED command: start line');
      const name = OLED_CMD[c];
      if (body.length > 3) return name ? t('OLED command sequence ({n} bytes, starting with {name})', { n: body.length, name }) : t('OLED command sequence ({n} bytes)', { n: body.length });
      return t('OLED command: {name}', { name: name ?? hex(c) });
    }
  }
  return '';
}

// ------------------------------------------------------------ Per-channel store

export interface Series {
  t: number[];
}
export interface GpioSeries extends Series {
  v: number[];
}
export interface PwmSeries extends Series {
  duty: number[];
  /** Hz; 0 = PWM stopped */
  freq: number[];
}
export interface WsSeries extends Series {
  n: number[];
  rgb: number[];
}

/** Web-side capacity; beyond it the oldest half is dropped as one time span */
export const STORE_CAP = 400_000;

/** Append-only event store, filled per worker batch; reset on power-on / rewind */
export class IoStore {
  gpio = new Map<number, GpioSeries>();
  pwm = new Map<number, PwmSeries>();
  ws = new Map<number, WsSeries>();
  i2c = new Map<number, I2cTxn[]>();
  /** Raw events (for diffing and export) */
  raw: IoEvent[] = [];
  /** Dropped count (web store full + core buffer overflow) */
  dropped = 0;
  coreDropped = 0;
  /** Earliest retained time (cycles); waveforms before it are unreliable after drops */
  since = 0;
  rev = 0;
  private open = new Map<number, I2cTxn>();

  reset() {
    this.gpio.clear();
    this.pwm.clear();
    this.ws.clear();
    this.i2c.clear();
    this.open.clear();
    this.raw = [];
    this.dropped = 0;
    this.coreDropped = 0;
    this.since = 0;
    this.rev++;
  }

  append(evs: IoEvent[]) {
    for (const e of evs) this.add(e);
    if (this.raw.length > STORE_CAP) this.trim();
    if (evs.length) this.rev++;
  }

  private add(e: IoEvent) {
    this.raw.push(e);
    switch (e.kind) {
      case K.GPIO: {
        const s = get(this.gpio, e.a, () => ({ t: [], v: [] }));
        s.t.push(e.t);
        s.v.push(e.b);
        break;
      }
      case K.PWM: {
        const s = get(this.pwm, e.a, () => ({ t: [], duty: [], freq: [] }));
        s.t.push(e.t);
        s.duty.push(e.b / 65535);
        s.freq.push(e.v / 1000);
        break;
      }
      case K.WS2812: {
        const s = get(this.ws, e.a, () => ({ t: [], n: [], rgb: [] }));
        s.t.push(e.t);
        s.n.push(e.b);
        s.rgb.push(e.v);
        break;
      }
      case K.I2C_START:
      case K.I2C_ADDR:
      case K.I2C_DATA:
      case K.I2C_STOP: {
        const port = e.b & B_PORT1 ? 1 : 0;
        let x = this.open.get(port);
        const bit = x?.bit ?? 400;
        if (e.kind === K.I2C_START && !(e.b & B_RESTART)) {
          // New START without a STOP: close the previous transaction
          if (x) x.done = true;
          x = { port, t0: e.t, t1: e.t + e.v, bit: e.v || 400, items: [], done: false };
          this.open.set(port, x);
          get(this.i2c, port, () => []).push(x);
        }
        if (!x) {
          // Buffer starts mid-transaction (earlier part dropped): open one here
          x = { port, t0: e.t, t1: e.t, bit, items: [], done: false };
          this.open.set(port, x);
          get(this.i2c, port, () => []).push(x);
        }
        if (e.kind === K.I2C_START && e.v) x.bit = e.v;
        const kind = e.kind === K.I2C_START ? (e.b & B_RESTART ? 'restart' : 'start') : e.kind === K.I2C_ADDR ? 'addr' : e.kind === K.I2C_DATA ? 'data' : 'stop';
        x.items.push({ kind, t: e.t, byte: e.a, read: !!(e.b & B_READ), nack: !!(e.b & B_NACK) });
        const len = kind === 'addr' || kind === 'data' ? 9 : 1;
        x.t1 = Math.max(x.t1, e.t + len * x.bit);
        if (kind === 'stop') {
          x.done = true;
          this.open.delete(port);
        }
        break;
      }
    }
  }

  /** Store full: drop the oldest half and rebuild channels from the rest */
  private trim() {
    const keep = this.raw.slice(this.raw.length - Math.floor(STORE_CAP / 2));
    const dropped = this.dropped + this.raw.length - keep.length;
    const core = this.coreDropped;
    this.reset();
    this.dropped = dropped;
    this.coreDropped = core;
    this.since = keep[0]?.t ?? 0;
    for (const e of keep) this.add(e);
  }

  /** Same format as the CLI --trace-io file (without the comment header) */
  text(n = this.raw.length) {
    return this.raw
      .slice(0, n)
      .map((e) => eventLine(e) + '\n')
      .join('');
  }
}

function get<K, V>(m: Map<K, V>, k: K, mk: () => V): V {
  let v = m.get(k);
  if (v === undefined) {
    v = mk();
    m.set(k, v);
  }
  return v;
}

/** Index of the last element ≤ x in a sorted array (-1 if none) */
export function lastLE(a: number[], x: number): number {
  let lo = 0,
    hi = a.length - 1,
    r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= x) {
      r = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return r;
}

/** Index of the first transaction with t1 ≥ x (sorted by t0; t1 is monotonic too) */
export function firstTxnEndingAfter(xs: I2cTxn[], x: number): number {
  let lo = 0,
    hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m].t1 < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** PWM label: "50 Hz · 1.675 ms" */
export function pwmLabel(duty: number, freq: number): string {
  if (!(freq > 0)) return t('No PWM');
  const f = freq >= 1000 ? `${(freq / 1000).toFixed(freq >= 10000 ? 1 : 2)} kHz` : `${freq.toFixed(freq >= 100 ? 0 : freq >= 10 ? 0 : 1)} Hz`;
  const w = duty / freq;
  const ws = w >= 1e-3 ? `${(w * 1e3).toFixed(3)} ms` : `${(w * 1e6).toFixed(1)} µs`;
  return `${f} · ${ws}`;
}

/** Seconds → readout: "1.675 ms", "12.0 µs", "2.350 s" */
export function fmtTime(s: number): string {
  const a = Math.abs(s);
  if (a >= 1) return `${s.toFixed(3)} s`;
  if (a >= 1e-3) return `${(s * 1e3).toFixed(3)} ms`;
  if (a >= 1e-6) return `${(s * 1e6).toFixed(2)} µs`;
  return `${(s * 1e9).toFixed(0)} ns`;
}
