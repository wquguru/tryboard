// Environment scenario (F-11): compile determinism, quantized round trip through the script format, minimum spacing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromScript, toScriptBody, type InputEvent } from '../src/inputlog.ts';
import { applyPreset, benchTracks, compileScenario, GRID_MS, MIN_GAP_MS, parseScenario, quantize, SCENARIO_MAX_MS, trackKey, valueAt, type ScenarioV1 } from '../src/app/scenario.ts';

const ROOM = { temp: 23.5, humidity: 45, pressure: 101325 };
const SC: ScenarioV1 = {
  len: 30000,
  tracks: [
    { k: 'temp', kf: [[0, 24], [8000, 32, 's'], [18000, 32, 'e'], [28000, 24]] },
    { k: 'hum', kf: [[0, 40], [10000, 60]] },
    { k: 'lux', kf: [[0, 800, 'e'], [10000, 5]] },
    { k: 'dist', kf: [[0, 200], [2000, 60], [4000, 200]] },
    { k: 'mv', pin: 1, kf: [[0, 0], [3000, 3300]] },
    { k: 'pir', spans: [[5000, 8000]] },
    { k: 'btn', pin: 9, presses: [[1500, 150], [12000, 3000]] },
    { k: 'net', steps: [[10000, 'flaky'], [30000, 'normal']], faults: [[20000, 'silent', 5]] },
  ],
};
const keyOf = (e: InputEvent) => (e.kind === 'pot' || e.kind === 'gpio' ? `${e.kind}${e.pin}` : e.kind);

test('compile is deterministic and sorted by integer ms', () => {
  const a = compileScenario(SC, ROOM);
  const b = compileScenario(structuredClone(SC), { ...ROOM });
  assert.deepEqual(a, b);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].tMs >= a[i - 1].tMs);
  assert.ok(a.every((e) => Number.isInteger(e.tMs) && e.tMs >= 0 && e.tMs <= SC.len));
});

test('quantized values round-trip through the --inputs script byte for byte', () => {
  const evs = compileScenario(SC, ROOM);
  const body = toScriptBody(evs);
  assert.deepEqual(fromScript(body), evs);
  assert.equal(toScriptBody(fromScript(body)), body);
  assert.match(body, /^0\.000000:env=24,40,101325$/m);
  // No float noise: temperatures carry at most one decimal, everything else is integral
  assert.doesNotMatch(body, /env=-?\d+\.\d{2,},/);
  assert.doesNotMatch(body, /(lux|dist|mv\d+)=\d+\./);
  assert.equal(quantize('temp', 31.400000001), 31.4);
  assert.equal(quantize('temp', 99), 45);
});

test('one track emits at most once per MIN_GAP_MS except at keyframes', () => {
  const evs = compileScenario(SC, ROOM);
  const keyTimes = new Set(SC.tracks.flatMap((t) => ('kf' in t ? t.kf.map((f) => f[0]) : [])));
  const last = new Map<string, number>();
  for (const e of evs) {
    if (e.kind === "gpio" || e.kind === "pir" || e.kind === "net" || e.kind === "netfault" || e.kind === "env") continue;
    const k = keyOf(e);
    const p = last.get(k);
    if (p !== undefined && !keyTimes.has(e.tMs)) assert.ok(e.tMs - p >= MIN_GAP_MS, `${k} at ${e.tMs} after ${p}`);
    if (!keyTimes.has(e.tMs)) assert.equal(e.tMs % GRID_MS, 0);
    last.set(k, e.tMs);
  }
  // env merges temp / hum / press: each source track on its own keeps the spacing
  for (const tr of SC.tracks.filter((t) => t.k === 'temp' || t.k === 'hum')) {
    const one = compileScenario({ len: SC.len, tracks: [tr] }, ROOM);
    const keys = new Set('kf' in tr ? tr.kf.map((f) => f[0]) : []);
    for (let i = 1; i < one.length; i++) if (!keys.has(one[i].tMs)) assert.ok(one[i].tMs - one[i - 1].tMs >= MIN_GAP_MS, `${tr.k} at ${one[i].tMs}`);
  }
});

test('24 -> 32 ℃ linear over 8 s is about 80 lines, steps only emit the jump', () => {
  const evs = compileScenario({ len: 10000, tracks: [{ k: 'temp', kf: [[0, 24], [8000, 32]] }] }, ROOM);
  assert.ok(evs.length >= 78 && evs.length <= 82, `${evs.length}`);
  const step = compileScenario({ len: 10000, tracks: [{ k: 'temp', kf: [[0, 24, 's'], [5000, 30]] }] }, ROOM);
  assert.deepEqual(step.map((e) => e.tMs), [0, 5000]);
  // env fills missing components from the room snapshot
  assert.deepEqual(step[0], { tMs: 0, kind: 'env', temp: 24, humidity: 45, pressure: 101325 });
});

test('values at keyframes are exact; smoothstep is flat at both ends', () => {
  const evs = compileScenario(SC, ROOM);
  const env8 = evs.find((e) => e.kind === 'env' && e.tMs === 8000);
  assert.ok(env8 && env8.kind === 'env' && env8.temp === 32);
  assert.equal(valueAt([[0, 0, 'e'], [1000, 100]], 500), 50);
  assert.ok(valueAt([[0, 0, 'e'], [1000, 100]], 10) < 0.1);
});

test('buttons press low and float on release; disabled and missing tracks do not compile', () => {
  const evs = compileScenario(SC, ROOM);
  const g = evs.filter((e) => e.kind === 'gpio');
  assert.deepEqual(g, [
    { tMs: 1500, kind: 'gpio', pin: 9, level: 0 },
    { tMs: 1650, kind: 'gpio', pin: 9, level: -1 },
    { tMs: 12000, kind: 'gpio', pin: 9, level: 0 },
    { tMs: 15000, kind: 'gpio', pin: 9, level: -1 },
  ]);
  const off = compileScenario({ ...SC, tracks: SC.tracks.map((t) => (t.k === 'lux' ? { ...t, on: false as const } : t)) }, ROOM);
  assert.ok(!off.some((e) => e.kind === 'lux'));
  const bench = { has: new Set(benchTracks([], 9, false).map(trackKey)) };
  const only = compileScenario(SC, ROOM, bench);
  assert.deepEqual([...new Set(only.map((e) => e.kind))].sort(), ['env', 'gpio']);
  // humidity has no part on an empty bench: env lines carry the room humidity
  assert.ok(only.every((e) => e.kind !== 'env' || e.humidity === 45));
});

test('parseScenario validates, normalizes and caps', () => {
  assert.deepEqual(parseScenario(JSON.parse(JSON.stringify(SC))), parseScenario(SC));
  assert.throws(() => parseScenario({ len: SCENARIO_MAX_MS + 1, tracks: [] }));
  assert.throws(() => parseScenario({ len: 30000, tracks: [{ k: 'temp', kf: [[1.5, 20]] }] }));
  assert.throws(() => parseScenario({ len: 30000, tracks: [{ k: 'net', steps: [[0, 'evil']], faults: [] }] }));
  assert.throws(() => parseScenario({ len: 30000, tracks: [{ k: 'x' }] }));
  const p = parseScenario({ len: 30000, tracks: [{ k: 'btn', pin: 0, presses: [[2000, 100], [1000, 5000]] }, { k: 'temp', kf: [[5000, 30.04], [0, 20, 'l']] }] });
  assert.deepEqual(p.tracks[0], { k: 'btn', pin: 0, presses: [[1000, 5000]] });
  assert.deepEqual(p.tracks[1], { k: 'temp', kf: [[0, 20], [5000, 30]] });
});

test('presets add tracks the bench offers and grow the length', () => {
  const offered = benchTracks([{ type: 'pir', pin: 4 }, { type: 'hcsr04' }], 9, true);
  let sc: ScenarioV1 = { len: 30000, tracks: [] };
  sc = applyPreset(sc, 'walk', 0, offered);
  assert.deepEqual(sc.tracks.map((t) => t.k), ['pir', 'dist']);
  sc = applyPreset(sc, 'long', 29000, offered);
  assert.equal(sc.len, 32000);
  assert.deepEqual(sc.tracks[2], { k: 'btn', pin: 9, presses: [[29000, 3000]] });
  assert.equal(applyPreset(sc, 'sunset', 0, offered).tracks.length, 3);
  assert.deepEqual(parseScenario(sc), sc);
});
