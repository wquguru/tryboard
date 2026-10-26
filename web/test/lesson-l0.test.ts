// H-16 lesson 0 (meet the dev board): course entry, board-only bench, real pick targets, task signals, datasheet params.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COURSE, courseLesson, courseStep, entryDone, lessonKey, tasksDone } from '../src/app/course.ts';
import { lessonFor } from '../src/app/lessons.ts';
import { hitText, matchTask, parseDone, taskTarget } from '../src/app/lessontasks.ts';
import zh from '../src/i18n/zh/index.ts';
import ja from '../src/i18n/ja/index.ts';
import ko from '../src/i18n/ko/index.ts';

const root = new URL('../../', import.meta.url);
const e0 = COURSE[0];
const l0 = lessonFor('basics', 'lesson-0')!;

/** Board pin ids of the S3 DevKitC as bench3d/boards.ts names them (digits → GPIOn, 'G' → GND). */
const boardSrc = readFileSync(new URL('web/src/bench3d/boards.ts', root), 'utf8');
const s3 = /BOARD_S3[\s\S]*?j1: (\[[^\]]*\]),\s*j3: (\[[^\]]*\])/.exec(boardSrc)!;
const pins = new Set(
  [...JSON.parse(s3[1].replace(/'/g, '"')), ...JSON.parse(s3[2].replace(/'/g, '"'))].map((n: string) => (/^\d+$/.test(n) ? `GPIO${n}` : n === 'G' ? 'GND' : n)),
);

test('lesson 0 is the course entry with no checkpoint and no firmware', () => {
  assert.equal(e0.no, 0);
  assert.equal(e0.cp, undefined);
  assert.equal(e0.noFw, true);
  assert.ok(l0, 'written');
  assert.equal(courseLesson(e0), l0);
  assert.equal(l0.checkpoint, lessonKey(e0));
  assert.equal(l0.no, 0);
  assert.equal(l0.fw, '');
  assert.deepEqual(l0.parts, [], 'bench = the dev board only');
  assert.equal(courseStep(0, 1)?.no, 1, 'next lesson is lesson 1');
  assert.ok(!l0.steps.some((s) => s.id === 'run' || s.codeLines || s.codeChips), 'no run step, no code');
});

test('lesson 0 has three steps: four things to find, pins, power', () => {
  assert.deepEqual(l0.steps.map((s) => s.id), ['find', 'pins', 'power']);
  const find = l0.steps[0];
  assert.deepEqual(find.callouts.map((c) => c.key), ['usb', 'boot', 'chip', 'header']);
  assert.deepEqual(find.tasks.map((x) => x.done), ['select:board@usb', 'press:boot×1', 'select:board@chip', 'select:GPIO5']);
  for (const s of l0.steps) assert.ok(s.tasks.length >= 1, `${s.id} has tasks (lesson 0 is done by its tasks)`);
});

test('callouts and task targets are real bench targets', () => {
  for (const s of l0.steps) {
    for (const c of s.callouts) {
      const tg = c.target;
      if (tg.kind === 'pin') assert.ok(pins.has(tg.id), `${s.id}: pin ${tg.id}`);
      else if (tg.kind === 'button') assert.ok(['BOOT', 'RST'].includes(tg.id), `${s.id}: button ${tg.id}`);
      else assert.ok(tg.kind === 'part' && tg.id === 'board', `${s.id}: only the board is on the bench`);
    }
    for (const x of s.tasks) {
      const tg = taskTarget(x.done);
      if (tg?.kind === 'pin') assert.ok(pins.has(tg.id), `${s.id}: task pin ${tg.id}`);
      if (tg?.kind === 'part') assert.equal(tg.id, 'board');
    }
  }
  assert.deepEqual(taskTarget('select:board@usb'), { kind: 'part', id: 'board', anchor: 'usb' });
  assert.deepEqual(taskTarget('select:board@chip'), { kind: 'part', id: 'board' });
});

test('board spots tick their own task only', () => {
  const c = { boots: 0 };
  assert.ok(matchTask('select:board@usb', 'select:board@usb', c));
  assert.equal(matchTask('select:board@usb', 'select:board@chip', c), null);
  assert.equal(matchTask('select:board@chip', 'select:board', c), null);
  assert.equal(matchTask('select:board', 'select:board@chip', c), null, 'lesson 1 "click the chip" still needs the plain signal');
  assert.ok(matchTask('press:boot×1', 'press:boot', { boots: 1 }));
  assert.equal(parseDone('select:board@usb')?.kind, 'select');
  assert.ok(hitText('select:board@usb', { v: 'board@usb' }).length > 0);
});

test('lesson 0 is done only when every task is ticked', () => {
  const all = (_w: string, _k: string, s: number) => Object.fromEntries(l0.steps[s].tasks.map((_, i) => [i, {}]));
  const none = () => ({});
  const passed = () => false;
  assert.equal(tasksDone(l0, all), true);
  assert.equal(entryDone(e0, l0, passed, all), true);
  assert.equal(entryDone(e0, l0, passed, none), false);
  const firstOnly = (_w: string, _k: string, s: number) => (s === 0 ? all('', '', 0) : {});
  assert.equal(tasksDone(l0, firstOnly), false);
});

test('chip facts come from the ESP32-S3 datasheet', () => {
  const ds = (l0.params ?? []).filter((p) => p.source === 'datasheet');
  assert.ok(ds.length >= 3);
  for (const p of ds) assert.equal(p.doc, 'ESP32-S3 datasheet');
  const vals = ds.map((p) => p.value).join(' | ');
  for (const w of ['240 MHz', '512 KB', 'Bluetooth LE 5']) assert.ok(vals.includes(w), w);
});

test('lesson 0 text is translated in zh / ja / ko', () => {
  const strs = [
    l0.title, l0.summary, l0.buy, l0.buyTip ?? '',
    ...(l0.params ?? []).flatMap((p) => [p.label, /[a-z]{3}/.test(p.value) ? p.value : '']),
    ...l0.steps.flatMap((s) => [s.title, s.sub, s.body, ...s.tasks.flatMap((x) => [x.text, x.how ?? '', x.answer ?? '']), ...s.callouts.flatMap((c) => [c.title, c.body])]),
    'the USB-C port', 'the main chip', 'This lesson runs no code: it is about the board itself', 'No checkpoint here: tick every task to finish',
  ].filter(Boolean);
  for (const [id, d] of Object.entries({ zh, ja, ko })) for (const k of strs) assert.ok((d as Record<string, string>)[k], `${id}: ${k}`);
});
