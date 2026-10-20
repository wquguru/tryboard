// Which dictionary keys each page can reach (R-20): walks the import graph from a page entry and collects string literals.
// Used by tools/i18n_regroup.mjs (assigns keys to groups) and web/test/i18n-groups.test.ts (no page misses a key).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB = path.join(ROOT, 'web');
const ts = createRequire(path.join(WEB, 'package.json'))('typescript');

/** Dictionary groups in load order; a page lists the ones it needs in `<html data-i18n="...">`. */
export const GROUPS = ['site', 'select', 'app'];
/** Workers get no page attribute: the sim worker loads this group only (web/src/i18n/index.ts useWorkerLocale). */
export const WORKER_GROUP = 'site';
/** Worker entries; verify-worker never sets a locale, so it stays English and needs no group. */
export const WORKERS = { 'src/worker.ts': true, 'src/verify-worker.ts': false };

const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
function resolve(from, spec) {
  if (!spec.startsWith('.')) return null;
  const b = path.resolve(path.dirname(from), spec.split('?')[0]);
  for (const e of EXTS) {
    const f = b + e;
    if (fs.existsSync(f) && fs.statSync(f).isFile() && /\.(tsx?|json)$/.test(f)) return f;
  }
  return null;
}

const DICT_DIR = /\/i18n\/(zh|ja|ko)\//;
const cache = new Map();
/** One module: static deps, dynamic deps, worker entries and every string literal (JSX text and JSON values included). */
export function scan(f) {
  if (cache.has(f)) return cache.get(f);
  const r = { st: [], dyn: [], workers: [], lits: new Set() };
  cache.set(f, r);
  const src = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.json')) {
    JSON.parse(src, (k, v) => (typeof v === 'string' && r.lits.add(v), v));
    return r;
  }
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, false, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const add = (list, spec) => {
    const p = resolve(f, spec);
    if (p && !DICT_DIR.test(p)) list.push(p);
  };
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) {
      if (!n.importClause?.isTypeOnly) add(r.st, n.moduleSpecifier.text);
      return;
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      if (!n.isTypeOnly) add(r.st, n.moduleSpecifier.text);
      return;
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) add(r.dyn, n.arguments[0].text);
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'URL' && n.arguments?.[0] && ts.isStringLiteral(n.arguments[0])) add(r.workers, n.arguments[0].text);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) r.lits.add(n.text);
    if (ts.isJsxText(n)) r.lits.add(n.text.trim());
    // Template pieces become keys once code splits them, e.g. labelText() on `${x} (I2C SDA / SCL, shared bus)`.
    if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) for (const s of n.text.split(/[()]/)) r.lits.add(s.trim());
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return r;
}

/** Every module a page can run: static and dynamic imports, but not workers (they load their own dictionary). */
export function reach(entries) {
  const seen = new Set();
  const workers = new Set();
  const q = entries.map((e) => path.resolve(WEB, e));
  while (q.length) {
    const f = q.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const s = scan(f);
    q.push(...s.st, ...s.dyn);
    s.workers.forEach((w) => workers.add(w));
  }
  return { files: seen, workers };
}

/** Literals of a module set that are dictionary keys. */
export function keysIn(files, keys) {
  const out = new Set();
  for (const f of files) for (const l of scan(f).lits) if (keys.has(l)) out.add(l);
  return out;
}

/** Pages with a module entry: html file -> { entry, groups } (groups from data-i18n; missing means all). */
export function pages() {
  const out = {};
  for (const h of fs.readdirSync(WEB).filter((f) => f.endsWith('.html'))) {
    const s = fs.readFileSync(path.join(WEB, h), 'utf8');
    const m = s.match(/<script type="module" src="\.\/([^"]+)"/);
    if (!m) continue;
    const g = s.match(/<html[^>]*\sdata-i18n="([^"]*)"/);
    out[h] = { entry: m[1], groups: g ? g[1].split(/\s+/).filter(Boolean) : null };
  }
  return out;
}
