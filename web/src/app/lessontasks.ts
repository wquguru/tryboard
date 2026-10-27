// "Try it" auto-ticks (PLAN H-10): bench actions arrive as signal strings through `lessonSignal`, are matched against the
// current step's tasks and kept per work + checkpoint + step on this machine. No React here: session.ts imports it.
import { t } from '../i18n/index.ts';
import { createStore } from './store.ts';
import { isLessonFw, type Lesson, type LessonTarget, type LessonTask } from './lessons.ts';

/** A parsed `LessonTask.done`. */
export type DoneSpec =
  | { kind: 'run' }
  | { kind: 'reveal' }
  | { kind: 'view'; what: 'current' }
  | { kind: 'select'; id: string }
  | { kind: 'prop'; part: string; key: string; v: string }
  | { kind: 'chip'; key: 'delay'; v: number }
  | { kind: 'press'; what: 'boot'; n: number }
  | { kind: 'strip'; pin: number; n: number }
  | { kind: 'usb'; what: 'configured' }
  | { kind: 'usb'; what: 'typed'; text: string }
  | { kind: 'env'; key: EnvKey }
  | { kind: 'adc'; pin: number; op: '<' | '>'; n: number }
  | { kind: 'oled'; n: number }
  | { kind: 'follow'; what: 'temp' }
  | { kind: 'asm' };

export type EnvKey = 'temp' | 'humidity' | 'pressure';

/** What was detected; raw values only, the words are made at render time in the current locale. */
export interface Hit {
  v?: string;
  from?: string;
}

/** `run` / `reveal` / `view:current` / `select:<id>` / `prop:<part>.<key>=<v>` / `chip:delay=<ms>` / `press:boot×<n>` / `strip:<pin>=<n lit>` / `usb:configured` / `usb:typed=<text>` / `env:<key>` / `adc:<pin><raw` or `>raw` /
 *  `oled:<n lit>` / `follow:temp` (a reading matches a temperature changed on this step) / `asm:done` (every part in the case, no warnings); null = malformed. */
export function parseDone(d: string): DoneSpec | null {
  if (d === 'run' || d === 'reveal') return { kind: d };
  if (d === 'view:current') return { kind: 'view', what: 'current' };
  let m = /^select:(.+)$/.exec(d);
  if (m) return { kind: 'select', id: m[1] };
  // Part ids may hold colons ('led:5'), so the key is the last dotted word before '='
  m = /^prop:(.+)\.(\w+)=(.+)$/.exec(d);
  if (m) return { kind: 'prop', part: m[1], key: m[2], v: m[3] };
  m = /^chip:delay=(\d+)$/.exec(d);
  if (m) return { kind: 'chip', key: 'delay', v: Number(m[1]) };
  m = /^press:boot[×x](\d+)$/.exec(d);
  if (m && Number(m[1]) >= 1) return { kind: 'press', what: 'boot', n: Number(m[1]) };
  m = /^strip:(\d+)=(\d+)$/.exec(d);
  if (m && Number(m[2]) >= 1) return { kind: 'strip', pin: Number(m[1]), n: Number(m[2]) };
  if (d === 'usb:configured') return { kind: 'usb', what: 'configured' };
  m = /^usb:typed=(.+)$/s.exec(d);
  if (m) return { kind: 'usb', what: 'typed', text: m[1] };
  m = /^env:(temp|humidity|pressure)$/.exec(d);
  if (m) return { kind: 'env', key: m[1] as EnvKey };
  m = /^adc:(\d+)([<>])(\d+)$/.exec(d);
  if (m) return { kind: 'adc', pin: Number(m[1]), op: m[2] as '<' | '>', n: Number(m[3]) };
  m = /^oled:(\d+)$/.exec(d);
  if (m && Number(m[1]) >= 1) return { kind: 'oled', n: Number(m[1]) };
  if (d === 'follow:temp') return { kind: 'follow', what: 'temp' };
  if (d === 'asm:done') return { kind: 'asm' };
  return null;
}

/** Signals: 'run', 'press:boot', 'chip:delay=<ms>' (+ from), 'view:current', 'select:<id>', 'prop:<part>.<key>=<v>', 'strip:<pin>=<lit>', 'usb:configured', 'usb:typed=<all text>', 'env:<key>=<v>' (+ from), 'adc:<pin>=<raw>',
 *  'oled:<lit>', 'reading:temp=<°C>', 'asm:done=clean|warn'. */
export interface SigCtx {
  /** BOOT presses (down edges) since this step came up, this one included. */
  boots: number;
  /** Temperature changes since this step came up (follow:temp only ticks after one). */
  envs?: number;
  /** Value before a chip / prop change. */
  from?: string;
}

/** Does signal `sig` complete a task whose `done` is `done`? Returns what was detected, or null. */
export function matchTask(done: string, sig: string, ctx: SigCtx): Hit | null {
  const d = parseDone(done);
  if (!d) return null;
  switch (d.kind) {
    case 'run':
      return sig === 'run' ? {} : null;
    case 'reveal':
      return null;
    case 'view':
      return sig === 'view:current' ? {} : null;
    case 'select':
      return sig === `select:${d.id}` ? { v: d.id } : null;
    case 'press':
      return sig === 'press:boot' && ctx.boots >= d.n ? { v: String(ctx.boots) } : null;
    case 'chip':
      return sig === `chip:delay=${d.v}` ? { v: String(d.v), from: ctx.from } : null;
    case 'prop':
      return sig === `prop:${d.part}.${d.key}=${d.v}` ? { v: d.v, from: ctx.from } : null;
    case 'strip': {
      // At least n LEDs lit in a frame on that pin (the strip lights up one by one, so "all lit" is reached last)
      const m = /^strip:(\d+)=(\d+)$/.exec(sig);
      return m && Number(m[1]) === d.pin && Number(m[2]) >= d.n ? { v: m[2] } : null;
    }
    case 'usb': {
      if (d.what === 'configured') return sig === 'usb:configured' ? {} : null;
      // The PC's text so far contains the wanted letters (the learner may press other keys in between)
      const m = /^usb:typed=(.*)$/s.exec(sig);
      return m && m[1].includes(d.text) ? { v: d.text } : null;
    }
    case 'env': {
      // Any real change of that environment value (slider gesture, number box, preset)
      const m = /^env:(\w+)=(.+)$/.exec(sig);
      return m && m[1] === d.key && m[2] !== ctx.from ? { v: m[2], from: ctx.from } : null;
    }
    case 'adc': {
      // The raw code the firmware last read on that pin, past the threshold
      const m = /^adc:(\d+)=(\d+)$/.exec(sig);
      if (!m || Number(m[1]) !== d.pin) return null;
      const raw = Number(m[2]);
      return (d.op === '<' ? raw < d.n : raw > d.n) ? { v: m[2] } : null;
    }
    case 'oled': {
      const m = /^oled:(\d+)$/.exec(sig);
      return m && Number(m[1]) >= d.n ? { v: m[1] } : null;
    }
    case 'follow': {
      // A reading line that matches the room only counts once the learner has moved the temperature on this step
      const m = /^reading:temp=(-?[\d.]+)$/.exec(sig);
      return m && (ctx.envs ?? 0) >= 1 ? { v: m[1] } : null;
    }
    case 'asm': {
      // H-21: warnings stay on screen as the lesson point, but only a clean case ticks
      return sig === 'asm:done=clean' ? { v: 'clean' } : null;
    }
  }
}

/** Where "Take me there" points the camera: select / prop tasks only. */
export function taskTarget(done: string): LessonTarget | null {
  const d = parseDone(done);
  // The BME280 quick card holds the temperature and humidity sliders; pressure lives under Environment only
  const env = d?.kind === 'env' && d.key !== 'pressure' ? 'bme280' : null;
  const sel = d?.kind === 'select' ? d.id : d?.kind === 'prop' ? d.part : env;
  if (!sel) return null;
  // 'board@usb': a spot on a part (lesson 0); the camera goes to the part, the callout anchor marks the spot
  const [id, spot] = sel.split('@');
  if (spot === 'usb') return { kind: 'part', id, anchor: 'usb' };
  if (id === 'BOOT' || id === 'RST') return { kind: 'button', id };
  if (/^(GPIO\d+|3V3|5V|GND)$/.test(id)) return { kind: 'pin', id };
  return { kind: 'part', id };
}

const PART_NAMES: Record<string, string> = {
  board: t('the dev board'),
  'led:5': t('the LED'),
  oled: t('the OLED screen'),
  ws2812: t('the LED strip'),
  bme280: t('the BME280 sensor'),
  pot: t('the potentiometer'),
  servo: t('the servo'),
  buzzer: t('the buzzer'),
  'board@usb': t('the USB-C port'),
  'board@chip': t('the main chip'),
  'key:4': t('button K1'),
  'key:5': t('button K2'),
  'key:6': t('button K3'),
};

/** "Detected: …" line for a ticked task; empty for reveal (its answer is the result). */
export function hitText(done: string, h: Hit): string {
  const d = parseDone(done);
  switch (d?.kind) {
    case 'run':
      return t("Detected: this lesson's code is running");
    case 'view':
      return t('Detected: "Show current" is on');
    case 'select':
      return t('Detected: you clicked {what}', { what: PART_NAMES[d.id] ?? d.id });
    case 'press':
      return t('Detected: BOOT pressed {n} times', { n: h.v ?? d.n });
    case 'strip':
      return t('Detected: {n} LEDs lit on GPIO{pin}', { n: h.v ?? d.n, pin: d.pin });
    case 'usb':
      return d.what === 'configured' ? t('Detected: the PC sees a USB keyboard') : t('Detected: the PC typed "{text}"', { text: h.v ?? d.text });
    case 'adc':
      return t('Detected: GPIO{pin} reads {raw}', { pin: d.pin, raw: h.v ?? d.n });
    case 'oled':
      return t('Detected: {n} dots lit on the screen', { n: h.v ?? d.n });
    case 'follow':
      return t('Detected: the reading followed to {v} °C', { v: h.v ?? '' });
    case 'asm':
      return t('Detected: every part is in the case, no warnings');
    case 'chip':
      return h.from && h.from !== h.v
        ? t('Detected: delay {from} ms → {to} ms', { from: h.from, to: h.v ?? d.v })
        : t('Detected: delay {to} ms', { to: h.v ?? d.v });
    case 'env': {
      const what = { temp: t('temperature'), humidity: t('humidity'), pressure: t('pressure') }[d.key];
      const u = (v: string) => (d.key === 'temp' ? `${v} °C` : d.key === 'humidity' ? `${v} %` : `${(Number(v) / 100).toFixed(1)} hPa`);
      return h.from !== undefined && h.v !== undefined ? t('Detected: {what} {from} → {to}', { what, from: u(h.from), to: u(h.v) }) : t('Detected: {what} changed', { what });
    }
    case 'prop':
      return h.from && h.from !== h.v
        ? t('Detected: {key} {from} → {to}', { key: d.key, from: h.from, to: h.v ?? d.v })
        : t('Detected: {key} = {to}', { key: d.key, to: h.v ?? d.v });
    default:
      return '';
  }
}

// Storage: { [checkpoint]: { [step]: { [task]: Hit } } } under one key per work (step progress has its own key)
const KEY = 'tryboard-app-lesson-tasks:';
type Saved = Record<string, Record<string, Record<string, Hit>>>;
const mem: Record<string, Saved> = {};
function load(work: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY + work) ?? '{}') as Saved;
  } catch {
    return mem[work] ?? {};
  }
}
function save(work: string, v: Saved) {
  mem[work] = v;
  try {
    localStorage.setItem(KEY + work, JSON.stringify(v));
  } catch {
    /* Storage blocked: this page's memory copy. */
  }
}
/** Ticked tasks of one step (index → hit), as stored on this machine. */
export function stepHits(work: string, cp: string, step: number): Record<number, Hit> {
  return (load(work)[cp]?.[step] ?? {}) as Record<number, Hit>;
}

export interface TaskUi {
  lesson: Lesson | null;
  step: number;
  hits: Record<number, Hit>;
  /** The task ticked last, for the one-off flash (cleared on step change). */
  fresh: number | null;
  /** Reveal tasks opened on this step. */
  open: Record<number, boolean>;
  /** H-21: every part is in the case but with warnings, so the asm task says why it has not ticked. */
  asmWarn: boolean;
  /** "Take me there": the bench eases the camera to a target and outlines it (bench/lesson.tsx installs it). */
  goTo: (tg: LessonTarget) => void;
}
export const taskUi = createStore<TaskUi>({ lesson: null, step: 0, hits: {}, fresh: null, open: {}, asmWarn: false, goTo: () => {} });
let boots = 0;
let envs = 0;

/** The bench's lesson / step changed (bench/lesson.tsx): load that step's ticks, restart the BOOT count. */
export function setTaskStep(lesson: Lesson | null, step: number) {
  const cur = taskUi.get();
  if (cur.lesson === lesson && cur.step === step) return;
  boots = 0;
  envs = 0;
  taskUi.set({ lesson, step, hits: lesson ? stepHits(lesson.work, lesson.checkpoint, step) : {}, fresh: null, open: {}, asmWarn: false });
}

function tick(i: number, h: Hit) {
  const { lesson, step, hits } = taskUi.get();
  if (!lesson) return;
  const all = load(lesson.work);
  ((all[lesson.checkpoint] ??= {})[step] ??= {})[i] = h;
  save(lesson.work, all);
  taskUi.set({ hits: { ...hits, [i]: h }, fresh: i });
}

/** The one entry for bench actions; `from` = value before a chip / prop change. */
export function lessonSignal(sig: string, from?: string) {
  const { lesson, step, hits } = taskUi.get();
  if (sig === 'press:boot') boots++;
  // Lesson 11 counts any temperature change: session.ts sends 'env:temp', the BME280 card 'env:temp=<v>'
  if (/^env:temp(=|$)/.test(sig)) envs++;
  const warn = sig === 'asm:done=warn';
  if (sig.startsWith('asm:done=') && taskUi.get().asmWarn !== warn) taskUi.set({ asmWarn: warn });
  const tasks: LessonTask[] = lesson?.steps[step]?.tasks ?? [];
  tasks.forEach((task, i) => {
    if (hits[i]) return;
    const h = matchTask(task.done, sig, { boots, envs, from });
    if (h) tick(i, h);
  });
}

/** Open (or fold) a "Think" task's answer; opening it the first time ticks it. */
export function revealTask(i: number) {
  const { open, hits } = taskUi.get();
  const on = !open[i];
  taskUi.set({ open: { ...open, [i]: on } });
  if (on && !hits[i]) tick(i, {});
}

/** Every task of the current step ticked. */
export function stepReady(s: TaskUi = taskUi.get()): boolean {
  const tasks = s.lesson?.steps[s.step]?.tasks ?? [];
  return tasks.length > 0 && tasks.every((_, i) => !!s.hits[i]);
}

/** The running build is the current lesson's firmware (or one of its code-chip builds). */
export function lessonFw(fwName: string): boolean {
  return isLessonFw(taskUi.get().lesson, fwName);
}

/** WS2812 frames (pin → [r, g, b] per LED) as 'strip:<pin>=<lit>' signals, only while the lesson's own firmware runs. */
export function stripSignals(strips: Record<number, number[][]>, fwName: string) {
  if (!lessonFw(fwName)) return;
  for (const [pin, leds] of Object.entries(strips)) lessonSignal(`strip:${pin}=${leds.filter((c) => c.some((v) => v > 0)).length}`);
}

/** Virtual PC state as 'usb:configured' / 'usb:typed=<text>' signals, only while the lesson's own firmware runs. */
export function usbSignals(v: { configured: boolean; typed: string } | null, fwName: string) {
  if (!v || !lessonFw(fwName)) return;
  if (v.configured) lessonSignal('usb:configured');
  if (v.typed) lessonSignal(`usb:typed=${v.typed}`);

}

/** ADC samples the firmware read (worker tick `adc`, pin → raw codes) as 'adc:<pin>=<latest raw>', lesson firmware only. */
export function adcSignals(adc: Record<number, { raw: number[] }>, fwName: string) {
  if (!lessonFw(fwName)) return;
  for (const [pin, a] of Object.entries(adc)) if (a.raw.length) lessonSignal(`adc:${pin}=${a.raw[a.raw.length - 1]}`);
}

/** OLED frame (128 × 64 bytes, non-zero = lit) as 'oled:<lit>', only while the lesson's own firmware runs. */
export function oledSignal(px: Uint8Array | null, fwName: string) {
  if (!px || !taskUi.get().lesson || !lessonFw(fwName)) return;
  let n = 0;
  for (const v of px) if (v) n++;
  lessonSignal(`oled:${n}`);
}

/** A serial reading of the lesson's own firmware that sits within 0.25 °C of the room (half a slider step): 'reading:temp=<°C>'. */
export function readingSignal(rd: { t: number } | null, room: number, fwName: string) {
  if (!rd || Math.abs(rd.t - room) > 0.25 || !taskUi.get().lesson || !lessonFw(fwName)) return;
  lessonSignal(`reading:temp=${rd.t.toFixed(2)}`);
}
