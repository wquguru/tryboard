// Case parameters (P1-08) and their per-work storage, without the mesh code: the eager app reads them at boot (R-12).
// Node tests import enclosure.ts, which re-exports DEFAULT_PARAMS / PARAM_RANGE from here, so imports keep the .ts suffix.
import type { CaseParams } from './enclosure.ts';

export const DEFAULT_PARAMS: Record<string, CaseParams> = {
  weather: { height: 32, wall: 2, radius: 5.5 },
  spin: { height: 32, wall: 2, radius: 0 },
  lens: { height: 30, wall: 2, radius: 0 },
  usbkey: { height: 22, wall: 2, radius: 4 },
};
export const PARAM_RANGE = { height: [16, 80], wall: [1.2, 4], radius: [0, 12] } as const;

const KEY = (work: string) => `tryboard-app-case:${work}`;
export function loadCaseParams(work: string): CaseParams {
  const d = DEFAULT_PARAMS[work] ?? DEFAULT_PARAMS.weather;
  try {
    const v = JSON.parse(localStorage.getItem(KEY(work)) ?? 'null');
    if (v && typeof v.height === 'number' && typeof v.wall === 'number' && typeof v.radius === 'number') return { height: v.height, wall: v.wall, radius: v.radius };
  } catch {
    /* Unreadable: fall back to defaults. */
  }
  return { ...d };
}
export function saveCaseParams(work: string, p: CaseParams) {
  try {
    localStorage.setItem(KEY(work), JSON.stringify(p));
    // The topbar "saved locally" badge listens for this event; keeps this file free of shell imports.
    globalThis.dispatchEvent?.(new Event('tb-saved'));
  } catch {
    /* Private mode: settings last for this page only. */
  }
}
