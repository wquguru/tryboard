// ⌘K palette views (R-12): the top-bar box and list render at first paint; the search logic in cmdk.tsx loads with the session.
import type { ReactNode } from 'react';
import { useStore } from './react';
import { createStore } from './store';
import { t } from '../i18n';

/** Palette open state and list content, written by createCmdk */
export const view = createStore<{ open: boolean; node: ReactNode }>({ open: false, node: null });

/** The centered top-bar input (uncontrolled; listeners are attached in createCmdk) */
export function CmdkBox() {
  const { open } = useStore(view);
  return (
    <div role="search" className="cmdk flex h-8 w-[200px] flex-none max-[1500px]:w-[100px] items-center rounded-lg border border-line bg-field focus-within:border-accent focus-within:bg-surface max-[1100px]:hidden">
      <input
        id="cmdk"
        type="search"
        placeholder={t('Search commands, parts, pins')}
        aria-label={t('Command palette')}
        autoComplete="off"
        role="combobox"
        aria-controls="cmdkList"
        aria-expanded={open}
        className="min-w-0 flex-1 border-0 bg-transparent px-2.5 py-1 text-[13px] text-inherit outline-none"
      />
      <kbd className="mono px-2 font-mono text-[11px] text-muted">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
    </div>
  );
}

export function CmdkList() {
  const { open, node } = useStore(view);
  return (
    <div
      id="cmdkList"
      role="listbox"
      hidden={!open}
      className="pnl cmdk-list max-md:hidden! fixed top-[calc(var(--top-h)+4px)] left-[calc((100vw+var(--left-w)-var(--right-w))/2)] z-5 max-h-[min(420px,60vh)] w-[min(460px,calc(100vw-var(--left-w)-var(--right-w)-32px))] min-w-[300px] -translate-x-1/2 overflow-auto rounded-(--r) border border-line bg-surface p-1 text-fg shadow-panel"
    >
      {node}
    </div>
  );
}
