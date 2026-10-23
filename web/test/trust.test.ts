// G-08: trust levels never overclaim. Simulated / behavioural needs a web model (read from the repo here),
// preset items boards.rs notes as inferred stay "needs real hardware".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADVISOR_RUN, BEHV, PART_CONF, REAL, SIMV, trustProblems, type Claim, type Runnable } from '../src/trust.ts';
import { PARTS } from '../src/advisor/data.ts';
import { exampleOnly } from '../src/advisor/catalogmap.ts';
import { resolve, trustRows } from '../src/advisor/derive.ts';
import { EMPTY } from '../src/advisor/state.ts';
import { BOARD_DEVS, PRESET_BOARDS } from '../src/bench3d/boarddevs.ts';

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const BOARDS_RS = read('core/crates/machine/src/boards.rs');

function runnable(): Runnable {
  const kind = /const KIND[^{]*\{([^}]*)\}/.exec(read('web/src/i2cdevs.ts'))![1];
  const web = new Set([...kind.matchAll(/(\w+):/g)].map((m) => m[1]));
  const examples = JSON.parse(read('firmware/examples.json')) as { scene?: { parts?: { type: string }[] } }[];
  for (const e of examples) for (const p of e.scene?.parts ?? []) web.add(p.type);
  // Preset and Grove devices: the web attaches them through tb_board_preset / tb_grove
  for (const m of BOARDS_RS.matchAll(/\("([a-z0-9]+)", 0x[0-9a-f]+\)/g)) web.add(m[1]);
  const make = /pub fn make_i2c[\s\S]*?_ => return None/.exec(read('core/crates/soc/src/devices/mod.rs'))![0];
  const cli = new Set([...make.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]));
  return { web, cli };
}

const LEVEL = { full: SIMV, partial: BEHV, none: REAL } as const;
function claims(): Claim[] {
  const adv = Object.values(PARTS).map((p) => {
    const run = ADVISOR_RUN[p.id];
    return { where: `advisor ${p.id}`, level: exampleOnly(p.id) ? BEHV : LEVEL[p.simulated], run, bench: run?.model ? PART_CONF[run.model] : undefined };
  });
  const bench = Object.entries(PART_CONF)
    .filter(([k]) => k !== 'board')
    .map(([k, level]) => ({ where: `bench ${k}`, level, run: { on: 'web' as const, model: k } }));
  return [...adv, ...bench];
}

test('every advisor part has a run entry', () => {
  assert.deepEqual(Object.keys(PARTS).filter((id) => !ADVISOR_RUN[id]), []);
});

test('no part claims simulated / behavioural without a web model', () => {
  assert.deepEqual(trustProblems(claims(), runnable()), []);
});

test('a CLI-only part marked simulated is reported', () => {
  const r = runnable();
  const cliOnly = [...r.cli].filter((k) => !r.web.has(k));
  assert.ok(cliOnly.length > 0, 'expected at least one CLI-only device');
  const bad: Claim[] = [
    { where: 'advisor fake-cli', level: SIMV, run: { on: 'cli', model: cliOnly[0] } },
    { where: 'advisor fake-web', level: BEHV, run: { on: 'web', model: cliOnly[0] } },
  ];
  const out = trustProblems([...claims(), ...bad], r);
  assert.ok(out.some((x) => x.startsWith('advisor fake-cli: claims')), out.join('\n'));
  assert.ok(out.some((x) => x.startsWith('advisor fake-web: marked web')), out.join('\n'));
});

test('a claim above the bench level is reported', () => {
  const out = trustProblems([{ where: 'advisor buzzer', level: SIMV, run: { on: 'web', model: 'buzzer' }, bench: BEHV }], runnable());
  assert.equal(out.length, 1);
});

test('result card caps a CLI-only part to real hardware and says the CLI can run it', () => {
  const r = resolve({ ...EMPTY, t: 'weather' });
  const keep = ADVISOR_RUN.bme280;
  ADVISOR_RUN.bme280 = { on: 'cli', model: 'bme280' };
  try {
    const row = trustRows(r.plan!, r.need).find(([k]) => k.startsWith(PARTS.bme280.name))!;
    assert.equal(row[1], REAL);
    assert.match(row[0], /command line can simulate/);
  } finally {
    ADVISOR_RUN.bme280 = keep;
  }
});

test('preset items boards.rs notes as inferred / unverified need a real board on the web', () => {
  const presets = [...BOARDS_RS.matchAll(/id: "([a-z0-9]+)",([\s\S]*?)note: "(.*?)",/g)].map((m) => ({ id: m[1], verified: /verified: true/.test(m[2]), note: m[3] }));
  const ids = new Set(presets.map((p) => p.id));
  assert.deepEqual(PRESET_BOARDS.filter((id) => !ids.has(id)), []);
  for (const p of presets.filter((x) => (PRESET_BOARDS as string[]).includes(x.id))) {
    const d = BOARD_DEVS[p.id as keyof typeof BOARD_DEVS];
    if (/inferred|assumed|unchecked|heuristic|estimated/.test(p.note)) assert.ok(d.check?.length, `${p.id}: note "${p.note}" needs a check entry`);
    assert.equal(!!d.unverified, !p.verified, `${p.id}: unverified flag differs from boards.rs`);
  }
});
