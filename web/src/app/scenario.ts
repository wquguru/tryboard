// Environment scenario (F-11): keyframed tracks compiled into stamped input events (docs/plan-F/F-11-timeline.md §4).
// Pure module (no DOM, no i18n) so node tests, share state and the worker feed all agree on the same events.
import type { InputEvent } from '../inputlog.ts';

/** Segment shape, held by the segment's left keyframe: s = step, l = linear (default), e = smoothstep */
// Omit that keeps a union a union (plain Omit collapses it to the shared keys)
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Interp = 's' | 'l' | 'e';
export type Kf = [tMs: number, v: number, interp?: Interp];
export type ContKind = 'temp' | 'hum' | 'press' | 'lux' | 'dist';
export type ScenarioTrack =
  | { k: ContKind; on?: false; kf: Kf[] }
  | { k: 'mv'; pin: number; on?: false; kf: Kf[] }
  | { k: 'pir'; on?: false; spans: [startMs: number, endMs: number][] }
  /** up = 1: release drives the pin high (M5 preset keys); default release floats it (BOOT, bench keys) */
  | { k: 'btn'; pin: number; up?: 1; on?: false; presses: [atMs: number, holdMs: number][] }
  | { k: 'net'; on?: false; steps: [tMs: number, preset: string][]; faults: [tMs: number, kind: string, durS?: number][] };
export type TrackKind = ScenarioTrack['k'];

export interface ScenarioV1 {
  /** Total length in ms (integer); every track holds its last value after it */
  len: number;
  /** Order = display order = apply order within one millisecond */
  tracks: ScenarioTrack[];
}

export const SCENARIO_MAX_MS = 600_000;
export const SCENARIO_DEFAULT_MS = 30_000;
/** Continuous tracks are sampled on this grid; one track emits at most once per MIN_GAP_MS (keyframes excepted) */
export const GRID_MS = 10;
export const MIN_GAP_MS = 100;
/** Above this many compiled lines the run no longer fits a share link (shown as a hint) */
export const LINES_LINK_HINT = 2000;

/** Quantization step and range per continuous kind; the quantized number is exactly what action() prints */
export const QUANT: Record<ContKind | 'mv', { step: number; min: number; max: number }> = {
  temp: { step: 0.1, min: -10, max: 45 },
  hum: { step: 1, min: 0, max: 100 },
  press: { step: 1, min: 30000, max: 110000 },
  lux: { step: 1, min: 0, max: 2000 },
  dist: { step: 1, min: 2, max: 400 },
  mv: { step: 1, min: 0, max: 3300 },
};
export const NET_PRESETS = ['normal', 'weak', 'flaky', 'offline'] as const;
export const NET_FAULTS = ['reboot', 'dns', 'silent'] as const;

const decimals = (step: number) => (step < 1 ? Math.round(-Math.log10(step)) : 0);
/** Round to the kind's step and clamp; rounding via toFixed keeps 31.4 instead of 31.400000000000002 */
export function quantize(k: ContKind | 'mv', v: number): number {
  const q = QUANT[k];
  const c = Math.min(q.max, Math.max(q.min, v));
  return Number((Math.round(c / q.step) * q.step).toFixed(decimals(q.step)));
}

/** Value of a keyframe list at t (before the first: its value; after the last: held) */
export function valueAt(kf: Kf[], t: number): number {
  if (!kf.length) return NaN;
  if (t <= kf[0][0]) return kf[0][1];
  for (let i = 0; i < kf.length - 1; i++) {
    const [ta, va, how] = kf[i];
    const [tb, vb] = kf[i + 1];
    if (t >= tb) continue;
    if (how === 's' || tb === ta) return va;
    const u = (t - ta) / (tb - ta);
    return va + (vb - va) * (how === 'e' ? u * u * (3 - 2 * u) : u);
  }
  return kf[kf.length - 1][1];
}

/** Change points of one continuous track: grid samples plus keyframe times, emitted on quantized change, >= MIN_GAP_MS apart */
function contChanges(k: ContKind | 'mv', kf: Kf[], len: number): [number, number][] {
  const keys = kf.map((x) => x[0]).filter((t) => t <= len);
  if (!keys.length) return [];
  const times = new Set<number>(keys);
  for (let i = 0; i * GRID_MS <= len; i++) times.add(i * GRID_MS);
  const isKey = new Set(keys);
  const out: [number, number][] = [];
  let last = NaN;
  let lastT = -Infinity;
  for (const t of [...times].sort((a, b) => a - b)) {
    const q = quantize(k, valueAt(kf, t));
    if (q === last) continue;
    if (!isKey.has(t) && t - lastT < MIN_GAP_MS) continue;
    out.push([t, q]);
    last = q;
    lastT = t;
  }
  return out;
}

/** Bench facts a scenario compiles against: which tracks have their part (others are skipped, never faked) */
export interface ScenarioBench {
  /** Track keys that exist on the bench: 'temp', 'lux', 'mv:1', 'btn:9'… (trackKey) */
  has: Set<string>;
}
export const trackKey = (tr: ScenarioTrack | { k: TrackKind; pin?: number }) => ('pin' in tr && tr.pin !== undefined ? `${tr.k}:${tr.pin}` : tr.k);

/** Room environment the env tracks fill missing components from (power-up snapshot) */
export interface Room {
  temp: number;
  humidity: number;
  pressure: number;
}

/** Scenario -> input events sorted by time (stable: track order, then time within a track). Deterministic */
export function compileScenario(sc: ScenarioV1, room: Room, bench?: ScenarioBench): InputEvent[] {
  const len = Math.min(SCENARIO_MAX_MS, Math.max(0, Math.round(sc.len)));
  const evs: { t: number; o: number; s: number; e: InputEvent }[] = [];
  let seq = 0;
  const push = (t: number, o: number, e: DistOmit<InputEvent, 'tMs'>) => evs.push({ t, o, s: seq++, e: { tMs: t, ...e } as InputEvent });
  const live = sc.tracks.filter((tr) => tr.on !== false && (!bench || bench.has.has(trackKey(tr))));
  // env = temp / hum / press merged: one line per union change time, ordered at the first env track's position
  const envTracks = live.filter((tr): tr is Extract<ScenarioTrack, { k: ContKind }> => tr.k === 'temp' || tr.k === 'hum' || tr.k === 'press');
  if (envTracks.length) {
    const o = live.indexOf(envTracks[0]);
    const per = { temp: [] as [number, number][], hum: [] as [number, number][], press: [] as [number, number][] };
    for (const tr of envTracks) per[tr.k as 'temp' | 'hum' | 'press'] = contChanges(tr.k, tr.kf, len);
    const cur = { temp: quantize('temp', room.temp), hum: Math.round(room.humidity), press: Math.round(room.pressure) };
    const at = new Map<number, Partial<typeof cur>>();
    for (const k of ['temp', 'hum', 'press'] as const) for (const [t, v] of per[k]) at.set(t, { ...at.get(t), [k]: v });
    for (const t of [...at.keys()].sort((a, b) => a - b)) {
      Object.assign(cur, at.get(t));
      push(t, o, { kind: 'env', temp: cur.temp, humidity: cur.hum, pressure: cur.press });
    }
  }
  live.forEach((tr, o) => {
    switch (tr.k) {
      case 'lux':
        for (const [t, v] of contChanges('lux', tr.kf, len)) push(t, o, { kind: 'lux', lux: v });
        break;
      case 'dist':
        for (const [t, v] of contChanges('dist', tr.kf, len)) push(t, o, { kind: 'dist', cm: v });
        break;
      case 'mv':
        for (const [t, v] of contChanges('mv', tr.kf, len)) push(t, o, { kind: 'pot', pin: tr.pin, mv: v });
        break;
      case 'pir':
        for (const [a, b] of tr.spans) {
          if (a > len) continue;
          push(a, o, { kind: 'pir', on: true });
          if (b <= len) push(b, o, { kind: 'pir', on: false });
        }
        break;
      case 'btn':
        for (const [a, hold] of tr.presses) {
          if (a > len) continue;
          push(a, o, { kind: 'gpio', pin: tr.pin, level: 0 });
          if (a + hold <= len) push(a + hold, o, { kind: 'gpio', pin: tr.pin, level: tr.up ? 1 : -1 });
        }
        break;
      case 'net':
        for (const [t, p] of tr.steps) if (t <= len) push(t, o, { kind: 'net', preset: p });
        for (const [t, f, d] of tr.faults) if (t <= len) push(t, o, { kind: 'netfault', fault: f, ...(d !== undefined ? { dur: d } : {}) });
        break;
    }
  });
  evs.sort((a, b) => a.t - b.t || a.o - b.o || a.s - b.s);
  return evs.map((x) => x.e);
}

const int = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= SCENARIO_MAX_MS;
const fin = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const isArr = Array.isArray;

/** Validate untrusted JSON (share links, pasted JSON) and return a normalized copy: sorted keyframes, non-overlapping presses */
export function parseScenario(raw: unknown): ScenarioV1 {
  const bad = (what: string): never => {
    throw new Error(`bad scenario: ${what}`);
  };
  if (!raw || typeof raw !== 'object' || isArr(raw)) bad('not an object');
  const r = raw as Record<string, unknown>;
  if (!int(r.len) || (r.len as number) < 1000) bad('len');
  if (!isArr(r.tracks) || r.tracks.length > 32) bad('tracks');
  const tracks = (r.tracks as unknown[]).map((x, i): ScenarioTrack => {
    if (!x || typeof x !== 'object') bad(`track ${i}`);
    const tr = x as Record<string, unknown>;
    const on = tr.on === false ? { on: false as const } : {};
    if (tr.on !== undefined && tr.on !== false) bad(`track ${i} on`);
    const pin = () => (Number.isInteger(tr.pin) && (tr.pin as number) >= 0 && (tr.pin as number) < 64 ? (tr.pin as number) : bad(`track ${i} pin`));
    const kfs = (k: ContKind | 'mv') => {
      if (!isArr(tr.kf) || tr.kf.length > 400) bad(`track ${i} kf`);
      const kf = (tr.kf as unknown[]).map((f) => {
        if (!isArr(f) || !int(f[0]) || !fin(f[1]) || (f[2] !== undefined && !['s', 'l', 'e'].includes(f[2]))) bad(`track ${i} keyframe`);
        const a = f as [number, number, Interp?];
        return (a[2] && a[2] !== 'l' ? [a[0], quantize(k, a[1]), a[2]] : [a[0], quantize(k, a[1])]) as Kf;
      });
      return dedupe(kf.sort((a, b) => a[0] - b[0]));
    };
    switch (tr.k) {
      case 'temp':
      case 'hum':
      case 'press':
      case 'lux':
      case 'dist':
        return { k: tr.k, ...on, kf: kfs(tr.k) };
      case 'mv':
        return { k: 'mv', pin: pin(), ...on, kf: kfs('mv') };
      case 'pir': {
        if (!isArr(tr.spans) || tr.spans.length > 400) bad(`track ${i} spans`);
        const sp = (tr.spans as unknown[]).map((s) => (isArr(s) && int(s[0]) && int(s[1]) && s[1] > s[0] ? ([s[0], s[1]] as [number, number]) : bad(`track ${i} span`)));
        return { k: 'pir', ...on, spans: noOverlap(sp.sort((a, b) => a[0] - b[0]).map(([a, b]) => [a, b - a])).map(([a, d]) => [a, a + d]) };
      }
      case 'btn': {
        if (!isArr(tr.presses) || tr.presses.length > 400) bad(`track ${i} presses`);
        const ps = (tr.presses as unknown[]).map((p) => (isArr(p) && int(p[0]) && int(p[1]) && p[1] >= 1 ? ([p[0], p[1]] as [number, number]) : bad(`track ${i} press`)));
        return { k: 'btn', pin: pin(), ...(tr.up === 1 ? { up: 1 as const } : {}), ...on, presses: noOverlap(ps.sort((a, b) => a[0] - b[0])) };
      }
      case 'net': {
        if (!isArr(tr.steps) || !isArr(tr.faults) || tr.steps.length > 200 || tr.faults.length > 200) bad(`track ${i} net`);
        const steps = (tr.steps as unknown[]).map((s) => (isArr(s) && int(s[0]) && (NET_PRESETS as readonly unknown[]).includes(s[1]) ? ([s[0], s[1]] as [number, string]) : bad(`track ${i} step`)));
        const faults = (tr.faults as unknown[]).map((x) => {
          const f = x as unknown[];
          if (!isArr(x) || !int(f[0]) || !(NET_FAULTS as readonly unknown[]).includes(f[1]) || (f[2] !== undefined && !(int(f[2]) && (f[2] as number) <= 600))) bad(`track ${i} fault`);
          return (f[2] === undefined ? [f[0], f[1]] : [f[0], f[1], f[2]]) as [number, string, number?];
        });
        return { k: 'net', ...on, steps: steps.sort((a, b) => a[0] - b[0]), faults: faults.sort((a, b) => a[0] - b[0]) };
      }
    }
    return bad(`track ${i} kind`);
  });
  return { len: r.len as number, tracks };
}
/** One keyframe per millisecond (the later wins) */
const dedupe = (kf: Kf[]) => kf.filter((f, i) => i === kf.length - 1 || kf[i + 1][0] !== f[0]);
/** Drop presses / spans that start before the previous one ended */
function noOverlap(ps: [number, number][]) {
  const out: [number, number][] = [];
  for (const p of ps) if (!out.length || p[0] > out[out.length - 1][0] + out[out.length - 1][1]) out.push(p);
  return out;
}

/** Which tracks the bench offers: room temperature always; others only with their part (DESIGN_V2 §4: no fake data) */
export function benchTracks(parts: { type: string; pin?: number }[], bootPin: number, net: boolean, board?: boolean): { k: TrackKind; pin?: number }[] {
  const has = (t: string) => parts.some((p) => p.type === t);
  const out: { k: TrackKind; pin?: number }[] = [{ k: 'temp' }];
  if (has('bme280') || has('dht11') || board) out.push({ k: 'hum' });
  if (has('bme280') || board) out.push({ k: 'press' });
  if (has('ldr')) out.push({ k: 'lux' });
  if (has('hcsr04')) out.push({ k: 'dist' });
  for (const p of parts) if (p.type === 'pot' && p.pin !== undefined) out.push({ k: 'mv', pin: p.pin });
  if (has('pir')) out.push({ k: 'pir' });
  out.push({ k: 'btn', pin: bootPin });
  for (const p of parts) if (p.type === 'key' && p.pin !== undefined && p.pin !== bootPin) out.push({ k: 'btn', pin: p.pin });
  if (net) out.push({ k: 'net' });
  return out;
}

/** Empty track of a kind (continuous tracks start with one keyframe at 0 holding the current value) */
export function newTrack(k: TrackKind, pin: number | undefined, v0: number): ScenarioTrack {
  switch (k) {
    case 'mv':
      return { k, pin: pin ?? 0, kf: [[0, quantize('mv', v0)]] };
    case 'pir':
      return { k, spans: [] };
    case 'btn':
      return { k, pin: pin ?? 0, presses: [] };
    case 'net':
      return { k, steps: [], faults: [] };
    default:
      return { k, kf: [[0, quantize(k, v0)]] };
  }
}

export type PresetId = 'ac' | 'warm' | 'sunset' | 'walk' | 'flaky' | 'silent' | 'short' | 'long' | 'double';
export const PRESETS: { id: PresetId; needs: TrackKind[] }[] = [
  { id: 'ac', needs: ['temp'] },
  { id: 'warm', needs: ['temp'] },
  { id: 'sunset', needs: ['lux'] },
  { id: 'walk', needs: ['pir', 'dist'] },
  { id: 'flaky', needs: ['net'] },
  { id: 'silent', needs: ['net'] },
  { id: 'short', needs: ['btn'] },
  { id: 'long', needs: ['btn'] },
  { id: 'double', needs: ['btn'] },
];

/** Apply a preset at `at` ms: continuous tracks are replaced, presses / spans / net events are added. Grows len when needed */
export function applyPreset(sc: ScenarioV1, id: PresetId, at: number, offered: { k: TrackKind; pin?: number }[]): ScenarioV1 {
  const tracks = sc.tracks.map((x) => structuredClone(x));
  const get = <K extends TrackKind>(k: K): Extract<ScenarioTrack, { k: K }> | null => {
    let tr = tracks.find((x) => x.k === k) as Extract<ScenarioTrack, { k: K }> | undefined;
    if (!tr) {
      const o = offered.find((x) => x.k === k);
      if (!o) return null;
      tr = newTrack(k, o.pin, 0) as Extract<ScenarioTrack, { k: K }>;
      tracks.push(tr);
    }
    return tr;
  };
  const a = Math.round(at);
  let end = a;
  const cont = (k: ContKind, kf: Kf[]) => {
    const tr = get(k);
    if (!tr) return;
    tr.kf = kf.map(([t, v, h]) => (h ? [a + t, quantize(k, v), h] : [a + t, quantize(k, v)]) as Kf);
    end = Math.max(end, a + kf[kf.length - 1][0]);
  };
  const press = (ps: [number, number][]) => {
    const tr = get('btn');
    if (!tr) return;
    tr.presses = noOverlap([...tr.presses, ...ps.map(([t, h]) => [a + t, h] as [number, number])].sort((x, y) => x[0] - y[0]));
    end = Math.max(end, a + ps[ps.length - 1][0] + ps[ps.length - 1][1]);
  };
  switch (id) {
    case 'ac':
      cont('temp', [[0, 30, 'e'], [20000, 24]]);
      break;
    case 'warm':
      cont('temp', [[0, 24], [20000, 35]]);
      break;
    case 'sunset':
      cont('lux', [[0, 800, 'e'], [10000, 2], [20000, 2, 'e'], [30000, 800]]);
      break;
    case 'walk': {
      const pir = get('pir');
      if (pir) {
        pir.spans = [...pir.spans, [a + 1000, a + 4000] as [number, number]].sort((x, y) => x[0] - y[0]);
        end = Math.max(end, a + 4000);
      }
      cont('dist', [[0, 200], [1000, 200], [2500, 60], [4000, 200]]);
      break;
    }
    case 'flaky': {
      const n = get('net');
      if (n) {
        n.steps = [...n.steps, [a, 'flaky'] as [number, string], [a + 20000, 'normal'] as [number, string]].sort((x, y) => x[0] - y[0]);
        end = Math.max(end, a + 20000);
      }
      break;
    }
    case 'silent': {
      const n = get('net');
      if (n) {
        n.faults = [...n.faults, [a, 'silent', 5] as [number, string, number]].sort((x, y) => x[0] - y[0]);
        end = Math.max(end, a + 5000);
      }
      break;
    }
    case 'short':
      press([[0, 150]]);
      break;
    case 'long':
      press([[0, 3000]]);
      break;
    case 'double':
      press([[0, 120], [250, 120]]);
      break;
  }
  return { len: Math.min(SCENARIO_MAX_MS, Math.max(sc.len, Math.ceil(end / 1000) * 1000)), tracks };
}

/** Export file of the whole scenario (comment header + `seconds:action` lines; # lines are skipped by CLI and fromScript) */
export function scenarioHeader(len: number) {
  return `# tryboard scenario, ${(len / 1000).toFixed(3)} s\n# suggested: --seconds ${len / 1000}\n`;
}

/** One scenario edit as a bench timeline step (F-11c): before and after, so undo needs no snapshot */
export interface ScenarioEdit {
  k: 'scenario';
  sc: ScenarioV1 | null;
  prev: ScenarioV1 | null;
  label: string;
  /** The edit touched time already run, so the live run needs a restart to match it */
  stale?: boolean;
}

/** Scenario in force after step i: the last edit at or before i, else what the first later edit replaced; undefined = never edited */
export function scenarioAt(ops: { k: string }[], i: number): ScenarioV1 | null | undefined {
  for (let j = Math.min(i, ops.length - 1); j >= 0; j--) if (ops[j].k === 'scenario') return (ops[j] as ScenarioEdit).sc;
  for (let j = Math.max(0, i + 1); j < ops.length; j++) if (ops[j].k === 'scenario') return (ops[j] as ScenarioEdit).prev;
  return undefined;
}

/** Whether step i's scenario needs a restart: the last edit since the run began changed its past */
export function scenarioStaleAt(ops: { k: string }[], i: number): boolean {
  for (let j = Math.min(i, ops.length - 1); j >= 0; j--) {
    if (ops[j].k === 'run') return false;
    if (ops[j].k === 'scenario') return !!(ops[j] as ScenarioEdit).stale;
  }
  return false;
}

// ---- Timeline zoom (F-11d): button steps, pinch and ctrl / ⌘ + wheel share these
export const ZOOMS = [1, 2, 4, 8, 16, 32];
export const ZOOM_MIN = ZOOMS[0];
export const ZOOM_MAX = ZOOMS[ZOOMS.length - 1];
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** Next button step from a possibly continuous zoom (pinch leaves values between steps); undefined at the end */
export function zoomStep(z: number, dir: 1 | -1): number | undefined {
  return dir > 0 ? ZOOMS.find((s) => s > z + 1e-6) : [...ZOOMS].reverse().find((s) => s < z - 1e-6);
}

/** Pinch: zoom scales with the finger distance, continuous, clamped to 1–32× */
export function pinchZoom(z0: number, d0: number, d: number): number {
  return clampZoom((z0 * d) / Math.max(1, d0));
}

/** Wheel with ctrl / ⌘ (also what trackpad pinches send): one notch of 100 px ≈ ×1.65 */
export function wheelZoom(z: number, deltaY: number): number {
  return clampZoom(z * Math.exp(-deltaY * 0.005));
}

/** scrollLeft that keeps lane fraction `frac` (a moment in the script) under `px` from the viewport's left edge */
export function anchorScroll(frac: number, laneW: number, px: number, viewW: number): number {
  return Math.max(0, Math.min(Math.max(0, laneW - viewW), frac * laneW - px));
}

/** Label for the zoom readout: integers as is, pinch values with one decimal */
export function zoomLabel(z: number): string {
  return Math.abs(z - Math.round(z)) < 0.05 ? String(Math.round(z)) : z.toFixed(1);
}
