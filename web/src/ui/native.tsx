// Seam between React and imperative lab code (DECISIONS 2026-10-17). Scripts set .value and dispatch (non-bubbling) events React's
// onChange misses, so inputs use native listeners; >10 Hz readouts bypass React state (data-live); Host mounts imperative nodes.
import { useLayoutEffect, useRef, type ComponentProps, type ElementType } from 'react';

type NativeEv = (e: Event & { currentTarget: HTMLInputElement }) => void;
type On<K extends string> = Partial<Record<K, NativeEv>>;

/** Attach `on` as native listeners once; callbacks are refreshed every render. */
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

/** Uncontrolled input with native input / change listeners; callers sync by writing .value directly. */
export function NInput({ on, ...p }: Omit<ComponentProps<'input'>, 'onChange' | 'onInput' | 'value'> & { on?: On<'input' | 'change'> }) {
  const ref = useNative<HTMLInputElement>(on);
  return <input ref={ref} {...p} />;
}

export function NSelect({ on, ...p }: Omit<ComponentProps<'select'>, 'onChange' | 'onInput' | 'value'> & { on?: On<'input' | 'change'> }) {
  const ref = useNative<HTMLSelectElement>(on as On<string>);
  return <select ref={ref} {...p} />;
}

/** Live field: React renders the shell and initial value, imperative code updates the text afterwards. */
export function Live({ k, init = '', as, ...p }: { k: string; init?: string; as?: ElementType } & Omit<ComponentProps<'span'>, 'children'>) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = init;
    // Written once on mount; later values belong to imperative code.
  }, []);
  const C = as ?? 'span';
  return <C ref={ref} data-live={k} {...p} />;
}

/** Imperative text (countdowns, progress): initial value on mount, then owned by the caller. */
export function useInitText<T extends HTMLElement>(init: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = init;
  }, []);
  return ref;
}

/** Element whose text imperative code changes; React renders the shell and writes text once on mount. */
export function Txt({ as, text, ...p }: { as?: ElementType; text: string } & Omit<ComponentProps<'button'>, 'children'>) {
  const ref = useInitText<HTMLElement>(text);
  const C = as ?? 'span';
  return <C ref={ref} {...p} />;
}

/** Mount an imperative node into the React tree (display: contents); on unmount it is detached for reuse. */
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
