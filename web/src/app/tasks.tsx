// Dock "Tasks" tab (C-04, docs/design-v2/compete/Tasks.dc.html): per-core lanes of running / waiting / idle, last-second CPU use,
// Perfetto export; app.elf is optional, only to name resume PCs. Mounted only while open, redraws at <= 4 Hz.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cn } from "../ui/cn";
import { Icon } from "./icons";
import { t } from "../i18n";
import { CPU_HZ, ST, elfFuncs, taskStore, type Slice } from "./tasktrace";

const COLORS = ["#0b76c8", "#7c5cd6", "#14ae5c", "#d9922b", "#d6487e", "#2a9bb0"];
const WAIT_BG =
  "repeating-linear-gradient(45deg, #fdf4e3 0 4px, #f0c98a 4px 8px)";
const WINDOWS: [number, string][] = [
  [0.05, "50 ms"],
  [0.2, "200 ms"],
  [1, "1 s"],
  [5, "5 s"],
];
const isIdle = (n: string) => /^IDLE\d?$/.test(n);
const ms = (cyc: number) => (cyc * 1000) / CPU_HZ;

/** The version bumps on every event; throttle to 250 ms so a running sim redraws at 4 Hz */
function useTaskVersion() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
  const v = useSyncExternalStore(
    (cb) => taskStore.subscribe(cb),
    () => taskStore.version,
  );
  return `${v}:${tick}:${taskStore.now}`;
}

interface Sel {
  task: number;
  core: number;
  kind: "run" | "wait";
  t0: number;
  t1: number;
  pc: number;
}

export function TasksPane({
  phone,
  toast,
}: {
  phone?: boolean;
  toast: (t: string) => void;
}) {
  const ver = useTaskVersion();
  const [win, setWin] = useState(0.2);
  const [sel, setSel] = useState<Sel | null>(null);
  const st = taskStore;
  const sl = st.slices();
  const now = st.now;
  const span = win * CPU_HZ;
  const from = Math.max(0, now - span);
  const to = Math.max(from + span, now);
  // Rows per core: tasks that ran there, IDLE last; order is stable so rows don't jump with the window
  const lanes = useMemo(() => {
    const per: number[][] = Array.from({ length: st.cores }, () => []);
    const seen = new Set<string>();
    for (const s of sl) {
      const k = `${s.core}:${s.task}`;
      if (seen.has(k) || s.core >= st.cores) continue;
      seen.add(k);
      per[s.core].push(s.task);
    }
    for (const rows of per)
      rows.sort(
        (a, b) =>
          Number(isIdle(st.tasks[a]?.name ?? "")) -
            Number(isIdle(st.tasks[b]?.name ?? "")) ||
          (st.tasks[b]?.prio ?? 0) - (st.tasks[a]?.prio ?? 0) ||
          a - b,
      );
    return per;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver]);
  // Segments: running, plus waiting (switched out on a queue / semaphore until next switched in); merge tiny gaps to cap DOM size
  const rowsOf = useMemo(() => {
    const m = new Map<string, { run: Slice[]; wait: [number, number][] }>();
    const lastOut = new Map<number, Slice>();
    const minGap = (to - from) / 800;
    for (const s of sl) {
      const k = `${s.core}:${s.task}`;
      let r = m.get(k);
      if (!r) m.set(k, (r = { run: [], wait: [] }));
      const lo = lastOut.get(s.task);
      if (lo && lo.end === ST.WAIT && s.t0 > lo.t1 && s.t0 > from && lo.t1 < to) {
        const wk = `${lo.core}:${s.task}`;
        const w = m.get(wk) ?? r;
        w.wait.push([lo.t1, s.t0]);
      }
      lastOut.set(s.task, s);
      if (s.t1 < from || s.t0 > to) continue;
      const prev = r.run[r.run.length - 1];
      if (prev && s.t0 - prev.t1 < minGap) prev.t1 = Math.max(prev.t1, s.t1);
      else r.run.push({ ...s });
    }
    // Still waiting now
    for (const [task, lo] of lastOut)
      if (lo.end === ST.WAIT && lo.t1 < to) {
        const r = m.get(`${lo.core}:${task}`);
        r?.wait.push([lo.t1, to]);
      }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver, win]);
  // Share of one core per task over the last second (or the run so far if shorter)
  const recent = useMemo(() => {
    const a = Math.max(0, now - CPU_HZ);
    const len = Math.max(1, now - a);
    const by = new Map<number, number>();
    for (const s of sl) {
      const x = Math.max(s.t0, a);
      const y = Math.min(s.t1, now);
      if (y > x) by.set(s.task, (by.get(s.task) ?? 0) + y - x);
    }
    return [...by]
      .map(([t, c]) => ({ t, pct: (c * 100) / len }))
      .sort(
        (p, q) =>
          Number(isIdle(st.tasks[p.t]?.name ?? "")) -
            Number(isIdle(st.tasks[q.t]?.name ?? "")) || q.pct - p.pct,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver]);
  const x = (t: number) => ((Math.min(Math.max(t, from), to) - from) * 100) / (to - from);
  // Colours rotate by order of non-IDLE tasks, not table index: IDLE / ipc take indices and neighbours would clash
  const palette = new Map<number, string>();
  for (const [i, t] of st.tasks.entries())
    if (!isIdle(t.name)) palette.set(i, COLORS[palette.size % COLORS.length]);
  const color = (t: number) => palette.get(t) ?? COLORS[0];
  const name = (t: number) => st.tasks[t]?.name ?? "?";
  const switches = st.events.filter((e) => e.task !== 0xffff).length;
  const exportIt = () => {
    const j = st.exportJson();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([j], { type: "application/json" }));
    a.download = `tasks-${st.chip}-${(now / CPU_HZ).toFixed(3)}s.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(t("Exported: open this JSON in ui.perfetto.dev"));
  };
  const loadElf = async (f: File) => {
    const syms = elfFuncs(await f.arrayBuffer());
    if (!syms?.length) {
      toast(t("No function symbols in this file (needs an IDF-built app.elf)"));
      return;
    }
    st.syms = syms;
    st.symsName = f.name;
    st.notify();
    toast(t("Loaded {n} function names", { n: syms.length }));
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(
    (k) => (from + (to - from) * k) / CPU_HZ,
  );
  const nameW = phone ? "w-[92px]" : "w-[140px]";
  const empty = !st.tasks.length;
  const selMs = sel ? ms(sel.t1 - sel.t0).toFixed(sel.t1 - sel.t0 < CPU_HZ / 100 ? 3 : 1) : "";

  return (
    <div
      id="tasksPane"
      data-switches={switches}
      data-tasks={st.tasks.length}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        className={cn(
          "flex flex-none flex-wrap items-center gap-2 border-b border-line-soft px-3 py-1.5 text-xs",
          phone && "px-2.5",
        )}
      >
        <span
          id="tasksCred"
          className="inline-flex items-center gap-1 text-muted"
          title={t("Switch order comes from real firmware execution; durations use simulated cycles (not calibrated on hardware), and interrupt time is charged to the interrupted task")}
        >
          <Icon n="meter" size={14} />
          {t("Behaviour model · switch order exact, durations in simulated cycles")}
        </span>
        <span className="flex-1" />
        <label className="inline-flex items-center gap-1 text-muted">
          {t("Window")}
          <select
            id="tasksWin"
            value={win}
            onChange={(e) => setWin(Number(e.currentTarget.value))}
            className={cn(
              "h-7 cursor-pointer rounded-md border border-line bg-surface px-1.5 font-mono text-xs text-fg",
              phone && "h-11 rounded-xl",
            )}
          >
            {WINDOWS.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          id="tasksExport"
          disabled={empty}
          onClick={exportIt}
          title={t("Chrome Trace Event JSON, opens in ui.perfetto.dev (one track per core)")}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line bg-surface px-2 text-xs text-fg hover:bg-field disabled:cursor-not-allowed disabled:text-muted",
            phone && "h-11 rounded-xl px-3",
          )}
        >
          <Icon n="download" size={14} />
          {t("Export Perfetto")}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row md:overflow-hidden">
        <div className="min-w-0 flex-none px-3 py-2 md:flex-1 md:overflow-auto">
          {empty ? (
            <p className="m-0 text-xs text-muted">
              {t("No task switches yet: the firmware has not started the scheduler, or it is not ESP-IDF v5.x FreeRTOS (the timeline reads the IDF v5.5 TCB layout).")}
            </p>
          ) : (
            <>
              <div
                className={cn(
                  "relative mb-1 flex h-4 font-mono text-[11px] text-muted",
                )}
              >
                <span className={cn("flex-none", nameW)}>
                  {ticks[0].toFixed(3)} s
                </span>
                <span className="relative min-w-0 flex-1">
                  {ticks.slice(1).map((t, i) => (
                    <span
                      key={i}
                      className="absolute -translate-x-full whitespace-nowrap"
                      style={{ left: `${(i + 1) * 25}%` }}
                    >
                      {t.toFixed(3)}
                    </span>
                  ))}
                </span>
              </div>
              {lanes.map((rows, c) => (
                <section
                  key={c}
                  data-core={c}
                  aria-label={t("Core {n}", { n: c })}
                  className="mb-1.5"
                >
                  <h4 className="m-0 mb-0.5 text-xs font-medium text-muted">
                    {t("Core {n}", { n: c })}
                  </h4>
                  {rows.map((tk) => {
                    const r = rowsOf.get(`${c}:${tk}`);
                    const idle = isIdle(name(tk));
                    return (
                      <div
                        key={tk}
                        data-task={name(tk)}
                        className="flex h-7 items-center"
                      >
                        <span
                          className={cn(
                            "flex-none truncate pr-2 font-mono text-xs",
                            nameW,
                            idle ? "text-muted" : "text-fg",
                          )}
                          title={(st.tasks[tk]?.core ?? -1) >= 0 ? t("{task} · priority {prio} · pinned to core {core}", { task: name(tk), prio: st.tasks[tk]?.prio ?? "?", core: st.tasks[tk]!.core }) : t("{task} · priority {prio}", { task: name(tk), prio: st.tasks[tk]?.prio ?? "?" })}
                        >
                          {name(tk)}
                        </span>
                        <span className="relative h-5 min-w-0 flex-1 overflow-hidden rounded bg-field">
                          {r?.wait.map(([a, b], i) => (
                            <button
                              key={`w${i}`}
                              type="button"
                              tabIndex={-1}
                              aria-label={t("{task} waiting {ms} ms", { task: name(tk), ms: ms(b - a).toFixed(1) })}
                              onClick={() =>
                                setSel({ task: tk, core: c, kind: "wait", t0: a, t1: b, pc: 0 })
                              }
                              className="absolute inset-y-0.5 cursor-pointer rounded-sm border border-[#d9922b] p-0"
                              style={{
                                left: `${x(a)}%`,
                                width: `max(2px, ${x(b) - x(a)}%)`,
                                background: WAIT_BG,
                              }}
                            />
                          ))}
                          {r?.run.map((s, i) => (
                            <button
                              key={i}
                              type="button"
                              tabIndex={-1}
                              aria-label={t("{task} running {ms} ms", { task: name(tk), ms: ms(s.t1 - s.t0).toFixed(2) })}
                              onClick={() =>
                                setSel({ task: tk, core: c, kind: "run", t0: s.t0, t1: s.t1, pc: s.pc })
                              }
                              className={cn(
                                "absolute cursor-pointer border-0 p-0",
                                idle ? "inset-y-[6px] rounded-sm" : "inset-y-0 rounded-[3px]",
                              )}
                              style={{
                                left: `${x(s.t0)}%`,
                                width: `max(1px, ${x(s.t1) - x(s.t0)}%)`,
                                background: idle ? "#d4d7dc" : color(tk),
                              }}
                            />
                          ))}
                        </span>
                      </div>
                    );
                  })}
                </section>
              ))}
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
                <span className="inline-flex items-center gap-1">
                  <i className="inline-block h-2.5 w-4 rounded-sm bg-[#0b76c8]" />
                  {t("Running")}
                </span>
                <span className="inline-flex items-center gap-1">
                  <i
                    className="inline-block h-2.5 w-4 rounded-sm border border-[#d9922b]"
                    style={{ background: WAIT_BG }}
                  />
                  {t("Waiting on semaphore / queue")}
                </span>
                <span className="inline-flex items-center gap-1">
                  <i className="inline-block h-1.5 w-4 rounded-sm bg-[#d4d7dc]" />
                  {t("Idle")}
                </span>
                <span className="font-mono">
                  {t("Switches: {n}", { n: switches })}
                  {st.coreDropped + st.trimmed
                    ? ` · ${t("Dropped: {n}", { n: st.coreDropped + st.trimmed })}`
                    : ""}
                </span>
              </div>
            </>
          )}
        </div>
        <aside
          aria-label={t("CPU use")}
          className="flex flex-none flex-col gap-3 border-t border-line-soft bg-field px-3 py-2.5 md:w-[360px] md:overflow-auto md:border-t-0 md:border-l"
        >
          <div>
            <h4 className="m-0 mb-1.5 text-xs font-medium text-fg">
              {t("CPU use, last 1 s")}
            </h4>
            {recent.length ? (
              <ul id="tasksUsage" className="m-0 list-none p-0">
                {recent.map(({ t, pct }) => (
                  <li
                    key={t}
                    data-task={name(t)}
                    className="grid grid-cols-[100px_1fr_48px] items-center gap-2 py-0.5 text-xs"
                  >
                    <span
                      className={cn(
                        "truncate font-mono",
                        isIdle(name(t)) ? "text-muted" : "text-fg",
                      )}
                    >
                      {name(t)}
                    </span>
                    <span className="h-2 overflow-hidden rounded-full bg-line-soft">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${Math.min(100, pct)}%`,
                          background: isIdle(name(t)) ? "#d4d7dc" : color(t),
                        }}
                      />
                    </span>
                    <span className="text-right font-mono text-muted">
                      {pct < 1 && pct > 0 ? "<1" : Math.round(pct)}%
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-xs text-muted">{t("No data yet")}</p>
            )}
          </div>
          {sel && (
            <div
              id="tasksSel"
              className="rounded-lg border border-line bg-surface px-3 py-2 text-xs"
            >
              <b className="font-medium">
                {sel.kind === "wait"
                  ? t("Selected: {task} waiting {ms} ms", { task: name(sel.task), ms: selMs })
                  : t("Selected: {task} running {ms} ms", { task: name(sel.task), ms: selMs })}
              </b>
              <p className="m-0 mt-1 text-muted">
                {t("Core {core} · {t0}–{t1} s · priority {prio}", {
                  core: sel.core,
                  t0: (sel.t0 / CPU_HZ).toFixed(4),
                  t1: (sel.t1 / CPU_HZ).toFixed(4),
                  prio: st.tasks[sel.task]?.prio ?? "?",
                })}
                {sel.kind === "wait"
                  ? ` · ${t("Parked on a queue / semaphore wait list when switched out")}`
                  : sel.pc
                    ? ` · ${t("Resumes from {fn}", { fn: st.func(sel.pc) ?? "0x" + sel.pc.toString(16).padStart(8, "0") })}`
                    : ""}
              </p>
            </div>
          )}
          <div className="rounded-lg border border-dashed border-[#b9c3cf] px-3 py-2 text-xs text-muted">
            {st.syms ? (
              <>
                <b className="font-mono text-fg">{st.symsName}</b>:{" "}
                {t("{n} functions loaded. Selected segments show the resume function, and the Perfetto export carries a resume field.", { n: st.syms.length })}
              </>
            ) : (
              <>
                {t("Task names are read from firmware memory. For function names, also drop in an app.elf.")}
              </>
            )}
            <label
              className={cn(
                "mt-2 flex h-7 w-fit cursor-pointer items-center gap-1 rounded-md border border-line bg-surface px-2 text-fg hover:bg-field",
                phone && "h-11 rounded-xl px-3",
              )}
            >
              <Icon n="upload" size={14} />
              {t("Upload app.elf")}
              <input
                id="tasksElf"
                type="file"
                accept=".elf"
                className="hidden"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  if (f) void loadElf(f);
                  e.currentTarget.value = "";
                }}
              />
            </label>
          </div>
        </aside>
      </div>
    </div>
  );
}
