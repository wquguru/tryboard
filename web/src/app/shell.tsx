// Workbench shell: routing (?work= + #step), step registry, verdict / next, toast. Switching steps only swaps panels;
// React draws the shell (DECISIONS 2026-10-17), while the three.js canvas and raw serial text bypass React.
import { LessonCard } from "./lesson";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { cn } from "../ui/cn";
import { t } from "../i18n";
import {
  STEPS,
  type NextState,
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
import { CmdkList } from "./cmdkview";
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
import { Icon } from "./icons";
import { shownSteps } from "./chrome";
import { StageOverlays } from "./overlays";

const registry = new Map<StepId, StepImpl>();

/** Step registry: Shop (P0-07), Assemble (P0-16), Product (P0-17) each register an impl over the placeholder. */
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
  // Two-step works have no assemble/product: old links land on the bench (URL fixed too, so reload stays put).
  if (STEPS.some((s) => s.id === h) && !shownSteps().includes(h)) {
    history.replaceState(null, "", "#bench");
    return "bench";
  }
  return STEPS.some((s) => s.id === h) ? h : "bench";
}

type Verdict = "ok" | "bad" | "warn" | "idle";
interface Chrome {
  /** Step the shell is drawing (stage filter and serial visibility follow it). */
  step: StepId;
  routed: boolean;
  workName: string;
  verdict: { text: string; state: Verdict };
  next: { label: string; to: StepId | null; why: string; onGo?: () => void; state: NextState };
  toast: { text: string; shown: boolean };
  /** Only the centre card: side columns and run group hidden (locked assembly, unify/Steps); reset on step change. */
  bare: boolean;
}
const chrome = createStore<Chrome>({
  step: stepFromHash(),
  routed: false,
  workName: "",
  verdict: { text: t("Checkpoints 0/0"), state: "idle" },
  next: { label: t("Next"), to: null, why: "", state: "lock" },
  toast: { text: "", shown: false },
  bare: false,
});
const setChrome = (p: Partial<Chrome>) => commit(() => chrome.set(p));
let verdictFn: (() => void) | null = null;

/** Fully redrawn region: each render changes the key so React rebuilds it, dropping imperative edits like innerHTML did. */
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
/** On phones, Shop/Assemble/Product blocks stack vertically, each as its own card. */
const mCard = "rounded-(--r) border border-line bg-(--panel) shadow-panel";
/** Phone stacking order (DESIGN_V2 §5): Shop verdict first; Assemble/Product put 3D first, then props, tools, tree. */
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
  const toastLift = useToastLift(c.toast.shown, c.toast.text, m.props);
  const phone = usePhone();
  const { step } = c;
  const bench = step === "bench";
  const own = step === "assemble" || step === "product";
  /** Phone bench: full-bleed stage with drawers; other steps scroll vertically with a sticky main button. */
  const pb = phone && bench;
  /** Phone product (P2-17, DESIGN_V2 §5): 3D fills the screen, bottom sheet has a serial line + keys; details are a drawer. */
  const pp = phone && step === "product";
  const pf = phone && !bench && !pp;
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
          // The step bar already shows checkpoint progress; hide this when narrow.
          "max-[1600px]:hidden",
        )}
      >
        {c.verdict.text}
      </button>
      {/* Next: one style, three states (DESIGN_V2 §6.3): outline, solid when just unlocked, grey with the reason when locked. */}
      <button
        id="next"
        type="button"
        data-state={c.next.state}
        disabled={!c.next.to}
        title={c.next.to ? "" : c.next.why}
        onClick={goNext}
        className={cn(
          "next inline-flex items-center gap-1.5 text-[13px]",
          topBtn,
          c.next.state === "hot"
            ? "border-accent-strong bg-accent-strong text-on-accent hover:opacity-90"
            : "border-accent-line text-accent-ink hover:bg-accent-bg",
          "disabled:cursor-not-allowed disabled:border-line disabled:bg-field disabled:font-normal disabled:text-muted disabled:hover:bg-field",
        )}
      >
        {c.next.state === "lock" && <Icon n="lock" size={13} />}
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
        // Assemble/Product have their own view: hide the bench 3D stage (it keeps running, not destroyed).
        own && "invisible",
        step === "shop" && "[&_canvas]:invisible",
      );
  const layerCls = pf
    ? cn("step-layer block empty:hidden", mo.layer)
    : pp
      ? "step-layer absolute inset-0"
      : "step-layer pointer-events-none fixed inset-0 z-1 flex items-center justify-center [&>*]:pointer-events-auto";
  const leftCls = pp || c.bare
    ? "hidden"
    : pb
      ? cn(
          "pnl left inset-0 z-40 flex-col overflow-hidden bg-surface",
          m.lib ? "fixed flex" : "hidden",
        )
      : pf
        ? cn("pnl left flex flex-col", mCard, mo.tree)
        : "pnl left fixed top-(--top-h) bottom-(--dock-h) left-0 z-2 flex w-(--left-w) flex-col overflow-hidden border-r border-line bg-surface";
  const propsCls = c.bare
    ? "hidden"
    : pb || pp
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
          toast={(s) => shell.toast(s)}
        />
      ) : (
        <TopBar
          step={step}
          workName={c.workName}
          bare={c.bare}
          right={right}
          toast={(s) => shell.toast(s)}
        />
      )}
      <section id="stage" aria-label={t("3D stage")} className={stageCls}>
        <card.View />
        <StageOverlays bench={bench} />
      </section>
      {pp ? (
        <div
          id="mProduct"
          className="fixed inset-x-0 top-(--top-h) bottom-0 z-1 flex flex-col"
        >
          <div className="relative min-h-0 flex-1">
            <layer.View tag="main" label={t("Current step")} className={layerCls} />
            <button
              id="verdict"
              type="button"
              data-state={c.verdict.state}
              onClick={() => verdictFn?.()}
              className={cn(
                verdictCls,
                "absolute right-2 bottom-2 z-3 h-11 max-w-[60%] cursor-pointer truncate rounded-full border border-line bg-(--panel) px-3 shadow-panel",
              )}
            >
              {c.verdict.text}
            </button>
          </div>
          <div
            id="mProductSheet"
            className="flex-none rounded-t-[18px] border-t border-line bg-surface px-4 pt-2.5 pb-[calc(12px+env(safe-area-inset-bottom))] shadow-[0_-6px_20px_#0000001a]"
          >
            {/* Serial line: opens the bench's serial drawer at half height; closing returns here. */}
            <button
              type="button"
              id="mSerialOpen"
              aria-label={t("Open serial drawer")}
              onClick={() =>
                setMui({ sheet: "half", props: false, more: false, lib: null })
              }
              className="block w-full cursor-pointer border-0 bg-transparent p-0 text-left"
            >
              <SerialStrip />
            </button>
            <toolbar.View step={step} />
            {c.next.to && (
              <button
                id="next"
                type="button"
                onClick={goNext}
                className="next mt-2 flex h-12 w-full cursor-pointer items-center justify-center rounded-xl border-0 bg-accent-strong px-3 text-[15px] font-medium text-on-accent"
              >
                <span className="max-w-full truncate">{c.next.label}</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <layer.View tag="main" label={t("Current step")} className={layerCls} />
      )}
      {!phone && step === "assemble" && (
        <div
          aria-hidden="true"
          className="fixed top-(--top-h) right-(--right-w) bottom-(--dock-h) left-(--left-w) bg-(image:--stage-bg)"
        />
      )}

      <aside aria-label={t("Build tree")} className={leftCls}>
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
        label={t("Properties panel")}
        live
        className={propsCls}
        head={
          pb || pp ? (
            <SheetHead
              title={pp ? t("Details") : t("Properties")}
              id="propsClose"
              onClose={() => setMui({ props: false })}
            />
          ) : (
            <LessonCard step={step} />
          )
        }
      />

      {pp ? null : pf ? (
        <div className={mo.tools}>
          <toolbar.View step={step} />
        </div>
      ) : (
        <toolbar.View step={step} />
      )}

      <Dock
        // Phone product borrows the bench serial drawer when the strip is opened.
        step={pp && m.sheet !== "peek" ? "bench" : step}
        toast={(s) => shell.toast(s)}
        timeline={<timeline.View />}
        simtime={
          <>
            <span
              id="simtime"
              className="mono simtime flex-none font-mono text-xs text-muted"
              title={t("Sim time")}
            />
            {/* Speed vs real hardware: red below 0.9× (discount timing-related behaviour). */}
            <span
              id="ratio"
              className="mono flex-none font-mono text-xs text-muted [&.slow]:text-bad-ink"
              title={t("Sim speed / real-hardware speed")}
            />
          </>
        }
      />
      {pf && (
        // Phone Shop/Assemble/Product: main buttons stick to the bottom (verdict left, next right).
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
            <span className="inline-flex max-w-full items-center gap-1 truncate">
              {c.next.state === "lock" && <Icon n="lock" size={14} className="flex-none" />}
              {c.next.label}
            </span>
            {!c.next.to && c.next.why && c.next.state !== "lock" && (
              <span className="max-w-full truncate text-[11px] font-normal">
                {c.next.why}
              </span>
            )}
          </button>
        </div>
      )}
      {/* Raw serial as appended text nodes (replay diff and regression scripts read it); the visible view is in the dock. */}
      <pre id="console" aria-hidden="true" className="sr-only" />
      <div
        id="toast"
        role="status"
        hidden={!c.toast.shown}
        style={phone && toastLift !== null ? { bottom: toastLift } : undefined}
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

/** Phone: keep the toast above the topmost open bottom drawer (DESIGN_V2 §10.4); returns bottom px or null */
function useToastLift(shown: boolean, text: string, propsOpen: boolean) {
  const [lift, setLift] = useState<number | null>(null);
  useEffect(() => {
    if (!shown) return;
    const measure = () => {
      let top = innerHeight;
      for (const el of document.querySelectorAll<HTMLElement>("#props, #fwMenu, #moreMenu, .qcard")) {
        if (el.id === "props" && !propsOpen) continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.top < innerHeight - 1) top = Math.min(top, r.top);
      }
      setLift(top < innerHeight ? innerHeight - top + 8 : null);
    };
    measure();
    // Drawers animate in, so measure again once they settle
    const id = window.setTimeout(measure, 350);
    return () => clearTimeout(id);
  }, [shown, text, propsOpen]);
  return lift;
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
  setBare(on) {
    setChrome({ bare: on });
  },
  setNext(label, to, why, onGo, state) {
    setChrome({ next: { label, to, why: why ?? "", onGo, state: state ?? (to ? "go" : "lock") } });
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

/** Shell component and API (main renders <ShellView/> before createSession). */
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
  setChrome({ step: id, bare: false });
  ctx.store.set({ step: id });
  if (!impl) {
    active = null;
    return;
  }
  active = { id, impl };
  impl.mount(ctx);
}

/** Start routing on the hash; all four steps share one page, so switching never reloads. */
export function startRouter(ctx: StepCtx) {
  ctxRef = ctx;
  window.addEventListener("hashchange", () => {
    const id = stepFromHash();
    if (id !== active?.id) remount(id);
  });
  remount(stepFromHash());
}
