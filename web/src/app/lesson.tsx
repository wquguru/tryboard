// Beginner mode UI (PLAN H-01, DESIGN_V2 §11): lesson steps (left), step card (right panel head), lesson title + progress (top bar).
// The bench fills `lessonUi`; these views only read it, so H-02..H-05 hang off the same store and selectors.
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { commit, useStore } from "./react";
import { createStore } from "./store";
import { Icon } from "./icons";
import { usePhone } from "./mobile";
import { beginnerOn, onBeginner, setBeginner } from "../beginner";
import { useEffect, useState } from "react";
import type { Lesson } from "./lessons";
import type { BenchWire } from "./wiring";
import type { LedColor } from "../bench3d/ledparams";
import { LessonInfo } from "./lessoninfo";
import { LessonMapBtn } from "./lessonmap";
import { StepDoneBar, TaskList, useStepReady } from "./lessontasklist";

export interface LessonUi {
  lesson: Lesson | null;
  /** 0-based current step; `steps.length` means the lesson is finished. */
  step: number;
  /** The checkpoint's pass criteria (folded under the plain-words title). */
  cpPass: string;
  /** The checkpoint after this one ("Next: 02 · Button"), empty on the last. */
  next: string;
  go: (i: number) => void;
  /** Load the lesson's built-in firmware into the bench and run it. */
  run: () => void;
  /** H-06: chosen delay (ms) of the prebuilt blink variants; `setDelay` loads that firmware and runs it. */
  delay: number;
  setDelay: (ms: number) => void;
  openChecks: () => void;
  /** H-05: "Show me how" playing over the bench, or the "wire it yourself" ring; other overlays step aside. */
  demo: "play" | "self" | null;
  /** Open the demo of step `i` (only steps with `demo` beats). */
  showDemo: (i: number) => void;
  /** H-14 info tabs: the open tab, this lesson's wiring rows (bench view), the bench LED, and "light up this wire". */
  info: InfoTab;
  wires: BenchWire[];
  led: { ohm: number; color: LedColor } | null;
  wireSel: string | null;
  showWire: (id: string) => void;
}
export type InfoTab = "overview" | "wiring" | "code" | "params";
const noop = () => {};
export const lessonUi = createStore<LessonUi>({
  lesson: null,
  step: 0,
  cpPass: "",
  next: "",
  go: noop,
  run: noop,
  delay: 500,
  setDelay: noop,
  openChecks: noop,
  demo: null,
  showDemo: noop,
  info: "overview",
  wires: [],
  led: null,
  wireSel: null,
  showWire: noop,
});
export const setLessonUi = (p: Partial<LessonUi>) => commit(() => lessonUi.set(p));

const dotCls = "inline-flex size-[22px] flex-none items-center justify-center rounded-full font-mono text-[12px]";

/** Left column card: this lesson's steps (done green, current blue, later grey) and the checkpoint in plain words. */
export function LessonSteps() {
  const s = useStore(lessonUi);
  const l = s.lesson;
  if (!l) return null;
  // "Show me how" plays the current step's demo, else the first step that has one (#cpGo keeps the checkpoint card's id)
  const demoAt = l.steps[s.step]?.demo?.length ? s.step : l.steps.findIndex((x) => x.demo?.length);
  return (
    <nav id="lessonSteps" aria-label={t("Lesson steps")} className="flex flex-col gap-0.5 text-xs">
      <div className="px-1 pb-1 text-[11px] font-medium text-muted">
        {t("{n} steps · about {min} min", { n: l.steps.length, min: l.minutes })}
      </div>
      {l.steps.map((st, i) => {
        const state = i < s.step ? "done" : i === s.step ? "now" : "todo";
        return (
          <button
            key={st.id}
            type="button"
            data-step={i}
            data-state={state}
            aria-current={state === "now" ? "step" : undefined}
            onClick={() => s.go(i)}
            className={cn(
              "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left text-fg hover:bg-field",
              state === "now" && "bg-accent-bg hover:bg-accent-bg",
            )}
          >
            <span
              className={cn(
                dotCls,
                state === "done" && "bg-ok-bg text-ok-ink",
                state === "now" && "bg-accent-strong text-on-accent",
                state === "todo" && "bg-field text-muted",
              )}
            >
              {state === "done" ? <Icon n="check" size={13} /> : i + 1}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium">{st.title}</span>
              <span className="text-[12px] leading-4 text-muted">{st.sub}</span>
            </span>
          </button>
        );
      })}
      <div id="lessonCp" className="mt-1.5 rounded-lg bg-field p-2.5">
        <div className="text-[11px] font-medium text-muted">{t("Checkpoint {id}", { id: l.checkpoint })}</div>
        <b className="mt-0.5 block text-[13px]">{l.title}</b>
        <p className="mt-0.5 mb-0">{l.summary}</p>
        <details className="mt-1">
          <summary className="cursor-pointer text-[12px] text-accent-ink">{t("Pass criteria")}</summary>
          <p className="mt-1 mb-0 text-muted">{s.cpPass}</p>
        </details>
        <p className="mt-1.5 mb-0 text-[12px] text-muted">{t("Parts for this lesson: {parts}", { parts: l.buy })}</p>
        {s.next && <p className="mt-0.5 mb-0 text-[12px] text-muted">{s.next}</p>}
        <button type="button" className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-[12px] text-accent-ink underline" onClick={s.openChecks}>
          {t("All checkpoints")}
        </button>
        {demoAt >= 0 && (
          <button type="button" id="cpGo" className={cn(btnBase, "mt-2 w-full border border-accent-strong bg-surface font-medium text-accent-ink hover:bg-accent-bg")} onClick={() => s.showDemo(demoAt)}>
            {t("Show me how")}
          </button>
        )}
      </div>
    </nav>
  );
}

const btnBase = "inline-flex h-11 cursor-pointer items-center justify-center rounded-lg px-3 text-[14px]";

/** Right panel head: the current step in three sentences, things to try, previous / next. */
export function LessonCard({ step }: { step: string }) {
  const s = useStore(lessonUi);
  const phone = usePhone();
  const ready = useStepReady();
  const l = s.lesson;
  if (!l || phone || step !== "bench") return null;
  const n = l.steps.length;
  const done = s.step >= n;
  const cur = l.steps[Math.min(s.step, n - 1)];
  return (
    <section id="lessonCard" aria-label={t("Lesson step")} data-step={done ? "done" : s.step} className="-mx-4 mb-3 flex flex-col gap-3 border-b border-line bg-surface px-4 pt-3 pb-4">
      <LessonInfo />
      {done ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-ok-ink">{t("Lesson {n} done", { n: l.no })}</span>
          <h2 className="m-0 text-[20px] leading-7">{l.title}</h2>
          <p className="m-0 text-[14px] leading-[22px]">{l.summary}</p>
          {s.next && <p className="m-0 text-[13px] text-muted">{s.next}</p>}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted">{t("Step {n} of {total}", { n: s.step + 1, total: n })}</span>
            <h2 className="m-0 text-[20px] leading-7">{cur.title}</h2>
            <p className="m-0 text-[14px] leading-[22px]">{cur.body}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted">{t("Try it")}</span>
            <TaskList tasks={cur.tasks} />
          </div>
          {!!cur.demo?.length && (
            <button type="button" id="lessonDemoBtn" className={cn(btnBase, "border border-accent-strong bg-surface font-medium text-accent-ink hover:bg-accent-bg")} onClick={() => s.showDemo(s.step)}>
              {t("Show me how")}
            </button>
          )}
          {cur.id === "run" && (
            <button type="button" id="lessonRun" className={cn(btnBase, "border border-accent-strong bg-surface font-medium text-accent-ink hover:bg-accent-bg")} onClick={s.run}>
              {t("Run this lesson's code")}
            </button>
          )}
        </>
      )}
      {!done && ready && <StepDoneBar />}
      <div className="flex gap-2">
        <button type="button" id="lessonPrev" className={cn(btnBase, "flex-1 border border-line bg-surface text-fg hover:bg-field disabled:cursor-default disabled:opacity-50")} disabled={s.step === 0} onClick={() => s.go(s.step - 1)}>
          {t("Previous")}
        </button>
        {done ? (
          <button type="button" id="lessonNext" className={cn(btnBase, "flex-2 border-0 bg-accent-strong font-medium text-on-accent")} onClick={() => s.go(0)}>
            {t("Start over")}
          </button>
        ) : (
          <button
            type="button"
            id="lessonNext"
            data-ready={ready ? 1 : 0}
            className={cn(btnBase, "flex-2 font-medium", ready ? "border-0 bg-accent-strong text-on-accent shadow-[0_0_0_4px_var(--color-accent-bg)]" : "border border-accent-strong bg-surface text-accent-ink hover:bg-accent-bg")}
            onClick={() => s.go(s.step + 1)}
          >
            {s.step === n - 1 ? t("Finish lesson {n}", { n: l.no }) : ready ? t("Next step") : t("Skip, next step")}
          </button>
        )}
      </div>
    </section>
  );
}

/** Top bar: "≡ Lessons" (H-12 map) + "Lesson 1 · Light up an LED" + one bar per step + n/5. */
export function LessonHead() {
  const s = useStore(lessonUi);
  const l = s.lesson;
  if (!l) return null;
  const n = l.steps.length;
  return (
    <div id="lessonTitle" className="flex min-w-0 items-center gap-2.5 px-2">
      <LessonMapBtn />
      <span className="truncate text-[14px] font-bold">{t("Lesson {n} · {title}", { n: l.no, title: l.title })}</span>
      <span className="flex flex-none gap-1" role="img" aria-label={t("Step progress {n}/{total}", { n: Math.min(s.step + 1, n), total: n })}>
        {l.steps.map((st, i) => (
          <span key={st.id} className={cn("h-1 w-3 rounded-sm", i <= s.step ? "bg-accent-strong" : "bg-line")} />
        ))}
      </span>
      <span className="flex-none font-mono text-[12px] text-muted">{`${Math.min(s.step + 1, n)}/${n}`}</span>
    </div>
  );
}

export function useBeginner() {
  const [on, set] = useState(beginnerOn);
  useEffect(() => onBeginner(set), []);
  return on;
}

/** Top bar switch, shown for every work: off brings the full bench back. */
export function BeginnerSwitch() {
  const on = useBeginner();
  return (
    <button
      type="button"
      id="beginnerBtn"
      role="switch"
      aria-checked={on}
      title={on ? t("Beginner mode: on (click for the full bench)") : t("Beginner mode: off (click for lesson steps)")}
      onClick={() => setBeginner(!on)}
      className="flex h-8 flex-none cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 text-[13px] text-fg hover:bg-field max-[1500px]:px-0.5"
    >
      <span aria-hidden="true" className={cn("relative inline-block h-5 w-[34px] rounded-full transition-colors", on ? "bg-accent-strong" : "bg-line")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white transition-[left]", on ? "left-4" : "left-0.5")} />
      </span>
      <span className="max-[1500px]:sr-only">{t("Beginner mode")}</span>
    </button>
  );
}
