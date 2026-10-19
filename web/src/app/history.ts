// 实验台时间线（P0-03）：每一步是一次编辑操作或一次运行；点回某一步 = 回到那一刻。
// 不存模拟快照：编辑状态（场景、供电、环境、热源、改接线、验收结果）由步骤日志折叠出来；
// 模拟器状态靠确定性——用那次运行的固件和输入日志重新上电，按原来的模拟时刻施加输入，快进到那一刻停住。
// 回退以后再做新操作，后面的步骤丢掉（和编辑器的撤销分支一样）。
// 本文件上半部分是纯函数（web/test/history.test.ts 测），下半部分把它接到 Session 上。
import type { SceneSpec } from '../board3d';
import type { InputEvent } from '../inputlog';
import type { Snapshot } from '../worker';
import type { CheckOutcome, Env } from './types';
import type { WireMods } from './wiring.ts';

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
  /** 欠压复位（P1-02）：模拟器报告的事件，不是用户操作；回退到它 = 回到复位那一刻 */
  | { k: 'brownout'; tSec: number; v3v3: number | null; count?: number };

export interface BenchStep {
  op: BenchOp;
  /** 发生在第几次运行里（运行步骤自己 = 它的编号；第一次上电前的放零件 / 连线算第 1 次运行的 0 ms） */
  run: number;
  /** 发生时的模拟时刻（毫秒，worker 盖的，与输入日志同一把尺子）；null = 还没拿到 */
  tMs: number | null;
}

/** 一次运行（一次上电）：回退要的全部输入 */
export interface RunRec {
  n: number;
  fwName: string;
  fw: ArrayBuffer;
  chip: 'esp32' | 'esp32c3' | 'esp32s3';
  /** 上电时的供电、热源（只是显示状态） */
  ext5v: boolean;
  heat: string | null;
  /** 收尾时的记录（日志、串口全文、观察记录）；null = 还在跑 */
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

/** 折叠前 i 步（含）得到的编辑状态；null 字段 = 这段日志里没改过，用初始值 */
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

/**
 * 回到第 i 步 = 第 i 步做完、第 i+1 步还没发生的那一刻：同一次运行里下一步的时刻；
 * 下一步属于别的运行（或没有下一步），就是这次运行收尾的时刻。
 */
export function seekTarget(steps: BenchStep[], i: number, runEndMs: (n: number) => number | null): { run: number; untilMs: number } | null {
  const s = steps[i];
  if (!s) return null;
  const next = steps[i + 1];
  if (next && next.run === s.run && next.tMs !== null) return { run: s.run, untilMs: next.tMs };
  const end = runEndMs(s.run);
  return end === null ? null : { run: s.run, untilMs: end };
}

/** 回退重放用的输入：去掉上电事件和上电时的那条环境（它由上电参数给） */
export function replayInputs(events: InputEvent[]): { env0: Env | null; events: InputEvent[] } {
  const rest = events.filter((e) => e.kind !== 'power');
  const first = rest[0];
  if (first && first.kind === 'env') return { env0: { temp: first.temp, humidity: first.humidity, pressure: first.pressure }, events: rest.slice(1) };
  return { env0: null, events: rest };
}

/** 截断：停在 cur 时做新操作，cur 以后的步骤和只在那些步骤里出现的运行都丢掉 */
export function truncate(steps: BenchStep[], runs: RunRec[], cur: number): { steps: BenchStep[]; runs: RunRec[] } {
  const kept = steps.slice(0, cur + 1);
  const last = kept.reduce((m, s) => Math.max(m, s.run), 0);
  return { steps: kept, runs: runs.filter((r) => r.n <= last) };
}

/** 运行的结果一行：weather 的最后一行读数，否则最后一行非空输出 */
export function runResult(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const reading = [...lines].reverse().find((l) => /^T=-?[\d.]+ C/.test(l));
  const last = reading ?? lines[lines.length - 1] ?? '（没有串口输出）';
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
    env0: ev ? envText(ev.env0) : '（运行中）',
    envChanges: ev ? ev.events.filter((e) => e.kind === 'env').length : 0,
    power: r.ext5v ? 'USB 和外接 5 V' : '只有 USB 5 V',
    heat: r.heat ? `热源靠近 ${r.heat === 'bme280' ? 'BME280' : r.heat}` : '无',
    seconds: r.snap ? `${r.snap.simSeconds.toFixed(2)} s` : '运行中',
    fingerprint: r.fingerprint ?? '（运行中，收尾后算）',
    result: r.snap ? runResult(r.snap.stdout) : '运行中',
  };
}

export const SUMMARY_ROWS: [keyof RunSummary, string][] = [
  ['fw', '固件'],
  ['env0', '上电时环境'],
  ['envChanges', '运行中改环境'],
  ['power', '供电'],
  ['heat', '热源'],
  ['seconds', '模拟时长'],
  ['result', '最后一行'],
  ['fingerprint', '运行编号'],
];

/** 两次运行的差异项（哪一项变了） */
export function diffRuns(a: RunSummary, b: RunSummary): { key: keyof RunSummary; label: string; a: string; b: string; changed: boolean }[] {
  return SUMMARY_ROWS.map(([key, label]) => ({ key, label, a: String(a[key]), b: String(b[key]), changed: String(a[key]) !== String(b[key]) }));
}
