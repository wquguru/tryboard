// Lab v2 top bar (DESIGN_V2 §3, §4): breadcrumb + work switch, saved state, undo / redo, steps, ⌘K, run state, firmware, ⋯ menu.
// Data comes from chrome.ts (bc); actions are registered by main.tsx / the bench and buttons grey out until they are.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { Logo } from '../ui/logo';
import { currentTheme, onTheme, setTheme } from '../theme';
import { actions, bc, BLANK, CUSTOM, EXAMPLE_ID, TWO_STEPS, shownSteps } from './chrome';
import { decode, encode } from '../advisor/state';
import { FwMenu, openFwMenu } from './fwmenu';
import { RealnetSwitch, toggleRealnet, useRealnet } from './realnet';
import { NetCondChip } from './netcond';
import { CmdkBox } from './cmdkview';
import { Icon } from './icons';
import { useStore } from './react';
import { savedText } from './saved';
import { STEPS, type StepId } from './types';
import { WORKS } from './works';
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
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** phone: work name centered in the phone top bar (≥ 44 tall, full-width menu) */
export function WorkMenu({ name, phone }: { name: string; phone?: boolean }) {
  const { open, setOpen, ref } = usePop();
  const cur = new URLSearchParams(location.search).get('work') ?? 'weather';
  return (
    <div ref={ref} className="relative min-w-0">
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
      {open && (
        <div role="menu" aria-label={t('Switch work')} id="workMenu" className={cn(menuPanel, 'left-0 max-h-[70vh] overflow-auto', phone && 'fixed top-12 right-2 left-2 [&_a]:min-h-11')}>
          {Object.values(WORKS).map((w) => (
            <a
              key={w.id}
              role="menuitemradio"
              aria-checked={w.id === cur}
              data-work={w.id}
              href={lab(w.id, (location.hash.slice(1) || 'bench') as StepId)}
              className={cn(menuItem, 'no-underline', w.id === cur && 'font-medium')}
            >
              <span className="inline-flex w-4 flex-none justify-center text-accent-ink">{w.id === cur && <Icon n="check" size={14} />}</span>
              <span className="min-w-0 flex-1 truncate">{w.title}</span>
              <span className="flex-none font-mono text-[11px] text-muted">{w.checkpoints.length ? t('{n} checkpoints', { n: w.checkpoints.length }) : t('Bench only')}</span>
            </a>
          ))}
        </div>
      )}
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

/** phone: the ⋯ on the right of the phone top bar (44 px button, wide menu, plus theme / language / firmware that don't fit there) */
export function MoreMenu({ toast, phone }: { toast: (msg: string) => void; phone?: boolean }) {
  const { open, setOpen, ref } = usePop();
  const [dark, setDark] = useState(currentTheme() === 'dark');
  const realnet = useRealnet();
  useEffect(() => {
    if (!phone) return;
    const off = onTheme((th) => setDark(th === 'dark'));
    return () => void off();
  }, [phone]);
  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="relative flex-none">
      <button type="button" id="moreBtn" className={cn(ib, phone && 'size-11')} aria-haspopup="menu" aria-expanded={open} aria-label={t('More: share, export input log, task brief for AI')} title={t('More')} onClick={() => setOpen(!open)}>
        <Icon n="more" />
      </button>
      {open && (
        <div role="menu" id="moreMenu" className={cn(menuPanel, 'right-0 w-[280px]', phone && 'fixed top-12 right-2 w-[min(300px,calc(100vw-16px))] [&_button]:min-h-11')}>
          <button
            type="button"
            role="menuitem"
            data-more="link"
            className={menuItem}
            onClick={go(() => {
              void navigator.clipboard?.writeText(location.href).then(
                () => toast(t('Link to this page copied (work and step only; your changes stay on this device)')),
                () => toast(t('Copy failed: the browser blocked clipboard access')),
              );
            })}
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
          {/* Real network (C-03): hidden on narrow desktops (≤ 1100px) and absent on phones, so both enter from ⋯ */}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={realnet}
            data-more="realnet"
            className={cn(menuItem, !phone && 'min-[1101px]:hidden')}
            onClick={go(toggleRealnet)}
          >
            <Icon n="link" size={15} />
            <span className="flex-1">
              {realnet ? t('Real network: on') : t('Real network: off')}
              <span className="block text-[11px] text-muted">{realnet ? t('Tap to go back to the virtual network') : t("The chip's HTTP requests really go out through the browser")}</span>
            </span>
          </button>
          {/* Firmware: no room on the phone bar, and narrow desktops (≤ 1100px) hide the top-bar menu, so both enter from ⋯ */}
          <button
            type="button"
            role="menuitem"
            id={phone ? 'swapFw' : undefined}
            data-more="fw"
            data-fw-open=""
            className={cn(menuItem, !phone && 'min-[1101px]:hidden')}
            disabled={!actions.pickFirmware}
            onClick={go(openFwMenu)}
          >
            <Icon n="upload" size={15} />
            <span className="flex-1">
              {t('Change firmware')}
              <span className="block text-[11px] text-muted">{t('Examples, reference firmware or your own .bin')}</span>
            </span>
          </button>
          {phone && (
            <>
              <button type="button" role="menuitem" data-more="theme" className={cn(menuItem, 'theme-btn')} aria-pressed={dark} onClick={go(() => setTheme(dark ? 'light' : 'dark'))}>
                <Icon n={dark ? 'moon' : 'sun'} size={15} />
                <span className="flex-1">{dark ? t('Switch to light') : t('Switch to dark')}</span>
              </button>
              <div role="none" data-more="lang" className="flex min-h-11 items-center gap-2 px-2.5 py-1">
                <span className="flex-1">{t('Language')}</span>
                <LangSelect className="min-w-[150px] [&_select]:w-full" />
              </div>
            </>
          )}
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
