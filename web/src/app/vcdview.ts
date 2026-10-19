// Fine capture (D-04) helpers: read the core's VCD text back into edges, measure pulses, decode DHT11 bits.
// Pure functions so node tests can check them without a page.
import { CPU_HZ } from './iotrace';

/** 1 ps per VCD time unit, 6250 ps per CPU cycle (same constants as core vcd.rs) */
export const PS_PER_CYCLE = 1e12 / CPU_HZ;

export interface FineWave {
  pin: number;
  /** Window in cycles */
  t0: number;
  t1: number;
  /** Level at t0, then edges (cycle, new level) */
  init: number;
  t: number[];
  v: number[];
}

/** Parse the VCD written by core vcd.rs for one pin; null when the pin is not in it */
export function parseVcd(text: string, pin: number): FineWave | null {
  let id: string | null = null;
  let now = 0;
  let t0 = -1;
  let last = 0;
  let init = 0;
  let inDump = false;
  const t: number[] = [];
  const v: number[] = [];
  for (const line of text.split('\n')) {
    const m = /^\$var wire 1 (\S+) GPIO(\d+) \$end$/.exec(line);
    if (m) {
      if (Number(m[2]) === pin) id = m[1];
      continue;
    }
    if (line.startsWith('#')) {
      now = Math.round(Number(line.slice(1)) / PS_PER_CYCLE);
      if (t0 < 0) t0 = now;
      last = now;
      continue;
    }
    if (line === '$dumpvars') inDump = true;
    else if (line === '$end' && inDump) inDump = false;
    else if (id !== null && line.length >= 2 && (line[0] === '0' || line[0] === '1') && line.slice(1) === id) {
      if (inDump) init = Number(line[0]);
      else {
        t.push(now);
        v.push(Number(line[0]));
      }
    }
  }
  if (id === null) return null;
  return { pin, t0: Math.max(t0, 0), t1: last, init, t, v };
}

/** Level and the pulse around cycle c: [a, b) between the edges around it (window edges when none) */
export function pulseAt(w: FineWave, c: number): { level: number; a: number; b: number } | null {
  if (c < w.t0 || c > w.t1) return null;
  let i = -1;
  for (let k = 0; k < w.t.length && w.t[k] <= c; k++) i = k;
  const level = i < 0 ? w.init : w.v[i];
  return { level, a: i < 0 ? w.t0 : w.t[i], b: i + 1 < w.t.length ? w.t[i + 1] : w.t1 };
}

/** DHT11 data bits: a ~50 µs low then a high under 40 µs = 0, over 60 µs = 1 (datasheet 26-28 / 70 µs) */
export interface DhtBit {
  /** High pulse [a, b) in cycles */
  a: number;
  b: number;
  bit: 0 | 1;
}
const US = CPU_HZ / 1e6;
export function dhtBits(w: FineWave): DhtBit[] {
  const out: DhtBit[] = [];
  for (let i = 1; i + 1 < w.t.length; i++) {
    if (w.v[i] !== 1 || w.v[i - 1] !== 0) continue;
    const low = (w.t[i] - w.t[i - 1]) / US;
    const high = (w.t[i + 1] - w.t[i]) / US;
    if (low < 35 || low > 65) continue;
    if (high < 40) out.push({ a: w.t[i], b: w.t[i + 1], bit: 0 });
    else if (high > 60 && high < 100) out.push({ a: w.t[i], b: w.t[i + 1], bit: 1 });
  }
  return out;
}

/** The bit under a high pulse that contains cycle c, if it is a DHT11 data bit */
export function dhtBitAt(bits: DhtBit[], c: number): 0 | 1 | null {
  const b = bits.find((x) => c >= x.a && c < x.b);
  return b ? b.bit : null;
}

/** First 40 bits as 5 bytes, plus the checksum verdict and readings; null with fewer than 40 bits */
export function dhtFrame(bits: DhtBit[]): { bytes: number[]; ok: boolean; humidity: number; temp: number } | null {
  if (bits.length < 40) return null;
  const bytes = [0, 0, 0, 0, 0];
  for (let i = 0; i < 40; i++) bytes[i >> 3] = (bytes[i >> 3] << 1) | bits[i].bit;
  const ok = ((bytes[0] + bytes[1] + bytes[2] + bytes[3]) & 0xff) === bytes[4];
  const t = bytes[2] + (bytes[3] & 0x0f) / 10;
  return { bytes, ok, humidity: bytes[0], temp: bytes[3] & 0x80 ? -t : t };
}
