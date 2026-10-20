// .tryboard work files on the lab page (F-01b): export the bench + actions + own bin, open one by picking or dropping it.
// Opening stores state + bin in IndexedDB and reloads with a short ?f=<key>; main.tsx feeds the state to the link path.
import { t } from '../i18n';
import { captureBench } from './shareopen';
import { builtinFw, encodeState, packTryfile, shareKey, unpackTryfile, ShareDecodeError } from './sharestate';
import type { StepCtx } from './types';

const DB = 'tryboard-files';
const STORE = 'files';
/** Opened files kept for reloads; older ones are pruned */
const KEEP = 3;

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const done = (tx: IDBTransaction) =>
  new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(tx.error);
  });
const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

interface Stored {
  /** encodeState() of the file's state: the same string a ?s= link carries */
  s: string;
  own: { buf: ArrayBuffer; name: string } | null;
  at: number;
}

async function putFile(key: string, v: Stored) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const st = tx.objectStore(STORE);
  st.put(v, key);
  const keys = (await req(st.getAllKeys())) as string[];
  const rows = (await req(st.getAll())) as Stored[];
  keys
    .map((k, i) => ({ k, at: rows[i].at }))
    .sort((a, b) => b.at - a.at)
    .slice(KEEP)
    .forEach((r) => st.delete(r.k));
  await done(tx);
  db.close();
}

/** An opened .tryboard file by its ?f= key: the state string and the own bin, or null when this browser no longer has it */
export async function takeFile(key: string): Promise<Pick<Stored, 's' | 'own'> | null> {
  try {
    const db = await openDb();
    const v = (await req(db.transaction(STORE).objectStore(STORE).get(key))) as Stored | undefined;
    db.close();
    return v ? { s: v.s, own: v.own } : null;
  } catch {
    return null;
  }
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/** Bytes and file name of the current bench (also behind window.__tbShareFile for tests) */
export async function makeFile(ctx: StepCtx): Promise<{ bytes: Uint8Array; name: string; own: boolean; run: boolean }> {
  const { session, work } = ctx;
  const { state, ownFw } = await captureBench(ctx, true);
  const bin = ownFw ? session.fwBuf : null;
  const bytes = await packTryfile(state, bin, session.fwName);
  const base = (builtinFw(session.fwName) ?? session.fwName.replace(/\.bin$/i, '')) || work.id;
  return { bytes, name: `${base.replace(/[^\w.-]+/g, '-')}-${stamp()}.tryboard`, own: !!bin, run: !!state.run };
}

/** Top bar ⋯ "Download .tryboard file" */
export async function exportFile(ctx: StepCtx) {
  try {
    const f = await makeFile(ctx);
    const { download } = await import('./capture');
    download(new Blob([f.bytes as BlobPart], { type: 'application/octet-stream' }), f.name);
    const what = f.own ? (f.run ? t('bench, your firmware and your actions') : t('bench and your firmware')) : f.run ? t('bench and your actions') : t('only the bench');
    ctx.shell.toast(t('Saved {name} ({what}): drop it on a TryBoard page to open it', { name: f.name, what }));
  } catch (e) {
    ctx.shell.toast(t('Could not save the .tryboard file: {err}', { err: String(e) }));
  }
}

/** Open a .tryboard file: check it, keep its bin, reload into the shared bench. A bad file changes nothing */
export async function openFile(f: File, toast: (msg: string) => void) {
  let opened;
  try {
    opened = await unpackTryfile(new Uint8Array(await f.arrayBuffer()));
  } catch (e) {
    const newer = e instanceof ShareDecodeError && e.reason === 'newer';
    toast(newer ? t('This .tryboard file was made by a newer TryBoard; reload the page to get the latest version') : t('This .tryboard file is damaged (failed its check), so nothing on the bench was changed'));
    return;
  }
  const { state, bin } = opened;
  // Long runs make a state far past what a URL can hold (servers cap request lines), so only the key travels
  const s = await encodeState(state);
  const key = shareKey(s).slice(6);
  try {
    await putFile(key, { s, own: bin && state.bin ? { buf: bin, name: state.bin.name } : null, at: Date.now() });
  } catch (e) {
    toast(t('The browser blocked local storage, so this file cannot be opened: {err}', { err: String(e) }));
    return;
  }
  const url = `${location.pathname}?f=${key}#bench`;
  if (url === location.pathname + location.search + location.hash) location.reload();
  else location.assign(url);
}

/** Dropping a .tryboard anywhere on the page opens it; other drops (parts, .bin on drop zones) are left alone */
export function installDrop(toast: (msg: string) => void) {
  const file = (e: DragEvent) => (e.dataTransfer?.types.includes('Files') ? e.dataTransfer : null);
  window.addEventListener('dragover', (e) => {
    if (file(e) && !e.defaultPrevented) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    const f = file(e)?.files?.[0];
    if (e.defaultPrevented || !f || !/\.tryboard$/i.test(f.name)) return;
    e.preventDefault();
    void openFile(f, toast);
  });
}
