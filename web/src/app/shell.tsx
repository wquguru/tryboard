// 工作台外壳：路由（?work= + #步骤）、步骤注册、右上结论 / 下一步、提示条（⌘K 在 cmdk.tsx）。
// 步骤切换只换面板内容；实时模拟和 3D 台面在 session 里，整页只有一份。
// 外壳由 React 画（DECISIONS 2026-10-17）：步骤调 shell 的 setter / Panel.render，全部同步提交；
// 3D 台面的 canvas 由 three.js 自己挂进 #stage，串口文字由 log() 直接追加文本节点，都不经 React。
import { Fragment, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { STEPS, type Panel, type Shell, type StepCtx, type StepId, type StepImpl } from './types';
import { createTimeline } from './timeline';
import { createToolbar } from './toolbar';
import { createCard } from './card';
import { commit, useStore } from './react';
import { createStore } from './store';
import { CmdkList } from './cmdk';
import { TopBar } from './topbar';
import { Dock } from './dock';
import { LeftColumn } from './leftcol';
import { StageOverlays } from './overlays';

const registry = new Map<StepId, StepImpl>();

/** 步骤注册：后续任务（采购 P0-07、组装 P0-16、成品 P0-17）各自注册一个实现覆盖占位 */
export function registerStep(id: StepId, impl: StepImpl) {
  registry.set(id, impl);
  if (active?.id === id && ctxRef) remount(id);
}

let active: { id: StepId; impl: StepImpl } | null = null;
let ctxRef: StepCtx | null = null;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function stepFromHash(): StepId {
  const h = location.hash.slice(1) as StepId;
  return STEPS.some((s) => s.id === h) ? h : 'bench';
}

type Verdict = 'ok' | 'bad' | 'warn' | 'idle';
interface Chrome {
  /** 外壳当前画的步骤（台面滤镜、串口显隐跟着它） */
  step: StepId;
  routed: boolean;
  workName: string;
  verdict: { text: string; state: Verdict };
  next: { label: string; to: StepId | null; why: string; onGo?: () => void };
  toast: { text: string; shown: boolean };
}
const chrome = createStore<Chrome>({
  step: stepFromHash(),
  routed: false,
  workName: '',
  verdict: { text: '检查点 0/0', state: 'idle' },
  next: { label: '下一步', to: null, why: '' },
  toast: { text: '', shown: false },
});
const setChrome = (p: Partial<Chrome>) => commit(() => chrome.set(p));
let verdictFn: (() => void) | null = null;

/** 一块整块重画的区域：每次 render 换 key，React 整棵重建（与原来 innerHTML 重画一致，命令式改过的状态随之清掉） */
function createPanel(id: string): Panel & { View: (p: { className: string; tag?: 'div' | 'aside' | 'main'; label?: string; live?: boolean }) => React.JSX.Element } {
  const st = createStore<{ v: ReactNode; n: number }>({ v: null, n: 0 });
  function View({ className, tag = 'div', label, live }: { className: string; tag?: 'div' | 'aside' | 'main'; label?: string; live?: boolean }) {
    const { v, n } = useStore(st);
    const T = tag;
    return (
      <T id={id} className={className} aria-label={label} aria-live={live ? 'polite' : undefined}>
        <Fragment key={n}>{v}</Fragment>
      </T>
    );
  }
  return {
    View,
    render(v) {
      commit(() => st.set({ v, n: st.get().n + 1 }));
    },
    get el() {
      return $(id);
    },
  };
}

const tree = createPanel('tree');
const props = createPanel('props');
const layer = createPanel('stepLayer');
const toolbar = createToolbar();
const timeline = createTimeline();
const card = createCard(() => $('stage'));

/** 手机上各块拆开堆叠，每块各自是一张卡 */
const mCard = 'max-[760px]:rounded-(--r) max-[760px]:border max-[760px]:border-line max-[760px]:bg-(--panel) max-[760px]:shadow-panel';
const topBtn = 'h-8 flex-none cursor-pointer rounded-lg border border-line bg-surface px-3 font-medium whitespace-nowrap max-[760px]:flex-1';

function App() {
  const c = useStore(chrome);
  const { step } = c;
  const bench = step === 'bench';
  const own = step === 'assemble' || step === 'product';
  const right = (
    <>
      <button
        id="verdict"
        type="button"
        data-state={c.verdict.state}
        onClick={() => verdictFn?.()}
        className={cn(
          'verdict font-mono text-xs text-fg',
          topBtn,
          'data-[state=ok]:border-(--ok-line) data-[state=ok]:text-ok-ink data-[state=warn]:border-(--warn-line) data-[state=warn]:text-warn-ink',
          'data-[state=bad]:border-(--bad-line) data-[state=bad]:bg-bad-bg data-[state=bad]:text-bad-ink',
          // 实验台的检查点进度在步骤条上已有；窄一点就藏起来给步骤条让位
          'max-[1600px]:hidden max-[760px]:inline-block',
        )}
      >
        {c.verdict.text}
      </button>
      <button
        id="next"
        type="button"
        disabled={!c.next.to}
        title={c.next.to ? '' : c.next.why}
        onClick={() => {
          const n = chrome.get().next;
          if (n.to) n.onGo ? n.onGo() : (location.hash = n.to);
        }}
        className={cn('next text-[13px]', topBtn, 'border-accent-strong text-accent-ink hover:bg-accent-bg disabled:cursor-not-allowed disabled:border-line disabled:bg-field disabled:text-muted')}
      >
        {c.next.label}
      </button>
    </>
  );
  return (
    <div className="max-[760px]:flex max-[760px]:flex-col max-[760px]:gap-3 max-[760px]:px-4 max-[760px]:py-3">
      <TopBar step={step} workName={c.workName} right={right} toast={(t) => shell.toast(t)} />
      <section
        id="stage"
        aria-label="3D 台面"
        className={cn(
          'stage fixed top-(--top-h) right-(--right-w) bottom-(--dock-h) left-(--left-w) overflow-hidden bg-(image:--stage-bg)',
          'max-[760px]:relative max-[760px]:inset-auto max-[760px]:order-3 max-[760px]:h-[300px] max-[760px]:flex-none max-[760px]:rounded-(--r) max-[760px]:border max-[760px]:border-line',
          !bench && step !== 'shop' && '[filter:saturate(.4)_opacity(.45)] max-[760px]:filter-none',
          // 组装、成品有自己的画面：实验台的 3D 台面藏起来（仍在后台跑，不销毁）；手机上还不占位置
          own && 'invisible max-[760px]:hidden',
          step === 'shop' && '[&_canvas]:invisible max-[760px]:hidden',
        )}
      >
        <card.View />
        <StageOverlays bench={bench} />
      </section>
      <layer.View
        tag="main"
        label="当前步骤"
        className={cn(
          'step-layer pointer-events-none fixed inset-0 z-1 flex items-center justify-center [&>*]:pointer-events-auto',
          'max-[760px]:static max-[760px]:order-4 max-[760px]:block max-[760px]:empty:hidden',
        )}
      />
      {step === 'assemble' && <div aria-hidden="true" className="fixed top-(--top-h) right-(--right-w) bottom-(--dock-h) left-(--left-w) bg-(image:--stage-bg) max-[760px]:hidden" />}

      <aside aria-label="构建树" className={cn('pnl left fixed top-(--top-h) bottom-(--dock-h) left-0 z-2 flex w-(--left-w) flex-col overflow-hidden border-r border-line bg-surface', 'max-[760px]:static max-[760px]:order-6 max-[760px]:w-auto max-[760px]:overflow-visible', mCard)}>
        <LeftColumn step={step} tree={<tree.View className="tree min-h-20 flex-1 overflow-auto px-1.5 pt-1.5 pb-2 max-[760px]:flex-none max-[760px]:overflow-visible" />} />
      </aside>

      <CmdkList />

      <props.View
        tag="aside"
        label="属性面板"
        live
        className={cn(
          'pnl right fixed top-(--top-h) right-0 bottom-(--dock-h) z-2 w-(--right-w) overflow-auto border-l border-line bg-surface px-4 pt-1 pb-4',
          'max-[760px]:static max-[760px]:order-5 max-[760px]:max-h-none max-[760px]:w-auto max-[760px]:overflow-visible',
          mCard,
          "max-[760px]:after:mt-2.5 max-[760px]:after:block max-[760px]:after:text-xs max-[760px]:after:text-muted max-[760px]:after:content-['手机上只读：上传固件、验收、调台面请在电脑上']",
        )}
      />

      <toolbar.View />

      <Dock step={step} toast={(t) => shell.toast(t)} timeline={<timeline.View />} simtime={<span id="simtime" className="mono simtime flex-none font-mono text-xs text-muted" title="模拟时间" />} />
      {/* 串口原文：文本节点原样追加（重放对拍、回归脚本读它）；看得见的是坞里的行视图 */}
      <pre id="console" aria-hidden="true" className="sr-only" />
      <div
        id="toast"
        role="status"
        hidden={!c.toast.shown}
        className="toast fixed bottom-[calc(var(--dock-h)+76px)] left-[calc((100vw+var(--left-w)-var(--right-w))/2)] z-10 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg bg-fg px-3.5 py-2 text-xs text-(--toast-fg) max-[760px]:bottom-4 max-[760px]:left-1/2"
      >
        {c.toast.text}
      </div>
    </div>
  );
}

let toastTimer = 0;
const shell: Shell = {
  tree,
  props,
  layer,
  toolbar,
  timeline,
  card,
  get stage() {
    return $('stage');
  },
  setVerdict(text, state) {
    setChrome({ verdict: { text, state } });
  },
  onVerdict(fn) {
    verdictFn = fn;
  },
  setNext(label, to, why, onGo) {
    setChrome({ next: { label, to, why: why ?? '', onGo } });
  },
  toast(text) {
    setChrome({ toast: { text, shown: true } });
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setChrome({ toast: { text: chrome.get().toast.text, shown: false } }), 2600);
  },
};

/** 外壳组件与接口（main 里先 render <ShellView/>，再 createSession） */
export const ShellView = App;
export function createShell(workName: string): Shell {
  setChrome({ workName });
  return shell;
}

function remount(id: StepId) {
  const ctx = ctxRef!;
  const impl = registry.get(id);
  active?.impl.unmount();
  layer.render(null);
  ctx.shell.card.hide();
  document.body.dataset.step = id;
  setChrome({ step: id });
  ctx.store.set({ step: id });
  if (!impl) {
    active = null;
    return;
  }
  active = { id, impl };
  impl.mount(ctx);
}

/** 启动路由：读当前 hash、监听 hashchange。四步都在同一页，切换不重载 */
export function startRouter(ctx: StepCtx) {
  ctxRef = ctx;
  window.addEventListener('hashchange', () => {
    const id = stepFromHash();
    if (id !== active?.id) remount(id);
  });
  remount(stepFromHash());
}
