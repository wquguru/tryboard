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
  | { kind: 'press'; what: 'boot'; n: number };

/** What was detected; raw values only, the words are made at render time in the current locale. */
export interface Hit {
  v?: string;
  from?: string;
}

/** `run` / `reveal` / `view:current` / `select:<id>` / `prop:<part>.<key>=<v>` / `chip:delay=<ms>` / `press:boot×<n>`; null = malformed. */
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
  return null;
}

/** Signals: 'run', 'press:boot', 'chip:delay=<ms>' (+ from), 'view:current', 'select:<id>', 'prop:<part>.<key>=<v>'. */
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
  }
}

/** Where "Take me there" points the camera: select / prop tasks only. */
export function taskTarget(done: string): LessonTarget | null {
  const d = parseDone(done);
  const sel = d?.kind === 'select' ? d.id : d?.kind === 'prop' ? d.part : null;
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
  'board@usb': t('the USB-C port'),
  'board@chip': t('the main chip'),
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
