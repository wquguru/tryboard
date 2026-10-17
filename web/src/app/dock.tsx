// 实验台 v2 底部坞（DESIGN_V2 §4）：串口 / 代码 / 逻辑分析仪 / 运行记录 / 检查点 / 问题，可拖高度、可收起。
// 串口原文仍追加进隐藏的 #console（文本节点原样，回归脚本和重放对拍读它）；看得见的是这里按行切开的视图：
// 过滤、时间戳（收到这段文字时的模拟时刻）、按 ESP-IDF 级别着色、跟随最新。行视图命令式维护，不经 React——
// 串口一秒能来几百行，整块重画太贵。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../ui/cn";
import { actions, bc, setDock, type DockTab } from "./chrome";
import { Icon } from "./icons";
import { useStore } from "./react";
import { createStore } from "./store";
import { Grab, mui, phoneProps, setMui, usePhone } from "./mobile";

interface Line {
  t: number;
  text: string;
  lv: "E" | "W" | "I" | "D" | "";
}
const MAX_LINES = 4000;
// ESP-IDF 日志行：可选的 ANSI 颜色头，然后 "E (1234) tag: …"
const ANSI = /\x1b\[[0-9;]*m/g;
const levelOf = (s: string): Line["lv"] => {
  const m = /^([EWID]) \(\d+\)/.exec(s);
  return (m?.[1] as Line["lv"]) ?? "";
};

type SerialUi = {
  filter: string;
  stamps: boolean;
  follow: boolean;
  eol: string;
};
const ui = createStore<SerialUi>({
  filter: "",
  stamps: true,
  follow: true,
  eol: "\r\n",
});

function createSerialModel() {
  let lines: Line[] = [];
  let pending = "";
  let pendingT = 0;
  let host: HTMLElement | null = null;
  let tail: HTMLElement | null = null;
  /** 手机的窥视条 / 成品串口条：只显示最后一行（命令式改 textContent，和行视图一样不经 React） */
  const peeks = new Set<HTMLElement>();
  let peekRaf = 0;
  const lastLine = () => {
    const p = pending.replace(ANSI, "").trim();
    if (p) return p;
    for (let i = lines.length - 1; i >= 0; i--)
      if (lines[i].text.trim()) return lines[i].text;
    return "";
  };
  function updPeek() {
    if (!peeks.size || peekRaf) return;
    peekRaf = requestAnimationFrame(() => {
      peekRaf = 0;
      const t = lastLine() || "还没有串口输出";
      for (const el of peeks) if (el.textContent !== t) el.textContent = t;
    });
  }

  const match = (l: Line) => {
    const f = ui.get().filter.trim().toLowerCase();
    return !f || l.text.toLowerCase().includes(f);
  };
  const lvCls: Record<string, string> = {
    E: "text-bad-ink",
    W: "text-warn-ink",
    I: "",
    D: "text-muted",
    "": "",
  };
  function lineEl(l: Line) {
    const d = document.createElement("div");
    d.className = "sl " + lvCls[l.lv];
    if (l.lv) d.dataset.lv = l.lv;
    if (ui.get().stamps) {
      const s = document.createElement("span");
      s.className = "st mr-2 text-muted select-none";
      s.textContent = l.t.toFixed(3);
      d.append(s);
    }
    d.append(l.text || " ");
    return d;
  }
  function stick() {
    if (host && ui.get().follow) host.scrollTop = host.scrollHeight;
  }
  function renderAll() {
    if (!host) return;
    host.replaceChildren();
    tail = null;
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const l of lines)
      if (match(l)) {
        frag.append(lineEl(l));
        n++;
      }
    host.append(frag);
    renderTail();
    if (!n && !pending) {
      const e = document.createElement("div");
      e.className = "sl-empty text-muted";
      e.textContent = lines.length
        ? `没有包含「${ui.get().filter}」的行`
        : "还没有串口输出";
      host.append(e);
    }
    stick();
  }
  function renderTail() {
    if (!host) return;
    tail?.remove();
    tail = null;
    if (!pending) return;
    const l: Line = {
      t: pendingT,
      text: pending.replace(ANSI, ""),
      lv: levelOf(pending.replace(ANSI, "")),
    };
    if (!match(l)) return;
    tail = lineEl(l);
    host.append(tail);
  }
  return {
    attach(el: HTMLElement | null) {
      host = el;
      renderAll();
    },
    attachPeek(el: HTMLElement, on: boolean) {
      if (on) peeks.add(el);
      else peeks.delete(el);
      updPeek();
    },
    push(text: string, tSec: number) {
      updPeek();
      if (!pending) pendingT = tSec;
      const parts = (pending + text).split("\n");
      pending = parts.pop()!;
      const add: Line[] = [];
      for (const raw of parts) {
        const s = raw.replace(/\r$/, "").replace(ANSI, "");
        add.push({ t: pendingT, text: s, lv: levelOf(s) });
        pendingT = tSec;
      }
      if (!pending) pendingT = tSec;
      if (!add.length && host) {
        renderTail();
        stick();
        return;
      }
      lines.push(...add);
      if (lines.length > MAX_LINES) {
        lines = lines.slice(-MAX_LINES * 0.75);
        renderAll();
        return;
      }
      if (!host) return;
      host.querySelector(".sl-empty")?.remove();
      tail?.remove();
      tail = null;
      const frag = document.createDocumentFragment();
      for (const l of add) if (match(l)) frag.append(lineEl(l));
      host.append(frag);
      renderTail();
      stick();
    },
    reset(text: string, tSec: number) {
      lines = [];
      pending = "";
      if (text) this.push(text, tSec);
      renderAll();
      updPeek();
    },
    text: () =>
      lines
        .filter(match)
        .map((l) => (ui.get().stamps ? `${l.t.toFixed(3)}  ` : "") + l.text)
        .join("\n") + (pending ? "\n" + pending : ""),
    renderAll,
    count: () => lines.length,
  };
}
export const serial = createSerialModel();
ui.subscribe(() => serial.renderAll(), ["filter", "stamps"]);

const dtab =
  "dtab relative inline-flex h-[38px] flex-none cursor-pointer items-center gap-1.5 border-0 bg-transparent px-3 text-[13px] whitespace-nowrap text-muted hover:text-fg aria-selected:font-medium aria-selected:text-accent-ink aria-selected:shadow-[inset_0_-2px_0_var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted";
const pill = (warn?: boolean) =>
  cn(
    "rounded-full px-1.5 font-mono text-[11px] leading-[18px]",
    warn ? "bg-warn-bg text-warn-ink" : "bg-field text-muted",
  );
const ib =
  "inline-flex size-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-field hover:text-fg aria-pressed:text-ok-ink";

function SerialView() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    serial.attach(ref.current);
    return () => serial.attach(null);
  }, []);
  return (
    <div
      id="serialView"
      ref={ref}
      role="log"
      aria-label="串口输出"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        if (ui.get().follow !== bottom) ui.set({ follow: bottom });
      }}
      className="serial-view min-h-0 flex-1 overflow-auto bg-(--scope-bg) px-3 py-1.5 font-mono text-[12.5px] leading-[1.7] break-all whitespace-pre-wrap"
    />
  );
}

const EOLS: [string, string][] = [
  ["\r\n", "\\r\\n"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["", "无"],
];
function SerialInput({ phone }: { phone?: boolean }) {
  const { eol } = useStore(ui);
  const [v, setV] = useState("");
  const can = !!actions.uart;
  return (
    <form
      className={cn(
        "flex h-10 flex-none items-center gap-2 border-t border-line-soft px-3",
        phone &&
          "h-auto gap-1.5 px-2.5 py-2 pb-[calc(8px+env(safe-area-inset-bottom))]",
      )}
      onSubmit={(e) => {
        e.preventDefault();
        if (!can) return;
        actions.uart!(v + eol);
        setV("");
      }}
    >
      <span className="font-mono text-muted">›</span>
      <input
        id="serialIn"
        value={v}
        disabled={!can}
        onChange={(e) => setV(e.currentTarget.value)}
        placeholder={can ? "发给串口，回车发送" : "会话还没就绪"}
        aria-label="发给串口"
        autoComplete="off"
        className={cn(
          "min-w-0 flex-1 border-0 bg-transparent font-mono text-[12.5px] text-fg outline-none",
          phone &&
            "h-11 rounded-xl border border-line bg-field px-3 text-[16px]",
        )}
      />
      <select
        id="serialEol"
        aria-label="行尾"
        title="回车时附加的行尾"
        value={eol}
        onChange={(e) => ui.set({ eol: e.currentTarget.value })}
        className={cn(
          "h-7 cursor-pointer rounded-md border border-line bg-surface px-1.5 font-mono text-xs text-fg",
          phone && "h-11 rounded-xl",
        )}
      >
        {EOLS.map(([k, t]) => (
          <option key={t} value={k}>
            {t}
          </option>
        ))}
      </select>
      {phone && (
        <button
          type="submit"
          id="serialSend"
          disabled={!can}
          className="h-11 w-16 flex-none cursor-pointer rounded-xl border-0 bg-accent-strong text-[14px] font-medium text-on-accent disabled:bg-field disabled:text-muted"
        >
          发送
        </button>
      )}
    </form>
  );
}

function SerialTools({ toast }: { toast: (t: string) => void }) {
  const s = useStore(ui);
  return (
    <div className="flex items-center gap-1.5 max-[1180px]:[&_.opt]:hidden">
      <input
        id="serialFilter"
        type="search"
        value={s.filter}
        onChange={(e) => ui.set({ filter: e.currentTarget.value })}
        placeholder="过滤"
        aria-label="过滤串口"
        className="h-7 w-40 rounded-md border border-line bg-field px-2 text-xs text-fg outline-none focus:border-accent max-[1100px]:w-24"
      />
      <button
        type="button"
        id="serialStamps"
        aria-pressed={s.stamps}
        onClick={() => ui.set({ stamps: !s.stamps })}
        title="收到这行时的模拟时刻（秒）"
        className={cn(ib, "opt w-auto px-1.5 text-xs whitespace-nowrap")}
      >
        时间戳 {s.stamps ? "开" : "关"}
      </button>
      <button
        type="button"
        id="serialFollow"
        aria-pressed={s.follow}
        onClick={() => {
          ui.set({ follow: !s.follow });
          if (!s.follow) serial.renderAll();
        }}
        title="新输出来了自动滚到最后"
        className={cn(ib, "opt w-auto px-1.5 text-xs whitespace-nowrap")}
      >
        跟随最新
      </button>
      <span
        className="opt font-mono text-xs text-muted"
        title="UART0 波特率（模拟器里不限速，只是标注）"
      >
        115200
      </span>
      <button
        type="button"
        id="serialCopy"
        className={ib}
        title="复制看得到的行"
        aria-label="复制串口"
        onClick={() =>
          void navigator.clipboard?.writeText(serial.text()).then(
            () => toast("已复制串口（按当前过滤）"),
            () => toast("复制失败：浏览器不让写剪贴板"),
          )
        }
      >
        <Icon n="copy" size={15} />
      </button>
      <button
        type="button"
        id="serialClear"
        className={ib}
        title="清空显示（不影响固件和验收）"
        aria-label="清空串口"
        onClick={() => {
          serial.reset("", 0);
          const con = document.getElementById("console");
          if (con) con.textContent = "";
        }}
      >
        <Icon n="trash" size={15} />
      </button>
    </div>
  );
}

function CheckList() {
  const { checkpoints } = useStore(bc);
  if (!checkpoints.length)
    return (
      <p className="m-0 p-3 text-xs text-muted">
        这个台面没有检查点（外设实验台）。
      </p>
    );
  const mk = {
    ok: ["✓", "text-ok-ink"],
    bad: ["✗", "text-bad-ink"],
    run: ["…", "text-accent-ink"],
    todo: ["○", "text-muted"],
  } as const;
  return (
    <ol className="m-0 list-none p-1.5">
      {checkpoints.map((c, i) => (
        <li key={c.id}>
          <button
            type="button"
            data-cp={c.id}
            onClick={() => {
              actions.selectCheckpoint?.(c.id);
              phoneProps();
            }}
            className="flex w-full cursor-pointer items-baseline gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left text-[13px] text-fg hover:bg-field"
          >
            <span className={cn("w-4 flex-none font-mono", mk[c.state][1])}>
              {mk[c.state][0]}
            </span>
            <span className="flex-none font-mono text-[11px] text-muted">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
            <span className="flex-none text-[11px] text-muted">{c.note}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function IssueList() {
  const { issues } = useStore(bc);
  if (!issues.length)
    return (
      <p className="m-0 p-3 text-xs text-muted">
        没有发现问题：接线规则检查通过，也没有欠压复位。
      </p>
    );
  return (
    <ul className="m-0 list-none p-1.5">
      {issues.map((x) => (
        <li key={x.id}>
          <button
            type="button"
            data-issue={x.id}
            onClick={() => x.go?.()}
            className="flex w-full cursor-pointer items-baseline gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left text-[13px] text-fg hover:bg-field"
          >
            <Icon
              n="warn"
              size={14}
              className={cn(
                "flex-none self-center",
                x.level === "block" ? "text-bad-ink" : "text-warn-ink",
              )}
            />
            <b className="flex-none font-medium">{x.title}</b>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">
              {x.detail}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 手机的串口抽屉（DESIGN_V2 §5）：平时是台面下沿的一条窥视条（最后一行串口），点 / 上拉到半屏、全屏 */
function PhoneDock({
  timeline,
  simtime,
  toast,
}: {
  timeline: ReactNode;
  simtime: ReactNode;
  toast: (t: string) => void;
}) {
  const c = useStore(bc);
  const { sheet } = useStore(mui);
  const s = useStore(ui);
  const cur: DockTab = c.dock.tab === "analyzer" ? "serial" : c.dock.tab;
  const open = sheet !== "peek";
  const peek = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = peek.current!;
    serial.attachPeek(el, true);
    return () => serial.attachPeek(el, false);
  }, []);
  const ok = c.checkpoints.filter((x) => x.state === "ok").length;
  const nIssue = c.issues.length;
  const go = (p: Partial<{ sheet: "peek" | "half" | "full" }>) =>
    setMui({ ...p, props: false, more: false, lib: null });
  const tabs: {
    id: DockTab;
    label: string;
    disabled?: boolean;
    title?: string;
  }[] = [
    { id: "serial", label: "串口" },
    {
      id: "code",
      label: "代码",
      disabled: true,
      title: "暂未开放：实验台只有编译好的 flash.bin，没有源码",
    },
    {
      id: "checks",
      label: c.checkpoints.length
        ? `检查点 ${ok}/${c.checkpoints.length}`
        : "检查点",
    },
    { id: "issues", label: nIssue ? `问题 ${nIssue}` : "问题" },
    { id: "runs", label: `运行记录 ${c.runs}` },
  ];
  return (
    <section
      id="dock"
      aria-label="串口抽屉"
      data-tab={cur}
      data-sheet={sheet}
      className={cn(
        "dock fixed inset-x-0 bottom-(--m-tb) z-24 flex flex-col rounded-t-2xl border-t border-line bg-surface shadow-[0_-6px_20px_#0000001a]",
        sheet === "peek"
          ? "h-(--m-peek)"
          : sheet === "half"
            ? "h-[52dvh]"
            : "h-[calc(100dvh-var(--top-h)-var(--m-tb))]",
      )}
    >
      <Grab
        label={open ? "收起串口抽屉" : "上拉看全部串口"}
        onUp={() => go({ sheet: sheet === "peek" ? "half" : "full" })}
        onDown={() => go({ sheet: sheet === "full" ? "half" : "peek" })}
        onTap={() => go({ sheet: open ? "peek" : "half" })}
      />
      <button
        type="button"
        id="sheetPeek"
        hidden={open}
        onClick={() => go({ sheet: "half" })}
        className="-mt-1 flex min-h-11 w-full min-w-0 cursor-pointer flex-col gap-0.5 border-0 bg-transparent px-4 pb-1.5 text-left text-fg [&[hidden]]:hidden"
      >
        <span className="flex w-full items-center gap-2 text-[13px]">
          <b className="font-medium">串口</b>
          {nIssue > 0 && (
            <span className="rounded-full bg-warn-bg px-2 text-[11px] leading-[18px] text-warn-ink">{`${nIssue} 个问题`}</span>
          )}
          <span className="flex-1" />
          <span className="text-xs text-muted">上拉看全部</span>
        </span>
        <span
          ref={peek}
          id="serialPeek"
          className="block w-full truncate font-mono text-xs text-muted"
        />
      </button>
      {open && (
        <>
          <div className="flex flex-none items-start gap-1.5 pr-3 pb-1.5">
            <div
              role="tablist"
              aria-label="串口抽屉"
              className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pl-3 [scrollbar-width:none]"
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  data-dock={t.id}
                  aria-selected={cur === t.id}
                  disabled={t.disabled}
                  title={t.title}
                  onClick={() => setDock({ tab: t.id, collapsed: false })}
                  className="h-11 flex-none cursor-pointer rounded-full border border-line bg-surface px-3.5 text-[13px] whitespace-nowrap text-fg aria-selected:border-accent aria-selected:bg-accent-bg aria-selected:font-medium aria-selected:text-accent-ink disabled:cursor-not-allowed disabled:text-muted"
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-label={sheet === "full" ? "半屏" : "全屏"}
              onClick={() => go({ sheet: sheet === "full" ? "half" : "full" })}
              className="inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-field p-0 text-fg"
            >
              <Icon n={sheet === "full" ? "down" : "up"} size={16} />
            </button>
          </div>
          {cur === "serial" && (
            <div className="flex min-h-0 flex-1 flex-col border-t border-line-soft">
              <SerialView />
              <div className="flex h-11 flex-none items-center gap-1 border-t border-line-soft px-2 text-xs text-muted">
                <button
                  type="button"
                  id="serialFollow"
                  aria-pressed={s.follow}
                  onClick={() => {
                    ui.set({ follow: !s.follow });
                    if (!s.follow) serial.renderAll();
                  }}
                  className="min-h-11 cursor-pointer border-0 bg-transparent px-2 text-xs text-muted aria-pressed:text-ok-ink"
                >
                  自动换行 · 跟随最新{s.follow ? "" : "（关）"}
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  id="serialCopy"
                  aria-label="复制串口"
                  onClick={() =>
                    void navigator.clipboard?.writeText(serial.text()).then(
                      () => toast("已复制串口"),
                      () => toast("复制失败：浏览器不让写剪贴板"),
                    )
                  }
                  className="inline-flex size-11 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-muted"
                >
                  <Icon n="copy" size={16} />
                </button>
                <span
                  className="font-mono"
                  title="UART0 波特率（模拟器里不限速，只是标注）"
                >
                  115200
                </span>
              </div>
              <SerialInput phone />
            </div>
          )}
          {cur === "checks" && (
            <div className="min-h-0 flex-1 overflow-auto border-t border-line-soft">
              <CheckList />
            </div>
          )}
          {cur === "issues" && (
            <div className="min-h-0 flex-1 overflow-auto border-t border-line-soft">
              <IssueList />
            </div>
          )}
        </>
      )}
      {/* 运行记录页（时间线、模拟时间）一直挂着：回放对拍读 #simtime */}
      <div
        hidden={!open || cur !== "runs"}
        className="flex min-h-0 flex-1 flex-col items-start gap-2 overflow-auto border-t border-line-soft px-3 py-2 [&[hidden]]:hidden"
      >
        {simtime}
        {timeline}
      </div>
    </section>
  );
}

/** 手机成品页的一行串口条（DESIGN_V2 §5「成品」）：只看最后一行，完整串口回实验台看 */
export function SerialStrip() {
  const r = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = r.current!;
    serial.attachPeek(el, true);
    return () => serial.attachPeek(el, false);
  }, []);
  return (
    <div
      id="mSerial"
      className="flex h-11 flex-none items-center gap-2 rounded-xl border border-line bg-surface px-3 text-xs text-fg"
    >
      <b className="flex-none font-medium">串口</b>
      <span ref={r} className="min-w-0 flex-1 truncate font-mono text-muted" />
    </div>
  );
}

export function Dock({
  step,
  timeline,
  simtime,
  toast,
}: {
  step: string;
  timeline: ReactNode;
  simtime: ReactNode;
  toast: (t: string) => void;
}) {
  const phone = usePhone();
  if (phone)
    return step === "bench" ? (
      <PhoneDock timeline={timeline} simtime={simtime} toast={toast} />
    ) : (
      // 别的步骤手机上没有坞，但 #simtime / 时间线要一直挂着（main.tsx 每次模拟时间变化都去写它）
      <div hidden>
        {simtime}
        {timeline}
      </div>
    );
  return (
    <DeskDock step={step} timeline={timeline} simtime={simtime} toast={toast} />
  );
}

function DeskDock({
  step,
  timeline,
  simtime,
  toast,
}: {
  step: string;
  timeline: ReactNode;
  simtime: ReactNode;
  toast: (t: string) => void;
}) {
  const c = useStore(bc);
  const { tab, collapsed } = c.dock;
  const bench = step === "bench";
  const shop = step === "shop";
  // 采购没有串口：默认看清单的变更记录
  const cur: DockTab =
    shop && (tab === "serial" || tab === "analyzer")
      ? "runs"
      : !bench && tab === "analyzer"
        ? "serial"
        : tab;
  const ok = c.checkpoints.filter((x) => x.state === "ok").length;
  const pick = (t: DockTab) => {
    if (t === "analyzer") actions.analyzer?.(true);
    else if (cur === "analyzer") actions.analyzer?.(false);
    setDock({ tab: t, collapsed: false });
  };
  const tabs: {
    id: DockTab;
    label: string;
    pill?: ReactNode;
    disabled?: boolean;
    title?: string;
  }[] = [
    {
      id: "serial",
      label: "串口",
      disabled: shop,
      title: shop ? "采购步骤没有在跑的固件" : undefined,
    },
    {
      id: "code",
      label: "代码",
      disabled: true,
      title: "暂未开放：实验台只有编译好的 flash.bin，没有源码",
    },
    {
      id: "analyzer",
      label: "逻辑分析仪",
      disabled: !bench || !actions.analyzer,
      title: bench ? "GPIO / PWM / I2C 波形" : "只在实验台",
    },
    {
      id: "runs",
      label: bench ? "运行记录" : "时间线",
      pill: bench ? <span className={pill()}>{c.runs}</span> : undefined,
    },
    {
      id: "checks",
      label: "检查点",
      pill: c.checkpoints.length ? (
        <span className={pill()}>{`${ok}/${c.checkpoints.length}`}</span>
      ) : undefined,
    },
    {
      id: "issues",
      label: "问题",
      pill: c.issues.length ? (
        <span className={pill(true)}>{c.issues.length}</span>
      ) : undefined,
    },
  ];
  return (
    <section
      id="dock"
      aria-label="底部坞"
      data-tab={cur}
      data-collapsed={collapsed ? "" : undefined}
      className={cn(
        "dock fixed inset-x-0 bottom-0 z-3 flex h-(--dock-h) flex-col border-t border-line bg-surface",
      )}
    >
      <div
        aria-hidden="true"
        title="拖动改高度"
        className="dock-grip absolute top-[-4px] left-1/2 z-1 flex h-3 w-16 -translate-x-1/2 cursor-ns-resize items-center justify-center"
        onPointerDown={(e) => {
          e.preventDefault();
          const move = (ev: PointerEvent) =>
            setDock({
              h: Math.round(
                Math.min(
                  window.innerHeight * 0.6,
                  Math.max(120, window.innerHeight - ev.clientY),
                ),
              ),
              collapsed: false,
            });
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        <span className="h-1 w-10 rounded-full bg-line" />
      </div>
      <div className="flex h-[38px] flex-none items-center gap-2 border-b border-line-soft pr-2">
        <div
          role="tablist"
          aria-label="底部坞"
          className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-dock={t.id}
              aria-selected={cur === t.id}
              disabled={t.disabled}
              title={t.title}
              onClick={() => pick(t.id)}
              className={dtab}
            >
              {t.label}
              {t.pill}
            </button>
          ))}
        </div>
        {cur === "serial" && !collapsed && <SerialTools toast={toast} />}
        {/* 模拟时间一直挂着（回放对拍读它），只在运行记录页显示 */}
        <span className={cn("contents", cur !== "runs" && "[&>*]:hidden")}>
          {simtime}
        </span>
        <button
          type="button"
          id="dockCollapse"
          className={ib}
          aria-expanded={!collapsed}
          title={collapsed ? "展开底部坞" : "收起底部坞"}
          aria-label={collapsed ? "展开底部坞" : "收起底部坞"}
          onClick={() => {
            if (!collapsed && cur === "analyzer") actions.analyzer?.(false);
            setDock({ collapsed: !collapsed });
          }}
        >
          <Icon n={collapsed ? "up" : "down"} size={15} />
        </button>
      </div>
      <div
        className={cn("flex min-h-0 flex-1 flex-col", collapsed && "hidden")}
      >
        <div
          hidden={cur !== "serial"}
          className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
        >
          <SerialView />
          <SerialInput />
        </div>
        <div
          hidden={cur !== "runs"}
          className="flex min-h-0 flex-1 items-start overflow-auto px-3 py-2 [&[hidden]]:hidden"
        >
          {timeline}
        </div>
        <div
          hidden={cur !== "checks"}
          className="min-h-0 flex-1 overflow-auto [&[hidden]]:hidden"
        >
          <CheckList />
        </div>
        <div
          hidden={cur !== "issues"}
          className="min-h-0 flex-1 overflow-auto [&[hidden]]:hidden"
        >
          <IssueList />
        </div>
      </div>
    </section>
  );
}
