// Harness (P2-11, estimate): I2C length -> rise time, antenna blockage -> RSSI, same numbers as i2cbus.rs / wifi/world.rs;
// bench wiring check W6; USB checkpoint verdicts (P2-12) follow tools/check.py
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { antennaLossDb, i2cLoad, maxWireCm, riseNs, rssiAfter, verdict, limitNs, wifiText } from '../src/app/harness.ts';
import { checkWiring } from '../src/app/wirecheck.ts';
import { benchI2cWire, wiresOf } from '../src/app/wiring.ts';
import { evaluate, bootOptions, type Level } from '../src/checks.ts';
import { action } from '../src/inputlog.ts';

test('I2C rise time: same numbers as the i2cbus.rs unit test', () => {
  assert.ok(Math.abs(riseNs(20, 2) - 211.825) < 0.01);
  assert.equal(verdict(riseNs(20, 2), limitNs(400_000)), 'ok');
  assert.equal(verdict(riseNs(60, 2), limitNs(400_000)), 'marginal');
  assert.equal(verdict(riseNs(150, 2), limitNs(400_000)), 'fail');
  assert.equal(verdict(riseNs(150, 2), limitNs(100_000)), 'ok');
  assert.ok(Math.abs(maxWireCm(2) - 40.81) < 0.01);
  // Deterministic: same input, same result
  assert.deepEqual(i2cLoad(60, 2), i2cLoad(60, 2));
});

test('antenna blockage: metal touching 45 dB -> -87 dBm cannot connect; 10 mm away 23 dB connects; 20 mm away no effect', () => {
  assert.equal(antennaLossDb('metal', 0), 45);
  assert.equal(antennaLossDb('battery', 0), 30);
  assert.equal(antennaLossDb('metal', 10), 23);
  assert.equal(antennaLossDb('metal', 20), 0);
  assert.equal(antennaLossDb('none', 0), 0);
  assert.equal(rssiAfter(45), -87);
  assert.equal(wifiText(45).level, 'fail');
  assert.equal(wifiText(23).level, 'marginal');
  assert.equal(wifiText(0).level, 'ok');
  // Core --antenna-loss 30: TryBoard-WiFi -72 (accept.json wifi-scan-antenna)
  assert.equal(rssiAfter(30), -72);
});

const weather = [
  { type: 'oled' as const, addr: 0x3c, sda: 8, scl: 9 },
  { type: 'bme280' as const, addr: 0x76, sda: 8, scl: 9 },
];

test('wiring check W6: longer BME280 wires warn at 60 cm, block at 150 cm; default 10 cm is fine', () => {
  assert.equal(checkWiring(weather, wiresOf(weather)).filter((f) => f.rule === 'W6').length, 0);
  const mid = checkWiring(weather, wiresOf(weather, false, { lenCm: { bme280: 50 } })).find((f) => f.rule === 'W6');
  assert.ok(mid && mid.level === 'warn' && mid.confidence === '必须上真机', JSON.stringify(mid)); // lint: allow-cjk (conf id)
  assert.match(mid.detail, /totals 60 cm/);
  assert.equal(mid.wires.length, 4);
  const bad = checkWiring(weather, wiresOf(weather, false, { lenCm: { bme280: 140 } })).find((f) => f.rule === 'W6');
  assert.ok(bad && bad.level === 'block');
  // Bus length handed to the simulator: unchanged = ideal (-1), changed = total SDA length
  assert.equal(benchI2cWire(weather, {}), -1);
  assert.equal(benchI2cWire(weather, { lenCm: { bme280: 50 } }), 60);
});

test('harness goes into the input log: i2cwire=cm / antenna=dB; checkpoint args --i2c-wire / --antenna-loss / --usb-log', () => {
  assert.equal(action({ tMs: 0, kind: 'i2cwire', cm: 60 }), 'i2cwire=60');
  assert.equal(action({ tMs: 0, kind: 'antenna', db: 30 }), 'antenna=30');
  const o = bootOptions({ args: ['--usb-log', '--i2c-wire', '60', '--antenna-loss', '30'] } as Level);
  assert.equal(o.usb, true);
  assert.equal(o.i2cWire, 60);
  assert.equal(o.antenna, 30);
});

test('USB level check: state + typed text (same wording as tools/check.py)', () => {
  const l = { id: 'usbkey-3', usb: { state: 'configured', typed: 'aHello TryBoard\n' } } as Level;
  const ok = evaluate(l, 'TRYBOARD_OK', '[tryboard] USB host: configured\n[tryboard] USB keyboard typed: "aHello TryBoard\\n"\n');
  assert.deepEqual(ok.map((r) => r.ok), [true, true]);
  assert.equal(ok[1].text, 'typed on the PC "aHello TryBoard↵" (need "aHello TryBoard↵")');
  const en = evaluate({ ...l, usb: { state: 'configured', typed: 'aHello TryBoard\n' } }, 'TRYBOARD_OK', '[tryboard] USB host: configured\n[tryboard] USB keyboard typed: "aHello TryBoard\\n"\n');
  assert.deepEqual(en.map((r) => r.text), ok.map((r) => r.text));
  const none = evaluate(l, '', '');
  assert.deepEqual(none.map((r) => r.text), ['USB device seen by the PC: no USB device (need configured)', 'typed on the PC "" (need "aHello TryBoard↵")']);
});
