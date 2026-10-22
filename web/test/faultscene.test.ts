// Fault switches that move bench wires (G-02): the --i2c-bus knob of fault-i2c-swap swaps the BME280's SDA / SCL on the bench,
// W8 flags it against the firmware's pads, and the fix puts the scene back
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { faultLevel, faultScene, foundKnobs, knobsFromScene } from '../src/faults.ts';
import { wiresOf } from '../src/app/wiring.ts';
import { checkWiring } from '../src/app/wirecheck.ts';
import { bootOptions, type Level } from '../src/checks.ts';

const levels = JSON.parse(readFileSync(new URL('../../firmware/levels.json', import.meta.url), 'utf8')) as Level[];
const lv = levels.find((l) => l.id === 'fault-i2c-swap')!;
const WEATHER = { parts: [
  { type: 'oled', addr: 0x3c, sda: 8, scl: 9 },
  { type: 'bme280', addr: 0x76, sda: 8, scl: 9 },
  { type: 'servo', pin: 4 },
] } as never;
const FW = [{ sda: 8, scl: 9 }];
const rules = (sc: { parts: never[] }) => checkWiring(sc.parts, wiresOf(sc.parts), FW).map((f) => f.rule);

test('as found: BME280 moves to SDA 9 / SCL 8, the OLED stays, W8 fires', () => {
  const sc = faultScene(WEATHER, lv, foundKnobs(lv)) as unknown as { parts: { type: string; sda?: number; scl?: number }[] };
  assert.ok(sc);
  assert.deepEqual(sc.parts.map((p) => [p.type, p.sda, p.scl]).slice(0, 2), [['oled', 8, 9], ['bme280', 9, 8]]);
  assert.ok(rules(sc as never).includes('W8'));
  // The check run attaches the BME280 on the same swapped pads
  const dev = bootOptions(faultLevel(lv, foundKnobs(lv))).i2c.find((d) => d.kind === 'bme280');
  assert.deepEqual([dev?.sda, dev?.scl], [9, 8]);
});

test('fixed: the switch puts the wires back, no W8; an unchanged scene returns null', () => {
  const fix = { '--i2c-bus': lv.fault!.fix![1] };
  const swapped = faultScene(WEATHER, lv, foundKnobs(lv))!;
  const back = faultScene(swapped, lv, fix) as never as { parts: never[] };
  assert.ok(back);
  assert.ok(!rules(back).includes('W8'));
  assert.equal(faultScene(WEATHER, lv, fix), null);
  // Levels without an --i2c-bus switch never touch the bench
  const wire = levels.find((l) => l.id === 'fault-wire')!;
  assert.equal(faultScene(WEATHER, wire, foundKnobs(wire)), null);
});

test('leaving the swap: any other fault level puts the BME280 back on its home pads; undo reads the switch back', () => {
  const swapped = faultScene(WEATHER, lv, foundKnobs(lv))!;
  const wire = levels.find((l) => l.id === 'fault-wire')!;
  const back = faultScene(swapped, wire, foundKnobs(wire), WEATHER) as never as { parts: { type: string; sda?: number; scl?: number }[] };
  assert.deepEqual(back.parts.filter((p) => p.type === 'bme280').map((p) => [p.sda, p.scl]), [[8, 9]]);
  assert.ok(!rules(back as never).includes('W8'));
  // Switch values follow the bench: swapped scene → as found, home scene → the fix
  const fix = { '--i2c-bus': lv.fault!.fix![1] };
  assert.deepEqual(knobsFromScene(swapped, lv, fix), foundKnobs(lv));
  assert.deepEqual(knobsFromScene(WEATHER, lv, foundKnobs(lv)), fix);
});
