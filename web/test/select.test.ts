// Advisor v3: URL state -> recommendation / brief / "Just now" text / relax options. Pure functions shared by page and bench.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefMarkdown, checkpointsOf } from '../src/advisor/brief.ts';
import { resolve, changeText, relaxOptions, partRows, sanitize, lasts } from '../src/advisor/derive.ts';
import { EMPTY, decode, encode } from '../src/advisor/state.ts';

const W = { ...EMPTY, t: 'weather' };

test('old link ?t=weather decodes to the weather station and has a recommended board', () => {
  const r = resolve(decode('?t=weather'));
  assert.equal(r.tpl.id, 'weather');
  assert.ok(r.plan);
  assert.ok(r.trio.length >= 2);
});

test('garbage URL params are dropped without errors', () => {
  const s = sanitize(decode('?t=nope&add=foo,buzzer&rm=bar&req=xx&board=zz'));
  assert.equal(s.t, 'weather');
  assert.deepEqual(s.add, ['buzzer']);
  assert.deepEqual(s.rm, []);
  assert.deepEqual(s.req, []);
  assert.equal(s.board, '');
});

test('brief: four sections, checkpoint names per contract 3, no command lines', () => {
  const md = briefMarkdown(W);
  for (const h of ['## Hardware', '## Pins', '## Requirements', '## Acceptance']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('1. Boots without crashing, prints to serial'));
  assert.ok(md.includes('I2C 0x76 responds (BME280)'));
  assert.ok(md.includes('I2C 0x3c responds (OLED)'));
  assert.ok(md.includes('OLED receives a frame'));
  assert.ok(md.includes('Wakes again after deep sleep'));
  assert.ok(!/npx|idf\.py|tryboard run/.test(md));
  assert.equal(md.trim().split('\n').at(-1), 'To run offline, install packages/tryboard locally from the repo');
});

test('checkpoints: LED strip, servo; no battery means no deep sleep', () => {
  const r = resolve({ ...EMPTY, t: 'lights', add: ['servo'] });
  const names = checkpointsOf(r).map((c) => c.name);
  assert.ok(names.includes('LED strip receives data'));
  assert.ok(names.includes('Servo signal'));
  assert.ok(!names.includes('Wakes again after deep sleep'));
});

test('"Just now": adding a buzzer keeps the pick, uses pins, raises the price', () => {
  const t = changeText('Added buzzer', resolve(W), resolve({ ...W, add: ['buzzer'] }));
  assert.match(t, /^Added buzzer → recommendation unchanged; uses 1 more pin .+; reference price \+¥/);
  // A battery life change must be stated (numbers come from the engine, not hard-coded)
  const a = resolve(W).plan!.power!.days;
  const b = resolve({ ...W, add: ['buzzer'] }).plan!.power!.days;
  if (lasts(a) !== lasts(b)) assert.match(t, /battery life about \d+ days → about \d+ days$/);
  // Switching templates rounds the price gap, no decimals
  const u = changeText('Switched to "Weather station"', resolve({ ...EMPTY, t: 'lights' }), resolve(W));
  assert.doesNotMatch(u, /reference price [+−]¥\d+\.\d/);
});

test('zero boards offers relax options, and each one really yields boards', () => {
  const s = { ...W, req: ['bt_classic'], budget: 60 as const };
  const r = resolve(s);
  assert.equal(r.plans.length, 0);
  const opts = relaxOptions(r);
  assert.ok(opts.length > 0);
  for (const o of opts) assert.equal(resolve(o.next).plans.length, o.n);
});

test('parts list: needed / suggested groups, suggested ones dashed by default', () => {
  const rows = partRows(resolve(W));
  assert.ok(rows.some((x) => x.key === 'bme280' && x.group === 'need' && x.on));
  assert.ok(rows.some((x) => x.key === 'battery' && x.group === 'suggest' && x.on));
  assert.ok(rows.some((x) => x.key === 'buzzer' && x.group === 'suggest' && !x.on));
});

test('share params round-trip', () => {
  const s = { ...W, add: ['buzzer'], bat: false, budget: 120 as const, board: 'c3-supermini' };
  assert.deepEqual(decode('?' + encode(s)), { ...s, have: [] });
});

test('advisor and shop (custom) agree on parts: both decode from the URL and must match', async () => {
  const { selectParts } = await import('../src/app/custom.ts');
  const { selectedParts, sanitize: san } = await import('../src/advisor/derive.ts');
  const { TEMPLATES } = await import('../src/advisor/data.ts');
  for (const t of TEMPLATES)
    for (const extra of [{}, { add: ['buzzer', 'servo'] }, { rm: t.parts.slice(0, 1) }, { bat: true }, { bat: false }]) {
      const s = san({ ...EMPTY, t: t.id, ...extra });
      const a = selectedParts(s).filter((p) => p !== 'battery').sort();
      const b = selectParts(s).filter((p) => p !== 'battery').sort();
      assert.deepEqual(b, [...new Set(a)].sort(), `${t.id} ${JSON.stringify(extra)}`);
    }
});

test('every template example id exists in firmware/examples.json', async () => {
  const { readFileSync } = await import('node:fs');
  const { TEMPLATES } = await import('../src/advisor/data.ts');
  const raw = JSON.parse(readFileSync(new URL('../../firmware/examples.json', import.meta.url), 'utf8'));
  const ids = new Set<string>((Array.isArray(raw) ? raw : (raw.examples ?? Object.values(raw))).map((e: { id: string }) => e.id));
  for (const t of TEMPLATES) for (const id of t.examples) assert.ok(ids.has(id), `${t.id}: unknown example ${id}`);
  for (const id of ['rfid', 'irremote', 'mqtt', 'blephone']) assert.ok(TEMPLATES.some((t) => t.id === id), id);
});
