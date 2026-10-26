// Course map (PLAN H-12, DESIGN_V2 §11.1): "≡ Lessons" in the lesson head opens a grid of all 12 lessons with their state.
// Data and state rules live in course.ts (node tests import it), live state in coursenav.tsx; this is the button and the dialog.
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { lessonUi } from "./lesson";
import { Icon } from "./icons";
import { COURSE, type CourseCard } from "./course";
import { courseCards, goLesson } from "./coursenav";

export { COURSE };

/** Top-bar "≡ Lessons" button (desktop lesson head and phone top bar, 44 px there). */
export function LessonMapBtn({ phone }: { phone?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
    <button
      type="button"
      id="lessonMapBtn"
      aria-haspopup="dialog"
      aria-label={t("Lesson map")}
      title={t("Lesson map")}
      onClick={() => setOpen(true)}
      className={cn(
        "flex flex-none cursor-pointer items-center justify-center gap-1.5 rounded-lg border-0 bg-transparent text-fg hover:bg-field",
        phone ? "size-11 rounded-[10px]" : "h-8 px-1.5 text-[13px]",
      )}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h16" />
      </svg>
      {!phone && <span className="max-[1500px]:sr-only">{t("Lessons")}</span>}
    </button>
    {open && createPortal(<LessonMap onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function go(c: CourseCard, close: () => void) {
  if (!c.lesson) return;
  if (lessonUi.get().lesson?.work === c.entry.work) close();
  goLesson(c.entry);
}

const badgeCls: Record<CourseCard["state"], string> = {
  done: "bg-ok-bg text-ok-ink",
  current: "bg-accent-bg text-accent-ink",
  ready: "bg-field text-fg",
  plan: "border border-dashed border-line text-muted",
};

function LessonMap({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [list] = useState(courseCards);
  const done = list.filter((c) => c.state === "done").length;
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLButtonElement>('[data-act="close"]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab" || !box.current) return;
      // Focus trap: wrap Tab / Shift+Tab inside the dialog
      const f = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.current.contains(document.activeElement))) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !box.current.contains(document.activeElement))) {
        e.preventDefault();
        first?.focus();
      }
    };
    addEventListener("keydown", key);
    return () => {
      removeEventListener("keydown", key);
      (document.getElementById("lessonMapBtn") ?? back)?.focus();
    };
  }, [onClose]);
  const badge = (c: CourseCard) =>
    c.state === "done"
      ? t("Done")
      : c.state === "current"
        ? t("In progress · {n}/{total}", { n: c.step, total: c.total })
        : c.state === "ready"
          ? t("Ready to start")
          : t("Planned");
  return (
    <div className="fixed inset-0 z-50 bg-[rgb(0_0_0/0.3)]" onClick={onClose}>
      <div
        ref={box}
        id="lessonMap"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lessonMapTitle"
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-0 flex flex-col gap-4 overflow-y-auto bg-bg p-4 text-[14px] text-fg md:inset-x-8 md:top-16 md:bottom-auto md:mx-auto md:max-h-[calc(100dvh-96px)] md:max-w-[1376px] md:gap-5 md:rounded-xl md:border md:border-line md:p-8 md:shadow-panel"
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 id="lessonMapTitle" className="m-0 text-[22px] font-bold">
              {t("Basics course")}
            </h2>
            <span className="text-muted">{t("From one board to a desk weather station, one new part per lesson")}</span>
          </div>
          <button type="button" data-act="close" aria-label={t("Close")} title={t("Close")} onClick={onClose} className="order-none flex size-9 flex-none cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-fg hover:bg-field max-md:size-11 md:order-last">
            <Icon n="x" size={18} />
          </button>
          <div id="lessonMapProgress" data-done={done} data-total={list.length} className="flex w-full flex-col gap-1.5 md:w-[320px]">
            <div className="flex flex-wrap justify-between gap-x-3 text-[13px]">
              <span>{t("{n} of {total} lessons done", { n: done, total: list.length })}</span>
              <span className="text-muted">{t("Done = this lesson's checkpoint passes")}</span>
            </div>
            <div className="h-2 rounded bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={list.length} aria-valuenow={done} aria-label={t("Lessons done")}>
              <div className="h-2 rounded bg-ok" style={{ width: `${Math.round((done / list.length) * 100)}%` }} />
            </div>
          </div>
          <div className="flex gap-3.5 text-[12px] text-muted max-md:hidden">
            <span className="flex items-center gap-1.5">
              <span className="size-3 rounded-[3px] border border-line bg-surface" />
              {t("Written")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-3 rounded-[3px] border border-dashed border-line" />
              {t("Planned")}
            </span>
          </div>
        </div>
        <ol className="m-0 grid list-none grid-cols-2 gap-3 p-0 md:grid-cols-6 md:gap-3.5">
          {list.map((c) => {
            const plan = c.state === "plan";
            return (
              <li key={c.entry.no} className="min-w-0">
                <button
                  type="button"
                  data-course={c.entry.no}
                  data-state={c.state}
                  disabled={plan}
                  aria-current={c.state === "current" && lessonUi.get().lesson === c.lesson ? "step" : undefined}
                  onClick={() => go(c, onClose)}
                  className={cn(
                    "flex h-full w-full min-w-0 flex-col gap-2.5 rounded-[14px] p-3 text-left text-fg",
                    plan ? "cursor-default border border-dashed border-line bg-transparent" : "cursor-pointer border border-line bg-surface hover:border-hover-line",
                    c.state === "current" && "border-2 border-accent-strong shadow-panel",
                  )}
                >
                  <span aria-hidden="true" className="flex h-[72px] items-center justify-center rounded-[10px] font-mono text-[16px] font-semibold tracking-wider text-white" style={{ background: c.entry.color, opacity: plan ? 0.55 : 1 }}>
                    {c.entry.tag}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[12px] text-muted">{t("Lesson {n}", { n: c.entry.no })}</span>
                    <b className="text-[15px] break-words">{c.lesson ? c.lesson.title : c.entry.title}</b>
                    <span className="text-[12px] text-muted">{c.entry.part}</span>
                  </span>
                  <span className={cn("mt-auto self-start rounded-md px-2 py-[3px] text-[12px]", badgeCls[c.state])}>{badge(c)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
