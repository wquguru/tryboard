// 工作台入口：app.html?work=weather#bench。外壳、实时模拟、3D 台面各一份；四个步骤注册到路由上。
import { createStore } from './store';
import { createShell, registerStep, startRouter } from './shell';
import { createSession, WORKS } from './session';
import { benchStep, passedCount, restoreChecks } from './steps/bench';
import { assembleStep, restoreAssembly } from './steps/assemble';
import { productStep } from './steps/product';
import { loadBom, loadPlaced, shopStep } from './steps/shop';
import type { AppState, StepCtx, WorkId } from './types';
import type { TimelineStep } from './timeline';

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

// 时间线：本任务只显示"放零件 / 连线 / 运行 #n / 验收"，回退由 P0-03 接 onSeek
// 采购、组装、成品各有自己的时间线（清单变更 / 装配步骤 / 事件），这份只在实验台显示
const history: TimelineStep[] = [];
const ownsTimeline = () => store.get().step === 'bench';
function renderHistory() {
  shell.timeline.setSteps(history);
  shell.timeline.setCurrent(history.length - 1);
}
function pushHistory(s: TimelineStep) {
  history.push(s);
  if (ownsTimeline()) renderHistory();
}
shell.timeline.onSeek((_i, s) => ownsTimeline() && shell.toast(`回到「${s.label}」由后续任务实现（P0-03）`));

(async () => {
  try {
    const placed = loadPlaced(work.id);
    const session = await createSession(shell.stage, work, store, { onConsole: log }, { placed });
    (window as unknown as { __tbApp: unknown }).__tbApp = { store, session };
    const ctx: StepCtx = { work, store, session, shell };
    restoreChecks(ctx);
    restoreAssembly(ctx);
    for (const p of session.scene.parts) pushHistory({ id: `place:${p.type}`, icon: '+', label: `放 ${p.type === 'bme280' ? 'BME280' : p.type === 'oled' ? 'OLED' : p.type === 'servo' ? 'SG90' : p.type === 'gc9a01' ? '圆屏' : p.type}` });
    if (session.scene.parts.length) pushHistory({ id: 'wire', icon: '~', label: '连线' });
    if (placed) pushHistory({ id: 'scene:placed', icon: '⇢', label: `按清单摆上 ${session.scene.parts.length} 件` });
    store.subscribe((s, prev) => {
      if (s.run > prev.run) {
        for (const h of history) if (h.id.startsWith('run:')) h.status = undefined;
        pushHistory({ id: `run:${s.run}`, icon: '▶', label: `运行 #${s.run}`, status: 'run' });
      }
      for (const [id, r] of Object.entries(s.checks)) if (prev.checks[id] !== r && r.rows.length) pushHistory({ id: `check:${id}:${history.length}`, icon: '◎', label: `验收 ${id}`, status: r.ok ? 'ok' : 'bad' });
    }, ['run', 'checks']);
    store.subscribe((s) => pushHistory({ id: `scene:${s.sceneRev}`, icon: '⇢', label: `按清单摆上 ${session.scene.parts.length} 件` }), ['sceneRev']);
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
    store.subscribe(() => ownsTimeline() && renderHistory(), ['step']);
    verdict();
    store.subscribe((s) => (document.getElementById('simtime')!.textContent = `${s.simSeconds.toFixed(2)} s`), ['simSeconds']);
    startRouter(ctx);
  } catch (e) {
    log(`[试板] 资源加载失败：${e}\n`);
    shell.toast(`资源加载失败：${e}`);
  }
})();
