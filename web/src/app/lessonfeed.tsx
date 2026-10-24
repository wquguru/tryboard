// Beginner "What happened" feed + code highlight (PLAN H-03, DESIGN_V2 §11): io edges narrated by the lesson's event rules.
// The bench binds it to the session while a lesson is up; lines come from lesson data, not DWARF (DECISIONS 2026-10-23).
import { useEffect, useRef, type ReactNode } from "react";
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { useStore } from "./react";
import { createStore } from "./store";
import { bc, setDock } from "./chrome";
import { lessonUi } from "./lesson";
import { B_NACK, B_PORT1, B_READ, B_RESTART, CPU_HZ, K, hex, type IoEvent, type IoStore } from "./iotrace";
import type { CodeChips, Lesson } from "./lessons";
import { CodePane as CodeView } from "./panes";

/** Rows kept; older ones scroll away (a blink makes two per second). */
export const FEED_CAP = 200;
/** I2C writes to one address closer than this (100 ms) add up in one row, so a screen refresh is one line. */
export const I2C_MERGE = CPU_HZ / 10;

export interface FeedItem {
  /** Running number since the last reset (React key, data-ev). */
  n: number;
  /** CPU cycles @160 MHz, same clock as `--trace-io`. */
  t: number;
  pin: number;
  hi: boolean;
  text: string;
  line: number;
  /** H-08: an I2C row (address, bytes written so far, time of the last write merged in); pin / hi unused. */
  i2c?: { addr: number; bytes: number; last: number };
}
interface FeedState {
  items: FeedItem[];
}
export const lessonFeed = createStore<FeedState>({ items: [] });

interface FeedSession {
  io: IoStore;
  onIo(cb: () => void): () => void;
  ioPins(): number[];
  watchIo(pins: number[]): void;
}

let bound: { lesson: Lesson; session: FeedSession; off: () => void } | null = null;

/** Follow `session.io` for `lesson`'s event rules (null unbinds); idempotent per lesson. */
export function bindLessonFeed(session: FeedSession, lesson: Lesson | null) {
  if (bound?.lesson === lesson && bound.session === session) return;
  bound?.off();
  bound = null;
  lessonFeed.set({ items: [] });
  const rules = lesson?.events ?? [];
  const i2cRules = lesson?.i2c ?? [];
  if (!lesson || (!rules.length && !i2cRules.length)) return;
  // GPIO edges are only recorded for watched pins; add ours without dropping the analyzer's (I2C is always logged)
  const pins = new Set(session.ioPins());
  if (rules.some((r) => !pins.has(r.pin))) session.watchIo([...pins, ...rules.map((r) => r.pin)]);
  // Open I2C write per port: address rule matched by the ACKed address byte, data bytes counted until STOP
  const open = new Map<number, { t: number; addr: number; bytes: number }>();
  const io = session.io;
  let raw: IoEvent[] = io.raw;
  let at = 0;
  let seenT = -1;
  let skipT = -1;
  let dropped = io.dropped;
  let n = 0;
  const pull = () => {
    if (io.raw !== raw) {
      // A new array is a power-on / seek reset, or a trim when the drop count grew (then skip what was seen)
      const trimmed = io.dropped > dropped;
      raw = io.raw;
      at = 0;
      skipT = trimmed ? seenT : -1;
      open.clear();
      if (!trimmed) {
        seenT = -1;
        n = 0;
        lessonFeed.set({ items: [] });
      }
    }
    dropped = io.dropped;
    const items = lessonFeed.get().items.slice();
    let changed = false;
    const close = (port: number) => {
      const x = open.get(port);
      open.delete(port);
      // Zero-byte writes are bus scans / probes, not screen traffic
      if (!x || !x.bytes) return;
      const r = i2cRules.find((y) => y.addr === x.addr)!;
      const prev = items[items.length - 1];
      changed = true;
      if (prev?.i2c && prev.i2c.addr === x.addr && x.t - prev.i2c.last < I2C_MERGE) {
        const bytes = prev.i2c.bytes + x.bytes;
        items[items.length - 1] = { ...prev, text: r.text.replace("{n}", String(bytes)), i2c: { addr: x.addr, bytes, last: x.t } };
        return;
      }
      items.push({ n: n++, t: x.t, pin: -1, hi: true, text: r.text.replace("{n}", String(x.bytes)), line: r.line, i2c: { addr: x.addr, bytes: x.bytes, last: x.t } });
    };
    for (; at < raw.length; at++) {
      const e = raw[at];
      if (e.t <= skipT) continue;
      if (e.kind === K.GPIO) {
        const r = rules.find((x) => x.pin === e.a);
        if (!r) continue;
        items.push({ n: n++, t: e.t, pin: e.a, hi: !!e.b, text: e.b ? r.hi : r.lo, line: r.line });
        changed = true;
        continue;
      }
      if (!i2cRules.length || e.kind < K.I2C_START || e.kind > K.I2C_STOP) continue;
      const port = e.b & B_PORT1 ? 1 : 0;
      if (e.kind === K.I2C_START) {
        // A repeated START keeps the transaction; a fresh one ends any write left open
        if (!(e.b & B_RESTART)) close(port);
      } else if (e.kind === K.I2C_ADDR) {
        if (!(e.b & (B_READ | B_NACK)) && i2cRules.some((y) => y.addr === e.a)) open.set(port, { t: e.t, addr: e.a, bytes: 0 });
        else open.delete(port);
      } else if (e.kind === K.I2C_DATA) {
        const x = open.get(port);
        if (x && !(e.b & B_READ)) x.bytes++;
      } else close(port);
    }
    if (raw.length) seenT = raw[raw.length - 1].t;
    if (changed) lessonFeed.set({ items: items.slice(-FEED_CAP) });
  };
  pull();
  bound = { lesson, session, off: session.onIo(pull) };
}

/** What the code panel should show in beginner mode: the lesson's source and lines to highlight, or null (normal pane). */
export function useLessonCode(): { fw: string; file: string; lines: number[]; chip?: { line: number; node: ReactNode } } | null {
  const s = useStore(lessonUi);
  const { items } = useStore(lessonFeed);
  const { run } = useStore(bc);
  const l = s.lesson;
  if (!l) return null;
  const file = l.src.replace(/^firmware\//, "");
  const last = items[items.length - 1];
  // Running: the line behind the latest edge; still: the current step's lines
  const lines = run === "run" && last ? [last.line] : (l.steps[s.step]?.codeLines ?? []);
  const chips = l.steps[s.step]?.codeChips;
  return { fw: `${l.fw}/flash.bin`, file, lines, chip: chips && { line: chips.line, node: <DelayChips chips={chips} /> } };
}

/** H-06: pick one of the prebuilt delay variants; the click loads that firmware and runs it. */
function DelayChips({ chips }: { chips: CodeChips }) {
  const { delay, setDelay } = useStore(lessonUi);
  return (
    <span className="inline-flex items-center gap-1.5" role="group" aria-label={t("Delay in milliseconds")}>
      {chips.values.map((v) => (
        <button
          key={v}
          type="button"
          data-chip={v}
          aria-pressed={delay === v}
          onClick={() => setDelay(v)}
          className={cn(
            "h-7 min-w-11 cursor-pointer rounded-md border px-2 font-mono text-[12px]",
            delay === v ? "border-accent-strong bg-accent-strong text-on-accent" : "border-line bg-surface text-fg hover:bg-field",
          )}
        >
          {v}
        </button>
      ))}
      <span className="font-sans text-[11px] text-muted">{t("Three prebuilt versions (the web page cannot compile yet)")}</span>
    </span>
  );
}

export const fmtSec = (cyc: number) => `${(cyc / CPU_HZ).toFixed(2)} s`;

/** Dock "What happened" list, newest on top. */
export function LessonFeed({ className }: { className?: string }) {
  const { items } = useStore(lessonFeed);
  const box = useRef<HTMLDivElement>(null);
  const top = items[items.length - 1]?.n ?? -1;
  // New rows land on top: keep the reader at the top unless they scrolled down to read history
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollTop < 40) el.scrollTop = 0;
  }, [top]);
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex h-8 flex-none items-center gap-2 border-b border-line-soft px-3">
        <span className="flex-1 text-[11px] font-medium text-muted">{t("What happened")}</span>
        <button
          type="button"
          id="lessonRawSerial"
          className="h-6 cursor-pointer rounded-md border-0 bg-transparent px-1.5 text-[12px] text-accent-ink hover:bg-field"
          onClick={() => setDock({ tab: "serial", collapsed: false })}
        >
          {t("Raw serial")}
        </button>
      </div>
      <div
        id="lessonFeed"
        ref={box}
        role="log"
        aria-label={t("What happened")}
        data-count={items.length}
        className="min-h-0 flex-1 overflow-auto px-3 py-1.5 text-[12.5px]"
      >
        {!items.length && <p className="m-0 py-1 text-xs text-muted">{t('Not run yet. Click "Run" below the bench.')}</p>}
        {items
          .slice()
          .reverse()
          .map((e) => (
            <div
              key={e.n}
              data-ev={e.n}
              data-t={e.t}
              {...(e.i2c ? { "data-i2c": hex(e.i2c.addr), "data-bytes": e.i2c.bytes } : { "data-pin": e.pin, "data-level": e.hi ? 1 : 0 })}
              className="flex gap-2.5 py-0.5 leading-5"
            >
              <span className="w-[60px] flex-none font-mono text-muted tabular-nums">{fmtSec(e.t)}</span>
              <span className={cn("font-medium", e.hi ? "text-fg" : "text-muted")}>{e.text}</span>
              <span className="font-mono text-muted">
                ·{" "}
                {e.i2c
                  ? t("I2C → {addr}", { addr: hex(e.i2c.addr) })
                  : e.hi
                    ? t("GPIO{pin} → high 3.3 V", { pin: e.pin })
                    : t("GPIO{pin} → low 0 V", { pin: e.pin })}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

/** Dock tab while a lesson is up: what happened (left) beside the lesson source with the followed line (right). */
export function LessonPane({ toast }: { toast: (msg: string) => void }) {
  const code = useLessonCode();
  return (
    <div id="lessonPane" className="flex min-h-0 flex-1">
      <LessonFeed className="w-[min(440px,42%)] flex-none border-r border-line-soft" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {code && <CodeView fw={code.fw} toast={toast} highlight={code} />}
      </div>
    </div>
  );
}
