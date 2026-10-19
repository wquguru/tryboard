// Bench interaction pure functions: timeline fold / rewind target / truncate (P0-03), run diff (P0-13), wiring rules (P0-12)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRuns, fold, replayInputs, runResult, seekTarget, truncate, type BenchStep, type RunRec } from '../src/app/history.ts';
import { PART_LABEL, partLabel, wiresOf } from '../src/app/wiring.ts';
import { checkWiring } from '../src/app/wirecheck.ts';

const env = (temp: number) => ({ temp, humidity: 45, pressure: 101325 });
const steps: BenchStep[] = [
  { op: { k: 'place', label: 'BME280' }, run: 1, tMs: 0 },
  { op: { k: 'run', n: 1 }, run: 1, tMs: 0 },
  { op: { k: 'env', env: env(30) }, run: 1, tMs: 1200 },
  { op: { k: 'power', ext5v: true }, run: 1, tMs: 1800 },
  { op: { k: 'run', n: 2 }, run: 2, tMs: 0 },
  { op: { k: 'heat', part: 'bme280', env: env(38) }, run: 2, tMs: 900 },
  { op: { k: 'run', n: 3 }, run: 3, tMs: 0 },
];
const ends: Record<number, number> = { 1: 2500, 2: 1600, 3: 700 };

test('back to a step = just before the next step; if that is in another run, the end of this run', () => {
  const end = (n: number) => ends[n] ?? null;
  assert.deepEqual(seekTarget(steps, 1, end), { run: 1, untilMs: 1200 });
  assert.deepEqual(seekTarget(steps, 3, end), { run: 1, untilMs: 2500 });
  assert.deepEqual(seekTarget(steps, 4, end), { run: 2, untilMs: 900 });
  assert.deepEqual(seekTarget(steps, 6, end), { run: 3, untilMs: 700 });
  assert.equal(seekTarget(steps, 6, () => null), null);
  // Parts placed before the first power-up: back to 0 ms of run #1
  assert.deepEqual(seekTarget(steps, 0, end), { run: 1, untilMs: 0 });
});

test('fold: edit state up to step i', () => {
  assert.deepEqual(fold(steps, 2).env, env(30));
  assert.equal(fold(steps, 2).power, null);
  assert.deepEqual(fold(steps, 3).power, { ext5v: true });
  assert.equal(fold(steps, 5).heat, 'bme280');
  assert.deepEqual(fold(steps, 5).env, env(38));
});

test('truncate: a new action mid-way drops later steps and runs', () => {
  const runs = [1, 2, 3].map((n) => ({ n }) as RunRec);
  const t = truncate(steps, runs, 3);
  assert.equal(t.steps.length, 4);
  assert.deepEqual(t.runs.map((r) => r.n), [1]);
});

test('replay inputs drop power-up and the power-up environment', () => {
  const r = replayInputs([
    { tMs: 0, kind: 'power', on: true },
    { tMs: 0, kind: 'env', temp: 23.5, humidity: 45, pressure: 101325 },
    { tMs: 5, kind: 'gpio', pin: 0, level: 0 },
  ]);
  assert.deepEqual(r.env0, env(23.5));
  assert.equal(r.events.length, 1);
});

test('run result is the last reading line; the diff lists changed items', () => {
  assert.equal(runResult('boot\r\nT=23.50 C H=45.0 % P=1013.25 hPa LED=green PWM=1675us\r\nALARM OFF\r\n'), 'T=23.50 C H=45.0 % P=1013.25 hPa LED=green PWM=1675us');
  const a = { n: 1, fw: 'w', env0: 'x', envChanges: 0, power: 'USB', heat: 'none', seconds: '1 s', fingerprint: 'aaaa·bbbb', result: 'r' };
  const d = diffRuns(a, { ...a, n: 2, env0: 'y', fingerprint: 'cccc·dddd' });
  assert.deepEqual(d.filter((x) => x.changed).map((x) => x.key), ['env0', 'fingerprint']);
});

const WEATHER = [
  { type: 'oled', addr: 0x3c, sda: 8, scl: 9 },
  { type: 'bme280', addr: 0x76, sda: 8, scl: 9 },
  { type: 'servo', pin: 4 },
  { type: 'buzzer', pin: 5 },
] as const;
const parts = (extra: unknown[] = []) => [...WEATHER, ...extra] as never[];
const rules = (p: never[], mods = {}) => checkWiring(p, wiresOf(p, false, mods)).map((f) => f.rule);

test('the three default works have clean wiring', () => {
  assert.deepEqual(rules(parts()), []);
  assert.deepEqual(rules([{ type: 'gc9a01', spi: 2 }, { type: 'servo', pin: 4 }] as never[]), []);
  assert.deepEqual(rules([{ type: 'gc9a01', spi: 2 }] as never[]), []);
});

test('W1 output to output: pot wiper on the servo signal pin', () => assert.deepEqual(rules(parts([{ type: 'pot', pin: 4 }])), ['W1']));
test('W2 5 V into GPIO: BME280 supply moved to 5V', () => assert.deepEqual(rules(parts(), { retarget: { 'wire:3V3~bme280:VIN': '5V' } }), ['W2']));
test('W3 LED without a current-limiting resistor', () => {
  assert.deepEqual(rules(parts([{ type: 'led', pin: 6 }])), []);
  assert.deepEqual(rules(parts([{ type: 'led', pin: 6 }]), { noResistor: ['led:6'] }), ['W3']);
});
test('W4 missing ground', () => assert.deepEqual(rules(parts(), { drop: ['wire:GND~bme280:GND'] }), ['W4']));
test('W5 I2C address conflict', () => assert.deepEqual(rules(parts().map((p: { type: string }) => (p.type === 'oled' ? { ...p, addr: 0x76 } : p)) as never[]), ['W5']));
test('wire ids match the 3D bench', () => {
  const ids = wiresOf(parts()).map((w) => w.id);
  for (const id of ['wire:GND~oled:GND', 'wire:3V3~oled:VCC', 'wire:GPIO9~oled:SCL', 'wire:GPIO8~oled:SDA', 'wire:3V3~bme280:VIN', 'wire:GND~bme280:GND', 'wire:GPIO4~servo:PWM', 'wire:5V~servo:VCC', 'wire:GND~servo:GND']) assert.ok(ids.includes(id), id);
  // External 5 V: the net becomes EXT5V, the id still follows the 5V pin drawn on the bench
  assert.equal(wiresOf(parts(), true).find((w) => w.id === 'wire:5V~servo:VCC')?.a, 'EXT5V');
});

test('buzzer module three wires: VCC -> 3V3, I/O -> GPIO5, GND (same ids as the 3D bench)', () => {
  const w = wiresOf([{ type: 'buzzer', pin: 5 }]);
  assert.deepEqual(w.map((x) => x.id), ['wire:3V3~buzzer:VCC', 'wire:GPIO5~buzzer:I/O', 'wire:GND~buzzer:GND']);
  assert.deepEqual(rules([{ type: 'buzzer', pin: 5 }] as never[]), []);
});

test('part display names are names / models, never the raw type id', () => {
  for (const [type, name] of Object.entries(PART_LABEL)) {
    assert.notEqual(name, type, type);
    assert.equal(partLabel(type), name);
  }
  assert.equal(partLabel('buzzer'), 'Buzzer');
  assert.equal(partLabel('servo'), 'Servo');
});
