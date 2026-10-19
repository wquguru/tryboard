// Gettext-style i18n: the English source string is the key, other locales map it to a translation.
// The dictionary loads via top-level await, so module-level t() calls in any importer already see it.

export type Locale = 'en' | 'zh' | 'ja' | 'ko';
export type Dict = Record<string, string>;
type Vars = Record<string, string | number>;

export const LOCALES: { id: Locale; label: string; html: string }[] = [
  { id: 'en', label: 'English', html: 'en' },
  { id: 'zh', label: '简体中文', html: 'zh-CN' }, // lint: allow-cjk
  { id: 'ja', label: '日本語', html: 'ja' }, // lint: allow-cjk
  { id: 'ko', label: '한국어', html: 'ko' }, // lint: allow-cjk
];

const KEY = 'tb-lang';
const isLocale = (v: unknown): v is Locale => LOCALES.some((l) => l.id === v);

function stored(): Locale | null {
  try {
    const v = localStorage.getItem(KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

/** Priority: ?lang= (this visit only) > saved choice > browser languages > English. */
export function detectLocale(): Locale {
  if (typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search).get('lang');
    if (isLocale(q)) return q;
  }
  const s = stored();
  if (s) return s;
  const langs = typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [];
  for (const l of langs) {
    const p = (l ?? '').toLowerCase().split('-')[0];
    if (isLocale(p)) return p;
  }
  return 'en';
}

const loaders: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Dict }>> = {
  zh: () => import('./zh/index.ts'),
  ja: () => import('./ja/index.ts'),
  ko: () => import('./ko/index.ts'),
};

// Node (CLI package, tests) and workers have no DOM: they stay English, matching the CLI output.
const hasDom = typeof document !== 'undefined';
export let locale: Locale = hasDom ? detectLocale() : 'en';
let dict: Dict = {};
if (locale !== 'en') {
  try {
    dict = (await loaders[locale]()).default;
  } catch {
    dict = {};
  }
}
if (hasDom) document.documentElement.lang = LOCALES.find((l) => l.id === locale)!.html;

/** Workers have no DOM or storage: the page posts its locale and the worker loads the same dictionary. */
export async function useWorkerLocale(l: Locale) {
  if (hasDom || l === locale || !isLocale(l)) return;
  dict = l === 'en' ? {} : (await loaders[l]()).default;
  locale = l;
}

const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/** Translate an English string; `{name}` placeholders are filled from vars. Missing entries fall back to English. */
export function t(en: string, vars?: Vars): string {
  return fill(dict[en] ?? en, vars);
}

/** Whether the current locale has its own entry (data files use this to pick a translated field). */
export const hasT = (en: string) => locale === 'en' || en in dict;

/** Save the choice and reload: strings are resolved at module load, so a reload is the simplest consistent switch. */
export function setLocale(l: Locale) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // Private mode: the choice lasts only for this page via ?lang=.
  }
  const u = new URL(location.href);
  u.searchParams.delete('lang');
  if (!stored()) u.searchParams.set('lang', l);
  location.assign(u.toString());
}

/** Number formatting follows the UI locale, not the OS locale. */
export const fmtNum = (n: number, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(LOCALES.find((l) => l.id === locale)!.html, opts).format(n);
