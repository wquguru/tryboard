// Gettext-style i18n: the English source string is the key, other locales map it to a translation.
// The page's dictionary groups load via top-level await, so module-level t() calls in any importer already see them.

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

/** Dictionary groups (docs/I18N.md §4): a page loads the ones in `<html data-i18n="...">`, all of them if unset. */
export type Group = 'site' | 'select' | 'app';
export const GROUPS: Group[] = ['site', 'select', 'app'];
type Loader = () => Promise<{ default: Dict }>;
const loaders: Record<Exclude<Locale, 'en'>, Record<Group, Loader>> = {
  zh: { site: () => import('./zh/site.ts'), select: () => import('./zh/select.ts'), app: () => import('./zh/app.ts') },
  ja: { site: () => import('./ja/site.ts'), select: () => import('./ja/select.ts'), app: () => import('./ja/app.ts') },
  ko: { site: () => import('./ko/site.ts'), select: () => import('./ko/select.ts'), app: () => import('./ko/app.ts') },
};
// Groups hold disjoint keys, so they load in parallel and merge in any order; the HTML already preloads them (vite.config.ts).
async function load(l: Locale, groups: Group[]): Promise<Dict> {
  if (l === 'en') return {};
  try {
    return Object.assign({}, ...(await Promise.all(groups.map((g) => loaders[l][g]()))).map((m) => m.default));
  } catch {
    return {};
  }
}

// Node (CLI package, tests) and workers have no DOM: they stay English, matching the CLI output.
const hasDom = typeof document !== 'undefined';
export let locale: Locale = hasDom ? detectLocale() : 'en';
const pageGroups = (): Group[] => {
  const a = hasDom ? document.documentElement.dataset.i18n : undefined;
  return a ? (a.split(/\s+/).filter((g) => (GROUPS as string[]).includes(g)) as Group[]) : GROUPS;
};
let dict: Dict = await load(locale, pageGroups());
if (hasDom) document.documentElement.lang = LOCALES.find((l) => l.id === locale)!.html;

/** Workers have no DOM or storage: the page posts its locale and the worker loads the site group only (R-20). */
export async function useWorkerLocale(l: Locale) {
  if (hasDom || l === locale || !isLocale(l)) return;
  dict = await load(l, ['site']);
  locale = l;
}

const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/** Translate an English string; `{name}` placeholders are filled from vars. Missing entries fall back to English. */
export function t(en: string, vars?: Vars): string {
  return fill(dict[en] ?? en, vars);
}

/** Whether the current locale has its own entry in the groups this page loaded (data files use this to pick a translated field). */
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
