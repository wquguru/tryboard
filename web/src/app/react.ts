// 工作台的 React 接线：命令式代码（步骤、session、benchhist）改状态，React 组件订阅着画。
// 改状态的一方往往紧接着就要量尺寸、找节点（快捷卡片定位、测试脚本 store.set 后立刻点按钮），
// 所以外壳的 setter 一律同步提交（flushSync）。不能在渲染 / effect 里调这些 setter。
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

/** 同步提交：调用返回时 DOM 已经是新的 */
export const commit = (fn: () => void) => flushSync(fn);

/** 外壳里一块可替换内容（构建树、属性面板、步骤层、快捷卡片）：步骤 render 一棵 JSX 进去 */
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
