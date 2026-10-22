// Advisor v3 (DESIGN_V2 §8.2, docs/design-v2/select-v3). The page is UI only: derive.ts and brief.ts compute every answer,
// so one URL gives the same result everywhere. State goes through state.ts and is written back with replaceState, so the address bar is the share link.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Collapsible, Dialog, Popover, RadioGroup } from 'radix-ui';
import { PARTS, TEMPLATES, type Template } from './data.ts';
import { capName, type Confidence } from './engine.ts';
import { EMPTY, decode, encode, loadHave, saveHave, type Budget, type SelectState } from './state.ts';
import {
  BUDGETS,
  MORE_CAPS,
  TEMPLATE_ORDER,
  addable,
  answers,
  avgCurrent,
  boardShort,
  changeText,
  confCounts,
  exposedCount,
  kindName,
  lasts,
  lastsN,
  partName,
  partRows,
  pinFull,
  pinKind,
  pinName,
  relaxOptions,
  resolve,
  sanitize,
  simConf,
  sleepCurrent,
  trustRows,
  usedPins,
  yuan,
  type PartRow,
  type Result,
} from './derive.ts';
import { briefMarkdown, checkpointsOf } from './brief.ts';
import { PART_MAP, boardFor } from './catalogmap.ts';
import type { Plan } from './engine.ts';
import { Conf, ConfBar, ConfIcon, confLabel } from '../ui/conf';
import { SiteFooter, SiteHeader } from '../ui/site';
import { SELECT, SITE_NAV, customLab, lab, selectLink } from '../ui/links';
import { cn } from '../ui/cn';
import { t } from '../i18n/index.ts';

/** Translate a sentence whose {term} slot holds a JSX term button */
const tj = (en: string, term: ReactNode, vars?: Record<string, string | number>) => {
  const [a, b = ''] = t(en, { ...vars, term: '\u0000' }).split('\u0000');
  return (
    <>
      {a}
      {term}
      {b}
    </>
  );
};

/** < 768px uses the mobile layout (DESIGN_V2 §0). Only one layout renders, so ids stay unique and first-use terms stay right */
function useMobile() {
  const q = '(max-width: 767px)';
  const [m, setM] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return m;
}

// ---------------------------------------------------------------- project line art (DesA: 120×96, stroke 4, round caps; no emoji)
const TONE: Record<string, [string, string]> = {
  weather: ['#0B76C8', '#E5F4FF'],
  lights: ['#7A4BC9', '#F7F2FF'],
  usbkey: ['#B26A00', '#FFF6E5'],
  smarthome: ['#0E7A41', '#EAF7EF'],
};
const ART: Record<string, ReactNode> = {
  weather: (
    <>
      <rect x="14" y="20" width="60" height="40" rx="6" />
      <path d="M92 18v44" />
      <circle cx="92" cy="70" r="9" />
    </>
  ),
  lights: (
    <>
      <path d="M10 60c14-20 26-20 40 0s26 20 40 0" />
      <circle cx="38" cy="45" r="5" />
      <circle cx="74" cy="72" r="5" />
    </>
  ),
  usbkey: (
    <>
      <rect x="16" y="30" width="88" height="40" rx="8" />
      <rect x="30" y="42" width="16" height="16" rx="3" />
      <rect x="56" y="42" width="16" height="16" rx="3" />
    </>
  ),
  smarthome: (
    <>
      <path d="M20 50L60 18l40 32" />
      <path d="M32 42v36h56V42" />
      <path d="M52 78V58h16v20" />
    </>
  ),
  blink: (
    <>
      <circle cx="60" cy="40" r="20" />
      <path d="M50 66h20M53 76h14" />
    </>
  ),
  voice: (
    <>
      <rect x="48" y="12" width="24" height="44" rx="12" />
      <path d="M34 44a26 26 0 0 0 52 0M60 70v14" />
    </>
  ),
  camera: (
    <>
      <rect x="16" y="28" width="88" height="52" rx="8" />
      <circle cx="60" cy="54" r="15" />
      <path d="M42 28l6-10h24l6 10" />
    </>
  ),
  btaudio: (
    <>
      <path d="M22 40h16l22-18v52L38 56H22z" />
      <path d="M76 36a20 20 0 0 1 0 24M86 26a34 34 0 0 1 0 44" />
    </>
  ),
  more: <path d="M40 48h40M60 28v40" />,
};
function Art({ id, className }: { id: string; className?: string }) {
  const [ink, bg] = TONE[id] ?? ['#6F6F6F', '#F5F5F5'];
  return (
    <span className={cn('inline-flex flex-none items-center justify-center rounded-lg dark:!bg-field', className)} style={{ background: bg }}>
      <svg width="44" height="34" viewBox="0 0 120 96" fill="none" stroke={ink} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="dark:brightness-[1.7]">
        {ART[id]}
      </svg>
    </span>
  );
}

const Ico = ({ d, size = 16, className }: { d: string; size?: number; className?: string }) => (
  <svg className={cn('flex-none', className)} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const CHECK = 'M5 12.5l4.5 4.5L19 7';
const CHEV = 'M6 9l6 6 6-6';
const SHARE = 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1';

// ---------------------------------------------------------------- terms (FrA): only the first use on the page; what it is + what it means for you
// Keys are data-term attribute values that tests select on, so the two CJK ones stay; TERM_LABEL is what shows
type TermKey = 'GPIO' | 'I2C' | 'SPI' | 'PSRAM' | '深睡' | 'ADC' | 'PWM' | '原生 USB'; // lint: allow-cjk
const TERM_LABEL: Partial<Record<TermKey, string>> = { 深睡: 'Deep sleep', '原生 USB': 'Native USB' }; // lint: allow-cjk
const termLabel = (k: TermKey) => t(TERM_LABEL[k] ?? k);
const TERM_WHAT: Record<TermKey, string> = {
  GPIO: 'A pin whose use you define yourself.',
  I2C: 'Two wires for many sensors (SDA data, SCL clock, told apart by address).',
  SPI: 'A faster four-wire bus, common for displays.',
  PSRAM: 'Add-on memory that cameras / voice need.',
  深睡: 'Almost powered off, only a wake timer runs.', // lint: allow-cjk
  ADC: 'Reads a voltage as a number.',
  PWM: 'Fast switching to dim LEDs / drive servos.',
  '原生 USB': 'The board can act as a keyboard / flash drive.', // lint: allow-cjk
};
/** Display text of a confidence value (ui/conf.tsx owns the labels) */
const confText = (c: Confidence) => confLabel(c);

function termYou(k: TermKey, r: Result): string {
  const p = r.plan;
  if (!p) return '';
  const b = p.board;
  const byKind = (kind: string) => p.pins.filter((a) => pinKind(a.label, r.need.parts) === kind);
  const names = (kind: string) => r.need.parts.filter((id) => PARTS[id].needs.some((n) => n.kind === kind)).map(partName).join(t(', '));
  const pinsOf = (kind: string) => Array.from(new Set(byKind(kind).flatMap((a) => a.pins))).map((x) => pinName(b, x));
  switch (k) {
    case 'GPIO':
      return t('{board} has {n} usable GPIOs; your project uses {used}.', { board: boardShort(b), n: exposedCount(p), used: usedPins(p).length });
    case 'I2C': {
      const n = names('i2c');
      return n ? t('{parts} share the two wires {pins}; different addresses keep them apart.', { parts: n, pins: pinsOf('i2c').join(' / ') }) : t('Your project uses no I2C devices right now.');
    }
    case 'SPI':
      return names('spi') ? t('{parts} use SPI on {pins}.', { parts: names('spi'), pins: pinsOf('spi').join(' / ') }) : t('Your project uses no SPI right now.');
    case 'PSRAM':
      if (!b.psramMB) return t('{board} has no PSRAM, and your project does not need it.', { board: boardShort(b) });
      return r.need.caps.includes('psram') ? t('{board} has {mb} MB PSRAM; your project needs it for audio / images.', { board: boardShort(b), mb: b.psramMB }) : t('{board} has {mb} MB PSRAM; your project does not need it yet.', { board: boardShort(b), mb: b.psramMB });
    case '深睡': // lint: allow-cjk
      return answers(r.s).bat && p.power ? t('{board} sleeps at about {current} for the whole board, which is why the battery lasts {span}.', { board: boardShort(b), current: sleepCurrent(b.boardSleepUA), span: lasts(p.power.days) }) : t('You did not pick "Battery powered", so sleep current does not affect you.');
    case 'ADC':
      return names('adc') ? t('{parts} on {pins} (ADC1, readable with Wi-Fi on).', { parts: names('adc'), pins: pinsOf('adc').join(' / ') }) : t('Your project uses no ADC right now.');
    case 'PWM':
      return names('pwm') ? t('{parts} use PWM on {pins}.', { parts: names('pwm'), pins: pinsOf('pwm').join(' / ') }) : t('Your project uses no PWM right now.');
    case '原生 USB': // lint: allow-cjk
      return p.chip.caps.includes('usb_otg') ? t('{chip} has native USB: plug it into a computer and it is a keyboard.', { chip: t(p.chip.name) }) : t('{chip} has no native USB: serial only, no keyboard.', { chip: t(p.chip.name) });
  }
}

function Term({ k, you, mobile }: { k: TermKey; you: string; mobile: boolean }) {
  const trigger = (
    <button type="button" data-term={k} className="cursor-help border-0 border-b border-dashed border-current bg-transparent p-0 font-[inherit] text-[inherit] leading-[inherit] text-accent-ink">
      {termLabel(k)}
    </button>
  );
  const body = (
    <>
      <p className="font-bold">{t('{term}: {what}', { term: termLabel(k), what: t(TERM_WHAT[k]) })}</p>
      <p className="mt-1.5">{t('For your project: {you}', { you })}</p>
    </>
  );
  if (mobile)
    return (
      <Dialog.Root>
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content data-term-pop={k} aria-describedby={undefined} className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-line bg-surface px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] text-[15px] leading-[1.7] text-fg">
            <Dialog.Title className="sr-only">{termLabel(k)}</Dialog.Title>
            {body}
            <Dialog.Close className="mt-4 h-12 w-full cursor-pointer rounded-xl border border-line bg-surface text-[15px]">{t('Got it')}</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content data-term-pop={k} side="top" sideOffset={6} collisionPadding={12} className="z-50 w-[300px] rounded-[10px] border border-[#3a3a3a] bg-[#1E1E1E] p-3.5 text-[13px] leading-[1.6] text-white shadow-lg">
          {body}
          <Popover.Arrow className="fill-[#1E1E1E]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------- small pieces
const Lbl = ({ children, className, id }: { children: ReactNode; className?: string; id?: string }) => (
  <p id={id} className={cn('mb-2.5 text-[12px] font-bold tracking-[.06em] text-muted', className)}>
    {children}
  </p>
);

function Switch({ on, flip, q, label }: { on: boolean; flip: () => void; q: string; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} data-q={q} onClick={flip} className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 text-left text-[14px]">
      {label}
      <span className={cn('relative h-[22px] w-10 flex-none rounded-full transition-colors', on ? 'bg-accent' : 'bg-line')}>
        <span className={cn('absolute top-[3px] size-4 rounded-full bg-white shadow transition-[left]', on ? 'left-[21px]' : 'left-[3px]')} />
      </span>
    </button>
  );
}

const simText = (p: Plan) => (p.chip.simulated === 'full' ? t('Can run') : p.chip.simulated === 'partial' ? t('Partly runs') : t('Not yet · runs on a C3 instead'));

// ---------------------------------------------------------------- page
interface Step {
  prev: SelectState;
  text: string;
}

export function App() {
  const mobile = useMobile();
  const [s, setS] = useState<SelectState>(() => ({ ...sanitize(decode(location.search)), have: loadHave() }));
  const [hist, setHist] = useState<Step[]>([]);
  const [moreTpl, setMoreTpl] = useState(() => TEMPLATE_ORDER.indexOf(s.t || 'weather') >= 3);
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<'' | 'parts' | 'qs'>('');
  const [toast, setToast] = useState('');
  const r = useMemo(() => resolve(s), [s]);
  const md = useMemo(() => briefMarkdown(s), [s]);
  const a = answers(r.s);
  const p = r.plan;
  const share = selectLink(encode({ ...r.s, have: [] }, false));
  const go = p ? customLab(encode({ ...r.s, board: p.board.id, have: s.have }, true)) : '';

  // The URL is the share link: write it back on every change (without "I have it"); old ?t=weather round-trips
  useEffect(() => {
    const q = encode({ ...r.s, have: [] }, false);
    try {
      history.replaceState(null, '', q ? `?${q}` : location.pathname);
    } catch {
      /* Preview hosts may forbid changing the URL */
    }
  }, [r.s]);
  // For tests: the clipboard is unreliable headless, so the brief and state are exposed here
  useEffect(() => {
    (globalThis as unknown as { __tbSelect?: unknown }).__tbSelect = { state: r.s, have: s.have, brief: md, go, share };
  });
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  /** One step: record the "Just now" line (recommendation, pins, price change) for repeated undo; "I have it" stays out of the stack */
  const change = (label: string, f: (x: SelectState) => SelectState) => {
    const next = sanitize(f(r.s));
    if (encode(next) === encode(r.s)) return;
    setHist((h) => [...h, { prev: r.s, text: changeText(label, r, resolve(next)) }]);
    setS({ ...next, have: s.have });
  };
  const undo = () => {
    const top = hist[hist.length - 1];
    if (!top) return;
    setHist((h) => h.slice(0, -1));
    setS({ ...top.prev, have: s.have });
  };
  const toggleHave = (ids: string[]) => {
    const on = ids.every((id) => s.have.includes(id));
    const have = on ? s.have.filter((x) => !ids.includes(x)) : Array.from(new Set([...s.have, ...ids]));
    saveHave(have);
    setS({ ...s, have });
  };
  const copy = (text: string, done: string) => {
    const ok = () => setToast(done);
    try {
      navigator.clipboard.writeText(text).then(ok, () => setToast(t('The browser blocked copying; select the text by hand')));
    } catch {
      setToast(t('The browser blocked copying; select the text by hand'));
    }
  };
  const copyShare = () => copy(new URL(share, location.href).href, t('Share link copied'));
  const copyBrief = () => copy(md, t('Brief copied'));

  const pickTpl = (id: string) => {
    const tp = TEMPLATES.find((x) => x.id === id)!;
    change(t('Switched to "{project}"', { project: t(tp.short) }), (x) => ({ ...EMPTY, t: id, budget: x.budget }));
  };
  const flipRow = (row: PartRow) => {
    if (row.fixed) return;
    const n = partName(row.key);
    if (row.key === 'battery') return change(a.bat ? t('No battery') : t('Battery powered'), (x) => ({ ...x, bat: !a.bat }));
    if (r.tpl.parts.includes(row.key)) return change(row.on ? t('Removed {part}', { part: n }) : t('Put back {part}', { part: n }), (x) => ({ ...x, rm: row.on ? [...x.rm, row.key] : x.rm.filter((y) => y !== row.key) }));
    change(row.on ? t('Removed {part}', { part: n }) : t('Added {part}', { part: n }), (x) => ({ ...x, add: row.on ? x.add.filter((y) => y !== row.key) : [...x.add, row.key] }));
  };
  const addPart = (id: string) => {
    setAdding(false);
    change(t('Added {part}', { part: partName(id) }), (x) => ({ ...x, add: [...x.add, id] }));
  };
  const pickBoard = (id: string) => {
    if (!p || id === p.board.id) return;
    const b = r.plans.find((x) => x.board.id === id)!;
    change(t('Viewing {board}', { board: boardShort(b.board) }), (x) => ({ ...x, board: id === r.plans[0].board.id ? '' : id }));
  };

  // Terms are recomputed each render; JSX evaluation order is page order, so only the first use is underlined
  const seen = new Set<TermKey>();
  const T = (k: TermKey): ReactNode => {
    if (seen.has(k)) return termLabel(k);
    seen.add(k);
    return <Term key={`term-${k}`} k={k} you={termYou(k, r)} mobile={mobile} />;
  };

  // ------------------------------------------------ input: project
  const ordered = TEMPLATE_ORDER.map((id) => TEMPLATES.find((x) => x.id === id)!).filter(Boolean);
  const big = ordered.slice(0, 3);
  const rest = ordered.slice(3);
  const tplItem = (tp: Template, kind: 'big' | 'small' | 'pill') => {
    const on = tp.id === r.tpl.id;
    if (kind === 'pill')
      return (
        <RadioGroup.Item
          key={tp.id}
          value={tp.id}
          data-t={tp.id}
          className="tpl h-11 flex-none cursor-pointer rounded-full border border-line bg-surface px-4 text-[14px] whitespace-nowrap data-[state=checked]:border-fg data-[state=checked]:bg-fg data-[state=checked]:text-bg"
        >
          {t(tp.short)}
        </RadioGroup.Item>
      );
    return (
      <RadioGroup.Item
        key={tp.id}
        value={tp.id}
        data-t={tp.id}
        className={cn(
          'tpl flex cursor-pointer rounded-xl border border-line bg-surface text-left transition hover:border-hover-line',
          'data-[state=checked]:border-2 data-[state=checked]:border-accent data-[state=checked]:bg-accent-bg',
          kind === 'big' ? 'flex-col items-start gap-2 p-3 data-[state=checked]:p-[11px]' : 'min-h-11 items-center gap-2 px-3 py-1.5 data-[state=checked]:px-[11px] data-[state=checked]:py-[5px]',
        )}
      >
        {kind === 'big' && <Art id={tp.id} className="h-[42px] w-[54px]" />}
        <span className={cn('text-[14px]', on && 'font-bold')}>{t(tp.short)}</span>
        {kind === 'big' && <small className="text-[11px] leading-[1.4] text-muted">{tp.parts.map(partName).join(' · ')}</small>}
      </RadioGroup.Item>
    );
  };
  const projects = mobile ? (
    <RadioGroup.Root id="templates" aria-label={t('What do you want to build')} value={r.tpl.id} onValueChange={pickTpl} orientation="horizontal" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {ordered.map((x) => tplItem(x, 'pill'))}
    </RadioGroup.Root>
  ) : (
    <RadioGroup.Root id="templates" aria-labelledby="tpl-label" value={r.tpl.id} onValueChange={pickTpl}>
      <div className="grid grid-cols-4 gap-2">
        {big.map((x) => tplItem(x, 'big'))}
        <button
          type="button"
          id="moreTpl"
          aria-expanded={moreTpl}
          onClick={() => setMoreTpl(!moreTpl)}
          className="flex cursor-pointer flex-col items-start gap-2 rounded-xl border border-dashed border-hover-line bg-surface p-3 text-left text-[14px] text-muted hover:border-fg"
        >
          <Art id="more" className="h-[42px] w-[54px]" />
          {t('{n} more projects', { n: rest.length })}
          <small className="text-[11px]">{moreTpl ? t('Collapse') : rest.map((x) => t(x.short)).slice(0, 3).join(' · ') + '…'}</small>
        </button>
      </div>
      {moreTpl && <div className="mt-2 flex flex-wrap gap-2">{rest.map((x) => tplItem(x, 'small'))}</div>}
    </RadioGroup.Root>
  );

  // ------------------------------------------------ input: the parts are the list
  const rows = partRows(r);
  const rowEl = (row: PartRow) => {
    const have = row.haveIds.every((id) => s.have.includes(id));
    return (
      <li key={row.key} data-row={row.key} className="flex min-h-11 items-center gap-2.5 border-t border-line-soft px-3 py-1.5 first:border-t-0">
        <button
          type="button"
          role="checkbox"
          aria-checked={row.on}
          aria-disabled={row.fixed || undefined}
          aria-label={row.name}
          data-part={row.key}
          onClick={() => flipRow(row)}
          className={cn('-m-2 flex size-11 flex-none items-center justify-center md:size-8', row.fixed ? 'cursor-default' : 'cursor-pointer')}
        >
          <span
            className={cn(
              'flex size-4 items-center justify-center rounded-[4px]',
              row.on ? (row.fixed ? 'bg-muted text-bg' : 'bg-accent text-white') : 'border-[1.5px] border-dashed border-hover-line',
            )}
          >
            {row.on && <Ico d={CHECK} size={12} className="[stroke-width:3]" />}
          </span>
        </button>
        <span className="min-w-0 flex-1">
          <span className={cn('block text-[13px] leading-[1.35]', !row.on && 'text-muted', have && 'line-through decoration-muted')}>{row.name}</span>
          <small className="block text-[11px] text-muted">
            {row.src}
            {PART_MAP[row.key] === null && t(' · no model in TryBoard')}
          </small>
        </span>
        <span className="flex-none font-mono text-[11px] text-muted">{yuan(row.price)}</span>
        {row.on && (
          <button
            type="button"
            aria-pressed={have}
            data-have={row.key}
            onClick={() => toggleHave(row.haveIds)}
            className={cn('h-7 flex-none cursor-pointer rounded-full px-2.5 text-[11px] max-md:h-11 max-md:px-3 max-md:text-[12px]', have ? 'bg-line-soft text-fg' : 'border border-line text-muted')}
          >
            {have ? t('I have it') : t('Have it?')}
          </button>
        )}
      </li>
    );
  };
  const partsBox = (
    <div id="parts" className="overflow-hidden rounded-xl border border-line bg-surface">
      <p className="bg-field px-3 py-1.5 text-[12px] font-bold text-muted">{t('Needed · for {project}', { project: t(r.tpl.short) })}</p>
      <ul>{rows.filter((x) => x.group === 'need').map(rowEl)}</ul>
      <p className="bg-field px-3 py-1.5 text-[12px] font-bold text-muted">{t('Suggested')}</p>
      <ul>{rows.filter((x) => x.group === 'suggest').map(rowEl)}</ul>
      <div className="border-t border-line-soft">
        <button type="button" id="addPart" aria-expanded={adding} onClick={() => setAdding(!adding)} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-[13px] text-accent-ink">
          {t('+ Add part')}
        </button>
        {adding && (
          <ul id="partTable" className="border-t border-line-soft">
            {addable(r.s).map((id) => (
              <li key={id}>
                <button type="button" data-add={id} onClick={() => addPart(id)} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left text-[13px] hover:bg-field">
                  <span className="flex-1">{t(PARTS[id].name)}</span>
                  {PART_MAP[id] === null && <Conf c="必须上真机" size={12} // lint: allow-cjk
                   className="text-[11px] text-muted" />}
                  <span className="font-mono text-[11px] text-muted">{yuan(PARTS[id].priceCNY)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  // ------------------------------------------------ input: three plain questions + budget + more needs
  const questions = (
    <div id="questions">
      <Switch q="bat" label={t('Battery powered?')} on={a.bat} flip={() => change(a.bat ? t('No battery') : t('Battery powered'), (x) => ({ ...x, bat: !a.bat }))} />
      <Switch q="net" label={t('Needs a network (Wi-Fi / Bluetooth)?')} on={a.net} flip={() => change(a.net ? t('No network') : t('Needs a network'), (x) => ({ ...x, net: !a.net }))} />
      <Switch q="sim" label={t('Run it in TryBoard first?')} on={a.sim} flip={() => change(a.sim ? t('No need to run in TryBoard first') : t('Run in TryBoard first'), (x) => ({ ...x, sim: !a.sim }))} />
      <p id="budget-label" className="mt-3 mb-1.5 text-[14px]">
        {t('Budget')}
      </p>
      <div id="budget" role="radiogroup" aria-labelledby="budget-label" className="grid grid-cols-4 gap-0.5 rounded-[10px] bg-field p-[3px] text-[13px]">
        {BUDGETS.map((b) => (
          <button
            key={b}
            type="button"
            role="radio"
            aria-checked={r.s.budget === b}
            data-budget={b}
            onClick={() => change(b ? t('Budget ¥{budget}', { budget: b }) : t('No budget limit'), (x) => ({ ...x, budget: b as Budget }))}
            className={cn('h-9 cursor-pointer rounded-lg max-md:h-11', r.s.budget === b ? 'bg-fg font-bold text-bg' : 'text-fg')}
          >
            {b ? `¥${b}` : t('Any')}
          </button>
        ))}
      </div>
      <Collapsible.Root defaultOpen={r.s.req.length > 0} className="mt-3">
        <Collapsible.Trigger id="moreReq" className="group flex min-h-11 w-full cursor-pointer items-center justify-between text-left text-[13px] text-muted">
          {t('More needs (Thread, Classic Bluetooth, PSRAM, native USB…)')}
          <span className="flex items-center gap-1">
            {r.s.req.length > 0 && <b className="text-accent-ink">{r.s.req.length}</b>}
            <Ico d={CHEV} className="transition-transform group-data-[state=open]:rotate-180" />
          </span>
        </Collapsible.Trigger>
        <Collapsible.Content className="flex flex-wrap gap-1.5 pb-1">
          {MORE_CAPS.map((c) => {
            const on = r.s.req.includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                data-cap={c}
                onClick={() => change(on ? t('No {cap}', { cap: capName(c) }) : t('Needs {cap}', { cap: capName(c) }), (x) => ({ ...x, req: on ? x.req.filter((y) => y !== c) : [...x.req, c] }))}
                className={cn('inline-flex h-8 cursor-pointer items-center gap-1 rounded-full border px-3 text-[12px] max-md:h-11', on ? 'border-fg bg-fg text-bg' : 'border-line bg-surface')}
              >
                {on && <Ico d={CHECK} size={12} />}
                {capName(c)}
              </button>
            );
          })}
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  );

  // ------------------------------------------------ result: just now
  const top = hist[hist.length - 1];
  const recent = top && (
    <div id="recent" role="status" className="flex items-center gap-3 rounded-[10px] bg-accent-bg px-3.5 py-2.5 text-[13px] text-accent-ink">
      <span className="min-w-0 flex-1">
        <b>{t('Just now: ')}</b>
        <span id="recentText">{top.text}</span>
      </span>
      <button type="button" id="undo" onClick={undo} className="h-8 flex-none cursor-pointer rounded-lg border border-accent-line bg-surface px-3 text-[13px] text-accent-ink max-md:h-11">
        {hist.length > 1 ? t('Undo ({n})', { n: hist.length }) : t('Undo')}
      </button>
    </div>
  );

  // ------------------------------------------------ result: zero boards (FrC)
  const none = !p && (
    <section id="none" className="rounded-[14px] border-2 border-line bg-surface p-5">
      <h2 className="text-[18px] font-bold">{t('No board meets all {n} conditions', { n: r.need.caps.length + (r.s.budget ? 1 : 0) + (a.bat ? 1 : 0) })}</h2>
      {(() => {
        const opts = relaxOptions(r);
        return opts.length ? (
          <>
            <p className="mt-2 text-[14px] text-muted">{t('Drop one of them and there are boards:')}</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {opts.map((o) => (
                <li key={o.label}>
                  <button type="button" data-relax={o.label} onClick={() => change(o.label, () => o.next)} className="flex min-h-11 w-full cursor-pointer items-center justify-between rounded-lg border border-line px-3.5 text-left text-[14px] hover:border-accent">
                    {t('{label} → {n} boards', { label: o.label, n: o.n })}
                    <Ico d="M9 6l6 6-6 6" className="text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-2 text-[14px] text-muted">{t('No Espressif chip can do all of these together; try another project.')}</p>
        );
      })()}
    </section>
  );

  // ------------------------------------------------ result: answer first
  const sub = p ? boardFor(p.board.id).sub : undefined;
  const reason = (pl: Plan): ReactNode => {
    if (r.s.board && r.plans[0] !== pl) return <>{t('You picked it in the comparison; the top recommendation is {board}.', { board: r.plans[0].board.name })}</>;
    const cheapest = [...r.plans].sort((x, y) => x.total[0] - y.total[0])[0] === pl;
    if (a.bat && pl.power)
      return (
        tj(pl.board.battery ? 'Picked for battery power: low whole-board current in {term}, with on-board Li-ion charging.' : 'Picked for battery power: low whole-board current in {term}.', T('深睡')) // lint: allow-cjk
      );
    if (r.need.caps.includes('usb_otg'))
      return tj(cheapest ? 'The chip has {term}: plug it into a computer and it is a keyboard; also the cheapest board that can.' : 'The chip has {term}: plug it into a computer and it is a keyboard.', T('原生 USB')); // lint: allow-cjk
    const tail = [cheapest ? t('the cheapest of them') : '', pl.chip.simulated !== 'none' ? t('you can run your firmware in TryBoard before buying') : ''].filter(Boolean);
    return <>{tail.length ? t('Meets all your conditions; {more}.', { more: tail.join(t('; ')) }) : t('Meets all your conditions.')}</>;
  };
  const stat = (k: string, v: ReactNode, c: Confidence, id: string) => (
    <div data-stat={id}>
      <p className="text-[12px] text-muted">{k}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[24px] leading-tight font-bold max-md:text-[20px]">
        {v}
        <span title={confText(c)} className="text-fg">
          <ConfIcon c={c} size={14} />
        </span>
      </p>
    </div>
  );
  const answer = p && (
    <section id="answer" className="rounded-[14px] border-2 border-accent bg-surface p-5 max-md:p-4">
      <p className="text-[12px] font-bold tracking-[.06em] text-accent-ink">{t('Buy this')}</p>
      <h2 id="boardName" className="mt-1 text-[30px] leading-tight font-bold max-md:text-[24px]">
        {p.board.name}
      </h2>
      <p className="mt-0.5 text-[13px] text-muted">
        {t(p.chip.name)} · {t(p.board.maker)}
        {r.s.board && t(' · your pick from the comparison')}
      </p>
      <div className="mt-4 grid grid-cols-3 gap-4 max-md:gap-2">
        {stat(t('Kit reference price'), yuan(p.total), '估算', 'price')}{/* lint: allow-cjk */}
        {p.power ? stat(t('Battery life'), lastsN(p.power.days), p.power.confidence, 'life') : stat(t('Battery life'), t('Mains powered'), '估算', 'life')}{/* lint: allow-cjk */}
        {stat(t('Runs firmware'), p.chip.simulated === 'none' ? t('Not yet') : p.chip.simulated === 'full' ? t('Yes') : t('Partly'), simConf(p), 'sim')}
      </div>
      <p id="reason" className="mt-4 text-[14px] leading-[1.7]">
        {reason(p)}
        {sub && <span className="text-muted">{t(' ({note})', { note: sub })}</span>}
      </p>
    </section>
  );

  // ------------------------------------------------ result: why this one (DESIGN_V2 §9)
  // Number + sentence + small line; yes / no uses a tag, price gap has no sign, total battery life stays on the answer card.
  type Why = { big?: ReactNode; chip?: string; t: ReactNode; d?: ReactNode; c: Confidence; tone?: 'warn' | 'ok' };
  const num = (v: ReactNode, unit?: string) => (
    <>
      {v}
      {unit && <small> {unit}</small>}
    </>
  );
  const whyRows = (pl: Plan): Why[] => {
    const out: Why[] = [];
    const kinds = new Set(pl.pins.map((x) => pinKind(x.label, r.need.parts)));
    const n = r.need.parts.length;
    const used = usedPins(pl).length;
    const cheap = [...r.plans].sort((x, y) => x.total[0] - y.total[0])[0];
    const more = a.bat && pl.power && cheap.power && cheap !== pl ? Math.round(pl.power.days - cheap.power.days) : 0;
    if (pl.pinProblems.length) out.push({ chip: t('Short'), tone: 'warn', t: t('Not enough pins'), d: pl.pinProblems.join(t('; ')), c: '估算' }); // lint: allow-cjk
    else {
      const how = [
        kinds.has('i2c') && tj('sensors and display share the two {term} wires', T('I2C')),
        kinds.has('spi') && tj('color display on {term}', T('SPI')),
        kinds.has('pwm') && tj('enough {term} pins', T('PWM')),
        kinds.has('adc') && tj('potentiometer on {term}', T('ADC')),
      ].filter(Boolean);
      out.push({
        big: num(exposedCount(pl) - used, t('left')),
        t: t('Enough pins, with this many to spare'),
        d: (
          <>
            {tj('{n} parts use {used} {term}', T('GPIO'), { n, used })}
            {how.map((x, i) => (
              <span key={i}>
                {t('; ')}
                {x}
              </span>
            ))}
          </>
        ),
        c: '估算', // lint: allow-cjk
      });
    }
    if (a.bat && pl.power) {
      const sleep = sleepCurrent(pl.board.boardSleepUA).split(' ');
      out.push(
        more >= 1
          ? { big: num(`+${more}`, t('days')), t: t('Lasts {n} days longer than the cheapest option', { n: more }), d: tj('{term}: board about {current}, average {avg}', T('深睡'), { current: sleepCurrent(pl.board.boardSleepUA), avg: avgCurrent(pl.power.avgMA) }), c: pl.power.confidence } // lint: allow-cjk
          : { big: num(sleep[0], sleep[1]), t: tj('{term}: whole-board current', T('深睡')), d: <>{t('Average {avg}; battery life is on the card above', { avg: avgCurrent(pl.power.avgMA) })}</>, c: pl.power.confidence }, // lint: allow-cjk
      );
    }
    if (r.need.caps.includes('usb_otg')) out.push({ chip: t('Yes'), tone: 'ok', t: t('Plug into a computer and it is a keyboard or flash drive'), d: tj('The chip has {term}', T('原生 USB')), c: simConf(pl) }); // lint: allow-cjk
    if (r.need.caps.includes('psram')) out.push({ big: num(pl.board.psramMB, 'MB'), t: t('Room for audio and images'), d: tj('On-board {term}', T('PSRAM')), c: '估算' }); // lint: allow-cjk
    const noModel = r.need.parts.filter((id) => PART_MAP[id] === null).map(partName);
    if (pl.chip.simulated === 'none') out.push({ chip: t('Stand-in'), tone: 'warn', t: t('Runs on an ESP32-C3 in TryBoard for now'), d: t('{chip} cannot be simulated yet; treat results as a reference', { chip: t(pl.chip.name) }), c: '必须上真机' }); // lint: allow-cjk
    else out.push({ chip: t('Can run'), tone: 'ok', t: t('Run your firmware in TryBoard before you buy'), d: pl.chip.simulated === 'partial' ? t('{chip}: some peripherals are behaviour models', { chip: t(pl.chip.name) }) : t('{chip}: the web page and the real board run the same firmware', { chip: t(pl.chip.name) }), c: simConf(pl) });
    if (noModel.length) out.push({ chip: t('Real board'), tone: 'warn', t: t('This part needs a real board'), d: t('No model in TryBoard for {parts}', { parts: noModel.join(t(', ')) }), c: '必须上真机' }); // lint: allow-cjk
    if (cheap === pl) out.push({ chip: t('Cheapest'), tone: 'ok', t: t('Cheapest of the {n} boards that qualify', { n: r.plans.length }), c: '估算' }); // lint: allow-cjk
    else {
      // When it costs more, say what that buys: extra days, else which capability
      const gain = more >= 1 ? t('buys the {n} extra days of battery above', { n: more }) : pl.board.battery && !cheap.board.battery ? t('buys on-board Li-ion charging') : t('buys steadier wiring and more headroom');
      out.push({ big: `¥${Math.round(pl.total[0] - cheap.total[0])}`, t: t('More than the cheapest option'), d: t('{gain}; compared with {board}', { gain, board: boardShort(cheap.board) }), c: '估算' }); // lint: allow-cjk
    }
    return out.slice(0, 4);
  };
  const trust = p ? trustRows(p, r.need) : [];
  const why = p && (
    <section id="why" className="rounded-[14px] border border-line bg-surface p-5 max-md:p-4">
      <div className="flex items-center justify-between gap-4 max-md:flex-col max-md:items-start">
        <h3 className="text-[16px] font-bold">{t('Why this one')}</h3>
        <ConfBar counts={confCounts(trust)} className="w-[200px] text-fg" />
      </div>
      <ul className="mt-2 border-t border-line-soft">
        {whyRows(p).map((w, i) => (
          <li key={i} className="grid min-h-16 grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-4 border-b border-line-soft py-3 last:border-b-0 max-md:grid-cols-[64px_minmax(0,1fr)_auto] max-md:gap-3">
            {w.big !== undefined ? (
              <span className="text-right text-[28px] leading-9 font-bold whitespace-nowrap text-fg tabular-nums max-md:text-[22px] max-md:leading-7 [&_small]:text-[13px] [&_small]:font-medium [&_small]:text-muted">{w.big}</span>
            ) : (
              <span className={cn('inline-flex h-6 items-center justify-self-end rounded-md px-2 text-xs font-semibold whitespace-nowrap', w.tone === 'warn' ? 'bg-warn-bg text-warn-ink' : 'bg-ok-bg text-ok-ink')}>{w.chip}</span>
            )}
            <span className="min-w-0">
              <span className="block text-[15px] leading-[22px] font-medium">{w.t}</span>
              {w.d && <span className="mt-0.5 block text-[13px] leading-5 text-muted">{w.d}</span>}
            </span>
            <Conf c={w.c} size={14} className="justify-self-end text-xs whitespace-nowrap text-fg" />
          </li>
        ))}
      </ul>
      <p className="mt-3 mb-0 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[10px] bg-field px-3 py-2 text-xs text-muted">
        <span className="font-medium">{t('Confidence')}</span>
        {(['仿真验证', '行为模拟', '估算', '必须上真机'] as Confidence[]).map((c) => ( // lint: allow-cjk
          <Conf key={c} c={c} size={12} className="text-fg" />
        ))}
      </p>
    </section>
  );

  // ------------------------------------------------ result: all details
  const details = p && (
    <Collapsible.Root className="rounded-[14px] border border-line bg-surface">
      <Collapsible.Trigger id="detailsBtn" className="group flex min-h-12 w-full gap-3 cursor-pointer items-center justify-between px-5 text-left text-[14px] max-md:px-4">
        <span>
          <b>{t('All details')}</b>
          <span className="text-muted">{t(' (pin table, power breakdown, real board only, basis)')}</span>
        </span>
        <span className="flex flex-none items-center gap-1 whitespace-nowrap text-[13px] text-muted">
          <span className="group-data-[state=open]:hidden">{t('Expand')}</span>
          <span className="hidden group-data-[state=open]:inline">{t('Collapse')}</span>
          <Ico d={CHEV} className="transition-transform group-data-[state=open]:rotate-180" />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content id="details" className="border-t border-line-soft px-5 pt-4 pb-5 text-[13px] max-md:px-4">
        <h4 className="mb-2 font-bold">{t('Pin table')}</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-muted">
              <tr>
                <th className="py-1 pr-3 font-normal">{t('Use')}</th>
                <th className="py-1 pr-3 font-normal">{t('Interface')}</th>
                <th className="py-1 pr-3 font-normal">{t('Pins')}</th>
              </tr>
            </thead>
            <tbody>
              {p.pins.map((x) => {
                const k = pinKind(x.label, r.need.parts);
                const term = (['I2C', 'SPI', 'PWM', 'ADC', 'GPIO'] as string[]).includes(kindName(k)) ? T(kindName(k) as TermKey) : t(kindName(k));
                return (
                  <tr key={x.label} className="border-t border-line-soft">
                    <td className="py-1.5 pr-3">{t(x.label.split(' (')[0])}</td>
                    <td className="py-1.5 pr-3">{term}</td>
                    <td className="py-1.5 pr-3 font-mono text-[12px]">{x.pins.map((n) => pinFull(p.board, n)).join(' / ') || x.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {p.pinProblems.length > 0 && <p className="mt-2 text-bad-ink">{p.pinProblems.join(t('; '))}</p>}
        {p.power && (
          <>
            <h4 className="mt-4 mb-2 flex items-center gap-2 font-bold">
              {t('Power breakdown')} <Conf c={p.power.confidence} size={12} className="text-[11px] font-normal text-muted" />
            </h4>
            <p className="leading-[1.7] text-muted">
              {t('Average {avg}; a 1000 mAh battery lasts {span}. ', { avg: avgCurrent(p.power.avgMA), span: lasts(p.power.days) })}
              {p.power.breakdown}
            </p>
          </>
        )}
        <h4 className="mt-4 mb-2 font-bold">{t('Real board only')}</h4>
        <ul className="flex flex-col gap-1.5">
          {trust
            .filter(([, c]) => c === '必须上真机') // lint: allow-cjk
            .map(([x]) => (
              <li key={x} className="flex gap-2">
                <ConfIcon c="必须上真机" size={13} className="mt-[3px]" /> {/* lint: allow-cjk */}
                {x}
              </li>
            ))}
          {[...r.tpl.risks.map((x) => t(x)), ...p.warnings].map((x) => (
            <li key={x} className="flex gap-2 text-muted">
              <span className="mt-[9px] size-1 flex-none rounded-full bg-muted" />
              {x}
            </li>
          ))}
        </ul>
        <h4 className="mt-4 mb-2 font-bold">{t('Basis')}</h4>
        <ul className="flex flex-col gap-1">
          {trust.map(([x, c]) => (
            <li key={x} className="flex items-center justify-between gap-3 border-t border-line-soft py-1 first:border-t-0">
              <span>{x}</span>
              <Conf c={c} size={12} className="flex-none text-[12px] text-muted" />
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] leading-[1.7] text-muted">
          {t('Data comes from Espressif datasheets and board makers\' public docs; prices are common shop ranges, check when buying. Power uses datasheet typical values; real numbers vary with board build, signal strength and firmware.')}{' '}
          {t('Checkpoints TryBoard generates from the parts: {list}.', { list: checkpointsOf(r).map((c) => c.name).join(t(', ')) })}
        </p>
      </Collapsible.Content>
    </Collapsible.Root>
  );

  // ------------------------------------------------ result: three-board comparison
  const trio = p && !r.trio.some((x) => x.p === p) ? [...r.trio.slice(0, 2), { p, tag: t('Your pick') }] : r.trio;
  // The last row (in TryBoard) is greyed out for unsimulated chips, matched by index
  const cmpRows: [string, (x: Plan) => ReactNode][] = [
    [t('Reference price'), (x) => yuan(x.total)],
    [t('Battery life (estimate)'), (x) => (x.power ? lasts(x.power.days) : t('Mains powered'))],
    [t('Deep sleep'), (x) => sleepCurrent(x.board.boardSleepUA)],
    [t('In TryBoard'), (x) => simText(x)],
  ];
  const tryExamples = r.tpl.examples.length > 0 && (
    <section id="examples" data-testid="tpl-examples">
      <h3 className="mb-2.5 text-[16px] font-bold">{t('Examples you can run in the simulator first')}</h3>
      <div className="flex flex-wrap gap-2">
        {r.tpl.examples.map((id) => (
          <a key={id} href={lab('blank', 'bench', { example: id })} data-example={id} className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 font-mono text-[13px] hover:border-fg">
            {id}
          </a>
        ))}
      </div>
    </section>
  );
  const compare = p && trio.length > 1 && (
    <section id="compare">
      <h3 className="mb-2.5 text-[16px] font-bold">{mobile ? t('Three-board comparison · swipe') : t('Three-board comparison')}</h3>
      <div className={cn(mobile ? '-mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-1' : 'grid grid-cols-3 gap-3')}>
        {trio.map(({ p: x, tag }) => {
          const on = x === p;
          return (
            <button
              key={x.board.id}
              type="button"
              data-board={x.board.id}
              aria-pressed={on}
              onClick={() => pickBoard(x.board.id)}
              className={cn(
                'flex cursor-pointer flex-col rounded-xl border bg-surface p-4 text-left',
                mobile && 'w-[300px] flex-none snap-start',
                on ? 'border-2 border-accent p-[15px]' : 'border-line hover:border-hover-line',
              )}
            >
              <span className="text-[11px] font-bold tracking-[.06em] text-muted">{tag}</span>
              <span className="mt-0.5 text-[15px] font-bold">{boardShort(x.board)}</span>
              <dl className="mt-2.5 grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                {cmpRows.map(([k, f], i) => (
                  <div key={k} className="contents">
                    <dt className="text-muted">{k}</dt>
                    <dd className={cn('text-right', i === cmpRows.length - 1 && x.chip.simulated === 'none' && 'text-muted')}>{f(x)}</dd>
                  </div>
                ))}
              </dl>
            </button>
          );
        })}
      </div>
    </section>
  );

  // ------------------------------------------------ result: brief
  const brief = p && (
    <section id="briefBox" className="rounded-[14px] border border-line bg-surface p-5 max-md:p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[16px] font-bold">{t('Brief')}</h3>
        <button type="button" id="copyBrief" onClick={copyBrief} className="h-9 cursor-pointer rounded-lg border border-line px-3 text-[13px] max-md:h-11">
          {t('Copy the brief')}
        </button>
      </div>
      <p className="mt-1 text-[12px] text-muted">{t('Paste it into a coding AI or follow it yourself; the acceptance section is what TryBoard checks.')}</p>
      <pre id="briefText" className="mt-3 max-h-[320px] overflow-auto rounded-lg bg-field p-3 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap">
        {md}
      </pre>
    </section>
  );

  // ------------------------------------------------ next step
  const goBtn = (cls: string) =>
    p && (
      <a id="go" href={go} className={cn('flex flex-col items-center justify-center rounded-xl bg-accent-strong text-on-accent hover:opacity-90', cls)}>
        <span className="text-[16px] font-bold">{t('Start building with this →')}</span>
        <span className="text-[12px] opacity-90">{t('Go to shopping, list filled in')}</span>
      </a>
    );
  const next = p && (
    <aside className="flex w-[300px] flex-none flex-col gap-2">
      {goBtn('h-14')}
      <button type="button" id="share" onClick={copyShare} className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line bg-surface text-[14px]">
        <Ico d={SHARE} /> {t('Copy share link')}
      </button>
      <button type="button" onClick={copyBrief} className="h-10 cursor-pointer rounded-lg border border-line bg-surface text-[14px]">
        {t('Copy the brief')}
      </button>
      {r.tpl.work && (
        <a href={lab(r.tpl.work, 'shop')} className="mt-1 text-center text-[13px] text-accent-ink hover:underline">
          {t('See the ready-made "{project}" project', { project: t(r.tpl.short) })}
        </a>
      )}
      <p className="mt-1 text-[12px] leading-[1.6] text-muted">{t('Parts marked "I have it" are flagged in shopping so you do not buy them twice.')}</p>
    </aside>
  );

  const toastEl = toast && (
    <p id="toast" role="status" className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-fg px-4 py-2 text-[13px] text-bg shadow-lg max-md:bottom-[88px]">
      {toast}
    </p>
  );

  // ------------------------------------------------ mobile (SelectCMobile)
  if (mobile) {
    const summaryParts = [...r.need.parts.map(partName), ...(a.bat ? [t('Li-ion battery')] : []), t('Cables')].join(' · ');
    const summaryQs = [a.bat ? t('Battery') : t('Mains'), a.net ? t('Wi-Fi on') : t('No network'), r.s.budget ? t('Budget ¥{budget}', { budget: r.s.budget }) : t('No budget limit')].join(' · ');
    const sumRow = (k: 'parts' | 'qs', text: string) => (
      <button type="button" data-edit={k} aria-expanded={edit === k} onClick={() => setEdit(edit === k ? '' : k)} className="flex min-h-12 w-full cursor-pointer items-center gap-3 border-t border-line-soft px-4 text-left text-[14px] first:border-t-0">
        <span className="min-w-0 flex-1 truncate">{text}</span>
        <span className="text-accent-ink">{edit === k ? t('Collapse') : t('Edit')}</span>
      </button>
    );
    return (
      <div className="flex min-h-screen flex-col pb-[84px]">
        <SiteHeader current={SELECT} subtitle={t('Board advisor')} links={SITE_NAV} />
        <main className="flex flex-1 flex-col gap-3 px-4 pt-4 pb-6">
          <h1 className="text-[22px] font-bold">{t('Board advisor')}</h1>
          {projects}
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            {sumRow('parts', summaryParts)}
            {edit === 'parts' && <div className="border-t border-line-soft p-2">{partsBox}</div>}
            {sumRow('qs', summaryQs)}
            {edit === 'qs' && <div className="border-t border-line-soft px-4 pb-3">{questions}</div>}
          </div>
          {recent}
          {none}
          {answer}
          {why}
          {tryExamples}
          {compare}
          {details}
          {brief}
          {r.tpl.work && (
            <a href={lab(r.tpl.work, 'shop')} className="flex min-h-11 items-center text-[14px] text-accent-ink">
              {t('See the ready-made "{project}" project', { project: t(r.tpl.short) })}
            </a>
          )}
        </main>
        <SiteFooter />
        {p && (
          <div id="mobileBar" className="fixed inset-x-0 bottom-0 z-[6] flex gap-2 border-t border-line-soft bg-bg px-4 pt-2.5 pb-[max(12px,env(safe-area-inset-bottom))]">
            {goBtn('h-12 flex-1')}
            <button type="button" id="share" aria-label={t('Copy share link')} onClick={copyShare} className="flex size-12 flex-none cursor-pointer items-center justify-center rounded-xl border border-line bg-surface">
              <Ico d={SHARE} size={20} />
            </button>
          </div>
        )}
        {toastEl}
      </div>
    );
  }

  // ------------------------------------------------ desktop (Rec)
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader current={SELECT} subtitle={t('Board advisor')} links={SITE_NAV} />
      <main className="grid flex-1 grid-cols-[500px_1fr] max-lg:grid-cols-[420px_1fr]">
        <section aria-label={t('Your project')} className="border-r border-line-soft bg-field/40 px-[26px] py-6">
          <h1 className="text-[22px] font-bold">{t('Board advisor')}</h1>
          <p className="mt-1 mb-5 text-[13px] text-muted">{t('Pick a project, tick parts, answer three questions; the right side tells you which board to buy.')}</p>
          <Lbl id="tpl-label">{t('What do you want to build')}</Lbl>
          {projects}
          <Lbl className="mt-6">{t('Parts (this is the list)')}</Lbl>
          {partsBox}
          <Lbl className="mt-6">{t('Three questions')}</Lbl>
          {questions}
        </section>
        <section aria-label={t('Recommendation')} aria-live="polite" className="flex min-w-0 flex-col gap-4 px-8 py-6 max-lg:px-5">
          {recent}
          {none}
          {p && (
            <div className="flex gap-4 max-xl:flex-col">
              <div className="min-w-0 flex-1">{answer}</div>
              {next}
            </div>
          )}
          {why}
          {details}
          {tryExamples}
          {compare}
          {brief}
        </section>
      </main>
      <SiteFooter />
      {toastEl}
    </div>
  );
}
