// Bench section: beginner "Show current" (PLAN H-04). With the switch on, the 3D bench draws the lesson's loop while its GPIO
// is high; until the lesson's own code runs it assumes high and says so in a stage corner. #stage[data-flow] mirrors the state.
import { t } from "../../i18n";
import type { Tool } from "../toolbar";
import { overlay } from "../chrome";
import { lessonUi } from "../lesson";
import { lessonSignal } from "../lessontasks";
import { bit } from "../pinscope";
import type { BenchCtx } from "./ctx";

type FlowState = "on" | "off" | "assumed";

function FlowNote() {
  return (
    <div
      id="flowNote"
      className="pointer-events-none absolute top-14 right-3 z-2 flex items-center gap-1.5 rounded-full border border-dashed border-[#0D99FF] bg-(--panel) px-2.5 py-1 text-[11px] text-fg shadow-panel"
    >
      <span className="inline-block h-0 w-4 border-t-2 border-dashed border-[#0D99FF]" />
      {t("Not running: shown as if the output were high")}
    </div>
  );
}

export function mountFlow(b: BenchCtx) {
  let on = false;
  let state: FlowState | null = null;
  let subs: (() => void)[] = [];

  /** Work out on / off / assumed from the lesson, run state and pin level; only touches the scene when that changes. */
  function apply(level?: number) {
    const c = b.ctx;
    const lesson = lessonUi.get().lesson;
    const circ = lesson?.circuit;
    if (on && (!c || !circ || c.store.get().step !== "bench")) return stop();
    let next: FlowState | null = null;
    if (on && c && lesson && circ) {
      const mine = c.store.get().running && c.session.fwName === `${lesson.fw}/flash.bin`;
      if (!mine) next = "assumed";
      else {
        const f = c.session.frame;
        const hi = level ?? (bit(f.enable, f.enableHi, circ.pin) & bit(f.gpio, f.gpioHi, circ.pin));
        next = hi ? "on" : "off";
      }
    }
    if (next === state) return;
    state = next;
    const segs = c?.session.bench.setFlow?.(next === "on" || next === "assumed" ? circ!.path : null) ?? 0;
    const el = document.getElementById("stage");
    if (el && next) {
      el.dataset.flow = next;
      el.dataset.flowSegs = String(segs);
    } else if (el) {
      delete el.dataset.flow;
      delete el.dataset.flowSegs;
    }
    overlay("flow", next === "assumed" ? <FlowNote /> : null);
  }

  function stop() {
    on = false;
    subs.forEach((f) => f());
    subs = [];
    apply();
    if (b.ctx) b.setToolGroups(b.ctx);
  }

  function toggle() {
    const c = b.ctx;
    if (!c) return;
    if (on) return stop();
    on = true;
    lessonSignal("view:current");
    subs = [
      c.session.onTick((m) => {
        const pin = lessonUi.get().lesson?.circuit?.pin;
        if (pin != null) apply(bit(m.enable, m.enableHi, pin) & bit(m.gpio, m.gpioHi, pin));
      }),
      c.store.subscribe(() => apply(), ["running", "step", "run"]),
      lessonUi.subscribe(() => apply(), ["lesson"]),
    ];
    apply();
    b.setToolGroups(c);
  }

  /** The switch for the short beginner toolbar; only lessons with a circuit get one. */
  b.flowTools = (): Tool[] =>
    lessonUi.get().lesson?.circuit ? [{ id: "current", label: t("Show current"), kind: "switch", on: () => on }] : [];
  b.toggleFlow = toggle;
  b.flowOn = () => on;
}
