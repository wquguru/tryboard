import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { t, locale } from '../src/i18n/index.ts';
import zh from '../src/i18n/zh/index.ts';
import ja from '../src/i18n/ja/index.ts';
import ko from '../src/i18n/ko/index.ts';

test('node falls back to English with placeholders filled', () => {
  assert.equal(locale, 'en');
  assert.equal(t('At least {n}', { n: 3 }), 'At least 3');
});

test('every translation keeps the placeholders of its English key', () => {
  const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [id, d] of Object.entries({ zh, ja, ko })) {
    for (const [en, tr] of Object.entries(d)) assert.equal(names(tr), names(en), `${id}: ${en}`);
  }
});

test('all locales define the same keys', () => {
  const keys = (d: Record<string, string>) => Object.keys(d).sort();
  assert.deepEqual(keys(ja), keys(zh), 'ja vs zh');
  assert.deepEqual(keys(ko), keys(zh), 'ko vs zh');
  assert.ok(readdirSync(new URL('../src/i18n/zh', import.meta.url)).length > 1);
});
