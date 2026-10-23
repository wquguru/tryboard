// Trust levels a part may claim (G-08): 仿真验证 / 行为模拟 only when the web page runs it (wasm model plus an example or work);
// a part only the CLI models stays 必须上真机 with a "command line can simulate" note. No React here: tests import it.
import type { ConfLevel } from './ui/conf';

export const [SIMV, BEHV, EST, REAL] = ['仿真验证', '行为模拟', '估算', '必须上真机'] as const satisfies readonly ConfLevel[]; // lint: allow-cjk

/** Where a part's model runs: web = wasm model and a web example / work, cli = native runner only, none = no model */
export type RunsOn = 'web' | 'cli' | 'none';
export interface PartRun {
  on: RunsOn;
  /** Model name: an example scene part type (firmware/examples.json) or a core device kind (make_i2c) */
  model?: string;
}

/** Advisor part id (advisor/data.ts PARTS) -> where its model runs; checked against the repo by test/trust.test.ts */
export const ADVISOR_RUN: Record<string, PartRun> = {
  led: { on: 'web', model: 'led' },
  button: { on: 'web', model: 'key' },
  pot: { on: 'web', model: 'pot' },
  servo: { on: 'web', model: 'servo' },
  ws2812: { on: 'web', model: 'ws2812' },
  oled: { on: 'web', model: 'oled' },
  bme280: { on: 'web', model: 'bme280' },
  tft: { on: 'web', model: 'tft' },
  mic: { on: 'web', model: 'inmp441' },
  amp: { on: 'web', model: 'max98357a' },
  buzzer: { on: 'web', model: 'buzzer' },
  relay: { on: 'web', model: 'relay' },
  dht11: { on: 'web', model: 'dht11' },
  pir: { on: 'web', model: 'pir' },
  battery: { on: 'none' },
  aht20: { on: 'web', model: 'aht20' },
  rc522: { on: 'web', model: 'rc522' },
  irrx: { on: 'web', model: 'irrx' },
  irled: { on: 'web', model: 'irled' },
  camera: { on: 'none' },
};

/** Per-part confidence on the bench (bench part types); rationale per peripheral in docs/STATUS.md */
export const PART_CONF: Record<string, ConfLevel> = {
  board: SIMV,
  bme280: SIMV,
  oled: SIMV,
  gc9a01: SIMV,
  tft: SIMV,
  pot: SIMV,
  led: SIMV,
  key: SIMV,
  encoder: SIMV,
  servo: BEHV,
  buzzer: BEHV,
  hcsr04: BEHV,
  mpu6050: BEHV,
  qmi8658: BEHV,
  cst816s: BEHV,
  max98357a: BEHV,
  inmp441: BEHV,
  aht20: SIMV,
  ds3231: SIMV,
  // Current comes from the electrical model's estimate of the board draw
  ina219: BEHV,
};

const RANK: Record<ConfLevel, number> = { [SIMV]: 3, [BEHV]: 2, [EST]: 1, [REAL]: 0 };

/** Cap a declared level by where the model runs: only a web model may claim simulated / behavioural */
export function capConf(c: ConfLevel, on: RunsOn): ConfLevel {
  return on === 'web' || RANK[c] < RANK[BEHV] ? c : REAL;
}

export interface Claim {
  /** Table and key, for the report */
  where: string;
  level: ConfLevel;
  run: PartRun;
  /** Bench level of the same part, when one exists: a claim may not exceed it */
  bench?: ConfLevel;
}

/** What the repo actually runs: web = example scene types, wasm I2C kinds, preset and Grove devices; cli = make_i2c kinds */
export interface Runnable {
  web: Set<string>;
  cli: Set<string>;
}

/** Overclaims: simulated / behavioural without a web model, a run table that disagrees with the repo, or above the bench level */
export function trustProblems(claims: Claim[], r: Runnable): string[] {
  const out: string[] = [];
  for (const c of claims) {
    const m = c.run.model;
    if (c.run.on === 'web' && (!m || !r.web.has(m))) out.push(`${c.where}: marked web but "${m}" has no web model or example`);
    if (c.run.on === 'cli' && (!m || !r.cli.has(m))) out.push(`${c.where}: marked cli but "${m}" is not a core device`);
    if (c.run.on === 'cli' && m && r.web.has(m)) out.push(`${c.where}: marked cli but "${m}" runs on the web`);
    if (capConf(c.level, c.run.on) !== c.level) out.push(`${c.where}: claims ${c.level} but runs on ${c.run.on}`);
    if (c.bench && RANK[c.level] > RANK[c.bench]) out.push(`${c.where}: claims ${c.level} above the bench level ${c.bench}`);
  }
  return out;
}
