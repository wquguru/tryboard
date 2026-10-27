// H-17 schematic view: the stage overlay that swaps the 3D bench for a 2D drawing of the same parts and wires.
// Picks go through the bench selection (b.select), so the 3D highlight, part card and lesson tasks see the same target.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { useStore } from "../react";
import { cn } from "../../ui/cn";
import { overlay } from "../chrome";
import { lessonUi } from "../lesson";
import { lessonSignal } from "../lessontasks";
import { isPhone, setMui, usePhone } from "../mobile";
import { lessonWires, partInfo, sceneView } from "../wiring";
import type { Tool } from "../toolbar";
import { BOARD_NAME } from "../../chips";
import { boardDevs } from "../../bench3d/boarddevs";
import { LED_VF, resistorBands, type LedColor } from "../../bench3d/ledparams";
import type { BenchCtx } from "../bench/ctx";
import { schematicOf, type Schematic, type SchFlag, type SchSym } from "./model";
import { schUi, type BenchView } from "./store";
import { LEADED, PartGlyph, zig } from "./glyphs";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
const LED_INK: Record<LedColor, string> = {
  red: "#F24822",
  green: "#14AE5C",
  blue: "#0D99FF",
};
const ledName = (c: LedColor) => (c === "green" ? t("Green LED") : c === "blue" ? t("Blue LED") : t("Red LED"));
const mA = (v: number) => v.toFixed(1);
/** Rough text width for label boxes: CJK glyphs are about twice as wide as Latin at the same size */
const textW = (s: string, px: number) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? px : px * 0.56), 0);

/** Toolbar segment: 3D bench | Schematic (both toolbars; phones list it under View tools). */
export const viewTools = (): Tool[] => [
  {
    id: "view3d",
    label: t("3D bench"),
    kind: "switch",
    on: () => schUi.get().view === "3d",
  },
  {
    id: "schematic",
    label: t("Schematic"),
    kind: "switch",
    on: () => schUi.get().view === "schematic",
  },
];

export function setBenchView(b: BenchCtx, view: BenchView) {
  if (schUi.get().view === view && (view === "3d" || document.getElementById("schematic"))) return;
  schUi.set({ view, sel: null, net: null });
  overlay("schematic", view === "schematic" ? <SchematicView b={b} /> : null);
  const st = document.getElementById("stage");
  if (st) {
    if (view === "schematic") st.dataset.view = view;
    else delete st.dataset.view;
  }
  if (isPhone()) setMui({ more: false });
  if (b.ctx) b.setToolGroups(b.ctx);
}

/** Leaving the bench drops the overlay; the next visit starts on 3D. */
export function resetBenchView() {
  schUi.set({ view: "3d", sel: null, net: null });
  overlay("schematic", null);
  delete document.getElementById("stage")?.dataset.view;
}

function SymRes({ s, on }: { s: SchSym; on: boolean }) {
  const v = s.dir === "v";
  const len = v ? s.h : s.w;
  const tf = v ? `translate(${s.x + s.w / 2} ${s.y}) rotate(90)` : `translate(${s.x} ${s.y + s.h / 2})`;
  return (
    <>
      <path d={zig(len)} transform={tf} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <text x={s.tx} y={s.ty} textAnchor={v ? "start" : "middle"} className="fill-current text-[13px] font-bold">
        {v ? (
          <>
            <tspan x={s.tx}>{s.ref}</tspan>
            <tspan x={s.tx} dy={16} className="font-medium">
              {s.sub}
            </tspan>
          </>
        ) : (
          `${s.ref} · ${s.sub}`
        )}
      </text>
      {on && <Ring s={s} />}
    </>
  );
}

function SymLed({ s, on }: { s: SchSym; on: boolean }) {
  const v = s.dir === "v";
  const len = v ? s.h : s.w;
  const lead = (len - 32) / 2;
  const ink = LED_INK[s.color ?? "red"];
  const tf = v ? `translate(${s.x + s.w / 2} ${s.y}) rotate(90)` : `translate(${s.x} ${s.y + s.h / 2})`;
  // Light arrows point away from the diode, drawn in local (unrotated) coordinates
  return (
    <>
      <g transform={tf}>
        <path d={`M0 0h${lead}M${lead + 32} 0h${lead}`} stroke="currentColor" strokeWidth={2} />
        <path d={`M${lead} -14v28l28-14z`} fill={ink} fillOpacity={0.14} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
        <path d={`M${lead + 30} -15v30`} stroke="currentColor" strokeWidth={2.4} />
        <path d={`M${lead + 20} -18l8-9M${lead + 26} -15l8-9`} stroke={ink} strokeWidth={1.8} strokeLinecap="round" />
      </g>
      <text x={s.tx} y={s.ty} textAnchor={v ? "start" : "middle"} className="fill-current text-[13px] font-bold">
        {v ? (
          <>
            <tspan x={s.tx}>{s.ref}</tspan>
            <tspan x={s.tx} dy={16} className="font-medium">
              {ledName(s.color ?? "red")}
            </tspan>
          </>
        ) : (
          `${s.ref} · ${ledName(s.color ?? "red")}`
        )}
      </text>
      {on && <Ring s={s} />}
    </>
  );
}

/** Normally-open push button on a lead of length `len` (local x); contacts as rings, the plunger on the -y side */
function SwGlyph({ len }: { len: number }) {
  const a = len / 2 - 14;
  const b = len / 2 + 14;
  return (
    <>
      <path d={`M0 0h${a - 3}M${b + 3} 0H${len}`} stroke="currentColor" strokeWidth={2} />
      <circle cx={a} cy={0} r={3} fill="var(--surface)" stroke="currentColor" strokeWidth={2} />
      <circle cx={b} cy={0} r={3} fill="var(--surface)" stroke="currentColor" strokeWidth={2} />
      <path d={`M${a - 2} -11H${b + 2}M${len / 2} -11v-10M${len / 2 - 7} -21h14`} stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </>
  );
}

/** Passive buzzer: two leads into the flat side of a dome (the sound side faces -y) */
function BuzzGlyph({ len }: { len: number }) {
  const c = len / 2;
  return (
    <>
      <path d={`M0 0H${c - 8}v-8M${len} 0H${c + 8}v-8M${c - 16} -8h32`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <path d={`M${c - 16} -8a16 16 0 0 1 32 0`} fill="var(--surface)" stroke="currentColor" strokeWidth={2} />
      <path d={`M${c + 22} -18q4 6 0 12M${c + 27} -22q7 10 0 20`} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </>
  );
}

/** A glyph drawn along a lead from (x, y): sideways, or turned down so it can bridge two stacked pins */
function Along({ x, y, down, children }: { x: number; y: number; down?: boolean; children: ReactNode }) {
  return <g transform={down ? `translate(${x} ${y}) rotate(90)` : `translate(${x} ${y})`}>{children}</g>;
}

function SymSw({ s, on }: { s: SchSym; on: boolean }) {
  const v = s.dir === "v";
  return (
    <>
      <Along x={v ? s.x + s.w / 2 : s.x} y={v ? s.y : s.y + s.h / 2} down={v}>
        <SwGlyph len={v ? s.h : s.w} />
      </Along>
      {/* Phone: under the ground glyph, since both sides of a 64-unit column belong to neighbouring flags */}
      <text x={s.tx} y={s.ty} textAnchor="middle" className="fill-current text-[13px] font-bold">
        {v ? s.ref : `${s.ref} · ${s.sub}`}
      </text>
      {on && <Ring s={s} />}
    </>
  );
}

function Ring({ s }: { s: SchSym }) {
  return <rect x={s.x - 6} y={s.y - 6} width={s.w + 12} height={s.h + 12} rx={6} fill="var(--accent)" fillOpacity={0.08} stroke="var(--accent)" strokeWidth={2} pointerEvents="none" />;
}

// H-25 dedicated symbols inside a part's box. Desktop pins run down the left edge, so leads go right into the symbol;
// phone pins sit along the top, so the symbol is a small picture on the right.
function BoxGlyph({ s, vertical }: { s: SchSym; vertical: boolean }) {
  const own = PartGlyph({ s, vertical });
  if (own) return own;
  const pin = (re: RegExp) => s.pins.find((p) => re.test(p.name));
  const sig = pin(/^(IN|I\/O|SIG|S|PWM)$/);
  const gnd = pin(/^GND$/);
  const lead = (y: number, x2: number) => <path key={y} d={`M${s.x} ${y}H${x2}`} stroke="currentColor" strokeWidth={2} />;
  if (s.glyph === "oled") {
    const [w, h] = vertical ? [88, 38] : [104, 56];
    const x = vertical ? s.x + Math.min(s.w - w - 12, 228) : s.x + 80;
    const y = vertical ? s.y + 40 : s.y + s.h / 2 - h / 2 + 18;
    return (
      <g data-glyph="oled">
        <rect x={x - 4} y={y - 4} width={w + 8} height={h + 8} rx={4} fill="none" stroke="currentColor" strokeWidth={1.5} />
        <rect x={x} y={y} width={w} height={h} rx={2} fill="#101418" />
        <text x={x + w / 2} y={y + h / 2 + 4} textAnchor="middle" fill="#7FD6FF" className="font-mono text-[12px]">
          128 × 64
        </text>
      </g>
    );
  }
  if (s.glyph === "servo") {
    const n = s.pins.length;
    const cx = vertical ? s.x + Math.min(s.w - 44, 276) : s.x + 150;
    const cy = vertical || !n ? s.y + (vertical ? 52 : s.h / 2) : (s.pins[0].y + s.pins[n - 1].y) / 2;
    return (
      <g data-glyph="servo">
        {!vertical && s.pins.map((p, k) => <polyline key={k} points={`${s.x} ${p.y} ${s.x + 96} ${p.y} ${cx - 24} ${cy + (k - (n - 1) / 2) * 10}`} fill="none" stroke="currentColor" strokeWidth={2} />)}
        <circle cx={cx} cy={cy} r={24} fill="var(--surface)" stroke="currentColor" strokeWidth={2} />
        <text x={cx} y={cy + 6} textAnchor="middle" className="fill-current text-[17px] font-bold">
          M
        </text>
        {/* The horn: what turns when the pulse width changes */}
        <path d={`M${cx + 16} ${cy - 20}l12-12`} stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
      </g>
    );
  }
  const G = s.glyph === "buzzer" ? BuzzGlyph : SwGlyph;
  // Desktop: the symbol bridges the signal and GND pins; without both wired it is drawn on its own
  if (!vertical && sig && gnd && gnd.y > sig.y) {
    const cx = s.x + 140;
    return (
      <g data-glyph={s.glyph}>
        {s.pins.map((p) => lead(p.y, p === sig || p === gnd ? cx : s.x + 56))}
        <Along x={cx} y={sig.y} down>
          <G len={gnd.y - sig.y} />
        </Along>
      </g>
    );
  }
  return (
    <g data-glyph={s.glyph}>
      <Along x={s.x + Math.min(s.w - 84, 232)} y={vertical ? s.y + 62 : s.y + s.h / 2 + 10}>
        <G len={56} />
      </Along>
    </g>
  );
}

function SymBox({ s, on, vertical }: { s: SchSym; on: boolean; vertical: boolean }) {
  // A bare button is a discrete part, not a module: no outline on desktop, where its leads show the circuit
  const bare = (s.glyph === "button" || s.glyph === "pot") && !vertical;
  const above = !vertical && LEADED.has(s.glyph ?? "");
  return (
    <>
      <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={6} fill={bare ? "transparent" : "var(--surface)"} stroke={bare ? "none" : "currentColor"} strokeWidth={2} />
      {s.glyph && <BoxGlyph s={s} vertical={vertical} />}
      <text x={s.x + 14} y={s.ty ?? s.y + 26} className="fill-current text-[15px] font-bold">
        {s.ref}
      </text>
      {s.sub && (
        <text x={s.x + 14} y={(s.ty ?? s.y + 26) + 20} className="fill-muted text-[13px]">
          {s.sub}
        </text>
      )}
      {s.pins.map((p, i) => (
        <text key={i} x={p.x} y={above ? p.y - 6 : p.y + 4} textAnchor={p.anchor} className="fill-current font-mono text-[12px]">
          {p.name}
        </text>
      ))}
      {on && <Ring s={s} />}
    </>
  );
}

function Flag({ f, on, pick }: { f: SchFlag; on: boolean; pick: () => void }) {
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={t("Net {net}", { net: f.net })}
      aria-pressed={on}
      data-net={f.net}
      data-end={f.end}
      data-wire={f.wire || undefined}
      className="cursor-pointer outline-none"
      onClick={pick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pick()}
    >
      {/* Larger invisible hit box: flags are 22 px tall */}
      <rect x={f.x - 4} y={f.y - 16} width={f.w + 8} height={32} fill="transparent" />
      <rect x={f.x} y={f.y - 11} width={f.w} height={22} rx={4} fill={on ? "var(--accent-bg)" : "var(--surface)"} stroke={on ? "var(--accent)" : "currentColor"} strokeWidth={1.5} />
      <text x={f.x + f.w / 2} y={f.y + 4} textAnchor="middle" className={cn("font-mono text-[12px]", on ? "fill-accent-ink" : "fill-current")}>
        {f.net}
      </text>
    </g>
  );
}

function Sheet({ sch, scale, vertical, sel, net, flow, onSym, onNet }: { sch: Schematic; scale: number; vertical: boolean; sel: (s: SchSym) => boolean; net: string | null; flow: boolean; onSym: (s: SchSym) => void; onNet: (f: SchFlag) => void }) {
  const lit = new Set(net ? (sch.nets[net] ?? []) : []);
  return (
    <svg id="schematicSvg" viewBox={`0 0 ${sch.w} ${sch.h}`} width={Math.round(sch.w * scale)} height={Math.round(sch.h * scale)} data-scale={scale.toFixed(2)} className="m-auto block shrink-0 text-fg select-none" role="img" aria-label={t("Schematic")}>
      {sch.lines.map((l, i) => (
        <polyline
          key={i}
          points={l.pts.join(" ")}
          fill="none"
          stroke={l.wire && lit.has(l.wire) ? "var(--accent)" : l.missing ? "var(--muted)" : "currentColor"}
          strokeWidth={l.wire && lit.has(l.wire) ? 3 : 2}
          strokeDasharray={l.missing ? "6 5" : undefined}
          data-wire={l.wire}
        />
      ))}
      {sch.gnds.map((g, i) => (
        <path key={i} d={`M${g.x - 18} ${g.y}h36M${g.x - 11} ${g.y + 8}h22M${g.x - 4} ${g.y + 16}h8`} stroke="currentColor" strokeWidth={2} strokeLinecap="round" data-gnd="" />
      ))}
      {sch.syms.map((s) => {
        const on = sel(s);
        return (
          <g
            key={s.ref}
            role="button"
            tabIndex={0}
            aria-label={`${s.ref} ${s.kind === "led" ? ledName(s.color ?? "red") : s.kind === "sw" ? t("BOOT button") : (s.sub ?? "")}`}
            aria-pressed={on}
            data-ref={s.ref}
            data-part={s.part}
            data-kind={s.kind}
            data-sym={s.glyph}
            className="cursor-pointer outline-none"
            onClick={() => onSym(s)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSym(s)}
          >
            {s.kind !== "mcu" && s.kind !== "box" && <rect x={s.x - 6} y={s.y - 6} width={s.w + 12} height={s.h + 12} fill="transparent" />}
            {s.kind === "res" ? <SymRes s={s} on={on} /> : s.kind === "led" ? <SymLed s={s} on={on} /> : s.kind === "sw" ? <SymSw s={s} on={on} /> : <SymBox s={s} on={on} vertical={vertical} />}
          </g>
        );
      })}
      {sch.flags.map((f, i) => (
        <Flag key={i} f={f} on={net === f.net} pick={() => onNet(f)} />
      ))}
      {flow &&
        sch.flows.map((f) => {
          const label = vertical
            ? t("{ref} ≈ {ma} mA · estimate", { ref: f.ref, ma: mA(f.mA) })
            : t("≈ {ma} mA → · estimate · not calibrated on real hardware", {
                ma: mA(f.mA),
              });
          // Vertical columns are narrow, so the calibration note gets its own line
          const note = vertical ? t("Not calibrated on real hardware") : "";
          const w = Math.max(textW(label, 13), textW(note, 12)) + 20;
          return (
            <g key={f.part} data-flow={f.part} pointerEvents="none">
              <polyline points={f.pts.join(" ")} fill="none" stroke="var(--accent)" strokeWidth={3} strokeDasharray="8 6" />
              <rect x={f.x} y={f.y} width={w} height={note ? 42 : 26} rx={6} fill="var(--accent-bg)" />
              {note && (
                <text x={f.x + 10} y={f.y + 34} className="fill-accent-ink text-[12px]">
                  {note}
                </text>
              )}
              <text x={f.x + 10} y={f.y + 17} className="fill-accent-ink text-[13px] font-medium">
                {label}
              </text>
            </g>
          );
        })}
    </svg>
  );
}

function Card({ b, sch, sym, net }: { b: BenchCtx; sch: Schematic; sym: SchSym | null; net: string | null }) {
  const box = "flex flex-col gap-1.5 rounded-xl border-2 border-accent bg-surface p-3 text-[13px] text-fg";
  if (net)
    return (
      <div id="schematicCard" data-net={net} className={box}>
        <b>{t("{net} net", { net })}</b>
        <span className="text-muted">{t("Labels with the same name are connected: both ends are lit, and so is the wire on the 3D bench.")}</span>
      </div>
    );
  if (!sym)
    return (
      <div id="schematicCard" className="text-[13px] text-muted">
        {t("Click any symbol in the schematic to see what it is.")}
      </div>
    );
  const flow = sch.flows.find((f) => f.part === sym.part);
  const open = () => {
    const c = b.ctx;
    if (!c) return;
    setBenchView(b, "3d");
    const tg = { kind: sym.pick.kind, id: sym.pick.id };
    const pt = c.session.pick.project?.(tg);
    b.onPick(tg, pt ?? { x: 0, y: 0 });
  };
  return (
    <div id="schematicCard" data-ref={sym.ref} className={box}>
      {sym.kind === "res" && (
        <>
          <b>{t("{ref} · resistor {ohm}", { ref: sym.ref, ohm: sym.sub ?? "" })}</b>
          <div className="flex items-center gap-1.5 text-fg">
            {t("Colour bands")}
            {resistorBands(sym.ohm ?? 220)
              .slice(0, 3)
              .map((c, i) => (
                <span key={i} className="inline-block size-3.5 rounded-[3px] border border-line" style={{ background: hex(c) }} />
              ))}
          </div>
          <span className="text-muted">{t("Current limiting: without it the LED current would be too high. The same resistor is highlighted on the 3D bench.")}</span>
        </>
      )}
      {sym.kind === "led" && (
        <>
          <b>
            {sym.ref} · {ledName(sym.color ?? "red")}
          </b>
          <span>
            {t("Forward drop {vf} V · current ≈ {ma} mA (estimate)", {
              vf: LED_VF[sym.color ?? "red"],
              ma: mA(flow?.mA ?? 0),
            })}
          </span>
          <span className="text-muted">{t("The triangle points the way current flows; the bar end (short leg) goes to GND.")}</span>
        </>
      )}
      {sym.kind === "mcu" && (
        <>
          <b>
            {sym.ref} · {sym.sub}
          </b>
          <span className="text-muted">
            {t("Only the pins this bench uses are drawn: {pins}", {
              pins: sym.pins.map((p) => p.name).join(", "),
            })}
          </span>
        </>
      )}
      {sym.kind === "sw" && (
        <>
          <b>
            {sym.ref} · {t("BOOT button · GPIO{n}", { n: b.bootGpio() })}
          </b>
          <span className="text-muted">{t("Normally open: pressing it connects GPIO{n} to GND, so the pin reads low.", { n: b.bootGpio() })}</span>
        </>
      )}
      {sym.kind === "box" && (
        <>
          <b>
            {sym.ref} · {sym.sub}
          </b>
          <span className="text-muted">{partModel(b, sym.part)}</span>
        </>
      )}
      {(sym.kind === "res" || sym.kind === "led" || sym.kind === "box" || sym.kind === "sw") && (
        <button type="button" id="schematicOpen" onClick={open} className="mt-1 min-h-11 cursor-pointer rounded-lg border border-line bg-field px-3 text-[14px] text-fg hover:border-hover-line">
          {sym.kind === "res" ? t("Open the part card (change the resistor)") : t("Open the part card")}
        </button>
      )}
    </div>
  );
}

function partModel(b: BenchCtx, part: string) {
  const p = b.ctx?.session.scene.parts.find((x) => (x.type === "led" || x.type === "key" ? `${x.type}:${x.pin}` : x.type) === part);
  try {
    return (p && partInfo(p)?.model) || t("A part the schematic has no symbol for yet: drawn as a box with its pins.");
  } catch {
    return t("A part the schematic has no symbol for yet: drawn as a box with its pins.");
  }
}

/** Inner size of the scrolling paper, tracked so the sheet can be scaled to it */
function usePaperSize(ref: { current: HTMLDivElement | null }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => setSize((o) => (o.w === el.clientWidth && o.h === el.clientHeight ? o : { w: el.clientWidth, h: el.clientHeight }));
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const PAD = 24; // paper padding on both sides, in px
const MAX_SCALE = 1.6;
/** Pick the layout that fills the paper best and its scale. Never below 1: sheet text is 12 units, so 12 px is the floor and the paper scrolls instead. */
export function fitSheet(make: (vertical: boolean) => Schematic, paper: { w: number; h: number }, phone: boolean) {
  const fit = (s: Schematic) => (paper.w ? Math.min((paper.w - PAD) / s.w, (paper.h - PAD) / s.h) : 1);
  const h = phone ? null : make(false);
  const v = phone || (h && fit(h) < 1) ? make(true) : null;
  // The horizontal sheet follows the design; the vertical one wins only when it is readable at a larger size
  const sch = h && (!v || fit(h) >= 1 || fit(h) >= fit(v)) ? h : v!;
  return {
    sch,
    vertical: sch === v,
    scale: Math.min(MAX_SCALE, Math.max(1, fit(sch))),
  };
}

export function SchematicView({ b }: { b: BenchCtx }) {
  const c = b.ctx!;
  const ui = useStore(schUi);
  const st = useStore(c.store);
  const lesson = useStore(lessonUi).lesson;
  const phone = usePhone();
  const ses = c.session;
  const keep = lesson?.parts ?? null;
  const parts = sceneView(ses.scene, keep).parts;
  const wires = lessonWires(ses.scene.parts, keep, !!ses.power?.ext5v, ses.wireMods);
  const board = boardDevs(ses.scene.board)?.name ?? BOARD_NAME[ses.chip as keyof typeof BOARD_NAME] ?? "ESP32";
  const flowOn = ui.flow === "on" || ui.flow === "assumed";
  const paperRef = useRef<HTMLDivElement>(null);
  const paper = usePaperSize(paperRef);
  // Lessons that point at the BOOT button get it drawn as SW1 on its GPIO (lesson 02)
  const boot = lesson?.steps.some((s) => s.callouts.some((x) => x.target.kind === "button" && x.target.id === "BOOT")) ? b.bootGpio() : undefined;
  const { sch, scale, vertical } = fitSheet((vertical) => schematicOf(parts, wires, { vertical, board, captions: flowOn, boot }), paper, phone);
  // Symbols match the bench selection by pick target (kind + id), so the BOOT switch follows a 3D button pick too
  const selKey = st.selection && (st.selection.kind === "part" || st.selection.kind === "button") ? `${st.selection.kind}:${st.selection.id}` : null;
  const key = (s: SchSym) => `${s.pick.kind}:${s.pick.id}`;
  const symOf = (s: SchSym) => !ui.net && selKey === key(s) && (!ui.sel || ui.sel === s.ref || !sch.syms.some((x) => x.ref === ui.sel && key(x) === selKey));
  const picked = ui.net ? null : (sch.syms.find((s) => s.ref === ui.sel && key(s) === selKey) ?? sch.syms.find((s) => key(s) === selKey) ?? null);
  const onSym = (s: SchSym) => {
    schUi.set({ sel: s.ref, net: null });
    b.select({ kind: s.pick.kind === "button" ? "button" : "part", id: s.pick.id });
    lessonSignal(`select:${s.pick.id}`);
  };
  const onNet = (f: SchFlag) => {
    schUi.set({ sel: null, net: f.net });
    const wire = f.wire || sch.nets[f.net]?.[0];
    if (!wire) return;
    b.select({ kind: "wire", id: wire });
    ses.pick.highlight?.({ kind: "wire", id: wire });
  };
  const flowTool = b.flowTools()[0];
  const shortBar = b.lessonTools() && !b.beginnerMore;
  const seg = (v: BenchView, label: string) => (
    <button
      type="button"
      data-view-seg={v}
      aria-pressed={ui.view === v}
      onClick={() => setBenchView(b, v)}
      className="min-h-11 flex-1 cursor-pointer rounded-lg border-0 bg-transparent px-4 text-[14px] text-fg aria-pressed:bg-surface aria-pressed:font-bold aria-pressed:shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
    >
      {label}
    </button>
  );
  // Desktop keeps the notes in the side column: under the paper they sat behind the floating bench toolbar
  const notes = (
    <ul id="schematicNotes" className={cn("m-0 flex list-none flex-col gap-1.5 p-0 text-[12px] text-muted", !phone && "mt-4")}>
      {!phone && <li>{t("Made from the current wiring · click a symbol to select it on the 3D bench too")}</li>}
      <li>{t("Wire colours aren't drawn: a schematic only shows what connects to what")}</li>
      {sch.flags.length > 0 && <li>{t("Labels with the same name are connected (no long wires, no crossings)")}</li>}
      {sch.gnds.length > 1 && <li>{t("Every ground symbol is the same GND")}</li>}
    </ul>
  );
  return (
    <div id="schematic" data-layout={phone ? "phone" : "desktop"} data-flow={flowOn ? "on" : undefined} className={cn("absolute inset-0 z-[5] flex bg-surface", phone ? "flex-col gap-2 overflow-y-auto p-3" : "gap-3 p-4 pb-[calc(var(--tb-h,52px)+16px)]")}>
      {/* H-32: on a phone the paper fills what the lesson footer leaves (h-full) and scrolls inside; notes and card sit below */}
      <div className={cn("flex min-w-0 flex-col gap-2", phone ? "h-full min-h-60 shrink-0" : "min-h-0 flex-1")}>
        {(phone || (flowTool && !shortBar)) && (
          <div className="flex flex-wrap items-center gap-2">
            {phone && (
              <div role="group" aria-label={t("Bench view")} className="flex flex-1 rounded-[10px] bg-line p-[3px]">
                {seg("3d", t("3D bench"))}
                {seg("schematic", t("Schematic"))}
              </div>
            )}
            {flowTool && (phone || !shortBar) && (
              <button
                type="button"
                id="schematicFlow"
                aria-pressed={flowOn}
                onClick={() => b.toggleFlow()}
                className="min-h-11 cursor-pointer rounded-[10px] border border-line bg-surface px-3.5 text-[14px] text-fg aria-pressed:border-accent aria-pressed:bg-accent-bg aria-pressed:font-medium aria-pressed:text-accent-ink"
              >
                {t("Show current")}
              </button>
            )}
          </div>
        )}
        <div
          id="schematicPaper"
          ref={paperRef}
          className="relative flex min-h-0 flex-1 overflow-auto rounded-xl border border-line p-3"
          style={{
            backgroundImage: "radial-gradient(var(--line) 1px, transparent 1.2px)",
            backgroundSize: "20px 20px",
          }}
        >
          <Sheet sch={sch} scale={scale} vertical={vertical} sel={symOf} net={ui.net} flow={flowOn} onSym={onSym} onNet={onNet} />
        </div>
      </div>
      {phone && notes}
      <aside aria-label={t("Selected symbol")} className={cn(phone ? "shrink-0 rounded-t-2xl bg-surface p-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)]" : "w-72 shrink-0 self-start")}>
        {!phone && <div className="mb-2 text-[12px] text-muted">{t("Selected symbol")}</div>}
        <Card b={b} sch={sch} sym={picked} net={ui.net} />
        {!phone && notes}
      </aside>
    </div>
  );
}
