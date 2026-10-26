// H-01: beginner lesson data matches the firmware it teaches (code lines, reference build) and is translated in every locale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LESSONS, ledParamValue, lessonFor } from '../src/app/lessons.ts';
import { lessonWires, partId, sceneView, wiresOf } from '../src/app/wiring.ts';
import { LED_VF, ledAmps } from '../src/bench3d/ledparams.ts';
import { hitText, matchTask, parseDone, taskTarget } from '../src/app/lessontasks.ts';
import type { SceneSpec } from '../src/bench3d/spec.ts';
import { WORKS } from '../src/app/works.ts';
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
    const strs = [l.title, l.summary, l.buy, ...(l.events ?? []).flatMap((e) => [e.hi, e.lo]), ...(l.i2c ?? []).map((r) => r.text), ...l.steps.flatMap((s) => [s.title, s.sub, s.body, ...s.tasks.flatMap((x) => [x.text, x.how ?? '', x.answer ?? ''].filter(Boolean)), ...s.callouts.flatMap((c) => [c.title, c.body]), ...(s.demo ?? []).flatMap((b) => [b.short, b.title, b.body])])];
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

/** H-09: each work's bench scene (examples.json via the work's example id in works.ts). */
const examples = JSON.parse(readFileSync(new URL('firmware/examples.json', root), 'utf8')) as { id: string; scene?: SceneSpec }[];
const worksSrc = readFileSync(new URL('web/src/app/works.ts', root), 'utf8');
const sceneOf = (work: string): SceneSpec => {
  // H-16: a work's own scene (WorkDef.scene) wins over its example's, as in session.ts benchInit
  if (WORKS[work]?.scene) return WORKS[work].scene;
  const ex = new RegExp(`\\b${work}: \\{ id: '${work}',[^\\n]*?example: '([^']+)'`).exec(worksSrc)?.[1];
  return examples.find((e) => e.id === ex)?.scene ?? { parts: [] };
};
/** Scene part ids a bench reference (part / pin / wire id, or a wire end) belongs to; board pins belong to none. */
const owners = (ids: string[], ref: string) =>
  (ref.startsWith('wire:') ? ref.slice(5).split('~') : [ref]).flatMap((x) => ids.filter((id) => x === id || x.startsWith(id + ':')));

test('H-09 lesson parts exist in the work scene and cover everything the lesson points at', () => {
  for (const l of LESSONS) {
    const name = `${l.work}/${l.checkpoint}`;
    const ids = sceneOf(l.work).parts.map(partId);
    assert.ok(ids.length > 0, `${name}: work scene found`);
    if (!l.parts) continue;
    for (const p of l.parts) assert.ok(ids.includes(p), `${name}: part ${p} is in the scene (${ids.join(', ')})`);
    const refs: string[] = [...(l.circuit?.path ?? [])];
    for (const s of l.steps) {
      for (const c of s.callouts) refs.push(c.target.id);
      for (const x of s.tasks) {
        const tg = taskTarget(x.done);
        if (tg) refs.push(tg.id);
      }
      for (const b of s.demo ?? []) {
        refs.push(b.focus.id);
        if (b.wire) refs.push(b.wire.from, b.wire.to);
      }
    }
    for (const r of refs) for (const o of owners(ids, r)) assert.ok(l.parts.includes(o), `${name}: ${r} needs part ${o} on the bench`);
  }
  const l1 = lessonFor('weather', '01')!;
  const view = sceneView(sceneOf('weather'), l1.parts ?? null);
  assert.deepEqual(view.parts.map(partId), ['led:5'], 'lesson 01 bench = board + breadboard + LED (resistor is in the LED group)');
  assert.deepEqual(lessonFor('weather', '03')!.parts, ['led:5', 'oled']);
  const full = sceneOf('weather');
  assert.equal(sceneView(full, null), full, 'no filter = the same scene object');
});

test('H-10 every task has a valid done signal; reveal tasks carry an answer', () => {
  for (const l of LESSONS)
    for (const s of l.steps) {
      const name = `${l.work}/${l.checkpoint}/${s.id}`;
      const bootCallout = l.steps.some((x) => x.callouts.some((c) => c.target.id === 'BOOT'));
      const chips = l.steps.find((x) => x.codeChips)?.codeChips;
      for (const x of s.tasks) {
        const d = parseDone(x.done);
        assert.ok(d, `${name}: "${x.done}" parses`);
        assert.ok(x.text, `${name}: task text`);
        if (d.kind === 'reveal') assert.ok(x.answer, `${name}: reveal "${x.text}" has an answer`);
        else assert.ok(!x.answer, `${name}: only reveal tasks have answers`);
        if (d.kind === 'chip') assert.ok(chips?.fw[d.v], `${name}: delay ${d.v} has a prebuilt firmware`);
        if (d.kind === 'press') assert.ok(bootCallout, `${name}: press tasks only where BOOT is pointed at`);
        if (d.kind === 'run') assert.equal(s.id, 'run', `${name}: run tasks sit on the run step`);
      }
    }
});

test('H-10 signal matching', () => {
  const c0 = { boots: 0 };
  assert.deepEqual(matchTask('run', 'run', c0), {});
  assert.equal(matchTask('run', 'view:current', c0), null);
  assert.equal(matchTask('reveal', 'run', c0), null, 'reveal only ticks by opening it');
  assert.deepEqual(matchTask('view:current', 'view:current', c0), {});
  assert.deepEqual(matchTask('select:led:5', 'select:led:5', c0), { v: 'led:5' });
  assert.equal(matchTask('select:led:5', 'select:board', c0), null);
  assert.equal(matchTask('select:led', 'select:led:5', c0), null, 'ids match whole');
  assert.equal(matchTask('press:boot×3', 'press:boot', { boots: 2 }), null);
  assert.deepEqual(matchTask('press:boot×3', 'press:boot', { boots: 3 }), { v: '3' });
  assert.deepEqual(matchTask('press:bootx1', 'press:boot', { boots: 1 }), { v: '1' }, 'x works as ×');
  assert.equal(matchTask('press:boot×3', 'run', { boots: 5 }), null);
  assert.deepEqual(matchTask('chip:delay=100', 'chip:delay=100', { boots: 0, from: '500' }), { v: '100', from: '500' });
  assert.equal(matchTask('chip:delay=100', 'chip:delay=1000', c0), null);
  assert.deepEqual(matchTask('prop:led:5.ohm=1000', 'prop:led:5.ohm=1000', { boots: 0, from: '220' }), { v: '1000', from: '220' });
  assert.equal(matchTask('prop:led:5.ohm=1000', 'prop:led:5.ohm=220', c0), null);
  for (const bad of ['', 'runs', 'press:boot×0', 'press:boot', 'chip:delay=fast', 'prop:led.ohm', 'view:other', 'select:'])
    assert.equal(parseDone(bad), null, `"${bad}" is malformed`);
  assert.deepEqual(parseDone('prop:led:5.ohm=1000'), { kind: 'prop', part: 'led:5', key: 'ohm', v: '1000' });
  assert.deepEqual(taskTarget('select:BOOT'), { kind: 'button', id: 'BOOT' });
  assert.deepEqual(taskTarget('prop:led:5.ohm=1000'), { kind: 'part', id: 'led:5' });
  assert.equal(taskTarget('run'), null);
  assert.match(hitText('press:boot×3', { v: '3' }), /3/);
  assert.match(hitText('chip:delay=100', { v: '100', from: '500' }), /500.*100/);
  assert.equal(hitText('reveal', {}), '');
});

test('H-14 wiring tab rows = wiresOf of the lesson bench view; notes point at real rows', () => {
  for (const l of LESSONS) {
    const name = `${l.work}/${l.checkpoint}`;
    const scene = sceneOf(l.work);
    const rows = lessonWires(scene.parts, l.parts ?? null);
    const want = wiresOf(sceneView(scene, l.parts ?? null).parts);
    assert.ok(rows.length > 0, `${name}: has wiring rows`);
    assert.equal(rows.length, want.length, `${name}: row count`);
    assert.deepEqual(rows.map((w) => w.id), want.map((w) => w.id), `${name}: row ids`);
    const full = new Set(wiresOf(scene.parts).map((w) => w.id));
    for (const w of rows) assert.ok(full.has(w.id), `${name}: ${w.id} is a bench wire`);
    for (const k of Object.keys(l.wireNotes ?? {})) assert.ok(rows.some((w) => w.id === k), `${name}: note for ${k} matches a row`);
    for (const w of rows) assert.ok(l.wireNotes?.[w.id], `${name}: ${w.id} has beginner words`);
  }
  assert.equal(lessonWires(sceneOf('weather').parts, ['led:5']).length, 2, 'lesson 01: GPIO5 + GND');
  assert.equal(lessonWires(sceneOf('weather').parts, ['led:5', 'oled']).length, 6, 'lesson 03: LED + four OLED wires');
});

test('H-14 code notes point at real, non-blank source lines', () => {
  for (const l of LESSONS) {
    const lines = readFileSync(new URL(l.src, root), 'utf8').split('\n');
    assert.ok(l.code && l.code.length >= 5, `${l.checkpoint}: has code notes`);
    for (const c of l.code) {
      assert.ok(Number.isInteger(c.line) && c.line >= 1 && c.line <= lines.length, `${l.checkpoint}: line ${c.line} in 1..${lines.length}`);
      assert.ok(lines[c.line - 1].trim() && !/^\s*\/\//.test(lines[c.line - 1]), `${l.checkpoint}: line ${c.line} is code`);
      assert.ok(c.text, `${l.checkpoint}: line ${c.line} has text`);
    }
  }
  const at = (cp: string, n: number) => readFileSync(new URL(lessonFor('weather', cp)!.src, root), 'utf8').split('\n')[n - 1];
  assert.match(at('01', 22), /gpio_set_level/);
  assert.match(at('02', 43), /50000/);
  assert.match(at('03', 69), /flush\(\)/);
});

test('H-14 every parameter has a source; LED values follow the H-13 model', () => {
  const kinds = ['bench', 'code', 'datasheet', 'typical', 'estimate'];
  for (const l of LESSONS) {
    assert.ok(l.params && l.params.length >= 4, `${l.checkpoint}: has params`);
    assert.ok(l.buyTip, `${l.checkpoint}: has a buying tip`);
    for (const p of l.params) {
      assert.ok(p.label && p.value, `${l.checkpoint}: param text`);
      assert.ok(kinds.includes(p.source), `${l.checkpoint}: ${p.label} source ${p.source}`);
      if (p.source === 'datasheet') assert.ok(p.doc, `${l.checkpoint}: ${p.label} names its datasheet`);
    }
    assert.equal(new Set(l.params.map((p) => p.label)).size, l.params.length, `${l.checkpoint}: labels unique`);
  }
  const ma = lessonFor('weather', '01')!.params!.find((p) => p.live === 'led-ma')!;
  assert.equal(ma.source, 'estimate');
  assert.ok(ma.value.endsWith(`${(ledAmps(220, LED_VF.red) * 1000).toFixed(1)} mA`), ma.value);
  assert.match(ma.value, /5\.7 mA$/);
  assert.match(ledParamValue('led-ma', 1000, 'red'), /1\.4 mA$/);
  assert.match(ledParamValue('led-vf', 220, 'blue'), /2\.8 V/);
  assert.equal(ledParamValue('led-ohm', 1000, 'red'), '1k Ω');
});

test('H-14 tab text is translated in zh / ja / ko', () => {
  const words = /\b[a-z]{4,}\b/;
  for (const l of LESSONS) {
    const strs = [
      l.buyTip ?? '',
      ...(l.code ?? []).map((c) => c.text),
      ...Object.values(l.wireNotes ?? {}).flatMap((n) => [n.to, n.why]),
      ...(l.params ?? []).flatMap((p) => [p.label, p.doc ?? '', p.live || !words.test(p.value) ? '' : p.value]),
    ].filter(Boolean);
    for (const [id, d] of Object.entries({ zh, ja, ko })) for (const k of strs) assert.ok(d[k], `${id}: ${k}`);
  }
});
