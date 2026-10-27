// H-16 feed rules: servo angle from the PWM pulse, lit-LED count, ADC row throttle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adcMoved, litCount, servoPulse, TickLast } from '../src/app/feedrules.ts';

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

test('H-23: a restart narrates the first strip frame even when its lit count matches the last run', () => {
  const last = new TickLast();
  // Run 1 ends with all 8 lit
  assert.equal(last.get(1, 5), undefined);
  last.set(1, 5, 8);
  assert.equal(last.get(1, 5), 8);
  // Run 2's first tick may land before the io reset clears anything: still a first row
  assert.equal(last.get(2, 5), undefined);
  last.set(2, 5, 8);
  assert.equal(last.get(2, 5), 8);
  // A seek keeps the run number but starts the trace over
  last.clear();
  assert.equal(last.get(2, 5), undefined);
  // ADC readings share the store: a new run's first reading always makes a row
  last.set(2, 4, 2048);
  assert.equal(adcMoved(last.get(2, 4), 2048, 200), false);
  assert.equal(adcMoved(last.get(3, 4), 2048, 200), true);
});
