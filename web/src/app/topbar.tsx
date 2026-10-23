// Lab v2 top bar (DESIGN_V2 §3, §4): breadcrumb + work switch, saved state, undo / redo, steps, ⌘K, run state, firmware, ⋯ menu.
// Data comes from chrome.ts (bc); actions are registered by main.tsx / the bench and buttons grey out until they are.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../ui/cn';
import { Logo } from '../ui/logo';
import { currentTheme, onTheme, setTheme } from '../theme';
import { actions, bc, BLANK, CUSTOM, EXAMPLE_ID, TWO_STEPS, shownSteps } from './chrome';
import { decode, encode } from '../advisor/state';
import { FwMenu, openFwMenu } from './fwmenu';
import { RealnetSwitch, toggleRealnet, useRealnet } from './realnet';
import { NetCondChip } from './netcond';
import { MoreSheet } from './moresheet';
import { CmdkBox } from './cmdkview';
import { Icon } from './icons';
import { useStore } from './react';
import { savedText } from './saved';
import { STEPS, type StepId, type WorkDef } from './types';
import { WORKS, wkey } from './works';
import { loadProgress } from './bench/progress';
import { CHIP_LABEL, type SimChip } from '../chips';
import { BLANK_LAB, HOME, LICENSES, lab, selectLink } from '../ui/links';
import { LangSelect } from '../ui/lang';
import { t } from '../i18n';

/** 32×32 icon button */
const ib =
  'ib inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-fg hover:bg-field disabled:cursor-not-allowed disabled:text-muted disabled:opacity-50 disabled:hover:bg-transparent';
export const menuPanel = 'absolute z-30 mt-1 min-w-[220px] rounded-(--r) border border-line bg-surface p-1 text-[13px] text-fg shadow-panel';
export const menuItem = 'flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-fg hover:bg-field disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent';

/** Dropdown closed by an outside click / Esc */
export function usePop() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // A panel portalled out of ref (phone work menu) still counts as inside
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return { open, setOpen, ref, panelRef };
}

/** Work menu groups (DESIGN_V2 §10.3): works with checkpoints, then the free bench (blank + my project tiles, bench-only examples) */
const GUIDED = Object.values(WORKS).filter((w) => w.checkpoints.length);
const BENCH_ONLY = Object.values(WORKS).filter((w) => !w.checkpoints.length && w.id !== 'blank' && w.id !== 'custom');
const workHref = (id: string) => lab(id, (location.hash.slice(1) || 'bench') as StepId);
/** Saved checkpoint passes; reference run-throughs count too */
const passedCount = (w: WorkDef) => {
  const p = loadProgress(wkey(w));
  return w.checkpoints.filter((id) => p[id]).length;
};

/** phone: work name centered in the phone top bar (≥ 44 tall, full-width menu) */
export function WorkMenu({ name, phone }: { name: string; phone?: boolean }) {
  const { open, setOpen, ref, panelRef } = usePop();
  const cur = new URLSearchParams(location.search).get('work') ?? 'weather';
  const button = (
    <h1 className="m-0 min-w-0 text-sm">
        <button
          id="workMenuBtn"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          title={t('Switch work')}
          onClick={() => setOpen(!open)}
          className={cn('inline-flex min-h-8 max-w-[300px] cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1 text-fg hover:bg-field', phone ? 'min-h-11 max-w-full px-2 text-[15px]' : 'max-[1500px]:max-w-[150px]')}
        >
          <span id="workName" className="work truncate font-bold">
            {name}
          </span>
          <Icon n="down" size={14} className="flex-none text-muted" />
        </button>
    </h1>
  );
  const panel = open && (
        <div ref={panelRef} role="menu" aria-label={t('Switch work')} id="workMenu" className={cn(menuPanel, 'left-0 max-h-[70vh] w-[360px] overflow-auto', phone && 'fixed top-12 right-2 left-2 z-50 max-h-[calc(100dvh-3.5rem)] w-auto [&_a]:min-h-11')}>
          <div role="group" aria-labelledby="wmGuided" data-group="guided">
            <div id="wmGuided" className="px-2.5 pt-1.5 pb-1 text-[12px] text-muted">
              {t('Guided works')}
            </div>
            {GUIDED.map((w) => {
              const done = passedCount(w);
              const total = w.checkpoints.length;
              return (
                <a key={w.id} role="menuitemradio" aria-checked={w.id === cur} data-work={w.id} href={workHref(w.id)} className={cn(menuItem, 'no-underline', w.id === cur && 'bg-accent-bg font-medium hover:bg-accent-bg')}>
                  <span className="inline-flex w-4 flex-none justify-center text-accent-ink">{w.id === cur && <Icon n="check" size={14} />}</span>
                  <span className="min-w-0 flex-1 truncate">{w.title}</span>
                  <span className="h-1 w-10 flex-none overflow-hidden rounded-full bg-line" aria-hidden="true">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${(done / total) * 100}%` }} />
                  </span>
                  <span className="w-8 flex-none text-right font-mono text-[11px] text-muted tabular-nums" title={t('{done} of {total} checkpoints passed', { done, total })}>
                    {done}/{total}
                  </span>
                </a>
              );
            })}
          </div>
          <div role="separator" className="mx-1 my-1 h-px bg-line" />
          <div role="group" aria-labelledby="wmFree" data-group="free">
            <div id="wmFree" className="px-2.5 pt-1 pb-1 text-[12px] text-muted">
              {t('Free lab')}
            </div>
            <div data-row="free-top" className="grid grid-cols-2 gap-1 px-1 pb-1">
              {(['blank', 'custom'] as const).map((id) => (
                <a
                  key={id}
                  role="menuitemradio"
                  aria-checked={id === cur}
                  data-work={id}
                  href={workHref(id)}
                  className={cn(
                    'flex min-h-10 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-fg no-underline hover:bg-field',
                    id === 'blank' ? 'border-dashed border-hover-line' : 'border-line',
                    id === cur && 'border-accent-line bg-accent-bg font-medium hover:bg-accent-bg',
                  )}
                >
                  <span className="inline-flex w-4 flex-none justify-center text-accent-ink">{id === cur ? <Icon n="check" size={14} /> : id === 'blank' && <Icon n="plus" size={14} className="text-muted" />}</span>
                  <span className="min-w-0 flex-1 truncate">{id === 'blank' ? t('Blank lab') : WORKS.custom.title}</span>
                </a>
              ))}
            </div>
            {BENCH_ONLY.map((w) => (
              <a key={w.id} role="menuitemradio" aria-checked={w.id === cur} data-work={w.id} href={workHref(w.id)} className={cn(menuItem, 'no-underline', w.id === cur && 'bg-accent-bg font-medium hover:bg-accent-bg')}>
                <span className="inline-flex w-4 flex-none justify-center text-accent-ink">{w.id === cur && <Icon n="check" size={14} />}</span>
                <span className="min-w-0 flex-1 truncate">{w.title}</span>
              </a>
            ))}
          </div>
        </div>
  );
  return (
    <div ref={ref} className="relative min-w-0">
      {button}
      {/* Phone menu portals to body: the top bar's stacking context (z-20) would put it under the sheet and bottom bar */}
      {phone && panel
        ? createPortal(
            <>
              <div aria-hidden="true" className="fixed inset-0 z-40 bg-[#0000004d]" />
              {panel}
            </>,
            document.body,
          )
        : panel}
    </div>
  );
}

/** First crumb: works → work list; blank / example → Lab (DESIGN_V2 §6.2 glossary: the entry is always called Lab) */
export const CRUMB = BLANK
  ? { href: BLANK_LAB, label: t('Lab'), title: t('Back to the blank lab') }
  : CUSTOM
    ? { href: selectLink(encode(decode(location.search))), label: t('Board picker'), title: t('Back to the board picker to change parts (this BOM and bench stay on this device)') }
    : { href: HOME, label: t('Works'), title: t('Back to the work list (unsaved wiring stays on this device)') };

function Breadcrumb({ name }: { name: string }) {
  const { saved, chip } = useStore(bc);
  // Refresh "just now / n minutes ago" every 30 s
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="crumb flex min-w-0 flex-none flex-col justify-center">
      <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
        <a href={HOME} aria-label={t('TryBoard home')} className="brand inline-flex flex-none items-center gap-1.5 leading-none text-fg no-underline">
          <Logo size={22} />
          <b className="text-[14px] max-[1500px]:hidden">{t('TryBoard')}</b>
        </a>
        <a
          id="crumbHome"
          href={CRUMB.href}
          title={CRUMB.title}
          className="inline-flex min-h-8 flex-none items-center px-0.5 text-accent-ink no-underline underline-offset-3 hover:underline"
        >
          {CRUMB.label}
        </a>
        <span className="text-muted">/</span>
        <WorkMenu name={EXAMPLE_ID ? t('Example · {name}', { name }) : name} />
        {EXAMPLE_ID && (
          <span id="chipBadge" className="flex-none rounded-md border border-line px-1.5 py-px font-mono text-[11px] text-muted max-[1500px]:hidden">
            {CHIP_LABEL[chip as SimChip] ?? 'ESP32-C3'}
          </span>
        )}
      </div>
      <span id="savedState" className="-mt-1 pl-[34px] text-[11px] leading-none text-muted">
        {savedText(saved)}
      </span>
    </div>
  );
}

function StepBar({ step }: { step: StepId }) {
  const { locks, done, checkpoints } = useStore(bc);
  const ok = checkpoints.filter((c) => c.state === 'ok' || c.state === 'ref').length;
  return (
    <nav id="steps" role="tablist" aria-label={TWO_STEPS ? t('Two steps') : t('Four steps')} className="steps flex flex-none items-center">
      {STEPS.filter((s) => shownSteps().includes(s.id)).map((s, i) => {
        const on = s.id === step;
        const lock = locks[s.id];
        return (
          <div key={s.id} className="flex items-center">
            {i > 0 && <span aria-hidden="true" className="mx-1 h-0.5 w-5 rounded-full bg-line max-[1500px]:mx-0.5 max-[1500px]:w-2" />}
            <button
              type="button"
              role="tab"
              data-step={s.id}
              aria-selected={on}
              data-locked={lock ? '' : undefined}
              title={lock ?? (done[s.id] ? t('{step} · done', { step: s.label }) : s.label)}
              onClick={() => (location.hash = s.id)}
              className={cn(
                'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-[13px] whitespace-nowrap text-muted hover:bg-field',
                on && 'bg-accent-bg font-medium text-accent-ink hover:bg-accent-bg',
                done[s.id] && !on && 'text-ok-ink',
              )}
            >
              {done[s.id] && !on ? (
                <Icon n="check" size={14} />
              ) : (
                <span className={cn('inline-flex size-[18px] items-center justify-center rounded-full font-mono text-[11px]', on ? 'bg-accent-strong text-on-accent' : 'border border-line')}>{i + 1}</span>
              )}
              <span className={cn(!on && '@max-[500px]:sr-only')}>{s.label}</span>
              {lock && <Icon n="lock" size={13} className="text-muted" />}
              {on && s.id === 'bench' && checkpoints.length > 0 && <span className="font-mono text-[11px] font-normal">{`${ok}/${checkpoints.length}`}</span>}
            </button>
          </div>
        );
      })}
    </nav>
  );
}

export const RUN_TEXT: Record<string, [string, string]> = {
  loading: [t('Loading'), 'bg-muted'],
  run: [t('Running'), 'bg-ok'],
  pause: [t('Paused'), 'bg-warn'],
  seek: [t('Rewound, stopped'), 'bg-accent'],
  busy: [t('Rewinding…'), 'bg-accent'],
  idle: [t('Not running'), 'bg-muted'],
  nofw: [t('No firmware'), 'bg-muted'],
};
export const SPEEDS = [1, 2, 0.5];

function RunGroup({ bench }: { bench: boolean }) {
  const { run, speed, sound } = useStore(bc);
  const [txt, dot] = RUN_TEXT[run];
  const live = bench && (run === 'run' || run === 'pause' || run === 'seek');
  return (
    <div role="group" aria-label={t('Run state')} id="runGroup" data-run={run} className="flex h-8 flex-none items-center gap-0.5 rounded-lg border border-line pr-0.5 pl-2.5 max-[1280px]:hidden">
      <span className="inline-flex items-center gap-1.5 pr-1 text-xs whitespace-nowrap">
        <span className={cn('size-2 rounded-full', dot, run === 'run' && 'animate-pulse')} />
        {/* Off-bench the run buttons are grey: say it is the bench running, else "Running" next to grey buttons looks broken */}
        <span id="runState" title={bench ? undefined : t('Run controls live on the bench; this step only shows the state')}>{bench ? txt : t('Bench: {state}', { state: txt })}</span>
      </span>
      {actions.speed && (
        <button
          type="button"
          id="runSpeed"
          className={cn(ib, 'w-auto px-1.5 font-mono text-xs')}
          disabled={!live}
          title={t('Speed: changes wall-clock pace only; simulated time and results stay the same')}
          onClick={() => actions.speed!(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
        >
          {speed}×
        </button>
      )}
      <button
        type="button"
        id="runPause"
        className={ib}
        disabled={!live}
        title={run === 'run' ? t('Pause') : run === 'seek' ? t('Continue from this moment') : t('Resume')}
        aria-label={run === 'run' ? t('Pause') : t('Resume')}
        onClick={() => (run === 'run' ? actions.pause?.() : actions.resume?.())}
      >
        <Icon n={run === 'run' ? 'pause' : 'play'} size={15} />
      </button>
      <button type="button" id="runRestart" className={ib} disabled={!bench || !actions.reboot || run === 'loading' || run === 'nofw'} title={t('Restart (power cycle)')} aria-label={t('Restart')} onClick={() => actions.reboot?.()}>
        <Icon n="restart" size={15} />
      </button>
      {bench && sound.has && (
        <button type="button" id="sound" className={ib} aria-pressed={sound.on} title={sound.on ? t('Sound: on (click to mute)') : t('Sound: off (muted by default, click to unmute)')} aria-label={sound.on ? t('Sound: on') : t('Sound: off')} onClick={() => actions.sound?.()}>
          <Icon n={sound.on ? 'sound' : 'mute'} size={15} />
        </button>
      )}
    </div>
  );
}

/** Copy the plain page URL (work + step only) and report the result in a toast */
export function copyPageLink(toast: (msg: string) => void) {
  void navigator.clipboard?.writeText(location.href).then(
    () => toast(t('Link to this page copied (work and step only; your changes stay on this device)')),
    () => toast(t('Copy failed: the browser blocked clipboard access')),
  );
}

/** phone: grouped bottom sheet (moresheet.tsx, DESIGN_V2 §10.1); desktop: the dropdown below */
export function MoreMenu({ toast, phone, name }: { toast: (msg: string) => void; phone?: boolean; name?: string }) {
  return phone ? <MoreSheet toast={toast} name={name} /> : <MoreDropdown toast={toast} />;
}

function MoreDropdown({ toast }: { toast: (msg: string) => void }) {
  const { open, setOpen, ref } = usePop();
  const realnet = useRealnet();
  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="relative flex-none">
      <button type="button" id="moreBtn" className={ib} aria-haspopup="menu" aria-expanded={open} aria-label={t('More: share, export input log, task brief for AI')} title={t('More')} onClick={() => setOpen(!open)}>
        <Icon n="more" />
      </button>
      {open && (
        <div role="menu" id="moreMenu" className={cn(menuPanel, 'right-0 w-[280px]')}>
          <button type="button" role="menuitem" data-more="share" className={menuItem} disabled={!actions.share} onClick={go(() => actions.share?.())}>
            <Icon n="ext" size={15} />
            <span className="flex-1">
              {t('Copy share link')}
              <span className="block text-[11px] text-muted">{t('Parts, wiring and your actions: others open the same bench at the same moment')}</span>
            </span>
          </button>
          <button type="button" role="menuitem" data-more="file" className={menuItem} disabled={!actions.shareFile} onClick={go(() => actions.shareFile?.())}>
            <Icon n="download" size={15} />
            <span className="flex-1">
              {t('Download .tryboard file')}
              <span className="block text-[11px] text-muted">{t('Also takes your own firmware and long action logs; drop the file on a TryBoard page to open it')}</span>
            </span>
          </button>
          <button type="button" role="menuitem" data-more="card" className={menuItem} disabled={!actions.shareCard} onClick={go(() => actions.shareCard?.())}>
            <Icon n="play" size={15} />
            <span className="flex-1">
              {t('Make a share card')}
              <span className="block text-[11px] text-muted">{t('6 s video and image with a QR code, for chats and posts')}</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-more="link"
            className={menuItem}
            onClick={go(() => copyPageLink(toast))}
          >
            <Icon n="link" size={15} />
            <span className="flex-1">
              {t('Copy link to this page')}
              <span className="block text-[11px] text-muted">{t('Work and step only; changes don’t travel with the link')}</span>
            </span>
          </button>
          <button type="button" role="menuitem" data-more="inputs" className={menuItem} disabled={!actions.exportInputs} onClick={go(() => actions.exportInputs?.())}>
            <Icon n="download" size={15} />
            <span className="flex-1">
              {t('Export input log')}
              <span className="block text-[11px] text-muted">{t('Replay byte for byte with tryboard run --inputs')}</span>
            </span>
          </button>
          <button type="button" role="menuitem" data-more="brief" className={menuItem} disabled={!actions.brief} onClick={go(() => actions.brief?.())}>
            <Icon n="doc" size={15} />
            <span className="flex-1">
              {t('Task brief for AI')}
              <span className="block text-[11px] text-muted">{t('Goal, wiring and check command of the current checkpoint')}</span>
            </span>
          </button>
          {/* Real network (C-03): hidden on narrow desktops (≤ 1100px), so it enters from ⋯ there */}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={realnet}
            data-more="realnet"
            className={cn(menuItem, 'min-[1101px]:hidden')}
            onClick={go(toggleRealnet)}
          >
            <Icon n="link" size={15} />
            <span className="flex-1">
              {realnet ? t('Real network: on') : t('Real network: off')}
              <span className="block text-[11px] text-muted">{realnet ? t('Tap to go back to the virtual network') : t("The chip's HTTP requests really go out through the browser")}</span>
            </span>
          </button>
          {/* Firmware: narrow desktops (≤ 1100px) hide the top-bar menu, so it enters from ⋯ there */}
          <button
            type="button"
            role="menuitem"
            data-more="fw"
            data-fw-open=""
            className={cn(menuItem, 'min-[1101px]:hidden')}
            disabled={!actions.pickFirmware}
            onClick={go(openFwMenu)}
          >
            <Icon n="upload" size={15} />
            <span className="flex-1">
              {t('Change firmware')}
              <span className="block text-[11px] text-muted">{t('Examples, reference firmware or your own .bin')}</span>
            </span>
          </button>
          <div className="my-1 h-px bg-line" />
          <a role="menuitem" data-more="licenses" href={LICENSES} className={cn(menuItem, 'no-underline')}>
            <Icon n="doc" size={15} />
            <span className="flex-1">
              {t('Licenses and credits')}
              <span className="block text-[11px] text-muted">{t('Licenses of third-party components, firmware, fonts and 3D models')}</span>
            </span>
          </a>
          <p lang="en" className="m-0 px-2.5 pt-1 pb-1.5 text-[10.5px] leading-snug text-muted">
            ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.
          </p>
        </div>
      )}
    </div>
  );
}

/** Theme toggle: icon only (sun / moon) in the top bar, text in title */
function ThemeBtn() {
  const [dark, setDark] = useState(currentTheme() === 'dark');
  useEffect(() => {
    const off = onTheme((th) => setDark(th === 'dark'));
    return () => void off();
  }, []);
  const title = dark ? t('Switch to light') : t('Switch to dark');
  return (
    <button type="button" className={cn(ib, 'theme-btn')} title={title} aria-label={title} aria-pressed={dark} onClick={() => setTheme(dark ? 'light' : 'dark')}>
      <Icon n={dark ? 'moon' : 'sun'} />
    </button>
  );
}

export function TopBar(p: { step: StepId; workName: string; bare?: boolean; right: ReactNode; toast: (msg: string) => void }) {
  const { undo, redo } = useStore(bc);
  // Shop has its own BOM history too (U-14): undo / redo work on these two steps
  const bench = p.step === 'bench';
  const undoable = bench || p.step === 'shop';
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <header
      id="topbar"
      className={cn(
        'topbar fixed inset-x-0 top-0 z-4 flex h-(--top-h) items-center gap-2.5 border-b border-line bg-surface px-3',
      )}
    >
      <Breadcrumb name={p.workName} />
      <span aria-hidden="true" className="h-6 w-px flex-none bg-line" />
      <div className="flex flex-none items-center">
        <button type="button" id="undoBtn" className={ib} disabled={!undoable || !undo} title={undoable ? t('Undo ({key}): back one step on the timeline', { key: mac ? '⌘Z' : 'Ctrl Z' }) : t('Only Shop and Bench can undo')} aria-label={t('Undo')} onClick={() => actions.undo?.()}>
          <Icon n="undo" />
        </button>
        <button type="button" id="redoBtn" className={ib} disabled={!undoable || !redo} title={undoable ? t('Redo ({key})', { key: mac ? '⇧⌘Z' : 'Ctrl Shift Z' }) : t('Only Shop and Bench can redo')} aria-label={t('Redo')} onClick={() => actions.redo?.()}>
          <Icon n="redo" />
        </button>
      </div>
      {/* Container query: longer locales squeeze the step bar, so idle step labels drop before anything overlaps */}
      <div className="@container flex min-w-0 flex-1 justify-center-safe overflow-hidden">
        <StepBar step={p.step} />
      </div>
      <CmdkBox />
      {!p.bare && bench && <NetCondChip />}
      {!p.bare && bench && <RealnetSwitch />}
      {!p.bare && <RunGroup bench={bench} />}
      <FwMenu />
      {p.right}
      <MoreMenu toast={p.toast} />
      {/* Below 1500px the picker shrinks to its globe icon; the native list still names every language */}
      <LangSelect className="max-[1500px]:[&_select]:w-8 max-[1500px]:[&_select]:pr-0 max-[1500px]:[&_select]:text-transparent [&_option]:text-fg" />
      <ThemeBtn />
    </header>
  );
}
