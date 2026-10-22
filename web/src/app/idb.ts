// Tiny IndexedDB helpers shared by .tryboard files (tryfile.ts) and kept own bins (ownbin.ts).
// The factory is a parameter so Node tests can pass an in-memory fake (Node has no indexedDB).

/** Open (creating on first use) a database with one object store */
export function openDb(name: string, store: string, idb: IDBFactory | undefined = globalThis.indexedDB): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    if (!idb) return rej(new Error('IndexedDB unavailable'));
    const r = idb.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export const done = (tx: IDBTransaction) =>
  new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(tx.error);
  });
export const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
