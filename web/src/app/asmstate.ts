// Saved assembly timeline and its DOM-free summary: the eager app restores it at boot, the lazy Assemble / Product steps reuse it (R-12).
import { TEMPLATES, type Template } from '../views/templates';
import type { ConfLevel } from '../ui/conf';
import { i2cLoad, antennaLossDb, loadCaseHarness, wifiText, type CaseHarness } from './harness';
import { noteSaved } from './saved';
import type { AssemblyState, StepCtx } from './types';

export type Entry = { kind: 'place'; id: string; spot?: string } | { kind: 'test'; ok: boolean; rows: { ok: boolean; text: string; say?: string; tag?: string; dev?: string; conf?: ConfLevel; note?: string }[]; fingerprint: string; who: string; temp: number; offset: number };

const KEY = (work: string) => `tryboard-app-asm:${work}`;
/** Locally saved assembly timeline (what went in, how, retest results; nothing beyond the per-row results) */
export function loadEntries(work: string): Entry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(work)) ?? '[]');
    return Array.isArray(v) ? v.filter((e) => e && (e.kind === 'place' || e.kind === 'test')) : [];
  } catch {
    return [];
  }
}
export function saveEntries(work: string, list: Entry[]) {
  try {
    localStorage.setItem(KEY(work), JSON.stringify(list));
    noteSaved();
  } catch {
    /* private mode: only lasts for this page */
  }
}
const lastIsTest = (list: Entry[]) => {
  const e = list[list.length - 1];
  return e?.kind === 'test' ? e.ok : null;
};

/** Whether this project's enclosure holds I2C modules (cable length only matters for them) */
export const I2C_DEVICES: Record<string, number> = { weather: 2 };

/** What the harness carries into the product (estimate): I2C cable length, antenna loss dB, and whether they break it */
export function harnessEffects(work: string, h: CaseHarness) {
  const n = I2C_DEVICES[work] ?? 0;
  const i2c = n ? i2cLoad(h.i2cCm, n) : null;
  const antennaDb = antennaLossDb(h.obstacle, h.distMm);
  const wifi = wifiText(antennaDb);
  return { i2c, antennaDb, wifi, ok: (!i2c || i2c.verdict === 'ok') && wifi.level !== 'fail' };
}

/** Computes the assembly result without DOM (Product step, restore after reload); must match createAssembly's clean / effects */
export function summarize(T: Template, places: { id: string; spot?: string }[], retest: boolean | null, h: CaseHarness): AssemblyState {
  const placed = places.map((p) => p.id);
  const choice: Record<string, string> = {};
  for (const p of places) if (p.spot) choice[p.id] = p.spot;
  const total = T.parts.length;
  const hx = harnessEffects(T.id, h);
  const clean = placed.length === total && hx.ok && T.parts.every((p) => !p.spots || p.spots.find((s) => s.key === choice[p.id])?.ok);
  const fx = T.effects({ placed, choice });
  // A template's own antenna blocker (amoclock's steel weight) and the harness choice: the worse one wins
  const effects = { ...fx, ...(hx.i2c ? { i2cWireCm: h.i2cCm } : {}), antennaDb: Math.max(fx.antennaDb ?? 0, hx.antennaDb) };
  return { placed, choice, total, clean, effects, retest };
}

/** Restore the saved assembly on page load (only what went in and how; retest results must be rerun) */
export function restoreAssembly(ctx: StepCtx) {
  const T = TEMPLATES[ctx.work.id];
  if (!T) return;
  const list = loadEntries(ctx.work.id);
  const places = list.filter((e): e is Extract<Entry, { kind: 'place' }> => e.kind === 'place');
  // Saved order must be the template's bottom-up order, otherwise treat it as not assembled
  const okOrder = places.every((p, i) => T.parts[i]?.id === p.id);
  if (places.length && okOrder) ctx.store.set({ assembly: summarize(T, places, lastIsTest(list), loadCaseHarness(ctx.work.id)) });
  else if (list.length) saveEntries(ctx.work.id, []);
}
