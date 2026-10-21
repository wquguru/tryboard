// Share links on the lab page (F-01a): read ?s= before the session starts, restore and fast-forward after it boots, build the link to copy.
// The format itself lives in sharestate.ts (pure, shared with F-01b / F-02 / F-03).
import { sharedText, takeShared } from './mpyapp';
import { t, locale } from '../i18n';
import { fetchBuf } from '../assets';
import { fromScript, type InputLog } from '../inputlog';
import type { Snapshot } from '../simmsg';
import type { SeekJob } from '../live';
import { captureState, decodeState, fwHash, shareKey, shareLink, ShareDecodeError, type ShareChip, type ShareState } from './sharestate';
import { defaultCaseHarness, loadCaseHarness, saveCaseHarness, scopeCaseHarness } from './harness';
import { replayInputs } from './history';
import { loadExamples } from './examples';
import { encode } from '../advisor/state';
import { fwCheck } from './fwcheck';
import type { StepCtx, WorkId } from './types';
import { scenFeed, setScenario } from './scenariofeed';

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

/** Paced replay of a share in progress (F-03b): skip() fast-forwards to the end the usual way; done resolves at endMs (null if cut short) */
export interface ShareReplay {
  endMs: number;
  done: Promise<Snapshot | null>;
  skip(): Promise<Snapshot>;
}
let replaying: ShareReplay | null = null;
/** The paced replay of the last restoreShare, while it has not ended */
export const shareReplay = () => replaying;

/** ?replay=1 on /app or /embed: play the shared actions at their original speed instead of fast-forwarding */
export const wantsPaced = (search: string) => new URLSearchParams(search).get('replay') === '1';

const restored = (snap: Snapshot, endMs: number, paced: boolean) =>
  ((globalThis as { __tbShareRestored?: unknown }).__tbShareRestored = { stdout: snap.stdout, report: snap.report, endMs, simSeconds: snap.simSeconds, ...(paced ? { paced } : {}) });

/** Fast-forward to the end of the shared log, then keep running live */
async function fastForward(ctx: StepCtx, job: SeekJob) {
  const snap = await ctx.session.seek(job);
  restored(snap, job.untilMs, false);
  ctx.session.continueRun();
  return snap;
}

/** After the session is up: wire mods, heat, firmware, then re-power and fast-forward through the shared input log (paced: play it at its original speed, F-03b).
 * own = the user's bin from a .tryboard file (F-01b, checked against state.bin when the file was opened) */
export async function restoreShare(ctx: StepCtx, sh: OpenedShare, own?: { buf: ArrayBuffer; name: string } | null, paced = false): Promise<Snapshot | null> {
  replaying = null;
  const { session, shell, store } = ctx;
  const st = sh.state;
  const notes: string[] = [t('Opened a shared bench: this is a local copy, your own work is untouched')];
  // Scenario first: the fast-forward / paced seek below hands its part after endMs to the worker (live.ts seek)
  // A link without one must not pick up a scenario saved earlier; the link itself is the copy, so nothing is saved here
  if (st.tl || scenFeed.get().sc) setScenario(st.tl ?? null, { save: false });
  // main.py rides along (F-07b); a run already holds the upload, so no automatic re-send on top of it
  takeShared(st.mpy, !!st.run);
  if (st.mods) session.setWireMods(st.mods);
  if (st.heat) session.setHeat(st.heat);
  let snap: Snapshot | null = null;
  try {
    if ((st.fw || own) && session.sim) {
      if (session.bootCount === 0) await waitBoot(ctx);
      let buf = session.fwBuf;
      const name = own ? own.name : `${st.fw!.ex}/flash.bin`;
      if (own) {
        // A hand-edited file could pair this work's chip with another chip's image
        const chk = fwCheck(own.buf, session.chip);
        if (!chk.ok) throw new Error(chk.title);
        buf = own.buf;
        const booted = waitBoot(ctx);
        session.loadFirmware(buf, name);
        await booted;
      } else if (!buf || session.fwName !== name) {
        buf = await fetchBuf(`./fw/${name}`);
        const booted = waitBoot(ctx);
        session.loadFirmware(buf, name);
        await booted;
      }
      if (st.fw && !own && (await fwHash(buf!)) !== st.fw.h) notes.push(t('The example firmware has changed since this link was made, so results may differ from the sharer’s'));
      if (st.run) {
        // Device header comes from this power-up (same scene, same devsOf), so the CLI replay header matches too
        const l: InputLog = await session.sim.inputLog();
        const inputs = replayInputs(fromScript(st.run.s));
        const job: SeekJob = { flash: buf!, i2c: l.i2c, lcd: l.spi ?? l.lcd, battery: l.battery, servo: l.servo, power: l.power, encoder: l.encoder, sonar: l.sonar, dht11: l.dht11, parts: l.parts, touchInt: l.touchInt, board: l.board, grove: l.grove, env: inputs.env0 ?? store.get().env, events: inputs.events, untilMs: st.run.endMs };
        const endS = (st.run.endMs / 1000).toFixed(2);
        if (paced && session.sim) {
          snap = await session.seek({ ...job, paced: true });
          const done = session.sim.pacedEnd();
          const r: ShareReplay = {
            endMs: job.untilMs,
            done,
            skip: () => {
              replaying = null;
              return fastForward(ctx, job);
            },
          };
          replaying = r;
          void done.then((end) => {
            if (replaying === r) replaying = null;
            if (end) restored(end, job.untilMs, true);
          });
          session.continueRun();
          notes.push(t('Replaying the shared actions at their original speed up to {t} s', { t: endS }));
        } else {
          snap = await fastForward(ctx, job);
          notes.push(t('Replayed the shared actions up to {t} s; it keeps running from there', { t: endS }));
        }
      } else if (st.tl) {
        // Scenario without a run (or the run did not fit the link): play it from power-up
        const booted = waitBoot(ctx);
        session.reboot();
        await booted;
      }
    } else if (st.bin && !own) notes.push(t('The firmware of this .tryboard file is no longer stored in this browser, so only the bench came along; open the file again'));
    else if (!st.fw) notes.push(t('The sharer’s own firmware is not in the link, so only the bench came along'));
  } catch (e) {
    notes.push(t('Could not replay the shared actions: {err}', { err: String(e) }));
    (globalThis as { __tbShareRestored?: unknown }).__tbShareRestored = { error: String(e) };
  }
  if (st.cut?.length) notes.push(t('Not shared, for privacy: {what}; results that depend on them may differ', { what: st.cut.map((c) => (c === 'wifi' ? t('Wi-Fi credentials') : t('real-network replies'))).join(', ') }));
  shell.toast(notes.join(' · '));
  return snap;
}

/** Collect the current bench into a state (link: ownRun false; .tryboard file: true keeps the run on the user's bin) */
export async function captureBench(ctx: StepCtx, ownRun = false) {
  const { session, store, work } = ctx;
  const ex = work.example ? (await loadExamples()).find((e) => e.id === work.example) : undefined;
  const sel = store.get().selection;
  return captureState({
    workId: work.id,
    example: work.example ?? undefined,
    sel: ctx.custom ? encode(ctx.custom.plan.state, false) : undefined,
    cp: sel?.kind === 'checkpoint' ? sel.id : null,
    fwName: session.fwName,
    fwBuf: session.fwBuf,
    chip: session.chip as ShareChip,
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
    scenario: scenFeed.get().sc,
    ownRun,
    mpy: sharedText(),
  });
}

/** Build the share link of the current bench (also behind window.__tbShare for tests) */
export async function makeShare(ctx: StepCtx, max?: number): Promise<{ url: string; notes: string[]; s: string; run: boolean; truncated: boolean }> {
  const { state, ownFw } = await captureBench(ctx);
  const link = await shareLink(location.origin + location.pathname, state, max);
  const notes: string[] = [];
  if (ownFw) notes.push(t('Your own firmware can’t go in a link, so it carries the bench only; ⋯ → Download .tryboard file takes the firmware and your actions'));
  else if (link.truncated && state.tl) notes.push(t('Link too long: only the scenario is included; download the .tryboard file for the full run'));
  else if (link.truncated) notes.push(t('Your actions are too long for a link, so it carries the bench only; ⋯ → Download .tryboard file takes them all'));
  if (state.cut?.length && !link.truncated) notes.push(t('Not shared, for privacy: {what}; results that depend on them may differ', { what: state.cut.map((c) => (c === 'wifi' ? t('Wi-Fi credentials') : t('real-network replies'))).join(', ') }));
  return { url: link.url, notes, s: link.s, run: !!state.run && !link.truncated, truncated: link.truncated };
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
