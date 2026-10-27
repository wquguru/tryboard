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
import { isLessonFw, type CodeChips, type Lesson } from "./lessons";
import { CodePane as CodeView } from "./panes";
import { adcMoved, litCount, servoPulse, TickLast } from "./feedrules";

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
  /** H-16: a PWM row (duty in whole percent); `hi` = duty above 0. */
  duty?: number;
  /** H-16: a tone row (PWM frequency in Hz); hi is true. */
  hz?: number;
  /** H-16: a servo row (commanded angle, pulse width in µs). */
  servo?: { deg: number; us: number };
  /** H-16: a strip row (LEDs lit, LEDs in the frame); `hi` = any lit. */
  strip?: { lit: number; of: number };
  /** H-16: an ADC row (0–4095 reading, wiper mV). */
  adc?: { raw: number; mv: number };
}
interface FeedState {
  items: FeedItem[];
}
export const lessonFeed = createStore<FeedState>({ items: [] });

/** The slice of a worker tick the strip / ADC rules read. */
interface FeedTick {
  simSeconds: number;
  strips?: Record<number, number[][]>;
  adc?: Record<number, { raw: number[]; mv: number[] }>;
}
interface FeedSession {
  io: IoStore;
  fwName: string;
  /** Power-ons so far: tick rows compare against this run's last value, not the previous firmware's */
  bootCount?: number;
  onTick?(cb: (m: FeedTick) => void): () => void;
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
  const pwmRules = lesson?.pwm ?? [];
  const toneRules = lesson?.tones ?? [];
  const servoRules = lesson?.servo ?? [];
  const tickRules = [...(lesson?.strip ?? []), ...(lesson?.adc ?? [])];
  if (!lesson || (!rules.length && !i2cRules.length && !pwmRules.length && !toneRules.length && !servoRules.length && !tickRules.length)) return;
  // Servo: last angle narrated per pin; strip / ADC: last lit count or reading narrated per pin (tick side)
  const servoLast = new Map<number, number>();
  const tickLast = new TickLast();
  // PWM: last duty level narrated per pin (PWM changes are always logged, no watch needed)
  const pwmLast = new Map<number, number>();
  // Pitch now sounding per tone pin (0 = silent), so a held note or a silent gap adds no row
  const sounding = new Map<number, number>();
  // GPIO edges are only recorded for watched pins; add ours without dropping the analyzer's (I2C is always logged)
  const pins = new Set(session.ioPins());
  if (rules.some((r) => !pins.has(r.pin))) session.watchIo([...pins, ...rules.map((r) => r.pin)]);
  // Open I2C write per port: address rule matched by the ACKed address byte, data bytes counted until STOP
  const open = new Map<number, { t: number; addr: number; bytes: number; reads: boolean }>();
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
      sounding.clear();
      if (!trimmed) {
        pwmLast.clear();
        servoLast.clear();
        tickLast.clear();
        seenT = -1;
        n = 0;
        lessonFeed.set({ items: [] });
      }
    }
    dropped = io.dropped;
    // The work's default build runs until "Run this lesson's code"; narrating it against this lesson's lines misleads
    if (!isLessonFw(lesson, session.fwName)) return void (at = raw.length);
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
        items.push({ n: n++, t: e.t, pin: e.a, hi: !!e.b, text: e.b ? r.hi : r.lo, line: e.b ? (r.hiLine ?? r.line) : r.line });
        changed = true;
        continue;
      }
      if (e.kind === K.PWM) {
        const p = pwmRules.find((x) => x.pin === e.a);
        if (p) {
          // Only duties sitting on a multiple of `every` make a row (a fade has hundreds of steps)
          const duty = e.v ? e.b / 65535 : 0;
          const every = p.every ?? 0.2;
          const q = Math.round(duty / every);
          if (Math.abs(duty - q * every) > 0.005 || pwmLast.get(e.a) === q) continue;
          pwmLast.set(e.a, q);
          const pct = Math.round(q * every * 100);
          items.push({ n: n++, t: e.t, pin: e.a, hi: pct > 0, text: p.text.replace("{pct}", String(pct)), line: p.line, duty: pct });
          changed = true;
          continue;
        }
        const sv = servoRules.find((x) => x.pin === e.a);
        if (sv) {
          const p = servoPulse(e.b, e.v);
          if (!p || servoLast.get(e.a) === p.deg) continue;
          servoLast.set(e.a, p.deg);
          items.push({ n: n++, t: e.t, pin: e.a, hi: true, text: sv.text.replace("{deg}", String(p.deg)), line: sv.line, servo: p });
          changed = true;
          continue;
        }
        const r = toneRules.find((x) => x.pin === e.a);
        if (!r) continue;
        // b = duty × 65535, v = Hz × 1000; a passive buzzer only sounds on a real square wave
        const hz = e.b > 0 && e.b < 65535 && e.v > 0 ? Math.round(e.v / 1000) : 0;
        if (hz === (sounding.get(e.a) ?? 0)) continue;
        sounding.set(e.a, hz);
        if (!hz) continue;
        const text = r.text.replace("{hz}", String(hz)).replace("{note}", r.notes?.[hz] ?? "");
        items.push({ n: n++, t: e.t, pin: e.a, hi: true, text, line: r.line, hz });
        changed = true;
        continue;
      }
      if (!i2cRules.length || e.kind < K.I2C_START || e.kind > K.I2C_STOP) continue;
      const port = e.b & B_PORT1 ? 1 : 0;
      if (e.kind === K.I2C_START) {
        // A repeated START keeps the transaction; a fresh one ends any write left open
        if (!(e.b & B_RESTART)) close(port);
      } else if (e.kind === K.I2C_ADDR) {
        const x = open.get(port);
        // Register read: the address again after a repeated START, now reading; one transaction with the write before it
        if (x?.reads && x.addr === e.a && e.b & B_READ && !(e.b & B_NACK)) continue;
        const r = e.b & (B_READ | B_NACK) ? undefined : i2cRules.find((y) => y.addr === e.a);
        if (r) open.set(port, { t: e.t, addr: e.a, bytes: 0, reads: !!r.reads });
        else open.delete(port);
      } else if (e.kind === K.I2C_DATA) {
        const x = open.get(port);
        if (x && (x.reads || !(e.b & B_READ))) x.bytes++;
      } else close(port);
    }
    if (raw.length) seenT = raw[raw.length - 1].t;
    if (changed) lessonFeed.set({ items: items.slice(-FEED_CAP) });
  };
  pull();
  const offIo = session.onIo(pull);
  const offTick = tickRules.length && session.onTick ? session.onTick(onTick) : () => {};
  bound = { lesson, session, off: () => (offIo(), offTick()) };

  /** Strip frames and ADC readings arrive with worker ticks, stamped with the tick's sim time. */
  function onTick(m: FeedTick) {
    if (!isLessonFw(lesson!, session.fwName)) return;
    const t = Math.round(m.simSeconds * CPU_HZ);
    const gen = session.bootCount ?? 0;
    const add: FeedItem[] = [];
    for (const r of lesson!.strip ?? []) {
      const leds = m.strips?.[r.pin];
      if (!leds) continue;
      const lit = litCount(leds);
      if (tickLast.get(gen, r.pin) === lit) continue;
      tickLast.set(gen, r.pin, lit);
      const text = r.text.replace("{n}", String(lit)).replace("{of}", String(leds.length));
      add.push({ n: n++, t, pin: r.pin, hi: lit > 0, text, line: r.line, strip: { lit, of: leds.length } });
    }
    for (const r of lesson!.adc ?? []) {
      const a = m.adc?.[r.pin];
      const i = (a?.raw.length ?? 0) - 1;
      if (!a || i < 0 || !adcMoved(tickLast.get(gen, r.pin), a.raw[i], r.step ?? 200)) continue;
      tickLast.set(gen, r.pin, a.raw[i]);
      const adc = { raw: a.raw[i], mv: a.mv[i] ?? 0 };
      add.push({ n: n++, t, pin: r.pin, hi: adc.raw > 0, text: r.text.replace("{raw}", String(adc.raw)), line: r.line, adc });
    }
    if (add.length) lessonFeed.set({ items: [...lessonFeed.get().items, ...add].slice(-FEED_CAP) });
  }
}

/** Lesson 0 has no firmware: the feed and code panes say so instead of pointing at a Run button or another work's source. */
export const noFwFeed = () => t("This lesson runs no code, so nothing shows up here. Click the parts on the bench instead.");
export const useNoFwLesson = () => {
  const l = useStore(lessonUi).lesson;
  return !!l && !l.fw;
};
export function NoCodeNote() {
  return <p className="m-0 p-3 text-[13px] text-muted">{t("This lesson runs no code: it is about the board itself")}</p>;
}

/** What the code panel should show in beginner mode: the lesson's source and lines to highlight, or null (normal pane). */
export function useLessonCode(): { fw: string; file: string; lines: number[]; chip?: { line: number; node: ReactNode } } | null {
  const s = useStore(lessonUi);
  const { items } = useStore(lessonFeed);
  const { run } = useStore(bc);
  const l = s.lesson;
  // Lesson 0 runs no firmware: no source to show or follow
  if (!l?.fw) return null;
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

/** The wire-level half of a feed row: "GPIO5 → high 3.3 V" or "I2C → 0x3C". */
export const evWhere = (e: FeedItem) =>
  e.i2c
    ? t("I2C → {addr}", { addr: hex(e.i2c.addr) })
    : e.servo
      ? t("GPIO{pin} → {us} µs pulse", { pin: e.pin, us: e.servo.us })
    : e.strip
      ? t("GPIO{pin} → frame for {of} LEDs", { pin: e.pin, of: e.strip.of })
    : e.adc
      ? t("GPIO{pin} ← {v} V into the ADC", { pin: e.pin, v: (e.adc.mv / 1000).toFixed(2) })
    : e.duty !== undefined
      ? t("GPIO{pin} → PWM duty {pct}%", { pin: e.pin, pct: e.duty })
      : e.hz
      ? t("GPIO{pin} → {hz} Hz square wave", { pin: e.pin, hz: e.hz })
      : e.hi
      ? t("GPIO{pin} → high 3.3 V", { pin: e.pin })
      : t("GPIO{pin} → low 0 V", { pin: e.pin });

export const fmtSec = (cyc: number) => `${(cyc / CPU_HZ).toFixed(2)} s`;

/** Dock "What happened" list, newest on top. */
export function LessonFeed({ className }: { className?: string }) {
  const { items } = useStore(lessonFeed);
  const noFw = useNoFwLesson();
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
        {!items.length && <p className="m-0 py-1 text-xs text-muted">{noFw ? noFwFeed() : t('Not run yet. Click "Run" below the bench.')}</p>}
        {items
          .slice()
          .reverse()
          .map((e) => (
            <div
              key={e.n}
              data-ev={e.n}
              data-t={e.t}
              {...(e.i2c ? { "data-i2c": hex(e.i2c.addr), "data-bytes": e.i2c.bytes } : { "data-pin": e.pin, "data-level": e.hi ? 1 : 0, ...(e.hz ? { "data-hz": e.hz } : {}) })}
              {...(e.duty !== undefined && { "data-duty": e.duty })}
              {...(e.servo && { "data-deg": e.servo.deg })}
              {...(e.strip && { "data-lit": e.strip.lit })}
              {...(e.adc && { "data-raw": e.adc.raw })}
              className="flex gap-2.5 py-0.5 leading-5"
            >
              <span className="w-[60px] flex-none font-mono text-muted tabular-nums">{fmtSec(e.t)}</span>
              <span className={cn("font-medium", e.hi ? "text-fg" : "text-muted")}>{e.text}</span>
              <span className="font-mono text-muted">
                ·{" "}
                {evWhere(e)}
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
  const noFw = useNoFwLesson();
  return (
    <div id="lessonPane" className="flex min-h-0 flex-1">
      <LessonFeed className="w-[min(440px,42%)] flex-none border-r border-line-soft" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {code && <CodeView fw={code.fw} toast={toast} highlight={code} />}
        {noFw && <NoCodeNote />}
      </div>
    </div>
  );
}
