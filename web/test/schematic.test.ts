// H-17: the schematic layout model follows the bench (sceneView + wiresOf) for lesson 01 / 03 and never drops a part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lessonFor } from '../src/app/lessons.ts';
import { lessonWires, sceneView, type BenchWire } from '../src/app/wiring.ts';
import { schematicOf } from '../src/app/schematic/model.ts';
import { LED_HEX, LED_VF, ledAmps } from '../src/bench3d/ledparams.ts';
import type { PartSpec, SceneSpec } from '../src/bench3d/spec.ts';

const root = new URL('../../', import.meta.url);
const examples = JSON.parse(readFileSync(new URL('firmware/examples.json', root), 'utf8')) as { id: string; scene?: SceneSpec }[];
const works = readFileSync(new URL('web/src/app/works.ts', root), 'utf8');
const sceneOf = (work: string) => {
  const ex = new RegExp(`\\b${work}: \\{ id: '${work}',[^\\n]*?example: '([^']+)'`).exec(works)?.[1];
  return examples.find((e) => e.id === ex)?.scene ?? { parts: [] };
};
const lessonSch = (n: string, vertical = false) => {
  const l = lessonFor('weather', n)!;
  const scene = sceneOf('weather');
  const parts = sceneView(scene, l.parts ?? null).parts;
  return { parts, sch: schematicOf(parts, lessonWires(scene.parts, l.parts ?? null), { vertical }) };
};

for (const vertical of [false, true]) {
  const tag = vertical ? 'phone' : 'desktop';
  test(`H-17 lesson 01 (${tag}): GPIO5 → R1 → D1 → GND loop with a current estimate`, () => {
    const { sch } = lessonSch('01', vertical);
    assert.deepEqual(sch.syms.map((s) => `${s.ref}:${s.kind}`), ['U1:mcu', 'R1:res', 'D1:led']);
    const r = sch.syms.find((s) => s.ref === 'R1')!;
    assert.deepEqual(r.pick, { kind: 'part', id: 'led:5', anchor: 'res' });
    assert.equal(r.sub, '220 Ω');
    assert.equal(sch.syms.find((s) => s.ref === 'D1')!.color, 'red');
    assert.deepEqual(sch.syms[0].pins.map((p) => p.name), ['GPIO5', 'GND']);
    assert.equal(sch.gnds.length, 2, 'one ground glyph at the LED, one at the board GND pin');
    assert.equal(sch.flags.length, 0, 'a lone LED needs no net flags');
    const wires = sch.lines.flatMap((l) => (l.wire ? [l.wire] : []));
    assert.deepEqual(wires, ['wire:GPIO5~led:5:IN', 'wire:GND~led:5:GND'], 'loop lines carry the 3D wire ids');
    assert.equal(sch.flows.length, 1);
    assert.ok(Math.abs(sch.flows[0].mA - ledAmps(220, LED_VF.red) * 1000) < 1e-9);
    for (const s of sch.syms) assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= sch.w && s.y + s.h <= sch.h, `${s.ref} inside the sheet`);
  });

  test(`H-17 lesson 03 (${tag}): OLED joins by 3V3 / SDA / SCL / GND net flags`, () => {
    const { sch } = lessonSch('03', vertical);
    assert.deepEqual(sch.syms.map((s) => s.kind), ['mcu', 'res', 'led', 'box']);
    const oled = sch.syms.find((s) => s.kind === 'box')!;
    assert.equal(oled.ref, 'U2');
    assert.match(oled.sub!, /SSD1306.*0x3C/);
    assert.deepEqual(oled.pins.map((p) => p.name).sort(), ['GND', 'SCL', 'SDA', 'VCC']);
    const count = (n: string) => sch.flags.filter((f) => f.net === n).length;
    for (const n of ['3V3', 'SDA', 'SCL', 'GND']) assert.equal(count(n), 2, `${n}: one flag on each end`);
    assert.ok(sch.syms[0].pins.some((p) => p.name === 'GPIO8') && sch.syms[0].pins.some((p) => p.name === 'GPIO9'));
    assert.deepEqual(sch.nets.SDA, ['wire:GPIO8~oled:SDA']);
    assert.ok(sch.flags.filter((f) => f.net === 'SDA').every((f) => f.wire === 'wire:GPIO8~oled:SDA'));
    assert.ok(sch.nets.GND.includes('wire:GND~led:5:GND') && sch.nets.GND.includes('wire:GND~oled:GND'));
  });
}

test('H-17 LED colour and resistor follow the part card', () => {
  const parts: PartSpec[] = [{ type: 'led', pin: 4, ohm: 1000, color: LED_HEX.blue }];
  const sch = schematicOf(parts, lessonWires(parts, null));
  assert.equal(sch.syms.find((s) => s.kind === 'res')!.sub, '1k Ω');
  assert.equal(sch.syms.find((s) => s.kind === 'led')!.color, 'blue');
  assert.ok(Math.abs(sch.flows[0].mA - ledAmps(1000, LED_VF.blue) * 1000) < 1e-9);
  const nores = schematicOf(parts, lessonWires(parts, null, false, { noResistor: ['led:4'] }));
  assert.equal(nores.syms.some((s) => s.kind === 'res'), false, 'resistor pulled: drawn as a straight wire');
});

test('H-17 unknown parts fall back to a box with their pin names', () => {
  const parts = [{ type: 'zzz', pin: 7 } as unknown as PartSpec, { type: 'servo', pin: 4 } as PartSpec];
  const wires: BenchWire[] = [
    { id: 'wire:GPIO7~zzz:OUT', a: 'GPIO7', b: 'zzz:OUT', part: 'zzz', pin: 'OUT', role: '', pinRole: 'drive', color: '', lenCm: 10 },
    { id: 'wire:GND~zzz:G', a: 'GND', b: 'zzz:G', part: 'zzz', pin: 'G', role: '', pinRole: 'gnd', color: '', lenCm: 10 },
    ...lessonWires(parts.slice(1), null),
  ];
  for (const vertical of [false, true]) {
    const sch = schematicOf(parts, wires, { vertical });
    assert.equal(sch.syms.length, parts.length + 1);
    const box = sch.syms.find((s) => s.part === 'zzz')!;
    assert.equal(box.kind, 'box');
    assert.deepEqual(box.pins.map((p) => p.name), ['OUT', 'G']);
    assert.ok(sch.flags.some((f) => f.net === 'GPIO7' && f.end === 'board'));
    assert.ok(sch.syms.find((s) => s.part === 'servo')!.pins.length === 3);
  }
  const bare = schematicOf([{ type: 'nowires' } as unknown as PartSpec], []);
  assert.equal(bare.syms.length, 2, 'a part with no wires is still drawn');
});
