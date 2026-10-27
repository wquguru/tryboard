// "Try it" list (PLAN H-10, design Tasks.dc.html): waiting (blue ring + how + Take me there), just done (green + what
// was detected), think (tap to open the answer, which ticks it) and the whole step done (green bar). Desktop card + phone sheet.
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { useStore } from "./react";
import { Icon } from "./icons";
import { hitText, revealTask, stepReady, taskTarget, taskUi } from "./lessontasks";
import type { LessonTask } from "./lessons";

export function useStepReady() {
  return stepReady(useStore(taskUi));
}

export function TaskList({ tasks }: { tasks: LessonTask[] }) {
  const s = useStore(taskUi);
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {tasks.map((x, i) => {
        const hit = s.hits[i];
        const reveal = x.done === "reveal";
        const tg = !hit && taskTarget(x.done);
        const open = reveal && !!s.open[i];
        return (
          <li
            key={i}
            data-task={i}
            data-done={hit ? 1 : 0}
            data-kind={x.done.split(":")[0]}
            data-fresh={s.fresh === i ? "" : undefined}
            className={cn("flex flex-col gap-2 rounded-lg border px-2.5 py-2 text-[13px]", hit ? "border-ok bg-ok-bg" : "border-transparent bg-field")}
          >
            <div className="flex items-start gap-2.5">
              {reveal ? (
                <button
                  type="button"
                  data-reveal={i}
                  aria-expanded={open}
                  onClick={() => revealTask(i)}
                  className="flex min-h-11 flex-1 md:-my-1 md:min-h-9 cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0 text-left text-[13px] font-medium text-fg"
                >
                  <Mark done={!!hit} />
                  <span className="flex-1">{x.text}</span>
                  <span className="flex-none text-[12px] font-normal text-accent-ink">{open ? t("Hide answer") : t("Show answer")}</span>
                </button>
              ) : (
                <>
                  <Mark done={!!hit} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium">{x.text}</span>
                    {hit ? (
                      <span data-detected className="text-[12px] text-ok-ink">{hitText(x.done, hit)}</span>
                    ) : s.asmWarn && x.done === "asm:done" ? (
                      <span data-warn className="text-[12px] text-warn-ink">{t("There are warnings: move the parts as the Assemble step suggests; it ticks once none are left")}</span>
                    ) : (
                      x.how && <span className="text-[12px] text-muted">{x.how}</span>
                    )}
                  </span>
                  {tg && (
                    <button
                      type="button"
                      data-goto={i}
                      onClick={() => s.goTo(tg)}
                      className="min-h-11 flex-none cursor-pointer self-center md:min-h-9 rounded-lg border border-accent-line bg-accent-bg px-2.5 text-[13px] text-accent-ink"
                    >
                      {t("Take me there")}
                    </button>
                  )}
                </>
              )}
            </div>
            {open && x.answer && <p data-answer className="m-0 rounded-md bg-surface px-3 py-2 leading-6">{x.answer}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function Mark({ done }: { done: boolean }) {
  return done ? (
    <span aria-label={t("Done")} className="mt-px inline-flex size-[18px] flex-none items-center justify-center rounded-full bg-ok text-surface">
      <Icon n="check" size={12} />
    </span>
  ) : (
    <span aria-hidden="true" className="mt-px size-[18px] flex-none rounded-full border-2 border-accent-strong" />
  );
}

/** Green bar above the buttons once every task of the step is ticked. */
export function StepDoneBar() {
  return (
    <div id="lessonStepDone" role="status" className="flex items-center gap-2 rounded-lg bg-ok-bg px-3 py-2 text-[13px] text-ok-ink">
      <Icon n="check" size={14} />
      {t("This step is done.")}
    </div>
  );
}
