// React 与命令式代码的接缝（实验台 app.html 用，DECISIONS 2026-10-17）：
// - 模拟器 / 测试脚本会直接改 .value 再派发 input / change（有的不冒泡），React 的 onChange 靠值跟踪和根节点委托，两种都收不到，
//   所以输入框一律挂原生监听（NInput / NSelect）。
// - 高频读数（>10 Hz）不走 React state：Live 只在挂载时写一次初值，之后由步骤代码按 data-live 直接改 textContent。
// - 3D 画面、SVG 视图这类命令式节点用 Host 挂进来，卸载时摘下，节点本身留给调用方复用。
import { useLayoutEffect, useRef, type ComponentProps, type ElementType } from 'react';

type NativeEv = (e: Event & { currentTarget: HTMLInputElement }) => void;
type On<K extends string> = Partial<Record<K, NativeEv>>;

/** 把 on 里的事件挂成原生监听；回调每次渲染都换成最新的，监听只挂一次 */
function useNative<T extends HTMLElement>(on: On<string> | undefined) {
  const ref = useRef<T>(null);
  const latest = useRef(on);
  useLayoutEffect(() => {
    latest.current = on;
  });
  const types = Object.keys(on ?? {}).sort().join(',');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !types) return;
    const fns = types.split(',').map((t) => [t, (e: Event) => latest.current?.[t]?.(e as Event & { currentTarget: HTMLInputElement })] as const);
    for (const [t, f] of fns) el.addEventListener(t, f);
    return () => {
      for (const [t, f] of fns) el.removeEventListener(t, f);
    };
  }, [types]);
  return ref;
}

/** 非受控输入框 + 原生 input / change 监听。初值用 defaultValue；外部同步由调用方直接改 .value */
export function NInput({ on, ...p }: Omit<ComponentProps<'input'>, 'onChange' | 'onInput' | 'value'> & { on?: On<'input' | 'change'> }) {
  const ref = useNative<HTMLInputElement>(on);
  return <input ref={ref} {...p} />;
}

export function NSelect({ on, ...p }: Omit<ComponentProps<'select'>, 'onChange' | 'onInput' | 'value'> & { on?: On<'input' | 'change'> }) {
  const ref = useNative<HTMLSelectElement>(on as On<string>);
  return <select ref={ref} {...p} />;
}

/** 实时字段：React 只渲染外壳和初值，之后由命令式代码改文字（不经 React state） */
export function Live({ k, init = '', as, ...p }: { k: string; init?: string; as?: ElementType } & Omit<ComponentProps<'span'>, 'children'>) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = init;
    // 只在挂载时写一次：之后的值归命令式代码
  }, []);
  const C = as ?? 'span';
  return <C ref={ref} data-live={k} {...p} />;
}

/** 命令式文字（按钮上的倒计时、进度）：挂载时写初值，之后归调用方 */
export function useInitText<T extends HTMLElement>(init: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = init;
  }, []);
  return ref;
}

/** 文字由命令式代码改的元素（进度、倒计时、模拟器输出）：React 只渲染外壳，挂载时写一次 text */
export function Txt({ as, text, ...p }: { as?: ElementType; text: string } & Omit<ComponentProps<'button'>, 'children'>) {
  const ref = useInitText<HTMLElement>(text);
  const C = as ?? 'span';
  return <C ref={ref} {...p} />;
}

/** 把一个命令式节点挂进 React 树（display: contents，不占布局）；卸载时摘下，节点留给调用方下次再挂 */
export function Host({ node }: { node: Node | null | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || !node) return;
    box.appendChild(node);
    return () => {
      if (node.parentNode === box) box.removeChild(node);
    };
  }, [node]);
  return <div ref={ref} className="contents" />;
}
