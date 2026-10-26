// Course layer (PLAN H-15, DESIGN_V2 §11.2): the 12 basic lessons in order, each pointing at a work + optional checkpoint.
// Lesson numbers are independent of checkpoint ids; this list is the only source of lesson order (DECISIONS 2026-10-26).
import { t } from '../i18n/index.ts';
import { lessonFor, type Lesson } from './lessons.ts';

export interface CourseEntry {
  /** "Lesson N" (0-based like the design). */
  no: number;
  /** Shown for planned lessons; written ones show their Lesson.title. */
  title: string;
  /** The part this lesson adds. */
  part: string;
  /** Thumbnail tag and colour (content art, same in both themes). */
  tag: string;
  color: string;
  /** The work (WORKS id) whose bench hosts this lesson. */
  work: string;
  /** Checkpoint id in that work; absent = no checkpoint, done when every "Try it" task is ticked (lessonKey). */
  cp?: string;
  /** "Bench" row of the cross-work notice: what the bench shows for this lesson. */
  bench: string;
  /** The lesson runs no firmware (lesson 0). */
  noFw?: boolean;
}

export const COURSE: CourseEntry[] = [
  { no: 0, title: t('Meet the dev board'), part: t('The ESP32-S3 itself'), tag: 'S3', color: '#23272D', work: 'basics', bench: t('Just the dev board'), noFw: true },
  { no: 1, title: t('Light up an LED'), part: 'LED + 220 Ω', tag: 'LED', color: '#E5484D', work: 'weather', cp: '01', bench: t('Dev board + breadboard + LED') },
  { no: 2, title: t('Press to light up'), part: t('BOOT button'), tag: 'BTN', color: '#3B4148', work: 'weather', cp: '02', bench: t('Dev board + breadboard + LED') },
  { no: 3, title: t('Write on a small screen'), part: 'SSD1306 OLED', tag: 'OLED', color: '#1F5FD1', work: 'weather', cp: '03', bench: t('Dev board + breadboard + LED + OLED') },
  { no: 4, title: t('Breathing light'), part: t('PWM brightness'), tag: 'PWM', color: '#E07A1F', work: 'basics', cp: 'basics-pwm', bench: t('Dev board + breadboard + LED') },
  { no: 5, title: t('Colour LED strip'), part: 'WS2812', tag: 'RGB', color: '#8E4EC6', work: 'lamp', cp: 'lamp-1', bench: t('Dev board + WS2812 LED strip') },
  { no: 6, title: t('Make a sound'), part: t('Passive buzzer'), tag: 'BUZ', color: '#5E646C', work: 'basics', cp: 'basics-buzz', bench: t('Dev board + breadboard + passive buzzer') },
  { no: 7, title: t('Turn a servo'), part: t('SG90 servo'), tag: 'SERVO', color: '#2B6CB0', work: 'weather', cp: '05', bench: t('Dev board + breadboard + SG90 servo') },
  { no: 8, title: t('Read temperature and humidity'), part: 'BME280', tag: 'BME', color: '#17805A', work: 'weather', cp: '04', bench: t('Dev board + breadboard + BME280') },
  { no: 9, title: t('Turn a knob'), part: t('Potentiometer · ADC'), tag: 'ADC', color: '#B5651B', work: 'lamp', cp: 'lamp-2', bench: t('Dev board + LED strip + potentiometer') },
  { no: 10, title: t('Build a USB keyboard'), part: 'USB HID', tag: 'USB', color: '#1E2227', work: 'usbkey', cp: 'usbkey-2', bench: t('Dev board + keys, USB to a virtual PC') },
  { no: 11, title: t('Capstone: desk weather station'), part: t('Everything so far'), tag: 'ALL', color: '#146B4B', work: 'weather', cp: '06', bench: t('Every part of the weather station') },
];

/** The key a lesson is filed under (Lesson.checkpoint, step and task storage): the checkpoint, or `lesson-<no>` without one. */
export const lessonKey = (e: CourseEntry) => e.cp ?? `lesson-${e.no}`;

/** The written lesson behind an entry, or null while it is planned. */
export const courseLesson = (e: CourseEntry): Lesson | null => lessonFor(e.work, lessonKey(e));

/** The entry a lesson belongs to (null for a lesson outside the course). */
export function courseOf(l: Pick<Lesson, 'work' | 'checkpoint'> | null): CourseEntry | null {
  return (l && COURSE.find((e) => e.work === l.work && lessonKey(e) === l.checkpoint)) ?? null;
}

/** The nearest written lesson before (-1) or after (+1) lesson `no`, skipping planned ones. */
export function courseStep(no: number, dir: 1 | -1, find: (e: CourseEntry) => Lesson | null = courseLesson): CourseEntry | null {
  for (let i = no + dir; i >= 0 && i < COURSE.length; i += dir) if (find(COURSE[i])) return COURSE[i];
  return null;
}

/** Ticked tasks of one step (index → anything truthy); lessontasks.ts `stepHits` in the app. */
export type HitsOf = (work: string, key: string, step: number) => Record<number, unknown>;

/** A lesson without a checkpoint is done once every task of every step is ticked (a lesson with no tasks never is). */
export function tasksDone(l: Lesson, hitsOf: HitsOf): boolean {
  let n = 0;
  for (let s = 0; s < l.steps.length; s++) {
    const hits = hitsOf(l.work, l.checkpoint, s);
    for (let i = 0; i < l.steps[s].tasks.length; i++, n++) if (!hits[i]) return false;
  }
  return n > 0;
}

/** Done rule of an entry: its checkpoint passes, or (no checkpoint) all its tasks are ticked. */
export function entryDone(e: CourseEntry, l: Lesson, passed: (work: string, cp: string) => boolean, hitsOf: HitsOf): boolean {
  return e.cp ? passed(e.work, e.cp) : tasksDone(l, hitsOf);
}

export type CourseState = 'done' | 'current' | 'ready' | 'plan';
export interface CourseCard {
  entry: CourseEntry;
  lesson: Lesson | null;
  state: CourseState;
  /** 1-based step shown in "In progress · x/n" (same rule as LessonHead). */
  step: number;
  total: number;
}

/** Map state of one entry: done = entryDone; current = open now or started; ready = written; else planned. */
export function courseCard(
  e: CourseEntry,
  passed: (work: string, cp: string) => boolean,
  stepOf: (work: string, key: string) => number,
  open: { work: string; cp: string; step: number } | null,
  hitsOf: HitsOf = () => ({}),
): CourseCard {
  const lesson = courseLesson(e);
  if (!lesson) return { entry: e, lesson: null, state: 'plan', step: 0, total: 0 };
  const total = lesson.steps.length;
  const here = open?.work === lesson.work && open.cp === lesson.checkpoint;
  const s = here ? open!.step : stepOf(lesson.work, lesson.checkpoint);
  const step = Math.min(s + 1, total);
  if (entryDone(e, lesson, passed, hitsOf)) return { entry: e, lesson, state: 'done', step, total };
  return { entry: e, lesson, state: here || s > 0 ? 'current' : 'ready', step, total };
}
