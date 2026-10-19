// Dark mode (DESIGN §2): follows prefers-color-scheme until the user toggles, then localStorage wins.
// An inline script in each page <head> sets data-theme before first paint to avoid a white flash.

export type Theme = 'light' | 'dark';

const KEY = 'tb-theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

const subs = new Set<(t: Theme) => void>();

function apply(t: Theme) {
  if (document.documentElement.dataset.theme === t) return;
  document.documentElement.dataset.theme = t;
  for (const f of subs) f(t);
}

/** Called when the theme changes (toggle or system); returns an unsubscribe function. */
export function onTheme(f: (t: Theme) => void) {
  subs.add(f);
  return () => subs.delete(f);
}

/** User toggle: persisted. */
export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Private mode cannot store: applies to this page only.
  }
  apply(t);
}

export type ThemePref = Theme | 'system';

/** Current preference: the user's explicit choice, else 'system' (for the phone drawer switch). */
export const themePref = (): ThemePref => stored() ?? 'system';

/** Three-way switch: 'system' clears storage and follows the OS again. */
export function setThemePref(p: ThemePref) {
  if (p !== 'system') return setTheme(p);
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage failure is fine: the page still follows the system.
  }
  apply(media?.matches ? 'dark' : 'light');
  for (const f of subs) f(currentTheme());
}

let inited = false;
/** Call once per page: apply stored / system theme and follow OS changes unless the user chose one. */
export function initTheme() {
  if (inited) return;
  inited = true;
  apply(stored() ?? (media?.matches ? 'dark' : 'light'));
  media?.addEventListener('change', (e) => {
    if (!stored()) apply(e.matches ? 'dark' : 'light');
  });
}
