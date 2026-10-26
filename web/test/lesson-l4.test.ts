// H-16 lesson 4 (breathing light): data points at the real basics bench, the s3-fade source and the basics-pwm checkpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COURSE, courseLesson, courseOf } from '../src/app/course.ts';
import { lessonFor } from '../src/app/lessons.ts';
import { lessonWires, partId, sceneView } from '../src/app/wiring.ts';
import { WORKS } from '../src/app/works.ts';
import type { SceneSpec } from '../src/bench3d/spec.ts';

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const l = lessonFor('basics', 'basics-pwm')!;
const src = read('firmware/s3-fade/main/main.c').split('\n');
const examples = JSON.parse(read('firmware/examples.json')) as { id: string; scene?: SceneSpec }[];
const scene = examples.find((e) => e.id === WORKS.basics.example)!.scene!;

test('lesson 4 sits in the course and its work lists the checkpoint', () => {
  const e = COURSE.find((x) => x.no === 4)!;
  assert.equal(courseLesson(e), l);
  assert.equal(courseOf(l), e);
  assert.ok(WORKS.basics.checkpoints.includes('basics-pwm'));
  assert.equal(l.steps.length, 5);
  assert.deepEqual(
    l.steps.map((s) => s.id),
    ['pwm', 'loop', 'code', 'run', 'tweak'],
  );
  for (const s of l.steps) assert.ok(s.tasks.length >= 2 && s.callouts.length >= 1, `${s.id}: tasks and callouts`);
});

test('parts, pins and wires exist on the basics bench', () => {
  const ids = scene.parts.map(partId);
  for (const p of l.parts ?? []) assert.ok(ids.includes(p), p);
  const wires = lessonWires(sceneView(scene, l.parts ?? null).parts, l.parts ?? null).map((w) => w.id);
  for (const w of l.circuit!.path.filter((x) => x.startsWith('wire:'))) assert.ok(wires.includes(w), w);
  for (const w of Object.keys(l.wireNotes!)) assert.ok(wires.includes(w), w);
  for (const s of l.steps)
    for (const c of s.callouts) {
      if (c.target.kind === 'pin') assert.match(c.target.id, /^GPIO5$/);
      if (c.target.kind === 'wire') assert.ok(wires.includes(c.target.id), c.target.id);
      if (c.target.kind === 'part') assert.ok(c.target.id === 'board' || ids.includes(c.target.id), c.target.id);
    }
});

test('PWM feed rule and code lines point at the LEDC calls', () => {
  assert.deepEqual(l.events ?? [], []);
  const [r] = l.pwm!;
  assert.equal(r.pin, 5);
  assert.match(src[r.line - 1], /ledc_set_duty\(/);
  assert.ok(r.text.includes('{pct}'));
  const at = (id: string) => l.steps.find((s) => s.id === id)!.codeLines!.map((n) => src[n - 1]).join('\n');
  assert.match(at('code'), /duty_resolution[\s\S]*freq_hz = 5000/);
  assert.match(at('run'), /ledc_set_duty/);
  assert.match(at('loop'), /gpio_num = LED_GPIO/);
  assert.match(src.find((x) => x.startsWith('#define LED_GPIO'))!, /LED_GPIO 5$/);
});

test('period chips have prebuilt firmware that build_web.sh ships and accept.sh runs', () => {
  const chips = l.steps.find((s) => s.codeChips)!.codeChips!;
  assert.match(src[chips.line - 1], /#define FADE_MS 2000/);
  const accept = (JSON.parse(read('firmware/accept.json')) as { id: string }[]).map((c) => c.id);
  const ship = read('tools/build_web.sh');
  for (const [v, fw] of Object.entries(chips.fw)) {
    assert.ok(accept.includes(fw), `${fw} in accept.json`);
    if (fw === l.fw) continue;
    assert.ok(ship.includes(`'${fw}'`), `${fw} shipped`);
    assert.match(read(`firmware/${fw}/main/CMakeLists.txt`), new RegExp(`FADE_MS=${v}\\b`));
  }
});

test('checkpoint basics-pwm judges a full breath on GPIO5', () => {
  const lv = (JSON.parse(read('firmware/levels.json')) as { id: string; ref?: string; work?: string; pwm?: { pin: number; freq: number; steps?: number[] } }[]).find((x) => x.id === 'basics-pwm')!;
  assert.equal(lv.ref, l.fw);
  assert.equal(lv.work, 'basics');
  assert.equal(lv.pwm?.pin, 5);
  assert.equal(lv.pwm?.freq, 5000);
  const st = lv.pwm!.steps!;
  const top = st.indexOf(1);
  assert.ok(top > 0 && st[0] === 0 && st.at(-1) === 0, 'rises from 0 to 1 and back to 0');
  // Params named "code" must match the source
  const code = l.params!.filter((p) => p.source === 'code').map((p) => p.value);
  assert.ok(code.includes('5000 Hz') && code.includes('2000 ms'));
  assert.equal(l.params!.find((p) => p.live === 'led-ma')?.source, 'estimate');
});
