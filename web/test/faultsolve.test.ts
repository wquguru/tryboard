// Wiring faults via the network solver (P2-14): each fault carries netlist params; with wasm built, values match core/crates/elec/src/fault.rs tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { wiresOf } from '../src/app/wiring.ts';
import { checkWiring, type WireFault } from '../src/app/wirecheck.ts';
import { consequence, estimateNet, type FaultExports } from '../src/app/faultsolve.ts';

const WEATHER = [
  { type: 'oled', addr: 0x3c, sda: 8, scl: 9 },
  { type: 'bme280', addr: 0x76, sda: 8, scl: 9 },
  { type: 'servo', pin: 4 },
] as never[];
const SONAR = [{ type: 'hcsr04', trig: 17, echo: 18 }] as never[];
const check = (p: never[], mods = {}) => checkWiring(p, wiresOf(p, false, mods));
const one = (fs: WireFault[], rule: string) => {
  const f = fs.find((x) => x.rule === rule);
  assert.ok(f, `no ${rule}: ${fs.map((x) => x.rule)}`);
  return f!;
};

const CASES = {
  drive: () => one(check([...WEATHER, { type: 'pot', pin: 4 }] as never[]), 'W1'),
  nores: () => one(check([...WEATHER, { type: 'led', pin: 6 }] as never[], { noResistor: ['led:6'] }), 'W3'),
  short3v3: () => one(check(WEATHER, { jumpers: [['3V3', 'GND']] }), 'W7'),
  short5v: () => one(check(WEATHER, { jumpers: [['GND', '5V']] }), 'W7'),
  nodiv: () => one(check(SONAR, { noDivider: ['hcsr04'] }), 'W2'),
  bme5v: () => one(check(WEATHER, { retarget: { 'wire:3V3~bme280:VIN': '5V' } }), 'W2'),
};

test('every fault carries a netlist: kind and params match tb_fault', () => {
  assert.deepEqual(CASES.drive().net, {
    kind: 1,
    cases: [
      { args: [3.3, 1], what: 'Pot wiper at the end (≈ tied straight to 3V3 / GND), GPIO drives the opposite level' },
      { args: [0, 1], what: 'Pot wiper at the end (≈ tied straight to 3V3 / GND), GPIO drives the opposite level' },
    ],
  });
  assert.deepEqual(CASES.nores().net?.kind, 3);
  assert.deepEqual(CASES.short3v3().net?.cases[0].args, [0]);
  assert.deepEqual(CASES.short5v().net?.cases[0].args, [1]);
  assert.deepEqual(CASES.nodiv().net?.cases.map((c) => c.args), [[50]]);
  assert.deepEqual(CASES.bme5v().net?.cases.map((c) => c.args), [[10_000], [10_000]]);
  // Jumpers are not parts: adding a harmless jumper (GND to GND) to the default wiring adds no issue
  assert.deepEqual(check(WEATHER, { jumpers: [['GND', 'GND']] }).map((f) => f.rule), []);
});

test('consequence text is bucketed by threshold (no wasm needed)', () => {
  assert.match(consequence(1, { i: 0.097, vPin: 0.1, v5: NaN, v33: NaN, limiter: 0 }), /over the datasheet 40 mA limit \(2\.4×\)/);
  assert.match(consequence(3, { i: 0.0349, vPin: 2.15, v5: NaN, v33: NaN, limiter: 0 }), /1\.7× overcurrent/);
  assert.match(consequence(4, { i: 0.717, vPin: 0, v5: 0.41, v33: 0.04, limiter: 4 }), /the onboard LDO dropping out/);
  assert.match(consequence(5, { i: 0.0001, vPin: 3.9, v5: 5, v33: 3.3, limiter: 0 }), /the current is small/);
});

const WASM = new URL('../public/wasm/tryboard.wasm', import.meta.url);
test('wasm solve: currents match elec unit tests / ngspice in magnitude (runs after tools/build_web.sh)', { skip: !existsSync(WASM) && 'no public/wasm/tryboard.wasm' }, async () => {
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM), {});
  const x = instance.exports as unknown as FaultExports;
  const mA = (f: WireFault) => estimateNet(x, f.net!, false)!.mA;
  // Pot to ground vs GPIO driving high 33 Ω: 3.3 / 34 = 97.1 mA (worse than the driving-low 90.8 mA, take the worst)
  assert.equal(mA(CASES.drive()), 97.1);
  // GPIO 33 Ω + red LED 1.8 V / 10 Ω: (3.3 - 1.8) / 43 = 34.9 mA
  assert.equal(mA(CASES.nores()), 34.9);
  // 3V3 short: USB foldback + LDO dropout ≈ 0.72 A; 5V short is only USB-limited ≈ 0.74 A (same as 13 / 14-*.cir)
  assert.ok(Math.abs(mA(CASES.short3v3()) - 717) < 2, String(mA(CASES.short3v3())));
  assert.ok(Math.abs(mA(CASES.short5v()) - 736) < 2, String(mA(CASES.short5v())));
  // HC-SR04 Echo straight at 5 V (50 Ω) into the clamp: ≈ 18 mA; BME280 10 kΩ pull-up is only 0.1 mA
  assert.ok(Math.abs(mA(CASES.nodiv()) - 18) < 1, String(mA(CASES.nodiv())));
  assert.ok(mA(CASES.bme5v()) > 0.05 && mA(CASES.bme5v()) < 0.2, String(mA(CASES.bme5v())));
  // Same params solved again give bit-identical results
  assert.deepEqual(estimateNet(x, CASES.short3v3().net!, false), estimateNet(x, CASES.short3v3().net!, false));
  assert.match(estimateNet(x, CASES.short3v3().net!, false)!.text, /limited by the onboard LDO dropping out/);
});
