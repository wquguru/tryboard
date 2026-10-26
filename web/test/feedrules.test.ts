// H-16 feed rules: servo angle from the PWM pulse, lit-LED count, ADC row throttle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adcMoved, litCount, servoPulse } from '../src/app/feedrules.ts';

test('servo angle comes from the pulse width at 50 Hz', () => {
  const at = (us: number) => servoPulse(Math.round((us / 20000) * 65535), 50000)!;
  assert.equal(at(500).deg, 0);
  assert.equal(at(1500).deg, 90);
  assert.equal(at(2500).deg, 180);
  assert.equal(at(1500).us, 1500);
  assert.equal(servoPulse(0, 50000), null);
  assert.equal(servoPulse(65535, 50000), null);
  assert.equal(servoPulse(4000, 0), null);
});

test('lit LEDs and ADC throttle', () => {
  assert.equal(litCount([[0, 0, 0], [1, 0, 0], [0, 0, 9]]), 2);
  assert.equal(litCount([]), 0);
  assert.ok(adcMoved(undefined, 100, 200));
  assert.ok(!adcMoved(1000, 1150, 200));
  assert.ok(adcMoved(1000, 1200, 200));
});
