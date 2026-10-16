// ⌘K 命令框的纯函数部分（P1-06）：模糊匹配打分、从输入里认出参数（室温 N ℃、第 n 次运行）。node --test 直接测。

export interface Match {
  score: number;
  /** label 里命中的字符下标（高亮用） */
  hits: number[];
}

/**
 * 模糊匹配：查询按空格切成几段，每段都要按顺序（不必连续）出现在 label 或 keys 里。
 * 打分：连续命中、命中在词首、命中在 label（而不是只在关键词里）、label 越短越靠前。没命中返回 null。
 */
export function fuzzy(query: string, label: string, keys = ''): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const L = label.toLowerCase();
  const all = `${L} ${keys.toLowerCase()}`;
  let score = 0;
  const hits: number[] = [];
  for (const tok of q.split(/\s+/)) {
    const inLabel = sub(tok, L);
    const m = inLabel ?? sub(tok, all);
    if (!m) return null;
    score += m.score + (inLabel ? 6 : 0);
    if (inLabel) hits.push(...inLabel.hits);
  }
  score -= label.length * 0.05;
  return { score, hits: [...new Set(hits)].sort((a, b) => a - b) };
}

function sub(tok: string, s: string): Match | null {
  // 先找连续出现（最好），再退回子序列
  const at = s.indexOf(tok);
  if (at >= 0) {
    const start = at === 0 || /[\s·/（(_-]/.test(s[at - 1]);
    return { score: 10 + tok.length * 3 + (start ? 5 : 0), hits: [...Array(tok.length).keys()].map((k) => at + k) };
  }
  const hits: number[] = [];
  let j = 0;
  for (let i = 0; i < s.length && j < tok.length; i++) if (s[i] === tok[j]) hits.push(i), j++;
  if (j < tok.length) return null;
  let run = 0;
  for (let k = 1; k < hits.length; k++) if (hits[k] === hits[k - 1] + 1) run++;
  return { score: tok.length + run * 2 - (hits[hits.length - 1] - hits[0]) * 0.1, hits };
}

/** 输入里要设的室温（"室温 35"、"温度35℃"、"temp 18.5"、"设为 30 度"）；没有温度意图或数字返回 null */
export function parseTemp(q: string): number | null {
  if (!/室温|温度|temp|℃|°c|度|设为|设成/i.test(q)) return null;
  const m = /(-?\d+(?:\.\d+)?)/.exec(q);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** 输入里的"第 n 次运行"（"回到第 2 次运行"、"运行 #3"、"run 1"）；没有返回 null */
export function parseRun(q: string): number | null {
  if (!/运行|run|回到|第/i.test(q)) return null;
  const m = /(\d+)/.exec(q);
  return m ? Number(m[1]) : null;
}

/** label 按命中下标包上 <mark>（已转义） */
export function highlight(label: string, hits: number[]): string {
  const esc = (c: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c;
  const set = new Set(hits);
  let out = '';
  let open = false;
  for (let i = 0; i < label.length; i++) {
    const h = set.has(i);
    if (h && !open) out += '<mark>';
    if (!h && open) out += '</mark>';
    open = h;
    out += esc(label[i]);
  }
  return out + (open ? '</mark>' : '');
}

/** 最近用过的命令：新的放前面、去重、最多 n 条 */
export function pushRecent(list: string[], id: string, n = 6): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, n);
}
