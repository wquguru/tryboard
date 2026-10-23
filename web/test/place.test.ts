// Placing parts on the bench (P2-16): what can be placed, scene parts from wiring, wrong supply recorded as a retarget and caught
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlaced, mergeMods, pinOk, placeConflict, placeDef, type PlaceDef } from '../src/app/place.ts';
import { wiresOf } from '../src/app/wiring.ts';
import { checkWiring } from '../src/app/wirecheck.ts';
import { PARTS } from '../src/catalog/parts.ts';

const def = (id: string) => {
  const d = placeDef(id);
  assert.ok('steps' in d, `${id} should be placeable`);
  return d as PlaceDef;
};

test('placeable parts have steps, the rest give a reason', () => {
  for (const id of ['led-kit', 'button', 'bme280', 'ssd1306', 'sg90', 'buzzer-module', 'mpu6050', 'encoder', 'ws2812-stick8', 'hc-sr04', 'pot', 'aht20', 'ina219', 'ds3231']) def(id);
  for (const id of ['gc9a01', 'buzzer-passive', 'max98357a']) {
    const d = placeDef(id);
    assert.ok('why' in d && d.why.length > 4, id);
  }
  // Every catalog part gets a verdict (placeable / reason) without throwing
  for (const p of PARTS) placeDef(p.id);
});

test('LED on GPIO5 + GND -> led@5 in the scene, two wires', () => {
  const d = def('led-kit');
  const { spec, retarget } = buildPlaced(d, { IN: 'GPIO5', GND: 'GND' });
  assert.deepEqual(spec, { type: 'led', pin: 5 });
  assert.deepEqual(retarget, {});
  const w = wiresOf([spec]);
  assert.deepEqual(
    w.map((x) => [x.a, x.pin]),
    [
      ['GPIO5', 'IN'],
      ['GND', 'GND'],
    ],
  );
});

test('BME280 VCC on 5V -> recorded as a retarget, wiring check reports W2', () => {
  const d = def('bme280');
  const { spec, retarget } = buildPlaced(d, { VIN: '5V', GND: 'GND', SCL: 'GPIO9', SDA: 'GPIO8' });
  assert.deepEqual(spec, { type: 'bme280', addr: 0x76, sda: 8, scl: 9 });
  assert.deepEqual(retarget, { 'wire:3V3~bme280:VIN': '5V' });
  const f = checkWiring([spec], wiresOf([spec], false, mergeMods({}, retarget)));
  assert.ok(
    f.some((x) => x.rule === 'W2'),
    JSON.stringify(f.map((x) => x.rule)),
  );
  // On 3V3 -> no retarget, no issue
  const ok = buildPlaced(d, { VIN: '3V3', GND: 'GND', SCL: 'GPIO9', SDA: 'GPIO8' });
  assert.deepEqual(ok.retarget, {});
  assert.equal(checkWiring([ok.spec], wiresOf([ok.spec])).length, 0);
});

test('optional pins left open, pin classes, conflicts', () => {
  const m = buildPlaced(def('mpu6050'), { VCC: '3V3', GND: 'GND', SCL: 'GPIO9', SDA: 'GPIO8' });
  assert.deepEqual(m.spec, { type: 'mpu6050', addr: 0x68, sda: 8, scl: 9 });
  assert.ok(pinOk('gpio', 'GPIO48') && !pinOk('gpio', '3V3') && pinOk('power', '5V') && !pinOk('gnd', '5V'));
  const scene = { parts: [{ type: 'bme280' as const, addr: 0x76, sda: 8, scl: 9 }] };
  assert.match(placeConflict(def('bme280'), scene)!, /already a/);
  assert.equal(placeConflict(def('ssd1306'), scene), null);
  assert.equal(placeConflict(def('led-kit'), scene), null);
});
