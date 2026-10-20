// F-04a: tutorial parts on the web: CLI flags, script actions, bench placement and share-state round trip
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partsArgs, partsFromArgs, rc522Spec, type PartsDevs } from '../src/partsdev.ts';
import { action, cliArgs, fromScript, toScriptBody, type InputEvent, type InputLog } from '../src/inputlog.ts';
import { buildPlaced, placeDef, type PlaceDef } from '../src/app/place.ts';
import { wiresOf } from '../src/app/wiring.ts';
import { checkWiring } from '../src/app/wirecheck.ts';
import { decodeState, encodeState } from '../src/app/sharestate.ts';
import type { PartSpec } from '../src/bench3d/spec.ts';

const args = (flags: string[]) => (f: string) => {
  const i = flags.indexOf(f);
  return i < 0 ? undefined : flags[i + 1];
};

test('partsArgs matches the accept.json flags and inverts with partsFromArgs', () => {
  const pr: PartsDevs = { pir: { pin: 4, hold: 2 }, relay: { pin: 5 }, ldr: { pin: 3, lux: 300 } };
  assert.deepEqual(partsArgs(pr), ['--pir', '4,2', '--relay', '5', '--ldr', '3']);
  const ds: PartsDevs = { ds18b20: { pin: 4, n: 2 } };
  assert.deepEqual(partsArgs(ds), ['--ds18b20', '4,2']);
  for (const p of [pr, ds, { relay: { pin: 6, low: true }, pir: { pin: 2, hold: 5 } }]) assert.deepEqual(partsFromArgs(args(partsArgs(p))), p);
  assert.deepEqual(partsFromArgs(args(['--spi', 'gc9a01,rc522@cs=8'])), { rc522: { cs: 8 } });
  assert.equal(rc522Spec({ rc522: { cs: 7 } }, 'esp32c3'), 'rc522');
  assert.equal(rc522Spec({ rc522: { cs: 7 } }, 'esp32s3'), 'rc522@cs=7');
  assert.equal(partsFromArgs(args([])), undefined);
});

test('pir= / lux= / card= script actions round trip and reach the CLI command', () => {
  const ev: InputEvent[] = [
    { tMs: 0, kind: 'lux', lux: 500 },
    { tMs: 500, kind: 'pir', on: true },
    { tMs: 800, kind: 'pir', on: false },
    { tMs: 1500, kind: 'card', uid: 'DEADBEEF' },
    { tMs: 1600, kind: 'card', uid: 'none' },
  ];
  assert.deepEqual(ev.map(action), ['lux=500', 'pir=1', 'pir=0', 'card=DEADBEEF', 'card=none']);
  assert.deepEqual(fromScript(toScriptBody(ev)).map(action), ev.map(action));
  const log: InputLog = { version: 1, chip: 'esp32c3', i2c: [], lcd: false, events: ev, endMs: 2000, parts: { pir: { pin: 4, hold: 2 }, relay: { pin: 5 }, ldr: { pin: 3, lux: 300 }, rc522: {} } };
  assert.deepEqual(cliArgs(log, 'fw.bin', 'in.txt'), ['tryboard', 'run', 'fw.bin', '--spi', 'rc522', '--pir', '4,2', '--relay', '5', '--ldr', '3', '--inputs', 'in.txt']);
});

test('each tutorial part is placeable and wires up with no faults', () => {
  const pins: Record<string, Record<string, string>> = {
    ds18b20: { VDD: '3V3', DQ: 'GPIO4', GND: 'GND' },
    'hc-sr501': { VCC: '5V', OUT: 'GPIO4', GND: 'GND' },
    'relay-1ch': { VCC: '5V', IN: 'GPIO5', GND: 'GND' },
    'ldr-module': { VCC: '3V3', AO: 'GPIO3', GND: 'GND' },
    rc522: { '3.3V': '3V3', GND: 'GND', SDA: 'GPIO7', SCK: 'GPIO4', MOSI: 'GPIO6', MISO: 'GPIO5', RST: 'GPIO3' },
  };
  const specs: PartSpec[] = [];
  for (const [id, got] of Object.entries(pins)) {
    const d = placeDef(id);
    assert.ok('steps' in d, `${id} should be placeable`);
    for (const s of (d as PlaceDef).steps) if (!s.optional) assert.ok(got[s.pin], `${id} step ${s.pin}`);
    const { spec, retarget } = buildPlaced(d as PlaceDef, got);
    assert.deepEqual(retarget, {});
    const w = wiresOf([spec]);
    assert.deepEqual(checkWiring([spec], w), [], id);
    for (const [pin, net] of Object.entries(got)) assert.ok(w.some((x) => x.pin === pin && x.a === net), `${id} ${pin} -> ${net}`);
    specs.push(spec);
  }
  // Pins as the c3-pir-relay / c3-ds18b20 / c3-rc522 firmware expects
  assert.deepEqual(specs, [{ type: 'ds18b20', pin: 4 }, { type: 'pir', pin: 4, hold: 2 }, { type: 'relay', pin: 5 }, { type: 'ldr', pin: 3 }, { type: 'rc522', cs: 7, sck: 4, mosi: 6, miso: 5, rst: 3 }]);
});

test('3.3 V-only tutorial parts on the 5V rail are blocked by W2 (PIR and relay on 5V are fine)', () => {
  const cases: [string, Record<string, string>, boolean][] = [
    ['rc522', { '3.3V': '5V', GND: 'GND', SDA: 'GPIO7', SCK: 'GPIO4', MOSI: 'GPIO6', MISO: 'GPIO5' }, true],
    ['ldr-module', { VCC: '5V', AO: 'GPIO3', GND: 'GND' }, true],
    ['ds18b20', { VDD: '5V', DQ: 'GPIO4', GND: 'GND' }, true],
    ['hc-sr501', { VCC: '5V', OUT: 'GPIO4', GND: 'GND' }, false],
    ['relay-1ch', { VCC: '5V', IN: 'GPIO5', GND: 'GND' }, false],
  ];
  for (const [id, got, bad] of cases) {
    const { spec, retarget } = buildPlaced(placeDef(id) as PlaceDef, got);
    const rules = checkWiring([spec], wiresOf([spec], false, { retarget })).map((f) => f.rule);
    assert.equal(rules.includes('W2'), bad, `${id}: ${rules.join(',')}`);
  }
});

test('share state keeps the tutorial parts in the scene', async () => {
  const scene = { parts: [{ type: 'ds18b20', pin: 4, n: 2 }, { type: 'pir', pin: 4, hold: 2 }, { type: 'relay', pin: 5, low: true }, { type: 'ldr', pin: 3, lux: 120 }, { type: 'rc522', cs: 7, sck: 4, mosi: 6, miso: 5, rst: 3 }] as PartSpec[] };
  const st = { v: 1 as const, w: 'blank:weather', scene };
  assert.deepEqual((await decodeState(await encodeState(st))).scene, scene);
});
