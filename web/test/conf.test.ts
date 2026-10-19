// Per-row trust levels on result cards (D-05): derived from the check kind, timing-sensitive pins override to real hardware
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, fingerprint, timingPins, type Level } from '../src/checks.ts';

const base: Level = { id: 't', title: '', goal: '', pass: '', buy: '', learn: '', brief: '', ref: null };

test('serial and GPIO rows are simulated, readings are behaviour models', () => {
  const l: Level = { ...base, expect: ['OK'], gpio_toggles: { pin: 5, min: 2 }, numeric: [{ name: 'T', regex: 'T=([\\d.]+)', value: 23, tol: 1 }] };
  const r = evaluate(l, 'OK\nT=23.0\n', '[tryboard] GPIO5 toggled 4 times\n');
  assert.deepEqual(r.map((x) => x.conf), ['仿真验证', '仿真验证', '行为模拟']);
});

test('Wi-Fi firmware makes serial rows behaviour models', () => {
  const r = evaluate({ ...base, expect: ['GET 200'] }, 'I (300) wifi:connected\nGET 200\n', '');
  assert.equal(r[0].conf, '行为模拟');
});

test('timing-sensitive line flags the pin row, else the readings', () => {
  const rep = '[tryboard] timing-sensitive: GPIO5 busy-wait esp_rom_delay_us ×4000\n';
  assert.deepEqual(timingPins(rep)?.pins, [5]);
  const pin = evaluate({ ...base, gpio_toggles: { pin: 5, min: 1 } }, '', rep + '[tryboard] GPIO5 toggled 3 times\n');
  assert.equal(pin[0].conf, '必须上真机');
  assert.ok(pin[0].note);
  const rd = evaluate({ ...base, expect: ['x'], numeric: [{ name: 'H', regex: 'H=(\\d+)', value: 45, tol: 1 }] }, 'x\nH=45\n', rep);
  assert.deepEqual(rd.map((x) => x.conf), ['仿真验证', '必须上真机']);
});

test('trust levels never touch the raw lines or the run ID', () => {
  const l: Level = { ...base, expect: ['OK'] };
  const a = evaluate(l, 'OK\n', '');
  assert.equal(a[0].text, 'serial shows "OK"');
  assert.equal(fingerprint('OK\n', a.map((x) => x.text).join('\n')), fingerprint('OK\n', 'serial shows "OK"'));
});
