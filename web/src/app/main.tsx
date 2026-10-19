// Lab entry: ./app?work=weather#bench (file is app.html, linked without suffix). One shell, live sim and 3D bench; four routed steps.
// React renders the shell synchronously first: #stage and friends must exist before createSession.
import '../ui/tailwind.css';
import '../views/views.css';
import './lab.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createStore } from './store';
import { createShell, registerStep, ShellView, startRouter } from './shell';
import { createSession, WORKS } from './session';
import { benchStep, passedCount, restoreChecks } from './steps/bench';
import { assembleStep, restoreAssembly } from './steps/assemble';
import { productStep } from './steps/product';
import { loadBom, loadPlaced, shopStep } from './steps/shop';
import type { AppState, StepCtx, WorkDef, WorkId } from './types';
import { wkey } from './works';
import { loadExamples } from './examples';
import { pushRecent } from './fwmenu';
import { fetchBuf } from '../assets';
import { createBenchHistory } from './benchhist';
import { initTheme } from '../theme';
import { partLabel } from './wiring';
import { createCmdk } from './cmdk';
import { getAnalyzer } from './analyzer';
import { loadCaseParams } from './casemesh';
import { actions, bc, overlay, setBc, setDock, syncDockVar, type CpRow, type Issue } from './chrome';
import { FwCheckCard, fwCheck } from './fwcheck';
import { BrownoutBanner } from './benchv2';
import { initSaved } from './saved';
import { serial } from './dock';
import { usbFeed } from './usbpane';
import { bleFeed } from './blepane';
import { toScript, type InputLog } from '../inputlog';
import { customPlan } from './custom';
import { genLevels } from './genlevels';
import { registerTemplate } from '../catalog/templates';
import { initialHistory, placement, replay } from './bom';
import { briefMarkdown } from '../advisor/brief';
import type { PartSpec } from '../board3d';
import { t } from '../i18n';

export { registerStep } from './shell';

const params = new URLSearchParams(location.search);
const want = params.get('work') as WorkId | null;
// &example=<id>: blank work + the example's firmware, bench and chip (DESIGN_V2 §6.1; old index.html?example= redirects here)
const exId = params.get('example');
const ex = exId ? (await loadExamples()).find((e) => e.id === exId) : undefined;
// work=custom: board picker result -> shop template + per-part checkpoints (U-17). New query = new work (save key hashes it)
const plan = !ex && want === 'custom' ? customPlan(location.search) : null;
if (plan) registerTemplate(plan.template);
// Without a saved placement, lay out per the picker pin table (unsaved); a saved one wins (shop may have changed parts)
const customPlaced = plan
  ? (loadPlaced(plan.wkey) ??
    (() => {
      const pl = placement(replay(initialHistory('custom')));
      return { scene: { parts: pl.parts as unknown as PartSpec[] }, ext5v: pl.ext5v };
    })())
  : null;
const customLevels = plan ? genLevels({ boardName: plan.boardName, chip: plan.chip, parts: customPlaced!.scene.parts, deepSleep: plan.deepSleep }) : [];
const work: WorkDef = ex
  ? { ...WORKS.blank, example: ex.id, title: t(ex.title), key: `blank:${ex.id}` }
  : plan
    ? { ...WORKS.custom, title: plan.title, key: plan.wkey, checkpoints: customLevels.filter((l) => !l.manual).map((l) => l.id) }
    : (WORKS[want ?? 'weather'] ?? WORKS.weather);
// &cp=04: preselect this checkpoint (old levels.html#04 redirects here); ignored if not in this work
const cp = params.get('cp');
if (ex) pushRecent({ kind: 'example', id: ex.id, title: ex.title, at: Date.now() });
document.title = ex ? t('{title} · Example · TryBoard', { title: work.title }) : t('{title} · TryBoard', { title: work.title });
initTheme();
initSaved(wkey(work));
syncDockVar();
const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<ShellView />));

const store = createStore<AppState>({
  work: work.id,
  step: 'bench',
  selection: cp && work.checkpoints.includes(cp) ? { kind: 'checkpoint', id: cp } : null,
  env: { temp: 23.5, humidity: 45, pressure: 101325 },
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
  caseParams: loadCaseParams(work.id),
  bom: loadBom(wkey(work)),
  sceneRev: 0,
  editRev: 0,
  runNo: 0,
  hist: { n: 0, cur: -1, seeked: false, busy: false, runs: 0 },
});
const shell = createShell(work.title);
document.getElementById('simtime')!.textContent = '0.00 s';

// Raw serial (#console, read by regression and replay scripts) keeps ~200 KB; the visible dock view stamps lines with sim time
const con = document.getElementById('console') as HTMLPreElement;
function log(text: string) {
  con.appendChild(document.createTextNode(text));
  if (con.textContent!.length > 200_000) con.textContent = con.textContent!.slice(-150_000);
  serial.push(text, store.get().simSeconds);
}

registerStep('shop', shopStep());
registerStep('bench', benchStep());
registerStep('assemble', assembleStep());
registerStep('product', productStep());

// The bench timeline (place / wire / env / run #n / verify; click to go back) lives in benchhist.ts.
// Shop, assemble and product have their own timelines, so this one shows only on the bench
const ownsTimeline = () => store.get().step === 'bench';

(async () => {
  try {
    const placed = customPlaced ?? loadPlaced(wkey(work));
    const session = await createSession(shell.stage, work, store, {
        onConsole: log,
        onConsoleReset: (t) => {
          con.textContent = t;
          serial.reset(t, store.get().simSeconds);
        },
      }, { placed, ...(plan ? { chip: plan.chip, levels: customLevels } : {}) });
    (window as unknown as { __tbApp: unknown }).__tbApp = { store, session };
    const ctx: StepCtx = { work, store, session, shell, ...(plan ? { custom: { plan, levels: customLevels } } : {}) };
    if (plan) Object.assign(globalThis, { __tbCustomLevels: customLevels });
    restoreChecks(ctx);
    restoreAssembly(ctx);
    ctx.hist = createBenchHistory(ctx, { placeLabels: session.scene.parts.map((p) => partLabel(p.type)), placed: !!placed });
    (window as unknown as { __tbApp: Record<string, unknown> }).__tbApp.hist = ctx.hist;
    const app = (window as unknown as { __tbApp: Record<string, unknown> }).__tbApp;
    // For automation (tools/webtest/replay.mjs): input log, 3D button screen positions, replay in the verify worker
    Object.assign(globalThis, {
      __tbInputLog: () => session.sim?.inputLog(),
      __tbButtonPos: (name: 'BOOT' | 'RST') => session.bench.buttonScreenPos(name),
      __tbReplay: async (l: InputLog, seconds: number, pwmPin?: number) => {
        const { replayLog } = await import('../verify');
        return replayLog(session.fwBuf!, l, seconds, pwmPin);
      },
    });
    app.cmdk = createCmdk(ctx);
    app.analyzer = getAnalyzer(ctx);
    store.subscribe(() => ctx.hist!.op({ k: 'scene', scene: session.scene, power: session.power, count: session.scene.parts.length, ...(session.sceneLabel ? { label: session.sceneLabel } : {}) }), ['sceneRev']);
    // Brownout reset (P1-02) is one bench timeline step; seeking to it returns to the reset moment
    session.onBrownout((tSec) => {
      ctx.hist!.event({ k: 'brownout', tSec, v3v3: session.frame.elec?.min3v3 ?? null }, tSec * 1000);
      shell.toast(t('Voltage too low, the chip rebooted ({s} s)', { s: tSec.toFixed(2) }));
    });
    // Verdict button: checkpoint progress on the bench; shop, assemble and product set their own on mount
    const verdict = () => {
      if (store.get().step === 'shop') {
        shell.onVerdict(() => (shell.props.el.scrollTop = 0));
        return;
      }
      if (!ownsTimeline()) return;
      const n = work.checkpoints.length;
      const d = passedCount(ctx);
      shell.setVerdict(n ? t('Checkpoints {d}/{n}', { d, n }) : t('No checkpoints'), n && d === n ? 'ok' : 'idle');
      shell.onVerdict(() => {
        const s = store.get();
        const first = work.checkpoints.find((id) => !s.checks[id]?.ok) ?? work.checkpoints.find((id) => !s.checks[id]?.own) ?? work.checkpoints[0];
        if (!first) return;
        if (s.step !== 'bench') location.hash = 'bench';
        store.set({ selection: { kind: 'checkpoint', id: first } });
      });
    };
    store.subscribe(verdict, ['checks', 'step']);
    verdict();
    store.subscribe((s) => (document.getElementById('simtime')!.textContent = `${s.simSeconds.toFixed(2)} s`), ['simSeconds']);
    const ratioEl = document.getElementById('ratio')!;
    session.onTick((m) => {
      if (!m.running) return;
      ratioEl.textContent = t('{x}× real time', { x: m.ratio.toFixed(2) });
      ratioEl.classList.toggle('slow', m.ratio < 0.9);
    });
    wireChrome(ctx, session);
    startRouter(ctx);
  } catch (e) {
    log(`${t('[TryBoard] Failed to load resources: {err}', { err: String(e) })}\n`);
    setBc({ run: 'idle', boot: { text: t('Failed to load resources: {err}', { err: String(e) }), steps: [], loaded: 0, total: 0 } });
    shell.toast(t('Failed to load resources: {err}', { err: String(e) }));
  }
})();

/** Data and actions for top bar, dock and bench overlays (U-04): the shell only knows chrome.ts; wire session and timeline here */
function wireChrome(ctx: StepCtx, session: Awaited<ReturnType<typeof createSession>>) {
  const hist = ctx.hist!;
  const benchOnly = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
    if (store.get().step === 'bench') f(...a);
  };
  let paused = false;
  const runState = () => {
    const s = store.get();
    const run = s.hist.busy ? 'busy' : s.hist.seeked ? 'seek' : paused ? 'pause' : s.running ? 'run' : session.sim ? 'idle' : session.fwName ? 'loading' : 'nofw';
    // Undo on the shop step walks the BOM history; elsewhere it walks the bench timeline
    const shop = s.step === 'shop';
    const undo = shop ? s.bom.cur > 0 : !s.hist.busy && s.hist.cur > 0;
    const redo = shop ? s.bom.cur < s.bom.ops.length - 1 : !s.hist.busy && s.hist.cur < s.hist.n - 1;
    setBc({ run, undo, redo, runs: s.hist.runs, room: s.env.temp, fw: session.fwName, chip: session.chip });
  };
  store.subscribe(runState, ['running', 'hist', 'env', 'bom', 'step']);
  session.onBoot(() => {
    paused = false;
    // Each power-up is a new worker: resend the speed
    if (bc.get().speed !== 1) session.sim?.speed(bc.get().speed);
    setBc({ boot: null });
    runState();
  });
  if (session.sim) setBc({ boot: null });
  runState();

  const benchUndo = benchOnly(() => {
    const h = store.get().hist;
    if (!h.busy && h.cur > 0) void hist.seek(h.cur - 1);
  });
  const benchRedo = benchOnly(() => {
    const h = store.get().hist;
    if (!h.busy && h.cur < h.n - 1) void hist.seek(h.cur + 1);
  });
  actions.undo = () => (store.get().step === 'shop' ? actions.shopUndo?.(-1) : benchUndo());
  actions.redo = () => (store.get().step === 'shop' ? actions.shopUndo?.(1) : benchRedo());
  actions.pause = () => {
    session.sim?.pause();
    paused = true;
    runState();
  };
  actions.resume = () => {
    if (store.get().hist.seeked) hist.resume();
    else session.sim?.resume();
    paused = false;
    runState();
  };
  actions.reboot = () => {
    paused = false;
    session.reboot();
  };
  actions.speed = (f) => {
    session.sim?.speed(f);
    setBc({ speed: f });
  };
  // Sound (muted by default): the click is the user gesture that creates / resumes the AudioContext
  const syncSound = () => setBc({ sound: { has: session.audio.hasSound, on: !session.audio.state.muted } });
  actions.sound = () => void session.audio.setMuted(!session.audio.state.muted).then(syncSound);
  store.subscribe(syncSound, ['sceneRev']);
  syncSound();
  actions.uart = (text) => session.sim?.uart(text);
  actions.usbCdc = (text) => session.sim?.usbCdc(text);
  // On first enumeration switch the dock to the USB tab so keyboard input and CDC echo are in view
  session.onUsb((v) => {
    usbFeed.update(v);
    if (!!v === bc.get().usb) return;
    setBc({ usb: !!v });
    if (v) setDock({ tab: 'usb', collapsed: false });
    else if (bc.get().dock.tab === 'usb') setDock({ tab: 'serial' });
  });
  // BLE (C-01): show and switch to the Bluetooth tab once firmware uses it; hide it when it stops (firmware change)
  actions.ble = (cmd) => session.sim?.ble(cmd);
  bleFeed.subscribe(() => {
    const has = bleFeed.get().state !== 0;
    if (has === bc.get().ble) return;
    setBc({ ble: has });
    if (has) setDock({ tab: 'ble', collapsed: false });
    else if (bc.get().dock.tab === 'ble') setDock({ tab: 'serial' });
  });
  // New firmware: check the image header (magic 0xE9, chip id) first; on mismatch don't power up, show a check card
  actions.pickFirmware = async (f) => {
    const buf = await f.arrayBuffer();
    const r = fwCheck(buf, session.chip);
    if (!r.ok) {
      overlay('fwcheck', <FwCheckCard name={f.name} res={r} onClose={() => overlay('fwcheck', null)} />);
      return;
    }
    overlay('fwcheck', null);
    const onBench = store.get().step === 'bench';
    if (!onBench) location.hash = 'bench';
    // Toast only once the new run is up, so "powered up" doesn't precede the timeline's "Run #n"
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      off();
      const id = onBench ? actions.checkUpload?.(buf, f.name) : null;
      const kb = (buf.byteLength / 1024).toFixed(0);
      shell.toast(id ? t('Switched to {name} ({kb} KB), powered up again; also verifying checkpoint {id}', { name: f.name, kb, id }) : t('Switched to {name} ({kb} KB), powered up again', { name: f.name, kb }));
    };
    const off = session.onBoot(fire);
    // If this power-up fails, don't leave the listener for the next one
    setTimeout(fire, 3000);
    session.loadFirmware(buf, f.name);
    pushRecent({ kind: 'file', name: f.name, at: Date.now() });
  };
  // Back to the work's reference firmware after uploading your own .bin; blank works have none
  if (work.example && !ex)
    actions.loadRef = async () => {
      const buf = await fetchBuf(`./fw/${work.example}/flash.bin`);
      if (store.get().step !== 'bench') location.hash = 'bench';
      session.loadFirmware(buf, `${work.example}/flash.bin`);
      shell.toast(t('Back to the reference firmware, powered up again'));
    };
  actions.exportInputs = async () => {
    if (!session.sim) return shell.toast(t('The simulator is not running yet, so there is no input log'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toScript(await session.sim.inputLog())], { type: 'text/plain' }));
    a.download = `${session.fwName || 'tryboard'}-inputs.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    shell.toast(t('Input log exported: tryboard run --inputs replays it byte for byte'));
  };
  const curLevel = () => {
    const s = store.get();
    const sel = s.selection?.kind === 'checkpoint' ? s.selection.id : null;
    const id = sel ?? work.checkpoints.find((x) => !s.checks[x]?.ok) ?? work.checkpoints.find((x) => !s.checks[x]?.own) ?? work.checkpoints[0];
    return session.levels.find((l) => l.id === id) ?? null;
  };
  // Picker works: brief = the picker's AI brief + generated checkpoints with their pass criteria
  const customBrief = plan ? () => [briefMarkdown(plan.state), '', t('## Checkpoints (the browser judges these)'), ...customLevels.map((l) => `- ${l.id} ${t(l.title)}: ${l.manual ? t('Needs real hardware; not judged in the browser') : t(l.pass)}`)].join('\n') : null;
  actions.brief = customBrief
    ? async () => {
        try {
          await navigator.clipboard.writeText(customBrief());
          shell.toast(t('Brief for the AI copied'));
        } catch {
          shell.toast(t('The browser blocked the clipboard: the brief is in the checkpoint side panel, copy it by hand'));
        }
      }
    : work.checkpoints.length
    ? async () => {
        const l = curLevel();
        if (!l) return;
        try {
          await navigator.clipboard.writeText(t(l.brief));
          shell.toast(t('Brief for checkpoint {id} copied', { id: l.id }));
        } catch {
          store.set({ selection: { kind: 'checkpoint', id: l.id } });
          shell.toast(t('The browser blocked the clipboard: the brief is in the side panel, copy it by hand'));
        }
      }
    : undefined;
  actions.selectCheckpoint = (id) => {
    if (store.get().step !== 'bench') location.hash = 'bench';
    store.set({ selection: { kind: 'checkpoint', id } });
  };
  const ana = getAnalyzer(ctx);
  actions.analyzer = (open) => (open ? ana.open() : ana.close());
  // The analyzer also opens from the toolbar / ⌘K: follow it with the dock tab, back to serial on close
  new MutationObserver(() => {
    const open = document.body.classList.contains('ana-open');
    const d = bc.get().dock;
    if (open && d.tab !== 'analyzer') setDock({ tab: 'analyzer', collapsed: false });
    else if (!open && d.tab === 'analyzer') setDock({ tab: 'serial' });
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  actions.view = (k) => session.bench.view?.(k, store.get().selection);

  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
    const el = e.target as HTMLElement;
    if (el.closest('input,textarea,select,[contenteditable]')) return;
    e.preventDefault();
    if (e.shiftKey) actions.redo?.();
    else actions.undo?.();
  });

  // Step locks are hints only (each step explains itself); clicking still enters.
  // Shop done = "Next: bench" pressed once (placement saved locally); sceneRev alone would lose the tick on reload
  const shopPlaced = !!loadPlaced(wkey(work));
  const progress = () => {
    const s = store.get();
    const n = work.checkpoints.length;
    const d = passedCount(ctx);
    const allOk = !n || d === n;
    const lockAsm = n && !allOk ? t('Unlocks once all {n} bench checkpoints pass ({d}/{n}, built-in firmware counts)', { n, d }) : undefined;
    const asmDone = !!s.assembly && s.assembly.placed.length >= s.assembly.total && s.assembly.total > 0;
    setBc({
      locks: { assemble: lockAsm, product: lockAsm ?? (n && !asmDone ? t('Unlocks once assembly is complete') : undefined) },
      done: { shop: s.sceneRev > 0 || shopPlaced, bench: n > 0 && allOk, assemble: asmDone, product: !!s.assembly?.retest },
      retest: s.assembly?.retest ?? null,
      checkpoints: work.checkpoints.map((id): CpRow => {
        const l = session.levels.find((x) => x.id === id);
        const r = s.checks[id];
        const state = s.verifying === id ? 'run' : r?.ok ? (r.own ? 'ok' : 'ref') : r && !r.ok ? 'bad' : 'todo';
        return { id, title: l?.title ? t(l.title) : id, state, note: r ? r.who : l?.pass ? t(l.pass) : '' };
      }),
    });
  };
  store.subscribe(progress, ['checks', 'verifying', 'assembly', 'sceneRev']);
  progress();

  // Issues tab: brownout resets from the sim; wiring-rule issues are added by the bench with a wire: prefix
  const brown: Issue[] = [];
  session.onBrownout((tSec) => {
    brown.push({ id: `brown:${brown.length}`, level: 'block', title: t('Voltage too low, the chip rebooted'), detail: t('At {s} s 3V3 dropped below the threshold (brownout reset)', { s: tSec.toFixed(2) }), go: () => setDock({ tab: 'runs' }) });
    setBc({ issues: [...bc.get().issues.filter((x) => !x.id.startsWith('brown:')), ...brown.slice(-5)] });
    // Brownout explainer: bench only, once per power-up (a jittering servo resets several times in a row)
    if (store.get().step !== 'bench' || bc.get().overlays.brown) return;
    const servo = session.scene.parts.some((p) => p.type === 'servo');
    overlay(
      'brown',
      <BrownoutBanner
        t={tSec}
        v={session.frame.elec?.min3v3 ?? null}
        servo={servo}
        onPower={() => {
          overlay('brown', null);
          store.set({ selection: { kind: 'power', id: 'usb' } });
        }}
        onClose={() => overlay('brown', null)}
      />,
    );
  });
  store.subscribe((s, prev) => s.step !== prev.step && s.step !== 'bench' && overlay('brown', null), ['step']);

  // Toast when your own firmware newly passes a checkpoint (restored progress and reference firmware don't count)
  store.subscribe((s, prev) => {
    const n = work.checkpoints.length;
    for (const id of work.checkpoints) {
      const r = s.checks[id];
      const was = prev.checks[id];
      if (!(r?.ok && r.own) || (was?.ok && was.own)) continue;
      const d = passedCount(ctx, s);
      const l = session.levels.find((x) => x.id === id);
      const title = l?.title ? t(l.title) : '';
      ctx.shell.toast(
        d === n
          ? plan
            ? t('Checkpoint {id} "{title}" passed, all {n} passed: next, make it real', { id, title, n })
            : t('Checkpoint {id} "{title}" passed, all {n} passed: assembly unlocked', { id, title, n })
          : t('Checkpoint {id} "{title}" passed ({d}/{n})', { id, title, d, n }),
      );
    }
  }, ['checks']);
}
