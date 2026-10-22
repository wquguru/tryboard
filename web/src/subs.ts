/** Minimal listener set: `on` returns its unsubscribe, `emit` copies first so a callback may unsubscribe itself */
export function subs<T>() {
  const set = new Set<(v: T) => void>();
  return {
    on: (cb: (v: T) => void) => (set.add(cb), () => void set.delete(cb)),
    emit: (v: T) => [...set].forEach((cb) => cb(v)),
  };
}
