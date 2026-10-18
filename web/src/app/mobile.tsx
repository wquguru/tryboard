// 手机布局（U-05，DESIGN_V2 §5；设计稿 docs/design-v2/MobileWorkbench、MobileSteps）。
// 断点与 Tailwind 的 md 一致（< 768px）。手机上不另起一套状态：顶栏、四步条、工具条、串口、属性面板都读同一份
// bc / 工具条 / 面板数据，只换摆法——实验台铺满台面，串口和属性面板变成底部抽屉，元件库变成整页。
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "../ui/cn";
import { actions, bc, BLANK, EXAMPLE_ID, shownSteps } from "./chrome";
import { Icon } from "./icons";
import { commit, useStore } from "./react";
import { createStore } from "./store";
import { CmdkBox } from "./cmdk";
import { CRUMB, MoreMenu, RUN_TEXT, SPEEDS, WorkMenu } from "./topbar";
import { FwMenu } from "./fwmenu";
import { STEPS, type StepId } from "./types";

const MQ = "(max-width: 767px)";
export const isPhone = () =>
  typeof matchMedia === "function" && matchMedia(MQ).matches;
function subPhone(cb: () => void) {
  const m = matchMedia(MQ);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
/** 跨过手机断点时通知（命令式代码用：成品步骤要换一套工具） */
export const onPhoneChange = (cb: () => void) =>
  typeof matchMedia === "function" ? subPhone(cb) : () => {};
export const usePhone = () =>
  useSyncExternalStore(subPhone, isPhone, () => false);

export type Sheet = "peek" | "half" | "full";
export type LibTab = "lib" | "tree" | "wires";
interface MobileUi {
  /** 串口抽屉：窥视条 / 半屏 / 全屏 */
  sheet: Sheet;
  /** 属性抽屉开着（选中零件时） */
  props: boolean;
  /** 整页元件库（null = 关） */
  lib: LibTab | null;
  /** 工具条「更多」 */
  more: boolean;
}
export const mui = createStore<MobileUi>({
  sheet: "peek",
  props: false,
  lib: null,
  more: false,
});
export const setMui = (p: Partial<MobileUi>) => commit(() => mui.set(p));
/** 手机上点了一个零件 / 一行构建树：打开属性抽屉（桌面什么都不做，属性面板一直在右栏） */
export function phoneProps() {
  if (isPhone()) setMui({ props: true, lib: null, more: false, sheet: "peek" });
}
/** 换步骤时抽屉全收起 */
export function resetPhoneUi() {
  setMui({ sheet: "peek", props: false, lib: null, more: false });
}

// ------------------------------------------------------------ 顶栏 + 四步条
const backCls =
  "inline-flex h-11 flex-none items-center gap-0.5 rounded-[10px] border border-line bg-surface pr-3 pl-1.5 text-[13px] font-medium text-fg no-underline";

export function MobileTop({
  step,
  workName,
  toast,
}: {
  step: StepId;
  workName: string;
  toast: (t: string) => void;
}) {
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
        <div className="flex min-w-0 flex-1 justify-center">
          <WorkMenu name={EXAMPLE_ID ? `示例 · ${workName}` : workName} phone />
        </div>
        <MoreMenu toast={toast} phone />
        <FwMenu phone />
        {/* 命令框窄屏本来就藏着（max-[1100px]:hidden），但 cmdk.ts 启动时要找到 #cmdk */}
        <CmdkBox />
      </div>
      <MobileSteps step={step} />
    </header>
  );
}

function MobileSteps({ step }: { step: StepId }) {
  const { locks, done, checkpoints } = useStore(bc);
  const ok = checkpoints.filter((c) => c.state === "ok").length;
  return (
    <nav
      id="steps"
      role="tablist"
      aria-label={BLANK ? "两个步骤" : "四个步骤"}
      className={cn("steps grid h-[50px] flex-none gap-1 px-2.5 pb-1.5", BLANK ? "grid-cols-2" : "grid-cols-4")}
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
            title={lock ?? (done[s.id] ? `${s.label} · 已完成` : s.label)}
            onClick={() => (location.hash = s.id)}
            className={cn(
              "inline-flex min-w-0 cursor-pointer items-center justify-center gap-1 rounded-lg border-0 bg-transparent px-1 text-[12.5px] whitespace-nowrap text-muted",
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

// ------------------------------------------------------------ 台面上：运行状态 + 检查点横幅
const stBtn =
  "inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-full border border-line bg-(--panel) p-0 text-fg shadow-panel disabled:cursor-not-allowed disabled:text-muted";

export function MobileStageBar({ wiring }: { wiring: boolean }) {
  const { run, speed, checkpoints, retest } = useStore(bc);
  const [t, dot] = RUN_TEXT[run];
  const live = run === "run" || run === "pause" || run === "seek";
  const i = checkpoints.findIndex((c) => c.state !== "ok");
  const cp = i >= 0 ? checkpoints[i] : null;
  return (
    <>
      <div
        hidden={wiring}
        className="absolute top-2 right-2 left-2 z-3 flex items-center gap-1.5 [&[hidden]]:hidden"
        id="runGroup"
        data-run={run}
        role="group"
        aria-label="运行状态"
      >
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-(--panel) px-3 text-xs shadow-panel">
          <span
            className={cn(
              "size-2 rounded-full",
              dot,
              run === "run" && "animate-pulse",
            )}
          />
          <span id="runState">{t}</span>
          {actions.speed && (
            <button
              type="button"
              id="runSpeed"
              disabled={!live}
              title="倍速：只改跑得快慢（墙钟），模拟时刻和结果不变"
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
          aria-label={run === "run" ? "暂停" : "继续"}
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
          aria-label="重启"
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
                <b className="font-medium">检查点 {i + 1}</b>
                <span className="text-muted"> · </span>
                <span className="break-words">{cp.title}</span>
              </>
            ) : (
              <b className="font-medium">
                {retest === false
                  ? `检查点 ${checkpoints.length}/${checkpoints.length} 通过 · 开机复测 ✗`
                  : `${checkpoints.length} 个检查点全部通过`}
              </b>
            )}
          </span>
          <button
            type="button"
            id="cpGo"
            onClick={() => {
              if (!cp) return void (location.hash = "assemble");
              actions.selectCheckpoint?.(cp.id);
              phoneProps();
            }}
            className="min-h-11 flex-none cursor-pointer rounded-lg border-0 bg-fg px-3 text-[13px] font-medium text-surface"
          >
            {cp ? "带我去" : "下一步：组装"}
          </button>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------ 底部工具条（实验台）与工具网格（别的步骤）
export interface PhoneTool {
  id: string;
  label: string;
  primary?: boolean;
  todo?: boolean;
}
const BENCH_MAIN: { id: string; label: string; icon: string }[] = [
  { id: "select", label: "选择", icon: "cursor" },
  { id: "wire", label: "连线", icon: "wire" },
  { id: "lib", label: "加零件", icon: "plus" },
  { id: "meter", label: "测量", icon: "meter" },
  { id: "more", label: "更多", icon: "more" },
];
// 分析仪在手机上不画（太窄看不了波形），「放置」还没开放：不进「更多」
const NOT_ON_PHONE = new Set(["select", "wire", "meter", "scope", "place"]);

export function PhoneToolbar({
  step,
  tools,
  active,
  fire,
}: {
  step: string;
  tools: PhoneTool[];
  active: string | null;
  fire: (id: string) => void;
}) {
  const ui = useStore(mui);
  if (step !== "bench") {
    if (!tools.length) return null;
    // 别的步骤：工具排成 44 高的按键网格，放在 3D 下面；成品的网格在底部面板里（P2-17），不再套一层卡片
    return (
      <div
        id="toolbar"
        role="toolbar"
        aria-label={step === "product" ? "成品按键" : undefined}
        className={cn(
          "toolbar grid grid-cols-4 gap-1.5 max-[360px]:grid-cols-3",
          step === "product"
            ? "mt-2"
            : "pnl rounded-(--r) border border-line bg-(--panel) p-2 shadow-panel",
        )}
      >
        {tools.map((t) => (
          <button
            key={t.id}
            type="button"
            data-tool={t.id}
            aria-pressed={t.id === active}
            onClick={() => fire(t.id)}
            className={cn(
              "tb-btn min-h-11 min-w-0 cursor-pointer rounded-[10px] border border-line bg-surface px-1 text-[12.5px] leading-tight text-fg aria-pressed:border-accent aria-pressed:bg-accent-bg aria-pressed:text-accent-ink",
              t.primary &&
                "primary border-accent-strong bg-accent-strong font-medium text-on-accent",
              t.todo && "todo text-muted",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    );
  }
  const more = tools.filter((t) => !NOT_ON_PHONE.has(t.id));
  const onMain = (id: string) => {
    if (id === "lib")
      return setMui({ lib: ui.lib ? null : "lib", more: false, props: false });
    if (id === "more") return setMui({ more: !ui.more, props: false });
    setMui({ more: false, lib: null, props: false, sheet: "peek" });
    fire(id);
  };
  const on = (id: string) =>
    id === "lib" ? !!ui.lib : id === "more" ? ui.more : id === active;
  return (
    <>
      {ui.more && (
        <div
          id="moreTools"
          role="menu"
          aria-label="更多工具"
          className="fixed inset-x-0 bottom-(--m-tb) z-26 grid grid-cols-3 gap-1.5 rounded-t-2xl border-t border-line bg-surface p-3 shadow-[0_-8px_24px_#0000001f]"
        >
          {more.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              data-tool={t.id}
              aria-pressed={t.id === active}
              onClick={() => {
                setMui({ more: false });
                fire(t.id);
              }}
              className={cn(
                "tb-btn min-h-11 min-w-0 cursor-pointer rounded-[10px] border border-line bg-surface px-1 text-[13px] text-fg aria-pressed:border-accent aria-pressed:bg-accent-bg aria-pressed:text-accent-ink",
                t.primary &&
                  "primary border-accent-strong bg-accent-strong font-medium text-on-accent",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <nav
        id="toolbar"
        role="toolbar"
        aria-label="工具"
        className="toolbar fixed inset-x-0 bottom-0 z-27 grid h-(--m-tb) grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        {BENCH_MAIN.map((t) => (
          <button
            key={t.id}
            type="button"
            data-mtool={t.id}
            data-tool={t.id === "lib" || t.id === "more" ? undefined : t.id}
            aria-pressed={on(t.id)}
            onClick={() => onMain(t.id)}
            className="m-1 flex cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[10px] border-0 bg-transparent text-[11px] text-muted aria-pressed:bg-accent-bg aria-pressed:font-medium aria-pressed:text-accent-ink"
          >
            <Icon n={t.icon} size={22} />
            {t.label}
          </button>
        ))}
      </nav>
    </>
  );
}

// ------------------------------------------------------------ 抽屉头（属性 / 元件库）
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
        aria-label="关闭"
        onClick={onClose}
        className="inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-field p-0 text-fg"
      >
        <Icon n="x" size={18} />
      </button>
    </div>
  );
}

/** 抽屉手柄：点一下切档，上下拖切档（只认竖直方向 ≥ 28px 的动作，免得和点按打架） */
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
