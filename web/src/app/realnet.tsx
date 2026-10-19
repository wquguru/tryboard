// "Real network" switch (C-03, design docs/design-v2/compete/Net.dc.html, wording "HTTP only"): off by default, turning on needs confirmation.
// The dialog mounts itself on body, so the top bar and the phone ... menu can both open it.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { t } from '../i18n';
import { cn } from '../ui/cn';
import { Icon } from './icons';
import { realnetSwitch } from './netfeed';

/** In an https page the browser refuses http requests (mixed content): only the local http preview can really reach the internet */
const mixedPage = () => location.protocol === 'https:';

function Confirm({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[data-act="keep"]')?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose]);
  const li = 'flex gap-2 leading-5';
  return (
    <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose}>
      <div
        ref={box}
        id="realnetDlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="realnetTitle"
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-x-3 top-14 flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4 text-[13px] text-fg shadow-panel md:right-40 md:left-auto md:w-[380px]"
      >
        <b id="realnetTitle" className="text-[15px]">
          {t('Let the board reach the real internet?')}
        </b>
        <p className="m-0 leading-5 text-fg/80">{t('HTTP requests the firmware sends to hosts other than tryboard.local really go out through your browser, and bring back real API data.')}</p>
        <div className="flex flex-col gap-2 rounded-lg bg-field p-2.5">
          <div className={li}>
            <Icon n="warn" size={16} className="mt-0.5 flex-none text-warn-ink" />
            {t('Results may differ from run to run; checkpoints are marked "needs internet" and record no run ID')}
          </div>
          <div className={li}>
            <Icon n="doc" size={16} className="mt-0.5 flex-none text-muted" />
            {t('Every reply received is stored in the input log and can be replayed offline later (command line --inputs, byte-for-byte identical)')}
          </div>
          <div className={li}>
            <Icon n="lock" size={16} className="mt-0.5 flex-none text-muted" />
            {t('Only HTTP is allowed; HTTPS and MQTT are not. When the site forbids cross-origin requests the reason is shown')}
          </div>
          {mixedPage() && (
            <div className={cn(li, 'text-warn-ink')}>
              <Icon n="warn" size={16} className="mt-0.5 flex-none" />
              {t('This page is https: the browser blocks every http request as "mixed content"; only the local http preview can really connect')}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" data-act="keep" className="h-9 cursor-pointer rounded-lg border border-line bg-surface px-3.5 text-fg max-md:h-11" onClick={onClose}>
            {t('Keep the virtual network')}
          </button>
          <button
            type="button"
            data-act="on"
            className="h-9 cursor-pointer rounded-lg border-0 bg-accent-strong px-3.5 font-medium text-white max-md:h-11"
            onClick={() => {
              realnetSwitch.set(true);
              onClose();
            }}
          >
            {t('Turn on the real network')}
          </button>
        </div>
      </div>
    </div>
  );
}

let host: { root: Root; el: HTMLElement } | null = null;
/** Switch: off -> confirm first; on -> go straight back to the virtual network */
export function toggleRealnet() {
  if (realnetSwitch.get()) {
    realnetSwitch.set(false);
    return;
  }
  if (host) return;
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  host = { root, el };
  const close = () => {
    const h = host;
    host = null;
    // Unmount on the next tick: do not unmount itself inside its own click handler
    setTimeout(() => {
      h?.root.unmount();
      h?.el.remove();
    });
  };
  root.render(<Confirm onClose={close} />);
}

export const useRealnet = () => useSyncExternalStore(realnetSwitch.subscribe, realnetSwitch.get);

/** Switch in the top bar (design: rounded capsule with a small toggle, amber when on) */
export function RealnetSwitch() {
  const on = useRealnet();
  return (
    <button
      type="button"
      role="switch"
      id="realnetBtn"
      aria-checked={on}
      title={on ? t("Real network: on (the chip's HTTP to the internet really goes out through the browser). Tap to go back to the virtual network") : t('Real network: off (only the in-browser virtual network, results are reproducible)')}
      onClick={toggleRealnet}
      className={cn(
        'flex h-8 flex-none cursor-pointer items-center gap-2 rounded-full border pr-2.5 pl-1.5 text-xs font-medium whitespace-nowrap max-[1100px]:hidden',
        on ? 'border-warn bg-warn-bg text-warn-ink' : 'border-line bg-surface text-muted hover:bg-field',
      )}
    >
      <span className={cn('relative h-5 w-8 rounded-full transition-colors', on ? 'bg-warn' : 'bg-line')}>
        <span className={cn('absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-[left]', on ? 'left-3.5' : 'left-0.5')} />
      </span>
      {t('Real network')}
    </button>
  );
}
