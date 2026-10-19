// 选板结果 ↔ 地址参数（DECISIONS 2026-10-18「选板 v3」接口约定 1）。选板页、采购页（work=custom）、分享链接都只走这里编解码。
// 缺省值不写进地址，旧链接 /select?t=weather 照常可开。

export type Budget = 0 | 60 | 120 | 200;

export interface SelectState {
  /** 模板 id（advisor/data.ts TEMPLATES） */
  t: string;
  /** 在模板之外加的零件、从模板里去掉的零件（advisor/data.ts PARTS 的 id） */
  add: string[];
  rm: string[];
  /** 三个白话问题：用电池供电 / 要连网 / 要在试板里先跑通；null = 跟模板默认 */
  bat: boolean | null;
  net: boolean | null;
  sim: boolean | null;
  /** 0 = 不限 */
  budget: Budget;
  /** 「更多需求」里点名的硬需求（Cap） */
  req: string[];
  /** 用户在三板对比里点的板子（advisor BOARDS id）；空 = 用推荐的 */
  board: string;
  /** 我已有：只在进采购的链接里带，分享链接不带 */
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

/** 参数串（不带 ?）。withHave=false 用于分享链接 */
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
  // URLSearchParams 会把逗号转成 %2C，地址里留逗号好读
  return q.toString().replace(/%2C/g, ',');
}

/** 本机「我已有」（零件 id 数组）；读写都可能被浏览器拦，失败当空 */
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
    /* 隐私模式等：只是下次不记得 */
  }
}
