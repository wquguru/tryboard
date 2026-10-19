// Pure parts of the ⌘K palette (P1-06): fuzzy scoring and parameter parsing (room temp N ℃, nth run); tested by node --test.

export interface Match {
  score: number;
  /** Indices of matched characters in label (for highlighting) */
  hits: number[];
}

/** Each space-separated token must appear in order (not necessarily contiguous) in label or keys; null if not.
 * Score favours contiguous hits, word starts, hits in label over keys only, and shorter labels. */
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
  // Contiguous match first (best), then fall back to subsequence
  const at = s.indexOf(tok);
  if (at >= 0) {
    const start = at === 0 || /[\s·/（(_-]/.test(s[at - 1]); // lint: allow-cjk
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

/** Room temperature to set ("temp 18.5", "set room to 30", Chinese "室温 35"); null without intent or number */ // lint: allow-cjk
export function parseTemp(q: string): number | null {
  if (!/室温|温度|temp|℃|°c|度|设为|设成|\bset\b|\broom\b|degree/i.test(q)) return null; // lint: allow-cjk
  const m = /(-?\d+(?:\.\d+)?)/.exec(q);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** The "nth run" in a query ("back to run 2", "run #3", Chinese "回到第 2 次运行"); null if none */ // lint: allow-cjk
export function parseRun(q: string): number | null {
  if (!/运行|run|回到|第|back to/i.test(q)) return null; // lint: allow-cjk
  const m = /(\d+)/.exec(q);
  return m ? Number(m[1]) : null;
}

/** Wrap hit indices of label in <mark> (escaped) */
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

/** Recent commands: newest first, deduped, at most n */
export function pushRecent(list: string[], id: string, n = 6): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, n);
}
