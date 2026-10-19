// 工作台入口：./app?work=weather#bench（文件是 app.html，链接不带后缀）。外壳、实时模拟、3D 台面各一份；四个步骤注册到路由上。
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
import { toScript, type InputLog } from '../inputlog';
import { customPlan } from './custom';
import { genLevels } from './genlevels';
import { registerTemplate } from '../catalog/templates';
import { initialHistory, placement, replay } from './bom';
import { briefMarkdown } from '../advisor/brief';
import type { PartSpec } from '../board3d';

export { registerStep } from './shell';

const params = new URLSearchParams(location.search);
const want = params.get('work') as WorkId | null;
// &example=<id>：示例 = 空白作品 + 示例的固件、台面、芯片（DESIGN_V2 §6.1；旧 index.html?example= 跳到这里）
const exId = params.get('example');
const ex = exId ? (await loadExamples()).find((e) => e.id === exId) : undefined;
// work=custom：选板结果 → 采购模板 + 按零件生成的检查点（U-17）。地址参数变了 = 新作品（存档键带参数哈希）
const plan = !ex && want === 'custom' ? customPlan(location.search) : null;
if (plan) registerTemplate(plan.template);
// 没按过「摆上实验台」也按选板引脚表摆好（不存档）；摆过就以摆过的为准（采购页可能加减过零件）
const customPlaced = plan
  ? (loadPlaced(plan.wkey) ??
    (() => {
      const pl = placement(replay(initialHistory('custom')));
      return { scene: { parts: pl.parts as unknown as PartSpec[] }, ext5v: pl.ext5v };
    })())
  : null;
const customLevels = plan ? genLevels({ boardName: plan.boardName, chip: plan.chip, parts: customPlaced!.scene.parts, deepSleep: plan.deepSleep }) : [];
const work: WorkDef = ex
  ? { ...WORKS.blank, example: ex.id, title: ex.title, key: `blank:${ex.id}` }
  : plan
    ? { ...WORKS.custom, title: plan.title, key: plan.wkey, checkpoints: customLevels.filter((l) => !l.manual).map((l) => l.id) }
    : (WORKS[want ?? 'weather'] ?? WORKS.weather);
// &cp=04：打开时选中这个检查点（旧关卡页 levels.html#04 重定向过来用）；不属于这个作品就忽略
const cp = params.get('cp');
if (ex) pushRecent({ kind: 'example', id: ex.id, title: ex.title, at: Date.now() });
document.title = ex ? `${ex.title} · 示例 · 试板 TryBoard` : `${work.title} · 试板 TryBoard`;
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
    // 给自动化测试（tools/webtest/replay.mjs）：取输入日志、3D 板上按钮的屏幕坐标；在验收 worker 里按同一份日志重放
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
    // 欠压复位（P1-02）进实验台时间线：一步，回到它 = 回到复位那一刻
    session.onBrownout((t) => {
      ctx.hist!.event({ k: 'brownout', tSec: t, v3v3: session.frame.elec?.min3v3 ?? null }, t * 1000);
      shell.toast(`电压不够，芯片重启了（${t.toFixed(2)} 秒）`);
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
    const ratioEl = document.getElementById('ratio')!;
    session.onTick((m) => {
      if (!m.running) return;
      ratioEl.textContent = `${m.ratio.toFixed(2)}× 实时`;
      ratioEl.classList.toggle('slow', m.ratio < 0.9);
    });
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
    // 采购步骤撤销的是清单历史（时间线上那几格），其他步骤是实验台时间线
    const shop = s.step === 'shop';
    const undo = shop ? s.bom.cur > 0 : !s.hist.busy && s.hist.cur > 0;
    const redo = shop ? s.bom.cur < s.bom.ops.length - 1 : !s.hist.busy && s.hist.cur < s.hist.n - 1;
    setBc({ run, undo, redo, runs: s.hist.runs, room: s.env.temp, fw: session.fwName, chip: session.chip });
  };
  store.subscribe(runState, ['running', 'hist', 'env', 'bom', 'step']);
  session.onBoot(() => {
    paused = false;
    // 每次上电是新的 worker：倍速重新下发
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
  // 声音（默认静音）：点击就是用户手势，AudioContext 在这一刻创建 / 恢复
  const syncSound = () => setBc({ sound: { has: session.audio.hasSound, on: !session.audio.state.muted } });
  actions.sound = () => void session.audio.setMuted(!session.audio.state.muted).then(syncSound);
  store.subscribe(syncSound, ['sceneRev']);
  syncSound();
  actions.uart = (text) => session.sim?.uart(text);
  actions.usbCdc = (text) => session.sim?.usbCdc(text);
  // 设备第一次枚举出来时把坞切到「USB」页签：键盘打的字、CDC 回显就在眼前
  session.onUsb((v) => {
    usbFeed.update(v);
    if (!!v === bc.get().usb) return;
    setBc({ usb: !!v });
    if (v) setDock({ tab: 'usb', collapsed: false });
    else if (bc.get().dock.tab === 'usb') setDock({ tab: 'serial' });
  });
  // 换固件：先看镜像头（魔数 0xE9、芯片 id），对不上就不上电，挂一张校验卡说清楚
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
    // 提示等新的一次运行真的起来再弹，免得"重新上电"跑在时间线「运行 #n」前面
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      off();
      const id = onBench ? actions.checkUpload?.(buf, f.name) : null;
      shell.toast(`已换成 ${f.name}（${(buf.byteLength / 1024).toFixed(0)} KB），重新上电${id ? `；同时验收检查点 ${id}` : ''}`);
    };
    const off = session.onBoot(fire);
    // 万一这次没上电成功，别让监听留到下一次上电
    setTimeout(fire, 3000);
    session.loadFirmware(buf, f.name);
    pushRecent({ kind: 'file', name: f.name, at: Date.now() });
  };
  // 换回作品自带的参考固件（上传过自己的 .bin 之后回到起点）；空白作品没有参考固件
  if (work.example && !ex)
    actions.loadRef = async () => {
      const buf = await fetchBuf(`./fw/${work.example}/flash.bin`);
      if (store.get().step !== 'bench') location.hash = 'bench';
      session.loadFirmware(buf, `${work.example}/flash.bin`);
      shell.toast('已换回参考固件，重新上电');
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
  // 选板作品：任务书 = 选板给 AI 的任务书 + 生成的检查点（逐条带判定）
  const customBrief = plan ? () => [briefMarkdown(plan.state), '', '## 检查点（网页按这些判）', ...customLevels.map((l) => `- ${l.id} ${l.title}：${l.manual ? '必须上真机，网页不判' : l.pass}`)].join('\n') : null;
  actions.brief = customBrief
    ? async () => {
        try {
          await navigator.clipboard.writeText(customBrief());
          shell.toast('已复制给 AI 的任务书');
        } catch {
          shell.toast('浏览器不让写剪贴板：任务书在检查点右栏，手动复制');
        }
      }
    : work.checkpoints.length
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
  // 采购完成 = 至少按过一次「下一步：实验台」（清单摆上台面存进本机）；只看 sceneRev 的话刷新后 ✓ 就丢了
  const shopPlaced = !!loadPlaced(wkey(work));
  const progress = () => {
    const s = store.get();
    const n = work.checkpoints.length;
    const d = passedCount(ctx);
    const allOk = !n || d === n;
    const lockAsm = n && !allOk ? `实验台 ${n} 个检查点全部通过后解锁（${d}/${n}）` : undefined;
    const asmDone = !!s.assembly && s.assembly.placed.length >= s.assembly.total && s.assembly.total > 0;
    setBc({
      locks: { assemble: lockAsm, product: lockAsm ?? (n && !asmDone ? '组装装完后解锁' : undefined) },
      done: { shop: s.sceneRev > 0 || shopPlaced, bench: n > 0 && allOk, assemble: asmDone, product: !!s.assembly?.retest },
      retest: s.assembly?.retest ?? null,
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
    brown.push({ id: `brown:${brown.length}`, level: 'block', title: '电压不够，芯片重启了', detail: `${t.toFixed(2)} 秒时 3V3 掉到门限以下（欠压复位）`, go: () => setDock({ tab: 'runs' }) });
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
      ctx.shell.toast(d === n ? `检查点 ${id}「${l?.title ?? ''}」通过，${n} 个全部通过：${plan ? '下一步做成真的' : '组装解锁了'}` : `检查点 ${id}「${l?.title ?? ''}」通过（${d}/${n}）`);
    }
  }, ['checks']);
}
