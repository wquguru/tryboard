// Embed storage shield (F-03): the page must not write the host's partitioned storage, and Safari may block it outright.
// localStorage is swapped for an in-memory copy (seeded from the real one, read-only), so session code can save without effect.

let real: Storage | null = null;

export function shieldStorage() {
  if (real) return;
  const mem = new Map<string, string>();
  try {
    real = window.localStorage;
    for (let i = 0; i < real.length; i++) {
      const k = real.key(i);
      if (k !== null) mem.set(k, real.getItem(k) ?? '');
    }
  } catch {
    /* Blocked storage (Safari third-party iframe): start empty */
  }
  const shim: Storage = {
    get length() {
      return mem.size;
    },
    key: (i: number) => [...mem.keys()][i] ?? null,
    getItem: (k: string) => mem.get(String(k)) ?? null,
    setItem: (k: string, v: string) => void mem.set(String(k), String(v)),
    removeItem: (k: string) => void mem.delete(String(k)),
    clear: () => mem.clear(),
  };
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => shim });
  } catch {
    /* Not redefinable: session code already guards its writes with try / catch */
  }
  // For tools/webtest/embed.mjs: keys in the real storage (must stay unchanged)
  (globalThis as { __tbEmbedRealKeys?: () => string[] }).__tbEmbedRealKeys = () => {
    try {
      return real ? Object.keys(real) : [];
    } catch {
      return [];
    }
  };
}
