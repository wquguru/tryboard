import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRows, headline } from '../src/ui/say.ts';

// Real rows from rechecking the ruler after casing (say / tag / dev as checks.ts produces them in Node, i.e. English)
const ruler = [
  { ok: false, text: 'serial shows "DIST 15.0 cm"', say: 'Serial did not print "DIST 15.0 cm"', tag: 'Serial', dev: 'Serial' },
  { ok: true, text: 'GPIO5 PWM ...', say: 'Buzzer pitch is right', tag: 'GPIO5', dev: 'Buzzer' },
  { ok: false, text: 'GPIO5 0.3–1.5 s beeped 0 times (need 2–5)', say: '0.3–1.5 s: buzzer silent, should beep 2–5 times', tag: 'GPIO5', dev: 'Buzzer' },
  { ok: false, text: 'GPIO5 1.8–2.5 s beeped 0 times (need 4–9)', say: '1.8–2.5 s: buzzer silent, should beep 4–9 times', tag: 'GPIO5', dev: 'Buzzer' },
  { ok: true, text: 'GPIO5 2.8–3.2 s beeped 0 times (need 0)', say: '2.8–3.2 s: buzzer quiet', tag: 'GPIO5', dev: 'Buzzer' },
  { ok: true, text: 'OLED lit 300 pixels', say: 'Screen is on', tag: 'OLED', dev: 'Screen' },
];

test('groups by device: pin written once, failed groups first', () => {
  const g = groupRows(ruler);
  assert.deepEqual(g.map((x) => x.dev), ['Serial', 'Buzzer', 'Screen']);
  assert.equal(g[0].pin, undefined);
  assert.equal(g[1].pin, 'GPIO5');
  assert.equal(g[1].rows.length, 4);
  assert.equal(g[1].sum, 'Buzzer never beeped');
});

test('headline counts devices, not time windows', () => {
  assert.equal(headline(ruler), '2 devices have problems');
  assert.equal(headline(ruler.slice(1)), 'Buzzer never beeped');
  assert.equal(headline(ruler.slice(0, 2)), 'Serial did not print "DIST 15.0 cm"');
  assert.equal(headline(ruler.filter((r) => r.ok)), 'All 3 checks passed');
});

test('old results without dev group by tag', () => {
  const g = groupRows([{ ok: false, text: 'a', tag: 'GPIO2' }, { ok: false, text: 'b', tag: 'GPIO2' }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].sum, 'GPIO2: 2 problems');
});
