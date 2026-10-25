// Course map data (PLAN H-12, DESIGN_V2 §11.1): the 12 basic lessons, one new part each, and their map state.
// Stop-gap table: H-15 replaces COURSE with the real course layer; written lessons point at a work + checkpoint (lessonFor).
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
  /** Written lessons only: where lessonFor finds them. */
  work?: string;
  cp?: string;
}

export const COURSE: CourseEntry[] = [
  { no: 0, title: t('Meet the dev board'), part: t('The ESP32-S3 itself'), tag: 'S3', color: '#23272D' },
  { no: 1, title: t('Light up an LED'), part: 'LED + 220 Ω', tag: 'LED', color: '#E5484D', work: 'weather', cp: '01' },
  { no: 2, title: t('Press to light up'), part: t('BOOT button'), tag: 'BTN', color: '#3B4148', work: 'weather', cp: '02' },
  { no: 3, title: t('Write on a small screen'), part: 'SSD1306 OLED', tag: 'OLED', color: '#1F5FD1', work: 'weather', cp: '03' },
  { no: 4, title: t('Breathing light'), part: t('PWM brightness'), tag: 'PWM', color: '#E07A1F' },
  { no: 5, title: t('Colour LED strip'), part: 'WS2812', tag: 'RGB', color: '#8E4EC6' },
  { no: 6, title: t('Make a sound'), part: t('Passive buzzer'), tag: 'BUZ', color: '#5E646C' },
  { no: 7, title: t('Turn a servo'), part: t('SG90 servo'), tag: 'SERVO', color: '#2B6CB0' },
  { no: 8, title: t('Read temperature and humidity'), part: 'BME280', tag: 'BME', color: '#17805A' },
  { no: 9, title: t('Turn a knob'), part: t('Potentiometer · ADC'), tag: 'ADC', color: '#B5651B' },
  { no: 10, title: t('Build a USB keyboard'), part: 'USB HID', tag: 'USB', color: '#1E2227' },
  { no: 11, title: t('Capstone: desk weather station'), part: t('Everything so far'), tag: 'ALL', color: '#146B4B' },
];

export type CourseState = 'done' | 'current' | 'ready' | 'plan';
export interface CourseCard {
  entry: CourseEntry;
  lesson: Lesson | null;
  state: CourseState;
  /** 1-based step shown in "In progress · x/n" (same rule as LessonHead). */
  step: number;
  total: number;
}

/** Map state of one entry: done = its checkpoint passed; current = open now or started; ready = written; else planned. */
export function courseCard(
  e: CourseEntry,
  passed: (work: string, cp: string) => boolean,
  stepOf: (work: string, cp: string) => number,
  open: { work: string; cp: string; step: number } | null,
): CourseCard {
  const lesson = e.work && e.cp ? lessonFor(e.work, e.cp) : null;
  if (!lesson) return { entry: e, lesson: null, state: 'plan', step: 0, total: 0 };
  const total = lesson.steps.length;
  const here = open?.work === lesson.work && open.cp === lesson.checkpoint;
  const s = here ? open!.step : stepOf(lesson.work, lesson.checkpoint);
  const step = Math.min(s + 1, total);
  if (passed(lesson.work, lesson.checkpoint)) return { entry: e, lesson, state: 'done', step, total };
  return { entry: e, lesson, state: here || s > 0 ? 'current' : 'ready', step, total };
}
