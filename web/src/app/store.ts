// 极简可订阅 store：一个对象、浅合并更新、同步通知。不做 diff，订阅者自己挑关心的字段。

export interface Store<T extends object> {
  get(): T;
  /** 浅合并；传函数时拿到当前状态返回补丁 */
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  /** 返回取消订阅函数。keys 给了就只在这些字段变（!==）时通知 */
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
      // 先拷一份：订阅者里可能取消订阅或再 set
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
