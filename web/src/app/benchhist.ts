// 实验台时间线的控制器：把 history.ts 的纯函数接到 Session（实时模拟）和外壳时间线条上。
// 回退的实现方式见 docs/DECISIONS.md「2026-10-16 · 实验台时间线回退」。
import { fingerprint } from '../checks';
import type { Snapshot } from '../worker';
import { fold, replayInputs, seekTarget, summarize, truncate, type BenchOp, type BenchStep, type RunRec } from './history';
import type { TimelineStep } from './timeline';
import type { CheckOutcome, StepCtx } from './types';

export interface SeekResult {
  step: number;
  run: number;
  untilMs: number;
  fingerprint: string;
  /** 回到的是一次运行的收尾时刻：当时收尾算的指纹 */
  expected: string | null;
  same: boolean | null;
}

export interface BenchHistory {
  steps(): BenchStep[];
  runs(): RunRec[];
  /** 记一步。返回这一步（拖滑块时同一手势里改它的值，不另记） */
  op(op: BenchOp): BenchStep;
  /** 回到第 i 步 */
  seek(i: number): Promise<SeekResult | null>;
  /** 停在回退点时从那一刻接着实时跑（等于做了一个新操作，后面的步骤丢掉） */
  resume(): void;
  lastSeek(): SeekResult | null;
  /** 时间线条重画 */
  render(): void;
  /** 模拟器报告的事件（欠压复位）：记一步，时刻由 worker 给，停在回退点时不记 */
  event(op: BenchOp, tMs: number): void;
}

const label = (op: BenchOp, runs: RunRec[]): TimelineStep => {
  switch (op.k) {
    case 'place':
      return { id: '', icon: '+', label: `放 ${op.label}` };
    case 'wire':
      return { id: '', icon: '~', label: '连线' };
    case 'scene':
      return { id: '', icon: '⇢', label: `按清单摆上 ${op.count} 件` };
    case 'run': {
      const r = runs.find((x) => x.n === op.n);
      return { id: '', icon: '▶', label: `运行 #${op.n}`, status: r?.snap ? undefined : 'run' };
    }
    case 'env':
      return { id: '', icon: '°', label: `室温 ${op.env.temp.toFixed(1)} °C` };
    case 'heat':
      return { id: '', icon: '≈', label: op.part ? '热源靠近 BME280' : '移开热源' };
    case 'power':
      return { id: '', icon: '⚡', label: op.ext5v ? '换外接 5 V' : '换回 USB 供电' };
    case 'wiring':
      return { id: '', icon: '~', label: op.label };
    case 'check':
      return { id: '', icon: '◎', label: `检查点 ${op.id}`, status: op.outcome.ok ? 'ok' : 'bad' };
    case 'brownout':
      return { id: '', icon: '↯', label: `欠压复位 ${op.tSec.toFixed(2)} s${op.count && op.count > 1 ? ` ×${op.count}` : ''}`, status: 'bad' };
  }
};

export function createBenchHistory(ctx: StepCtx, init: { placeLabels: string[]; placed: boolean }): BenchHistory {
  const { session, store, shell } = ctx;
  let steps: BenchStep[] = [];
  let runs: RunRec[] = [];
  /** 当前停在第几步；-1 = 跟着最新一步 */
  let cur = -1;
  /** 停在回退点：那一刻的快照（之后做新操作时，这次运行就截在这里） */
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

  /** 停在中间时做新操作：丢掉后面的步骤；停在回退点的那次运行截到回退的时刻 */
  function branch() {
    if (cur >= 0 && cur < steps.length - 1) {
      const t = truncate(steps, runs, cur);
      steps = t.steps;
      runs = t.runs;
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
    // 先要时间戳再施加：mark 在 worker 里先于随后的输入处理，所以这一步的时刻 ≤ 它带来的第一条输入
    if (st.tMs === null) {
      if (!session.sim || session.bootCount === 0) st.tMs = 0;
      else session.mark().then((t) => (st.tMs = t));
    }
    // 回退点上改环境 / 热源 = 从这一刻接着跑这次运行（输入要施加到正在走的模拟上）
    if (wasSeeked && (o.k === 'env' || o.k === 'heat')) {
      const r = runs.find((x) => x.n === seeked!.res.run);
      if (r) {
        r.snap = null;
        r.fingerprint = null;
      }
      seeked = null;
      session.continueRun();
    } else if (o.k !== 'run' && wasSeeked) {
      // 不影响模拟的操作（供电显示、改接线、验收）：留在回退点，但已经是新分支
      seeked = { res: { ...seeked!.res, step: steps.length - 1 }, snap: seeked!.snap };
    }
    sync();
    return st;
  }

  function event(o: BenchOp, tMs: number) {
    if (seeked || busy) return;
    // 一串连续复位（掉压后反复复位）相隔不到 0.5 s 的并成一步，记次数；回到这一步 = 回到第一次复位
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
    r.fingerprint = snap.truncated ? '（串口太长，没算）' : fingerprint(snap.stdout, snap.report);
    sync();
  });

  async function seek(i: number): Promise<SeekResult | null> {
    if (busy || !steps[i]) return null;
    if (store.get().verifying) {
      shell.toast('正在验收检查点，验收完再回退');
      return null;
    }
    const live = openRun();
    // 回到正在跑的这次运行：先拿此刻的日志（seek 会把它收尾）
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
      shell.toast('这一步还没有运行记录，回不去');
      return null;
    }
    busy = true;
    sync();
    // 编辑状态：折叠到第 i 步
    const f = fold(steps, i);
    session.restoreScene(f.scene ?? baseScene, f.power ?? basePower);
    session.setHeat(f.heat);
    session.setWireMods(f.mods ?? {});
    store.set({ checks: { ...baseChecks, ...f.checks } });
    const inputs = replayInputs(rec.snap.log.events);
    session.fwName = rec.fwName;
    let snap: Snapshot;
    try {
      snap = await session.seek({ flash: rec.fw, i2c: rec.snap.log.i2c, lcd: rec.snap.log.lcd, servo: rec.snap.log.servo, power: rec.snap.log.power, encoder: rec.snap.log.encoder, sonar: rec.snap.log.sonar, touchInt: rec.snap.log.touchInt, env: inputs.env0 ?? f.env ?? baseEnv, events: inputs.events, untilMs: tgt.untilMs });
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

  // 第一次上电前的步骤：放零件、连线、按清单摆上（算第 1 次运行的 0 ms）
  for (const l of init.placeLabels) steps.push({ op: { k: 'place', label: l }, run: 1, tMs: 0 });
  if (init.placeLabels.length) steps.push({ op: { k: 'wire' }, run: 1, tMs: 0 });
  if (init.placed) steps.push({ op: { k: 'scene', scene: session.scene, power: session.power, count: session.scene.parts.length }, run: 1, tMs: 0 });

  shell.timeline.onSeek((i) => {
    if (!ownsTimeline()) return;
    void seek(i).then((r) => {
      if (!r) return;
      const s = steps[i];
      const what = label(s.op, runs).label;
      shell.toast(`回到「${what}」· 运行 #${r.run} 的 ${(r.untilMs / 1000).toFixed(2)} s${r.same === null ? '' : r.same ? ' · ✓ 指纹一致' : ' · ✗ 指纹不同'}`);
    });
  });
  store.subscribe(() => ownsTimeline() && render(), ['step']);
  // 已经上电过（createSession 里就启动了模拟），补记第 1 次运行
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
