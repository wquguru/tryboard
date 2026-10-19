// Advisor result <-> URL params (DECISIONS 2026-10-18 advisor v3 contract 1); advisor, shop (work=custom) and share links all use it.
// Defaults stay out of the URL so old links like /select?t=weather still open.

export type Budget = 0 | 60 | 120 | 200;

export interface SelectState {
  /** Template id (advisor/data.ts TEMPLATES) */
  t: string;
  /** Parts added beyond / removed from the template (advisor/data.ts PARTS ids) */
  add: string[];
  rm: string[];
  /** The three plain questions: battery / network / run in TryBoard first; null = template default */
  bat: boolean | null;
  net: boolean | null;
  sim: boolean | null;
  /** 0 = no limit */
  budget: Budget;
  /** Hard needs named under "More needs" (Cap) */
  req: string[];
  /** Board picked in the comparison (advisor BOARDS id); empty = the recommended one */
  board: string;
  /** "I have it": only in links into the shop, never in share links */
  have: string[];
}

export const EMPTY: SelectState = { t: '', add: [], rm: [], bat: null, net: null, sim: null, budget: 0, req: [], board: '', have: [] };

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);
const flag = (v: string | null) => (v === '1' ? true : v === '0' ? false : null);
const BUDGETS: Budget[] = [0, 60, 120, 200];

export function decode(search: string): SelectState {
  const q = new URLSearchParams(search);
  const b = Number(q.get('budget') ?? 0) as Budget;
  return {
    t: q.get('t') ?? '',
    add: list(q.get('add')),
    rm: list(q.get('rm')),
    bat: flag(q.get('bat')),
    net: flag(q.get('net')),
    sim: flag(q.get('sim')),
    budget: BUDGETS.includes(b) ? b : 0,
    req: list(q.get('req')),
    board: q.get('board') ?? '',
    have: list(q.get('have')),
  };
}

/** Query string (no ?). withHave=false is for share links */
export function encode(s: SelectState, withHave = false): string {
  const q = new URLSearchParams();
  if (s.t) q.set('t', s.t);
  if (s.add.length) q.set('add', s.add.join(','));
  if (s.rm.length) q.set('rm', s.rm.join(','));
  for (const k of ['bat', 'net', 'sim'] as const) if (s[k] !== null) q.set(k, s[k] ? '1' : '0');
  if (s.budget) q.set('budget', String(s.budget));
  if (s.req.length) q.set('req', s.req.join(','));
  if (s.board) q.set('board', s.board);
  if (withHave && s.have.length) q.set('have', s.have.join(','));
  // URLSearchParams turns commas into %2C; plain commas read better in the URL
  return q.toString().replace(/%2C/g, ',');
}

/** Local "I have it" list (part ids); storage may be blocked, so failure means empty */
export const HAVE_KEY = 'tryboard-have';
export function loadHave(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HAVE_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
export function saveHave(ids: string[]) {
  try {
    localStorage.setItem(HAVE_KEY, JSON.stringify(ids));
  } catch {
    /* Private mode etc.: it just will not be remembered */
  }
}
