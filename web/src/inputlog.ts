// Input log: web actions (buttons, sliders, serial...) stamped in simulated time by the worker, not wall clock (its ratio varies by machine),
// exported as a `tryboard run --inputs <file>` script that replays cycle for cycle. Format: docs/DECISIONS.md (2026-10-16 input log).

import { partsArgs, rc522Spec, type PartsDevs } from './partsdev.ts';
export type InputEvent =
  /** Externally driven pin: 0 / 1, -1 = released (high impedance) */
  | { tMs: number; kind: 'gpio'; pin: number; level: number }
  /** Environment (what BME280 etc. read; the assembled sensor-near-chip offset is already in temp) */
  | { tMs: number; kind: 'env'; temp: number; humidity: number; pressure: number }
  /** Potentiometer / analog input: pin voltage (mV) */
  | { tMs: number; kind: 'pot'; pin: number; mv: number }
  /** Power-up: every log starts at one (reset = new log), so replay needs no action */
  | { tMs: number; kind: 'power'; on: boolean }
  /** Serial / USB virtual serial input */
  | { tMs: number; kind: 'uart' | 'usbcdc'; text: string }
  /** Supply switch (P1-02): usb = servo on USB 5 V; ext = servo on external 5 V. Script action power=usb|ext */
  | { tMs: number; kind: 'supply'; mode: 'usb' | 'ext' }
  /** Harness (P2-11, estimate): total I2C wire length (cm, negative = ideal bus), antenna loss (dB). Actions i2cwire=cm / antenna=dB */
  | { tMs: number; kind: 'i2cwire'; cm: number }
  | { tMs: number; kind: 'antenna'; db: number }
  /** Rotary encoder turned by steps detents (positive = clockwise); script action enc=+N / enc=-N (P2-01) */
  | { tMs: number; kind: 'enc'; steps: number }
  /** Encoder push button; script action encsw=1|0 */
  | { tMs: number; kind: 'encsw'; down: boolean }
  /** Ultrasonic sensor to obstacle distance (cm, negative = nothing ahead); script action dist=cm (P2-04) */
  | { tMs: number; kind: 'dist'; cm: number }
  /** IMU attitude (P2-03): Euler angles (deg, ZYX: yaw -> pitch -> roll) + rates (°/s, from drag speed). Action imu=p,r,y[,dp,dr,dy] */
  | { tMs: number; kind: 'imu'; pitch: number; roll: number; yaw: number; rates?: [number, number, number] }
  /** Touch screen (P2-02): press / move to (x, y) (screen pixels, clamped to the screen) or lift. Script action touch=x,y / release */
  | { tMs: number; kind: 'touch'; down: boolean; x: number; y: number }
  /** Virtual phone (C-01): scan / connect / read / write / subscribe..., logged verbatim. Action ble=<command> (syntax: ARCH.md BLE); virtual PC commands log as pc=… */
  | { tMs: number; kind: 'ble'; cmd: string }
  /** One virtual-phone step (C-02): on / join,ssid[,pass] / leave / open / get,url / post,url,body. Action phone=… */
  | { tMs: number; kind: 'phone'; cmd: string }
  /** "Real network" toggle (C-03). Action realnet=1/0 */
  | { tMs: number; kind: 'realnet'; on: boolean }
  /** One real-network reply (C-03): id,status,ms,content type or reason code,base64 body. Action netreply=… */
  | { tMs: number; kind: 'netreply'; reply: string }
  /** Network conditions (D-01): PRNG seed, preset (normal / weak / flaky / offline), one fault from now (reboot / dns / silent, seconds).
   *  Actions seed=N / net=preset / netfault=kind[,s] */
  | { tMs: number; kind: 'seed'; seed: number }
  | { tMs: number; kind: 'net'; preset: string }
  | { tMs: number; kind: 'netfault'; fault: string; dur?: number }
  /** ADC model (D-02): ideal = linear and exact, real = calibration curve + end bends + noise (default). Action adc=ideal|real */
  | { tMs: number; kind: 'adc'; ideal: boolean }
  /** AXP2101 battery percent and USB plugged (E-03). Action bat=pct[,usb] */
  | { tMs: number; kind: 'bat'; pct: number; usb: boolean }
  /** PWR key wired to the AXP2101 PWRON pin (E-03). Action pwrkey=short|long */
  | { tMs: number; kind: 'pwrkey'; long: boolean }
  /** Board keyboard key (M5-09b Cardputer, script-safe name of core keyboard.rs). Action key=<name>,1|0 */
  | { tMs: number; kind: 'key'; name: string; down: boolean }
  /** F-04a bench parts: PIR motion (pir=1|0), light on the photoresistor (lux=N), card on the RC522 (card=<uid hex>|none) */
  | { tMs: number; kind: 'pir'; on: boolean }
  | { tMs: number; kind: 'lux'; lux: number }
  | { tMs: number; kind: 'card'; uid: string };

/** An event not yet stamped (the worker fills in tMs when applying it) */
export type InputAction = InputEvent extends infer E ? (E extends unknown ? Omit<E, 'tMs'> : never) : never;

export interface InputLog {
  version: 1;
  /** Example / firmware name (filled on the main thread; the worker does not know it) */
  firmware?: string;
  chip?: 'esp32' | 'esp32c3' | 'esp32s3';
  /** Devices attached at power-up: become --i2c / --spi on replay */
  i2c: { kind: string; addr: number }[];
  lcd: boolean;
  /** Screen other than the GC9A01 (E-03): becomes --spi co5300 on replay */
  spi?: 'co5300';
  /** AXP2101 battery at power-up: becomes --battery pct[,usb] on replay */
  battery?: { pct: number; usb: boolean };
  /** Servo (GPIO) and supply at power-up: become --servo / --power on replay */
  servo?: number;
  power?: 'usb' | 'ext';
  /** Encoder / ultrasonic at power-up: become --encoder A,B[,SW] / --sonar TRIG,ECHO on replay */
  encoder?: { a: number; b: number; sw?: number };
  sonar?: { trig: number; echo: number };
  /** DHT11 data GPIO at power-up: becomes --dht11 on replay */
  dht11?: number;
  /** GPIO wired to the touch controller INT: becomes --touch-int on replay */
  touchInt?: number;
  /** Core board preset at power-up (M5-09b): becomes --board on replay */
  board?: string;
  /** Grove unit on the preset's Port A (M5-09d): becomes --grove on replay */
  grove?: string;
  /** I2S audio parts at power-up (max98357a / inmp441) and the mic's test WAV (name under tools/audio/): become --i2s / --mic */
  i2s?: string[];
  mic?: string;
  /** F-04a parts at power-up (DS18B20 / PIR / relay / LDR / RC522): become --ds18b20 / --pir / --relay / --ldr / --spi rc522 */
  parts?: PartsDevs;
  events: InputEvent[];
  /** Simulated time (ms) when the log was taken: replaying up to here (--seconds) matches what the web showed */
  endMs?: number;
}

const CPU_HZ = 160_000_000;

/** Cycles -> ms (full precision; rounded on export) */
export const cyclesToMs = (cycles: number) => (cycles * 1000) / CPU_HZ;

// Seconds floored to the microsecond: never after the apply time, yet well past the previous 1 ms slice start,
// so the CLI applies it at the start of the same slice (see --inputs in cli main.rs).
const sec = (ms: number) => (Math.floor(ms * 1000) / 1e6).toFixed(6);
const esc = (t: string) => t.replaceAll('\n', '\\n');

/** One event -> script action (`gpio0=0`, `env=35,45,101325`, `mv1=1650`...); power has none */
export function action(e: InputEvent): string | null {
  switch (e.kind) {
    case 'gpio':
      return `gpio${e.pin}=${e.level < 0 ? 'z' : e.level ? 1 : 0}`;
    case 'env':
      return `env=${e.temp},${e.humidity},${e.pressure}`;
    case 'pot':
      return `mv${e.pin}=${e.mv}`;
    case 'uart':
      return `uart=${esc(e.text)}`;
    case 'usbcdc':
      return `usbcdc=${esc(e.text)}`;
    case 'supply':
      return `power=${e.mode}`;
    case 'i2cwire':
      return `i2cwire=${e.cm}`;
    case 'antenna':
      return `antenna=${e.db}`;
    case 'enc':
      return `enc=${e.steps >= 0 ? '+' : ''}${e.steps}`;
    case 'encsw':
      return `encsw=${e.down ? 1 : 0}`;
    case 'dist':
      return `dist=${Math.round(e.cm * 100) / 100}`;
    case 'imu': {
      const r = (v: number) => String(Math.round(v * 100) / 100);
      const base = [e.pitch, e.roll, e.yaw].map(r).join(',');
      return e.rates && e.rates.some((v) => v !== 0) ? `imu=${base},${e.rates.map(r).join(',')}` : `imu=${base}`;
    }
    case 'touch':
      return e.down ? `touch=${Math.round(e.x)},${Math.round(e.y)}` : 'release';
    case 'ble':
      // Virtual PC (E-07b) rides the phone channel but logs as the CLI's own pc= action
      return e.cmd.startsWith('pc=') ? e.cmd : `ble=${e.cmd}`;
    case 'phone':
      return `phone=${esc(e.cmd)}`;
    case 'realnet':
      return `realnet=${e.on ? 1 : 0}`;
    case 'netreply':
      return `netreply=${e.reply}`;
    case 'seed':
      return `seed=${e.seed >>> 0}`;
    case 'net':
      return `net=${e.preset}`;
    case 'netfault':
      return `netfault=${e.fault}${e.dur === undefined ? '' : ',' + e.dur}`;
    case 'adc':
      return `adc=${e.ideal ? 'ideal' : 'real'}`;
    case 'bat':
      return `bat=${e.pct}${e.usb ? ',usb' : ''}`;
    case 'pwrkey':
      return `pwrkey=${e.long ? 'long' : 'short'}`;
    case 'key':
      return `key=${e.name},${e.down ? 1 : 0}`;
    case 'pir':
      return `pir=${e.on ? 1 : 0}`;
    case 'lux':
      return `lux=${e.lux}`;
    case 'card':
      return `card=${e.uid}`;
    case 'power':
      return null;
  }
}

/** imu events are rounded to 0.01° before logging (the script's precision), so web-applied and replayed values match bit for bit */
export function roundImu<T extends { pitch: number; roll: number; yaw: number; rates?: [number, number, number] }>(e: T): T {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { ...e, pitch: r(e.pitch), roll: r(e.roll), yaw: r(e.yaw), ...(e.rates ? { rates: e.rates.map(r) as [number, number, number] } : {}) };
}

/** Export as an `--inputs` file: one `seconds:action` per line, # lines are comments (including a suggested command) */
export function toScript(log: InputLog): string {
  const lines = [`# TryBoard input log v${log.version}${log.firmware ? ' · ' + log.firmware : ''} (simulated clock, seconds)`, `# replay: ${cliArgs(log, '<flash.bin>', '<this file>', log.endMs === undefined ? undefined : Math.floor(log.endMs) / 1000).join(' ')}`];
  for (const e of log.events) {
    const a = action(e);
    if (a !== null) lines.push(`${sec(e.tMs)}:${a}`);
  }
  return lines.join('\n') + '\n';
}

/** The same script on one line (`--script` / levels.json script field / verify-worker) */
export function toScriptInline(log: InputLog): string {
  return log.events.flatMap((e) => (action(e) === null ? [] : [`${sec(e.tMs)}:${action(e)}`])).join('; ');
}

/** Command-line arguments for replay */
export function cliArgs(log: InputLog, fw: string, inputsFile: string, seconds?: number): string[] {
  const a = ['tryboard', 'run', fw];
  if (seconds !== undefined) a.push('--seconds', String(seconds));
  if (log.board) a.push('--board', log.board);
  if (log.grove) a.push('--grove', log.grove);
  if (log.i2c.length) a.push('--i2c', log.i2c.map((d) => `${d.kind}@0x${d.addr.toString(16)}`).join(','));
  const spi = [...(log.lcd || log.spi ? [log.spi ?? 'gc9a01'] : []), ...(rc522Spec(log.parts, log.chip) ? [rc522Spec(log.parts, log.chip)!] : [])];
  if (spi.length) a.push('--spi', spi.join(','));
  a.push(...partsArgs(log.parts));
  if (log.battery) a.push('--battery', `${log.battery.pct}${log.battery.usb ? ',usb' : ''}`);
  if (log.servo !== undefined) a.push('--servo', String(log.servo), '--power', log.power ?? 'usb');
  if (log.encoder) a.push('--encoder', [log.encoder.a, log.encoder.b, ...(log.encoder.sw !== undefined ? [log.encoder.sw] : [])].join(','));
  if (log.sonar) a.push('--sonar', `${log.sonar.trig},${log.sonar.echo}`);
  if (log.dht11 !== undefined) a.push('--dht11', String(log.dht11));
  if (log.touchInt !== undefined) a.push('--touch-int', String(log.touchInt));
  if (log.i2s?.length) a.push('--i2s', log.i2s.join(','));
  if (log.mic) a.push('--mic', `tools/audio/${log.mic}`);
  a.push('--inputs', inputsFile);
  return a;
}

const unesc = (t: string) => t.replaceAll('\\n', '\n');
const num = (v: string | undefined) => {
  const n = Number(v);
  if (v === undefined || v.trim() === '' || !Number.isFinite(n)) throw new Error(`bad number "${v}"`);
  return n;
};

/** Inverse of action(): one script action -> event without tMs; throws on an unknown or malformed action */
export function fromAction(a: string): InputAction {
  if (a === 'release') return { kind: 'touch', down: false, x: 0, y: 0 };
  if (a.startsWith('pc=')) return { kind: 'ble', cmd: a };
  const eq = a.indexOf('=');
  if (eq < 0) throw new Error(`bad action "${a}"`);
  const k = a.slice(0, eq);
  const v = a.slice(eq + 1);
  const g = /^gpio(\d+)$/.exec(k);
  if (g) return { kind: 'gpio', pin: Number(g[1]), level: v === 'z' ? -1 : num(v) };
  const mv = /^mv(\d+)$/.exec(k);
  if (mv) return { kind: 'pot', pin: Number(mv[1]), mv: num(v) };
  const p = v.split(',');
  switch (k) {
    case 'env':
      return { kind: 'env', temp: num(p[0]), humidity: num(p[1]), pressure: num(p[2]) };
    case 'uart':
    case 'usbcdc':
      return { kind: k, text: unesc(v) };
    case 'power':
      if (v === 'usb' || v === 'ext') return { kind: 'supply', mode: v };
      break;
    case 'i2cwire':
      return { kind: 'i2cwire', cm: num(v) };
    case 'antenna':
      return { kind: 'antenna', db: num(v) };
    case 'enc':
      return { kind: 'enc', steps: num(v) };
    case 'encsw':
      return { kind: 'encsw', down: v === '1' };
    case 'dist':
      return { kind: 'dist', cm: num(v) };
    case 'imu': {
      const n = p.map(num);
      if (n.length === 3 || n.length === 6) return { kind: 'imu', pitch: n[0], roll: n[1], yaw: n[2], ...(n.length === 6 ? { rates: [n[3], n[4], n[5]] as [number, number, number] } : {}) };
      break;
    }
    case 'touch':
      return { kind: 'touch', down: true, x: num(p[0]), y: num(p[1]) };
    case 'ble':
      return { kind: 'ble', cmd: v };
    case 'phone':
      return { kind: 'phone', cmd: unesc(v) };
    case 'realnet':
      return { kind: 'realnet', on: v === '1' };
    case 'netreply':
      return { kind: 'netreply', reply: v };
    case 'seed':
      return { kind: 'seed', seed: num(v) >>> 0 };
    case 'net':
      return { kind: 'net', preset: v };
    case 'netfault':
      return { kind: 'netfault', fault: p[0], ...(p.length > 1 ? { dur: num(p[1]) } : {}) };
    case 'adc':
      return { kind: 'adc', ideal: v === 'ideal' };
    case 'bat':
      return { kind: 'bat', pct: num(p[0]), usb: p[1] === 'usb' };
    case 'pwrkey':
      return { kind: 'pwrkey', long: v === 'long' };
    case 'key':
      if (p.length === 2 && (p[1] === '0' || p[1] === '1')) return { kind: 'key', name: p[0], down: p[1] === '1' };
      break;
    case 'pir':
      return { kind: 'pir', on: v.trim() === '1' };
    case 'lux':
      return { kind: 'lux', lux: num(v) };
    case 'card':
      return { kind: 'card', uid: v.trim() };
  }
  throw new Error(`bad action "${a}"`);
}

/** Inverse of toScript / toScriptBody (one `seconds:action` per line) and toScriptInline (`; `-separated); # lines are skipped */
export function fromScript(text: string): InputEvent[] {
  const out: InputEvent[] = [];
  for (const raw of text.includes('\n') ? text.split('\n') : text.split('; ')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.startsWith('#')) continue;
    const c = line.indexOf(':');
    if (c < 0) throw new Error(`bad script line "${line}"`);
    // Scripts carry microseconds: rebuild ms from the integer count so values round-trip exactly
    out.push({ tMs: Math.round(num(line.slice(0, c)) * 1e6) / 1000, ...fromAction(line.slice(c + 1)) } as InputEvent);
  }
  return out;
}

/** Script body without the comment header: one `seconds:action` per line (text payloads escape \n, so a `; ` inside them is safe) */
export function toScriptBody(events: InputEvent[]): string {
  return events.flatMap((e) => (action(e) === null ? [] : [`${sec(e.tMs)}:${action(e)}`])).join('\n');
}
