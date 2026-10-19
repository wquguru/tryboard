// Minimal subscribable store: one object, shallow-merge updates, synchronous notify. No diffing; subscribers pick their fields.

export interface Store<T extends object> {
  get(): T;
  /** Shallow merge; a function receives the current state and returns the patch. */
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  /** Returns an unsubscribe function. With keys, notifies only when one of them changes (!==). */
  subscribe(fn: (s: T, prev: T) => void, keys?: (keyof T)[]): () => void;
}

export function createStore<T extends object>(init: T): Store<T> {
  let state = init;
  const subs = new Set<{ fn: (s: T, prev: T) => void; keys?: (keyof T)[] }>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      const prev = state;
      state = { ...state, ...p };
      // Copy first: a subscriber may unsubscribe or call set again.
      for (const s of [...subs]) {
        if (!subs.has(s)) continue;
        if (s.keys && !s.keys.some((k) => prev[k] !== state[k])) continue;
        s.fn(state, prev);
      }
    },
    subscribe(fn, keys) {
      const s = { fn, keys };
      subs.add(s);
      return () => subs.delete(s);
    },
  };
}
