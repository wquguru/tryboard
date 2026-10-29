// All in-site URLs are built here (DESIGN_V2 §7.2): no .html suffix, servers map /app to app.html; path-style URLs later only touch this file.
// Always relative ./ because base is './' (pack_artifact bundles and sub-path deploys rely on it).

import { t } from '../i18n';
import type { StepId } from '../app/types';

export const HOME = './';
export const SELECT = './select';
export const LICENSES = './licenses';
/** Static changelog page and its Atom feed (F-12, tools/gen_changelog.mjs) */
export const CHANGELOG = './changelog';
export const CHANGELOG_FEED = './changelog.xml';

/** External project links (header icons, footer). */
export const GITHUB = 'https://github.com/wquguru/tryboard';
export const X_FOLLOW = 'https://x.com/intent/follow?screen_name=wquguru';

/** Lab URL for one step of a work; cp selects a checkpoint, example opens a sample on the blank work. */
export function lab(work: string, step: StepId = 'bench', opt: { cp?: string; example?: string } = {}): string {
  const q = new URLSearchParams({ work });
  if (opt.example) q.set('example', opt.example);
  if (opt.cp) q.set('cp', opt.cp);
  return `./app?${q}#${step}`;
}

export const BLANK_LAB = lab('blank');

/** Board-picker result into the shopping step (work=custom); params come from advisor/state.ts encode(s, true). */
export const customLab = (params: string, step: StepId = 'shop') => `./app?work=custom${params ? `&${params}` : ''}#${step}`;

/** Share link for a picker result (without the "I already have" list). */
export const selectLink = (params: string) => `${SELECT}${params ? `?${params}` : ''}`;

/** Site nav for document pages (home, board picker). */
export const SITE_NAV: [string, string][] = [
  [HOME, t('Projects')],
  [SELECT, t('Pick a board')],
  [BLANK_LAB, t('Lab')],
];
