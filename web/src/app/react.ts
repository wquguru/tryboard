// Imperative code (steps, session, benchhist) sets state and React renders it. Setters commit synchronously (flushSync)
// because callers measure or query the DOM right after (card placement, test scripts); never call them in render/effects.
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { createStore, type Store } from './store';

export function useStore<T extends object>(s: Store<T>): T {
  return useSyncExternalStore(
    (cb) => s.subscribe(cb),
    s.get,
    s.get,
  );
}

/** Synchronous commit: the DOM is updated when this returns. */
export const commit = (fn: () => void) => flushSync(fn);

/** A replaceable region of the shell (build tree, inspector, step layer, quick card); steps render JSX into it. */
export interface Slot<T> {
  render(v: T): void;
  get(): T;
  store: Store<{ v: T }>;
}
export function createSlot<T>(init: T): Slot<T> {
  const store = createStore<{ v: T }>({ v: init });
  return {
    store,
    get: () => store.get().v,
    render(v) {
      commit(() => store.set({ v }));
    },
  };
}
export const useSlot = <T>(s: Slot<T>) => useStore(s.store).v;
