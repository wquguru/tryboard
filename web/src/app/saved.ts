// Source of the top bar's "Saved locally · just now": steps note the time whenever they write work data to localStorage.
// The time itself is stored too, so after a reload it still shows the real last save, not the page-open time.
import { t } from '../i18n/index.ts';
import { bc, setBc } from './chrome';

const KEY = (work: string) => `tryboard-app-saved:${work}`;
let cur = '';

export function initSaved(work: string) {
  cur = work;
  let at: number | null = null;
  try {
    const v = Number(localStorage.getItem(KEY(work)));
    if (v > 0) at = v;
  } catch {
    /* private mode */
  }
  setBc({ saved: at });
  window.addEventListener('tb-saved', noteSaved);
}

export function noteSaved() {
  const at = Date.now();
  if (cur) {
    try {
      localStorage.setItem(KEY(cur), String(at));
    } catch {
      /* private mode: shown on this page only */
    }
  }
  if (bc.get().saved !== at) setBc({ saved: at });
}

/** "just now / 3 min ago / yesterday 14:05" */
export function savedText(at: number | null, now = Date.now()): string {
  if (at == null) return t('Not modified');
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return t('Saved locally · just now');
  if (s < 3600) return t('Saved locally · {n} min ago', { n: Math.round(s / 60) });
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now).toDateString() === d.toDateString();
  return today ? t('Saved locally · today {hm}', { hm }) : t('Saved locally · {m}/{d} {hm}', { m: d.getMonth() + 1, d: d.getDate(), hm });
}
