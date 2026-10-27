// H-17: the schematic layout model follows the bench (sceneView + wiresOf) for lesson 01 / 03 and never drops a part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lessonFor } from '../src/app/lessons.ts';
import { WORKS } from '../src/app/works.ts';
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

// H-25: dedicated symbols per lesson (OLED screen, normally-open button incl. the board's BOOT, passive buzzer, servo M)
const workSch = (work: string, n: string, vertical: boolean, boot?: number) => {
  const l = lessonFor(work, n)!;
  const scene = WORKS[work]?.scene ?? sceneOf(work);
  const parts = sceneView(scene, l.parts ?? null).parts;
  return schematicOf(parts, lessonWires(scene.parts, l.parts ?? null), { vertical, boot });
};
const usesBoot = (work: string, n: string) => lessonFor(work, n)!.steps.some((s) => s.callouts.some((c) => c.target.kind === 'button' && c.target.id === 'BOOT'));
for (const vertical of [false, true]) {
  const tag = vertical ? 'phone' : 'desktop';
  test(`H-25 lesson 02 (${tag}): BOOT is SW1, a normally-open switch from GPIO0 to ground, picked as the 3D button`, () => {
    assert.ok(usesBoot('weather', '02'));
    const sch = workSch('weather', '02', vertical, 0);
    const sw = sch.syms.find((s) => s.kind === 'sw')!;
    assert.deepEqual([sw.ref, sw.glyph, sw.sub], ['SW1', 'button', 'BOOT']);
    assert.deepEqual(sw.pick, { kind: 'button', id: 'BOOT' });
    assert.deepEqual(sch.syms[0].pins.map((p) => p.name), ['GPIO0', 'GPIO5', 'GND']);
    assert.equal(sch.gnds.length, 3, 'BOOT, LED and board GND each end in a ground glyph');
    assert.ok(sw.x + sw.w <= sch.w && sw.y + sw.h <= sch.h);
    assert.equal(workSch('weather', '01', vertical).syms.some((s) => s.kind === 'sw'), false, 'no BOOT unless the lesson uses it');
  });
  test(`H-25 lesson 03 (${tag}): the OLED box carries the screen symbol and its 4 pins`, () => {
    const oled = workSch('weather', '03', vertical).syms.find((s) => s.part === 'oled')!;
    assert.equal(oled.glyph, 'oled');
    assert.equal(oled.pins.length, 4);
  });
  test(`H-25 lesson 06 (${tag}): passive buzzer is BZ1 with VCC / I/O / GND`, () => {
    const bz = workSch('basics', 'basics-buzz', vertical).syms.find((s) => s.part === 'buzzer')!;
    assert.deepEqual([bz.ref, bz.glyph], ['BZ1', 'buzzer']);
    assert.deepEqual(bz.pins.map((p) => p.name), ['VCC', 'I/O', 'GND']);
  });
  test(`H-25 lesson 07 (${tag}): servo is an M symbol with three wires`, () => {
    const m = workSch('weather', '05', vertical).syms.find((s) => s.part === 'servo')!;
    assert.equal(m.glyph, 'servo');
    assert.deepEqual(m.pins.map((p) => p.name), ['PWM', 'VCC', 'GND']);
  });
  test(`H-25 lesson 11 (${tag}): the capstone keeps every symbol (BME280 has its own since H-33)`, () => {
    const sch = workSch('weather', '06', vertical, usesBoot('weather', '06') ? 0 : undefined);
    const g = Object.fromEntries(sch.syms.filter((s) => s.kind === 'box').map((s) => [s.part, s.glyph ?? 'box']));
    assert.deepEqual(g, { oled: 'oled', bme280: 'bme280', servo: 'servo', buzzer: 'buzzer' });
    for (const s of sch.syms) assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= sch.w && s.y + s.h <= sch.h, `${s.ref} inside the sheet`);
  });
}
test('H-25 USB keypad buttons are SW1… with IN / GND', () => {
  const sws = workSch('usbkey', 'usbkey-2', false).syms.filter((s) => s.glyph === 'button');
  assert.deepEqual(sws.map((s) => `${s.ref}:${s.pins.length}`), ['SW1:2', 'SW2:2', 'SW3:2']);
});

// H-33: symbols the design sheets lack (BME280, pot, WS2812, HC-SR04); designators, pins and wires stay as before
const sceneSch = (work: string, vertical: boolean) => {
  const scene = WORKS[work]?.scene ?? sceneOf(work);
  return schematicOf(sceneView(scene, null).parts, lessonWires(scene.parts, null), { vertical });
};
const H33: [string, () => ReturnType<typeof schematicOf>[], string, string, string, string[], number][] = [
  ['BME280 (lesson 08)', () => [false, true].map((v) => workSch('weather', '04', v)), 'bme280', 'bme280', 'U2', ['GND', 'VIN', 'SCL', 'SDA'], 8],
  ['pot (lesson 09)', () => [false, true].map((v) => workSch('adc', 'lesson-9', v)), 'pot', 'pot', 'RV1', ['VCC', 'OUT', 'GND'], 9],
  ['WS2812 strip (lesson 05)', () => [false, true].map((v) => workSch('lamp', 'lamp-1', v)), 'ws2812', 'ws2812', 'D1', ['5V', 'DIN', 'GND'], 6],
  ['HC-SR04 (ultrasonic ruler)', () => [false, true].map((v) => sceneSch('ruler', v)), 'hcsr04', 'sonar', 'U2', ['VCC', 'Trig', 'Echo', 'GND'], 19],
];
for (const [name, make, part, glyph, ref, pins, lines] of H33) {
  test(`H-33 ${name}: ${glyph} glyph as ${ref}, pins and wires unchanged`, () => {
    for (const sch of make()) {
      const s = sch.syms.find((x) => x.part === part)!;
      assert.deepEqual([s.kind, s.glyph, s.ref, s.title], ['box', glyph, ref, ref]);
      assert.deepEqual(s.pins.map((p) => p.name), pins);
      assert.equal(sch.lines.length, lines);
      assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= sch.w && s.y + s.h <= sch.h, `${s.ref} inside the sheet`);
    }
  });
}
test('H-33 a WS2812 after a discrete LED takes the next D number', () => {
  const parts: PartSpec[] = [{ type: 'led', pin: 5 }, { type: 'ws2812', pin: 8 }];
  const sch = schematicOf(parts, [], { vertical: false });
  assert.deepEqual(sch.syms.filter((s) => s.kind === 'led' || s.glyph === 'ws2812').map((s) => s.ref), ['D1', 'D2']);
});
