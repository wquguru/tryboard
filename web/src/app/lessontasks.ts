// "Try it" auto-ticks (PLAN H-10): bench actions arrive as signal strings through `lessonSignal`, are matched against the
// current step's tasks and kept per work + checkpoint + step on this machine. No React here: session.ts imports it.
import { t } from '../i18n/index.ts';
import { createStore } from './store.ts';
import type { Lesson, LessonTarget, LessonTask } from './lessons.ts';

/** A parsed `LessonTask.done`. */
export type DoneSpec =
  | { kind: 'run' }
  | { kind: 'reveal' }
  | { kind: 'view'; what: 'current' }
  | { kind: 'select'; id: string }
  | { kind: 'prop'; part: string; key: string; v: string }
  | { kind: 'chip'; key: 'delay'; v: number }
  | { kind: 'press'; what: 'boot'; n: number }
  | { kind: 'strip'; pin: number; n: number };

/** What was detected; raw values only, the words are made at render time in the current locale. */
export interface Hit {
  v?: string;
  from?: string;
}

/** `run` / `reveal` / `view:current` / `select:<id>` / `prop:<part>.<key>=<v>` / `chip:delay=<ms>` / `press:boot×<n>` / `strip:<pin>=<n lit>`; null = malformed. */
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
  return null;
}

/** Signals: 'run', 'press:boot', 'chip:delay=<ms>' (+ from), 'view:current', 'select:<id>', 'prop:<part>.<key>=<v>', 'strip:<pin>=<lit>'. */
export interface SigCtx {
  /** BOOT presses (down edges) since this step came up, this one included. */
  boots: number;
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
  }
}

/** Where "Take me there" points the camera: select / prop tasks only. */
export function taskTarget(done: string): LessonTarget | null {
  const d = parseDone(done);
  const id = d?.kind === 'select' ? d.id : d?.kind === 'prop' ? d.part : null;
  if (!id) return null;
  if (id === 'BOOT' || id === 'RST') return { kind: 'button', id };
  if (/^GPIO\d+$/.test(id)) return { kind: 'pin', id };
  return { kind: 'part', id };
}

const PART_NAMES: Record<string, string> = {
  board: t('the dev board'),
  'led:5': t('the LED'),
  oled: t('the OLED screen'),
  ws2812: t('the LED strip'),
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
    case 'chip':
      return h.from && h.from !== h.v
        ? t('Detected: delay {from} ms → {to} ms', { from: h.from, to: h.v ?? d.v })
        : t('Detected: delay {to} ms', { to: h.v ?? d.v });
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
  /** "Take me there": the bench eases the camera to a target and outlines it (bench/lesson.tsx installs it). */
  goTo: (tg: LessonTarget) => void;
}
export const taskUi = createStore<TaskUi>({ lesson: null, step: 0, hits: {}, fresh: null, open: {}, goTo: () => {} });
let boots = 0;

/** The bench's lesson / step changed (bench/lesson.tsx): load that step's ticks, restart the BOOT count. */
export function setTaskStep(lesson: Lesson | null, step: number) {
  const cur = taskUi.get();
  if (cur.lesson === lesson && cur.step === step) return;
  boots = 0;
  taskUi.set({ lesson, step, hits: lesson ? stepHits(lesson.work, lesson.checkpoint, step) : {}, fresh: null, open: {} });
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
  const tasks: LessonTask[] = lesson?.steps[step]?.tasks ?? [];
  tasks.forEach((task, i) => {
    if (hits[i]) return;
    const h = matchTask(task.done, sig, { boots, from });
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

/** WS2812 frames (pin → [r, g, b] per LED) as 'strip:<pin>=<lit>' signals; session.ts calls it per new frame. */
export function stripSignals(strips: Record<number, number[][]>) {
  for (const [pin, leds] of Object.entries(strips)) lessonSignal(`strip:${pin}=${leds.filter((c) => c.some((v) => v > 0)).length}`);
}
