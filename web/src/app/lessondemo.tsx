// Beginner "Show me how" (PLAN H-05, DESIGN_V2 §11 Demo.dc.html): a scripted walk through one lesson step drawn over the bench.
// Camera eases to each beat's focus, the rest dims, a wire draws itself; nothing here touches the bench's wiring.
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { onFrame, PRIO } from "../ui/frame";
import { useEffect, useRef, useState } from "react";
import type { ScreenPoint } from "../scene-api";
import type { DemoBeat, LessonTarget } from "./lessons";

export interface DemoApi {
  project: (t: LessonTarget) => ScreenPoint | null;
  /** Board end first; null when the bench has no such wire. */
  projectWire: (id: string, n: number) => ScreenPoint[] | null;
  /** Bench wire id for a beat's wire (either end order), or null. */
  wireId: (from: string, to: string) => string | null;
  viewTo: (t: LessonTarget, ms: number, wires?: string[]) => void;
  setFlow: (on: boolean) => void;
}

/** Beat length at 1×: camera move, then the wire draws, then time to read. */
const CAM_MS = 900;
const DRAW_MS = 2400;
const beatMs = (b: DemoBeat) => (b.wire ? 7000 : 5500);
const pulse = (ms: number) => (ms % 1200) / 1200;
const btn = "inline-flex h-11 min-w-11 flex-none cursor-pointer items-center justify-center rounded-lg text-[14px]";

export function LessonDemo({
  head,
  beats,
  flowWires,
  api,
  onExit,
  onSelf,
}: {
  /** "Lesson 1 · Light up an LED · step 3 "Close the loop"" */
  head: string;
  beats: DemoBeat[];
  /** Wires the dim hole opens around on a "show current" beat. */
  flowWires: string[];
  api: DemoApi;
  onExit: () => void;
  onSelf: (beat: number) => void;
}) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [slow, setSlow] = useState(false);
  const live = useRef({ i, paused, slow, ms: 0 });
  live.current.i = i;
  live.current.paused = paused;
  live.current.slow = slow;
  const hole = useRef<SVGEllipseElement>(null);
  const line = useRef<SVGPathElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const start = useRef<SVGCircleElement>(null);
  const hand = useRef<SVGGElement>(null);
  const tag = useRef<SVGTextElement>(null);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const beat = beats[i];

  // A new beat restarts its clock, moves the camera and switches "Show current"
  useEffect(() => {
    live.current.ms = 0;
    const wid = beat.wire ? api.wireId(beat.wire.from, beat.wire.to) : null;
    api.viewTo(beat.focus, CAM_MS / (slow ? 0.5 : 1), beat.flow ? flowWires : wid ? [wid] : undefined);
    api.setFlow(!!beat.flow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  useEffect(() => {
    // Last good hole: projections go null for a frame or two while the camera swings
    const cur = { x: 0, y: 0, rx: 0, ry: 0, set: false };
    return onFrame(
      (_t, dt) => {
        const L = live.current;
        const b = beats[L.i];
        if (!L.paused) L.ms += Math.min(dt, 100) * (L.slow ? 0.5 : 1);
        if (!L.paused && L.ms > beatMs(b) && L.i < beats.length - 1) {
          L.ms = 0;
          setI(L.i + 1);
        }
        const id = b.wire ? api.wireId(b.wire.from, b.wire.to) : null;
        let path = id ? api.projectWire(id, 32) : null;
        // Wire curves are not always stored board end first: orient by the board pin's projection
        if (path && id) {
          const pin = id.slice(5).split("~")[0];
          const p = api.project({ kind: "pin", id: pin });
          const d = (q: ScreenPoint) => (p ? Math.hypot(q.x - p.x, q.y - p.y) : 0);
          const boardFirst = d(path[0]) <= d(path[path.length - 1]);
          if (boardFirst !== (b.wire!.from === pin)) path = [...path].reverse();
        }
        const pts: ScreenPoint[] = [];
        const f = api.project(b.focus);
        if (f) pts.push(f);
        if (path) pts.push(path[0], path[path.length - 1]);
        if (b.focus.kind === "wire") pts.push(...(api.projectWire(b.focus.id, 8) ?? []));
        if (b.flow) for (const w of flowWires) pts.push(...(api.projectWire(w, 8) ?? []));
        if (pts.length) {
          const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
          const want = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, rx: Math.max(90, (x1 - x0) / 2 + 70), ry: Math.max(70, (y1 - y0) / 2 + 60) };
          const k = cur.set ? Math.min(1, dt / 120) : 1;
          cur.x += (want.x - cur.x) * k;
          cur.y += (want.y - cur.y) * k;
          cur.rx += (want.rx - cur.rx) * k;
          cur.ry += (want.ry - cur.ry) * k;
          cur.set = true;
        }
        const h = hole.current;
        if (h && cur.set) {
          h.setAttribute("cx", cur.x.toFixed(1));
          h.setAttribute("cy", cur.y.toFixed(1));
          h.setAttribute("rx", cur.rx.toFixed(1));
          h.setAttribute("ry", cur.ry.toFixed(1));
        }
        // Wire beats: the line grows from `from` to `to` after the camera settles, the hand rides its tip
        const p = Math.max(0, Math.min(1, (L.ms - CAM_MS) / DRAW_MS));
        const ln = line.current;
        if (ln) {
          ln.style.display = path ? "" : "none";
          if (path) {
            ln.setAttribute("d", "M" + path.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join("L"));
            ln.style.strokeDashoffset = String(1 - p);
          }
        }
        const end = path ? path[path.length - 1] : f;
        const tip = path ? path[Math.round(p * (path.length - 1))] : null;
        const r = ring.current;
        if (r) {
          r.style.display = end ? "" : "none";
          if (end) {
            const k = pulse(L.ms);
            r.setAttribute("cx", end.x.toFixed(1));
            r.setAttribute("cy", end.y.toFixed(1));
            r.setAttribute("r", (6 + 14 * k).toFixed(1));
            r.style.opacity = (1 - k).toFixed(2);
          }
        }
        const s = start.current;
        if (s) {
          s.style.display = path ? "" : "none";
          if (path) {
            s.setAttribute("cx", path[0].x.toFixed(1));
            s.setAttribute("cy", path[0].y.toFixed(1));
          }
        }
        const g = hand.current;
        if (g) {
          g.style.display = tip ? "" : "none";
          if (tip) g.setAttribute("transform", `translate(${tip.x.toFixed(1)} ${tip.y.toFixed(1)})`);
        }
        const tg = tag.current;
        if (tg) {
          const show = b.focus.kind === "pin" && !path && f;
          tg.style.display = show ? "" : "none";
          if (show) {
            tg.setAttribute("x", f.x.toFixed(1));
            tg.setAttribute("y", (f.y + 30).toFixed(1));
          }
        }
        bars.current.forEach((el, j) => {
          if (!el) return;
          const v = j < L.i ? 100 : j > L.i ? 0 : Math.min(100, (L.ms / beatMs(b)) * 100);
          el.style.width = `${v.toFixed(0)}%`;
        });
      },
      { priority: PRIO.ui, immediate: true },
    );
  }, [beats, flowWires, api]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onExit]);

  const go = (n: number) => setI(Math.max(0, Math.min(beats.length - 1, n)));
  return (
    <div
      id="lessonDemo"
      data-beat={i + 1}
      data-paused={paused ? "1" : "0"}
      data-speed={slow ? "0.5" : "1"}
      className="pointer-events-none absolute inset-0 z-4"
    >
      <svg className="absolute inset-0 size-full" aria-hidden="true">
        <defs>
          <mask id="lessonDemoMask">
            <rect width="100%" height="100%" fill="#fff" />
            <ellipse ref={hole} cx="-999" cy="-999" rx="0" ry="0" fill="#000" />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="#0F1720" opacity=".45" mask="url(#lessonDemoMask)" />
        <path
          ref={line}
          pathLength={1}
          fill="none"
          stroke={beat.wire?.color ?? "#F08C2E"}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray="1 1"
          style={{ filter: "drop-shadow(0 0 1.5px #fff)" }}
        />
        <circle ref={ring} fill="none" stroke="#0D99FF" strokeWidth="2" />
        <circle ref={start} r="7" fill="none" stroke="#0D99FF" strokeWidth="2" />
        <text ref={tag} textAnchor="middle" className="font-mono" fontSize="11" fill="#fff" stroke="#0F1720" strokeWidth="3" paintOrder="stroke">
          {beat.focus.id}
        </text>
        <g ref={hand}>
          <path d="M0 0 l0 22 l6 -6 l5 10 l4 -2 l-5 -10 l8 0 z" fill="#fff" stroke="#1E1E1E" strokeWidth="1.5" strokeLinejoin="round" />
        </g>
      </svg>

      <div className="pointer-events-auto absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2.5 rounded-xl border border-line bg-surface py-1 pr-1 pl-3 shadow-panel">
        <span className="max-w-[420px] truncate text-[12px] text-muted">{head}</span>
        <span id="lessonDemoBadge" className="inline-flex items-center gap-1.5 rounded-full bg-accent-bg px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-accent-ink">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 2l7 4-7 4z" fill="currentColor" />
          </svg>
          {t("Demo · your bench won't be changed")}
        </span>
        <button type="button" data-demo="exit" className={cn(btn, "border border-line bg-surface px-4 text-fg hover:bg-field")} onClick={onExit}>
          {t("Exit demo")}
        </button>
      </div>

      <div className="pointer-events-auto absolute bottom-[84px] left-4 flex w-[380px] max-w-[calc(100%-32px)] flex-col gap-1.5 rounded-xl border border-line bg-surface p-3.5 shadow-panel">
        <span className="text-[11px] font-medium text-muted">{t("Demo {n} / {total}", { n: i + 1, total: beats.length })}</span>
        <b id="lessonDemoTitle" className="text-[15px] leading-6">
          {beat.title}
        </b>
        <span className="text-[13px] leading-5 text-fg">{beat.body}</span>
        {beat.wire && <span className="text-[12px] text-accent-ink">{t("Blue ring = the hole to plug into")}</span>}
      </div>

      <div
        role="toolbar"
        aria-label={t("Demo controls")}
        className="pointer-events-auto absolute bottom-3 left-1/2 flex w-[min(900px,calc(100%-32px))] -translate-x-1/2 items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-panel"
      >
        <button type="button" data-demo="prev" aria-label={t("Previous beat")} title={t("Previous beat")} disabled={i === 0} className={cn(btn, "border border-line bg-surface text-fg hover:bg-field disabled:cursor-default disabled:opacity-40")} onClick={() => go(i - 1)}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M11 3L5 8l6 5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </button>
        <button
          type="button"
          data-demo="play"
          aria-label={paused ? t("Resume") : t("Pause")}
          title={paused ? t("Resume") : t("Pause")}
          aria-pressed={paused}
          className={cn(btn, "border-0 bg-accent-strong text-on-accent")}
          onClick={() => setPaused((x) => !x)}
        >
          {paused ? (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2l10 6-10 6z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4" y="3" width="3" height="10" fill="currentColor" />
              <rect x="9" y="3" width="3" height="10" fill="currentColor" />
            </svg>
          )}
        </button>
        <button type="button" data-demo="next" aria-label={t("Next beat")} title={t("Next beat")} disabled={i === beats.length - 1} className={cn(btn, "border border-line bg-surface text-fg hover:bg-field disabled:cursor-default disabled:opacity-40")} onClick={() => go(i + 1)}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 3l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </button>
        <div className="flex min-w-0 flex-1 gap-2">
          {beats.map((x, j) => (
            <button key={j} type="button" data-demo-seg={j + 1} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 border-0 bg-transparent p-0 text-left" onClick={() => go(j)}>
              <span className="block h-1 w-full overflow-hidden rounded-sm bg-line">
                <span ref={(el) => void (bars.current[j] = el)} className="block h-full w-0 bg-accent-strong" />
              </span>
              <span className={cn("truncate text-[12px]", j === i ? "font-medium text-fg" : "text-muted")}>{x.short}</span>
            </button>
          ))}
        </div>
        <button type="button" data-demo="slow" aria-pressed={slow} title={t("Slow motion")} className={cn(btn, "border px-3 font-mono", slow ? "border-accent-strong bg-accent-bg text-accent-ink" : "border-line bg-surface text-fg hover:bg-field")} onClick={() => setSlow((x) => !x)}>
          0.5×
        </button>
        <button type="button" data-demo="self" className={cn(btn, "border border-accent-strong bg-surface px-4 font-medium text-accent-ink hover:bg-accent-bg")} onClick={() => onSelf(i)}>
          {t("I'll wire it myself")}
        </button>
      </div>
    </div>
  );
}

export type SelfState = "set" | "todo" | "wrong" | "ok";

/** "I'll wire it myself": one ring on the target hole (blue, green once the user plugs it right) and a short hint card. */
export function SelfWire({
  pin,
  at,
  state,
  hint,
  onUnplug,
  onPlug,
  onDone,
}: {
  pin: string;
  at: () => ScreenPoint | null;
  state: SelfState;
  hint: string;
  onUnplug: (() => void) | null;
  onPlug: (() => void) | null;
  onDone: () => void;
}) {
  const ring = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      onFrame(
        () => {
          const el = ring.current;
          if (!el) return;
          const s = at();
          if (el.hidden !== !s) el.hidden = !s;
          const tf = s ? `translate(${Math.round(s.x - 14)}px, ${Math.round(s.y - 14)}px)` : "";
          if (s && el.style.transform !== tf) el.style.transform = tf;
        },
        { priority: PRIO.ui, immediate: true },
      ),
    [at],
  );
  const ok = state === "ok";
  return (
    <div id="lessonSelf" data-state={state} className="pointer-events-none absolute inset-0 z-4">
      <span
        ref={ring}
        data-self-ring={pin}
        data-state={state}
        className={cn(
          "absolute top-0 left-0 flex size-7 items-center justify-center rounded-full border-[3px] text-[13px] font-bold",
          ok ? "border-ok-ink bg-ok-bg text-ok-ink" : "animate-pulse border-[#0D99FF] bg-[#0D99FF22]",
        )}
      >
        {ok ? "✓" : ""}
      </span>
      <div className="pointer-events-auto absolute bottom-[84px] left-4 flex w-[380px] max-w-[calc(100%-32px)] flex-col gap-2 rounded-xl border border-line bg-surface p-3.5 shadow-panel">
        <span className="text-[11px] font-medium text-muted">{t("Wire it yourself · target {pin}", { pin })}</span>
        <span id="lessonSelfHint" className={cn("text-[13px] leading-5", ok ? "font-medium text-ok-ink" : "text-fg")}>
          {hint}
        </span>
        {onUnplug && <span className="text-[12px] text-muted">{t("Undo (Ctrl+Z) puts it back.")}</span>}
        <div className="flex flex-wrap gap-2">
          {onUnplug && (
            <button type="button" data-demo="unplug" className={cn(btn, "border border-accent-strong bg-surface px-3 font-medium text-accent-ink hover:bg-accent-bg")} onClick={onUnplug}>
              {t("Unplug it")}
            </button>
          )}
          {onPlug && (
            <button type="button" data-demo="plug" className={cn(btn, "border-0 bg-accent-strong px-3 font-medium text-on-accent")} onClick={onPlug}>
              {t("Plug it in")}
            </button>
          )}
          <button type="button" data-demo="done" className={cn(btn, "border border-line bg-surface px-3 text-fg hover:bg-field")} onClick={onDone}>
            {t("Done")}
          </button>
        </div>
      </div>
    </div>
  );
}
