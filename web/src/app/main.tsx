// 工作台入口：app.html?work=weather#bench。外壳、实时模拟、3D 台面各一份；四个步骤注册到路由上。
// 外壳先由 React 同步画出来（#stage 等节点要在 createSession 之前就在），之后的逻辑与原来相同。
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
import type { AppState, StepCtx, WorkId } from './types';
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
import { toScript } from '../inputlog';

export { registerStep } from './shell';

const params = new URLSearchParams(location.search);
const want = params.get('work') as WorkId | null;
const work = WORKS[want ?? 'weather'] ?? WORKS.weather;
// &cp=04：打开时选中这个检查点（旧关卡页 levels.html#04 重定向过来用）；不属于这个作品就忽略
const cp = params.get('cp');
document.title = `${work.title} · 试板 TryBoard`;
initTheme();
initSaved(work.id);
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
  bom: loadBom(work.id),
  sceneRev: 0,
  editRev: 0,
  runNo: 0,
  hist: { n: 0, cur: -1, seeked: false, busy: false, runs: 0 },
});
const shell = createShell(work.title);
document.getElementById('simtime')!.textContent = '0.00 s';

// 串口原文（#console，回归脚本和重放对拍读它）只留最近约 200 KB；看得见的是底部坞的行视图（按到达时的模拟时刻盖戳）
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

// 实验台时间线（放零件 / 连线 / 改环境 / 运行 #n / 验收……，点回去 = 回到那一刻）在 benchhist.ts；
// 采购、组装、成品各有自己的时间线（清单变更 / 装配步骤 / 事件），这份只在实验台显示
const ownsTimeline = () => store.get().step === 'bench';

(async () => {
  try {
    const placed = loadPlaced(work.id);
    const session = await createSession(shell.stage, work, store, {
        onConsole: log,
        onConsoleReset: (t) => {
          con.textContent = t;
          serial.reset(t, store.get().simSeconds);
        },
      }, { placed });
    (window as unknown as { __tbApp: unknown }).__tbApp = { store, session };
    const ctx: StepCtx = { work, store, session, shell };
    restoreChecks(ctx);
    restoreAssembly(ctx);
    ctx.hist = createBenchHistory(ctx, { placeLabels: session.scene.parts.map((p) => partLabel(p.type)), placed: !!placed });
    (window as unknown as { __tbApp: Record<string, unknown> }).__tbApp.hist = ctx.hist;
    const app = (window as unknown as { __tbApp: Record<string, unknown> }).__tbApp;
    app.cmdk = createCmdk(ctx);
    app.analyzer = getAnalyzer(ctx);
    store.subscribe(() => ctx.hist!.op({ k: 'scene', scene: session.scene, power: session.power, count: session.scene.parts.length, ...(session.sceneLabel ? { label: session.sceneLabel } : {}) }), ['sceneRev']);
    // 欠压复位（P1-02）进实验台时间线：一步，回到它 = 回到复位那一刻
    session.onBrownout((t) => {
      ctx.hist!.event({ k: 'brownout', tSec: t, v3v3: session.frame.elec?.min3v3 ?? null }, t * 1000);
      shell.toast(`欠压复位：3V3 掉到门限以下（${t.toFixed(2)} s）`);
    });
    // 结论按钮：实验台显示检查点进度；采购、组装、成品挂载时自己设
    const verdict = () => {
      if (store.get().step === 'shop') {
        shell.onVerdict(() => (shell.props.el.scrollTop = 0));
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
    wireChrome(ctx, session);
    startRouter(ctx);
  } catch (e) {
    log(`[试板] 资源加载失败：${e}\n`);
    setBc({ run: 'idle', boot: { text: `资源加载失败：${e}`, steps: [], loaded: 0, total: 0 } });
    shell.toast(`资源加载失败：${e}`);
  }
})();

/** 顶栏 / 底部坞 / 台面浮层的数据和动作（U-04）：外壳只认 chrome.ts，这里把会话和时间线接上去 */
function wireChrome(ctx: StepCtx, session: Awaited<ReturnType<typeof createSession>>) {
  const hist = ctx.hist!;
  const benchOnly = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
    if (store.get().step === 'bench') f(...a);
  };
  let paused = false;
  const runState = () => {
    const s = store.get();
    const run = s.hist.busy ? 'busy' : s.hist.seeked ? 'seek' : paused ? 'pause' : s.running ? 'run' : session.sim ? 'idle' : session.fwName ? 'loading' : 'nofw';
    setBc({ run, undo: !s.hist.busy && s.hist.cur > 0, redo: !s.hist.busy && s.hist.cur < s.hist.n - 1, runs: s.hist.runs, room: s.env.temp, fw: session.fwName });
  };
  store.subscribe(runState, ['running', 'hist', 'env']);
  session.onBoot(() => {
    paused = false;
    // 每次上电是新的 worker：倍速重新下发
    if (bc.get().speed !== 1) session.sim?.speed(bc.get().speed);
    setBc({ boot: null });
    runState();
  });
  if (session.sim) setBc({ boot: null });
  runState();

  actions.undo = benchOnly(() => {
    const h = store.get().hist;
    if (!h.busy && h.cur > 0) void hist.seek(h.cur - 1);
  });
  actions.redo = benchOnly(() => {
    const h = store.get().hist;
    if (!h.busy && h.cur < h.n - 1) void hist.seek(h.cur + 1);
  });
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
  actions.uart = (text) => session.sim?.uart(text);
  // 换固件：先看镜像头（魔数 0xE9、芯片 id），对不上就不上电，挂一张校验卡说清楚
  actions.pickFirmware = async (f) => {
    const buf = await f.arrayBuffer();
    const r = fwCheck(buf, session.chip);
    if (!r.ok) {
      overlay('fwcheck', <FwCheckCard name={f.name} res={r} onClose={() => overlay('fwcheck', null)} />);
      return;
    }
    overlay('fwcheck', null);
    if (store.get().step !== 'bench') location.hash = 'bench';
    session.loadFirmware(buf, f.name);
    shell.toast(`已换成 ${f.name}（${(buf.byteLength / 1024).toFixed(0)} KB），重新上电`);
  };
  actions.exportInputs = async () => {
    if (!session.sim) return shell.toast('模拟器还没跑起来，没有输入日志');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toScript(await session.sim.inputLog())], { type: 'text/plain' }));
    a.download = `${session.fwName || 'tryboard'}-inputs.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    shell.toast('已导出输入日志：tryboard run --inputs 可逐字节重放');
  };
  const curLevel = () => {
    const s = store.get();
    const sel = s.selection?.kind === 'checkpoint' ? s.selection.id : null;
    const id = sel ?? work.checkpoints.find((x) => !(s.checks[x]?.ok && s.checks[x].own)) ?? work.checkpoints[0];
    return session.levels.find((l) => l.id === id) ?? null;
  };
  actions.brief = work.checkpoints.length
    ? async () => {
        const l = curLevel();
        if (!l) return;
        try {
          await navigator.clipboard.writeText(l.brief);
          shell.toast(`已复制检查点 ${l.id} 的任务书`);
        } catch {
          store.set({ selection: { kind: 'checkpoint', id: l.id } });
          shell.toast('浏览器不让写剪贴板：任务书在右栏，手动复制');
        }
      }
    : undefined;
  actions.selectCheckpoint = (id) => {
    if (store.get().step !== 'bench') location.hash = 'bench';
    store.set({ selection: { kind: 'checkpoint', id } });
  };
  const ana = getAnalyzer(ctx);
  actions.analyzer = (open) => (open ? ana.open() : ana.close());
  // 分析仪也能从工具条、⌘K 打开：开了就把坞切到它的页签，关了切回串口
  new MutationObserver(() => {
    const open = document.body.classList.contains('ana-open');
    const d = bc.get().dock;
    if (open && d.tab !== 'analyzer') setDock({ tab: 'analyzer', collapsed: false });
    else if (!open && d.tab === 'analyzer') setDock({ tab: 'serial' });
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  actions.view = (k) => session.bench.view?.(k, store.get().selection);

  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
    const t = e.target as HTMLElement;
    if (t.closest('input,textarea,select,[contenteditable]')) return;
    e.preventDefault();
    if (e.shiftKey) actions.redo?.();
    else actions.undo?.();
  });

  // 步骤锁和完成标记：锁只是提示（各步骤自己会说明为什么还不能做），点了照样能进去看
  const progress = () => {
    const s = store.get();
    const n = work.checkpoints.length;
    const d = passedCount(ctx);
    const allOk = !n || d === n;
    const lockAsm = n && !allOk ? `实验台 ${n} 个检查点全部通过后解锁（${d}/${n}）` : undefined;
    const asmDone = !!s.assembly && s.assembly.placed.length >= s.assembly.total && s.assembly.total > 0;
    setBc({
      locks: { assemble: lockAsm, product: lockAsm ?? (n && !asmDone ? '组装装完后解锁' : undefined) },
      done: { shop: s.sceneRev > 0, bench: n > 0 && allOk, assemble: asmDone, product: !!s.assembly?.retest },
      checkpoints: work.checkpoints.map((id): CpRow => {
        const l = session.levels.find((x) => x.id === id);
        const r = s.checks[id];
        const state = s.verifying === id ? 'run' : r?.ok && r.own ? 'ok' : r && !r.ok ? 'bad' : 'todo';
        return { id, title: l?.title ?? id, state, note: r ? r.who : (l?.pass ?? '') };
      }),
    });
  };
  store.subscribe(progress, ['checks', 'verifying', 'assembly', 'sceneRev']);
  progress();

  // 问题页：欠压复位（模拟器报的）；接线规则检查的问题由实验台写进 issues 的 wire: 前缀项
  const brown: Issue[] = [];
  session.onBrownout((t) => {
    brown.push({ id: `brown:${brown.length}`, level: 'block', title: '欠压复位', detail: `${t.toFixed(2)} s 时 3V3 掉到门限以下，芯片复位`, go: () => setDock({ tab: 'runs' }) });
    setBc({ issues: [...bc.get().issues.filter((x) => !x.id.startsWith('brown:')), ...brown.slice(-5)] });
    // 掉电复位解释（关键状态）：只在实验台上弹，同一次上电只弹一次（舵机抖动会连着复位好几次）
    if (store.get().step !== 'bench' || bc.get().overlays.brown) return;
    const servo = session.scene.parts.some((p) => p.type === 'servo');
    overlay(
      'brown',
      <BrownoutBanner
        t={t}
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

  // 检查点通过提示：自己的固件新通过一个检查点时（恢复进度、参考固件不算）
  store.subscribe((s, prev) => {
    const n = work.checkpoints.length;
    for (const id of work.checkpoints) {
      const r = s.checks[id];
      const was = prev.checks[id];
      if (!(r?.ok && r.own) || (was?.ok && was.own)) continue;
      const d = passedCount(ctx, s);
      const l = session.levels.find((x) => x.id === id);
      ctx.shell.toast(d === n ? `检查点 ${id}「${l?.title ?? ''}」通过，${n} 个全部通过：组装解锁了` : `检查点 ${id}「${l?.title ?? ''}」通过（${d}/${n}）`);
    }
  }, ['checks']);
}
