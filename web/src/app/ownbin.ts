// Own firmware kept across reloads (F-07c): uploaded .bin files go into this browser's IndexedDB, keyed by sha256.
// A per-work pointer in localStorage names the bin to bring back on the next load; nothing leaves the browser.
import { openDb, done, req } from './idb.ts';
import { sha256Hex } from './sharestate.ts';
import { createStore } from './store.ts';

const DB = 'tryboard-bins';
const STORE = 'bins';
const PTR = 'tryboard-ownbin:';
/** Bins kept at most; the oldest go first */
export const KEEP_BINS = 3;
/** Total bytes kept (three 8 MB flash images); a single bin over this is not kept at all */
export const MAX_BYTES = 24 << 20;

export interface KeptBin {
  h: string;
  name: string;
  buf: ArrayBuffer;
  size: number;
  at: number;
}
type Meta = Pick<KeptBin, 'h' | 'size' | 'at'>;

/** Keys to delete so at most `keep` rows and `max` bytes remain, newest first; `fresh` is never evicted */
export function evictPlan(rows: Meta[], fresh: string, keep = KEEP_BINS, max = MAX_BYTES): string[] {
  const sorted = [...rows].sort((a, b) => +(b.h === fresh) - +(a.h === fresh) || b.at - a.at);
  const out: string[] = [];
  let bytes = 0;
  sorted.forEach((r, i) => {
    if (r.h !== fresh && (i >= keep || bytes + r.size > max)) out.push(r.h);
    else bytes += r.size;
  });
  return out;
}

/** Store a bin (or refresh its time) and prune; returns its sha256. Throws when the browser refuses (private mode, quota) */
export async function keepBin(buf: ArrayBuffer, name: string, idb?: IDBFactory, now = Date.now()): Promise<string> {
  if (buf.byteLength > MAX_BYTES) throw new Error('too large');
  const h = await sha256Hex(buf);
  const db = await openDb(DB, STORE, idb);
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    st.put({ h, name, buf, size: buf.byteLength, at: now } satisfies KeptBin, h);
    const rows = (await req(st.getAll())) as KeptBin[];
    for (const k of evictPlan(rows, h)) st.delete(k);
    await done(tx);
  } finally {
    db.close();
  }
  return h;
}

/** A kept bin by sha256, or null when it is gone or storage is unavailable */
export async function takeBin(h: string, idb?: IDBFactory): Promise<KeptBin | null> {
  try {
    const db = await openDb(DB, STORE, idb);
    const v = (await req(db.transaction(STORE).objectStore(STORE).get(h))) as KeptBin | undefined;
    db.close();
    return v ?? null;
  } catch {
    return null;
  }
}

/** Delete this browser's copy; false when storage refused */
export async function dropBin(h: string, idb?: IDBFactory): Promise<boolean> {
  try {
    const db = await openDb(DB, STORE, idb);
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(h);
    await done(tx);
    db.close();
    return true;
  } catch {
    return false;
  }
}

const ls = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
/** sha256 of the bin a work's bench ran last, if it was the user's own */
export function lastBin(work: string, s = ls()): string | null {
  try {
    return s?.getItem(PTR + work) ?? null;
  } catch {
    return null;
  }
}
export function setLastBin(work: string, h: string | null, s = ls()) {
  try {
    if (h) s?.setItem(PTR + work, h);
    else s?.removeItem(PTR + work);
  } catch {
    /* private mode: the bin just isn't restored */
  }
}

/** The running firmware when it is a kept bin (drives "Forget" in the firmware menu) */
export const keptNow = createStore<{ cur: { h: string; name: string } | null }>({ cur: null });
