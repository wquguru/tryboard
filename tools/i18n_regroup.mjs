// Moves dictionary entries into the lightest group whose page reaches them (R-20, docs/I18N.md §3).
// Usage: node tools/i18n_regroup.mjs [--dry]. Entries only move up (lab areas -> select.ts -> site.ts), never down.
import fs from 'node:fs';
import path from 'node:path';
import { WEB, WORKERS, keysIn, pages, reach } from './i18n_reach.mjs';

const dry = process.argv.includes('--dry');
const LOCALES = ['zh', 'ja', 'ko'];
/** Page that owns each light group: its reach decides the group's keys. */
const OWNER = { site: ['index.html', ...Object.keys(WORKERS).filter((w) => WORKERS[w])], select: ['select.html'] };
const GROUP_FILE = { site: 'site.ts', select: 'select.ts' };
const NOT_AREA = new Set(['index.ts', 'app.ts']);
/** Old merge order of the area files (later wins); files not listed sort first. */
const MERGE = ['data.ts', 'checks.ts', 'views.ts', 'site.ts', 'lab.ts', 'steps.ts', 'net.ts', 'select.ts'];

const ENTRY = /^  ("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),?$/;
/** Split a dictionary file into header, body lines and footer; entries are one `"en": "tr",` per line. */
function parse(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const open = lines.findIndex((l) => /^const d: Dict = \{$/.test(l));
  const close = lines.lastIndexOf('};');
  if (open < 0 || close < 0) throw new Error(`${file}: no "const d: Dict = {" ... "};" block`);
  const body = lines.slice(open + 1, close).map((l) => {
    const m = l.match(ENTRY);
    if (m) return { key: JSON.parse(m[1]), line: l };
    if (/^\s*(\/\/.*)?$/.test(l)) return { comment: l };
    throw new Error(`${file}: unexpected line ${JSON.stringify(l)}`);
  });
  return { head: lines.slice(0, open + 1), body, foot: lines.slice(close) };
}
/** Drop comment runs with no entry left under them and repeated blank lines. */
function tidy(body) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b.key !== undefined) out.push(b);
    else if (!b.comment.trim()) out.length && out.at(-1).key === undefined && !out.at(-1).comment.trim() ? 0 : out.push(b);
    else {
      let e = i;
      while (e + 1 < body.length && body[e + 1].key === undefined && body[e + 1].comment.trim()) e++;
      let n = e + 1;
      while (n < body.length && body[n].key === undefined && !body[n].comment.trim()) n++;
      if (n < body.length && body[n].key !== undefined) out.push(...body.slice(i, e + 1));
      i = e;
    }
  }
  while (out.length && out[0].key === undefined && !out[0].comment.trim()) out.shift();
  while (out.length && out.at(-1).key === undefined && !out.at(-1).comment.trim()) out.pop();
  return out;
}
const write = (file, p) => fs.writeFileSync(file, [...p.head, ...p.body.map((b) => b.line ?? b.comment), ...p.foot].join('\n'));

const pg = pages();
const entryOf = (h) => (h.endsWith('.html') ? pg[h].entry : h);
const zhDir = path.join(WEB, 'src/i18n/zh');
const allKeys = new Set();
for (const f of fs.readdirSync(zhDir).filter((f) => !NOT_AREA.has(f))) for (const b of parse(path.join(zhDir, f)).body) if (b.key !== undefined) allKeys.add(b.key);
const want = {};
for (const [g, owners] of Object.entries(OWNER)) want[g] = keysIn(reach(owners.map(entryOf)).files, allKeys);
for (const k of want.site) want.select.delete(k);
const groupOf = (k) => (want.site.has(k) ? 'site' : want.select.has(k) ? 'select' : null);

for (const loc of LOCALES) {
  const dir = path.join(WEB, 'src/i18n', loc);
  const files = fs.readdirSync(dir).filter((f) => !NOT_AREA.has(f));
  for (const g of Object.values(GROUP_FILE)) if (!files.includes(g)) throw new Error(`${loc}/${g} missing: create it first`);
  const parsed = Object.fromEntries(files.map((f) => [f, parse(path.join(dir, f))]));
  const rank = (f) => (f === GROUP_FILE.site ? 0 : f === GROUP_FILE.select ? 1 : 2);
  const moved = { site: [], select: [] };
  // Same key in several files: keep the entry that won the old merge (later in MERGE wins), drop the rest.
  const win = new Map();
  for (const f of [...files].sort((a, b) => MERGE.indexOf(a) - MERGE.indexOf(b))) for (const b of parsed[f].body) if (b.key !== undefined) win.set(b.key, f);
  let dropped = 0;
  for (const [f, p] of Object.entries(parsed)) p.body = p.body.filter((b) => b.key === undefined || win.get(b.key) === f || (dropped++, false));
  for (const [f, p] of Object.entries(parsed)) {
    let section = [];
    let lastWasEntry = false;
    const keep = [];
    for (const b of p.body) {
      if (b.key === undefined) {
        if (lastWasEntry) section = [];
        if (b.comment.trim()) section.push(b.comment);
        lastWasEntry = false;
        keep.push(b);
        continue;
      }
      lastWasEntry = true;
      const g = groupOf(b.key);
      if (g && rank(GROUP_FILE[g]) < rank(f)) moved[g].push({ ...b, from: f, section: section.join('\n') });
      else keep.push(b);
    }
    // Drop section comments left with no entries under them.
    p.body = tidy(keep);
  }
  for (const [g, list] of Object.entries(moved)) {
    if (!list.length) continue;
    const p = parsed[GROUP_FILE[g]];
    let cur = null;
    for (const m of list) {
      const head = m.section || `  // Moved from ${m.from}`;
      if (head !== cur) p.body.push({ comment: '' }, ...head.split('\n').map((c) => ({ comment: c })));
      cur = head;
      p.body.push({ key: m.key, line: m.line });
    }
  }
  // A key may sit in only one file of a locale: groups must be disjoint for the per-page merge.
  const where = new Map();
  for (const [f, p] of Object.entries(parsed)) for (const b of p.body) if (b.key !== undefined) where.set(b.key, [...(where.get(b.key) ?? []), f]);
  const dup = [...where].filter(([, fs]) => fs.length > 1 && fs.some((f) => rank(f) < 2));
  if (dup.length) throw new Error(`${loc}: keys in a light group and another file: ${dup.slice(0, 5).map(([k, fs]) => `${k} (${fs})`).join('; ')}`);
  console.log(`[regroup] ${loc}: site +${moved.site.length}, select +${moved.select.length}, duplicates dropped ${dropped}`);
  if (!dry) for (const [f, p] of Object.entries(parsed)) write(path.join(dir, f), p);
}
