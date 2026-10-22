import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIC_REC_MAX_S, MicRecord, quantize } from '../src/micrec.ts';

test('quantize rounds and clamps to 16 bit, floats are exactly q / 32768', () => {
  const { q, f } = quantize(new Float32Array([0, 0.5, -1, 1.5, -2, 1 / 65536 + 1e-9]));
  assert.deepEqual([...q], [0, 16384, -32768, 32767, -32768, 1]);
  for (let i = 0; i < q.length; i++) assert.equal(f[i], Math.fround(q[i] / 32768));
});

test('later chunks truncate what the core never heard; the WAV places samples at their grid index', () => {
  const r = new MicRecord();
  r.add(10, 16000, new Int16Array([1, 2, 3, 4]));
  r.add(14, 16000, new Int16Array([5, 6]));
  // Core restarted placement at 12 (e.g. after a drop): samples 12.. from earlier chunks are gone
  r.add(12, 16000, new Int16Array([7, 8, 9]));
  assert.equal(r.length, 5);
  const buf = r.wav(20);
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(36), 'data');
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(34, true), 16);
  const n = v.getUint32(40, true) / 2;
  assert.equal(n, 21);
  const pcm = new Int16Array(buf, 44, n);
  assert.deepEqual([...pcm.subarray(8, 17)], [0, 0, 1, 2, 7, 8, 9, 0, 0]);
});

test('rate change restarts the recording; the cap marks it full', () => {
  const r = new MicRecord();
  r.add(0, 8000, new Int16Array(10));
  r.add(0, 100, new Int16Array(5));
  assert.equal(r.rate, 100);
  assert.equal(r.length, 5);
  r.add(5, 100, new Int16Array(MIC_REC_MAX_S * 100));
  assert.equal(r.full, true);
  assert.equal(r.length, 5);
});
