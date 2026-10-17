// 工作台外壳：路由（?work= + #步骤）、步骤注册、右上结论 / 下一步、提示条（⌘K 在 cmdk.tsx）。
// 步骤切换只换面板内容；实时模拟和 3D 台面在 session 里，整页只有一份。
// 外壳由 React 画（DECISIONS 2026-10-17）：步骤调 shell 的 setter / Panel.render，全部同步提交；
// 3D 台面的 canvas 由 three.js 自己挂进 #stage，串口文字由 log() 直接追加文本节点，都不经 React。
import { Fragment, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { ThemeToggle } from '../ui/components';
import { STEPS, type Panel, type Shell, type StepCtx, type StepId, type StepImpl } from './types';
import { createTimeline } from './timeline';
import { createToolbar } from './toolbar';
import { createCard } from './card';
import { commit, useStore } from './react';
import { createStore } from './store';
import { CmdkBox, CmdkList } from './cmdk';

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

const pnl = 'rounded-(--r) border border-line bg-(--panel) shadow-panel';
/** 手机上左栏拆开堆叠，每块各自是一张卡 */
const mCard = 'max-[760px]:rounded-(--r) max-[760px]:border max-[760px]:border-line max-[760px]:bg-(--panel) max-[760px]:shadow-panel';
const topBtn = 'h-[34px] cursor-pointer rounded-lg border border-line bg-(--panel) px-3.5 font-medium shadow-panel max-[760px]:flex-1';

function Steps({ step }: { step: StepId }) {
  return (
    <nav id="steps" role="tablist" aria-label="四个步骤" className="steps mt-2.5 grid grid-cols-4 gap-0.5 rounded-lg bg-field p-0.5">
      {STEPS.map((s, i) => (
        <button
          key={s.id}
          type="button"
          role="tab"
          data-step={s.id}
          aria-selected={s.id === step}
          onClick={() => (location.hash = s.id)}
          className="flex cursor-pointer items-center justify-center gap-[3px] rounded-md border-0 bg-transparent py-1 text-xs text-muted aria-selected:bg-(--seg-on) aria-selected:font-medium aria-selected:text-fg aria-selected:shadow-[0_1px_2px_#0000001a]"
        >
          <span className="mono font-mono text-[10px]">{i + 1}</span>
          {s.label}
        </button>
      ))}
    </nav>
  );
}

const VIEWS: [string, string][] = [
  ['透视', '3D'],
  ['俯视', '顶'],
  ['正视', '前'],
];

function App() {
  const c = useStore(chrome);
  const { step } = c;
  const bench = step === 'bench';
  const own = step === 'assemble' || step === 'product';
  return (
    <div className="max-[760px]:flex max-[760px]:flex-col max-[760px]:gap-3 max-[760px]:px-4 max-[760px]:py-3">
      <section
        id="stage"
        aria-label="3D 台面"
        className={cn(
          'stage fixed inset-x-0 top-0 bottom-(--tl-h) overflow-hidden bg-(image:--stage-bg)',
          'max-[760px]:relative max-[760px]:inset-auto max-[760px]:order-3 max-[760px]:h-[300px] max-[760px]:flex-none max-[760px]:rounded-(--r) max-[760px]:border max-[760px]:border-line',
          !bench && step !== 'shop' && '[filter:saturate(.4)_opacity(.45)] max-[760px]:filter-none',
          // 组装、成品有自己的画面：实验台的 3D 台面藏起来（仍在后台跑，不销毁）；手机上还不占位置
          own && 'invisible max-[760px]:hidden',
          step === 'shop' && '[&_canvas]:invisible max-[760px]:hidden',
        )}
      >
        <card.View />
      </section>
      <layer.View
        tag="main"
        label="当前步骤"
        className={cn(
          'step-layer pointer-events-none fixed inset-0 z-1 flex items-center justify-center [&>*]:pointer-events-auto',
          'max-[760px]:static max-[760px]:order-4 max-[760px]:block max-[760px]:empty:hidden',
          step === 'assemble' && 'bottom-(--tl-h) bg-(image:--stage-bg) max-[760px]:bg-none',
        )}
      />
      {bench && <aside aria-label="外观说明" className="disclaimer pointer-events-none fixed bottom-[calc(var(--tl-h)+64px)] left-1/2 -translate-x-1/2 text-[11px] text-muted max-[760px]:hidden">外观示意，非乐鑫官方模型</aside>}

      <aside aria-label="构建树" className={cn('pnl left fixed top-3 bottom-[calc(var(--tl-h)+var(--gap))] left-3 z-2 flex w-[268px] flex-col overflow-hidden', pnl, 'max-[760px]:contents')}>
        <header className={cn('left-head border-b border-line-soft px-3 pt-3 pb-2 max-[760px]:order-1', mCard)}>
          <div className="brand-row flex min-w-0 items-baseline gap-2">
            <a className="brand inline-flex flex-none items-baseline gap-1.5 text-fg no-underline" href="./home.html">
              <b className="text-sm">试板</b>
              <span className="font-mono text-[10px] tracking-[0.08em] text-muted">TRYBOARD</span>
            </a>
            <h1 id="workName" className="work truncate font-medium">
              {c.workName}
            </h1>
          </div>
          <Steps step={step} />
        </header>
        <tree.View className={cn('tree min-h-20 flex-1 overflow-auto px-1.5 pt-1.5 pb-2 max-[760px]:order-6 max-[760px]:flex-none max-[760px]:overflow-visible', mCard)} />
        <details open className={cn('serial border-t border-line-soft max-[760px]:order-7 max-[760px]:overflow-hidden', mCard, step === 'shop' && 'hidden')}>
          <summary className="flex cursor-pointer list-none justify-between px-3 py-2 text-[11px] font-medium text-muted [&::-webkit-details-marker]:hidden">
            <span>串口</span>
            <span className="mono font-mono text-muted">UART0 · 115200</span>
          </summary>
          <pre id="console" tabIndex={0} role="log" aria-live="off" aria-label="串口输出" className="mono m-0 h-[150px] overflow-auto bg-field px-3 pt-1.5 pb-2.5 font-mono text-[11px] leading-[1.45] break-all whitespace-pre-wrap" />
        </details>
      </aside>

      <CmdkBox />
      <CmdkList />

      <div role="region" aria-label="检查与视图" className="topright fixed top-3 right-3 z-3 flex items-center gap-2 max-[760px]:static max-[760px]:order-2 max-[760px]:flex-wrap">
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
          className={cn('next text-[13px]', topBtn, 'border-accent-strong bg-accent-strong text-on-accent disabled:cursor-not-allowed disabled:border-line disabled:bg-field disabled:text-muted')}
        >
          {c.next.label}
        </button>
        <div role="group" aria-label="视角" className={cn('viewcube grid grid-cols-[repeat(3,26px)] gap-0.5 rounded-lg p-[3px]', pnl, 'max-[760px]:hidden')}>
          {VIEWS.map(([title, t]) => (
            <button
              key={t}
              type="button"
              title={title}
              aria-label={title}
              onClick={() => shell.toast(`「${title}」视角暂未开放，可以直接拖动旋转`)}
              className="h-[26px] cursor-pointer rounded border border-line-soft bg-surface p-0 text-[10px] text-muted hover:bg-accent-bg hover:text-accent-ink"
            >
              {t}
            </button>
          ))}
        </div>
        <ThemeToggle className="h-[34px] rounded-lg bg-(--panel) shadow-panel" />
      </div>

      <props.View
        tag="aside"
        label="属性面板"
        live
        className={cn(
          'pnl right fixed top-[calc(var(--gap)+46px)] right-3 bottom-[calc(var(--tl-h)+var(--gap))] z-2 w-[304px] overflow-auto px-3.5 pt-1 pb-3.5',
          pnl,
          'max-[760px]:static max-[760px]:order-5 max-[760px]:max-h-none max-[760px]:w-auto max-[760px]:overflow-visible',
          "max-[760px]:after:mt-2.5 max-[760px]:after:block max-[760px]:after:text-xs max-[760px]:after:text-muted max-[760px]:after:content-['手机上只读：上传固件、验收、调台面请在电脑上']",
        )}
      />

      <toolbar.View />

      <footer className="timeline-bar fixed inset-x-0 bottom-0 z-2 flex h-(--tl-h) items-center gap-3 border-t border-line bg-surface px-3 max-[760px]:static max-[760px]:order-8 max-[760px]:rounded-(--r) max-[760px]:border">
        <timeline.View />
        <span id="simtime" className="mono simtime flex-none font-mono text-xs text-muted" />
      </footer>
      <div
        id="toast"
        role="status"
        hidden={!c.toast.shown}
        className="toast fixed bottom-[calc(var(--tl-h)+64px)] left-1/2 z-10 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg bg-fg px-3.5 py-2 text-xs text-(--toast-fg) max-[760px]:bottom-4"
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
