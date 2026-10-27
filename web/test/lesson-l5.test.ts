// H-16 lesson 5 (WS2812 strip, lamp · lamp-1): the data points at the real lamp bench, firmware and source lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COURSE, courseLesson } from '../src/app/course.ts';
import { chipText, lessonFor } from '../src/app/lessons.ts';
import { lessonWires, partId, wiresOf } from '../src/app/wiring.ts';
import { hitText, matchTask, parseDone } from '../src/app/lessontasks.ts';
import type { SceneSpec } from '../src/bench3d/spec.ts';

const root = new URL('../../', import.meta.url);
const ex = (JSON.parse(readFileSync(new URL('firmware/examples.json', root), 'utf8')) as { id: string; scene?: SceneSpec }[]).find((e) => e.id === 'lamp')!;
const levels = JSON.parse(readFileSync(new URL('firmware/levels.json', root), 'utf8')) as { id: string; ref?: string; ws2812?: { pin: number; last?: { count: number } } }[];
const l = lessonFor('lamp', 'lamp-1')!;
const src = readFileSync(new URL(l.src, root), 'utf8').split('\n');

test('lesson 5 is the course entry for lamp · lamp-1 and runs the checkpoint reference', () => {
  const e = COURSE.find((x) => x.no === 5)!;
  assert.equal(e.work, 'lamp');
  assert.equal(e.cp, 'lamp-1');
  assert.equal(courseLesson(e), l);
  assert.equal(l.no, 5);
  assert.equal(l.fw, levels.find((x) => x.id === 'lamp-1')!.ref);
  assert.deepEqual(l.steps.map((s) => s.id), ['strip', 'power', 'bits', 'run', 'tweak']);
  for (const s of l.steps) assert.ok(s.tasks.length >= 2 && s.callouts.length >= 1, s.id);
});

test('bench shows only the strip, and every wire / pin the lesson names is drawn', () => {
  const ids = ex.scene!.parts.map(partId);
  assert.ok(ids.includes('encoder'), 'the lamp scene also has the knob');
  assert.deepEqual(l.parts, ['ws2812']);
  const rows = lessonWires(ex.scene!.parts, l.parts!).map((w) => w.id);
  assert.deepEqual(rows.sort(), Object.keys(l.wireNotes!).sort());
  assert.deepEqual(wiresOf(ex.scene!.parts.filter((p) => p.type === 'ws2812')).map((w) => w.id).sort(), rows);
  const strip = ex.scene!.parts.find((p) => p.type === 'ws2812') as { pin: number };
  for (const s of l.steps)
    for (const c of s.callouts) {
      if (c.target.kind === 'wire') assert.ok(rows.includes(c.target.id), `${s.id} ${c.key}`);
      if (c.target.kind === 'pin') assert.equal(c.target.id, `GPIO${strip.pin}`, `${s.id} ${c.key}`);
      if (c.target.kind === 'part') assert.ok(['board', 'ws2812'].includes(c.target.id), `${s.id} ${c.key}`);
    }
});

test('code lines and notes sit on the RMT / GRB code they explain', () => {
  const at = (n: number) => src[n - 1] ?? '';
  const step = (id: string) => l.steps.find((s) => s.id === id)!.codeLines ?? [];
  assert.ok(step('bits').some((n) => at(n).includes('.bit0')) && step('bits').some((n) => at(n).includes('grb[i * 3]')));
  assert.ok(step('run').every((n) => at(n).includes('strip_show(scale(WARM, 64), i)')));
  assert.ok(at(66).includes('#define WARM 0xFF9933'));
  assert.ok(at(54).includes('rmt_transmit') && at(49).includes('>> 8'));
  for (const c of l.code!) assert.ok(at(c.line).trim() && !/^\s*\/\//.test(at(c.line)), `line ${c.line}`);
});

test('the run step ticks on the strip signal for all LEDs of the checkpoint', () => {
  const lv = levels.find((x) => x.id === 'lamp-1')!.ws2812!;
  const task = l.steps.find((s) => s.id === 'run')!.tasks.find((x) => x.done.startsWith('strip:'))!;
  assert.deepEqual(parseDone(task.done), { kind: 'strip', pin: lv.pin, n: lv.last!.count });
  assert.equal(matchTask(task.done, 'strip:5=7', { boots: 0 }), null);
  assert.equal(matchTask(task.done, 'strip:6=8', { boots: 0 }), null);
  assert.deepEqual(matchTask(task.done, 'strip:5=8', { boots: 0 }), { v: '8' });
  assert.equal(parseDone('strip:5=0'), null);
  assert.match(hitText(task.done, { v: '8' }), /8/);
});

test('the feed counts lit LEDs off the rmt_transmit line, and the tweak step ticks on the USB port', () => {
  assert.deepEqual(l.strip!.map((r) => r.pin), [levels.find((x) => x.id === 'lamp-1')!.ws2812!.pin]);
  for (const r of l.strip!) assert.ok(src[r.line - 1].includes('rmt_transmit'), `line ${r.line}`);
  const tweak = l.steps.find((s) => s.id === 'tweak')!;
  const usb = tweak.tasks.find((x) => x.done === 'select:board@usb')!;
  assert.ok(matchTask(usb.done, 'select:board@usb', { boots: 0 }));
  assert.ok(tweak.callouts.some((c) => c.key === 'usb'));
});

test('H-28 colour chips on line 66: every value has a prebuilt WARM build that build_web.sh ships and accept.sh checks', () => {
  const tweak = l.steps.find((s) => s.id === 'tweak')!;
  const chips = tweak.codeChips!;
  assert.equal(chips.key, 'color');
  assert.equal(src[chips.line - 1], `#define WARM ${chipText(chips.key, chips.current)}`);
  assert.equal(chips.fw[chips.current], l.fw, 'the current value is the lesson firmware itself');
  const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
  const accept = JSON.parse(read('firmware/accept.json')) as { id: string; ws2812?: { frames: string[][] } }[];
  const ship = read('tools/build_web.sh');
  for (const v of chips.values) {
    const fw = chips.fw[v];
    const c = accept.find((x) => x.id === fw);
    assert.ok(c, `${fw} in accept.json`);
    // Lit colour = each channel × 64 ÷ 255, as line 62 scales it
    const want = '#' + [16, 8, 0].map((s) => Math.floor((((v >> s) & 0xff) * 64) / 255).toString(16).padStart(2, '0')).join('');
    assert.equal(c.ws2812!.frames[0][0], want, `${fw} first LED`);
    if (fw === l.fw) continue;
    assert.ok(ship.includes(`'${fw}'`), `${fw} shipped`);
    assert.match(read(`firmware/${fw}/main/CMakeLists.txt`), new RegExp(`STAGE=1 WARM=${chipText(chips.key, v)}\\b`));
  }
  // Both colour tasks tick off the chip row, not "Show answer"
  const want = chips.values.filter((v) => v !== chips.current).map((v) => `chip:color=${chipText(chips.key, v)}`);
  assert.deepEqual(tweak.tasks.filter((x) => x.done.startsWith('chip:')).map((x) => x.done), want);
  for (const d of want) assert.deepEqual(matchTask(d, d, { boots: 0, from: '0xFF9933' }), { v: d.slice(11), from: '0xFF9933' });
});
