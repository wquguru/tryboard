// F-02 QR encoder: spec vectors, qrencode 4.1.1 fixtures (qr-qrencode.json, -8 -l M -m 0 -v N) and round trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { alignmentPositions, encodeQr, formatBits, qrCapacity, QR_MAX_BYTES, rsRemainder, versionBits } from '../src/app/qr.ts';
import { decodeQr, fromHexRows } from './qrdecode.ts';

const fixtures: { text: string; version: number; rows: string[] }[] = JSON.parse(readFileSync(new URL('./qr-qrencode.json', import.meta.url), 'utf8'));

test('Reed–Solomon: HELLO WORLD 1-M codewords', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual([...rsRemainder(data, 10)], [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('format and version info match the spec tables', () => {
  const m = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
  m.forEach((s, mask) => assert.equal(formatBits(mask), parseInt(s, 2), `mask ${mask}`));
  assert.equal(versionBits(7), 0b000111110010010100);
  assert.equal(versionBits(40), 0b101000110001101001);
});

test('capacity and alignment positions', () => {
  assert.deepEqual([1, 9, 10, 25, 40].map(qrCapacity), [14, 180, 213, 997, 2331]);
  assert.equal(QR_MAX_BYTES, 2331);
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

for (const f of fixtures) {
  test(`qrencode fixture v${f.version}: decodes, and the encoder matches it module for module`, () => {
    const q = fromHexRows(f.rows);
    const d = decodeQr(q.modules, q.size);
    assert.equal(d.text, f.text);
    assert.equal(d.level, 0);
    // Same version and mask as qrencode picked, so the matrices must be identical.
    const mine = encodeQr(f.text, { version: f.version, mask: d.mask });
    assert.equal(mine.size, q.size);
    assert.deepEqual([...mine.modules], [...q.modules]);
    // Free choice: smallest version that fits; any mask still decodes.
    const auto = encodeQr(f.text);
    assert.ok(auto.version <= f.version);
    assert.equal(decodeQr(auto.modules, auto.size).text, f.text);
  });
}

test('round trip across every version boundary', () => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let v = 1; v <= 40; v++) {
    for (const n of [qrCapacity(v), qrCapacity(v - 1 || 1) + 1]) {
      const s = Array.from({ length: n }, (_, i) => abc[(i * 31 + v) % 64]).join('');
      const q = encodeQr(s);
      let want = 1;
      while (qrCapacity(want) < n) want++;
      assert.equal(q.version, want, `n=${n}`);
      const d = decodeQr(q.modules, q.size);
      assert.equal(d.text, s, `v${v} n=${n}`);
      assert.equal(d.mask, q.mask);
    }
  }
});

test('too long throws', () => {
  assert.throws(() => encodeQr('x'.repeat(QR_MAX_BYTES + 1)));
  assert.throws(() => encodeQr('x'.repeat(20), { version: 1 }));
});
