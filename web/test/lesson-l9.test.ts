// H-16 lesson 9 (potentiometer · ADC, course-only `adc` work): the data points at the s3-pot bench, firmware and source lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COURSE, courseLesson, lessonKey } from '../src/app/course.ts';
import { lessonFor } from '../src/app/lessons.ts';
import { WORKS } from '../src/app/works.ts';
import { lessonWires, partId } from '../src/app/wiring.ts';
import { hitText, matchTask, parseDone } from '../src/app/lessontasks.ts';
import type { SceneSpec } from '../src/bench3d/spec.ts';

const root = new URL('../../', import.meta.url);
type Ex = { id: string; scene?: SceneSpec; controls?: { type: string; pin: number; max_mv: number }[] };
const ex = (JSON.parse(readFileSync(new URL('firmware/examples.json', root), 'utf8')) as Ex[]).find((e) => e.id === 's3-pot')!;
const accept = (JSON.parse(readFileSync(new URL('firmware/accept.json', root), 'utf8')) as { id: string; expect: string[] }[]).find((c) => c.id === 's3-pot');
const l = lessonFor('adc', 'lesson-9')!;
const src = readFileSync(new URL(l.src, root), 'utf8').split('\n');

test('lesson 9 is the course entry on the course-only adc work, running the s3-pot example', () => {
  const e = COURSE.find((x) => x.no === 9)!;
  assert.equal(e.work, 'adc');
  assert.equal(e.cp, undefined);
  assert.equal(lessonKey(e), 'lesson-9');
  assert.equal(courseLesson(e), l);
  assert.equal(l.no, 9);
  assert.ok(WORKS.adc.courseOnly);
  assert.equal(WORKS.adc.example, l.fw);
  assert.ok(accept, 'the firmware has an accept case');
  assert.deepEqual(l.steps.map((s) => s.id), ['pot', 'divider', 'adc', 'run', 'tweak']);
  for (const s of l.steps) assert.ok(s.tasks.length >= 2 && s.callouts.length >= 1, s.id);
});

test('bench shows the pot and the LED, and every wire / pin the lesson names is drawn', () => {
  const ids = ex.scene!.parts.map(partId);
  for (const id of l.parts!) assert.ok(ids.includes(id), id);
  const rows = lessonWires(ex.scene!.parts, l.parts!).map((w) => w.id);
  assert.deepEqual(rows.sort(), Object.keys(l.wireNotes!).sort());
  const pot = ex.scene!.parts.find((p) => p.type === 'pot') as { pin: number };
  for (const s of l.steps)
    for (const c of s.callouts) {
      if (c.target.kind === 'wire') assert.ok(rows.includes(c.target.id), `${s.id} ${c.key}`);
      if (c.target.kind === 'pin') assert.equal(c.target.id, `GPIO${pot.pin}`, `${s.id} ${c.key}`);
      if (c.target.kind === 'part') assert.ok(['board', ...l.parts!].includes(c.target.id), `${s.id} ${c.key}`);
    }
});

test('code lines sit on the ADC / LEDC code they explain', () => {
  const at = (n: number) => src[n - 1] ?? '';
  assert.ok(at(22).includes('ADC_UNIT_1'));
  assert.ok(at(24).includes('ADC_ATTEN_DB_12') && at(24).includes('ADC_BITWIDTH_12'));
  assert.ok(at(27).includes('LEDC_TIMER_12_BIT'));
  assert.ok(at(37).includes('adc_oneshot_read'));
  assert.ok(at(38).includes('ledc_set_duty') && at(38).includes('raw'));
  assert.ok(at(46).includes('TRYBOARD_OK pot'));
  for (const c of l.code!) assert.ok(at(c.line).trim() && !/^\s*\/\//.test(at(c.line)), `line ${c.line}`);
  for (const s of l.steps) for (const n of s.codeLines ?? []) assert.ok(l.code!.some((c) => c.line === n), `${s.id} line ${n}`);
  // The S3 build reads GPIO4 = ADC1 channel 3 with a 3.1 V full scale (the mV figure in the log)
  const cmake = readFileSync(new URL('firmware/s3-pot/main/CMakeLists.txt', root), 'utf8');
  assert.ok(cmake.includes('POT_CHANNEL=ADC_CHANNEL_3') && cmake.includes('FULL_MV=3100'));
});

test('the run step ticks on the ADC reading at both ends, matching the firmware thresholds', () => {
  const tasks = l.steps.find((s) => s.id === 'run')!.tasks;
  const lo = tasks.find((x) => x.done.startsWith('adc:') && x.done.includes('<'))!;
  const hi = tasks.find((x) => x.done.startsWith('adc:') && x.done.includes('>'))!;
  assert.deepEqual(parseDone(lo.done), { kind: 'adc', pin: 4, op: '<', n: 100 });
  assert.deepEqual(parseDone(hi.done), { kind: 'adc', pin: 4, op: '>', n: 3500 });
  assert.ok(src[43].includes('raw < 100') && src[44].includes('raw > 3500'));
  assert.equal(matchTask(lo.done, 'adc:4=100', { boots: 0 }), null);
  assert.deepEqual(matchTask(lo.done, 'adc:4=12', { boots: 0 }), { v: '12' });
  assert.equal(matchTask(lo.done, 'adc:5=12', { boots: 0 }), null);
  assert.equal(matchTask(hi.done, 'adc:4=3500', { boots: 0 }), null);
  assert.deepEqual(matchTask(hi.done, 'adc:4=3778', { boots: 0 }), { v: '3778' });
  assert.ok(hitText(hi.done, { v: '3778' }).includes('3778'));
  assert.ok(ex.controls?.some((c) => c.type === 'analog' && c.pin === 4));
});

test('feed ADC rows sit on the pot pin and the adc_oneshot_read line', () => {
  assert.deepEqual(l.adc!.map((r) => r.pin), [ex.controls!.find((c) => c.type === 'analog')!.pin]);
  for (const r of l.adc!) assert.ok(src[r.line - 1].includes('adc_oneshot_read'), `line ${r.line}`);
});
