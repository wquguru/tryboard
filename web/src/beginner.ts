// Beginner mode (PLAN H-01): the bench shows lesson steps, a step card and a short toolbar instead of the full tool set.
// New visitors get it on; `?beginner=0|1` overrides for this visit (tests pin it off), the switch writes localStorage.
const KEY = 'tb-beginner';
const LESSON_KEY = 'tryboard-app-lesson:';
let override: boolean | null = null;
const listeners = new Set<(on: boolean) => void>();
const stepListeners = new Set<() => void>();

/** Beginner mode on? URL override first, then the stored choice; default on (DESIGN_V2 §11). */
export function beginnerOn(): boolean {
  if (override !== null) return override;
  if (typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search).get('beginner');
    if (q === '0' || q === '1') return q === '1';
  }
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}
export function setBeginner(on: boolean) {
  override = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* Private mode: this page only. */
  }
  listeners.forEach((f) => f(on));
}
export function onBeginner(f: (on: boolean) => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}

const mem: Record<string, Record<string, number>> = {};
/** Current lesson step (0-based) per work and checkpoint, kept on this machine. */
export function lessonStep(work: string, cp: string): number {
  let v: Record<string, number> = mem[work] ?? {};
  try {
    v = JSON.parse(localStorage.getItem(LESSON_KEY + work) ?? '{}') as Record<string, number>;
  } catch {
    /* Storage blocked: this page's memory copy. */
  }
  return Number.isInteger(v[cp]) ? v[cp] : 0;
}
export function setLessonStep(work: string, cp: string, step: number) {
  try {
    const v = JSON.parse(localStorage.getItem(LESSON_KEY + work) ?? '{}') as Record<string, number>;
    v[cp] = step;
    localStorage.setItem(LESSON_KEY + work, JSON.stringify(v));
  } catch {
    (mem[work] ??= {})[cp] = step;
  }
  stepListeners.forEach((f) => f());
}
export function onLessonStep(f: () => void) {
  stepListeners.add(f);
  return () => void stepListeners.delete(f);
}

if (typeof window !== 'undefined') (window as unknown as { __tbBeginner: unknown }).__tbBeginner = { on: beginnerOn, set: setBeginner, step: lessonStep };
