// 采购清单的日志重放与"摆上实验台"（P0-07、P0-09）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialHistory, placement, push, replay, ruleInput, validHistory } from '../src/app/bom.ts';
import { problems } from '../src/catalog/rules.ts';

const examples = JSON.parse(readFileSync(new URL('../../firmware/examples.json', import.meta.url), 'utf8')) as { id: string; scene?: { parts: unknown[] } }[];

test('气象站：默认清单没问题，场景与 examples.json 一致、有外接 5 V', () => {
  const b = replay(initialHistory('weather'));
  assert.equal(b.board, 's3-devkitc1-v10');
  assert.deepEqual(problems(ruleInput(b)), []);
  const p = placement(b);
  assert.deepEqual(p.parts, examples.find((e) => e.id === 'weather')!.scene!.parts);
  assert.equal(p.ext5v, true);
  assert.deepEqual(p.skipped, []);
});

test('去掉 5 V 电源：只靠 USB 的提醒 + 一键补回；实验台供电只剩 USB', () => {
  let h = push(initialHistory('weather'), { t: 'remove', partId: 'psu-5v2a' });
  const b = replay(h);
  assert.ok(!b.picks.some((p) => p.partId === 'psu-5v2a'));
  assert.equal(placement(b).ext5v, false);
  const f = problems(ruleInput(b)).find((x) => x.id === 'R27' && x.fix?.partId === 'psu-5v2a');
  assert.ok(f && /只靠电脑 USB/.test(f.detail), '提醒说后果');
  h = push(h, { t: 'fix', fix: f.fix!, rule: f.id });
  assert.deepEqual(problems(ruleInput(replay(h))), []);
  assert.equal(h.ops.length, 3);
});

test('必选件去不掉，不记进日志', () => {
  const h0 = initialHistory('weather');
  assert.equal(push(h0, { t: 'remove', partId: 'bme280' }), h0);
  assert.equal(push(h0, { t: 'remove', partId: 's3-devkitc1-v10' }), h0, '开发板只能换不能去');
});

test('时间线：回到第一步重放出模版默认；从中间再改会丢掉后面的分支', () => {
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

test('换开发板：清单里的板子跟着换，接线不变（C3 的 GPIO9 是 BOOT 脚，规则会说）', () => {
  const h = push(initialHistory('weather'), { t: 'board', partId: 'c3-devkitm1' });
  const b = replay(h);
  assert.equal(b.board, 'c3-devkitm1');
  assert.ok(b.picks.some((p) => p.partId === 'c3-devkitm1') && !b.picks.some((p) => p.partId === 's3-devkitc1-v10'));
  assert.ok(problems(ruleInput(b)).length > 0);
});

test('从元件库加的件：没有默认接线的不摆上台，列为 skipped', () => {
  const h = push(initialHistory('blank'), { t: 'add', partId: 'ssd1306' });
  const b = replay(h);
  assert.equal(b.extra.ssd1306, '从元件库加的');
  const p = placement(b);
  assert.deepEqual(p.parts, []);
  assert.deepEqual(p.skipped, ['oled', 'led'], '空白模版默认带 LED 套装，也没有接线');
});

test('日志校验：坏数据不重放', () => {
  assert.ok(validHistory(initialHistory('lens')));
  assert.ok(!validHistory({ ops: [{ t: 'template', id: 'nope' }], cur: 0 }));
  assert.ok(!validHistory({ ops: [{ t: 'template', id: 'weather' }, { t: 'add', partId: 'gone' }], cur: 1 }));
  assert.ok(!validHistory({ ops: [], cur: 0 }));
  assert.ok(!validHistory(null));
});
