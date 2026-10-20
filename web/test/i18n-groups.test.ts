// R-20: each page loads only its dictionary groups, so every key a page can reach must sit in one of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { GROUPS as SRC_GROUPS } from '../src/i18n/index.ts';
// @ts-expect-error plain JS tool module without types
import { GROUPS, WORKERS, WORKER_GROUP, keysIn, pages, reach } from '../../tools/i18n_reach.mjs';

type Dict = Record<string, string>;
const LOCALES = ['zh', 'ja', 'ko'];
const groups: Record<string, Record<string, Dict>> = {};
for (const l of LOCALES) {
  groups[l] = {};
  for (const g of GROUPS) groups[l][g] = (await import(`../src/i18n/${l}/${g}.ts`)).default;
}
const zhAll = new Set(Object.values(groups.zh).flatMap((d) => Object.keys(d)));

test('tool and loader agree on the group list', () => {
  assert.deepEqual(GROUPS, SRC_GROUPS);
  for (const l of LOCALES) assert.ok(readdirSync(new URL(`../src/i18n/${l}`, import.meta.url)).includes('index.ts'));
});

test('groups are disjoint and hold the same keys in every locale', () => {
  for (const l of LOCALES) {
    const seen = new Map<string, string>();
    for (const g of GROUPS) {
      for (const k of Object.keys(groups[l][g])) {
        assert.ok(!seen.has(k), `${l}: "${k}" in both ${seen.get(k)} and ${g}`);
        seen.set(k, g);
      }
      assert.deepEqual(Object.keys(groups[l][g]).sort(), Object.keys(groups.zh[g]).sort(), `${l}/${g} vs zh/${g}`);
    }
  }
});

test('every page declares known groups and reaches only keys in them', () => {
  const pg = pages() as Record<string, { entry: string; groups: string[] | null }>;
  assert.ok(pg['index.html'] && pg['select.html'] && pg['app.html'], 'page entries found');
  const missing: string[] = [];
  const check = (who: string, entry: string, gs: string[]) => {
    const have = new Set(gs.flatMap((g) => Object.keys(groups.zh[g])));
    for (const k of keysIn(reach([entry]).files, zhAll)) if (!have.has(k)) missing.push(`${who}: ${k}`);
  };
  for (const [h, p] of Object.entries(pg)) {
    assert.ok(p.groups, `${h}: <html data-i18n="..."> missing`);
    for (const g of p.groups!) assert.ok(GROUPS.includes(g), `${h}: unknown group ${g}`);
    check(h, p.entry, p.groups!);
  }
  for (const [w, localized] of Object.entries(WORKERS)) if (localized) check(w, w, [WORKER_GROUP]);
  // Fix: run `node tools/i18n_regroup.mjs` (moves entries into the lightest group that needs them), see docs/I18N.md §3.
  assert.deepEqual(missing, []);
});

test('the home page dictionary stays small', () => {
  const size = (d: Dict) => Object.entries(d).reduce((n, [k, v]) => n + k.length + v.length, 0);
  const all = GROUPS.reduce((n, g) => n + size(groups.zh[g]), 0);
  assert.ok(size(groups.zh.site) < all / 2, `site group ${size(groups.zh.site)} chars of ${all}`);
});
