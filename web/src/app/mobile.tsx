// Phone layout (U-05, DESIGN_V2 §5; mockups docs/design-v2/MobileWorkbench, MobileSteps), breakpoint = Tailwind md (< 768px).
// No separate state: same bc / toolbar / panel data, only rearranged (full-bleed bench, bottom sheets, full-page part library).
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { actions, bc, CUSTOM, EXAMPLE_ID, TWO_STEPS, shownSteps } from "./chrome";
import { Icon } from "./icons";
import { commit, useStore } from "./react";
import { createStore } from "./store";
import { CmdkBox } from "./cmdkview";
import { CRUMB, MoreMenu, RUN_TEXT, SPEEDS, WorkMenu } from "./topbar";
import { FwMenu } from "./fwmenu";
import { NetCondChip } from "./netcond";
import { lessonUi } from "./lesson";
import { LessonMapBtn } from "./lessonmap";
import { STEPS, type StepId } from "./types";
import type { Tool, ToolGroup } from "./toolbar";

const MQ = "(max-width: 767px)";
export const isPhone = () =>
  typeof matchMedia === "function" && matchMedia(MQ).matches;
function subPhone(cb: () => void) {
  const m = matchMedia(MQ);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
/** Notify when crossing the phone breakpoint (imperative code: the product step swaps its tools) */
export const onPhoneChange = (cb: () => void) =>
  typeof matchMedia === "function" ? subPhone(cb) : () => {};
export const usePhone = () =>
  useSyncExternalStore(subPhone, isPhone, () => false);

export type Sheet = "peek" | "half" | "full";
export type LibTab = "lib" | "tree" | "wires";
interface MobileUi {
  /** Serial sheet: peek bar / half / full */
  sheet: Sheet;
  /** Properties sheet open (when a part is selected) */
  props: boolean;
  /** Full-page part library (null = closed) */
  lib: LibTab | null;
  /** Toolbar "More" */
  more: boolean;
}
export const mui = createStore<MobileUi>({
  sheet: "peek",
  props: false,
  lib: null,
  more: false,
});
export const setMui = (p: Partial<MobileUi>) => commit(() => mui.set(p));
/** Tapped a part / build-tree row on a phone: open the properties sheet (desktop has it in the right column) */
export function phoneProps() {
  if (isPhone()) setMui({ props: true, lib: null, more: false, sheet: "peek" });
}
/** Collapse all sheets when switching steps */
export function resetPhoneUi() {
  setMui({ sheet: "peek", props: false, lib: null, more: false });
}

// ------------------------------------------------------------ Top bar + step bar
const backCls =
  "inline-flex h-11 flex-none items-center gap-0.5 rounded-[10px] border border-line bg-surface pr-3 pl-1.5 text-[13px] font-medium text-fg no-underline";

export function MobileTop({
  step,
  workName,
  toast,
}: {
  step: StepId;
  workName: string;
  toast: (msg: string) => void;
}) {
  const lesson = !!useStore(lessonUi).lesson && step === "bench";
  return (
    <header
      id="topbar"
      className="topbar fixed inset-x-0 top-0 z-20 flex h-(--top-h) flex-col border-b border-line bg-surface"
    >
      <div className="flex h-12 flex-none items-center gap-1 px-2.5">
        <a
          id="crumbHome"
          href={CRUMB.href}
          title={CRUMB.title}
          className={backCls}
        >
          <Icon n="left" size={18} />
          {CRUMB.label}
        </a>
        {lesson && <LessonMapBtn phone />}
        <div className="flex min-w-0 flex-1 justify-center">
          <WorkMenu name={EXAMPLE_ID ? t('Example · {name}', { name: workName }) : workName} phone />
        </div>
        <NetCondChip phone />
        <MoreMenu toast={toast} phone name={EXAMPLE_ID ? t('Example · {name}', { name: workName }) : workName} />
        <FwMenu phone />
        {/* The palette is hidden on narrow screens (max-[1100px]:hidden), but cmdk.ts needs #cmdk at startup */}
        <CmdkBox />
      </div>
      <MobileSteps step={step} />
    </header>
  );
}

function MobileSteps({ step }: { step: StepId }) {
  const { locks, done, checkpoints } = useStore(bc);
  const ok = checkpoints.filter((c) => c.state === "ok" || c.state === "ref").length;
  return (
    <nav
      id="steps"
      role="tablist"
      aria-label={TWO_STEPS ? t('Two steps') : t('Four steps')}
      // Widths follow the labels: equal columns truncated "Assemble" in English while "Shop" had room to spare
      className="steps flex h-[50px] flex-none gap-1 px-2.5 pb-1.5"
    >
      {STEPS.filter((s) => shownSteps().includes(s.id)).map((s, i) => {
        const on = s.id === step;
        const lock = locks[s.id];
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            data-step={s.id}
            aria-selected={on}
            data-locked={lock ? "" : undefined}
            title={lock ?? (done[s.id] ? t('{step} · done', { step: s.label }) : s.label)}
            onClick={() => (location.hash = s.id)}
            className={cn(
              "inline-flex min-w-0 flex-auto cursor-pointer items-center justify-center gap-1 rounded-lg border-0 bg-transparent px-1 text-[12.5px] whitespace-nowrap text-muted",
              on && "bg-accent-bg font-bold text-accent-ink",
              done[s.id] && !on && "text-ok-ink",
            )}
          >
            {done[s.id] && !on ? (
              <Icon n="check" size={13} />
            ) : (
              <span className="font-mono text-[11px]">{i + 1}</span>
            )}
            <span className="truncate">{s.label}</span>
            {lock && <Icon n="lock" size={12} className="flex-none" />}
            {on && s.id === "bench" && checkpoints.length > 0 && (
              <span className="font-mono text-[10.5px] font-normal">{`${ok}/${checkpoints.length}`}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ------------------------------------------------------------ On the bench: run state + checkpoint banner
const stBtn =
  "inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-full border border-line bg-(--panel) p-0 text-fg shadow-panel disabled:cursor-not-allowed disabled:text-muted";

export function MobileStageBar({ wiring }: { wiring: boolean }) {
  const { run, speed, checkpoints, retest } = useStore(bc);
  const [txt, dot] = RUN_TEXT[run];
  const live = run === "run" || run === "pause" || run === "seek";
  const i = checkpoints.findIndex((c) => c.state !== "ok" && c.state !== "ref");
  const cp = i >= 0 ? checkpoints[i] : null;
  return (
    <>
      <div
        hidden={wiring}
        className="absolute top-2 right-2 left-2 z-3 flex items-center gap-1.5 [&[hidden]]:hidden"
        id="runGroup"
        data-run={run}
        role="group"
        aria-label={t('Run state')}
      >
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-(--panel) px-3 text-xs shadow-panel">
          <span
            className={cn(
              "size-2 rounded-full",
              dot,
              run === "run" && "animate-pulse",
            )}
          />
          <span id="runState">{txt}</span>
          {actions.speed && (
            <button
              type="button"
              id="runSpeed"
              disabled={!live}
              title={t('Speed: changes wall-clock pace only; simulated time and results stay the same')}
              onClick={() =>
                actions.speed!(
                  SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length],
                )
              }
              className="-my-2 -mr-2 min-h-11 cursor-pointer border-0 bg-transparent px-2 font-mono text-xs text-fg disabled:text-muted"
            >
              · {speed}×
            </button>
          )}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          id="runPause"
          className={stBtn}
          disabled={!live}
          aria-label={run === "run" ? t('Pause') : t('Resume')}
          onClick={() =>
            run === "run" ? actions.pause?.() : actions.resume?.()
          }
        >
          <Icon n={run === "run" ? "pause" : "play"} size={16} />
        </button>
        <button
          type="button"
          id="runRestart"
          className={stBtn}
          disabled={!actions.reboot || run === "loading"}
          aria-label={t('Restart')}
          onClick={() => actions.reboot?.()}
        >
          <Icon n="restart" size={16} />
        </button>
      </div>
      {!wiring && checkpoints.length > 0 && (
        <div
          id="cpBanner"
          role="status"
          className={cn(
            "absolute top-[60px] right-2 left-2 z-3 flex items-center gap-2 rounded-xl border px-3 py-1.5 shadow-panel",
            cp
              ? "border-(--warn-line) bg-(--ch-bg) text-fg"
              : retest === false
                ? "border-(--warn-line) bg-warn-bg text-warn-ink"
                : "border-(--ok-line) bg-ok-bg text-ok-ink",
          )}
        >
          <span className="min-w-0 flex-1 text-[13px] leading-snug">
            {cp ? (
              <>
                <b className="font-medium">{t('Checkpoint {n}', { n: i + 1 })}</b>
                <span className="text-muted"> · </span>
                <span className="break-words">{cp.title}</span>
              </>
            ) : (
              <b className="font-medium">
                {retest === false
                  ? t('Checkpoints {n}/{n} passed · power-on retest ✗', { n: checkpoints.length })
                  : t('All {n} checkpoints pass', { n: checkpoints.length })}
              </b>
            )}
          </span>
          {cp && actions.runAllRef && (
            <button
              type="button"
              id="cpAllRefM"
              disabled={cp.state === "run"}
              title={t('Run each checkpoint with the work’s reference firmware (◐); this also unlocks assembly')}
              onClick={() => actions.runAllRef?.()}
              className="min-h-11 flex-none cursor-pointer rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-fg disabled:text-muted"
            >
              {cp.state === "run" ? t('Checking…') : t('Run built-in')}
            </button>
          )}
          <button
            type="button"
            id="cpGo"
            onClick={() => {
              // Board-picker works have no assembly step: after all pass, next is the buy card
              if (!cp) return void (CUSTOM ? actions.openBuy?.() : (location.hash = "assemble"));
              actions.selectCheckpoint?.(cp.id);
              phoneProps();
            }}
            className="min-h-11 flex-none cursor-pointer rounded-lg border-0 bg-fg px-3 text-[13px] font-medium text-surface"
          >
            {cp ? t('Take me there') : CUSTOM ? t('Next: make it real') : t('Next: assemble')}
          </button>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------ Bottom toolbar (bench) and tool grid (other steps)
const BENCH_MAIN: { id: string; label: string; icon: string }[] = [
  { id: "select", label: t('Select'), icon: "cursor" },
  { id: "wire", label: t('Wire'), icon: "wire" },
  { id: "lib", label: t('Add part'), icon: "plus" },
  { id: "meter", label: t('Measure'), icon: "meter" },
  { id: "more", label: t('More'), icon: "more" },
];
// The analyzer isn't drawn on phones (too narrow for waveforms) and Place isn't open yet: keep them out of More
const NOT_ON_PHONE = new Set(["select", "wire", "meter", "scope", "place", "view3d"]);
// More drawer sections, board actions -> capture -> view (DESIGN_V2 §10.2 / §8.4); desktop keeps its own group order
const SECTION_TITLE: Record<string, string> = {
  act: t('Board controls'),
  media: t('Capture'),
  view: t('View tools'),
};
const BENCH_SECTIONS: { id: string; from: string[]; order: string[] }[] = [
  { id: "act", from: ["act"], order: ["button", "heat", "sound"] },
  { id: "media", from: ["media"], order: ["photo", "rec"] },
  { id: "view", from: ["view", "nav", "look", "measure"], order: ["schematic", "orbit", "ext", "ruler"] },
];
const BENCH_ICON: Record<string, string> = {
  button: "boot",
  heat: "flame",
  photo: "camera",
  orbit: "orbit",
  ext: "cube",
  ruler: "ruler",
  schematic: "wire",
};
const rank = (order: string[], id: string) => {
  const i = order.indexOf(id);
  return i < 0 ? order.length : i;
};

function StateTag({ tool }: { tool: Tool }) {
  if (tool.kind !== "tag" || !tool.on) return null;
  const on = tool.on();
  return (
    <span
      data-state={on ? "on" : "off"}
      className={cn(
        "rounded-full border px-1.5 text-[11px] leading-[18px] font-medium",
        on ? "border-accent bg-accent-bg text-accent-ink" : "border-line bg-field text-muted",
      )}
    >
      {on ? t('on') : (tool.offTag ?? t('off'))}
    </span>
  );
}

function SectionTitle({ id, tight }: { id: string; tight?: boolean }) {
  return SECTION_TITLE[id] ? (
    <div
      className={cn("m-group-title px-0.5 text-[12px] text-muted", tight ? "leading-[14px]" : "pt-1")}
      data-group-title={id}
    >
      {SECTION_TITLE[id]}
    </div>
  ) : null;
}

export function PhoneToolbar({
  step,
  groups,
  active,
  fire,
}: {
  step: string;
  groups: ToolGroup[];
  active: string | null;
  fire: (id: string) => void;
}) {
  const ui = useStore(mui);
  const { sound } = useStore(bc);
  if (step !== "bench") {
    const all = groups.flatMap((g) => g.tools);
    if (!all.length) return null;
    // Other steps: a 44-tall button grid under the 3D view (product: inside the bottom panel, P2-17, no extra card), titled per
    // section like the bench More drawer. The primary button (retest) takes its own 48-tall row last (DESIGN_V2 §9.5)
    const titled = groups.some((g) => SECTION_TITLE[g.id]);
    const grid = (tools: Tool[]) => {
      // Up to five across (G-16b Dial: four timer keys + sound), so the 3D view keeps ≥ 45% of the screen
      const cols = Math.min(5, Math.max(1, tools.filter((x) => !x.primary).length));
      return cn(
        "grid gap-1.5",
        ["grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4 max-[360px]:grid-cols-3", "grid-cols-5 max-[360px]:grid-cols-3"][cols - 1],
      );
    };
    const btn = (tool: Tool) => {
      const on = tool.on?.();
      return (
        <button
          key={tool.id}
          type="button"
          data-tool={tool.id}
          aria-pressed={tool.id === active || (tool.kind === "tag" && !!on)}
          onClick={() => fire(tool.id)}
          className={cn(
            "tb-btn flex min-h-11 min-w-0 cursor-pointer items-center justify-center gap-1 rounded-[10px] border border-line bg-surface px-1 text-[12.5px] leading-tight text-fg aria-pressed:border-accent aria-pressed:bg-accent-bg aria-pressed:text-accent-ink",
            tool.primary &&
              "primary col-span-full min-h-12 border-accent-strong bg-accent-strong text-[15px] font-semibold text-on-accent",
            tool.todo && "todo text-muted",
          )}
        >
          {tool.icon && <Icon n={tool.icon} size={15} className="shrink-0" />}
          <span className="min-w-0">{tool.label}</span>
          <StateTag tool={tool} />
        </button>
      );
    };
    return (
      <div
        id="toolbar"
        role="toolbar"
        aria-label={step === "product" ? t('Product buttons') : undefined}
        className={cn(
          "toolbar",
          titled ? "flex flex-col gap-1" : grid(all),
          step === "product"
            ? "mt-2"
            : "pnl rounded-(--r) border border-line bg-(--panel) p-2 shadow-panel",
        )}
      >
        {titled
          ? groups.map((g) => {
              const tools = [...g.tools.filter((x) => !x.primary), ...g.tools.filter((x) => x.primary)];
              return tools.length ? (
                <div key={g.id} data-group={g.id} className="flex flex-col gap-0.5">
                  <SectionTitle id={g.id} tight />
                  <div className={grid(tools)}>{tools.map(btn)}</div>
                </div>
              ) : null;
            })
          : [...all.filter((x) => !x.primary), ...all.filter((x) => x.primary)].map(btn)}
      </div>
    );
  }
  const soundTool: Tool | null = sound.has
    ? { id: "sound", label: t('Sound'), icon: sound.on ? "sound" : "mute", kind: "tag", on: () => sound.on, offTag: t('muted') }
    : null;
  const sections = BENCH_SECTIONS.map((s) => ({
    id: s.id,
    tools: [...groups.filter((g) => s.from.includes(g.id)).flatMap((g) => g.tools), ...(s.id === "act" && soundTool ? [soundTool] : [])]
      .filter((x) => !NOT_ON_PHONE.has(x.id))
      .sort((a, b) => rank(s.order, a.id) - rank(s.order, b.id)),
  })).filter((s) => s.tools.length);
  const onMain = (id: string) => {
    if (id === "lib")
      return setMui({ lib: ui.lib ? null : "lib", more: false, props: false });
    if (id === "more") return setMui({ more: !ui.more, props: false });
    setMui({ more: false, lib: null, props: false, sheet: "peek" });
    fire(id);
  };
  const on = (id: string) =>
    id === "lib" ? !!ui.lib : id === "more" ? ui.more : id === active;
  // Switches and sound keep the drawer open so the flip is visible; actions close it (their toast / card shows next)
  const run = (tool: Tool) => {
    if (tool.id === "sound") return actions.sound?.();
    if (tool.id === "orbit") return fire(active === "orbit" ? "select" : "orbit");
    if (tool.kind !== "switch") setMui({ more: false });
    fire(tool.id);
  };
  const tile = (tool: Tool) => {
    const boot = tool.id === "button";
    const icon = tool.icon ?? (tool.id === "rec" ? (tool.on?.() ? "stop" : "record") : BENCH_ICON[tool.id]);
    return (
      <button
        key={tool.id}
        type="button"
        data-tool={tool.id}
        aria-pressed={tool.kind === "tag" ? !!tool.on?.() : tool.id === active}
        onClick={() => run(tool)}
        className={cn(
          "tb-btn flex min-h-12 min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-[10px] border border-line bg-surface px-1 py-1.5 text-[13px] leading-tight text-fg",
          boot
            ? "primary border-accent-strong bg-accent-strong font-semibold text-on-accent"
            : "aria-pressed:border-accent aria-pressed:bg-accent-bg aria-pressed:text-accent-ink",
        )}
      >
        {icon && <Icon n={icon} size={20} />}
        <span className="flex max-w-full flex-wrap items-center justify-center gap-1">
          <span className="min-w-0">{tool.label}</span>
          <StateTag tool={tool} />
        </span>
      </button>
    );
  };
  const row = (tool: Tool) => {
    const sw = tool.kind === "switch";
    const checked = tool.id === "orbit" ? active === "orbit" : !!tool.on?.();
    return (
      <button
        key={tool.id}
        type="button"
        data-tool={tool.id}
        role={sw ? "switch" : undefined}
        aria-checked={sw ? checked : undefined}
        aria-pressed={sw ? undefined : tool.id === active}
        onClick={() => run(tool)}
        className="tb-btn flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[10px] border border-line bg-surface px-3 text-left text-[14px] text-fg aria-pressed:border-accent aria-pressed:bg-accent-bg aria-pressed:text-accent-ink"
      >
        <Icon n={tool.icon ?? BENCH_ICON[tool.id] ?? "more"} size={20} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1">{tool.phoneLabel ?? tool.label}</span>
        {sw && (
          <span
            aria-hidden="true"
            className={cn(
              "relative h-6 w-10 shrink-0 rounded-full transition-colors",
              checked ? "bg-accent-strong" : "bg-line",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-5 rounded-full bg-surface shadow transition-[left]",
                checked ? "left-[18px]" : "left-0.5",
              )}
            />
          </span>
        )}
      </button>
    );
  };
  return (
    <>
      {ui.more && (
        <div
          id="moreTools"
          role="group"
          aria-label={t('More tools')}
          className="fixed inset-x-0 bottom-(--m-tb) z-26 flex max-h-[calc(100dvh-var(--m-tb)-56px)] flex-col gap-1.5 overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-3 shadow-[0_-8px_24px_#0000001f]"
        >
          {sections.map((s) => (
            <div key={s.id} data-group={s.id} className="flex flex-col gap-1.5">
              <SectionTitle id={s.id} />
              {s.id === "view" ? (
                <div className="flex flex-col gap-1.5">{s.tools.map(row)}</div>
              ) : (
                <div className="grid grid-cols-3 gap-1.5">{s.tools.map(tile)}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <nav
        id="toolbar"
        role="toolbar"
        aria-label={t('Tools')}
        className="toolbar fixed inset-x-0 bottom-0 z-27 grid h-(--m-tb) grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        {BENCH_MAIN.map((tool) => (
          <button
            key={tool.id}
            type="button"
            data-mtool={tool.id}
            data-tool={tool.id === "lib" || tool.id === "more" ? undefined : tool.id}
            aria-pressed={on(tool.id)}
            onClick={() => onMain(tool.id)}
            className="m-1 flex cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[10px] border-0 bg-transparent text-[11px] text-muted aria-pressed:bg-accent-bg aria-pressed:font-medium aria-pressed:text-accent-ink"
          >
            <Icon n={tool.icon} size={22} />
            {tool.label}
          </button>
        ))}
      </nav>
    </>
  );
}

// ------------------------------------------------------------ Sheet header (properties / part library)
export function SheetHead({
  title,
  id,
  onClose,
  children,
}: {
  title: ReactNode;
  id: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-2 -mx-4 mb-1 flex items-center gap-2 border-b border-line-soft bg-surface px-4 py-1">
      <b className="min-w-0 flex-1 truncate text-[15px]">{title}</b>
      {children}
      <button
        type="button"
        id={id}
        aria-label={t('Close')}
        onClick={onClose}
        className="inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-field p-0 text-fg"
      >
        <Icon n="x" size={18} />
      </button>
    </div>
  );
}

/** Sheet handle: tap or drag to change size (only vertical moves ≥ 28px count, so taps aren't misread) */
export function Grab({
  onUp,
  onDown,
  onTap,
  label,
}: {
  onUp: () => void;
  onDown: () => void;
  onTap: () => void;
  label: string;
}) {
  const drag = useRef<{ y0: number; moved: boolean } | null>(null);
  return (
    <button
      type="button"
      id="sheetGrab"
      aria-label={label}
      className="flex h-6 w-full flex-none cursor-pointer touch-none items-center justify-center border-0 bg-transparent p-0"
      onPointerDown={(e) => {
        drag.current = { y0: e.clientY, moved: false };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.moved || Math.abs(e.clientY - d.y0) < 28) return;
        d.moved = true;
        if (e.clientY < d.y0) onUp();
        else onDown();
      }}
      onClick={() => {
        const moved = drag.current?.moved;
        drag.current = null;
        if (!moved) onTap();
      }}
    >
      <span className="h-[5px] w-10 rounded-full bg-line" />
    </button>
  );
}
