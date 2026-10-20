// Share links on the lab page (F-01a): read ?s= before the session starts, restore and fast-forward after it boots, build the link to copy.
// The format itself lives in sharestate.ts (pure, shared with F-01b / F-02 / F-03).
import { t, locale } from '../i18n';
import { fetchBuf } from '../assets';
import { fromScript, type InputLog } from '../inputlog';
import type { Snapshot } from '../simmsg';
import { captureState, decodeState, fwHash, shareKey, shareLink, ShareDecodeError, type ShareState } from './sharestate';
import { defaultCaseHarness, loadCaseHarness, saveCaseHarness, scopeCaseHarness } from './harness';
import { replayInputs } from './history';
import { loadExamples } from './examples';
import { encode } from '../advisor/state';
import type { StepCtx, WorkId } from './types';

export interface OpenedShare {
  state: ShareState;
  /** Local-copy storage key (share:<fnv(s)>) */
  key: string;
  /** Work the state names, as main.tsx's ?work= / ?example= / advisor query would */
  work: WorkId;
  example: string | null;
  search: string | null;
}

/** Decode ?s=; on failure the page opens as usual and `error` is shown once the shell is up */
export async function readShare(s: string): Promise<{ share: OpenedShare | null; error: string | null }> {
  try {
    const state = await decodeState(s);
    const key = shareKey(s);
    const [w, ex] = state.w.startsWith('blank:') ? ['blank', state.w.slice(6)] : [state.w, null];
    // Assembly harness reads / writes of this page go to the copy's key, never the user's own work
    scopeCaseHarness(key);
    if (state.harness) saveCaseHarness(w, state.harness);
    return { share: { state, key, work: w as WorkId, example: ex, search: w === 'custom' && state.sel ? `?${state.sel}` : null }, error: null };
  } catch (e) {
    const newer = e instanceof ShareDecodeError && e.reason === 'newer';
    return { share: null, error: newer ? t('This share link was made by a newer TryBoard; reload the page to get the latest version') : t('This share link is damaged and cannot be opened; showing the default bench instead') };
  }
}

/** Placement for createSession: the state's scene wins over anything saved */
export const sharedPlaced = (sh: OpenedShare | null) => (sh?.state.scene ? { scene: sh.state.scene, ext5v: !!sh.state.ext5v } : null);

const waitBoot = (ctx: StepCtx) =>
  new Promise<void>((r) => {
    const off = ctx.session.onBoot(() => {
      off();
      r();
    });
    setTimeout(() => {
      off();
      r();
    }, 20000);
  });

/** After the session is up: wire mods, heat, firmware, then re-power and fast-forward through the shared input log */
export async function restoreShare(ctx: StepCtx, sh: OpenedShare): Promise<Snapshot | null> {
  const { session, shell, store } = ctx;
  const st = sh.state;
  const notes: string[] = [t('Opened a shared bench: this is a local copy, your own work is untouched')];
  if (st.mods) session.setWireMods(st.mods);
  if (st.heat) session.setHeat(st.heat);
  let snap: Snapshot | null = null;
  try {
    if (st.fw && session.sim) {
      if (session.bootCount === 0) await waitBoot(ctx);
      let buf = session.fwBuf;
      const name = `${st.fw.ex}/flash.bin`;
      if (!buf || session.fwName !== name) {
        buf = await fetchBuf(`./fw/${name}`);
        const booted = waitBoot(ctx);
        session.loadFirmware(buf, name);
        await booted;
      }
      if ((await fwHash(buf)) !== st.fw.h) notes.push(t('The example firmware has changed since this link was made, so results may differ from the sharer’s'));
      if (st.run) {
        // Device header comes from this power-up (same scene, same devsOf), so the CLI replay header matches too
        const l: InputLog = await session.sim.inputLog();
        const inputs = replayInputs(fromScript(st.run.s));
        snap = await session.seek({ flash: buf, i2c: l.i2c, lcd: l.spi ?? l.lcd, battery: l.battery, servo: l.servo, power: l.power, encoder: l.encoder, sonar: l.sonar, dht11: l.dht11, touchInt: l.touchInt, env: inputs.env0 ?? store.get().env, events: inputs.events, untilMs: st.run.endMs });
        (globalThis as { __tbShareRestored?: unknown }).__tbShareRestored = { stdout: snap.stdout, report: snap.report, endMs: st.run.endMs, simSeconds: snap.simSeconds };
        session.continueRun();
        notes.push(t('Replayed the shared actions up to {t} s; it keeps running from there', { t: (st.run.endMs / 1000).toFixed(2) }));
      }
    } else if (!st.fw) notes.push(t('The sharer’s own firmware is not in the link, so only the bench came along'));
  } catch (e) {
    notes.push(t('Could not replay the shared actions: {err}', { err: String(e) }));
    (globalThis as { __tbShareRestored?: unknown }).__tbShareRestored = { error: String(e) };
  }
  if (st.cut?.length) notes.push(t('Not shared, for privacy: {what}; results that depend on them may differ', { what: st.cut.map((c) => (c === 'wifi' ? t('Wi-Fi credentials') : t('real-network replies'))).join(', ') }));
  shell.toast(notes.join(' · '));
  return snap;
}

/** Build the share link of the current bench (also behind window.__tbShare for tests) */
export async function makeShare(ctx: StepCtx): Promise<{ url: string; notes: string[]; s: string; run: boolean }> {
  const { session, store, work } = ctx;
  const ex = work.example ? (await loadExamples()).find((e) => e.id === work.example) : undefined;
  const sel = store.get().selection;
  const { state, ownFw } = await captureState({
    workId: work.id,
    example: work.example ?? undefined,
    sel: ctx.custom ? encode(ctx.custom.plan.state, false) : undefined,
    cp: sel?.kind === 'checkpoint' ? sel.id : null,
    fwName: session.fwName,
    fwBuf: session.fwBuf,
    chip: session.chip as 'esp32' | 'esp32c3' | 'esp32s3',
    scene: session.scene,
    defaultScene: ctx.custom ? null : (ex?.scene ?? { parts: [] }),
    ext5v: !!session.power?.ext5v,
    mods: session.wireMods,
    harness: loadCaseHarness(work.id),
    defaultHarness: defaultCaseHarness(),
    env: store.get().env,
    heat: session.heat,
    loc: locale,
    log: session.sim ? await session.sim.inputLog() : null,
  });
  const link = await shareLink(location.origin + location.pathname, state);
  const notes: string[] = [];
  if (ownFw) notes.push(t('Your own firmware can’t go in a link yet (file export comes in the next version), so the link carries the bench only'));
  else if (link.truncated) notes.push(t('Your actions are too long for a link, so it carries the bench only; the next version can export them as a file'));
  if (state.cut?.length && !link.truncated) notes.push(t('Not shared, for privacy: {what}; results that depend on them may differ', { what: state.cut.map((c) => (c === 'wifi' ? t('Wi-Fi credentials') : t('real-network replies'))).join(', ') }));
  return { url: link.url, notes, s: link.s, run: !!state.run && !link.truncated };
}

/** Top bar ⋯ "Copy share link" */
export async function copyShare(ctx: StepCtx) {
  const { shell } = ctx;
  try {
    const { url, notes, run } = await makeShare(ctx);
    await navigator.clipboard.writeText(url);
    shell.toast([run ? t('Share link copied: it opens this bench and replays your actions') : t('Share link copied: it opens this bench with your parts and wiring'), ...notes].join(' · '));
  } catch (e) {
    shell.toast(e instanceof DOMException && e.name === 'NotAllowedError' ? t('Copy failed: the browser blocked clipboard access') : t('Could not make the share link: {err}', { err: String(e) }));
  }
}
