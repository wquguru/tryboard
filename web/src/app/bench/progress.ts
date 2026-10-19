// Checkpoint progress kept in localStorage and the cross-step entry points
// (Assemble reruns the built-in firmware through Bench).
import { t } from "../../i18n";
import { type AppState, type CheckOutcome, type StepCtx } from "../types";
import { noteSaved } from "../saved";
import { wkey } from "../works";
import { actions } from "../chrome";

/** Checks that never finished (worker error / stall): not a fail, keep the firmware for Retry. */
export const stalled: Record<
  string,
  { why: string; buf: ArrayBuffer; who: string; own: boolean }
> = {};

/** Another step (Assemble lock card) asks to run the built-in firmware through: switch to Bench, run after mount. */
export const pending = { allRef: false };
export function requestAllRef() {
  if (actions.runAllRef) return actions.runAllRef();
  pending.allRef = true;
  location.hash = "bench";
}

/** Firmware the user verified on this page (Assemble's power-on retest reuses it; lost on reload, falls back to bench firmware). */
export const ownFirmware: Record<string, { buf: ArrayBuffer; name: string }> =
  {};

export const PROGRESS_KEY = (work: string) => `tryboard-app-checks:${work}`;
export function loadProgress(
  work: string,
): Record<string, { fp: string; at: string; own?: boolean; net?: boolean }> {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY(work)) ?? "{}");
  } catch {
    return {};
  }
}
export function saveProgress(work: string, id: string, fp: string, own: boolean, net = false) {
  try {
    const p = loadProgress(work);
    // A reference pass never overwrites the user's own pass (old records lack `own`: treat as own).
    if (!own && p[id] && p[id].own !== false) return;
    p[id] = {
      fp,
      at: new Date().toLocaleString("zh-CN", { hour12: false }),
      own,
      // Passed on the real network (C-03): depends on the internet, no run ID
      ...(net ? { net: true } : {}),
    };
    localStorage.setItem(PROGRESS_KEY(work), JSON.stringify(p));
    noteSaved();
  } catch {
    /* Private mode cannot store: progress lives only on this page */
  }
}

/** On boot, load saved progress into the store (only pass + fingerprint were saved, no per-row results). */
export function restoreChecks(ctx: StepCtx) {
  const p = loadProgress(wkey(ctx.work));
  const checks: Record<string, CheckOutcome> = {};
  for (const [id, v] of Object.entries(p))
    if (ctx.work.checkpoints.includes(id))
      checks[id] = {
        ok: true,
        own: v.own !== false,
        who:
          (v.own !== false
            ? t("Your firmware (passed {at})", { at: v.at })
            : t("Reference firmware (ran through {at})", { at: v.at })) +
          (v.net ? t(" · needs internet") : ""),
        rows: [],
        fingerprint: v.fp,
        sim: 0,
        ...(v.net ? { realnet: true } : {}),
      };
  ctx.store.set({ checks });
}

/** Unlocking Assemble / Product only needs a pass: a reference run (◐) and an own pass (✓) both count. */
export function passedCount(ctx: StepCtx, s: AppState = ctx.store.get()) {
  return ctx.work.checkpoints.filter((id) => s.checks[id]?.ok).length;
}

/** Checkpoints passed with the user's own firmware (shown separately as "My firmware n/N"). */
export function ownCount(ctx: StepCtx, s: AppState = ctx.store.get()) {
  return ctx.work.checkpoints.filter(
    (id) => s.checks[id]?.ok && s.checks[id].own,
  ).length;
}
