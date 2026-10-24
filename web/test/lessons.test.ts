// H-01: beginner lesson data matches the firmware it teaches (code lines, reference build) and is translated in every locale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LESSONS, lessonFor } from '../src/app/lessons.ts';
import zh from '../src/i18n/zh/index.ts';
import ja from '../src/i18n/ja/index.ts';
import ko from '../src/i18n/ko/index.ts';

const root = new URL('../../', import.meta.url);
const levels = JSON.parse(readFileSync(new URL('firmware/levels.json', root), 'utf8')) as { id: string; ref?: string }[];

/** What each highlighted line must call, per lesson step (H-03 hangs events on these). */
const CALLS: Record<string, Record<string, string>> = {
  'weather/01': { loop: 'gpio_set_direction', run: 'gpio_set_level', tweak: 'vTaskDelay' },
};

test('weather lesson 01 has the five designed steps', () => {
  const l = lessonFor('weather', '01');
  assert.ok(l);
  assert.deepEqual(l.steps.map((s) => s.id), ['board', 'parts', 'loop', 'run', 'tweak']);
  assert.equal(lessonFor('weather', '02'), null);
  assert.equal(lessonFor('spin', '01'), null);
});

test('every lesson step is short and complete', () => {
  for (const l of LESSONS)
    for (const s of l.steps) {
      const sentences = s.body.split(/(?<=[.!?])\s+/).filter(Boolean);
      assert.ok(sentences.length <= 3, `${l.work}/${l.checkpoint}/${s.id}: ${sentences.length} sentences`);
      assert.ok(s.title && s.sub && s.tasks.length >= 1, `${s.id} title / sub / tasks`);
      for (const c of s.callouts) assert.ok(c.title && c.body && c.target.id, `${s.id} callout ${c.key}`);
    }
});

// H-02: each card needs its own spot on the bench, and anchors are the ones bench3d/pick.ts resolves
test('callouts in a step point at distinct, resolvable spots', () => {
  const anchors: Record<string, (string | undefined)[]> = { part: [undefined, 'usb', 'res', 'led'], pin: [undefined], wire: [undefined, '0', '1'], button: [undefined] };
  for (const l of LESSONS)
    for (const s of l.steps) {
      const spots = s.callouts.map((c) => `${c.target.kind}:${c.target.id}@${c.target.anchor ?? ''}`);
      assert.equal(new Set(spots).size, spots.length, `${s.id}: ${spots.join(', ')}`);
      for (const c of s.callouts) assert.ok(anchors[c.target.kind]?.includes(c.target.anchor), `${s.id} callout ${c.key} anchor ${c.target.anchor}`);
      assert.equal(new Set(s.callouts.map((c) => c.key)).size, s.callouts.length, `${s.id} keys`);
    }
});

test('lesson firmware is the checkpoint reference build', () => {
  for (const l of LESSONS) {
    const lv = levels.find((x) => x.id === l.checkpoint);
    assert.equal(l.fw, lv?.ref, `${l.work}/${l.checkpoint}`);
    const cmake = readFileSync(new URL(`firmware/${l.fw}/main/CMakeLists.txt`, root), 'utf8');
    const own = `firmware/${l.fw}/main/`;
    assert.ok(l.src.startsWith(own) || cmake.includes(l.src.replace(/^firmware\//, '../../')), `${l.fw} builds ${l.src}`);
  }
});

test('highlighted code lines contain the calls the step talks about', () => {
  for (const l of LESSONS) {
    const lines = readFileSync(new URL(l.src, root), 'utf8').split('\n');
    const want = CALLS[`${l.work}/${l.checkpoint}`] ?? {};
    for (const s of l.steps) {
      for (const n of s.codeLines ?? []) assert.ok(n >= 1 && n <= lines.length, `${s.id}: line ${n}`);
      if (want[s.id]) assert.ok(s.codeLines?.some((n) => lines[n - 1].includes(want[s.id])), `${s.id}: ${want[s.id]} on ${s.codeLines}`);
      // The chip's line holds the delay either as a literal or as BLINK_MS whose default is the current value (H-06)
      if (s.codeChips) {
        const ln = lines[s.codeChips.line - 1];
        const lit = ln.includes(`(${s.codeChips.current})`);
        const mac = /\b([A-Z_]+_MS)\b/.exec(ln)?.[1];
        assert.ok(lit || (mac && lines.some((x) => x.trim() === `#define ${mac} ${s.codeChips!.current}`)), `${s.id}: chip value ${s.codeChips.current}`);
      }
    }
    for (const [id, call] of Object.entries(want)) assert.ok(l.steps.some((s) => s.id === id), `${id} (${call}) step exists`);
  }
});

test('event rules point at the line that drives the pin (H-03)', () => {
  for (const l of LESSONS) {
    const lines = readFileSync(new URL(l.src, root), 'utf8').split('\n');
    for (const e of l.events ?? []) {
      assert.ok(e.pin >= 0 && e.pin < 49 && e.hi && e.lo, `${l.work}/${l.checkpoint}: rule for GPIO${e.pin}`);
      assert.ok(/gpio_set_level|digitalWrite/.test(lines[e.line - 1] ?? ''), `GPIO${e.pin} line ${e.line}: ${lines[e.line - 1]}`);
    }
  }
});

test('lesson text is translated in zh / ja / ko', () => {
  for (const l of LESSONS) {
    const strs = [l.title, l.summary, l.buy, ...(l.events ?? []).flatMap((e) => [e.hi, e.lo]), ...l.steps.flatMap((s) => [s.title, s.sub, s.body, ...s.tasks, ...s.callouts.flatMap((c) => [c.title, c.body]), ...(s.demo ?? []).flatMap((b) => [b.short, b.title, b.body])])];
    for (const [id, d] of Object.entries({ zh, ja, ko })) for (const k of strs) assert.ok(d[k], `${id}: ${k}`);
  }
});

test('H-05 demo beats point at wires the bench draws', () => {
  const demo = lessonFor('weather', '01')?.steps.find((s) => s.id === 'loop')?.demo;
  assert.ok(demo && demo.length === 4, 'loop step has four beats');
  assert.equal(demo.at(-1)?.flow, true, 'last beat shows current');
  for (const l of LESSONS)
    for (const s of l.steps)
      for (const b of s.demo ?? []) {
        assert.ok(b.short && b.title && b.body && b.focus.id, `${s.id}: beat text`);
        assert.ok(b.body.split(/(?<=[.!?])\s+/).filter(Boolean).length <= 3, `${s.id}: ${b.title} is short`);
        if (b.focus.kind === 'wire') assert.ok(l.circuit?.path.includes(b.focus.id), `${b.focus.id} is a circuit wire`);
        if (b.wire) {
          const ids = [`wire:${b.wire.from}~${b.wire.to}`, `wire:${b.wire.to}~${b.wire.from}`];
          assert.ok(ids.some((x) => l.circuit?.path.includes(x)), `${b.wire.from} → ${b.wire.to} is a circuit wire`);
        }
      }
});
