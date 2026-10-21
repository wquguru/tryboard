// Embed run view (F-03): the shared bench with run / pause, restart and a collapsible serial; no shell, editing or saving.
// Loaded on the poster click, so wasm, three.js and the session code are fetched only then.
import '../views/views.css';
import '../app/lab.css';
import { t } from '../i18n';
import { createSession } from '../app/session';
import { createStore } from '../app/store';
import { restoreShare, shareReplay, type OpenedShare } from '../app/shareopen';
import { shareKey, type ShareState } from '../app/sharestate';
import { initialHistory } from '../app/bom';
import type { AppState, StepCtx, WorkDef, WorkId } from '../app/types';
import { shieldStorage } from './memstore';

export interface EmbedInput {
  state: ShareState;
  s: string;
  work: WorkDef;
  title: string;
  openLink: () => HTMLAnchorElement;
  /** F-03b: play the shared actions at their original speed instead of fast-forwarding */
  paced?: boolean;
}

function button(id: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = id;
  b.className = 'tb-embed-btn';
  b.textContent = label;
  return b;
}

export async function runEmbed(root: HTMLElement, inp: EmbedInput) {
  // Before any session module touches storage: writes go to memory, the host page's site never sees them
  shieldStorage();
  const { state: st, s } = inp;
  const key = shareKey(s);
  const work: WorkDef = { ...inp.work, key };
  const shared: OpenedShare = { state: st, key, work: work.id as WorkId, example: work.example, search: null };

  const view = document.createElement('div');
  view.className = 'tb-embed-run';
  const stage = document.createElement('div');
  stage.id = 'stage';
  stage.className = 'tb-embed-stage';
  const bar = document.createElement('div');
  bar.className = 'tb-embed-bar';
  const runBtn = button('embedRun', t('Pause'));
  const restart = button('embedRestart', t('Restart'));
  const simtime = document.createElement('span');
  simtime.id = 'simtime';
  simtime.className = 'tb-embed-time';
  simtime.textContent = '0.00 s';
  const serialBtn = button('embedSerial', t('Serial'));
  serialBtn.setAttribute('aria-expanded', 'true');
  bar.append(runBtn, restart, simtime, serialBtn);
  const con = document.createElement('pre');
  con.id = 'console';
  con.className = 'tb-embed-console';
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.className = 'tb-embed-toast';
  toast.setAttribute('role', 'status');
  view.append(stage, bar, con, toast, inp.openLink());
  root.replaceChildren(view);
  document.body.dataset.state = 'running';

  const store = createStore<AppState>({
    work: work.id,
    step: 'bench',
    selection: null,
    env: st.env ?? { temp: 23.5, humidity: 45, pressure: 101325 },
    run: 0,
    simSeconds: 0,
    running: false,
    reading: null,
    pose: { pitch: 0, roll: 0, yaw: 0 },
    imu: null,
    touch: null,
    checks: {},
    verifying: null,
    verifyProgress: 0,
    assembly: null,
    caseParams: { height: 40, wall: 2, radius: 4 },
    bom: initialHistory('blank'),
    sceneRev: 0,
    editRev: 0,
    runNo: 0,
    hist: { n: 0, cur: -1, seeked: false, busy: false, runs: 0 },
  });
  store.subscribe((x) => (simtime.textContent = `${x.simSeconds.toFixed(2)} s`), ['simSeconds']);

  const log = (text: string) => {
    con.appendChild(document.createTextNode(text));
    if (con.textContent!.length > 200_000) con.textContent = con.textContent!.slice(-150_000);
    if (!con.hidden) con.scrollTop = con.scrollHeight;
  };
  let toastTimer = 0;
  const shell = {
    toast(msg: string) {
      toast.textContent = msg;
      toast.dataset.on = '1';
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => delete toast.dataset.on, 6000);
    },
  };
  const placed = st.scene ? { scene: st.scene, ext5v: !!st.ext5v } : null;
  const session = await createSession(stage, work, store, { onConsole: log, onConsoleReset: (text) => (con.textContent = text) }, { placed, ...(st.chip ? { chip: st.chip } : {}) });
  (globalThis as { __tbEmbed?: unknown }).__tbEmbed = { store, session };

  let paused = false;
  const sync = () => {
    runBtn.textContent = paused ? t('Resume') : t('Pause');
    runBtn.setAttribute('aria-pressed', String(paused));
  };
  runBtn.addEventListener('click', () => {
    if (paused) session.sim?.resume();
    else session.sim?.pause();
    paused = !paused;
    sync();
  });
  restart.addEventListener('click', () => {
    paused = false;
    sync();
    session.reboot();
  });
  serialBtn.addEventListener('click', () => {
    con.hidden = !con.hidden;
    serialBtn.setAttribute('aria-expanded', String(!con.hidden));
    view.dataset.serial = con.hidden ? 'off' : 'on';
  });
  const ctx = { work, store, session, shell } as unknown as StepCtx;
  await restoreShare(ctx, shared, null, inp.paced);
  const rep = shareReplay();
  if (rep) {
    // Paced replay: progress and "Skip to end" sit in the toolbar until the log's end time is reached
    const tag = document.createElement('span');
    tag.id = 'embedReplay';
    tag.className = 'tb-embed-replay';
    const end = (rep.endMs / 1000).toFixed(2);
    const show = (x: number) => (tag.textContent = t('Replaying {t} / {end} s', { t: Math.min(x, rep.endMs / 1000).toFixed(2), end }));
    show(0);
    const skip = button('embedSkip', t('Skip to end'));
    const off = store.subscribe((x) => show(x.simSeconds), ['simSeconds']);
    const finish = () => {
      off();
      tag.remove();
      skip.remove();
      delete view.dataset.replay;
    };
    skip.addEventListener('click', async () => {
      skip.disabled = true;
      await rep.skip();
      paused = false;
      sync();
      finish();
    });
    simtime.after(tag, skip);
    view.dataset.replay = 'on';
    void rep.done.then(finish);
  }
  if (st.tl) {
    // F-11: read-only scenario progress (editing lives in the full lab)
    const len = st.tl.len;
    const sc = document.createElement('div');
    sc.id = 'embedScenario';
    sc.className = 'tb-embed-scen';
    sc.setAttribute('role', 'progressbar');
    sc.setAttribute('aria-label', t('Script'));
    sc.setAttribute('aria-valuemin', '0');
    sc.setAttribute('aria-valuemax', String(len / 1000));
    const fill = document.createElement('i');
    sc.append(fill);
    const show = (secs: number) => {
      const p = Math.min(1, (secs * 1000) / len);
      fill.style.width = `${(p * 100).toFixed(1)}%`;
      sc.setAttribute('aria-valuenow', Math.min(secs, len / 1000).toFixed(1));
      sc.title = t('Script {t} / {len} s', { t: Math.min(secs, len / 1000).toFixed(1), len: (len / 1000).toFixed(0) });
    };
    show(store.get().simSeconds);
    store.subscribe((x) => show(x.simSeconds), ['simSeconds']);
    bar.before(sc);
  }
  document.body.dataset.state = 'ready';
}
