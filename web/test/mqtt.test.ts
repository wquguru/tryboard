// F-08b: virtual MQTT cloud publishes round-trip through the input log (same text as CLI mqtt=)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { action, fromAction } from '../src/inputlog.ts';

test('mqtt= actions round-trip', () => {
  for (const cmd of ['pub,tryboard/in,from cloud', 'pub1,a/b,x,y', 'retain,home/temp,21.5']) {
    const a = action({ tMs: 0, kind: 'mqtt', cmd });
    assert.equal(a, `mqtt=${cmd}`);
    assert.deepEqual(fromAction(a!), { kind: 'mqtt', cmd });
  }
});
