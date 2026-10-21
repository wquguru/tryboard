// Lazy dock panes (R-12): Code / Tasks / USB / Bluetooth / Network and the virtual phone load on first open or idle prefetch.
// Not React.lazy: Suspense holds revealed content back ~300 ms after a fallback, longer than the whole chunk fetch.
import { useEffect, useState, type ComponentType } from 'react';
import { t } from '../i18n';

const loaders = {
  code: () => import('./code'),
  tasks: () => import('./tasks'),
  usb: () => import('./usbpane'),
  ble: () => import('./blepane'),
  net: () => import('./netpane'),
  py: () => import('./mpypane'),
  scenario: () => import('./scenariopane'),
};
type Key = keyof typeof loaders;
type Mod<K extends Key> = Awaited<ReturnType<(typeof loaders)[K]>>;

const done = new Map<Key, unknown>();
const pending = new Map<Key, Promise<unknown>>();
function load<K extends Key>(k: K): Promise<Mod<K>> {
  let p = pending.get(k) as Promise<Mod<K>> | undefined;
  if (!p) {
    p = loaders[k]().then(
      (m) => (done.set(k, m), m as Mod<K>),
      (e) => {
        pending.delete(k);
        throw e;
      },
    );
    pending.set(k, p);
  }
  return p;
}

/** Placeholder while a pane's chunk loads */
export function PaneLoading({ text }: { text?: string }) {
  return (
    <p role="status" aria-busy="true" className="pane-loading m-0 p-3 text-xs text-muted">
      {text ?? t('Loading panel…')}
    </p>
  );
}

function pane<K extends Key, P extends object>(k: K, pick: (m: Mod<K>) => ComponentType<P>, text?: () => string) {
  return function LazyPane(props: P) {
    const [C, setC] = useState<ComponentType<P> | null>(() => (done.has(k) ? pick(done.get(k) as Mod<K>) : null));
    const [err, setErr] = useState('');
    useEffect(() => {
      if (C) return;
      let live = true;
      load(k).then(
        (m) => live && setC(() => pick(m)),
        (e) => live && setErr(String(e?.message ?? e)),
      );
      return () => {
        live = false;
      };
    }, [C]);
    if (C) return <C {...props} />;
    if (err) return <p role="alert" className="m-0 p-3 text-xs text-muted">{t('This panel could not load: {err}', { err })}</p>;
    return <PaneLoading text={text?.()} />;
  };
}

export const CodePane = pane('code', (m) => m.default, () => t('Loading code tab…'));
export const TasksPane = pane('tasks', (m) => m.TasksPane);
export const UsbPane = pane('usb', (m) => m.UsbPane);
export const BlePane = pane('ble', (m) => m.BlePane);
export const PhonePanel = pane('ble', (m) => m.PhonePanel);
export const NetPane = pane('net', (m) => m.NetPane);
export const MpyPane = pane('py', (m) => m.MpyPane);
export const ScenarioPane = pane('scenario', (m) => m.ScenarioPane);

/** Fetch every pane chunk; failures are ignored here and surface when the pane is opened. */
export function prefetchPanes() {
  return Promise.all((Object.keys(loaders) as Key[]).map((k) => load(k).catch(() => null)));
}
