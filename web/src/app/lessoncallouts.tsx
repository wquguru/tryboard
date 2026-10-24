// Beginner lesson callouts (PLAN H-02, DESIGN_V2 §11): cards on the stage edges with a leader line to the part / pin.
// Positions are written to the DOM every frame (no React render per frame); React only re-renders on step changes.
import { useEffect, useRef } from "react";
import { t } from "../i18n";
import { onFrame, PRIO } from "../ui/frame";
import { lessonUi } from "./lesson";
import type { LessonCallout } from "./lessons";
import { bit } from "./pinscope";
import { useStore } from "./react";
import type { BenchCtx } from "./bench/ctx";

const GAP = 8;
const EDGE = 12;
// Keep clear of the top-left chips / top-right view buttons and the bottom toolbar
const TOP = 64;
const BOTTOM = 72;

/** GPIO number a callout reports live: pin 'GPIO5' → level, part 'led:5' → on / off; null = no live line. */
function livePin(c: LessonCallout): { pin: number; led: boolean } | null {
  const g = c.target.kind === "pin" && /^GPIO(\d+)$/.exec(c.target.id);
  if (g) return { pin: +g[1], led: false };
  const l = c.target.kind === "part" && c.target.anchor !== "res" && /^led:(\d+)$/.exec(c.target.id);
  return l ? { pin: +l[1], led: true } : null;
}

interface Slot {
  side: "L" | "R" | null;
}

export function LessonCallouts({ b }: { b: BenchCtx }) {
  const ui = useStore(lessonUi);
  const lesson = ui.lesson;
  const list = lesson && ui.step < lesson.steps.length ? lesson.steps[ui.step].callouts : [];
  const root = useRef<HTMLDivElement>(null);
  const keys = list.map((c) => c.key).join(",");

  useEffect(() => {
    const el = root.current;
    const c = b.ctx;
    if (!el || !c || !list.length) return;
    const cards = list.map((x) => el.querySelector<HTMLElement>(`[data-callout="${x.key}"]`)!);
    const lines = list.map((x) => el.querySelector<SVGLineElement>(`line[data-for="${x.key}"]`)!);
    const dots = list.map((x) => el.querySelector<SVGCircleElement>(`circle[data-for="${x.key}"]`)!);
    const slots: Slot[] = list.map(() => ({ side: null }));
    const show = (i: number, on: boolean) => {
      cards[i].style.display = on ? "" : "none";
      lines[i].style.display = dots[i].style.display = on ? "" : "none";
    };
    const frame = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      const pts = list.map((x) => c.session.pick.project?.(x.target) ?? null);
      const cols: Record<"L" | "R", number[]> = { L: [], R: [] };
      pts.forEach((p, i) => {
        if (!p) return show(i, false);
        show(i, true);
        const s = slots[i];
        // Hysteresis: a card only changes sides once its point is well into the other half
        if (!s.side || (s.side === "L" && p.x > W * 0.55) || (s.side === "R" && p.x < W * 0.45)) s.side = p.x < W / 2 ? "L" : "R";
        // Never cover the point itself with its own card
        const band = cards[i].offsetWidth + EDGE + 16;
        if (s.side === "L" && p.x < band) s.side = "R";
        else if (s.side === "R" && p.x > W - band) s.side = "L";
        cols[s.side].push(i);
      });
      for (const side of ["L", "R"] as const) {
        const ix = cols[side].sort((a, z) => pts[a]!.y - pts[z]!.y);
        const hs = ix.map((i) => cards[i].offsetHeight);
        const cw = cards[ix[0]]?.offsetWidth ?? 0;
        const ys = ix.map((i, k) => pts[i]!.y - hs[k] / 2);
        // Push down past the card above, then back up from the bottom edge
        for (let k = 0; k < ys.length; k++) ys[k] = Math.max(ys[k], TOP, k ? ys[k - 1] + hs[k - 1] + GAP : TOP);
        for (let k = ys.length - 1; k >= 0; k--)
          ys[k] = Math.min(ys[k], k < ys.length - 1 ? ys[k + 1] - hs[k] - GAP : H - BOTTOM - hs[k]);
        ix.forEach((i, k) => {
          const x = side === "L" ? EDGE : W - EDGE - cw;
          const p = pts[i]!;
          const card = cards[i];
          card.style.transform = `translate(${x}px, ${ys[k]}px)`;
          card.dataset.side = side;
          card.dataset.x = String(Math.round(p.x));
          card.dataset.y = String(Math.round(p.y));
          const lx = side === "L" ? x + cw : x;
          const ly = Math.max(ys[k] + 10, Math.min(ys[k] + hs[k] - 10, p.y));
          lines[i].setAttribute("x1", String(lx));
          lines[i].setAttribute("y1", String(ly));
          lines[i].setAttribute("x2", String(p.x));
          lines[i].setAttribute("y2", String(p.y));
          dots[i].setAttribute("cx", String(p.x));
          dots[i].setAttribute("cy", String(p.y));
        });
      }
    };
    frame();
    const offFrame = onFrame(frame, { priority: PRIO.ui, el });
    // Live state from the sim tick, only while the firmware drives the pin as an output
    const lives = list.map((x) => ({ pin: livePin(x), el: el.querySelector<HTMLElement>(`[data-callout="${x.key}"] [data-live]`), text: "" }));
    const offTick = c.session.onTick((m) => {
      for (const l of lives) {
        if (!l.pin || !l.el) continue;
        const out = !!bit(m.enable, m.enableHi, l.pin.pin);
        const hi = !!bit(m.gpio, m.gpioHi, l.pin.pin);
        const s = !out ? "" : l.pin.led ? (hi ? t("Now: on") : t("Now: off")) : hi ? t("Now: high 3.3 V") : t("Now: low 0 V");
        if (s === l.text) continue;
        l.text = s;
        l.el.textContent = s;
        l.el.style.display = s ? "" : "none";
      }
    });
    return () => {
      offFrame();
      offTick();
    };
    // `keys` stands for `list`: the callouts only change with the lesson step
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, b]);

  if (!list.length) return null;
  return (
    <div id="lessonCallouts" ref={root} aria-label={t("Part callouts")} className="pointer-events-none absolute inset-0 z-2 overflow-hidden max-md:hidden">
      <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
        {list.map((x) => (
          <g key={x.key}>
            <line data-for={x.key} stroke="#0D99FF" strokeWidth={1} style={{ display: "none" }} />
            <circle data-for={x.key} r={3.5} fill="#0D99FF" style={{ display: "none" }} />
          </g>
        ))}
      </svg>
      {list.map((x) => (
        <button
          key={x.key}
          type="button"
          data-callout={x.key}
          onClick={() => b.select({ kind: x.target.kind, id: x.target.id })}
          style={{ display: "none" }}
          className="pointer-events-auto absolute top-0 left-0 flex w-[200px] cursor-pointer flex-col gap-0.5 rounded-[10px] border border-[#CFE6FA] bg-(--panel) px-2.5 py-2 text-left text-fg shadow-panel hover:border-[#0D99FF]"
        >
          <span className="text-[13px] font-bold tracking-[.02em]">{x.title}</span>
          <span className="text-[12px] leading-[17px] text-muted">{x.body}</span>
          {livePin(x) && <span data-live className="font-mono text-[12px] text-[#0A6FBD]" style={{ display: "none" }} />}
        </button>
      ))}
    </div>
  );
}
