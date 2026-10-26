// H-16 lesson 8 (BME280): data points at the real bench, source lines, checkpoint 04 and the env auto-tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L8 } from '../src/app/lessondata/l8.ts';
import { COURSE, courseLesson } from '../src/app/course.ts';
import { lessonFor } from '../src/app/lessons.ts';
import { lessonWires, partId, sceneView } from '../src/app/wiring.ts';
import { hitText, matchTask, parseDone, taskTarget } from '../src/app/lessontasks.ts';
import type { PartSpec } from '../src/bench3d/spec.ts';

const root = new URL('../../', import.meta.url);
const levels = JSON.parse(readFileSync(new URL('firmware/levels.json', root), 'utf8')) as { id: string; ref?: string; args?: string[] }[];
const examples = JSON.parse(readFileSync(new URL('firmware/examples.json', root), 'utf8')) as { id: string; scene?: { parts: PartSpec[] } }[];
const weather = examples.find((e) => e.id === 'weather')!.scene!;
const src = readFileSync(new URL(L8.src, root), 'utf8').split('\n');
const lv = levels.find((x) => x.id === '04')!;

test('lesson 8 sits in the course as weather 04', () => {
  const e = COURSE.find((x) => x.no === 8)!;
  assert.equal(e.work, 'weather');
  assert.equal(e.cp, '04');
  assert.equal(courseLesson(e), L8);
  assert.equal(lessonFor('weather', '04'), L8);
  assert.equal(L8.no, 8);
  assert.equal(L8.fw, lv.ref);
});

test('bench shows only the BME280, on the pins the s3 build uses', () => {
  assert.deepEqual(L8.parts, ['bme280']);
  const view = sceneView(weather, L8.parts!);
  assert.deepEqual(view.parts.map(partId), ['bme280']);
  const b = view.parts[0] as Extract<PartSpec, { type: 'bme280' }>;
  assert.equal(b.addr, 0x76);
  const cmake = readFileSync(new URL(`firmware/${L8.fw}/main/CMakeLists.txt`, root), 'utf8');
  assert.match(cmake, new RegExp(`PIN_SDA=${b.sda}\\b`));
  assert.match(cmake, new RegExp(`PIN_SCL=${b.scl}\\b`));
  assert.match(cmake, new RegExp(L8.src.replace('firmware/', '').replace(/\./g, '\\.')));
  // The OLED stays in the simulated scene: the scan line the lesson explains lists 0x3C too
  assert.ok(weather.parts.some((p) => p.type === 'oled' && p.addr === 0x3c));
  assert.ok(lv.args!.join(' ').includes('bme280@0x76'));
});

test('wire notes and callouts use the bench wires', () => {
  const rows = new Set(lessonWires(weather.parts, L8.parts!).map((w) => w.id));
  assert.deepEqual([...rows].sort(), Object.keys(L8.wireNotes!).sort());
  const keys = new Set<string>();
  for (const s of L8.steps) {
    assert.ok(s.callouts.length >= 1 && s.tasks.length >= 2, `${s.id}: callouts and tasks`);
    for (const c of s.callouts) {
      keys.add(c.key);
      if (c.target.kind === 'wire') assert.ok(rows.has(c.target.id), `${s.id}: ${c.target.id}`);
      else if (c.target.kind === 'pin') assert.ok(['GPIO8', 'GPIO9'].includes(c.target.id));
      else assert.equal(c.target.id, 'bme280');
    }
    for (const x of s.tasks) {
      assert.ok(parseDone(x.done), `${s.id}: ${x.done}`);
      const tg = taskTarget(x.done);
      if (tg) assert.ok(['bme280', 'GPIO8'].includes(tg.id), `${s.id}: ${tg.id}`);
    }
    for (const n of s.codeLines ?? []) assert.ok(L8.code!.some((c) => c.line === n), `${s.id}: line ${n} explained`);
  }
  for (const k of ['bme', 'sda', 'scl', 'vin', 'gnd']) assert.ok(keys.has(k), `callout ${k}`);
  assert.deepEqual(L8.steps.map((s) => s.id), ['bme280', 'bus', 'calc', 'run', 'tweak']);
  assert.ok(L8.steps.find((s) => s.id === 'run')!.tasks.some((x) => x.done === 'run'));
  assert.deepEqual(L8.steps.find((s) => s.id === 'tweak')!.tasks.map((x) => x.done), ['env:temp', 'env:humidity']);
});

test('code lines and numbers match the firmware', () => {
  const at = (n: number) => src[n - 1];
  assert.match(at(16), /BME_ADDR 0x76/);
  assert.match(at(23), /i2c_master_transmit_receive/);
  assert.match(at(36), /sda_io_num = PIN_SDA/);
  assert.match(at(37), /scl_io_num = PIN_SCL/);
  assert.match(at(40), /enable_internal_pullup = true/);
  assert.match(at(45), /i2c_master_probe/);
  assert.match(at(48), /scl_speed_hz = 100000/);
  assert.match(at(52), /rd\(0xD0/);
  assert.match(at(56), /rd\(0x88, c, 26\)/);
  assert.match(at(57), /rd\(0xE1, h, 7\)/);
  assert.match(at(58), /bme280_parse_calib/);
  assert.match(at(62), /wr\(0xF2, 0x01\)/);
  assert.match(at(64), /wr\(0xF4, 0x27\)/);
  assert.match(at(68), /vTaskDelay\(pdMS_TO_TICKS\(1000\)\)/);
  assert.match(at(70), /rd\(0xF7, d, 8\)/);
  assert.match(at(74), /comp_t/);
  assert.match(at(76), /comp_h/);
  assert.match(at(77), /printf\("T=/);
  assert.deepEqual(L8.i2c, [{ addr: 0x76, text: L8.i2c![0].text, line: 23, reads: true }]);
  assert.ok(L8.params!.some((p) => p.source === 'datasheet' && p.doc));
  assert.ok(L8.params!.some((p) => p.label === 'I2C clock' && p.source === 'code' && p.value === '100 kHz'));
  assert.ok(L8.params!.some((p) => p.source === 'estimate'));
});

test('env tasks tick on a real change of that value only', () => {
  assert.deepEqual(parseDone('env:temp'), { kind: 'env', key: 'temp' });
  assert.equal(parseDone('env:wind'), null);
  assert.deepEqual(matchTask('env:temp', 'env:temp=30', { boots: 0, from: '23.5' }), { v: '30', from: '23.5' });
  assert.equal(matchTask('env:temp', 'env:temp=23.5', { boots: 0, from: '23.5' }), null);
  assert.equal(matchTask('env:temp', 'env:humidity=60', { boots: 0, from: '45' }), null);
  assert.equal(matchTask('env:humidity', 'env:humidity=60', { boots: 0, from: '45' })?.v, '60');
  assert.match(hitText('env:temp', { v: '30', from: '23.5' }), /23\.5 °C → 30 °C/);
  assert.match(hitText('env:humidity', { v: '60', from: '45' }), /45 % → 60 %/);
  assert.deepEqual(taskTarget('env:temp'), { kind: 'part', id: 'bme280' });
  assert.equal(taskTarget('env:pressure'), null);
});
