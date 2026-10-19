// Bench timeline (P0-03): no sim snapshots. Edit state is folded from the step log; sim state is rebuilt
// deterministically by re-powering with that run's firmware + input log and fast-forwarding. New edits after a rewind drop later steps.
import type { SceneSpec } from '../board3d';
import type { InputEvent } from '../inputlog';
import type { Snapshot } from '../simmsg';
import type { CheckOutcome, Env } from './types';
import type { WireMods } from './wiring.ts';
import { t } from '../i18n/index.ts';

export type BenchOp =
  | { k: 'place'; label: string }
  | { k: 'wire' }
  | { k: 'scene'; scene: SceneSpec; power: { ext5v: boolean } | null; count: number; label?: string }
  | { k: 'run'; n: number }
  | { k: 'env'; env: Env }
  | { k: 'heat'; part: string | null; env: Env }
  | { k: 'power'; ext5v: boolean }
  | { k: 'wiring'; mods: WireMods; scene?: SceneSpec; label: string }
  | { k: 'check'; id: string; outcome: CheckOutcome }
  /** Brownout reset (P1-02): reported by the sim, not a user op; rewinding to it lands on the reset moment. */
  | { k: 'brownout'; tSec: number; v3v3: number | null; count?: number };

export interface BenchStep {
  op: BenchOp;
  /** Run number it belongs to; edits before the first power-on count as run 1 at 0 ms. */
  run: number;
  /** Sim time in ms stamped by the worker (same clock as the input log); null = not known yet. */
  tMs: number | null;
}

/** One run (one power-on): everything a rewind needs. */
export interface RunRec {
  n: number;
  fwName: string;
  fw: ArrayBuffer;
  chip: 'esp32' | 'esp32c3' | 'esp32s3';
  /** Power and heat source at power-on (display only). */
  ext5v: boolean;
  heat: string | null;
  /** Final record (log, full serial, observations); null = still running. */
  snap: Snapshot | null;
  fingerprint: string | null;
}

export interface Folded {
  scene: SceneSpec | null;
  power: { ext5v: boolean } | null;
  env: Env | null;
  heat: string | null;
  mods: WireMods | null;
  checks: Record<string, CheckOutcome>;
}

/** Edit state after steps 0..i; null fields were never changed, so the caller uses initial values. */
export function fold(steps: BenchStep[], i: number): Folded {
  const f: Folded = { scene: null, power: null, env: null, heat: null, mods: null, checks: {} };
  for (let k = 0; k <= i && k < steps.length; k++) {
    const op = steps[k].op;
    if (op.k === 'scene') {
      f.scene = op.scene;
      f.power = op.power;
    } else if (op.k === 'env') f.env = op.env;
    else if (op.k === 'heat') {
      f.heat = op.part;
      f.env = op.env;
    } else if (op.k === 'power') f.power = { ext5v: op.ext5v };
    else if (op.k === 'wiring') {
      f.mods = op.mods;
      if (op.scene) f.scene = op.scene;
    } else if (op.k === 'check') f.checks = { ...f.checks, [op.id]: op.outcome };
  }
  return f;
}

/** Step i = just before step i+1 happens: the next step's time if in the same run, otherwise this run's end. */
export function seekTarget(steps: BenchStep[], i: number, runEndMs: (n: number) => number | null): { run: number; untilMs: number } | null {
  const s = steps[i];
  if (!s) return null;
  const next = steps[i + 1];
  if (next && next.run === s.run && next.tMs !== null) return { run: s.run, untilMs: next.tMs };
  const end = runEndMs(s.run);
  return end === null ? null : { run: s.run, untilMs: end };
}

/** Replay inputs: drop power events and the boot-time env (it is passed as a boot parameter). */
export function replayInputs(events: InputEvent[]): { env0: Env | null; events: InputEvent[] } {
  const rest = events.filter((e) => e.kind !== 'power');
  const first = rest[0];
  if (first && first.kind === 'env') return { env0: { temp: first.temp, humidity: first.humidity, pressure: first.pressure }, events: rest.slice(1) };
  return { env0: null, events: rest };
}

/** A new edit at cur drops later steps and runs that only appear in them. */
export function truncate(steps: BenchStep[], runs: RunRec[], cur: number): { steps: BenchStep[]; runs: RunRec[] } {
  const kept = steps.slice(0, cur + 1);
  const last = kept.reduce((m, s) => Math.max(m, s.run), 0);
  return { steps: kept, runs: runs.filter((r) => r.n <= last) };
}

/** One-line run result: weather's last reading, else the last non-empty line. */
export function runResult(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const reading = [...lines].reverse().find((l) => /^T=-?[\d.]+ C/.test(l));
  const last = reading ?? lines[lines.length - 1] ?? t('(no serial output)');
  return last.length > 72 ? last.slice(0, 71) + '…' : last;
}

export interface RunSummary {
  n: number;
  fw: string;
  env0: string;
  envChanges: number;
  power: string;
  heat: string;
  seconds: string;
  fingerprint: string;
  result: string;
}

const envText = (e: Env | null) => (e ? `${e.temp.toFixed(1)} °C · ${e.humidity.toFixed(0)} % · ${(e.pressure / 100).toFixed(1)} hPa` : '—');

export function summarize(r: RunRec): RunSummary {
  const ev = r.snap ? replayInputs(r.snap.log.events) : null;
  return {
    n: r.n,
    fw: r.fwName,
    env0: ev ? envText(ev.env0) : t('(running)'),
    envChanges: ev ? ev.events.filter((e) => e.kind === 'env').length : 0,
    power: r.ext5v ? t('USB and external 5 V') : t('USB 5 V only'),
    heat: r.heat ? t('Heat source near {part}', { part: r.heat === 'bme280' ? 'BME280' : r.heat }) : t('None'),
    seconds: r.snap ? `${r.snap.simSeconds.toFixed(2)} s` : t('Running'),
    fingerprint: r.fingerprint ?? t('(running, computed when it ends)'),
    result: r.snap ? runResult(r.snap.stdout) : t('Running'),
  };
}

export const SUMMARY_ROWS: [keyof RunSummary, string][] = [
  ['fw', t('Firmware')],
  ['env0', t('Environment at power-on')],
  ['envChanges', t('Environment changes during run')],
  ['power', t('Power')],
  ['heat', t('Heat source')],
  ['seconds', t('Sim time')],
  ['result', t('Last line')],
  ['fingerprint', t('Run ID')],
];

/** Per-row diff of two runs. */
export function diffRuns(a: RunSummary, b: RunSummary): { key: keyof RunSummary; label: string; a: string; b: string; changed: boolean }[] {
  return SUMMARY_ROWS.map(([key, label]) => ({ key, label, a: String(a[key]), b: String(b[key]), changed: String(a[key]) !== String(b[key]) }));
}
