// Bench section: beginner mode (PLAN H-01). Picks the lesson for the current checkpoint and keeps `lessonUi` in step.
// Off, phone (H-07), or no lesson here: the store is cleared and the bench draws exactly what it drew before.
import { t } from "../../i18n";
import { type ReactNode } from "react";
import { type Level } from "../../checks";
import { fetchBuf } from "../../assets";
import { beginnerOn, lessonStep, setLessonStep } from "../../beginner";
import { setDock, actions, bc, overlay } from "../chrome";
import { LessonCallouts } from "../lessoncallouts";
import { isPhone } from "../mobile";
import { lessonFor } from "../lessons";
import { LessonSteps, lessonUi, setLessonUi } from "../lesson";
import { bindLessonFeed } from "../lessonfeed";
import type { BenchCtx } from "./ctx";

export function mountLesson(b: BenchCtx) {
  /** The left-column lesson card for checkpoint `id`, or null (store cleared) when the normal card should show. */
  function lessonCard(id: string | null, l: Level | undefined): ReactNode | null {
    const c = b.ctx!;
    const lesson = id && !c.custom && beginnerOn() && !isPhone() ? lessonFor(c.work.id, id) : null;
    const had = !!lessonUi.get().lesson;
    if (!lesson || !l) {
      if (had) {
        setLessonUi({ lesson: null });
        b.setToolGroups(c);
        bindLessonFeed(c.session, null);
        if (bc.get().dock.tab === "lesson") setDock({ tab: "serial" });
      }
      if (bc.get().overlays.lessonCallouts) overlay("lessonCallouts", null);
      return null;
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
        setLessonUi({ delay: ms });
        load(fw);
      },
      openChecks: () => setDock({ tab: "checks", collapsed: false }),
      showDemo: (i) => b.openDemo(i),
    });
    // The left card is drawn after the bench's first toolbar pass, so the short toolbar follows from here
    if (!had) b.setToolGroups(c);
    // H-03: the dock opens on "What happened" whenever a lesson comes up (the serial log is one click away)
    bindLessonFeed(c.session, lesson);
    if (!had) setDock({ tab: "lesson" });
    // H-02 callouts live in the stage overlays; they follow lessonUi themselves
    if (!bc.get().overlays.lessonCallouts) overlay("lessonCallouts", <LessonCallouts b={b} />);
    return <LessonSteps />;
  }

  /** The short beginner toolbar shows while a lesson is up; lessons are desktop only until H-07. */
  b.lessonTools = () => !!lessonUi.get().lesson;
  b.lessonCard = lessonCard;
}
