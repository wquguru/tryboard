// Phone ⋯ menu as a grouped bottom sheet (DESIGN_V2 §10.1); the desktop dropdown stays in topbar.tsx.
// data-more values match the desktop menu because the web tests find items by them.
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../ui/cn';
import { ThemeSegment } from '../ui/theme-segment';
import { LangSelect } from '../ui/lang';
import { SocialLinks } from '../ui/social';
import { LICENSES } from '../ui/links';
import { actions } from './chrome';
import { openFwMenu } from './fwmenu';
import { toggleRealnet, useRealnet } from './realnet';
import { Icon } from './icons';
import { copyPageLink } from './topbar';
import { t } from '../i18n';

const row =
  'flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-xl border-0 bg-transparent px-2 py-2 text-left text-[15px] text-fg no-underline hover:bg-field disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent';
const sub = 'block text-[12px] leading-snug text-muted';
const roundBtn = 'inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-field p-0 text-fg';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section data-more-group="" className="border-t border-line-soft pt-2 pb-1 first:border-t-0">
      <h3 className="m-0 px-2 pb-1 text-[12px] font-medium text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Row({
  icon,
  label,
  note,
  chevron,
  ...p
}: {
  icon: string;
  label: string;
  note?: string;
  chevron?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={row} {...p}>
      <Icon n={icon} size={18} className="flex-none text-muted" />
      <span className="min-w-0 flex-1">
        {label}
        {note && <span className={sub}>{note}</span>}
      </span>
      {chevron && <Icon n="left" size={16} className="flex-none rotate-180 text-muted" />}
    </button>
  );
}

/** Drag handle: a downward drag of ≥ 28 px or a tap closes the sheet */
function Handle({ onClose }: { onClose: () => void }) {
  const y0 = useRef<number | null>(null);
  return (
    <button
      type="button"
      data-more="grab"
      aria-label={t('Close')}
      className="flex h-6 w-full flex-none cursor-pointer touch-none items-center justify-center border-0 bg-transparent p-0"
      onPointerDown={(e) => {
        y0.current = e.clientY;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (y0.current !== null && e.clientY - y0.current >= 28) {
          y0.current = null;
          onClose();
        }
      }}
      onClick={onClose}
    >
      <span aria-hidden="true" className="h-1 w-9 rounded-full bg-line" />
    </button>
  );
}

export function MoreSheet({ toast, name }: { toast: (msg: string) => void; name?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && toggle(false);
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);
  const [page, setPage] = useState<'main' | 'share'>('main');
  const [dev, setDev] = useState(false);
  const realnet = useRealnet();
  const toggle = (v: boolean) => {
    setOpen(v);
    setPage('main');
    setDev(false);
  };
  const go = (fn: () => void) => () => {
    toggle(false);
    fn();
  };
  const shareCard = (id: string, icon: string, label: string, note: string, fn: (() => void) | undefined, primary?: boolean) => (
    <button
      type="button"
      data-more={id}
      disabled={!fn}
      onClick={go(() => fn?.())}
      className={cn(
        'flex min-h-16 w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-[15px] disabled:cursor-not-allowed disabled:opacity-50',
        primary ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-fg hover:bg-field',
      )}
    >
      <Icon n={icon} size={18} className="flex-none" />
      <span className="min-w-0 flex-1 font-medium">
        {label}
        <span className={cn('block text-[12px] leading-snug font-normal', primary ? 'text-white/85' : 'text-muted')}>{note}</span>
      </span>
    </button>
  );
  return (
    <div className="relative flex-none">
      <button
        type="button"
        id="moreBtn"
        className="inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-fg hover:bg-field"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('More: share, export input log, task brief for AI')}
        title={t('More')}
        onClick={() => toggle(!open)}
      >
        {/* Filled dots: the stroked "more" icon reads as muted at phone size (§10.1 wants body colour) */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open &&
        createPortal(
          <>
            {/* Portal to <body>: the sticky header's stacking context would put the sheet under the phone bottom bar */}
            <div id="moreScrim" aria-hidden="true" className="fixed inset-0 z-40 bg-[#0000007a]" onClick={() => toggle(false)} />
            <div
              role="dialog"
              aria-modal="true"
              aria-label={page === 'share' ? t('Share this bench…') : t('More')}
              id="moreMenu"
              data-page={page}
              className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-2xl border-t border-line bg-surface text-fg shadow-[0_-8px_24px_#00000026]"
            >
              <Handle onClose={() => toggle(false)} />
              <div className="flex flex-none items-center gap-2 border-b border-line-soft px-4 pb-2">
                {page === 'share' && (
                  <button type="button" data-more="back" aria-label={t('Back')} className={roundBtn} onClick={() => setPage('main')}>
                    <Icon n="left" size={18} />
                  </button>
                )}
                <div className="min-w-0 flex-1">
                  <b className="block truncate text-[16px]">{page === 'share' ? t('Share this bench…') : t('More')}</b>
                  {name && <span className="block truncate text-[12px] text-muted">{name}</span>}
                </div>
                <button type="button" data-more="close" aria-label={t('Close')} className={roundBtn} onClick={() => toggle(false)}>
                  <Icon n="x" size={18} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-[calc(12px+env(safe-area-inset-bottom))]">
                {page === 'share' ? (
                  <div className="flex flex-col gap-2 pt-2">
                    {shareCard('share', 'link', t('Copy share link'), t('Parts, wiring and your actions: others open the same bench at the same moment'), actions.share, true)}
                    {shareCard('card', 'play', t('Make a share card'), t('6 s video and image with a QR code, for chats and posts'), actions.shareCard)}
                    {shareCard(
                      'file',
                      'download',
                      t('Download .tryboard file'),
                      t('Also takes your own firmware and long action logs; drop the file on a TryBoard page to open it'),
                      actions.shareFile,
                    )}
                    <div className="flex min-h-11 flex-wrap items-center gap-x-2 px-1 pt-1 text-[12px] text-muted">
                      <span className="min-w-0 flex-1">{t('Work and step only; changes don’t travel with the link')}</span>
                      <button
                        type="button"
                        data-more="link"
                        className="min-h-11 cursor-pointer border-0 bg-transparent px-1 text-[13px] font-medium text-accent-ink"
                        onClick={go(() => copyPageLink(toast))}
                      >
                        {t('Copy link to this page')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <Group title={t('Share')}>
                      <Row data-more="share-open" icon="ext" label={t('Share this bench…')} note={t('Link, share card or .tryboard file')} chevron onClick={() => setPage('share')} />
                    </Group>
                    <Group title={t('Firmware')}>
                      <Row
                        id="swapFw"
                        data-more="fw"
                        data-fw-open=""
                        icon="upload"
                        label={t('Change firmware')}
                        note={t('Examples, reference firmware or your own .bin')}
                        disabled={!actions.pickFirmware}
                        onClick={go(openFwMenu)}
                      />
                    </Group>
                    <Group title={t('Developer tools')}>
                      <button type="button" data-more="dev" aria-expanded={dev} className={row} onClick={() => setDev(!dev)}>
                        <Icon n="doc" size={18} className="flex-none text-muted" />
                        <span className="min-w-0 flex-1">
                          {t('Developer tools')}
                          <span className={sub}>{t('Input log · AI task brief · Real network')}</span>
                        </span>
                        <Icon n={dev ? 'up' : 'down'} size={16} className="flex-none text-muted" />
                      </button>
                      {dev && (
                        <div className="pl-3">
                          <Row
                            data-more="inputs"
                            icon="download"
                            label={t('Export input log')}
                            note={t('Replay byte for byte with tryboard run --inputs')}
                            disabled={!actions.exportInputs}
                            onClick={go(() => actions.exportInputs?.())}
                          />
                          <Row
                            data-more="brief"
                            icon="doc"
                            label={t('Task brief for AI')}
                            note={t('Goal, wiring and check command of the current checkpoint')}
                            disabled={!actions.brief}
                            onClick={go(() => actions.brief?.())}
                          />
                          <button type="button" role="switch" aria-checked={realnet} data-more="realnet" className={row} onClick={go(toggleRealnet)}>
                            <Icon n="link" size={18} className="flex-none text-muted" />
                            <span className="min-w-0 flex-1">
                              {t('Real network')}
                              <span className={sub}>{realnet ? t('Tap to go back to the virtual network') : t("The chip's HTTP requests really go out through the browser")}</span>
                            </span>
                            <span aria-hidden="true" className={cn('relative h-7 w-12 flex-none rounded-full transition-colors', realnet ? 'bg-warn' : 'bg-line')}>
                              <span className={cn('absolute top-0.5 size-6 rounded-full bg-white shadow-sm transition-[left]', realnet ? 'left-5.5' : 'left-0.5')} />
                            </span>
                          </button>
                        </div>
                      )}
                    </Group>
                    <Group title={t('Settings')}>
                      <div data-more="theme" className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-2 text-[15px]">
                        {t('Dark mode')}
                        <ThemeSegment />
                      </div>
                      <div data-more="lang" className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-2 text-[15px]">
                        {t('Language')}
                        <LangSelect className="min-w-[150px] [&_select]:min-h-11 [&_select]:w-full" />
                      </div>
                    </Group>
                    <div className="border-t border-line-soft pt-1">
                      <a data-more="licenses" href={LICENSES} className="flex min-h-11 items-center px-2 text-[14px] text-muted no-underline hover:text-fg">
                        {t('Licenses and credits')}
                      </a>
                      <SocialLinks labels className="flex-col items-start gap-0 px-2 [&_a]:text-[14px]" />
                      <p lang="en" className="m-0 px-2 pb-1 text-[11px] leading-snug text-muted">
                        ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
