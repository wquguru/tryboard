// H-15: course layer — lesson order and mapping (DECISIONS 2026-10-26), prev / next skipping unwritten lessons, cp-less done rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COURSE, courseCard, courseLesson, courseOf, courseStep, entryDone, lessonKey, tasksDone, type CourseEntry } from '../src/app/course.ts';
import { LESSONS, type Lesson } from '../src/app/lessons.ts';
import { WORKS } from '../src/app/works.ts';

test('course order and mapping follow DECISIONS 2026-10-26', () => {
  assert.deepEqual(
    COURSE.map((e) => `${e.no}:${e.work}${e.cp ? '·' + e.cp : ''}`),
    ['0:basics', '1:weather·01', '2:weather·02', '3:weather·03', '4:basics·basics-pwm', '5:lamp·lamp-1', '6:basics·basics-buzz', '7:weather·05', '8:weather·04', '9:lamp·lamp-2', '10:usbkey·usbkey-1', '11:weather·06'],
  );
  for (const e of COURSE) assert.ok(WORKS[e.work], `work ${e.work}`);
  // Checkpoints already in a work must be listed there (basics gets its own in H-16)
  for (const e of COURSE) if (e.cp && e.work !== 'basics') assert.ok(WORKS[e.work].checkpoints.includes(e.cp), `${e.work} ${e.cp}`);
  assert.equal(lessonKey(COURSE[0]), 'lesson-0');
  assert.equal(lessonKey(COURSE[3]), '03');
});

test('every written lesson sits in the course under its own number', () => {
  for (const l of LESSONS) {
    const e = courseOf(l);
    assert.ok(e, `${l.work} ${l.checkpoint}`);
    assert.equal(e.no, l.no);
    assert.equal(courseLesson(e), l);
  }
  assert.equal(courseOf(null), null);
});

test('basics is a course-only work', () => {
  const b = WORKS.basics;
  assert.ok(b.courseOnly);
  assert.equal(b.card, undefined);
  assert.equal(b.example, 's3-blink');
});

test('prev / next skip unwritten lessons', () => {
  const written = new Set([1, 3, 5, 9]);
  const find = (e: CourseEntry) => (written.has(e.no) ? ({} as Lesson) : null);
  assert.equal(courseStep(3, 1, find)?.no, 5);
  assert.equal(courseStep(5, 1, find)?.no, 9);
  assert.equal(courseStep(9, 1, find), null);
  assert.equal(courseStep(5, -1, find)?.no, 3);
  assert.equal(courseStep(1, -1, find), null);
  // With today's lessons (1..3, 6) the real lookup skips 4 / 5 and stops after lesson 6
  assert.equal(courseStep(1, 1)?.no, 2);
  assert.equal(courseStep(3, 1)?.no, 6);
  assert.equal(courseStep(6, 1), null);
  assert.equal(courseStep(6, -1)?.no, 3);
  assert.equal(courseStep(1, -1), null);
});

const fake: Lesson = {
  ...LESSONS[0],
  work: 'basics',
  checkpoint: 'lesson-0',
  no: 0,
  steps: [
    { ...LESSONS[0].steps[0], tasks: [{ text: 'a', done: 'select:usb' }, { text: 'b', done: 'select:boot' }] },
    { ...LESSONS[0].steps[1], tasks: [{ text: 'c', done: 'select:chip' }] },
  ],
};

test('a lesson without a checkpoint is done once every task is ticked', () => {
  const all = () => ({ 0: {}, 1: {} });
  const some = (_w: string, _k: string, s: number) => (s === 0 ? { 0: {}, 1: {} } : {});
  assert.equal(tasksDone(fake, all), true);
  assert.equal(tasksDone(fake, some), false);
  assert.equal(tasksDone({ ...fake, steps: fake.steps.map((s) => ({ ...s, tasks: [] })) }, all), false);
  const seen: string[] = [];
  tasksDone(fake, (w, k, s) => (seen.push(`${w}/${k}/${s}`), { 0: 1, 1: 1 }));
  assert.deepEqual(seen, ['basics/lesson-0/0', 'basics/lesson-0/1']);
  // The checkpoint rule never applies to it, and a checkpoint lesson ignores ticks
  const yes = () => true;
  assert.equal(entryDone(COURSE[0], fake, yes, some), false);
  assert.equal(entryDone(COURSE[0], fake, () => false, all), true);
  assert.equal(entryDone(COURSE[1], LESSONS[0], () => false, all), false);
  assert.equal(entryDone(COURSE[1], LESSONS[0], yes, () => ({})), true);
});

test('courseCard passes ticks through for cp-less entries', () => {
  // Lesson 0 is not written yet, so it stays planned whatever the ticks say
  assert.equal(courseCard(COURSE[0], () => true, () => 0, null, () => ({ 0: 1 })).state, 'plan');
});
