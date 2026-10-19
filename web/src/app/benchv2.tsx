// Bench v2 cards and left-rail content (U-04): wiring banners, pin rings, wrong-wire card, meter, checkpoint, wiring table, parts.
// Render only: data and actions come from steps/bench.tsx (or main.tsx); this never touches the Session.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { ScreenPoint } from "../scene-api";
import { PARTS, type Kind } from "../catalog/parts";
import { cn } from "../ui/cn";
import { Live } from "../ui/native";
import { Icon } from "./icons";
import { isPhone, setMui, usePhone } from "./mobile";
import type { BenchWire } from "./wiring";
import { placeDef } from "./place";
import { ConfIcon, confLabel, type ConfLevel } from "../ui/conf";
import { t } from "../i18n";

/** t() with React nodes as placeholders, so markup stays inside one translatable sentence. */
export function tn(en: string, nodes: Record<string, ReactNode>): ReactNode {
  return t(en)
    .split(/(\{\w+\})/)
    .map((s, i) => {
      const k = /^\{(\w+)\}$/.exec(s)?.[1];
      return k && k in nodes ? <Fragment key={i}>{nodes[k]}</Fragment> : s;
    });
}

const btn =

  "inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-line bg-surface px-2.5 text-xs text-fg hover:bg-field";
const btnPri =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-accent-strong bg-accent-strong px-2.5 text-xs font-medium text-on-accent";

// ------------------------------------------------------------ confidence
// ConfLevel values are machine identifiers shared with ui/conf.tsx and data files; only labels are translated.
export type Conf = ConfLevel;
const [SIMV, BEHV, EST, REAL] = ["仿真验证", "行为模拟", "估算", "必须上真机"] as const satisfies readonly Conf[]; // lint: allow-cjk
/** Display label per confidence level (the stored value stays the identifier). */
export const CONF_LABEL: Record<Conf, string> = { [SIMV]: confLabel(SIMV), [BEHV]: confLabel(BEHV), [EST]: confLabel(EST), [REAL]: confLabel(REAL) };
const CONF_TIP: Record<Conf, string> = {
  [SIMV]: t("An acceptance firmware ran in the simulator; readings follow the datasheet registers and formulas"),
  [BEHV]: t("Register interface follows the datasheet, physics is approximated; noise and timing details are not modeled"),
  [EST]: t("No model; estimated from the datasheet only"),
  [REAL]: t("This can't be simulated; only real hardware gives a verdict"),
};
/** Per-part confidence on the bench; rationale per peripheral in docs/STATUS.md (firmware acceptance = simulated). */
export const PART_CONF: Record<string, Conf> = {
  board: SIMV,
  bme280: SIMV,
  oled: SIMV,
  gc9a01: SIMV,
  pot: SIMV,
  led: SIMV,
  key: SIMV,
  encoder: SIMV,
  servo: BEHV,
  buzzer: BEHV,
  hcsr04: BEHV,
  mpu6050: BEHV,
  qmi8658: BEHV,
  cst816s: BEHV,
  max98357a: BEHV,
  inmp441: BEHV,
};
/** Ink icon + level name (U-14: colour is reserved for result status, not confidence). */
export function ConfBadge({ c }: { c: Conf }) {
  return (
    <span
      data-conf={c}
      title={CONF_TIP[c]}
      className="inline-flex h-5 flex-none items-center gap-1 text-[11px] whitespace-nowrap text-fg"
    >
      <ConfIcon c={c} size={12} />
      {CONF_LABEL[c]}
    </span>
  );
}

// ------------------------------------------------------------ wiring banner + pin rings
/** Thin wires are hard to tap on phones, so the banner lists rewirable wires plus undo and wiring table (DESIGN_V2 §5). */
export function WireBanner({
  wire,
  onCancel,
  wires,
  onWire,
  onUndo,
}: {
  wire: string | null;
  onCancel: () => void;
  wires?: { id: string; label: string }[];
  onWire?: (id: string) => void;
  onUndo?: (() => void) | null;
}) {
  const phone = usePhone();
  if (phone)
    return (
      <div
        id="wireBanner"
        role="status"
        className="absolute top-2 right-2 left-2 z-5 rounded-xl bg-accent-strong p-2 pl-3 text-[13px] text-on-accent shadow-panel"
      >
        <div className="flex items-center gap-2">
          <Icon n="wire" size={16} className="flex-none" />
          <span className="min-w-0 flex-1 leading-snug">
            {wire ? (
              <>
                {tn("Selected {wire}, now tap a blue pin", { wire: <b className="font-mono">{wire}</b> })}
              </>
            ) : (
              t("First tap the wire to rewire:")
            )}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 flex-none cursor-pointer rounded-lg border-0 bg-[#ffffff2e] px-3 text-[13px] text-on-accent"
          >
            {t("Cancel")}
          </button>
        </div>
        {!wire && !!wires?.length && (
          <div className="mt-1.5 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
            {wires.map((w) => (
              <button
                key={w.id}
                type="button"
                data-wpick={w.id}
                onClick={() => onWire?.(w.id)}
                className="min-h-11 flex-none cursor-pointer rounded-lg border-0 bg-surface px-3 font-mono text-xs whitespace-nowrap text-fg"
              >
                {w.label}
              </button>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex gap-1.5">
          <button
            type="button"
            data-wire-undo=""
            disabled={!onUndo}
            onClick={() => onUndo?.()}
            className="min-h-11 flex-1 cursor-pointer rounded-lg border-0 bg-[#ffffff2e] px-2 text-[13px] text-on-accent disabled:opacity-50"
          >
            {t("Undo last step")}
          </button>
          <button
            type="button"
            data-wire-table=""
            onClick={() => setMui({ lib: "wires", props: false, more: false })}
            className="min-h-11 flex-1 cursor-pointer rounded-lg border-0 bg-[#ffffff2e] px-2 text-[13px] text-on-accent"
          >
            {t("View wiring table")}
          </button>
        </div>
      </div>
    );
  return (
    <div
      id="wireBanner"
      role="status"
      className="absolute top-14 left-1/2 z-4 flex -translate-x-1/2 items-center gap-2 rounded-full bg-accent-strong py-1 pr-1 pl-3.5 text-xs text-on-accent shadow-panel"
    >
      <Icon n="wire" size={14} />
      <span>
        {wire ? (
          <>
            {tn("Rewire {wire}: click a new pin", { wire: <b className="font-mono">{wire}</b> })}
          </>
        ) : (
          t("Wiring… first click the wire to rewire")
        )}
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="h-6 cursor-pointer rounded-full border-0 bg-[#ffffff2e] px-2.5 text-xs text-on-accent hover:bg-[#ffffff47]"
      >
        {t("Esc to cancel")}
      </button>
    </div>
  );
}

/** Pin-by-pin wiring guide after placing a part (P2-16): current pin highlighted, click a blue ring on the board. */
export function PlaceBanner({
  name,
  steps,
  cur,
  got,
  onStep,
  onSkip,
  onBack,
  onCancel,
}: {
  name: string;
  steps: { pin: string; label: string; want: string; optional?: boolean }[];
  cur: number;
  got: Record<string, string>;
  onStep: (i: number) => void;
  onSkip: (() => void) | null;
  onBack: (() => void) | null;
  onCancel: () => void;
}) {
  const phone = usePhone();
  const s = steps[cur];
  const what =
    s.want === "gnd" ? "GND" : s.want === "power" ? t("3V3 or 5V") : t("a GPIO");
  return (
    <div
      id="placeBanner"
      role="status"
      data-step={s.pin}
      className={cn(
        "absolute z-5 rounded-xl bg-accent-strong text-on-accent shadow-panel",
        phone
          ? "top-2 right-2 left-2 p-2 pl-3 text-[13px]"
          : "top-14 left-1/2 w-[min(560px,calc(100%-24px))] -translate-x-1/2 px-3.5 py-2 text-xs",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon n="wire" size={14} className="flex-none" />
        <span className="min-w-0 flex-1 leading-snug">
          {tn(
            s.optional
              ? "Wire {pin} of {part} (optional): click {what} on the board (blue ring)"
              : "Wire {pin} of {part}: click {what} on the board (blue ring)",
            { part: <b>{name}</b>, pin: <b className="font-mono">{s.label}</b>, what },
          )}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "flex-none cursor-pointer rounded-full border-0 bg-[#ffffff2e] px-2.5 text-on-accent hover:bg-[#ffffff47]",
            phone ? "min-h-11 text-[13px]" : "h-6 text-xs",
          )}
        >
          {phone ? t("Don't place") : t("Esc: don't place")}
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {steps.map((x, i) => (
          <button
            key={x.pin}
            type="button"
            data-pstep={x.pin}
            aria-current={i === cur ? "step" : undefined}
            onClick={() => onStep(i)}
            className={cn(
              "cursor-pointer rounded-md border-0 px-2 font-mono text-[11px] whitespace-nowrap",
              phone ? "min-h-11" : "h-6",
              i === cur
                ? "bg-surface text-fg"
                : got[x.pin]
                  ? "bg-[#ffffff2e] text-on-accent"
                  : "bg-transparent text-on-accent opacity-75 outline outline-1 outline-[#ffffff47]",
            )}
          >
            {x.label}
            {got[x.pin] ? ` → ${got[x.pin]}` : ""}
          </button>
        ))}
        <span className="flex-1" />
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className={cn(
              "cursor-pointer rounded-md border-0 bg-[#ffffff2e] px-2 text-on-accent",
              phone ? "min-h-11 text-[13px]" : "h-6 text-[11px]",
            )}
          >
            {t("Previous pin")}
          </button>
        )}
        {onSkip && (
          <button
            type="button"
            data-pskip=""
            onClick={onSkip}
            className={cn(
              "cursor-pointer rounded-md border-0 bg-[#ffffff2e] px-2 text-on-accent",
              phone ? "min-h-11 text-[13px]" : "h-6 text-[11px]",
            )}
          >
            {t("Skip this pin")}
          </button>
        )}
      </div>
    </div>
  );
}

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
    let raf = 0;
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
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
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

// ------------------------------------------------------------ wrong-wire confirmation
export function WrongWireCard({
  title,
  detail,
  wire,
  sim,
  estimate,
  onUndo,
  onRetry,
  onKeep,
}: {
  title: string;
  detail: string;
  wire: string;
  sim: string;
  /** Current and consequence from the net solver (P2-14, estimate; hidden until computed). */
  estimate?: { mA: number; text: string; what: string };
  onUndo: () => void;
  onRetry: () => void;
  onKeep: () => void;
}) {
  return (
    <div
      id="wrongWire"
      role="alertdialog"
      aria-label={t("Wrong wire")}
      className="absolute top-14 left-1/2 z-5 w-[380px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-(--r) border border-(--bad-line) max-md:top-2 max-md:z-6 bg-surface p-3.5 text-fg shadow-panel"
    >
      <div className="flex items-start gap-2">
        <Icon n="warn" size={18} className="mt-0.5 flex-none text-bad-ink" />
        <div className="min-w-0 flex-1">
          <b className="block text-sm">{t("This wiring will cause trouble: {title}", { title })}</b>
          <span className="block font-mono text-[11px] text-muted">{wire}</span>
        </div>
      </div>
      <p className="mt-2 mb-0 text-xs">{detail}</p>
      {estimate && (
        <div
          data-ww="estimate"
          className="mt-2 rounded-(--r) border border-(--bad-line) bg-bad-bg px-2.5 py-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <b className="font-mono text-sm text-bad-ink">≈ {estimate.mA} mA</b>
            <ConfBadge c={EST} />
          </div>
          <p className="mt-1 mb-0">{estimate.text}</p>
          <p className="mt-0.5 mb-0 text-[11px] text-muted">
            {t("Worst case: {what}", { what: estimate.what })}
          </p>
        </div>
      )}
      <p className="mt-1.5 mb-0 text-[11px] text-muted">{sim}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          data-ww="undo"
          className={btnPri}
          onClick={onUndo}
        >
          {t("Undo this rewire")}
        </button>
        <button type="button" data-ww="retry" className={btn} onClick={onRetry}>
          {t("Rewire to another pin")}
        </button>
        <button type="button" data-ww="keep" className={btn} onClick={onKeep}>
          {t("I know, keep it")}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ multimeter card
/** Readings are filled by the bench's updateLive via data-live (data-live-root lets it find this card). */
export function MeterCard({
  target,
  onClose,
}: {
  target: string | null;
  onClose: () => void;
}) {
  return (
    <div
      id="meterCard"
      data-live-root=""
      role="region"
      aria-label={t("Multimeter")}
      className="absolute right-3 bottom-[calc(var(--tb-h,52px)+12px)] z-3 w-[220px] rounded-(--r) border border-line bg-surface p-3 text-fg shadow-panel max-md:right-2 max-md:bottom-2 max-md:w-[200px]"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted">{t("Multimeter · DC voltage")}</span>
        <button
          type="button"
          aria-label={t("Close multimeter")}
          onClick={onClose}
          className="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-field max-md:-my-2 max-md:-mr-2 max-md:size-11"
        >
          <Icon n="x" size={13} />
        </button>
      </div>
      <Live
        k="mv"
        init="—"
        className="mt-1 block font-mono text-2xl font-semibold tabular-nums"
      />
      <span className="block text-xs text-muted">
        {target ? (
          <>
            {tn("{target} to GND", { target: <span className="font-mono">{target}</span> })}
          </>
        ) : (
          t("Click a pin or a wire on the bench")
        )}
      </span>
      <Live as="p" k="mnote" className="mt-1.5 mb-0 text-[11px] text-muted" />
    </div>
  );
}

// ------------------------------------------------------------ checkpoint card (bottom of left rail)
export function CheckpointCard({
  id,
  title,
  pass,
  done,
  total,
  go,
  onGo,
  onAll,
  own,
  allBusy,
  onAllRef,
  onMine,
}: {
  id: string;
  title: string;
  pass: string;
  done: number;
  total: number;
  go: string | null;
  onGo: () => void;
  onAll: () => void;
  /** How many passed with the user's own firmware (✓); the rest passed with reference firmware (◐). */
  own: number;
  /** Built-in firmware is being checked one checkpoint at a time. */
  allBusy: boolean;
  /** Run every checkpoint with built-in firmware (null when the project has no reference firmware). */
  onAllRef: (() => void) | null;
  /** Write your own: open this checkpoint (drop a .bin, copy the brief for an AI). */
  onMine: () => void;
}) {
  return (
    <div
      id="cpCard"
      className="rounded-lg border border-line bg-surface p-2.5 text-xs"
    >
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>{t("Current checkpoint")}</span>
        <span className="font-mono" title={t("Checkpoints that ran; \"mine\" passed with your own firmware")}>
          {done}/{total}
          {done > 0 && ` · ${t("mine {n}", { n: own })}`}
        </span>
      </div>
      <b className="mt-1 block text-[13px]">
        <span className="font-mono">{id}</span> {t(title)}
      </b>
      <p className="mt-1 mb-2 line-clamp-3 text-muted">{t(pass)}</p>
      {onAllRef && (
        <>
          <button
            type="button"
            id="cpAllRef"
            className={`${btnPri} w-full`}
            disabled={allBusy}
            onClick={onAllRef}
            title={t("Checks each checkpoint with the project's reference firmware; a pass counts as ◐ and still unlocks Assemble and Product")}
          >
            {allBusy ? t("Checking built-in firmware…") : t("Run all with built-in firmware")}
          </button>
          <p className="mt-1 mb-2 text-[11px] text-muted">
            {t("See Assemble and Product without a toolchain; switch to your own firmware later and passes become ✓.")}
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" id="cpMine" className={onAllRef ? btn : btnPri} onClick={onMine} title={t("Drop a .bin, or copy the brief for an AI")}>
          {t("Write my own firmware")}
        </button>
        <button
          type="button"
          id="cpGo"
          className={btn}
          onClick={onGo}
          title={go ? t("Select and focus {part}", { part: go }) : t("Open this checkpoint")}
        >
          {t("Show me")}
        </button>
        <button type="button" id="cpAll" className={btn} onClick={onAll}>
          {t("All checkpoints")}
        </button>
      </div>
    </div>
  );
}
export function AllPassedCard({
  total,
  own = total,
  retest,
  onNext,
}: {
  total: number;
  /** Passes with the user's own firmware; the rest ran on built-in firmware (◐). */
  own?: number;
  /** Power-on retest after assembly: false = failed, so the card must not still say "all passed". */
  retest?: boolean | null;
  onNext: () => void;
}) {
  if (retest === false)
    return (
      <div
        id="cpCard"
        className="rounded-lg border border-(--warn-line) bg-warn-bg p-2.5 text-xs text-warn-ink"
      >
        <b className="block text-[13px]">
          {t("Checkpoints {n}/{n} passed · power-on retest ✗", { n: total })}
        </b>
        <p className="mt-1 mb-2">{t("Fine on the bench, but the retest failed inside the enclosure: go back to Assemble and see what to change.")}</p>
        <button type="button" className={btnPri} onClick={onNext}>
          {t("Back to Assemble →")}
        </button>
      </div>
    );
  return (
    <div
      id="cpCard"
      className="rounded-lg border border-line bg-ok-bg p-2.5 text-xs text-ok-ink"
    >
      <b className="block text-[13px]">
        {own === total ? t("All {n} checkpoints passed", { n: total }) : t("All {n} checkpoints ran", { n: total })}
      </b>
      <p className="mt-1 mb-2">{t("Assemble is unlocked: put what's on the bench into an enclosure.")}</p>
      {own < total && (
        <p className="mt-0 mb-2 text-muted" data-own={own}>
          {t("My firmware {own}/{total}: the rest ran on built-in firmware (◐). Drop your own .bin on a checkpoint; a pass becomes ✓.", { own, total })}
        </p>
      )}
      <button type="button" className={btnPri} onClick={onNext}>
        {t("Next: Assemble →")}
      </button>
    </div>
  );
}

// ------------------------------------------------------------ wiring table
export function WireTable({
  wires,
  bad,
  sel,
  onSel,
}: {
  wires: BenchWire[];
  bad: Map<string, string>;
  sel: string | null;
  onSel: (id: string) => void;
}) {
  if (!wires.length)
    return <p className="m-2 text-xs text-muted">{t("No external wires on the bench")}</p>;
  return (
    <table id="wireTable" className="w-full border-collapse text-xs">
      <thead>
        <tr className="text-left text-[11px] text-muted">
          <th className="px-1 py-1 font-normal">{t("Dev board")}</th>
          <th className="px-1 py-1 font-normal">{t("Part")}</th>
          <th className="px-1 py-1 font-normal">{t("Wire")}</th>
        </tr>
      </thead>
      <tbody>
        {wires.map((w) => {
          const b = bad.get(w.id);
          return (
            <tr
              key={w.id}
              data-wire={w.id}
              aria-selected={sel === w.id}
              onClick={() => onSel(w.id)}
              title={b ? `✗ ${b}` : w.role}
              className={cn(
                "cursor-pointer border-t border-line-soft hover:bg-field aria-selected:bg-accent-bg",
                w.missing && "opacity-50",
              )}
            >
              <td className="px-1 py-1.5 font-mono">
                {w.a}
                {w.from && (
                  <span className="block text-[10px] text-muted">
                    {t("was {pin}", { pin: w.from })}
                  </span>
                )}
              </td>
              <td className="px-1 py-1.5">
                <span className="font-mono">{w.b}</span>
                {b && (
                  <span className="block text-[11px] text-bad-ink">✗ {b}</span>
                )}
                {w.missing && (
                  <span className="block text-[11px] text-muted">{t("Unplugged")}</span>
                )}
              </td>
              <td className="px-1 py-1.5 text-muted">
                {t(w.color)} · {w.lenCm} cm
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------ parts library
const KIND_NAMES: Partial<Record<Kind, string>> = {
  sensor: t("Sensors"),
  display: t("Displays"),
  actuator: t("Actuators"),
  input: t("Inputs"),
  audio: t("Audio"),
  module: t("Modules"),
  power: t("Power"),
  passive: t("Discrete parts"),
};
/** dataTransfer type for library drags; the bench drop accepts only this, so it never mixes with .bin drops. */
export const LIB_DRAG = "application/x-tryboard-part";
const SIM_NAMES = {
  verified: CONF_LABEL[SIMV],
  estimated: CONF_LABEL[EST],
  none: t("No model"),
} as const;
const SIM_CONF = {
  verified: SIMV,
  estimated: EST,
  none: REAL,
} as const;
/** inBom: part ids already in the shopping list (the phone library marks them "In list"). */
export function PartLib({
  chip,
  inBom,
  onPlace,
}: {
  chip: "esp32" | "esp32c3" | "esp32s3";
  inBom?: ReadonlySet<string>;
  /** Desktop: click "Place" or drag onto the bench (P2-16); without it parts can only be added via Shop. */
  onPlace?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind | null>(null);
  const phone = usePhone();
  const all = PARTS.filter(
    (p) =>
      KIND_NAMES[p.kind] &&
      p.chips.includes(chip) &&
      (!q ||
        (p.name + p.model + p.keywords)
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
  const list = phone && kind ? all.filter((p) => p.kind === kind) : all;
  const kinds = [...new Set(list.map((p) => p.kind))];
  if (phone)
    return (
      <div id="partLib" className="text-[14px]">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder={t("Find a part: BME280, servo…")}
          aria-label={t("Find a part")}
          className="h-11 w-full rounded-xl border border-line bg-field px-3 text-[16px] text-fg outline-none focus:border-accent"
        />
        <div
          role="group"
          aria-label={t("Category")}
          className="-mx-4 mt-2 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]"
        >
          {([null, ...new Set(all.map((p) => p.kind))] as (Kind | null)[]).map(
            (k) => (
              <button
                key={k ?? "all"}
                type="button"
                data-kind={k ?? "all"}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className="h-11 flex-none cursor-pointer rounded-full border border-line bg-surface px-3.5 text-[13px] whitespace-nowrap text-fg aria-pressed:border-accent aria-pressed:bg-accent-bg aria-pressed:font-medium aria-pressed:text-accent-ink"
              >
                {k ? KIND_NAMES[k] : t("All")}
              </button>
            ),
          )}
        </div>
        <p className="mt-1 mb-2 text-xs text-muted">
          {t("Parts reach the bench from the shopping list: tap one to tick it in Shop. Prices are hand-picked reference ranges.")}
        </p>
        {list.map((p) => {
          const has = inBom?.has(p.id);
          return (
            <a
              key={p.id}
              href="#shop"
              data-lib={p.id}
              className="flex min-h-14 items-center gap-3 border-b border-line-soft py-1.5 text-fg no-underline"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{t(p.name)}</span>
                <span className="block truncate text-xs text-muted">
                  {KIND_NAMES[p.kind]} · ¥{p.price.lo}–{p.price.hi} ·{" "}
                  <span className="inline-flex items-center gap-1 align-[-2px]">
                    <ConfIcon c={SIM_CONF[p.sim.level]} size={11} />
                    {SIM_NAMES[p.sim.level]}
                  </span>
                </span>
              </span>
              <span
                className={cn(
                  "flex-none rounded-full px-3 py-1.5 text-xs",
                  has
                    ? "bg-ok-bg text-ok-ink"
                    : "bg-accent-strong text-on-accent",
                )}
              >
                {has ? t("In list") : t("Add")}
              </span>
            </a>
          );
        })}
        {!list.length && <p className="text-muted">{t("No matching parts")}</p>}
      </div>
    );
  return (
    <div id="partLib" className="text-xs">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        placeholder={t("Find a part: BME280, servo…")}
        aria-label={t("Find a part")}
        className="mb-2 h-8 w-full rounded-md border border-line bg-field px-2 text-xs text-fg outline-none focus:border-accent"
      />
      <p className="mt-0 mb-2 text-[11px] text-muted">
        {onPlace
          ? t("Drag onto the bench or click \"Place\", then wire it to the board pin by pin; greyed parts can't be placed (hover for why). Whole kits still come from the shopping list.")
          : t("Parts reach the bench from the shopping list: click one to tick it in Shop.")}
      </p>
      {kinds.map((k) => (
        <section key={k} className="mb-2">
          <h4 className="m-0 mb-1 text-[11px] font-medium text-muted">
            {KIND_NAMES[k]}
          </h4>
          {list
            .filter((p) => p.kind === k)
            .map((p) => {
              const d = onPlace ? placeDef(p.id) : null;
              const why = d && "why" in d ? d.why : null;
              return (
                <div
                  key={p.id}
                  data-lib={p.id}
                  data-placeable={d ? String(!why) : undefined}
                  draggable={!!d && !why}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(LIB_DRAG, p.id);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title={why ?? (d ? t("Drag onto the bench, or click \"Place\"") : undefined)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-field",
                    d && !why && "cursor-grab",
                  )}
                >
                  <a
                    href="#shop"
                    title={t("See it in Shop")}
                    className={cn(
                      "min-w-0 flex-1 truncate no-underline",
                      why ? "text-muted" : "text-fg",
                    )}
                  >
                    {t(p.name)}
                  </a>
                  <span className="inline-flex flex-none items-center gap-1 text-[10px] text-muted">
                    <ConfIcon c={SIM_CONF[p.sim.level]} size={10} />
                    {SIM_NAMES[p.sim.level]}
                  </span>
                  {d && (
                    <button
                      type="button"
                      data-place={p.id}
                      disabled={!!why}
                      aria-label={why ? t("{part} can't be placed: {why}", { part: t(p.name), why }) : t("Place {part} on the bench", { part: t(p.name) })}
                      onClick={() => onPlace?.(p.id)}
                      className="h-6 flex-none cursor-pointer rounded-md border border-line bg-surface px-2 text-[11px] text-fg hover:border-accent hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg"
                    >
                      {t("Place")}
                    </button>
                  )}
                </div>
              );
            })}
        </section>
      ))}
      {!list.length && <p className="text-muted">{t("No matching parts")}</p>}
    </div>
  );
}

// ------------------------------------------------------------ empty-bench guide
export function EmptyBench({
  onFirmware,
  hasFw,
}: {
  onFirmware: () => void;
  hasFw: boolean;
}) {
  return (
    <div
      id="emptyBench"
      className="absolute top-1/2 left-1/2 z-3 w-[340px] max-w-[calc(100%-24px)] -translate-x-1/2 -translate-y-1/2 rounded-(--r) border border-line bg-surface p-4 text-fg shadow-panel"
    >
      {/* Without firmware the only primary button is "Change firmware…" (design unify/Steps); with it, Shop gets primary */}
      {!hasFw && <span className="block text-[11px] font-medium text-muted">{t("No firmware")}</span>}
      <b className="block text-sm">{t("Only a dev board on the bench")}</b>
      <p className="mt-1 mb-3 text-xs text-muted">
        {hasFw
          ? t("Pick parts in Shop to put here, or drag single parts from the library and wire them.")
          : t("Drop a .bin exported from ESP-IDF / Arduino, or run an example first.")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {hasFw ? (
          <a href="#shop" className={cn(btnPri, "no-underline")}>
            {t("Pick parts in Shop")}
          </a>
        ) : (
          <button type="button" id="emptyFw" data-fw-open="" className={btnPri} onClick={onFirmware}>
            {t("Change firmware…")}
          </button>
        )}
        {hasFw ? (
          <button type="button" data-fw-open="" className={btn} onClick={onFirmware}>
            {t("Change firmware…")}
          </button>
        ) : (
          <a href="#shop" className={cn(btn, "no-underline")}>
            {t("Pick parts in Shop")}
          </a>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ brownout reset explanation
export function BrownoutBanner({
  t: at,
  v,
  servo,
  onPower,
  onClose,
}: {
  t: number;
  v: number | null;
  servo: boolean;
  onPower: (() => void) | null;
  onClose: () => void;
}): ReactNode {
  return (
    <div
      id="brownBanner"
      role="alert"
      className="absolute top-14 left-1/2 z-4 w-[420px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-(--r) border border-(--bad-line) bg-bad-bg p-3 text-xs text-bad-ink shadow-panel"
    >
      <div className="flex items-start gap-2">
        <Icon n="warn" size={16} className="mt-px flex-none" />
        <div className="min-w-0 flex-1">
          <b className="block text-[13px]">
            {t("Voltage too low, the chip restarted")}
          </b>
          <p className="mt-1 mb-0 text-[13px]">
            {servo
              ? t("The servo shares USB power with the chip; when it moves it drags the voltage down.")
              : t("The peripherals draw more than USB can supply.")}
          </p>
          <p className="mt-1 mb-0 opacity-75">
            {v != null
              ? t("At {t} s, 3V3 dropped to {v} V, below the brownout threshold (brownout reset). Serial prints the boot log again.", { t: at.toFixed(2), v: v.toFixed(2) })
              : t("At {t} s, 3V3 fell below the brownout threshold (brownout reset). Serial prints the boot log again.", { t: at.toFixed(2) })}
          </p>
          <div className="mt-2 flex gap-1.5">
            {onPower && (
              <button type="button" className={btnPri} onClick={onPower}>
                {t("Check power")}
              </button>
            )}
            <button type="button" className={btn} onClick={onClose}>
              {t("Got it")}

            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
