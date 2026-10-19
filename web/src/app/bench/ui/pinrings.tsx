import { useEffect, useRef, useState } from "react";
import type { ScreenPoint } from "../../../scene-api";
import { cn } from "../../../ui/cn";
import { onFrame, PRIO } from "../../../ui/frame";
import { t } from "../../../i18n";
import { isPhone } from "../../mobile";

export interface RingPin {
  id: string;
  label: string;
  role?: string;
  /** Wires already on this pin (part ends). */
  used: string[];
}
/** One ring per connectable pin, following the 3D projection each frame (style writes, no re-render). */
export function PinRings({
  pins,
  cur,
  project,
  onPin,
}: {
  pins: RingPin[];
  cur: string | null;
  project: (id: string) => ScreenPoint | null;
  onPin: (id: string) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => {
      for (const p of pins) {
        const el = refs.current[p.id];
        if (!el) continue;
        const s = project(p.id);
        // Skip DOM writes when the camera is still, otherwise the page never looks idle
        if (el.hidden !== !s) el.hidden = !s;
        const tf = s
          ? `translate(${Math.round(s.x - 9)}px, ${Math.round(s.y - 9)}px)`
          : "";
        if (s && el.style.transform !== tf) el.style.transform = tf;
      }
    };
    return onFrame(tick, { priority: PRIO.ui, immediate: true });
  }, [pins, project]);
  const h = hover ? pins.find((p) => p.id === hover) : null;
  const lens = useLens(pins, refs, onPin);
  return (
    <div id="pinRings" className="pointer-events-none absolute inset-0 z-3">
      {pins.map((p) => (
        <button
          key={p.id}
          ref={(el) => void (refs.current[p.id] = el)}
          type="button"
          data-ring={p.id}
          aria-label={t("Connect to {pin}", { pin: p.id })}
          onClick={() => onPin(p.id)}
          onPointerEnter={() => setHover(p.id)}
          onPointerLeave={() => setHover((x) => (x === p.id ? null : x))}
          className={cn(
            "pointer-events-auto absolute top-0 left-0 size-[18px] cursor-pointer rounded-full border-2 bg-transparent p-0",
            // Phone: bigger rings; taps go through the lens (useLens) since 2.54 mm pitch is a few pixels
            "max-md:scale-125",
            p.id === cur
              ? "border-warn-ink"
              : p.used.length
                ? "border-muted"
                : "border-accent",
            "hover:bg-accent-bg",
          )}
        />
      ))}
      {h && (
        <div
          role="tooltip"
          className="absolute rounded-md border border-line bg-surface px-2 py-1 text-[11px] whitespace-nowrap text-fg shadow-panel"
          style={{
            transform: refs.current[h.id]?.style.transform,
            marginTop: 24,
          }}
        >
          <b className="font-mono">{h.id}</b>
          {h.label !== h.id && (
            <span className="text-muted"> {t("(silkscreen {label})", { label: h.label })}</span>
          )}
          <span className="ml-1.5">
            {h.id === cur
              ? t("Connected here now")
              : h.used.length
                ? t("Used by: {list}", { list: h.used.join(", ") })
                : t("Free")}
          </span>
          {h.role && <span className="block text-muted">{h.role}</span>}
        </div>
      )}
      {lens}
    </div>
  );
}

const ringCenter = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
/** Phone lens: a 140px circle above the finger shows nearby pins at 2.5x and connects the nearest on release.
 *  It draws pin dots, not a WebGL capture (that needs preserveDrawingBuffer and slows every frame). */
function useLens(
  pins: RingPin[],
  refs: React.RefObject<Record<string, HTMLButtonElement | null>>,
  onPin: (id: string) => void,
) {
  const [st, setSt] = useState<{
    x: number;
    y: number;
    ox: number;
    oy: number;
    id: string | null;
  } | null>(null);
  const live = useRef(st);
  live.current = st;
  useEffect(() => {
    const stage = document.getElementById("stage");
    if (!stage) return;
    const near = (x: number, y: number, max: number) => {
      let best: string | null = null;
      let bd = max;
      for (const p of pins) {
        const el = refs.current[p.id];
        if (!el || el.hidden) continue;
        const c = ringCenter(el);
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < bd) {
          bd = d;
          best = p.id;
        }
      }
      return best;
    };
    const down = (e: PointerEvent) => {
      if (!isPhone() || e.button > 0) return;
      // Only take over near a pin; elsewhere the drag still orbits the camera
      const id = near(e.clientX, e.clientY, 40);
      if (!id) return;
      e.stopPropagation();
      e.preventDefault();
      const o = stage.getBoundingClientRect();
      setSt({ x: e.clientX, y: e.clientY, ox: o.left, oy: o.top, id });
      const move = (ev: PointerEvent) => {
        ev.preventDefault();
        setSt(
          (s) =>
            s && {
              ...s,
              x: ev.clientX,
              y: ev.clientY,
              id: near(ev.clientX, ev.clientY, 48),
            },
        );
      };
      const up = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        const pick = live.current?.id;
        setSt(null);
        if (pick) onPin(pick);
      };
      const cancel = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        setSt(null);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
    };
    // Ring clicks also fire onPin; on phones release already connected, so swallow the click
    const click = (e: MouseEvent) => {
      if (isPhone() && (e.target as HTMLElement).closest?.("[data-ring]")) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    stage.addEventListener("pointerdown", down, true);
    stage.addEventListener("click", click, true);
    return () => {
      stage.removeEventListener("pointerdown", down, true);
      stage.removeEventListener("click", click, true);
    };
  }, [pins, refs, onPin]);
  if (!st) return null;
  const R = 70;
  const K = 2.5;
  const hit = st.id ? pins.find((p) => p.id === st.id) : null;
  const dots = pins
    .map((p) => {
      const el = refs.current[p.id];
      if (!el || el.hidden) return null;
      const c = ringCenter(el);
      const dx = (c.x - st.x) * K,
        dy = (c.y - st.y) * K;
      return Math.hypot(dx, dy) < R - 8 ? { p, dx, dy } : null;
    })
    .filter((d) => !!d);
  // Lens sits above the fingertip so the finger doesn't cover it; beside it near the top edge
  const lx = st.x - st.ox,
    ly = st.y - st.oy;
  const top = ly - 2 * R - 36 < 0 ? ly - R : ly - 2 * R - 36;
  const left =
    ly - 2 * R - 36 < 0 ? (lx > 200 ? lx - 2 * R - 40 : lx + 40) : lx - R;
  return (
    <div
      id="pinLens"
      aria-live="polite"
      className="pointer-events-none absolute z-6"
      style={{ left, top }}
    >
      <div className="relative size-[140px] overflow-hidden rounded-full border-2 border-accent-strong bg-surface shadow-panel">
        <span className="absolute top-1/2 left-1/2 size-1.5 -translate-1/2 rounded-full bg-muted" />
        {dots.map(({ p, dx, dy }) => (
          <span
            key={p.id}
            className={cn(
              "absolute top-1/2 left-1/2 size-4 rounded-full border-2",
              p.id === st.id
                ? "border-accent-strong bg-accent-strong"
                : p.used.length
                  ? "border-muted"
                  : "border-accent",
            )}
            style={{ transform: `translate(${dx - 8}px, ${dy - 8}px)` }}
          />
        ))}
      </div>
      <div className="mt-1 w-[140px] rounded-md bg-fg px-2 py-1 text-center text-[11px] leading-tight text-surface">
        {hit ? (
          <>
            <b className="font-mono">{hit.id}</b>
            <span className="block opacity-80">
              {hit.used.length
                ? t("Used by: {list}", { list: hit.used.join(", ") })
                : (hit.role ?? t("Free"))}
            </span>
          </>
        ) : (
          t("Move closer to a pin")
        )}
      </div>
    </div>
  );
}
