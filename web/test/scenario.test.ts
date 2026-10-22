// Environment scenario (F-11): compile determinism, quantized round trip through the script format, minimum spacing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromScript, toScriptBody, type InputEvent } from '../src/inputlog.ts';
import { anchorScroll, applyPreset, benchTracks, pinchZoom, wheelZoom, zoomLabel, zoomStep, ZOOMS, compileScenario, GRID_MS, MIN_GAP_MS, parseScenario, quantize, SCENARIO_MAX_MS, scenarioAt, scenarioStaleAt, trackKey, valueAt, type ScenarioV1 } from '../src/app/scenario.ts';
import { truncate, type BenchStep } from '../src/app/history.ts';

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

test('undo / redo walks scenario edits on the bench timeline and keeps the compiled events (F-11c)', () => {
  const A = applyPreset({ len: 30000, tracks: [] }, 'ac', 0, [{ k: 'temp' }]);
  const B: ScenarioV1 = { ...A, tracks: [...A.tracks, { k: 'pir', spans: [[2000, 3000]] }] };
  const steps: BenchStep[] = [
    { op: { k: 'run', n: 1 }, run: 1, tMs: 0 },
    { op: { k: 'scenario', sc: A, prev: null, label: 'ac' }, run: 1, tMs: 100 },
    { op: { k: 'env', env: ROOM }, run: 1, tMs: 200 },
    { op: { k: 'scenario', sc: B, prev: A, label: 'add' }, run: 1, tMs: 300 },
  ];
  const ops = steps.map((s) => s.op);
  // Before the first edit: what that edit replaced; after it: the last edit at or before the step
  assert.equal(scenarioAt(ops, 0), null);
  assert.equal(scenarioAt(ops, 1), A);
  assert.equal(scenarioAt(ops, 2), A);
  assert.equal(scenarioAt(ops, 3), B);
  assert.equal(scenarioAt([{ k: 'run' }], 0), undefined);
  // Undo to step 2 then redo to 3: the restored scenario compiles to the same events, and survives the share JSON
  const back = scenarioAt(ops, 3)!;
  assert.deepEqual(compileScenario(back, ROOM), compileScenario(B, ROOM));
  assert.deepEqual(parseScenario(JSON.parse(JSON.stringify(scenarioAt(ops, 2)))), A);
  // A new edit after undo drops the redo branch
  const C: ScenarioV1 = { ...A, len: 40000 };
  const cut = truncate(steps, [], 2).steps;
  cut.push({ op: { k: 'scenario', sc: C, prev: A, label: 'len' }, run: 1, tMs: 400 });
  const ops2 = cut.map((s) => s.op);
  assert.equal(ops2.length, 4);
  assert.equal(scenarioAt(ops2, 3), C);
  assert.equal(scenarioAt(ops2, 2), A);
  // Restart banner: the edit's own flag within its run, cleared by a later run
  const past = { k: 'scenario', sc: C, prev: A, label: 'move', stale: true };
  assert.equal(scenarioStaleAt([...ops2, past], 4), true);
  assert.equal(scenarioStaleAt([...ops2, past], 3), false);
  assert.equal(scenarioStaleAt([...ops2, past, { k: 'run' }], 5), false);
});

test('timeline zoom (F-11d): anchor keeps the moment under the fingers, steps from continuous zoom, clamps', () => {
  // Zoom 2 -> 5.5 about px 120 of a 358 px view: the same lane fraction stays at px 120
  const viewW = 358;
  const sl0 = 300;
  const px = 120;
  const frac = (sl0 + px) / (viewW * 2);
  const z = pinchZoom(2, 100, 275);
  assert.equal(z, 5.5);
  const sl = anchorScroll(frac, viewW * z, px, viewW);
  assert.ok(Math.abs((sl + px) / (viewW * z) - frac) < 1e-12);
  // Clamped at both ends: never negative, never past the last viewport
  assert.equal(anchorScroll(0.01, viewW * 4, 200, viewW), 0);
  assert.equal(anchorScroll(1, viewW * 4, 10, viewW), viewW * 3);
  assert.equal(pinchZoom(1, 100, 20), 1);
  assert.equal(pinchZoom(16, 100, 400), 32);
  assert.equal(pinchZoom(3, 0, 50), 32);
  // Buttons step to the next power of two from wherever a pinch left the zoom
  assert.equal(zoomStep(5.5, 1), 8);
  assert.equal(zoomStep(5.5, -1), 4);
  assert.equal(zoomStep(4, 1), 8);
  assert.equal(zoomStep(4, -1), 2);
  assert.equal(zoomStep(32, 1), undefined);
  assert.equal(zoomStep(1, -1), undefined);
  assert.equal(ZOOMS[0], 1);
  // Wheel: up zooms in, down zooms out, symmetric
  assert.ok(wheelZoom(2, -100) > 2 && wheelZoom(2, 100) < 2);
  assert.ok(Math.abs(wheelZoom(wheelZoom(2, -100), 100) - 2) < 1e-9);
  assert.equal(zoomLabel(4), '4');
  assert.equal(zoomLabel(5.5), '5.5');
  assert.equal(zoomLabel(7.98), '8');
});
