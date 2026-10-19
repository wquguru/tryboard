// Bench timeline controller: wires history.ts pure functions to the Session and the shell timeline.
// Rewind design: docs/DECISIONS.md, entry dated 2026-10-16 (bench timeline rewind).
import { fingerprint } from '../checks';
import { t } from '../i18n';
import type { Snapshot } from '../worker';
import { fold, replayInputs, seekTarget, summarize, truncate, type BenchOp, type BenchStep, type RunRec } from './history';
import type { TimelineStep } from './timeline';
import type { CheckOutcome, StepCtx } from './types';

export interface SeekResult {
  step: number;
  run: number;
  untilMs: number;
  fingerprint: string;
  /** When the target is a run's end: the fingerprint computed back then. */
  expected: string | null;
  same: boolean | null;
}

export interface BenchHistory {
  steps(): BenchStep[];
  runs(): RunRec[];
  /** Record a step and return it (a slider drag updates it in place within one gesture). */
  op(op: BenchOp): BenchStep;
  /** Rewind to step i. */
  seek(i: number): Promise<SeekResult | null>;
  /** Continue live from the rewind point (counts as a new edit: later steps are dropped). */
  resume(): void;
  lastSeek(): SeekResult | null;
  /** Redraw the timeline bar. */
  render(): void;
  /** Sim-reported event (brownout): worker supplies the time; ignored while rewound. */
  event(op: BenchOp, tMs: number): void;
}

const label = (op: BenchOp, runs: RunRec[]): TimelineStep => {
  switch (op.k) {
    case 'place':
      return { id: '', icon: '+', label: t('Place {part}', { part: op.label }) };
    case 'wire':
      return { id: '', icon: '~', label: t('Wire up') };
    case 'scene':
      return { id: '', icon: '⇢', label: op.label ?? t('Placed {n} parts from the list', { n: op.count }) };
    case 'run': {
      const r = runs.find((x) => x.n === op.n);
      return { id: '', icon: '▶', label: t('Run #{n}', { n: op.n }), status: r?.snap ? undefined : 'run' };
    }
    case 'env':
      return { id: '', icon: '°', label: t('Room {temp} °C', { temp: op.env.temp.toFixed(1) }) };
    case 'heat':
      return { id: '', icon: '≈', label: op.part ? t('Heat source near BME280') : t('Heat source removed') };
    case 'power':
      return { id: '', icon: '⚡', label: op.ext5v ? t('Switch to external 5 V') : t('Back to USB power') };
    case 'wiring':
      return { id: '', icon: '~', label: op.label };
    case 'check':
      return { id: '', icon: '◎', label: t('Checkpoint {id}', { id: op.id }), status: op.outcome.ok ? 'ok' : 'bad' };
    case 'brownout':
      return { id: '', icon: '↯', label: op.count && op.count > 1 ? t('Brownout reset {t} s ×{n}', { t: op.tSec.toFixed(2), n: op.count }) : t('Brownout reset {t} s', { t: op.tSec.toFixed(2) }), status: 'bad' };
  }
};

export function createBenchHistory(ctx: StepCtx, init: { placeLabels: string[]; placed: boolean }): BenchHistory {
  const { session, store, shell } = ctx;
  let steps: BenchStep[] = [];
  let runs: RunRec[] = [];
  /** Current step; -1 = follow the latest. */
  let cur = -1;
  /** Rewind point snapshot (a new edit truncates that run here). */
  let seeked: { res: SeekResult; snap: Snapshot } | null = null;
  let busy = false;
  let last: SeekResult | null = null;
  const baseChecks: Record<string, CheckOutcome> = { ...store.get().checks };
  const baseScene = session.scene;
  const basePower = session.power;
  const baseEnv = { ...store.get().env };
  const ownsTimeline = () => store.get().step === 'bench';
  const curIndex = () => (cur < 0 ? steps.length - 1 : cur);
  const openRun = () => [...runs].reverse().find((r) => !r.snap) ?? null;
  const currentRun = () => (seeked ? seeked.res.run : (openRun()?.n ?? runs[runs.length - 1]?.n ?? 1));

  function sync() {
    store.set({ hist: { n: steps.length, cur: curIndex(), seeked: !!seeked, busy, runs: runs.length } });
    if (ownsTimeline()) render();
  }
  function render() {
    shell.timeline.setSteps(steps.map((s, i) => ({ ...label(s.op, runs), id: `${s.op.k}:${i}` })));
    shell.timeline.setCurrent(curIndex());
  }

  /** New edit mid-timeline: drop later steps and cut the rewound run at the rewind moment. */
  function branch() {
    if (cur >= 0 && cur < steps.length - 1) {
      const tr = truncate(steps, runs, cur);
      steps = tr.steps;
      runs = tr.runs;
    }
    if (seeked) {
      const r = runs.find((x) => x.n === seeked!.res.run);
      if (r) {
        r.snap = seeked.snap;
        r.fingerprint = seeked.res.fingerprint;
      }
    }
    cur = -1;
  }

  function op(o: BenchOp): BenchStep {
    const wasSeeked = !!seeked;
    branch();
    const st: BenchStep = { op: o, run: o.k === 'run' ? o.n : currentRun(), tMs: o.k === 'run' ? 0 : null };
    steps.push(st);
    // Stamp before applying: the worker handles mark before later inputs, so this step's time ≤ its first input.
    if (st.tMs === null) {
      if (!session.sim || session.bootCount === 0) st.tMs = 0;
      else session.mark().then((ms) => (st.tMs = ms));
    }
    // Env/heat change at a rewind point resumes this run from here (inputs must hit a running sim).
    if (wasSeeked && (o.k === 'env' || o.k === 'heat')) {
      const r = runs.find((x) => x.n === seeked!.res.run);
      if (r) {
        r.snap = null;
        r.fingerprint = null;
      }
      seeked = null;
      session.continueRun();
    } else if (o.k !== 'run' && wasSeeked) {
      // Ops that do not affect the sim (power display, rewiring, checks): stay rewound, but on a new branch.
      seeked = { res: { ...seeked!.res, step: steps.length - 1 }, snap: seeked!.snap };
    }
    sync();
    return st;
  }

  function event(o: BenchOp, tMs: number) {
    if (seeked || busy) return;
    // Merge a burst of resets < 0.5 s apart into one counted step; rewinding lands on the first one.
    const prev = steps[steps.length - 1];
    if (o.k === 'brownout' && prev?.op.k === 'brownout' && prev.run === currentRun() && prev.tMs !== null && tMs - prev.tMs < 500 + (prev.op.count ?? 1) * 50) {
      prev.op = { ...prev.op, count: (prev.op.count ?? 1) + 1 };
      sync();
      return;
    }
    steps.push({ op: o, run: currentRun(), tMs });
    sync();
  }

  session.onBoot(() => {
    branch();
    seeked = null;
    const n = (runs[runs.length - 1]?.n ?? 0) + 1;
    runs.push({ n, fwName: session.fwName, fw: session.fwBuf!, chip: session.chip, ext5v: !!session.power?.ext5v, heat: session.heat, snap: null, fingerprint: null });
    store.set({ runNo: n });
    steps.push({ op: { k: 'run', n }, run: n, tMs: 0 });
    sync();
  });
  session.onRunEnd((snap) => {
    const r = openRun();
    if (!r) return;
    r.snap = snap;
    r.fingerprint = snap.truncated ? t('(serial too long, not computed)') : fingerprint(snap.stdout, snap.report);
    sync();
  });

  async function seek(i: number): Promise<SeekResult | null> {
    if (busy || !steps[i]) return null;
    if (store.get().verifying) {
      shell.toast(t('Checking checkpoints; rewind after the check finishes'));
      return null;
    }
    const live = openRun();
    // Rewinding into the live run: grab its log now (seek ends it).
    if (live && !live.snap) {
      const snap = await session.snapshot();
      if (snap) {
        live.snap = snap;
        live.fingerprint = fingerprint(snap.stdout, snap.report);
      }
    }
    const tgt = seekTarget(steps, i, (n) => runs.find((r) => r.n === n)?.snap?.log.endMs ?? null);
    const rec = tgt && runs.find((r) => r.n === tgt.run);
    if (!tgt || !rec || !rec.snap) {
      shell.toast(t('No run record for this step yet, cannot rewind'));
      return null;
    }
    busy = true;
    sync();
    // Edit state: fold up to step i.
    const f = fold(steps, i);
    session.restoreScene(f.scene ?? baseScene, f.power ?? basePower);
    session.setHeat(f.heat);
    session.setWireMods(f.mods ?? {});
    store.set({ checks: { ...baseChecks, ...f.checks } });
    const inputs = replayInputs(rec.snap.log.events);
    session.fwName = rec.fwName;
    let snap: Snapshot;
    try {
      snap = await session.seek({ flash: rec.fw, i2c: rec.snap.log.i2c, lcd: rec.snap.log.lcd, servo: rec.snap.log.servo, power: rec.snap.log.power, encoder: rec.snap.log.encoder, sonar: rec.snap.log.sonar, dht11: rec.snap.log.dht11, touchInt: rec.snap.log.touchInt, env: inputs.env0 ?? f.env ?? baseEnv, events: inputs.events, untilMs: tgt.untilMs });
    } finally {
      busy = false;
    }
    const fp = fingerprint(snap.stdout, snap.report);
    const atEnd = Math.round(tgt.untilMs * 160000) === Math.round((rec.snap.log.endMs ?? -1) * 160000);
    const expected = atEnd ? rec.fingerprint : null;
    last = { step: i, run: rec.n, untilMs: tgt.untilMs, fingerprint: fp, expected, same: expected === null ? null : expected === fp };
    seeked = { res: last, snap };
    (globalThis as { __tbSeekSnap?: Snapshot }).__tbSeekSnap = snap;
    cur = i;
    store.set({ runNo: rec.n });
    sync();
    return last;
  }

  function resume() {
    if (!seeked) return;
    const n = seeked.res.run;
    branch();
    const r = runs.find((x) => x.n === n);
    if (r) {
      r.snap = null;
      r.fingerprint = null;
    }
    seeked = null;
    session.continueRun();
    sync();
  }

  // Steps before the first power-on (place, wire, list) count as run 1 at 0 ms.
  for (const l of init.placeLabels) steps.push({ op: { k: 'place', label: l }, run: 1, tMs: 0 });
  if (init.placeLabels.length) steps.push({ op: { k: 'wire' }, run: 1, tMs: 0 });
  if (init.placed) steps.push({ op: { k: 'scene', scene: session.scene, power: session.power, count: session.scene.parts.length }, run: 1, tMs: 0 });

  shell.timeline.onSeek((i) => {
    if (!ownsTimeline()) return;
    void seek(i).then((r) => {
      if (!r) return;
      const s = steps[i];
      const what = label(s.op, runs).label;
      const v = { what, run: r.run, t: (r.untilMs / 1000).toFixed(2) };
      shell.toast(r.same === null ? t('Back to "{what}" · run #{run} at {t} s', v) : r.same ? t('Back to "{what}" · run #{run} at {t} s · identical to back then', v) : t('Back to "{what}" · run #{run} at {t} s · differs from back then', v));
    });
  });
  store.subscribe(() => ownsTimeline() && render(), ['step']);
  // Already powered on (createSession starts the sim): record run 1 retroactively.
  if (session.bootCount > 0 && !runs.length) {
    runs.push({ n: 1, fwName: session.fwName, fw: session.fwBuf!, chip: session.chip, ext5v: !!session.power?.ext5v, heat: null, snap: null, fingerprint: null });
    steps.push({ op: { k: 'run', n: 1 }, run: 1, tMs: 0 });
    store.set({ runNo: 1 });
  }
  sync();

  return {
    steps: () => steps,
    runs: () => runs,
    op,
    seek,
    resume,
    lastSeek: () => last,
    render,
    event,
  };
}

export { summarize };
