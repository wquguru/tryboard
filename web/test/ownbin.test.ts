// F-07c: own bins kept in IndexedDB (store / fetch, eviction by count and bytes, quiet fallback when storage refuses).
// Node has no indexedDB, so a small in-memory fake stands in; requests settle in microtasks, the transaction after them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropBin, evictPlan, keepBin, keptKeys, lastBin, MAX_BYTES, setLastBin, takeBin } from '../src/app/ownbin.ts';

type Rec = Record<string, unknown>;
function fakeIdb(opt: { failOpen?: boolean; failPut?: boolean } = {}): IDBFactory & { data: Map<string, Rec> } {
  const data = new Map<string, Rec>();
  const request = (tx: { pending: number; settle: () => void } | null, run: () => unknown, fail = false) => {
    const r: Rec = { result: undefined, error: null, onsuccess: null, onerror: null };
    if (tx) tx.pending++;
    queueMicrotask(() => {
      try {
        if (fail) throw new DOMException('quota', 'QuotaExceededError');
        r.result = run();
        (r.onsuccess as (() => void) | null)?.();
      } catch (e) {
        r.error = e;
        (r.onerror as (() => void) | null)?.();
        if (tx) (tx as unknown as { failed: unknown }).failed = e;
      }
      if (tx) (tx.pending--, tx.settle());
    });
    return r;
  };
  const db = {
    createObjectStore: () => ({}),
    close: () => {},
    transaction: () => {
      const tx: Rec & { pending: number; settle: () => void } = {
        pending: 0,
        failed: null,
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        settle: () =>
          setTimeout(() => {
            if (tx.pending || tx.done) return;
            tx.done = true;
            if (tx.failed) ((tx.error = tx.failed), (tx.onabort as () => void)?.());
            else (tx.oncomplete as () => void)?.();
          }),
        objectStore: () => ({
          put: (v: Rec, k: string) => request(tx, () => data.set(k, structuredClone(v)), opt.failPut),
          get: (k: string) => request(tx, () => data.get(k)),
          getAll: () => request(tx, () => [...data.values()]),
          getAllKeys: () => request(tx, () => [...data.keys()]),
          delete: (k: string) => request(tx, () => data.delete(k)),
        }),
      };
      tx.settle();
      return tx;
    },
  };
  return {
    data,
    open: () => {
      const r: Rec = { result: db, error: null };
      queueMicrotask(() => {
        if (opt.failOpen) return ((r.error = new DOMException('blocked', 'SecurityError')), (r.onerror as () => void)?.());
        if (!data.size) (r.onupgradeneeded as () => void)?.();
        (r.onsuccess as () => void)?.();
      });
      return r;
    },
  } as unknown as IDBFactory & { data: Map<string, Rec> };
}
const bin = (n: number, fill: number) => new Uint8Array(n).fill(fill).buffer;

test('keep then take by sha256; same bytes are one entry', async () => {
  const idb = fakeIdb();
  const h = await keepBin(bin(1000, 1), 'mpy.bin', idb, 1);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(await keepBin(bin(1000, 1), 'renamed.bin', idb, 2), h);
  assert.equal(idb.data.size, 1);
  const got = await takeBin(h, idb);
  assert.equal(got?.name, 'renamed.bin');
  assert.deepEqual(new Uint8Array(got!.buf), new Uint8Array(bin(1000, 1)));
  assert.equal(await takeBin('0'.repeat(64), idb), null);
  assert.ok(await dropBin(h, idb));
  assert.equal(await takeBin(h, idb), null);
});

test('only the newest three are kept, oldest evicted first', async () => {
  const idb = fakeIdb();
  const hs: string[] = [];
  for (let i = 0; i < 5; i++) hs.push(await keepBin(bin(100, i), `b${i}.bin`, idb, 10 + i));
  assert.equal(idb.data.size, 3);
  for (const h of hs.slice(0, 2)) assert.equal(await takeBin(h, idb), null);
  for (const h of hs.slice(2)) assert.ok(await takeBin(h, idb));
  // Re-keeping an old one refreshes its time, so the next eviction skips it
  await keepBin(bin(100, 2), 'b2.bin', idb, 100);
  await keepBin(bin(100, 9), 'b9.bin', idb, 101);
  assert.ok(await takeBin(hs[2], idb));
  assert.equal(await takeBin(hs[3], idb), null);
});

test('byte cap: older bins go until the total fits; the fresh one always stays', () => {
  const big = MAX_BYTES / 2 + 1;
  const rows = [
    { h: 'a', size: big, at: 1 },
    { h: 'b', size: 10, at: 2 },
    { h: 'c', size: big, at: 3 },
  ];
  assert.deepEqual(evictPlan(rows, 'c'), ['a']);
  assert.deepEqual(evictPlan(rows, 'a'), ['c']);
  assert.deepEqual(evictPlan([{ h: 'x', size: 1, at: 0 }], 'x'), []);
});

test('a bin over the byte cap is refused before touching storage', async () => {
  const idb = fakeIdb();
  await assert.rejects(keepBin(new ArrayBuffer(MAX_BYTES + 1), 'huge.bin', idb));
  assert.equal(idb.data.size, 0);
});

test('storage refused (private mode, quota): keep throws, take / drop fall back quietly', async () => {
  await assert.rejects(keepBin(bin(10, 1), 'a.bin', fakeIdb({ failOpen: true })));
  await assert.rejects(keepBin(bin(10, 1), 'a.bin', fakeIdb({ failPut: true })));
  assert.equal(await takeBin('a'.repeat(64), fakeIdb({ failOpen: true })), null);
  assert.equal(await dropBin('a'.repeat(64), fakeIdb({ failOpen: true })), false);
  // No indexedDB at all (this Node process)
  await assert.rejects(keepBin(bin(10, 1), 'a.bin'));
  assert.equal(await takeBin('a'.repeat(64)), null);
});

test('per-work pointer: set, clear, and a throwing localStorage', () => {
  const m = new Map<string, string>();
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as Storage;
  setLastBin('blank:hello', 'ab', s);
  assert.equal(lastBin('blank:hello', s), 'ab');
  assert.equal(lastBin('blank:other', s), null);
  setLastBin('blank:hello', null, s);
  assert.equal(lastBin('blank:hello', s), null);
  const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} } as unknown as Storage;
  assert.equal(lastBin('w', bad), null);
  setLastBin('w', 'ab', bad);
});

test('keptKeys lists kept sha256s (F-07d); null when storage is unavailable', async () => {
  const idb = fakeIdb();
  const hs: string[] = [];
  for (let i = 0; i < 4; i++) hs.push(await keepBin(bin(100, i), `b${i}.bin`, idb, 10 + i));
  assert.deepEqual([...(await keptKeys(idb))!].sort(), hs.slice(1).sort());
  await dropBin(hs[3], idb);
  assert.deepEqual([...(await keptKeys(idb))!].sort(), hs.slice(1, 3).sort());
  assert.equal(await keptKeys(fakeIdb({ failOpen: true })), null);
  assert.equal(await keptKeys(), null);
});
