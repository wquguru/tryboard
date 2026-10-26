// H-17 schematic view: the stage overlay that swaps the 3D bench for a 2D drawing of the same parts and wires.
// Picks go through the bench selection (b.select), so the 3D highlight, part card and lesson tasks see the same target.
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

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
const LED_INK: Record<LedColor, string> = { red: "#F24822", green: "#14AE5C", blue: "#0D99FF" };
const ledName = (c: LedColor) => (c === "green" ? t("Green LED") : c === "blue" ? t("Blue LED") : t("Red LED"));
const mA = (v: number) => v.toFixed(1);
/** Rough text width for label boxes: CJK glyphs are about twice as wide as Latin at the same size */
const textW = (s: string, px: number) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? px : px * 0.56), 0);

/** Toolbar segment: 3D bench | Schematic (both toolbars; phones list it under View tools). */
export const viewTools = (): Tool[] => [
  { id: "view3d", label: t("3D bench"), kind: "switch", on: () => schUi.get().view === "3d" },
  { id: "schematic", label: t("Schematic"), kind: "switch", on: () => schUi.get().view === "schematic" },
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

function zig(len: number) {
  const lead = (len - 60) / 2;
  return `M0 0h${lead}l5-9 10 18 10-18 10 18 10-18 10 18 5-9h${lead}`;
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

function Ring({ s }: { s: SchSym }) {
  return (
    <rect
      x={s.x - 6}
      y={s.y - 6}
      width={s.w + 12}
      height={s.h + 12}
      rx={6}
      fill="var(--accent)"
      fillOpacity={0.08}
      stroke="var(--accent)"
      strokeWidth={2}
      pointerEvents="none"
    />
  );
}

function SymBox({ s, on }: { s: SchSym; on: boolean }) {
  return (
    <>
      <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={6} fill="var(--surface)" stroke="currentColor" strokeWidth={2} />
      <text x={s.x + 14} y={s.ty ?? s.y + 26} className="fill-current text-[15px] font-bold">
        {s.ref}
      </text>
      {s.sub && (
        <text x={s.x + 14} y={(s.ty ?? s.y + 26) + 20} className="fill-muted text-[13px]">
          {s.sub}
        </text>
      )}
      {s.pins.map((p, i) => (
        <text key={i} x={p.x} y={p.y + 4} textAnchor={p.anchor} className="fill-current font-mono text-[12px]">
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
      <rect
        x={f.x}
        y={f.y - 11}
        width={f.w}
        height={22}
        rx={4}
        fill={on ? "var(--accent-bg)" : "var(--surface)"}
        stroke={on ? "var(--accent)" : "currentColor"}
        strokeWidth={1.5}
      />
      <text x={f.x + f.w / 2} y={f.y + 4} textAnchor="middle" className={cn("font-mono text-[12px]", on ? "fill-accent-ink" : "fill-current")}>
        {f.net}
      </text>
    </g>
  );
}

function Sheet({ sch, sel, net, flow, onSym, onNet }: { sch: Schematic; sel: (s: SchSym) => boolean; net: string | null; flow: boolean; onSym: (s: SchSym) => void; onNet: (f: SchFlag) => void }) {
  const lit = new Set(net ? (sch.nets[net] ?? []) : []);
  const phone = usePhone();
  return (
    <svg
      id="schematicSvg"
      viewBox={`0 0 ${sch.w} ${sch.h}`}
      width={sch.w}
      height={sch.h}
      style={{ width: "100%", maxWidth: sch.w * 1.5 }}
      className="mx-auto block h-auto text-fg select-none"
      role="img"
      aria-label={t("Schematic")}
    >
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
            aria-label={`${s.ref} ${s.kind === "led" ? ledName(s.color ?? "red") : (s.sub ?? "")}`}
            aria-pressed={on}
            data-ref={s.ref}
            data-part={s.part}
            data-kind={s.kind}
            className="cursor-pointer outline-none"
            onClick={() => onSym(s)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSym(s)}
          >
            {s.kind !== "mcu" && s.kind !== "box" && <rect x={s.x - 6} y={s.y - 6} width={s.w + 12} height={s.h + 12} fill="transparent" />}
            {s.kind === "res" ? <SymRes s={s} on={on} /> : s.kind === "led" ? <SymLed s={s} on={on} /> : <SymBox s={s} on={on} />}
          </g>
        );
      })}
      {sch.flags.map((f, i) => (
        <Flag key={i} f={f} on={net === f.net} pick={() => onNet(f)} />
      ))}
      {flow &&
        sch.flows.map((f) => {
          const label = phone
            ? t("{ref} ≈ {ma} mA · estimate", { ref: f.ref, ma: mA(f.mA) })
            : t("≈ {ma} mA → · estimate · not calibrated on real hardware", { ma: mA(f.mA) });
          const w = textW(label, 13) + 20;
          return (
            <g key={f.part} data-flow={f.part} pointerEvents="none">
              <polyline points={f.pts.join(" ")} fill="none" stroke="var(--accent)" strokeWidth={3} strokeDasharray="8 6" />
              <rect x={f.x} y={f.y} width={w} height={26} rx={6} fill="var(--accent-bg)" />
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
        <span className="text-muted">
          {t("Labels with the same name are connected: both ends are lit, and so is the wire on the 3D bench.")}
        </span>
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
    const tg = { kind: "part" as const, id: sym.part };
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
          <span>{t("Forward drop {vf} V · current ≈ {ma} mA (estimate)", { vf: LED_VF[sym.color ?? "red"], ma: mA(flow?.mA ?? 0) })}</span>
          <span className="text-muted">{t("The triangle points the way current flows; the bar end (short leg) goes to GND.")}</span>
        </>
      )}
      {sym.kind === "mcu" && (
        <>
          <b>
            {sym.ref} · {sym.sub}
          </b>
          <span className="text-muted">
            {t("Only the pins this bench uses are drawn: {pins}", { pins: sym.pins.map((p) => p.name).join(", ") })}
          </span>
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
      {(sym.kind === "res" || sym.kind === "led" || sym.kind === "box") && (
        <button
          type="button"
          id="schematicOpen"
          onClick={open}
          className="mt-1 min-h-11 cursor-pointer rounded-lg border border-line bg-field px-3 text-[14px] text-fg hover:border-hover-line"
        >
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
  const sch = schematicOf(parts, wires, { vertical: phone, board });
  const selId = st.selection?.kind === "part" ? st.selection.id : null;
  const symOf = (s: SchSym) => !ui.net && selId === s.part && (!ui.sel || ui.sel === s.ref || !sch.syms.some((x) => x.ref === ui.sel && x.part === selId));
  const picked = ui.net ? null : (sch.syms.find((s) => s.ref === ui.sel && s.part === selId) ?? sch.syms.find((s) => s.part === selId) ?? null);
  const onSym = (s: SchSym) => {
    schUi.set({ sel: s.ref, net: null });
    b.select({ kind: "part", id: s.part });
    lessonSignal(`select:${s.part}`);
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
  const flowOn = ui.flow === "on" || ui.flow === "assumed";
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
  return (
    <div
      id="schematic"
      data-layout={phone ? "phone" : "desktop"}
      data-flow={flowOn ? "on" : undefined}
      className={cn("absolute inset-0 z-[5] flex bg-surface", phone ? "flex-col gap-2 overflow-y-auto p-3" : "gap-3 p-4 pb-(--tb-h)")}
    >
      <div className={cn("flex min-w-0 flex-col gap-2", phone ? "shrink-0" : "min-h-0 flex-1")}>
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
          {!phone && <span className="ml-auto text-[13px] text-muted">{t("Made from the current wiring · click a symbol to select it on the 3D bench too")}</span>}
        </div>
        <div
          id="schematicPaper"
          className={cn("relative overflow-auto rounded-xl border border-line p-3", phone ? "shrink-0" : "min-h-0 flex-1")}
          style={{ backgroundImage: "radial-gradient(var(--line) 1px, transparent 1.2px)", backgroundSize: "20px 20px" }}
        >
          <Sheet sch={sch} sel={symOf} net={ui.net} flow={flowOn} onSym={onSym} onNet={onNet} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
          <span>{t("Wire colours aren't drawn: a schematic only shows what connects to what")}</span>
          {sch.flags.length > 0 && <span>{t("Labels with the same name are connected (no long wires, no crossings)")}</span>}
          {sch.gnds.length > 1 && <span>{t("Every ground symbol is the same GND")}</span>}
        </div>
      </div>
      <aside
        aria-label={t("Selected symbol")}
        className={cn(phone ? "shrink-0 rounded-t-2xl bg-surface p-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)]" : "w-72 shrink-0 self-start pt-9")}
      >
        {!phone && <div className="mb-2 text-[12px] text-muted">{t("Selected symbol")}</div>}
        <Card b={b} sch={sch} sym={picked} net={ui.net} />
      </aside>
    </div>
  );
}
