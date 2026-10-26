// H-16 lesson 11 (capstone): full weather bench, generated pin table, source lines, power figures and new task kinds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L11 } from '../src/app/lessondata/l11.ts';
import { COURSE, courseLesson } from '../src/app/course.ts';
import { lessonFor } from '../src/app/lessons.ts';
import { lessonWires, partId, sceneView } from '../src/app/wiring.ts';
import { parseDone, taskTarget } from '../src/app/lessontasks.ts';
import { PART_BY_ID } from '../src/catalog/parts.ts';
import type { PartSpec } from '../src/bench3d/spec.ts';

const root = new URL('../../', import.meta.url);
const levels = JSON.parse(readFileSync(new URL('firmware/levels.json', root), 'utf8')) as { id: string; ref?: string; assembly?: boolean; pwm?: { pin: number; min: number; max: number }; oled_min_pixels?: number }[];
const examples = JSON.parse(readFileSync(new URL('firmware/examples.json', root), 'utf8')) as { id: string; scene?: { parts: PartSpec[] } }[];
const weather = examples.find((e) => e.id === 'weather')!.scene!;
const src = readFileSync(new URL(L11.src, root), 'utf8').split('\n');
const board = readFileSync(new URL('core/crates/elec/src/board.rs', root), 'utf8');
const lv = levels.find((x) => x.id === '06')!;

test('lesson 11 sits in the course as weather 06 with the assembly checkpoint', () => {
  const e = COURSE.find((x) => x.no === 11)!;
  assert.equal(e.work, 'weather');
  assert.equal(e.cp, '06');
  assert.equal(courseLesson(e), L11);
  assert.equal(lessonFor('weather', '06'), L11);
  assert.equal(L11.fw, lv.ref);
  assert.equal(lv.assembly, true);
  assert.equal(L11.buyAll, true);
});

test('no parts filter: the whole scene is on the bench and every wire has a note', () => {
  assert.equal(L11.parts, undefined);
  const ids = sceneView(weather, null).parts.map(partId);
  for (const p of ['oled', 'bme280', 'servo', 'buzzer', 'led:5']) assert.ok(ids.includes(p), p);
  for (const ext of [false, true]) {
    const rows = lessonWires(weather.parts, null, ext).map((w) => w.id);
    assert.deepEqual(rows.sort(), Object.keys(L11.wireNotes!).sort(), `ext5v=${ext}`);
  }
});

test('callouts and tasks point at real bench things; the new task kinds parse', () => {
  const rows = new Set(lessonWires(weather.parts, null).map((w) => w.id));
  const pins = new Set(['GPIO4', 'GPIO5', 'GPIO8', 'GPIO9', 'GPIO0']);
  const parts = new Set(['board', ...sceneView(weather, null).parts.map(partId)]);
  const dones = new Set<string>();
  for (const s of L11.steps) {
    assert.ok(s.callouts.length >= 2 && s.tasks.length >= 2, `${s.id}: callouts and tasks`);
    for (const c of s.callouts) {
      if (c.target.kind === 'wire') assert.ok(rows.has(c.target.id), `${s.id}: ${c.target.id}`);
      else if (c.target.kind === 'pin') assert.ok(pins.has(c.target.id), `${s.id}: ${c.target.id}`);
      else if (c.target.kind === 'button') assert.equal(c.target.id, 'BOOT');
      else assert.ok(parts.has(c.target.id), `${s.id}: ${c.target.id}`);
    }
    for (const x of s.tasks) {
      assert.ok(parseDone(x.done), `${s.id}: ${x.done}`);
      dones.add(x.done);
      const tg = taskTarget(x.done);
      if (tg) assert.ok(parts.has(tg.id) || pins.has(tg.id), `${s.id}: ${tg.id}`);
    }
  }
  for (const d of ['run', `oled:${lv.oled_min_pixels}`, 'follow:temp', 'asm:done', 'press:boot×1']) assert.ok(dones.has(d), d);
  assert.deepEqual(parseDone('oled:300'), { kind: 'oled', n: 300 });
  assert.deepEqual(parseDone('follow:temp'), { kind: 'follow', what: 'temp' });
  assert.deepEqual(parseDone('asm:done'), { kind: 'asm' });
});

test('code lines match firmware/weather and checkpoint 06', () => {
  const at = (n: number) => src[n - 1];
  assert.match(at(23), /ALARM_ON_T 3000/);
  assert.match(at(24), /ALARM_OFF_T 2900/);
  assert.match(at(47), /on_press/);
  assert.match(at(58), /return 500 \+ \(uint32_t\)t \/ 2;/);
  assert.match(at(67), /freq_hz = 50,/);
  assert.match(at(146), /text\(x, 4, s, 3\)/);
  assert.match(at(156), /flush\(\)/);
  assert.match(at(212), /gpio_isr_handler_add\(BTN_GPIO/);
  assert.match(at(222), /rd\(0xF7, d, 8\)/);
  assert.match(at(227), /t < 1800 \? "blue" : t < 2800 \? "green" : "red"/);
  assert.match(at(235), /temp_to_us\(t\)/);
  assert.match(at(242), /draw\(t, hh, p, fahrenheit\)/);
  assert.match(at(245), /printf\("T=/);
  assert.match(at(250), /ALARM_OFF_T : t >= ALARM_ON_T/);
  assert.match(at(268), /ts - last_press < 50000/);
  assert.match(at(270), /fahrenheit = !fahrenheit/);
  for (const c of L11.code!) assert.ok(src[c.line - 1]?.trim(), `line ${c.line}`);
  // 23.5 °C → 500 + 2350 / 2 = 1675 µs = the checkpoint's duty (pulse / 20 ms)
  assert.equal((500 + 2350 / 2) / 20000, lv.pwm!.min);
  assert.equal(lv.pwm!.min, lv.pwm!.max);
  assert.equal(lv.pwm!.pin, 4);
});

test('power estimate uses the catalog and the elec board model', () => {
  assert.match(board, /chip_idle: match chip \{\s+ChipKind::S3 => 0\.020/);
  assert.match(board, /chip_core: match chip \{\s+ChipKind::S3 => 0\.012/);
  assert.match(board, /board_3v3: 0\.011/);
  assert.match(board, /SGM2212[^\n]*\n[^\n]*800 mA/);
  assert.equal(PART_BY_ID.ssd1306.currentMa!.typ, 10);
  assert.equal(PART_BY_ID['buzzer-module'].currentMa!.typ, 30);
  assert.equal(PART_BY_ID.sg90.currentMa!.typ, 150);
  assert.equal(PART_BY_ID.sg90.currentMa!.peak, 700);
  assert.ok(L11.params!.some((p) => p.live === 'led-ma'));
  assert.ok(L11.params!.some((p) => p.source === 'datasheet' && p.doc));
  for (const p of L11.params!) if (/\d\s*m?A\b/.test(p.value) && p.source !== 'datasheet') assert.equal(p.source, 'estimate', p.label);
});
