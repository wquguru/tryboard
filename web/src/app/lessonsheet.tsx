// Phone lesson panel (PLAN H-07, DESIGN_V2 §11, Mobile.dc.html): the dock's lower band while a lesson is up.
// Title + progress, the current step, a few highlighted code lines, the last two events, previous / next.
import { CourseDone, CourseTodo, useLessonDone } from "./coursenav";
import { COURSE, courseOf } from "./course";
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { useStore } from "./react";
import { lessonUi } from "./lesson";
import { schUi } from "./schematic/store";
import { chipLabel, chipText } from "./lessons";
import { ChipFace, evWhere, noFwFeed, fmtSec, lessonFeed, useLessonCode, useNoFwLesson } from "./lessonfeed";
import { LessonInfo, useSrcLines } from "./lessoninfo";
import { Icon } from "./icons";
import { StepDoneBar, TaskList, useStepReady } from "./lessontasklist";

/** Up to four rows around the highlighted lines (one line of context each side). */
function CodeSnip() {
  const code = useLessonCode();
  const src = useSrcLines(code?.fw, code?.file);
  if (!code || !src || !code.lines.length) return null;
  const hl = new Set(code.lines);
  const lo = Math.max(1, Math.min(...code.lines) - 1);
  const hi = Math.min(src.length, Math.max(...code.lines) + 1, lo + 3);
  const rows = [];
  for (let n = lo; n <= hi; n++) rows.push(n);
  return (
    <div id="lessonSnip" data-file={code.file} className="flex-none overflow-hidden rounded-[10px] border border-line py-1 font-mono text-[12px] leading-5">
      {rows.map((n) => (
        <div
          key={n}
          data-line={n}
          data-hl={hl.has(n) ? "" : undefined}
          className={cn("flex gap-2 pr-2", hl.has(n) && "bg-accent-bg shadow-[inset_3px_0_0_#0D99FF]")}
        >
          <span className="w-[26px] flex-none text-right text-muted tabular-nums">{n}</span>
          <span className="min-w-0 truncate whitespace-pre">{src[n - 1]}</span>
        </div>
      ))}
    </div>
  );
}

/** The two latest "What happened" rows, newest first. */
function LastEvents() {
  const { items } = useStore(lessonFeed);
  const noFw = useNoFwLesson();
  const last = items.slice(-2).reverse();
  return (
    <div id="lessonLast" role="log" aria-label={t("What happened")} data-count={items.length} className="flex flex-none flex-col gap-0.5 text-[12px]">
      {!last.length && <p className="m-0 text-muted">{noFw ? noFwFeed() : t("Nothing yet: pin changes show up here once the code runs.")}</p>}
      {last.map((e) => (
        <div key={e.n} data-ev={e.n} data-t={e.t} className="flex min-w-0 gap-2.5 leading-5">
          <span className="min-w-[52px] flex-none font-mono whitespace-nowrap text-muted tabular-nums">{fmtSec(e.t)}</span>
          <span className="min-w-0 truncate">
            <span className={cn("font-medium", e.hi ? "text-fg" : "text-muted")}>{e.text}</span>
            <span className="text-muted"> · {evWhere(e)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

const btn = "inline-flex min-h-12 cursor-pointer items-center justify-center rounded-[10px] px-3 text-[15px] leading-5";

/** The panel; `full` (sheet pulled up) adds the step's "Try it" list, `onOpen` draws a 44px pull-up button (the grab is 24px). */
export function LessonSheet({ full, onOpen }: { full?: boolean; onOpen?: () => void }) {
  const s = useStore(lessonUi);
  const ready = useStepReady();
  const done = useLessonDone();
  const view = useStore(schUi).view;
  const l = s.lesson;
  const entry = courseOf(l);
  if (!l) return null;
  const n = l.steps.length;
  // Past the last step but not done by the rule (H-30): the last step stays, with what is left
  const todo = !done && s.step >= n;
  // H-32: over the phone schematic the peek panel is a footer (title + Previous / Next), as SchematicPhone draws it
  const footer = !full && !done && view === "schematic";
  const shown = Math.min(s.step, n - 1);
  const cur = l.steps[shown];
  const at = Math.min(s.step + 1, n);
  // H-40: on the run step the footer gets the run button, Previous shrinks to an arrow to make room
  const footRun = footer && cur.id === "run";
  return (
    <section id="lessonSheet" aria-label={t("Lesson step")} data-step={done ? "done" : shown} data-todo={todo ? 1 : undefined} data-footer={footer ? "" : undefined} className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-3">
      <div id="lessonSheetHead" className="flex flex-none items-center gap-2.5">
        <span className="flex min-w-0 flex-1 flex-col">
          <b className="truncate text-[14px]">
            {entry ? t("Lesson {n} / {total} · {title}", { n: entry.no, total: COURSE.length, title: l.title }) : t("Lesson {n} · {title}", { n: l.no, title: l.title })}
          </b>
          <span className="mt-1 flex gap-[3px]" role="img" aria-label={t("Step progress {n}/{total}", { n: at, total: n })}>
            {l.steps.map((st, i) => (
              <span key={st.id} className={cn("h-[3px] w-[22px] rounded-sm", i <= shown ? "bg-accent-strong" : "bg-line")} />
            ))}
          </span>
          {footer && <span id="mLessonSum" className="mt-1 truncate text-[12px] leading-4 text-muted">{t("Step {n} · {title}", { n: shown + 1, title: cur.title })}</span>}
        </span>
        <span className="flex-none font-mono text-[12px] text-muted">{`${at}/${n}`}</span>
        {onOpen && (
          <button
            type="button"
            id="mLessonOpen"
            aria-label={t("Open the full lesson panel")}
            onClick={onOpen}
            className="-mr-1.5 inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-field p-0 text-fg"
          >
            <Icon n="up" size={16} />
          </button>
        )}
      </div>
      <div hidden={footer} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain [&[hidden]]:hidden">
        {done ? (
          <CourseDone phone />
        ) : (
          <>
            <span className="text-[11px] font-medium text-muted">{t("Step {n} · {title}", { n: shown + 1, title: cur.title })}</span>
            <p className="m-0 text-[14px] leading-[22px]">{cur.body}</p>
            {todo && <CourseTodo />}
            {full && (
              <>
                <TaskList tasks={cur.tasks} />
                {ready && <StepDoneBar />}
                <LessonInfo phone />
              </>
            )}
            {cur.id === "run" && (
              <button type="button" id="mLessonRun" className={cn(btn, "flex-none border border-accent-strong bg-surface font-medium text-accent-ink")} onClick={s.run}>
                {t("Run this lesson's code")}
              </button>
            )}
            {cur.codeChips && (
              <div id="mLessonChips" role="group" aria-label={chipLabel(cur.codeChips)} className="flex flex-none flex-wrap items-center gap-2">
                <span className="text-[12px] text-muted">{chipLabel(cur.codeChips)}</span>
                {cur.codeChips.values.map((v) => (
                  <button
                    key={v}
                    type="button"
                    data-chip={chipText(cur.codeChips!.key, v)}
                    aria-pressed={s.delay === v}
                    onClick={() => s.setDelay(v)}
                    className={cn(
                      "min-h-11 min-w-12 cursor-pointer rounded-lg border px-2 font-mono text-[14px]",
                      s.delay === v ? "border-accent-strong bg-accent-strong text-on-accent" : "border-line bg-surface text-fg",
                    )}
                  >
                    <ChipFace chips={cur.codeChips!} v={v} />
                  </button>
                ))}
              </div>
            )}
            <CodeSnip />
            <LastEvents />
          </>
        )}
      </div>
      {!done && (
      <div className="flex flex-none gap-2">
        <button
          type="button"
          id="mLessonPrev"
          aria-label={footRun ? t("Previous") : undefined}
          className={cn(btn, footRun ? "w-12 flex-none px-0" : "flex-1", "border border-line bg-surface text-fg disabled:cursor-default disabled:opacity-50")}
          disabled={s.step === 0}
          onClick={() => s.go(shown - 1)}
        >
          {footRun ? <Icon n="left" size={18} /> : t("Previous")}
        </button>
        {footRun && (
          <button type="button" id="mLessonRunFoot" className={cn(btn, "min-w-0 flex-1 border border-accent-strong bg-surface text-[14px] leading-[18px] font-medium text-accent-ink")} onClick={s.run}>
            <span className="line-clamp-2">{t("Run this lesson's code")}</span>
          </button>
        )}
        <button
          type="button"
          id="mLessonNext"
          data-ready={ready ? 1 : 0}
          disabled={todo}
          className={cn(
            btn,
            "min-w-0 font-medium",
            footRun ? "flex-1" : "flex-2",
            todo
              ? "cursor-default gap-1.5 border border-line bg-field text-muted"
              : ready
                ? "border-0 bg-accent-strong text-on-accent"
                : "border border-accent-strong bg-surface text-accent-ink",
          )}
          onClick={() => s.go(s.step + 1)}
        >
          {todo && <Icon n="lock" size={14} />}
          <span className="truncate">
          {todo
            ? t("Not done yet")
            : s.step === n - 1
              ? t("Finish lesson {n}", { n: l.no })
              : t("Next: {title}", { title: l.steps[s.step + 1].title })}
          </span>
        </button>
      </div>
      )}
    </section>
  );
}
