// "Firmware ▾" menu (U-08, mocks docs/design-v2/unify/Bench, MobileFw): every way to run another program in one place.
// Desktop dropdown / phone bottom sheet; open state in bc.fwMenu so the empty-bench card and phone ⋯ menu can open it.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LOCALES, locale, t } from '../i18n/index.ts';
import { cn } from '../ui/cn';
import { actions, bc, BLANK, setBc } from './chrome';
import { CHIP_NAME, chipOf, exampleHref, loadExamples, type Chip, type Example } from './examples';
import { Icon } from './icons';
import { useStore } from './react';
import { menuItem, menuPanel } from './topbar';

const RECENT_KEY = 'tryboard-recent-fw';
type Recent = { kind: 'example'; id: string; title: string; at: number } | { kind: 'file'; name: string; at: number };

export function recentFw(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.slice(0, 3) : [];
  } catch {
    return [];
  }
}
/** Record opened examples/uploads; files keep only their name (content can't be re-read), clicking re-picks the file. */
export function pushRecent(r: Recent) {
  const key = (x: Recent) => (x.kind === 'example' ? `e:${x.id}` : `f:${x.name}`);
  const list = [r, ...recentFw().filter((x) => key(x) !== key(r))].slice(0, 3);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode: not recorded */
  }
}

const hhmm = (at: number) => new Date(at).toLocaleTimeString(LOCALES.find((l) => l.id === locale)?.html, { hour: '2-digit', minute: '2-digit' });
const open = (v: boolean) => setBc({ fwMenu: v });

/** Top-bar button + dropdown/sheet. The file input stays mounted so change still fires after the menu closes. */
export function FwMenu({ phone }: { phone?: boolean }) {
  const { fwMenu, fw, chip: cur } = useStore(bc);
  const file = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [exs, setExs] = useState<Example[]>([]);
  const [chip, setChip] = useState<Chip>(cur);
  const [all, setAll] = useState(false);
  useEffect(() => void loadExamples().then(setExs), []);
  // Each open starts from the bench chip.
  useEffect(() => {
    if (fwMenu) {
      setChip(cur);
      setAll(false);
    }
  }, [fwMenu, cur]);
  useEffect(() => {
    if (!fwMenu) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-fw-open]') && open(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && open(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [fwMenu]);
  const running = (e: Example) => fw === `${e.id}/flash.bin`;
  // The running example sorts first so "running" shows even when collapsed.
  const list = exs.filter((e) => chipOf(e) === chip).sort((a, b) => +running(b) - +running(a));
  const shown = all ? list : list.slice(0, 5);
  const recent = recentFw().filter((r) => !(r.kind === 'example' && fw === `${r.id}/flash.bin`));
  const item = cn(menuItem, 'no-underline', phone && 'min-h-11');
  const sec = 'px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted';
  const panel = (
    <div
      ref={ref}
      role="menu"
      id="fwMenu"
      aria-label={t('Change firmware')}
      className={
        phone
          ? 'fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-auto rounded-t-2xl border-t border-line bg-surface px-2 pt-2 pb-[calc(12px+env(safe-area-inset-bottom))] text-[14px] text-fg shadow-[0_-8px_24px_#00000026]'
          : cn(menuPanel, 'right-0 max-h-[min(640px,80vh)] w-[340px] overflow-auto')
      }
    >
      {phone && <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 rounded-full bg-line" />}
      <div className="flex items-center gap-2 px-2.5 py-1">
        <b className={phone ? 'text-[16px]' : 'text-[13px]'}>{t('Change firmware')}</b>
        <div role="radiogroup" aria-label={t('Chip')} className="ml-auto flex rounded-lg bg-field p-0.5">
          {(['esp32', 'esp32c3', 'esp32s3'] as Chip[]).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={chip === c}
              data-chip={c}
              onClick={() => (setChip(c), setAll(false))}
              className={cn(
                'cursor-pointer rounded-md border-0 bg-transparent px-2.5 font-mono text-[11.5px] text-muted',
                phone ? 'min-h-11 min-w-[72px]' : 'h-6',
                chip === c && 'bg-surface font-medium text-fg shadow-[0_1px_2px_#0000001a]',
              )}
            >
              {phone ? CHIP_NAME[c] : CHIP_NAME[c].replace('ESP32-', '')}
            </button>
          ))}
        </div>
      </div>
      <div className={sec}>{t('Examples')}</div>
      {shown.map((e) => {
        const on = running(e);
        return (
          <a key={e.id} role="menuitem" data-ex={e.id} href={exampleHref(e.id)} aria-current={on || undefined} className={cn(item, on && 'bg-accent-bg')}>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{t(e.title)}</span>
              <span className="block truncate text-[11px] text-muted">
                {e.tags.filter((g) => !g.startsWith('✓')).slice(0, 3).map((g) => t(g)).join(' · ')}
                {on && ` · ${t('Running')}`}
              </span>
            </span>
          </a>
        );
      })}
      {list.length > 5 && !all && (
        <button type="button" role="menuitem" data-fw="all" className={cn(item, 'text-accent-ink')} onClick={() => setAll(true)}>
          {t('All {n} {chip} examples…', { n: list.length, chip: CHIP_NAME[chip].replace('ESP32-', '') })}
        </button>
      )}
      {!BLANK && actions.loadRef && (
        <>
          <div className={sec}>{t('This project')}</div>
          <button type="button" role="menuitem" data-fw="ref" className={item} onClick={() => (open(false), actions.loadRef?.())}>
            <Icon n="restart" size={15} />
            <span className="min-w-0 flex-1">
              {t('Back to the reference firmware')}
              <span className="block text-[11px] text-muted">{t("The project's own firmware: see the result, no checkpoints run")}</span>
            </span>
          </button>
          {actions.runAllRef && (
            <button type="button" role="menuitem" data-fw="allref" className={item} onClick={() => (open(false), actions.runAllRef?.())}>
              <Icon n="play" size={15} />
              <span className="min-w-0 flex-1">
                {t('Run the whole route with built-in firmware')}
                <span className="block text-[11px] text-muted">{t('Each checkpoint is checked with its own reference firmware; passes count as ◐ and unlock assembly')}</span>
              </span>
            </button>
          )}
        </>
      )}
      {recent.length > 0 && <div className={sec}>{t('Recent')}</div>}
      {recent.map((r) =>
        r.kind === 'example' ? (
          <a key={`e:${r.id}`} role="menuitem" data-recent={r.id} href={exampleHref(r.id)} className={item}>
            <Icon n="restart" size={15} />
            <span className="min-w-0 flex-1 truncate">{t('Example · {title}', { title: t(r.title) })}</span>
            <span className="flex-none font-mono text-[11px] text-muted">{hhmm(r.at)}</span>
          </a>
        ) : (
          <button key={`f:${r.name}`} type="button" role="menuitem" data-recent-file={r.name} title={t("The browser doesn't keep file contents: click to pick this file again")} className={item} onClick={() => (open(false), file.current?.click())}>
            <Icon n="doc" size={15} />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{r.name}</span>
            <span className="flex-none font-mono text-[11px] text-muted">{hhmm(r.at)}</span>
          </button>
        ),
      )}
      <div className="my-1 h-px bg-line" />
      <button type="button" role="menuitem" data-fw="upload" className={item} disabled={!actions.pickFirmware} onClick={() => (open(false), file.current?.click())}>
        <Icon n="upload" size={15} />
        <span className="min-w-0 flex-1">
          {t('Upload your own .bin…')}
          <span className="block text-[11px] text-muted">{t("Runs on the bench and checks the current checkpoint. A full flash image from ESP-IDF / Arduino; dropping it on the bench works too (the file never leaves your browser).")}</span>
        </span>
      </button>
    </div>
  );
  return (
    <div className={cn('relative flex-none', phone && 'contents')}>
      <input
        ref={file}
        type="file"
        accept=".bin"
        hidden
        id="fwPick"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          open(false);
          if (f) actions.pickFirmware?.(f);
        }}
      />
      {!phone && (
        <button
          type="button"
          id="swapFw"
          data-fw-open=""
          aria-haspopup="menu"
          aria-expanded={fwMenu}
          title={t('Run another program on the bench: an example, the reference firmware or your own .bin')}
          onClick={() => open(!fwMenu)}
          className="inline-flex h-8 flex-none cursor-pointer items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-[13px] whitespace-nowrap text-fg hover:bg-field max-[1100px]:hidden"
        >
          {t('Change firmware')}
          <Icon n="down" size={14} className="text-muted" />
        </button>
      )}
      {/* Phone sheet portals to body: the top bar's own stacking context (z-20) would put it under the serial sheet and bottom bar. */}
      {fwMenu &&
        phone &&
        createPortal(
          <>
            <div aria-hidden="true" className="fixed inset-0 z-40 bg-[#0000004d]" onClick={() => open(false)} />
            {panel}
          </>,
          document.body,
        )}
      {fwMenu && !phone && panel}
    </div>
  );
}

/** Open the firmware menu (empty-bench card, phone ⋯). Clicks on [data-fw-open] don't count as "click outside". */
export const openFwMenu = () => open(true);
