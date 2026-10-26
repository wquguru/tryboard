// Lesson info tabs (PLAN H-14, DESIGN_V2 §11 Tabs.dc.html): overview / wiring / code explained / parameters above the step card.
// Wiring rows are this lesson's wiring.ts rows (bench view); clicking one lights that wire up on the bench.
import { useEffect, useState, type KeyboardEvent } from "react";
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { useStore } from "./react";
import { lessonUi, setLessonUi, type InfoTab } from "./lesson";
import { ledParamValue, type Lesson, type LessonParam, type ParamSource } from "./lessons";
import type { BenchWire } from "./wiring";
import { ohmText, type LedColor } from "../bench3d/ledparams";
import { loadSrc } from "./fwsrc";
import { COURSE, courseLesson } from "./course";

/** Source lines of `file` in firmware `fw` (`<id>/flash.bin`), or null while loading / missing. */
export function useSrcLines(fw: string | undefined, file: string | undefined): string[] | null {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    setLines(null);
    const id = fw && /^([\w-]+)\/flash\.bin$/.exec(fw)?.[1];
    if (!id || !file) return;
    let live = true;
    void loadSrc(id).then((g) => {
      const f = g.ok ? g.src.files.find((x) => x.path === file) : undefined;
      if (live && f) setLines(f.text.split("\n"));
    });
    return () => void (live = false);
  }, [fw, file]);
  return lines;
}

const TABS: [InfoTab, string][] = [
  ["overview", t("Overview")],
  ["wiring", t("Wiring")],
  ["code", t("Code explained")],
  ["params", t("Parameters")],
];

/** Jumper colour names (wiring.ts, already translated) → the dot in the pin column. */
const DOT: Record<string, string> = {
  [t("Black")]: "#2F343A",
  [t("Red")]: "#D93B30",
  [t("Orange")]: "#E07A1F",
  [t("Yellow")]: "#E3B21C",
  [t("Green")]: "#2E9E4F",
  [t("Purple")]: "#7B4FC9",
  [t("Blue")]: "#2F6FE0",
  [t("Cyan")]: "#1FA8B8",
  [t("Grey")]: "#8A9099",
};

const SOURCE: Record<ParamSource, { text: string; cls: string }> = {
  bench: { text: t("This lesson's bench"), cls: "bg-surface text-muted" },
  code: { text: t("This lesson's code"), cls: "bg-surface text-muted" },
  typical: { text: t("Typical value"), cls: "bg-surface text-muted" },
  datasheet: { text: t("Datasheet"), cls: "bg-accent-bg text-accent-ink" },
  estimate: { text: t("Estimate · not calibrated on real hardware"), cls: "bg-warn-bg text-warn-ink" },
};

/** The four tabs; desktop draws them at the top of the lesson card, phones inside the pulled-up lesson panel. */
export function LessonInfo({ phone }: { phone?: boolean }) {
  const s = useStore(lessonUi);
  const l = s.lesson;
  if (!l) return null;
  const pick = (k: InfoTab) => setLessonUi({ info: k });
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex(([k]) => k === s.info);
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const k = TABS[(i + d + TABS.length) % TABS.length][0];
    pick(k);
    (e.currentTarget.querySelector(`[data-info-tab="${k}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div id="lessonInfo" data-tab={s.info} className="flex flex-none flex-col gap-3">
      <div role="tablist" aria-label={t("About this lesson")} onKeyDown={onKey} className="flex gap-0.5 border-b border-line">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`lessonInfoTab-${k}`}
            data-info-tab={k}
            aria-selected={s.info === k}
            aria-controls="lessonInfoPanel"
            tabIndex={s.info === k ? 0 : -1}
            onClick={() => pick(k)}
            className={cn(
              "-mb-px min-h-11 min-w-0 flex-1 cursor-pointer border-0 border-b-2 bg-transparent",
              "px-1 text-[13px] leading-[16px]",
              s.info === k ? "border-accent-strong font-bold text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="lessonInfoPanel" data-info-tab={s.info} aria-labelledby={`lessonInfoTab-${s.info}`} className="flex flex-col gap-2.5">
        {s.info === "overview" && <Overview l={l} />}
        {s.info === "wiring" && <Wiring l={l} wires={s.wires} sel={s.wireSel} onSel={s.showWire} phone={phone} />}
        {s.info === "code" && <Code l={l} />}
        {s.info === "params" && <Params l={l} led={s.led} />}
      </div>
    </div>
  );
}

function Overview({ l }: { l: Lesson }) {
  return (
    <>
      <p className="m-0 text-[14px] leading-[22px]">{l.summary}</p>
      <p className="m-0 text-[12px] text-muted">
        {t("About {n} min", { n: l.minutes })} · {t("Parts for this lesson: {parts}", { parts: l.buy })}
      </p>
      <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
        {l.steps.map((st, i) => (
          <li key={st.id} className="flex gap-2">
            <span className="w-4 flex-none text-right font-mono text-muted">{i + 1}</span>
            <span className="min-w-0">{st.title}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function wireTo(l: Lesson, w: BenchWire) {
  const note = l.wireNotes?.[w.id];
  if (!note) return w.b;
  if (w.ohm === 0) return t("LED long leg (no resistor)");
  return note.to.replace("{ohm}", ohmText(w.ohm ?? 220));
}

function Wiring({ l, wires, sel, onSel, phone }: { l: Lesson; wires: BenchWire[]; sel: string | null; onSel: (id: string) => void; phone?: boolean }) {
  if (!wires.length) return <p className="m-0 text-[13px] text-muted">{t("No external wires on the bench")}</p>;
  return (
    <>
      <b className="text-[15px]">{t("How this lesson is wired")}</b>
      <table id="lessonWires" className="w-full table-fixed border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[12px] text-muted">
            <th className="w-[30%] border-b border-line px-1.5 py-1.5 font-medium">{t("Pin")}</th>
            <th className="w-[35%] border-b border-line px-1.5 py-1.5 font-medium">{t("Goes to")}</th>
            <th className="border-b border-line px-1.5 py-1.5 font-medium">{t("What it does")}</th>
          </tr>
        </thead>
        <tbody>
          {wires.map((w) => (
            <tr
              key={w.id}
              data-wire={w.id}
              aria-selected={sel === w.id}
              tabIndex={0}
              onClick={() => onSel(w.id)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onSel(w.id);
              }}
              className={cn("h-11 cursor-pointer align-top hover:bg-field aria-selected:bg-accent-bg", w.missing && "opacity-50")}
            >
              <td className="border-b border-line-soft px-1.5 py-2.5">
                <span className="inline-flex items-center gap-1.5 font-bold break-all">
                  <span className="size-2.5 flex-none rounded-full" style={{ background: DOT[w.color] ?? "#8A9099" }} />
                  {w.a}
                </span>
              </td>
              <td className="border-b border-line-soft px-1.5 py-2.5 break-words">
                {wireTo(l, w)}
                {w.missing && <span className="block text-[11px] text-muted">{t("Unplugged")}</span>}
              </td>
              <td className="border-b border-line-soft px-1.5 py-2.5 break-words text-muted">{l.wireNotes?.[w.id]?.why ?? w.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="text-[12px] text-muted">{phone ? t("Tap a row to light up that wire on the bench") : t("Click a row to light up that wire on the bench")}</span>
    </>
  );
}

function Code({ l }: { l: Lesson }) {
  const src = useSrcLines(`${l.fw}/flash.bin`, l.src.replace(/^firmware\//, ""));
  if (!l.fw) return <p className="m-0 text-[13px] text-muted">{t("This lesson runs no code: it is about the board itself")}</p>;
  if (!l.code?.length) return <p className="m-0 text-[13px] text-muted">{t("No notes for this code yet")}</p>;
  return (
    <>
      <span className="text-[12px] text-muted">{t("The lines that matter in {file}", { file: l.src.split("/").pop() ?? l.src })}</span>
      <ol id="lessonCodeNotes" className="m-0 flex list-none flex-col gap-2 p-0">
        {l.code.map((c) => (
          <li key={c.line} data-code-line={c.line} className="flex flex-col gap-0.5 rounded-lg bg-field px-2.5 py-2">
            <span className="flex min-w-0 gap-2 font-mono text-[12px] leading-5">
              <span className="w-[22px] flex-none text-right text-muted tabular-nums">{c.line}</span>
              <span className="min-w-0 truncate whitespace-pre">{src?.[c.line - 1]?.trim() ?? ""}</span>
            </span>
            <span className="pl-[30px] text-[13px] leading-5">{c.text}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function paramValue(p: LessonParam, led: { ohm: number; color: LedColor } | null) {
  return p.live && led ? ledParamValue(p.live, led.ohm, led.color) : p.value;
}

function Params({ l, led }: { l: Lesson; led: { ohm: number; color: LedColor } | null }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <b className="text-[15px]">{t("Parameters")}</b>
        <span className="text-[12px] text-muted">{t("Each one says where it comes from")}</span>
      </div>
      <div id="lessonParams" className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
        {(l.params ?? []).map((p) => {
          const src = SOURCE[p.source];
          return (
            <div key={p.label} data-param={p.label} data-source={p.source} className="flex min-w-0 flex-col gap-1 rounded-[10px] bg-field px-3 py-2.5">
              <span className="text-[12px] text-muted">{p.label}</span>
              <b className={cn("text-[13px] break-words", p.live === "led-ma" && "font-mono font-normal")}>{paramValue(p, led)}</b>
              <span className={cn("self-start rounded px-1.5 py-0.5 text-[11px]", src.cls)}>{p.doc ? `${src.text} · ${p.doc}` : src.text}</span>
            </div>
          );
        })}
      </div>
      {l.buyTip && (
        <p id="lessonBuyTip" className="m-0 rounded-[10px] border border-line px-3 py-2.5 text-[13px] leading-5 text-muted">
          {l.buyTip}
        </p>
      )}
      {l.buyAll && <BuyAll l={l} />}
    </>
  );
}

/** H-16 capstone shopping list: each written course lesson's parts and buy tip, in course order (the BOM lives in the Shop step). */
function BuyAll({ l }: { l: Lesson }) {
  const rows = COURSE.map((e) => ({ e, x: courseLesson(e) })).filter(({ x }) => x && x !== l && x.buyTip);
  return (
    <div id="lessonBuyAll" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <b className="text-[15px]">{t("What to buy, lesson by lesson")}</b>
        <a id="lessonBuyShop" href="#shop" className="text-[12px] font-medium text-accent-strong underline underline-offset-2">
          {t("Full parts list with prices (Shop step)")}
        </a>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map(({ e, x }) => (
          <li key={e.no} data-buy={e.no} className="flex flex-col gap-0.5 rounded-[10px] bg-field px-3 py-2.5 text-[13px] leading-5">
            <span className="text-[12px] text-muted">{t("Lesson {n} · {title}", { n: e.no, title: x!.title })}</span>
            <b className="break-words">{x!.buy}</b>
            <span className="break-words text-muted">{x!.buyTip}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
