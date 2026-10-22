// F-07d: the firmware menu's "Recent" list drops forgotten / evicted own bins and shows file entries under their chip only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveRecent, pruneRecent, pushRecent, recentFor, recentFw, type Recent } from '../src/app/recentfw.ts';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as Storage;
};
const ex: Recent = { kind: 'example', id: 'blink', title: 'Blink', at: 1 };
const c3: Recent = { kind: 'file', name: 'mpy-c3.bin', h: 'aa', chip: 'esp32c3', at: 2 };
const s3: Recent = { kind: 'file', name: 'mpy-s3.bin', h: 'bb', chip: 'esp32s3', at: 3 };
const old: Recent = { kind: 'file', name: 'old.bin', h: 'cc', at: 4 };
const loose: Recent = { kind: 'file', name: 'loose.bin', chip: 'esp32c3', at: 5 };

test('filter by chip: other-chip bins hidden, examples and pre-F-07d entries kept', () => {
  assert.deepEqual(recentFor([ex, c3, s3, old], 'esp32s3'), [ex, s3, old]);
  assert.deepEqual(recentFor([ex, c3, s3, old], 'esp32c3'), [ex, c3, old]);
  assert.deepEqual(recentFor([ex, c3, s3, old], 'esp32'), [ex, old]);
});

test('bins no longer kept leave the list; never-kept files stay; unreadable storage keeps all', () => {
  assert.deepEqual(liveRecent([ex, c3, s3, loose], new Set(['bb'])), [ex, s3, loose]);
  assert.deepEqual(liveRecent([ex, c3, s3, loose], new Set()), [ex, loose]);
  assert.deepEqual(liveRecent([ex, c3, s3, loose], null), [ex, c3, s3, loose]);
});

test('pushRecent dedups by name, keeps three; forget then prune removes the entry from storage', () => {
  const s = mem();
  pushRecent(ex, s);
  pushRecent({ kind: 'file', name: c3.name, chip: 'esp32c3', at: 2 }, s);
  pushRecent(c3, s);
  assert.deepEqual(recentFw(s), [c3, ex]);
  pushRecent(s3, s);
  pushRecent(old, s);
  assert.deepEqual(recentFw(s), [old, s3, c3]);
  assert.deepEqual(pruneRecent(new Set(['bb', 'cc']), s), [old, s3]);
  assert.deepEqual(recentFw(s), [old, s3]);
  assert.deepEqual(pruneRecent(null, s), [old, s3]);
  const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
  pushRecent(ex, bad);
  assert.deepEqual(pruneRecent(new Set(), bad), []);
});
