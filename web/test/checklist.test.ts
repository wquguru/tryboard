// Real-hardware checklist (D-06): items follow the project's parts, serial and "needs real hardware" result rows
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChecklist, checklistText } from '../src/app/checklist.ts';

const none = { first: [] as [string, string][], parts: [] as string[], serial: '', mustReal: [] as { text: string; note?: string }[] };

test('capabilities pick the rules', () => {
  assert.deepEqual(buildChecklist(none), []);
  const keys = buildChecklist({ ...none, parts: ['pot', 'servo', 'dht11'], serial: 'I (300) wifi:connected\n' }).map((x) => x.key);
  assert.deepEqual(keys, ['wifi-rssi', 'timing', 'adc-cal', 'peak-current']);
});

test('project steps come first, flagged rows last and deduplicated', () => {
  const rows = [{ text: 'GPIO5 toggled 3 times', note: 'busy-wait' }, { text: 'GPIO5 toggled 3 times' }];
  const it = buildChecklist({ ...none, first: [['Identify the board', 'Flash blink']], mustReal: rows });
  assert.deepEqual(it.map((x) => x.key), ['first:0', 'timing', 'row:GPIO5 toggled 3 times']);
  assert.equal(it[2].how, 'busy-wait');
});

test('copied text marks ticked items', () => {
  const it = buildChecklist({ ...none, parts: ['mpu6050'] });
  const s = checklistText('T', it, ['imu-bias']);
  assert.match(s, /^\[x\] 1\. /m);
  assert.ok(s.includes(it[0].why));
});
