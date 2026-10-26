// Bench section: beginner mode (PLAN H-01). Picks the lesson for the current checkpoint and keeps `lessonUi` in step.
// Off or no lesson here: the store is cleared and the bench draws exactly what it drew before (phones: H-07 sheet).
import { t } from "../../i18n";
import { type ReactNode } from "react";
import { type Level } from "../../checks";
import { fetchBuf } from "../../assets";
import { beginnerOn, lessonStep, setLessonStep } from "../../beginner";
import { setDock, actions, bc, overlay } from "../chrome";
import { afterFrame } from "../../ui/frame";
import { LessonCallouts } from "../lessoncallouts";
import { isPhone, setMui } from "../mobile";
import { lessonFor } from "../lessons";
import { LessonSteps, lessonUi, setLessonUi } from "../lesson";
import { bindLessonFeed } from "../lessonfeed";
import { lessonSignal, setTaskStep, stripSignals, taskUi } from "../lessontasks";
import type { BenchCtx } from "./ctx";
import { lessonWires, partId } from "../wiring";
import { ledColor } from "../../bench3d/ledparams";

export function mountLesson(b: BenchCtx) {
  // H-10: ticks follow the shown step; run / Show current are states, so they are probed on every change too
  let unsub: (() => void)[] = [];
  function probe() {
    const c = b.ctx;
    const lesson = lessonUi.get().lesson;
    setTaskStep(lesson, lessonUi.get().step);
    if (!c || !lesson) return;
    const fws = [lesson.fw, ...lesson.steps.flatMap((x) => Object.values(x.codeChips?.fw ?? {}))];
    if (c.store.get().running && fws.some((f) => c.session.fwName === `${f}/flash.bin`)) {
      lessonSignal("run");
      // Strip frames arrive as edges; a step opened after the strip lit up still sees the last frame
      stripSignals(c.session.frame.strips, c.session.fwName);
    }
    if (b.flowOn()) lessonSignal("view:current");
  }
  setLessonUi({
    showWire: (id) => {
      const ses = b.ctx?.session;
      setLessonUi({ wireSel: id });
      ses?.bench.viewTo?.({ kind: "wire", id }, 600);
      ses?.pick.highlight?.({ kind: "wire", id });
      // Phones: drop the full-screen panel so the lit wire is visible
      if (isPhone()) setMui({ sheet: "peek" });
    },
  });
  taskUi.set({
    goTo: (tg) => {
      b.ctx?.session.bench.viewTo?.(tg, 600);
      b.ctx?.session.pick.highlight?.(tg);
    },
  });
  function bindTasks(on: boolean) {
    unsub.forEach((f) => f());
    unsub = [];
    if (!on || !b.ctx) return setTaskStep(null, 0);
    unsub = [b.ctx.store.subscribe(probe, ["running", "run"]), lessonUi.subscribe(probe, ["lesson", "step"])];
    probe();
  }
  /** The left-column lesson card for checkpoint `id`, or null (store cleared) when the normal card should show. */
  function lessonCard(id: string | null, l: Level | undefined): ReactNode | null {
    const c = b.ctx!;
    const lesson = id && !c.custom && beginnerOn() ? lessonFor(c.work.id, id) : null;
    const had = !!lessonUi.get().lesson;
    if (!lesson || !l) {
      if (had) {
        setLessonUi({ lesson: null });
        bindTasks(false);
        b.setToolGroups(c);
        bindLessonFeed(c.session, null);
        if (bc.get().dock.tab === "lesson") setDock({ tab: "serial" });
      }
      delete document.body.dataset.lesson;
      c.session.setBenchParts(null);
      if (bc.get().overlays.lessonCallouts) overlay("lessonCallouts", null);
      return null;
    }
    // H-15: another lesson in the same work starts on the overview tab with no wire lit (H-14 kept the old one)
    if (had && lessonUi.get().lesson !== lesson) {
      if (lessonUi.get().wireSel) c.session.pick.highlight?.(null);
      setLessonUi({ wireSel: null, info: "overview" });
    }
    const n = lesson.steps.length;
    const ids = c.work.checkpoints;
    const nextId = ids[ids.indexOf(lesson.checkpoint) + 1];
    const nl = nextId ? c.session.levels.find((x) => x.id === nextId) : undefined;
    const work = c.work.id;
    const load = (fw: string) =>
      void fetchBuf(`./fw/${fw}/flash.bin`).then((buf) => {
        actions.releaseBin?.();
        c.session.loadFirmware(buf, `${fw}/flash.bin`);
        c.shell.toast(t("Running this lesson's code ({fw})", { fw }));
      });
    setLessonUi({
      lesson,
      step: Math.max(0, Math.min(n, lessonStep(work, lesson.checkpoint))),
      cpPass: l.pass ? t(l.pass) : "",
      next: nl ? t("Next: checkpoint {id} · {title}", { id: nl.id, title: t(nl.title) }) : "",
      go: (i) => {
        const s = Math.max(0, Math.min(n, i));
        setLessonStep(work, lesson.checkpoint, s);
        setLessonUi({ step: s });
        if (s === n) c.shell.toast(t("Lesson {n} done: {title}", { n: lesson.no, title: lesson.title }));
      },
      run: () => {
        setLessonUi({ delay: lesson.steps.find((x) => x.codeChips)?.codeChips?.current ?? 500 });
        load(lesson.fw);
      },
      delay: lessonUi.get().delay,
      setDelay: (ms) => {
        const fw = lesson.steps.find((x) => x.codeChips)?.codeChips?.fw[ms];
        if (!fw) return;
        const from = lessonUi.get().delay;
        setLessonUi({ delay: ms });
        lessonSignal(`chip:delay=${ms}`, String(from));
        load(fw);
      },
      openChecks: () => setDock({ tab: "checks", collapsed: false }),
      showDemo: (i) => b.openDemo(i),
    });
    // H-14: this lesson's wiring rows (bench view, rewires included) and the bench LED for the info tabs
    const ses = c.session;
    const wires = lessonWires(ses.scene.parts, lesson.parts ?? null, !!ses.power?.ext5v, ses.wireMods);
    const lp = ses.scene.parts.find((p) => p.type === "led" && (!lesson.parts || lesson.parts.includes(partId(p))));
    const led = lp?.type === "led" ? { ohm: wires.find((w) => w.part === partId(lp) && w.ohm !== undefined)?.ohm ?? 220, color: ledColor(lp.color) } : null;
    const prev = lessonUi.get();
    if (JSON.stringify([prev.wires, prev.led]) !== JSON.stringify([wires, led])) setLessonUi({ wires, led });
    // The left card is drawn after the bench's first toolbar pass, so the short toolbar follows from here
    if (!had) b.setToolGroups(c);
    if (!had) bindTasks(true);
    // H-03: the dock opens on "What happened" whenever a lesson comes up (the serial log is one click away)
    bindLessonFeed(c.session, lesson);
    if (!had) setDock({ tab: "lesson" });
    // H-07: on phones the dock's peek band becomes the step panel (lab.css sizes it from body[data-lesson])
    document.body.dataset.lesson = lesson.checkpoint;
    // H-09: the bench shows only this lesson's parts (no-op when the drawn set is unchanged)
    c.session.setBenchParts(lesson.parts ?? null);
    if (!had && isPhone()) {
      setMui({ sheet: "peek" });
      // The stage just shrank to the top band: frame the board so the lesson's parts aren't specks
      afterFrame(() => {
        const v = c.session.bench.view;
        v?.("fit", { kind: "part", id: "board" });
        for (let i = 0; i < 3; i++) v?.("out");
      });
    }
    // H-02 callouts live in the stage overlays; they follow lessonUi themselves
    if (!bc.get().overlays.lessonCallouts) overlay("lessonCallouts", <LessonCallouts b={b} />);
    return <LessonSteps />;
  }

  /** The short beginner toolbar shows while a lesson is up; phones keep their own five-button bar (H-07). */
  b.lessonTools = () => !!lessonUi.get().lesson && !isPhone();
  b.lessonCard = lessonCard;
}
