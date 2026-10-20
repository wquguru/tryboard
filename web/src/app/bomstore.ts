// Per-work BOM and bench placement in localStorage: shared by the eager shell (session, main) and the lazy Shop step (R-12).
import type { SceneSpec } from '../board3d';
import { PROCURE_TEMPLATES } from '../catalog/templates';
import { initialHistory, validHistory, type BomHistory } from './bom';
import { noteSaved } from './saved';

const BOM_KEY = (w: string) => `tryboard-app-shop:${w}`;
const PLACED_KEY = (w: string) => `tryboard-app-placed:${w}`;

/** template: list to start from when nothing is saved (a shared copy's key share:<fnv> names no template) */
export function loadBom(work: string, template?: string): BomHistory {
  try {
    const h = JSON.parse(localStorage.getItem(BOM_KEY(work)) ?? 'null');
    if (validHistory(h)) return h;
  } catch {
    /* corrupt data: fall back to the template default */
  }
  // Board-picker works (custom:<hash>) get their template registered as 'custom' by main.tsx from URL params
  if (template) return initialHistory(template);
  return initialHistory(work.startsWith('custom:') ? 'custom' : PROCURE_TEMPLATES.some((x) => x.id === work) ? work : 'blank');
}
export function saveBom(work: string, h: BomHistory) {
  try {
    localStorage.setItem(BOM_KEY(work), JSON.stringify(h));
    noteSaved();
  } catch {
    /* private mode can't store: the list lives only on this page */
  }
}
export function loadPlaced(work: string): { scene: SceneSpec; ext5v: boolean } | null {
  try {
    const p = JSON.parse(localStorage.getItem(PLACED_KEY(work)) ?? 'null');
    if (p && Array.isArray(p.scene?.parts) && typeof p.ext5v === 'boolean') return p;
  } catch {
    /* same as above */
  }
  return null;
}
export function savePlaced(work: string, scene: SceneSpec, ext5v: boolean) {
  try {
    localStorage.setItem(PLACED_KEY(work), JSON.stringify({ scene, ext5v }));
    noteSaved();
  } catch {
    /* same as above */
  }
}
