// H-01: beginner lesson data matches the firmware it teaches (code lines, reference build) and is translated in every locale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LESSONS, lessonFor } from '../src/app/lessons.ts';
import zh from '../src/i18n/zh/index.ts';
import ja from '../src/i18n/ja/index.ts';
import ko from '../src/i18n/ko/index.ts';

const root = new URL('../../', import.meta.url);
interface Level {
  id: string;
  ref?: string;
  script?: string;
  args?: string[];
  brief?: string;
  gpio_toggles?: { pin: number };
}
const levels = JSON.parse(readFileSync(new URL('firmware/levels.json', root), 'utf8')) as Level[];

/** What each highlighted line must call, per lesson step (H-03 hangs events on these). */
const CALLS: Record<string, Record<string, string>> = {
  'weather/01': { loop: 'gpio_set_direction', run: 'gpio_set_level', tweak: 'vTaskDelay' },
  'weather/02': { inout: 'GPIO_MODE_INPUT', code: 'gpio_isr_handler_add', run: 'gpio_set_level', tweak: '50000' },
  'weather/03': { oled: 'sda_io_num', addr: 'OLED_ADDR', fb: 'text(', run: 'flush()', tweak: '"TryBoard"' },
};

test('weather lesson 01 has the five designed steps', () => {
  const l = lessonFor('weather', '01');
  assert.ok(l);
  assert.deepEqual(l.steps.map((s) => s.id), ['board', 'parts', 'loop', 'run', 'tweak']);
  assert.equal(lessonFor('weather', '04'), null);
  assert.equal(lessonFor('spin', '01'), null);
});

test('weather lessons 02 / 03 have five steps with a run step (H-08)', () => {
  for (const [cp, ids] of [
    ['02', ['boot', 'inout', 'code', 'run', 'tweak']],
    ['03', ['oled', 'addr', 'fb', 'run', 'tweak']],
  ] as const) {
    const l = lessonFor('weather', cp);
    assert.ok(l, cp);
    assert.equal(l.no, Number(cp));
    assert.deepEqual(l.steps.map((s) => s.id), ids);
    for (const s of l.steps) assert.ok(s.callouts.length >= 1, `${cp}/${s.id} has a callout`);
  }
  assert.ok(lessonFor('weather', '02')!.steps.some((s) => s.callouts.some((c) => c.target.kind === 'button' && c.target.id === 'BOOT')));
  assert.ok(lessonFor('weather', '03')!.steps.some((s) => s.callouts.some((c) => c.target.kind === 'part' && c.target.id === 'oled')));
});

test('event pins and I2C addresses match the checkpoint (levels.json)', () => {
  const l2 = lessonFor('weather', '02')!;
  const lv2 = levels.find((x) => x.id === '02')!;
  const pressed = [...(lv2.script ?? '').matchAll(/gpio(\d+)=0/g)].map((m) => Number(m[1]));
  assert.ok(pressed.length > 0, 'checkpoint 02 presses a pin');
  for (const p of pressed) assert.ok(l2.events?.some((e) => e.pin === p && e.input), `input rule for GPIO${p}`);
  assert.ok(l2.events?.some((e) => e.pin === lv2.gpio_toggles?.pin && !e.input), `output rule for GPIO${lv2.gpio_toggles?.pin}`);
  const l3 = lessonFor('weather', '03')!;
  const lv3 = levels.find((x) => x.id === '03')!;
  const addrs = (lv3.args ?? []).flatMap((a) => [...a.matchAll(/@0x([0-9a-f]+)/gi)].map((m) => parseInt(m[1], 16)));
  assert.ok(addrs.length > 0 && (l3.i2c ?? []).length > 0);
  for (const r of l3.i2c ?? []) assert.ok(addrs.includes(r.addr), `0x${r.addr.toString(16)} is attached`);
  // The SDA / SCL callouts name the pins the checkpoint brief wires
  const pins = l3.steps.flatMap((s) => s.callouts).filter((c) => c.target.kind === 'pin').map((c) => c.target.id);
  const wired = [...(lv3.brief ?? '').matchAll(/(SDA|SCL)=GPIO(\d+)/g)];
  assert.equal(wired.length, 2);
  for (const [, sig, pin] of wired) assert.ok(pins.includes(`GPIO${pin}`), `${sig} callout on GPIO${pin}`);
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
      const re = e.input ? /FromISR|gpio_isr_handler_add|gpio_get_level|digitalRead/ : /gpio_set_level|digitalWrite/;
      assert.ok(re.test(lines[e.line - 1] ?? ''), `GPIO${e.pin} line ${e.line}: ${lines[e.line - 1]}`);
      if (e.hiLine) assert.ok(/xQueueReceive|gpio_get_level|digitalRead/.test(lines[e.hiLine - 1] ?? ''), `GPIO${e.pin} hiLine ${e.hiLine}: ${lines[e.hiLine - 1]}`);
    }
    for (const r of l.i2c ?? []) {
      assert.ok(r.addr > 0 && r.addr < 0x78 && r.text.includes('{n}'), `I2C rule 0x${r.addr.toString(16)}`);
      assert.ok(/flush\(|i2c_master_transmit|Wire\.endTransmission/.test(lines[r.line - 1] ?? ''), `I2C line ${r.line}: ${lines[r.line - 1]}`);
    }
  }
});

test('lesson text is translated in zh / ja / ko', () => {
  for (const l of LESSONS) {
    const strs = [l.title, l.summary, l.buy, ...(l.events ?? []).flatMap((e) => [e.hi, e.lo]), ...(l.i2c ?? []).map((r) => r.text), ...l.steps.flatMap((s) => [s.title, s.sub, s.body, ...s.tasks, ...s.callouts.flatMap((c) => [c.title, c.body])])];
    for (const [id, d] of Object.entries({ zh, ja, ko })) for (const k of strs) assert.ok(d[k], `${id}: ${k}`);
  }
});
