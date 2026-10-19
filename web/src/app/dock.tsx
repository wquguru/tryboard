// Lab v2 bottom dock (DESIGN_V2 §4): serial / code / analyzer / runs / checkpoints / issues / tasks (C-04). Raw serial still goes
// to hidden #console (replay diffing reads it); the line view (filter, sim-time stamps, IDF colors) is imperative: too many lines for React.
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../ui/cn";
import { actions, bc, setDock, type DockTab } from "./chrome";
import { UsbPane } from "./usbpane";
import { TasksPane } from "./tasks";
import { BlePane } from "./blepane";
import { NetPane } from "./netpane";
import { Icon } from "./icons";
import { useStore } from "./react";
import { createStore } from "./store";
import { Grab, mui, phoneProps, setMui, usePhone } from "./mobile";
import { t } from "../i18n";

// Code tab (P2-15): chunk and source load only when opened, not in the first bundle
const CodeView = lazy(() => import("./code"));
function CodePane({ phone, toast }: { phone?: boolean; toast: (msg: string) => void }) {
  const { fw } = useStore(bc);
  return (
    <Suspense fallback={<p className="m-0 p-3 text-xs text-muted">{t('Loading code tab…')}</p>}>
      <CodeView fw={fw} phone={phone} toast={toast} />
    </Suspense>
  );
}

interface Line {
  t: number;
  text: string;
  lv: "E" | "W" | "I" | "D" | "";
}
const MAX_LINES = 4000;
// ESP-IDF log line: optional ANSI color prefix, then "E (1234) tag: …"
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
  /** Phone peek bar / product serial strip: last line only (imperative textContent, no React) */
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
      const txt = lastLine() || t('No serial output yet');
      for (const el of peeks) if (el.textContent !== txt) el.textContent = txt;
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
  // Reading scrollHeight per chunk during a serial flood forces reflow: coalesce into one scroll per frame
  let stickRaf = 0;
  /** Last auto-scroll position: scroll events are async, new lines may have grown the height, so that's not a user scroll-up */
  let autoTop = -1;
  function stick() {
    if (stickRaf) return;
    stickRaf = requestAnimationFrame(() => {
      stickRaf = 0;
      if (host && ui.get().follow) {
        host.scrollTop = host.scrollHeight;
        autoTop = host.scrollTop;
      }
    });
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
        ? t('No lines contain “{filter}”', { filter: ui.get().filter })
        : t('No serial output yet');
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
    /** Not below the last auto-scroll position: new lines grew it, the user didn't scroll up */
    autoScrolled: (top: number) => top >= autoTop - 1,
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
      aria-label={t('Serial output')}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        if (!bottom && serial.autoScrolled(el.scrollTop)) return;
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
  ["", t('None')],
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
        placeholder={can ? t('Send to serial, Enter to send') : t('Session not ready yet')}
        aria-label={t('Send to serial')}
        autoComplete="off"
        className={cn(
          "min-w-0 flex-1 border-0 bg-transparent font-mono text-[12.5px] text-fg outline-none",
          phone &&
            "h-11 rounded-xl border border-line bg-field px-3 text-[16px]",
        )}
      />
      <select
        id="serialEol"
        aria-label={t('Line ending')}
        title={t('Line ending appended on Enter')}
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
          {t('Send')}
        </button>
      )}
    </form>
  );
}

function SerialTools({ toast }: { toast: (msg: string) => void }) {
  const s = useStore(ui);
  return (
    <div className="flex items-center gap-1.5 max-[1180px]:[&_.opt]:hidden">
      <input
        id="serialFilter"
        type="search"
        value={s.filter}
        onChange={(e) => ui.set({ filter: e.currentTarget.value })}
        placeholder={t('Filter')}
        aria-label={t('Filter serial')}
        className="h-7 w-40 rounded-md border border-line bg-field px-2 text-xs text-fg outline-none focus:border-accent max-[1100px]:w-24"
      />
      <button
        type="button"
        id="serialStamps"
        aria-pressed={s.stamps}
        onClick={() => ui.set({ stamps: !s.stamps })}
        title={t('Simulated time when this line arrived (s)')}
        className={cn(ib, "opt w-auto px-1.5 text-xs whitespace-nowrap")}
      >
        {s.stamps ? t('Timestamps on') : t('Timestamps off')}
      </button>
      <button
        type="button"
        id="serialFollow"
        aria-pressed={s.follow}
        onClick={() => {
          ui.set({ follow: !s.follow });
          if (!s.follow) serial.renderAll();
        }}
        title={t('Auto-scroll to the end on new output')}
        className={cn(ib, "opt w-auto px-1.5 text-xs whitespace-nowrap")}
      >
        {t('Follow latest')}
      </button>
      <span
        className="opt font-mono text-xs text-muted"
        title={t('UART0 baud rate (the simulator doesn’t throttle; label only)')}
      >
        115200
      </span>
      <button
        type="button"
        id="serialCopy"
        className={ib}
        title={t('Copy the visible lines')}
        aria-label={t('Copy serial')}
        onClick={() =>
          void navigator.clipboard?.writeText(serial.text()).then(
            () => toast(t('Serial copied (current filter applied)')),
            () => toast(t('Copy failed: the browser blocked clipboard access')),
          )
        }
      >
        <Icon n="copy" size={15} />
      </button>
      <button
        type="button"
        id="serialClear"
        className={ib}
        title={t('Clear display (does not affect firmware or checks)')}
        aria-label={t('Clear serial')}
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
        {t('This bench has no checkpoints (peripheral lab).')}
      </p>
    );
  const mk = {
    ok: ["✓", "text-ok-ink"],
    ref: ["◐", "text-ok-ink"],
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
        {t('No issues found: wiring is fine and voltage stayed sufficient.')}
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

/** Phone serial sheet (DESIGN_V2 §5): a peek bar with the last serial line; tap / swipe up for half or full */
function PhoneDock({
  timeline,
  simtime,
  toast,
}: {
  timeline: ReactNode;
  simtime: ReactNode;
  toast: (msg: string) => void;
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
  const ok = c.checkpoints.filter((x) => x.state === "ok" || x.state === "ref").length;
  const nIssue = c.issues.length;
  const go = (p: Partial<{ sheet: "peek" | "half" | "full" }>) =>
    setMui({ ...p, props: false, more: false, lib: null });
  const tabs: {
    id: DockTab;
    label: string;
    disabled?: boolean;
    title?: string;
  }[] = [
    { id: "serial", label: t('Serial') },
    {
      id: "code",
      label: t('Code'),
      title: t('Source of the firmware on the bench (read-only)'),
    },
    {
      id: "checks",
      label: c.checkpoints.length
        ? t('Checkpoints {ok}/{n}', { ok, n: c.checkpoints.length })
        : t('Checkpoints'),
    },
    { id: "issues", label: nIssue ? t('Issues {n}', { n: nIssue }) : t('Issues') },
    { id: "runs", label: t('Runs {n}', { n: c.runs }) },
    { id: "tasks", label: t('Tasks'), title: t('FreeRTOS task timeline: who runs and who waits on each core') },
    ...(c.usb ? [{ id: "usb" as const, label: "USB" }] : []),
    ...(c.ble ? [{ id: "ble" as const, label: t('Bluetooth') }] : []),
    ...(c.net ? [{ id: "net" as const, label: t('Network') }] : []),
  ];
  return (
    <section
      id="dock"
      aria-label={t('Serial sheet')}
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
        label={open ? t('Collapse serial sheet') : t('Swipe up for full serial')}
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
          <b className="font-medium">{t('Serial')}</b>
          {nIssue > 0 && (
            <span className="rounded-full bg-warn-bg px-2 text-[11px] leading-[18px] text-warn-ink">{t('{n} issues', { n: nIssue })}</span>
          )}
          <span className="flex-1" />
          <span className="text-xs text-muted">{t('Swipe up for all')}</span>
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
              aria-label={t('Serial sheet')}
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
              aria-label={sheet === "full" ? t('Half screen') : t('Full screen')}
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
                  {s.follow ? t('Word wrap · follow latest') : t('Word wrap · follow latest (off)')}
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  id="serialCopy"
                  aria-label={t('Copy serial')}
                  onClick={() =>
                    void navigator.clipboard?.writeText(serial.text()).then(
                      () => toast(t('Serial copied')),
                      () => toast(t('Copy failed: the browser blocked clipboard access')),
                    )
                  }
                  className="inline-flex size-11 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-muted"
                >
                  <Icon n="copy" size={16} />
                </button>
                <span
                  className="font-mono"
                  title={t('UART0 baud rate (the simulator doesn’t throttle; label only)')}
                >
                  115200
                </span>
              </div>
              <SerialInput phone />
            </div>
          )}
          {cur === "code" && (
            <div className="flex min-h-0 flex-1 flex-col border-t border-line-soft">
              <CodePane phone toast={toast} />
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
          {cur === "tasks" && (
            <div className="flex min-h-0 flex-1 flex-col border-t border-line-soft">
              <TasksPane phone toast={toast} />
            </div>
          )}
          {cur === "usb" && c.usb && (
            <div className="flex min-h-0 flex-1 flex-col border-t border-line-soft">
              <UsbPane sendCdc={(t) => actions.usbCdc?.(t)} />
            </div>
          )}
          {cur === "ble" && c.ble && (
            <div className="flex min-h-0 flex-1 flex-col border-t border-line-soft">
              <BlePane />
            </div>
          )}
          {cur === "net" && c.net && (
            <div className="flex min-h-0 flex-1 flex-col border-t border-line-soft">
              <NetPane mobile />
            </div>
          )}
        </>
      )}
      {/* The runs page (timeline, sim time) stays mounted: replay diffing reads #simtime */}
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

/** One-line serial strip on the phone product page (DESIGN_V2 §5): last line only; full serial is on the bench */
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
      <b className="flex-none font-medium">{t('Serial')}</b>
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
  toast: (msg: string) => void;
}) {
  const phone = usePhone();
  if (phone)
    return step === "bench" ? (
      <PhoneDock timeline={timeline} simtime={simtime} toast={toast} />
    ) : (
      // Other phone steps have no dock, but #simtime / timeline stay mounted (main.tsx writes them on every sim-time change)
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
  toast: (msg: string) => void;
}) {
  const c = useStore(bc);
  const { tab, collapsed } = c.dock;
  const bench = step === "bench";
  const shop = step === "shop";
  // Shop has no serial: default to the list's change log
  const cur: DockTab =
    shop && (tab === "serial" || tab === "analyzer" || tab === "tasks")
      ? "runs"
      : !bench && tab === "analyzer"
        ? "serial"
        : tab;
  const ok = c.checkpoints.filter((x) => x.state === "ok" || x.state === "ref").length;
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
      label: t('Serial'),
      disabled: shop,
      title: shop ? t('No firmware runs in the Shop step') : undefined,
    },
    {
      id: "code",
      label: t('Code'),
      title: t('Source of the firmware on the bench (read-only)'),
    },
    {
      id: "analyzer",
      label: t('Logic analyzer'),
      disabled: !bench || !actions.analyzer,
      title: bench ? t('GPIO / PWM / I2C waveforms') : t('Bench step only'),
    },
    {
      id: "runs",
      label: bench ? t('Runs') : t('Timeline'),
      pill: bench ? <span className={pill()}>{c.runs}</span> : undefined,
    },
    {
      id: "checks",
      label: t('Checkpoints'),
      pill: c.checkpoints.length ? (
        <span className={pill()}>{`${ok}/${c.checkpoints.length}`}</span>
      ) : undefined,
    },
    {
      id: "issues",
      label: t('Issues'),
      pill: c.issues.length ? (
        <span className={pill(true)}>{c.issues.length}</span>
      ) : undefined,
    },
    {
      id: "tasks",
      label: t('Tasks'),
      disabled: shop,
      title: shop
        ? t('No firmware runs in the Shop step')
        : t('FreeRTOS task timeline: who runs and who waits on each core (behavioral model)'),
      pill: (
        <span className="rounded-full bg-accent-bg px-1.5 text-[11px] leading-[18px] text-accent-ink">
          {t('New')}
        </span>
      ),
    },
    ...(c.usb
      ? [
          {
            id: "usb" as const,
            label: "USB",
            title: t('Virtual PC: USB devices the firmware enumerates, typed keys, USB serial'),
          },
        ]
      : []),
    ...(c.ble
      ? [
          {
            id: "ble" as const,
            label: t('Bluetooth'),
            title: t('Air log: advertising, connections, reads/writes, notifications (by sim time)'),
            pill: <span className="rounded px-[5px] text-[11px] font-medium leading-4 bg-accent-bg text-accent-ink">{t('New')}</span>,
          },
        ]
      : []),
    ...(c.net
      ? [{ id: "net" as const, label: "网络", title: "虚拟手机配网、芯片发出的请求" }]
      : []),
  ];
  return (
    <section
      id="dock"
      aria-label={t('Bottom dock')}
      data-tab={cur}
      data-collapsed={collapsed ? "" : undefined}
      className={cn(
        "dock fixed inset-x-0 bottom-0 z-3 flex h-(--dock-h) flex-col border-t border-line bg-surface",
      )}
    >
      <div
        aria-hidden="true"
        title={t('Drag to resize')}
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
          aria-label={t('Bottom dock')}
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
        {/* Sim time stays mounted (replay diffing reads it), shown only on the runs page */}
        <span className={cn("contents", cur !== "runs" && "[&>*]:hidden")}>
          {simtime}
        </span>
        <button
          type="button"
          id="dockCollapse"
          className={ib}
          aria-expanded={!collapsed}
          title={collapsed ? t('Expand bottom dock') : t('Collapse bottom dock')}
          aria-label={collapsed ? t('Expand bottom dock') : t('Collapse bottom dock')}
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
        {cur === "code" && <CodePane toast={toast} />}
        {cur === "tasks" && <TasksPane toast={toast} />}
        {c.usb && (
          <div
            hidden={cur !== "usb"}
            className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
          >
            <UsbPane sendCdc={(t) => actions.usbCdc?.(t)} />
          </div>
        )}
        {c.ble && (
          <div
            hidden={cur !== "ble"}
            className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
          >
            <BlePane />
          </div>
        )}
        {c.net && cur === "net" && <NetPane />}
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
