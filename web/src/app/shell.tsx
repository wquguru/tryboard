// 工作台外壳：路由（?work= + #步骤）、步骤注册、右上结论 / 下一步、提示条（⌘K 在 cmdk.tsx）。
// 步骤切换只换面板内容；实时模拟和 3D 台面在 session 里，整页只有一份。
// 外壳由 React 画（DECISIONS 2026-10-17）：步骤调 shell 的 setter / Panel.render，全部同步提交；
// 3D 台面的 canvas 由 three.js 自己挂进 #stage，串口文字由 log() 直接追加文本节点，都不经 React。
import { Fragment, type ReactNode } from "react";
import { cn } from "../ui/cn";
import {
  STEPS,
  type Panel,
  type Shell,
  type StepCtx,
  type StepId,
  type StepImpl,
} from "./types";
import { createTimeline } from "./timeline";
import { createToolbar } from "./toolbar";
import { createCard } from "./card";
import { commit, useStore } from "./react";
import { createStore } from "./store";
import { CmdkList } from "./cmdk";
import { TopBar } from "./topbar";
import { Dock, SerialStrip } from "./dock";
import {
  MobileTop,
  SheetHead,
  mui,
  resetPhoneUi,
  setMui,
  usePhone,
} from "./mobile";
import { LeftColumn } from "./leftcol";
import { StageOverlays } from "./overlays";

const registry = new Map<StepId, StepImpl>();

/** 步骤注册：后续任务（采购 P0-07、组装 P0-16、成品 P0-17）各自注册一个实现覆盖占位 */
export function registerStep(id: StepId, impl: StepImpl) {
  registry.set(id, impl);
  if (active?.id === id && ctxRef) remount(id);
}

let active: { id: StepId; impl: StepImpl } | null = null;
let ctxRef: StepCtx | null = null;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

export function stepFromHash(): StepId {
  const h = location.hash.slice(1) as StepId;
  return STEPS.some((s) => s.id === h) ? h : "bench";
}

type Verdict = "ok" | "bad" | "warn" | "idle";
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
  workName: "",
  verdict: { text: "检查点 0/0", state: "idle" },
  next: { label: "下一步", to: null, why: "" },
  toast: { text: "", shown: false },
});
const setChrome = (p: Partial<Chrome>) => commit(() => chrome.set(p));
let verdictFn: (() => void) | null = null;

/** 一块整块重画的区域：每次 render 换 key，React 整棵重建（与原来 innerHTML 重画一致，命令式改过的状态随之清掉） */
type PanelProps = {
  className: string;
  tag?: "div" | "aside" | "main";
  label?: string;
  live?: boolean;
  head?: ReactNode;
};
function createPanel(
  id: string,
): Panel & { View: (p: PanelProps) => React.JSX.Element } {
  const st = createStore<{ v: ReactNode; n: number }>({ v: null, n: 0 });
  function View({ className, tag = "div", label, live, head }: PanelProps) {
    const { v, n } = useStore(st);
    const T = tag;
    return (
      <T
        id={id}
        className={className}
        aria-label={label}
        aria-live={live ? "polite" : undefined}
      >
        {head}
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

const tree = createPanel("tree");
const props = createPanel("props");
const layer = createPanel("stepLayer");
const toolbar = createToolbar();
const timeline = createTimeline();
const card = createCard(() => $("stage"));

const topBtn =
  "h-8 flex-none cursor-pointer rounded-lg border border-line bg-surface px-3 font-medium whitespace-nowrap";
/** 手机上采购 / 组装 / 成品各块拆开竖排，每块各自是一张卡 */
const mCard = "rounded-(--r) border border-line bg-(--panel) shadow-panel";
/** 手机竖排的先后（DESIGN_V2 §5）：采购结论在上、清单、零件平铺；组装 / 成品 3D 在上、属性（装法 / 按键）、工具、构建树 */
const M_ORDER: Record<
  string,
  { layer: string; props: string; tools: string; tree: string }
> = {
  shop: {
    props: "order-1",
    tree: "order-2",
    layer: "order-3",
    tools: "order-4",
  },
  assemble: {
    layer: "order-1",
    props: "order-2",
    tools: "order-3",
    tree: "order-4",
  },
  product: {
    layer: "order-1",
    props: "order-3",
    tools: "order-4",
    tree: "order-5",
  },
};

function App() {
  const c = useStore(chrome);
  const m = useStore(mui);
  const phone = usePhone();
  const { step } = c;
  const bench = step === "bench";
  const own = step === "assemble" || step === "product";
  /** 手机实验台：台面铺满，属性 / 元件库 / 串口是抽屉；别的步骤：各块竖排滚动，底部吸一条主按钮 */
  const pb = phone && bench;
  const pf = phone && !bench;
  const mo = M_ORDER[step] ?? M_ORDER.shop;
  const goNext = () => {
    const n = chrome.get().next;
    if (n.to) n.onGo ? n.onGo() : (location.hash = n.to);
  };
  const verdictCls = cn(
    "verdict font-mono text-xs text-fg",
    "data-[state=ok]:border-(--ok-line) data-[state=ok]:text-ok-ink data-[state=warn]:border-(--warn-line) data-[state=warn]:text-warn-ink",
    "data-[state=bad]:border-(--bad-line) data-[state=bad]:bg-bad-bg data-[state=bad]:text-bad-ink",
  );
  const right = (
    <>
      <button
        id="verdict"
        type="button"
        data-state={c.verdict.state}
        onClick={() => verdictFn?.()}
        className={cn(
          verdictCls,
          topBtn,
          // 实验台的检查点进度在步骤条上已有；窄一点就藏起来给步骤条让位
          "max-[1600px]:hidden",
        )}
      >
        {c.verdict.text}
      </button>
      <button
        id="next"
        type="button"
        disabled={!c.next.to}
        title={c.next.to ? "" : c.next.why}
        onClick={goNext}
        className={cn(
          "next text-[13px]",
          topBtn,
          "border-accent-strong text-accent-ink hover:bg-accent-bg disabled:cursor-not-allowed disabled:border-line disabled:bg-field disabled:text-muted",
        )}
      >
        {c.next.label}
      </button>
    </>
  );
  const stageCls = phone
    ? cn(
        "stage fixed top-(--top-h) right-0 bottom-(--dock-h) left-0 overflow-hidden bg-(image:--stage-bg)",
        !bench && "pointer-events-none invisible",
      )
    : cn(
        "stage fixed top-(--top-h) right-(--right-w) bottom-(--dock-h) left-(--left-w) overflow-hidden bg-(image:--stage-bg)",
        !bench && step !== "shop" && "[filter:saturate(.4)_opacity(.45)]",
        // 组装、成品有自己的画面：实验台的 3D 台面藏起来（仍在后台跑，不销毁）
        own && "invisible",
        step === "shop" && "[&_canvas]:invisible",
      );
  const layerCls = pf
    ? cn("step-layer block empty:hidden", mo.layer)
    : "step-layer pointer-events-none fixed inset-0 z-1 flex items-center justify-center [&>*]:pointer-events-auto";
  const leftCls = pb
    ? cn(
        "pnl left inset-0 z-40 flex-col overflow-hidden bg-surface",
        m.lib ? "fixed flex" : "hidden",
      )
    : pf
      ? cn("pnl left flex flex-col", mCard, mo.tree)
      : "pnl left fixed top-(--top-h) bottom-(--dock-h) left-0 z-2 flex w-(--left-w) flex-col overflow-hidden border-r border-line bg-surface";
  const propsCls = pb
    ? cn(
        "pnl right inset-x-0 bottom-0 z-30 max-h-[min(540px,72dvh)] overflow-auto rounded-t-2xl border-t border-line bg-surface px-4 pt-0 pb-[calc(16px+env(safe-area-inset-bottom))] shadow-[0_-8px_24px_#00000026]",
        m.props ? "fixed block" : "hidden",
      )
    : pf
      ? cn("pnl right px-4 pt-1 pb-4", mCard, mo.props)
      : "pnl right fixed top-(--top-h) right-0 bottom-(--dock-h) z-2 w-(--right-w) overflow-auto border-l border-line bg-surface px-4 pt-1 pb-4";
  return (
    <div
      className={cn(
        pf &&
          "flex min-h-dvh flex-col gap-3 px-3 pt-[calc(var(--top-h)+12px)] pb-[calc(var(--dock-h)+12px)]",
      )}
    >
      {phone ? (
        <MobileTop
          step={step}
          workName={c.workName}
          toast={(t) => shell.toast(t)}
        />
      ) : (
        <TopBar
          step={step}
          workName={c.workName}
          right={right}
          toast={(t) => shell.toast(t)}
        />
      )}
      <section id="stage" aria-label="3D 台面" className={stageCls}>
        <card.View />
        <StageOverlays bench={bench} />
      </section>
      <layer.View tag="main" label="当前步骤" className={layerCls} />
      {!phone && step === "assemble" && (
        <div
          aria-hidden="true"
          className="fixed top-(--top-h) right-(--right-w) bottom-(--dock-h) left-(--left-w) bg-(image:--stage-bg)"
        />
      )}
      {pf && step === "product" && (
        <div className="order-2">
          <SerialStrip />
        </div>
      )}

      <aside aria-label="构建树" className={leftCls}>
        <LeftColumn
          step={step}
          tree={
            <tree.View
              className={
                pf
                  ? "tree flex-none px-1.5 pt-1.5 pb-2"
                  : "tree min-h-20 flex-1 overflow-auto px-1.5 pt-1.5 pb-2"
              }
            />
          }
        />
      </aside>

      <CmdkList />

      <props.View
        tag="aside"
        label="属性面板"
        live
        className={propsCls}
        head={
          pb ? (
            <SheetHead
              title="属性"
              id="propsClose"
              onClose={() => setMui({ props: false })}
            />
          ) : null
        }
      />

      {pf ? (
        <div className={mo.tools}>
          <toolbar.View step={step} />
        </div>
      ) : (
        <toolbar.View step={step} />
      )}

      <Dock
        step={step}
        toast={(t) => shell.toast(t)}
        timeline={<timeline.View />}
        simtime={
          <span
            id="simtime"
            className="mono simtime flex-none font-mono text-xs text-muted"
            title="模拟时间"
          />
        }
      />
      {pf && (
        // 手机上采购 / 组装 / 成品的主按钮吸在底部（结论在左，下一步在右）
        <div
          id="mNext"
          className="fixed inset-x-0 bottom-0 z-20 flex h-(--dock-h) items-start gap-2 border-t border-line bg-surface px-3 pt-2.5 pb-[env(safe-area-inset-bottom)]"
        >
          <button
            id="verdict"
            type="button"
            data-state={c.verdict.state}
            onClick={() => verdictFn?.()}
            className={cn(
              verdictCls,
              "h-12 max-w-[42%] min-w-0 flex-none cursor-pointer truncate rounded-xl border border-line bg-surface px-3",
            )}
          >
            {c.verdict.text}
          </button>
          <button
            id="next"
            type="button"
            disabled={!c.next.to}
            title={c.next.to ? "" : c.next.why}
            onClick={goNext}
            className="next flex h-12 min-w-0 flex-1 cursor-pointer flex-col items-center justify-center rounded-xl border-0 bg-accent-strong px-3 text-[15px] font-medium text-on-accent disabled:cursor-not-allowed disabled:bg-field disabled:text-muted"
          >
            <span className="max-w-full truncate">{c.next.label}</span>
            {!c.next.to && c.next.why && (
              <span className="max-w-full truncate text-[11px] font-normal">
                {c.next.why}
              </span>
            )}
          </button>
        </div>
      )}
      {/* 串口原文：文本节点原样追加（重放对拍、回归脚本读它）；看得见的是坞里的行视图 */}
      <pre id="console" aria-hidden="true" className="sr-only" />
      <div
        id="toast"
        role="status"
        hidden={!c.toast.shown}
        className={cn(
          "toast fixed z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg bg-fg px-3.5 py-2 text-xs text-(--toast-fg)",
          phone
            ? "bottom-[calc(var(--dock-h)+12px)] left-1/2"
            : "bottom-[calc(var(--dock-h)+76px)] left-[calc((100vw+var(--left-w)-var(--right-w))/2)] z-10",
        )}
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
    return $("stage");
  },
  setVerdict(text, state) {
    setChrome({ verdict: { text, state } });
  },
  onVerdict(fn) {
    verdictFn = fn;
  },
  setNext(label, to, why, onGo) {
    setChrome({ next: { label, to, why: why ?? "", onGo } });
  },
  toast(text) {
    setChrome({ toast: { text, shown: true } });
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
      () =>
        setChrome({ toast: { text: chrome.get().toast.text, shown: false } }),
      2600,
    );
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
  resetPhoneUi();
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
  window.addEventListener("hashchange", () => {
    const id = stepFromHash();
    if (id !== active?.id) remount(id);
  });
  remount(stepFromHash());
}
