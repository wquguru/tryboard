// Bench section: beginner "Show me how" (PLAN H-05). Plays a lesson step's demo beats over the stage and hands over to
// "I'll wire it myself" (one target ring). The demo only draws; the self mode changes wiring only through the normal history.
import { t } from "../../i18n";
import { onFrame, PRIO } from "../../ui/frame";
import { overlay } from "../chrome";
import { lessonUi, setLessonUi } from "../lesson";
import { LessonDemo, SelfWire, type DemoApi, type SelfState } from "../lessondemo";
import type { DemoBeat, LessonTarget } from "../lessons";
import type { ScreenPoint } from "../../scene-api";
import type { BenchCtx } from "./ctx";

export function mountDemo(b: BenchCtx) {
  /** "Show current" was switched on by the demo (and is switched back off when it ends). */
  let flowMine = false;
  let selfStop: (() => void) | null = null;
  const ids = new Map<string, string | null>();

  const stageDemo = (v: "play" | "self" | null) => {
    const el = document.getElementById("stage");
    if (!el) return;
    if (v) el.dataset.lessonDemo = v;
    else delete el.dataset.lessonDemo;
  };
  function setFlow(on: boolean) {
    const cur = b.flowOn();
    if (on && !cur) {
      b.toggleFlow();
      flowMine = true;
    } else if (!on && flowMine) {
      if (cur) b.toggleFlow();
      flowMine = false;
    }
  }
  function wireId(from: string, to: string): string | null {
    const k = `${from}|${to}`;
    if (!ids.has(k)) {
      const ws = b.benchWires();
      ids.set(k, [`wire:${from}~${to}`, `wire:${to}~${from}`].find((id) => ws.some((w) => w.id === id)) ?? null);
    }
    return ids.get(k)!;
  }
  const api: DemoApi = {
    project: (tg) => b.ctx?.session.pick.project?.(tg) ?? null,
    projectWire: (id, n) => b.ctx?.session.bench.projectWire?.(id, n) ?? null,
    wireId,
    viewTo: (tg, ms) => {
      const bench = b.ctx?.session.bench;
      if (bench?.viewTo) bench.viewTo(tg, ms);
      else bench?.view("fit", tg);
    },
    setFlow,
  };

  function exitPlay() {
    if (lessonUi.get().demo !== "play") return;
    overlay("demo", null);
    setFlow(false);
    setLessonUi({ demo: null });
    stageDemo(null);
  }
  function closeSelf() {
    selfStop?.();
    selfStop = null;
    overlay("demoSelf", null);
    if (lessonUi.get().demo === "self") setLessonUi({ demo: null });
    stageDemo(null);
  }

  function open(step: number) {
    const c = b.ctx;
    const u = lessonUi.get();
    const l = u.lesson;
    const beats = l?.steps[step]?.demo;
    if (!c || !l || !beats?.length) return;
    closeSelf();
    if (b.wiring) b.setWiring(false);
    b.closeCard();
    ids.clear();
    if (u.step !== step) u.go(step);
    setLessonUi({ demo: "play" });
    stageDemo("play");
    const head = `${t("Lesson {n} · {title}", { n: l.no, title: l.title })} · ${t("Step {n}: {title}", { n: step + 1, title: l.steps[step].title })}`;
    overlay(
      "demo",
      <LessonDemo
        key={Date.now()}
        head={head}
        beats={beats}
        flowWires={(l.circuit?.path ?? []).filter((x) => x.startsWith("wire:"))}
        api={api}
        onExit={exitPlay}
        onSelf={(i) => self(beats, i)}
      />,
    );
  }

  /** Screen-space hint for a wrong pin: right / left (or up / down) when it sits next to the target. */
  function nearHint(chosen: string, target: string): string {
    const pick = b.ctx!.session.pick;
    const at = (id: string) => pick.project?.({ kind: "pin", id }) ?? null;
    const pc = at(chosen), pt = at(target);
    const generic = t("Not that hole: the blue ring is {pin}", { pin: target });
    if (!pc || !pt) return generic;
    const d = (p: ScreenPoint, q: ScreenPoint) => Math.hypot(p.x - q.x, p.y - q.y);
    let near = Infinity;
    for (const p of pick.listPins?.() ?? []) {
      if (p.id === target) continue;
      const q = at(p.id);
      if (q) near = Math.min(near, d(q, pt));
    }
    if (d(pc, pt) > near * 1.6) return generic;
    const dx = pt.x - pc.x, dy = pt.y - pc.y;
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? t("One column to the right") : t("One column to the left");
    return dy > 0 ? t("One column further down") : t("One column further up");
  }

  function self(beats: DemoBeat[], i: number) {
    const bt = beats[i].wire ? beats[i] : beats.find((x) => x.wire);
    const id = bt?.wire ? wireId(bt.wire.from, bt.wire.to) : null;
    exitPlay();
    const c = b.ctx;
    if (!c || !id) return;
    const target = id.slice(5).split("~")[0];
    const pinT: LessonTarget = { kind: "pin", id: target };
    setLessonUi({ demo: "self" });
    stageDemo("self");
    api.viewTo(pinT, 600);
    let touched = false;
    let last = "";
    let mods: unknown = null;
    const ringAt = () => {
      const w = b.benchWires().find((x) => x.id === id);
      if (w && !w.missing && w.a === target) return c.session.bench.projectWire?.(id, 1)?.[0] ?? c.session.pick.project?.(pinT) ?? null;
      return c.session.pick.project?.(pinT) ?? null;
    };
    const render = () => {
      const w = b.benchWires().find((x) => x.id === id);
      const ok = !!w && !w.missing && w.a === target;
      if (!ok) touched = true;
      const state: SelfState = ok ? (touched ? "ok" : "set") : !w || w.missing ? "todo" : "wrong";
      const key = `${state}|${w?.a}`;
      if (key === last) return;
      last = key;
      const hint =
        state === "set"
          ? t("This wire is already connected; you can delete it first and wire it yourself once.")
          : state === "ok"
            ? t("Right hole: the circuit is closed ✓")
            : state === "wrong"
              ? nearHint(w!.a, target)
              : t("Click “Plug it in”, then click the blue ring ({pin}).", { pin: target });
      overlay(
        "demoSelf",
        <SelfWire
          pin={target}
          at={ringAt}
          state={state}
          hint={hint}
          onUnplug={
            state === "set"
              ? () => {
                  const m = c.session.wireMods;
                  b.applyMods({ ...m, drop: [...(m.drop ?? []), id] }, t("Unplug {wire}", { wire: w!.b }));
                }
              : null
          }
          onPlug={state === "todo" || state === "wrong" ? () => b.setWiring(true, id) : null}
          onDone={closeSelf}
        />,
      );
    };
    // Wiring edits (rewire, unplug, undo) swap session.wireMods for a new object
    selfStop = onFrame(
      () => {
        if (c.session.wireMods === mods) return;
        mods = c.session.wireMods;
        render();
      },
      { priority: PRIO.ui, immediate: true },
    );
  }

  // Beginner mode off or another checkpoint: the demo and the ring go with the lesson
  lessonUi.subscribe(() => {
    if (lessonUi.get().lesson) return;
    exitPlay();
    if (selfStop) closeSelf();
  }, ["lesson"]);

  b.openDemo = open;
}
