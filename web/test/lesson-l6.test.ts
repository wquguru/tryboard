// H-16 lesson 6 (passive buzzer): ids exist on the basics bench, steps are complete, the course entry resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lessonFor } from '../src/app/lessons.ts';
import { COURSE, courseLesson } from '../src/app/course.ts';
import { WORKS } from '../src/app/works.ts';
import { lessonWires, partId } from '../src/app/wiring.ts';

const root = new URL('../../', import.meta.url);
const levels = JSON.parse(readFileSync(new URL('firmware/levels.json', root), 'utf8')) as { id: string; pwm?: { pin: number; tones?: number } }[];

test('lesson 6 resolves from the course and keeps only the buzzer', () => {
  const entry = COURSE.find((e) => e.no === 6)!;
  const l = courseLesson(entry);
  assert.ok(l);
  assert.equal(l, lessonFor('basics', 'basics-buzz'));
  assert.equal(l.no, 6);
  assert.deepEqual(l.parts, ['buzzer']);
  assert.ok(WORKS.basics.checkpoints.includes('basics-buzz'));
  assert.deepEqual(l.steps.map((s) => s.id), ['part', 'wire', 'code', 'run', 'tweak']);
  for (const s of l.steps) assert.ok(s.tasks.length >= 1 && s.callouts.length >= 1, s.id);
  assert.ok(l.steps.some((s) => s.tasks.some((x) => x.done === 'run')));
  assert.ok(l.steps.some((s) => s.tasks.some((x) => x.done === 'select:buzzer')));
});

test('lesson 6 ids exist on the basics bench', () => {
  const l = lessonFor('basics', 'basics-buzz')!;
  const parts = WORKS.basics.scene!.parts;
  const ids = parts.map(partId);
  for (const p of l.parts!) assert.ok(ids.includes(p), `part ${p}`);
  const wires = lessonWires(parts, l.parts!);
  const wireIds = wires.map((w) => w.id);
  // Only the buzzer's wires are drawn, and the wire notes cover exactly those
  assert.deepEqual(Object.keys(l.wireNotes!).sort(), wireIds.slice().sort());
  const boardPins = new Set(wires.map((w) => w.a));
  for (const s of l.steps)
    for (const c of s.callouts) {
      const { kind, id } = c.target;
      if (kind === 'part') assert.ok(id === 'board' || ids.includes(id), `${s.id}: part ${id}`);
      else if (kind === 'wire') assert.ok(wireIds.includes(id), `${s.id}: wire ${id}`);
      else if (kind === 'pin') assert.ok(boardPins.has(id), `${s.id}: pin ${id}`);
      else assert.fail(`${s.id}: unexpected ${kind}`);
    }
});

test('lesson 6 tone rule matches the level and the source', () => {
  const l = lessonFor('basics', 'basics-buzz')!;
  const lv = levels.find((x) => x.id === 'basics-buzz')!;
  assert.equal(l.tones?.[0].pin, lv.pwm?.pin);
  assert.ok((lv.pwm?.tones ?? 0) >= 3);
  const src = readFileSync(new URL(l.src, root), 'utf8').split('\n');
  assert.match(src[l.tones![0].line - 1], /tone\(MELODY/);
  assert.match(src[25], /ledc_set_freq/);
  assert.match(src[7], /#define BUZZER_GPIO 6/);
  for (const [hz, name] of Object.entries(l.tones![0].notes!)) assert.ok(src.some((x) => x.includes(`{"${name}", ${hz}}`)), `${name} ${hz}`);
  for (const p of l.params!) if (p.source === 'datasheet') assert.ok(p.doc && !/p\.\s*\d|page/i.test(p.doc));
});
