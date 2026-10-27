// Course navigation (PLAN H-15, design-v2/beginner/v3/Main.dc.html): course-ordered prev / next, the 12-lesson bar,
// and the "Lesson n done" panel with the next lesson card (plus the cross-work notice when it lives in another work).
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { useStore } from "./react";
import { lessonUi } from "./lesson";
import { lessonStep } from "../beginner";
import { loadProgress } from "./bench/progress";
import { stepHits, taskUi } from "./lessontasks";
import { actions, bc } from "./chrome";
import { Icon } from "./icons";
import { WORKS } from "./works";
import { COURSE, courseCard, courseLesson, courseOf, courseStep, lessonKey, type CourseCard, type CourseEntry } from "./course";

/** Every entry's card (map state); the open work's checkpoints are live, other works read their stored passes. */
export function courseCards(): CourseCard[] {
  const ui = lessonUi.get();
  const open = ui.lesson ? { work: ui.lesson.work, cp: ui.lesson.checkpoint, step: ui.step } : null;
  const live = new Set(bc.get().checkpoints.filter((c) => c.state === "ok" || c.state === "ref").map((c) => c.id));
  const stored: Record<string, Record<string, unknown>> = {};
  const passed = (work: string, cp: string) => (open?.work === work ? live.has(cp) : !!(stored[work] ??= loadProgress(work))[cp]);
  return COURSE.map((e) => courseCard(e, passed, lessonStep, open, stepHits));
}

/** Open lesson `e`: same work switches checkpoint in place, another work reloads the lab (fresh lesson state there). */
export function goLesson(e: CourseEntry) {
  if (!courseLesson(e)) return;
  if (lessonUi.get().lesson?.work === e.work && e.cp) return actions.selectCheckpoint?.(e.cp);
  // A lesson with no checkpoint (lesson 0) is named by its key in the URL; bench/left.tsx pins it on load
  location.href = `/app?work=${encodeURIComponent(e.work)}&cp=${encodeURIComponent(lessonKey(e))}#bench`;
}

/** Keep `?cp=` on the open course lesson: same-work switches happen in place, so reload and browser back would land on the old one. */
export function syncCourseUrl() {
  lessonUi.subscribe(
    ({ lesson }) => {
      const e = courseOf(lesson);
      const q = new URLSearchParams(location.search);
      if (!e || q.get('work') !== e.work || q.get('cp') === lessonKey(e)) return;
      q.set('cp', lessonKey(e));
      history.replaceState(history.state, '', `${location.pathname}?${q}${location.hash}`);
    },
    ['lesson'],
  );
}

/** The open lesson's course entry and the per-lesson cards, re-read whenever steps, passes or ticks change. */
export function useCourse() {
  const ui = useStore(lessonUi);
  useStore(bc);
  useStore(taskUi);
  const entry = courseOf(ui.lesson);
  return { entry, cards: courseCards() };
}

const navBtn = "inline-flex h-8 flex-none cursor-pointer items-center gap-1 rounded-lg border px-2.5 text-[13px] whitespace-nowrap disabled:cursor-default disabled:opacity-50";

/** Top bar: "Basics / Lesson n / 12 · title", one bar per lesson, ‹ previous / next › written lesson. */
export function CourseHead() {
  const { entry, cards } = useCourse();
  const l = lessonUi.get().lesson;
  if (!l) return null;
  if (!entry) return <span className="truncate text-[14px] font-bold">{t("Lesson {n} · {title}", { n: l.no, title: l.title })}</span>;
  const prev = courseStep(entry.no, -1);
  const next = courseStep(entry.no, 1);
  const done = cards.filter((c) => c.state === "done").length;
  const prevLabel = prev ? t("‹ Lesson {n}", { n: prev.no }) : t("‹ Previous lesson");
  const nextLabel = next ? t("Lesson {n} ›", { n: next.no }) : t("Next lesson ›");
  return (
    <>
      {/* Title over the 12-lesson bar so neither squeezes the other out of a crowded top bar */}
      <span className="flex min-w-0 flex-1 flex-col gap-1 text-[14px] leading-5">
        <span className="truncate">
          <span className="text-muted max-[2200px]:hidden">{t("Basics course")} / </span>
          <b>{t("Lesson {n} / {total} · {title}", { n: entry.no, total: COURSE.length, title: l.title })}</b>
        </span>
        <span id="courseBar" className="flex gap-[3px]" role="img" data-done={done} aria-label={t("{n} of {total} lessons done", { n: done, total: COURSE.length })}>
          {cards.map((c) => (
            <span
              key={c.entry.no}
              data-course-dot={c.entry.no}
              data-state={c.entry === entry ? "now" : c.state}
              className={cn("h-1 w-3 rounded-[2px]", c.state === "done" ? "bg-ok" : c.entry === entry ? "bg-accent-strong" : "bg-line")}
            />
          ))}
        </span>
      </span>
      <button
        type="button"
        id="coursePrev"
        data-course={prev?.no}
        disabled={!prev}
        aria-label={prevLabel}
        title={prevLabel}
        onClick={() => prev && goLesson(prev)}
        className={cn(navBtn, "border-line bg-surface text-fg hover:bg-field")}
      >
        <Icon n="left" size={14} />
        <span className="max-[2000px]:hidden">{prevLabel.replace(/^‹\s*/, "")}</span>
      </button>
      <button
        type="button"
        id="courseNext"
        data-course={next?.no}
        disabled={!next}
        aria-label={nextLabel}
        title={next ? nextLabel : t("The next lessons are still being written")}
        onClick={() => next && goLesson(next)}
        className={cn(navBtn, "border-accent-strong bg-accent-bg font-medium text-accent-ink")}
      >
        <span className="max-[2000px]:hidden">{nextLabel.replace(/\s*›$/, "")}</span>
        <Icon n="right" size={14} />
      </button>
    </>
  );
}

/** "✓ Checkpoint passed": done by ticks alone has no badge, a passing checkpoint adds this one (H-20). */
export function CpBadge() {
  return (
    <span data-cp-passed="1" className="inline-flex items-center gap-1 rounded-md bg-ok px-2 py-[3px] text-[12px] font-medium text-surface">
      <Icon n="check" size={12} />
      {t("Checkpoint passed")}
    </span>
  );
}

const bigBtn = "inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-[10px] px-3 text-center";

/** Right panel (and phone sheet) once the steps are finished: "Lesson n done", the next lesson, the cross-work notice, start / stay. */
export function CourseDone({ phone }: { phone?: boolean }) {
  const s = useStore(lessonUi);
  const { entry, cards } = useCourse();
  const l = s.lesson;
  if (!l || !entry) return null;
  // Same judgment as the map and the top bar (courseCard), so the ✓ never disagrees between them
  const card = cards.find((c) => c.entry === entry);
  const cp = bc.get().checkpoints.find((c) => c.id === entry.cp);
  const passed = !!card?.cpPassed && !!cp;
  // Next written lesson; while none is written yet, preview the next planned one (its start button stays off)
  const next = courseStep(entry.no, 1) ?? COURSE[entry.no + 1] ?? null;
  const nl = next && courseLesson(next);
  const away = !!next && next.work !== l.work;
  const work = next && WORKS[next.work];
  const ci = next?.cp && work ? work.checkpoints.indexOf(next.cp) : -1;
  return (
    <div id="courseDone" data-next={next?.no} data-away={away ? 1 : 0} data-state={card?.state} className="flex flex-col gap-3.5">
      <div className="flex items-center gap-3">
        <span className="flex size-10 flex-none items-center justify-center rounded-full bg-ok-bg text-ok-ink">
          <Icon n="check" size={20} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <b className={phone ? "text-[17px]" : "text-[20px] leading-7"}>{t("Lesson {n} done", { n: entry.no })}</b>
          <span className="text-[13px] text-muted">
            {passed
              ? t("Checkpoint {id} {title} passed · Basics {n} / {total}", { id: cp.id, title: cp.title, n: entry.no, total: COURSE.length })
              : t("Basics {n} / {total}", { n: entry.no, total: COURSE.length })}
          </span>
          {passed && (
            <span className="mt-1 flex">
              <CpBadge />
            </span>
          )}
        </span>
      </div>
      {next && (
        <>
          <div className="h-px bg-line" />
          <span className="text-[12px] text-muted">{t("Next lesson")}</span>
          <div id="courseNextCard" data-course={next.no} data-written={nl ? 1 : 0} className={cn("flex gap-3.5 rounded-xl p-3.5", nl ? "border-2 border-accent-strong shadow-panel" : "border border-dashed border-line")}>
            <span aria-hidden="true" className="flex h-[72px] w-[84px] flex-none items-center justify-center rounded-[10px] font-mono text-[16px] font-semibold tracking-wider text-white" style={{ background: next.color, opacity: nl ? 1 : 0.55 }}>
              {next.tag}
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-[12px] text-muted">{t("Lesson {n}", { n: next.no })}</span>
              <b className="text-[17px] break-words">{nl ? nl.title : next.title}</b>
              <span className="line-clamp-2 text-[13px] text-fg">{nl ? nl.summary : next.part}</span>
            </span>
          </div>
          {away && (
            <div id="courseAway" className="flex flex-col gap-2.5 rounded-xl border border-(--warn-line) bg-warn-bg p-3.5">
              <span className="flex items-center gap-2 text-warn-ink">
                <Icon n="right" size={18} />
                <b>{t("This lesson lives in another work")}</b>
              </span>
              <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1.5 text-[13px]">
                <span className="text-muted">{t("Switch to")}</span>
                <span data-row="work">{ci >= 0 ? t("{work} · checkpoint {n}", { work: work!.title, n: ci + 1 }) : (work?.title ?? next.work)}</span>
                <span className="text-muted">{t("Bench")}</span>
                <span data-row="bench">{next.bench}</span>
                <span className="text-muted">{t("Firmware")}</span>
                <span data-row="fw">{next.noFw ? t("None: this lesson runs no code") : t("Switches to lesson {n}'s built-in firmware", { n: next.no })}</span>
              </div>
              <span className="text-[13px] text-muted">{t("Lesson {n}'s wiring and progress are saved; come back any time from the lesson map.", { n: entry.no })}</span>
            </div>
          )}
        </>
      )}
      <div className="flex flex-col gap-2">
        {next && (
          <button
            type="button"
            id="courseStart"
            disabled={!nl}
            onClick={() => goLesson(next)}
            className={cn(bigBtn, "border-0 bg-accent-strong font-bold text-on-accent disabled:cursor-default disabled:opacity-50", phone ? "text-[15px]" : "min-h-12 text-[16px]")}
          >
            {nl ? t("Start lesson {n} →", { n: next.no }) : t("Lesson {n} is still being written", { n: next.no })}
          </button>
        )}
        <button type="button" id="courseStay" onClick={() => s.go(0)} className={cn(bigBtn, "border border-line bg-surface text-[14px] text-fg hover:bg-field")}>
          {t("Stay on lesson {n} and go over it again", { n: entry.no })}
        </button>
      </div>
    </div>
  );
}

