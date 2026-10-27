// H-15: course layer — lesson order and mapping (DECISIONS 2026-10-26), prev / next skipping unwritten lessons, cp-less done rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COURSE, courseCard, courseLesson, courseOf, courseStep, entryDone, lessonFinished, lessonKey, tasksDone, tasksLeft, type CourseEntry } from '../src/app/course.ts';
import { LESSONS, type Lesson } from '../src/app/lessons.ts';
import { WORKS } from '../src/app/works.ts';

test('course order and mapping follow DECISIONS 2026-10-26', () => {
  assert.deepEqual(
    COURSE.map((e) => `${e.no}:${e.work}${e.cp ? '·' + e.cp : ''}`),
    ['0:basics', '1:weather·01', '2:weather·02', '3:weather·03', '4:basics·basics-pwm', '5:lamp·lamp-1', '6:basics·basics-buzz', '7:weather·05', '8:weather·04', '9:adc', '10:usbkey·usbkey-2', '11:weather·06'],
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
  // All 12 lessons are written (H-16)
  assert.equal(courseStep(1, 1)?.no, 2);
  assert.equal(courseStep(3, 1)?.no, 4);
  assert.equal(courseStep(4, 1)?.no, 5);
  assert.equal(courseStep(5, 1)?.no, 6);
  assert.equal(courseStep(6, 1)?.no, 7);
  assert.equal(courseStep(7, 1)?.no, 8);
  assert.equal(courseStep(8, 1)?.no, 9);
  assert.equal(courseStep(9, 1)?.no, 10);
  assert.equal(courseStep(9, -1)?.no, 8);
  assert.equal(courseStep(8, -1)?.no, 7);
  assert.equal(courseStep(10, 1)?.no, 11);
  assert.equal(courseStep(11, 1), null);
  assert.equal(courseStep(11, -1)?.no, 10);
  assert.equal(courseStep(10, -1)?.no, 9);
  assert.equal(courseStep(1, -1)?.no, 0);
  assert.equal(courseStep(0, -1), null);
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
  // The checkpoint rule never applies to it; a checkpoint lesson is done by ticks too (H-20, was: ticks ignored)
  const yes = () => true;
  assert.equal(entryDone(COURSE[0], fake, yes, some), false);
  assert.equal(entryDone(COURSE[0], fake, () => false, all), true);
  assert.equal(entryDone(COURSE[1], LESSONS[0], () => false, all), true);
  assert.equal(entryDone(COURSE[1], LESSONS[0], () => false, some), false);
  assert.equal(entryDone(COURSE[1], LESSONS[0], yes, () => ({})), true);
});

test('courseCard passes ticks through for cp-less entries', () => {
  // Lesson 0 (H-16) has no checkpoint: passes don't count, only every task of every step ticked does
  const l0 = courseLesson(COURSE[0])!;
  const all = (_w: string, _k: string, s: number) => Object.fromEntries(l0.steps[s].tasks.map((_, i) => [i, 1]));
  assert.equal(courseCard(COURSE[0], () => true, () => 0, null, () => ({ 0: 1 })).state, 'ready');
  assert.equal(courseCard(COURSE[0], () => false, () => 0, null, all).state, 'done');
});

test('H-20: ticks or a passing checkpoint finish a lesson; only the checkpoint adds cpPassed', () => {
  const ticked = (l: Lesson) => (_w: string, _k: string, s: number) => Object.fromEntries(l.steps[s].tasks.map((_, i) => [i, 1]));
  const none = () => false;
  const zero = () => 0;
  for (const no of [1, 10]) {
    const e = COURSE[no];
    const l = courseLesson(e)!;
    assert.ok(e.cp && l.steps.some((s) => s.tasks.length), `lesson ${no} has a checkpoint and tasks`);
    const tasksOnly = courseCard(e, none, () => l.steps.length - 1, null, ticked(l));
    assert.equal(tasksOnly.state, 'done', `lesson ${no}: every task ticked`);
    assert.equal(tasksOnly.cpPassed, false);
    const cpOnly = courseCard(e, (w, cp) => w === e.work && cp === e.cp, zero, null);
    assert.equal(cpOnly.state, 'done', `lesson ${no}: checkpoint passed`);
    assert.equal(cpOnly.cpPassed, true);
    const both = courseCard(e, () => true, zero, null, ticked(l));
    assert.deepEqual([both.state, both.cpPassed], ['done', true]);
    assert.equal(courseCard(e, none, zero, null).state, 'ready');
    assert.equal(courseCard(e, none, () => 2, null).state, 'current');
    assert.equal(courseCard(e, none, zero, { work: e.work, cp: e.cp!, step: 0 }).state, 'current');
  }
  // No-checkpoint lessons (0 and 9) keep their rule: ticks only, never cpPassed
  for (const no of [0, 9]) {
    const e = COURSE[no];
    const l = courseLesson(e);
    if (!l) continue;
    assert.equal(e.cp, undefined);
    assert.deepEqual([courseCard(e, () => true, zero, null).state, courseCard(e, () => true, zero, null).cpPassed], ['ready', false]);
    const done = courseCard(e, () => true, zero, null, ticked(l));
    assert.deepEqual([done.state, done.cpPassed], ['done', false]);
  }
  // A checkpoint lesson with no tasks at all is never done by ticks
  const bare: Lesson = { ...LESSONS[0], steps: LESSONS[0].steps.map((s) => ({ ...s, tasks: [] })) };
  assert.equal(tasksDone(bare, () => ({ 0: 1, 1: 1 })), false);
  assert.equal(entryDone(COURSE[1], bare, none, () => ({ 0: 1 })), false);
  assert.equal(entryDone(COURSE[1], bare, () => true, () => ({})), true);
});

test('H-30: past the last step the done panel needs the done rule (ticks or checkpoint)', () => {
  const ticked = (l: Lesson) => (_w: string, _k: string, s: number) => Object.fromEntries(l.steps[s].tasks.map((_, i) => [i, 1]));
  const lastOnly = (l: Lesson) => (_w: string, _k: string, s: number) => (s === l.steps.length - 1 ? {} : ticked(l)(_w, _k, s));
  const none = () => false;
  for (const no of [1, 10]) {
    const e = COURSE[no];
    const l = courseLesson(e)!;
    const n = l.steps.length;
    const end = { work: e.work, cp: e.cp!, step: n };
    // Pressed "Finish" with nothing ticked and no pass: not done, panel stays away
    const bare = courseCard(e, none, () => n, end);
    assert.equal(bare.state, 'current', `lesson ${no}: last step alone is not done`);
    assert.equal(lessonFinished(n, bare), false);
    // Last step's tasks still open: the hint names that step
    const most = courseCard(e, none, () => n, end, lastOnly(l));
    assert.equal(lessonFinished(n, most), false);
    assert.deepEqual(tasksLeft(l, lastOnly(l)).map((x) => x.step), [n - 1]);
    // Every task ticked, or the checkpoint passed: done
    const ticks = courseCard(e, none, () => n, end, ticked(l));
    assert.equal(lessonFinished(n, ticks), true);
    assert.deepEqual(tasksLeft(l, ticked(l)), []);
    const cp = courseCard(e, (w, c) => w === e.work && c === e.cp, () => n, end);
    assert.equal(lessonFinished(n, cp), true);
    // Done by the rule but still mid-lesson: the steps stay, the panel waits for "Finish"
    assert.equal(lessonFinished(n - 1, courseCard(e, () => true, () => n - 1, { ...end, step: n - 1 })), false);
  }
  assert.equal(lessonFinished(5, undefined), false);
});
