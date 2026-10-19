// Shopping list log replay and "place it on the bench" (P0-07, P0-09)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialHistory, placement, push, replay, ruleInput, validHistory } from '../src/app/bom.ts';
import { problems } from '../src/catalog/rules.ts';
import { bomTotal, getTemplate, templatePicks } from '../src/catalog/templates.ts';

const examples = JSON.parse(readFileSync(new URL('../../firmware/examples.json', import.meta.url), 'utf8')) as { id: string; scene?: { parts: unknown[] } }[];

test('weather station: default list is clean, scene matches examples.json, external 5 V present', () => {
  const b = replay(initialHistory('weather'));
  assert.equal(b.board, 's3-devkitc1-v10');
  assert.deepEqual(problems(ruleInput(b)), []);
  const p = placement(b);
  assert.deepEqual(p.parts, examples.find((e) => e.id === 'weather')!.scene!.parts);
  assert.equal(p.ext5v, true);
  assert.deepEqual(p.skipped, []);
});

test('removing the 5 V supply: USB-only warning + one-click restore; bench power falls back to USB', () => {
  let h = push(initialHistory('weather'), { t: 'remove', partId: 'psu-5v2a' });
  const b = replay(h);
  assert.ok(!b.picks.some((p) => p.partId === 'psu-5v2a'));
  assert.equal(placement(b).ext5v, false);
  const f = problems(ruleInput(b)).find((x) => x.id === 'R27' && x.fix?.partId === 'psu-5v2a');
  assert.ok(f && /on computer USB alone/.test(f.detail), 'the warning states the consequence');
  h = push(h, { t: 'fix', fix: f.fix!, rule: f.id });
  assert.deepEqual(problems(ruleInput(replay(h))), []);
  assert.equal(h.ops.length, 3);
});

test('required parts cannot be removed and are not logged', () => {
  const h0 = initialHistory('weather');
  assert.equal(push(h0, { t: 'remove', partId: 'bme280' }), h0);
  assert.equal(push(h0, { t: 'remove', partId: 's3-devkitc1-v10' }), h0, 'the board can be swapped but not removed');
});

test('timeline: back to step one replays the template default; editing mid-way drops the later branch', () => {
  let h = initialHistory('weather');
  h = push(h, { t: 'remove', partId: 'buzzer-module' });
  h = push(h, { t: 'template', id: 'spin' });
  assert.equal(replay(h).template, 'spin');
  assert.ok(replay(h).picks.some((p) => p.partId === 'gc9a01'));
  const back = { ...h, cur: 0 };
  assert.deepEqual(replay(back), replay(initialHistory('weather')));
  assert.ok(replay({ ...h, cur: 1 }).picks.every((p) => p.partId !== 'buzzer-module'));
  const branch = push(back, { t: 'add', partId: 'dupont-ff' });
  assert.equal(branch.ops.length, 2);
  assert.deepEqual(placement(replay({ ...h, cur: 2 })).parts, examples.find((e) => e.id === 'spin')!.scene!.parts);
});

test('board swap: the board line follows, wiring stays (C3 GPIO9 is the BOOT pin, the rules say so)', () => {
  const h = push(initialHistory('weather'), { t: 'board', partId: 'c3-devkitm1' });
  const b = replay(h);
  assert.equal(b.board, 'c3-devkitm1');
  assert.ok(b.picks.some((p) => p.partId === 'c3-devkitm1') && !b.picks.some((p) => p.partId === 's3-devkitc1-v10'));
  assert.ok(problems(ruleInput(b)).length > 0);
});

test('board swap (P1-12): Xiaohuang to XIAO S3 changes the board line and raises R04; Waveshare round display board -> R29 removes the external display in one click', () => {
  const h0 = initialHistory('spin');
  const before = new Set(problems(ruleInput(replay(h0))).map((f) => f.id));
  const h1 = push(h0, { t: 'board', partId: 'xiao-s3' });
  const b1 = replay(h1);
  assert.equal(b1.board, 'xiao-s3');
  assert.ok(b1.picks.some((p) => p.partId === 'xiao-s3') && !b1.picks.some((p) => p.partId === 's3-devkitc1-v10'));
  const after = new Set(problems(ruleInput(b1)).map((f) => f.id));
  assert.ok(!before.has('R04') && after.has('R04'), 'XIAO S3 does not break out GPIO10–15');
  const h2 = push(h0, { t: 'board', partId: 'ws-s3-lcd128' });
  const r29 = problems(ruleInput(replay(h2))).find((f) => f.id === 'R29')!;
  assert.ok(r29);
  const h3 = push(h2, { t: 'fix', fix: r29.fix!, rule: 'R29' });
  const b3 = replay(h3);
  assert.ok(!b3.picks.some((p) => p.partId === 'gc9a01'));
  const left = problems(ruleInput(b3));
  assert.ok(!left.some((f) => f.id === 'R29' || f.id === 'R27'), JSON.stringify(left.map((f) => f.id)));
});

test('parts added from the library: without default wiring they are not placed and are listed as skipped', () => {
  const h = push(initialHistory('blank'), { t: 'add', partId: 'ssd1306' });
  const b = replay(h);
  assert.equal(b.extra.ssd1306, '从元件库加的'); // lint: allow-cjk
  const p = placement(b);
  assert.deepEqual(p.parts, []);
  assert.deepEqual(p.skipped, ['oled', 'led'], 'the blank template includes the LED kit by default, also unwired');
});

test('log validation: bad data is not replayed', () => {
  assert.ok(validHistory(initialHistory('lens')));
  assert.ok(!validHistory({ ops: [{ t: 'template', id: 'nope' }], cur: 0 }));
  assert.ok(!validHistory({ ops: [{ t: 'template', id: 'weather' }, { t: 'add', partId: 'gone' }], cur: 1 }));
  assert.ok(!validHistory({ ops: [], cur: 0 }));
  assert.ok(!validHistory(null));
});

test('home page reference price and shop total use the same basis (templatePicks defaults + bomTotal)', () => {
  for (const id of ['weather', 'spin', 'lens']) {
    const shop = replay(initialHistory(id));
    const a = bomTotal(shop.picks, shop.board);
    const home = bomTotal(templatePicks(id), getTemplate(id).board);
    assert.deepEqual([home.lo, home.hi, home.lines.length], [a.lo, a.hi, a.lines.length], id);
  }
});
