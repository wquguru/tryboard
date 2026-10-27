// H-12: the course map lists 12 lessons; written ones resolve to a lesson and get their state from progress + steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COURSE, courseCard, courseLesson, lessonKey } from '../src/app/course.ts';
import { lessonFor } from '../src/app/lessons.ts';

test('COURSE has 12 lessons numbered 0..11', () => {
  assert.equal(COURSE.length, 12);
  COURSE.forEach((e, i) => assert.equal(e.no, i));
});

test('written lessons resolve through lessonFor with the same number', () => {
  const written = COURSE.filter((e) => courseLesson(e));
  assert.deepEqual(
    written.map((e) => e.no),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  for (const e of written) {
    const l = lessonFor(e.work, lessonKey(e));
    assert.ok(l, `lesson ${e.no}`);
    assert.equal(l.no, e.no);
  }
});

test('courseCard states', () => {
  const none = () => false;
  const zero = () => 0;
  const [c0, c1, c2] = COURSE;
  assert.equal(courseCard(c0, none, zero, null).state, 'ready');
  assert.equal(courseCard(c1, none, zero, null).state, 'ready');
  const started = courseCard(c1, none, () => 1, null);
  assert.equal(started.state, 'current');
  assert.equal(started.step, 2);
  assert.equal(started.total, lessonFor('weather', '01')!.steps.length);
  const open = courseCard(c2, none, zero, { work: 'weather', cp: '02', step: 0 });
  assert.equal(open.state, 'current');
  assert.equal(open.step, 1);
  assert.equal(courseCard(c2, (w, cp) => w === 'weather' && cp === '02', zero, null).state, 'done');
  // H-20: the map's extra ✓ comes from cpPassed, which ticks alone never set
  assert.equal(courseCard(c2, (w, cp) => w === 'weather' && cp === '02', zero, null).cpPassed, true);
  const l2 = courseLesson(c2)!;
  const ticked = courseCard(c2, none, zero, null, (_w, _k, s) => Object.fromEntries(l2.steps[s].tasks.map((_, i) => [i, 1])));
  assert.deepEqual([ticked.state, ticked.cpPassed], ['done', false]);
  assert.equal(courseCard(COURSE[11], none, zero, null).cpPassed, false);
});
