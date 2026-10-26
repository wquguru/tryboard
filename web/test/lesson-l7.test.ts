// H-16 lesson 7 (servo): data points at the real bench, source lines and checkpoint 05.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L7 } from '../src/app/lessondata/l7.ts';
import { COURSE, courseLesson } from '../src/app/course.ts';
import { lessonFor } from '../src/app/lessons.ts';
import { lessonWires, partId, sceneView } from '../src/app/wiring.ts';
import { parseDone, taskTarget } from '../src/app/lessontasks.ts';
import type { PartSpec } from '../src/bench3d/spec.ts';

const root = new URL('../../', import.meta.url);
const levels = JSON.parse(readFileSync(new URL('firmware/levels.json', root), 'utf8')) as { id: string; ref?: string; pwm?: { pin: number; freq: number; steps: number[] } }[];
const examples = JSON.parse(readFileSync(new URL('firmware/examples.json', root), 'utf8')) as { id: string; scene?: { parts: PartSpec[] } }[];
const weather = examples.find((e) => e.id === 'weather')!.scene!;
const src = readFileSync(new URL(L7.src, root), 'utf8').split('\n');
const lv = levels.find((x) => x.id === '05')!;

test('lesson 7 sits in the course as weather 05', () => {
  const e = COURSE.find((x) => x.no === 7)!;
  assert.equal(e.work, 'weather');
  assert.equal(e.cp, '05');
  assert.equal(courseLesson(e), L7);
  assert.equal(lessonFor('weather', '05'), L7);
  assert.equal(L7.no, 7);
  assert.equal(L7.fw, lv.ref);
});

test('bench shows only the servo, on the checkpoint pin', () => {
  assert.deepEqual(L7.parts, ['servo']);
  const view = sceneView(weather, L7.parts!);
  assert.deepEqual(view.parts.map(partId), ['servo']);
  const sv = view.parts[0] as Extract<PartSpec, { type: 'servo' }>;
  assert.equal(sv.pin, lv.pwm!.pin);
  assert.match(readFileSync(new URL(`firmware/${L7.fw}/main/CMakeLists.txt`, root), 'utf8'), new RegExp(`SERVO_GPIO=${sv.pin}\\b`));
});

test('wire notes and callouts use the bench wires, with or without external 5 V', () => {
  for (const ext of [false, true]) {
    const rows = lessonWires(weather.parts, L7.parts!, ext).map((w) => w.id);
    assert.deepEqual(rows.sort(), Object.keys(L7.wireNotes!).sort(), `ext5v=${ext}`);
  }
  const rows = new Set(lessonWires(weather.parts, L7.parts!).map((w) => w.id));
  const keys = new Set<string>();
  for (const s of L7.steps) {
    assert.ok(s.callouts.length >= 2 && s.tasks.length >= 2, `${s.id}: callouts and tasks`);
    for (const c of s.callouts) {
      keys.add(c.key);
      if (c.target.kind === 'wire') assert.ok(rows.has(c.target.id), `${s.id}: ${c.target.id}`);
      else if (c.target.kind === 'pin') assert.equal(c.target.id, `GPIO${lv.pwm!.pin}`);
      else assert.equal(c.target.id, 'servo');
    }
    for (const x of s.tasks) {
      assert.ok(parseDone(x.done), `${s.id}: ${x.done}`);
      const tg = taskTarget(x.done);
      if (tg) assert.ok(['servo', `GPIO${lv.pwm!.pin}`].includes(tg.id), `${s.id}: ${tg.id}`);
    }
  }
  for (const k of ['servo', 'sig', 'vcc', 'gnd', 'pin']) assert.ok(keys.has(k), `callout ${k}`);
  assert.deepEqual(L7.steps.map((s) => s.id), ['servo', 'power', 'pulse', 'run', 'tweak']);
  assert.ok(L7.steps.find((s) => s.id === 'run')!.tasks.some((x) => x.done === 'run'));
});

test('code lines and numbers match the firmware and checkpoint 05', () => {
  const at = (n: number) => src[n - 1];
  assert.match(at(13), /500 \+ angle \* 2000 \/ 180/);
  assert.match(at(14), /1 << 14\) \/ 20000/);
  assert.match(at(21), /LEDC_TIMER_14_BIT/);
  assert.match(at(23), new RegExp(`freq_hz = ${lv.pwm!.freq}\\b`));
  assert.match(at(28), /SERVO_GPIO/);
  assert.match(at(35), /angles\[\] = \{0, 45, 90, 135, 180, 90\}/);
  assert.match(at(38), /ledc_set_duty/);
  assert.match(at(39), /ledc_update_duty/);
  assert.match(at(41), /vTaskDelay\(pdMS_TO_TICKS\(400\)\)/);
  // 0°..180° in 45° steps = the checkpoint's duty steps (pulse ms / 20 ms)
  const duty = [0, 45, 90, 135, 180].map((a) => (500 + (a * 2000) / 180) / 20000);
  assert.deepEqual(duty, lv.pwm!.steps);
  assert.ok(L7.params!.some((p) => p.source === 'datasheet' && p.doc));
  assert.ok(L7.params!.some((p) => p.source === 'typical'));
  assert.ok(L7.params!.some((p) => p.source === 'estimate'));
});
