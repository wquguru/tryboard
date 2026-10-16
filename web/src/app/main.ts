// 工作台入口：app.html?work=weather#bench。外壳、实时模拟、3D 台面各一份；四个步骤注册到路由上。
import { createStore } from './store';
import { createShell, registerStep, startRouter } from './shell';
import { createSession, WORKS } from './session';
import { benchStep, passedCount, restoreChecks } from './steps/bench';
import { assembleStep, restoreAssembly } from './steps/assemble';
import { productStep } from './steps/product';
import { loadBom, loadPlaced, shopStep } from './steps/shop';
import type { AppState, StepCtx, WorkId } from './types';
import { createBenchHistory } from './benchhist';
import { partLabel } from './wiring';

export { registerStep } from './shell';

const params = new URLSearchParams(location.search);
const want = params.get('work') as WorkId | null;
const work = WORKS[want ?? 'weather'] ?? WORKS.weather;
// &cp=04：打开时选中这个检查点（旧关卡页 levels.html#04 重定向过来用）；不属于这个作品就忽略
const cp = params.get('cp');
document.title = `${work.title} · 试板 TryBoard`;
document.getElementById('workName')!.textContent = work.title;

const store = createStore<AppState>({
  work: work.id,
  step: 'bench',
  selection: cp && work.checkpoints.includes(cp) ? { kind: 'checkpoint', id: cp } : null,
  env: { temp: 23.5, humidity: 45, pressure: 101325 },
  run: 0,
  simSeconds: 0,
  running: false,
  reading: null,
  checks: {},
  verifying: null,
  verifyProgress: 0,
  assembly: null,
  bom: loadBom(work.id),
  sceneRev: 0,
  editRev: 0,
  runNo: 0,
  hist: { n: 0, cur: -1, seeked: false, busy: false, runs: 0 },
});
const shell = createShell();

// 左栏底的串口：只留最近约 200 KB
const con = document.getElementById('console') as HTMLPreElement;
function log(text: string) {
  const atBottom = con.scrollTop + con.clientHeight >= con.scrollHeight - 8;
  con.appendChild(document.createTextNode(text));
  if (con.textContent!.length > 200_000) con.textContent = con.textContent!.slice(-150_000);
  if (atBottom) con.scrollTop = con.scrollHeight;
}

registerStep('shop', shopStep());
registerStep('bench', benchStep());
registerStep('assemble', assembleStep());
registerStep('product', productStep());

// 实验台时间线（放零件 / 连线 / 改环境 / 运行 #n / 验收……，点回去 = 回到那一刻）在 benchhist.ts；
// 采购、组装、成品各有自己的时间线（清单变更 / 装配步骤 / 事件），这份只在实验台显示
const ownsTimeline = () => store.get().step === 'bench';

(async () => {
  try {
    const placed = loadPlaced(work.id);
    const session = await createSession(shell.stage, work, store, { onConsole: log, onConsoleReset: (t) => (con.textContent = t) }, { placed });
    (window as unknown as { __tbApp: unknown }).__tbApp = { store, session };
    const ctx: StepCtx = { work, store, session, shell };
    restoreChecks(ctx);
    restoreAssembly(ctx);
    ctx.hist = createBenchHistory(ctx, { placeLabels: session.scene.parts.map((p) => partLabel(p.type)), placed: !!placed });
    (window as unknown as { __tbApp: Record<string, unknown> }).__tbApp.hist = ctx.hist;
    store.subscribe(() => ctx.hist!.op({ k: 'scene', scene: session.scene, power: session.power, count: session.scene.parts.length }), ['sceneRev']);
    // 结论按钮：实验台显示检查点进度；采购、组装、成品挂载时自己设
    const verdict = () => {
      if (store.get().step === 'shop') {
        shell.onVerdict(() => (document.getElementById('props')!.scrollTop = 0));
        return;
      }
      if (!ownsTimeline()) return;
      const n = work.checkpoints.length;
      const d = passedCount(ctx);
      shell.setVerdict(n ? `检查点 ${d}/${n}` : '没有检查点', n && d === n ? 'ok' : 'idle');
      shell.onVerdict(() => {
        const s = store.get();
        const first = work.checkpoints.find((id) => !(s.checks[id]?.ok && s.checks[id].own)) ?? work.checkpoints[0];
        if (!first) return;
        if (s.step !== 'bench') location.hash = 'bench';
        store.set({ selection: { kind: 'checkpoint', id: first } });
      });
    };
    store.subscribe(verdict, ['checks', 'step']);
    verdict();
    store.subscribe((s) => (document.getElementById('simtime')!.textContent = `${s.simSeconds.toFixed(2)} s`), ['simSeconds']);
    startRouter(ctx);
  } catch (e) {
    log(`[试板] 资源加载失败：${e}\n`);
    shell.toast(`资源加载失败：${e}`);
  }
})();
