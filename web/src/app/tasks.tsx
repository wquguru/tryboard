// 底部坞「任务」页签（C-04，设计稿 docs/design-v2/compete/Tasks.dc.html）：每核一组泳道，画在跑 / 等信号量或队列 / 空闲；
// 右侧（手机在下面）是最近 1 秒 CPU 占用和选中段的说明；导出 Perfetto；可选上传 app.elf 只为把恢复处 PC 翻成函数名。
// 数据来自内核的任务切换记录（tasktrace.ts），只在页签打开时挂载，≤ 4 Hz 重画。
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cn } from "../ui/cn";
import { Icon } from "./icons";
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

/** 版本号每次有新事件就变；这里再按 250 ms 节流，运行中也只 4 Hz 重画 */
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
  // 每核的行：在这个核上跑过的任务，IDLE 放最后（顺序固定，不随窗口跳）
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
  // 窗口里每行的段：在跑 + 等待（被切出时在等队列 / 信号量 → 直到下次换上来）；太窄的相邻段合并，DOM 有上限
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
    // 现在还在等的
    for (const [task, lo] of lastOut)
      if (lo.end === ST.WAIT && lo.t1 < to) {
        const r = m.get(`${lo.core}:${task}`);
        r?.wait.push([lo.t1, to]);
      }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver, win]);
  // 最近 1 秒（不满 1 秒按已跑的时长）每任务占一个核的百分比
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
  // 颜色按非 IDLE 任务的出场顺序轮换（不按任务表下标：IDLE / ipc 占了下标，相邻泳道容易撞色）
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
    toast("已导出：在 ui.perfetto.dev 打开这个 JSON");
  };
  const loadElf = async (f: File) => {
    const syms = elfFuncs(await f.arrayBuffer());
    if (!syms?.length) {
      toast("这个文件里没找到函数符号（要 IDF 构建出的 app.elf）");
      return;
    }
    st.syms = syms;
    st.symsName = f.name;
    st.notify();
    toast(`已载入 ${syms.length} 个函数名`);
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(
    (k) => (from + (to - from) * k) / CPU_HZ,
  );
  const nameW = phone ? "w-[92px]" : "w-[140px]";
  const empty = !st.tasks.length;

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
          title="任务切换的先后来自固件真实执行；耗时按模拟周期（未经真机标定），中断处理时间记在被打断的任务头上"
        >
          <Icon n="meter" size={14} />
          行为模拟 · 切换顺序准，耗时按模拟周期
        </span>
        <span className="flex-1" />
        <label className="inline-flex items-center gap-1 text-muted">
          窗口
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
          title="Chrome Trace Event JSON，ui.perfetto.dev 能打开（每核一条轨道）"
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line bg-surface px-2 text-xs text-fg hover:bg-field disabled:cursor-not-allowed disabled:text-muted",
            phone && "h-11 rounded-xl px-3",
          )}
        >
          <Icon n="download" size={14} />
          导出 Perfetto
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row md:overflow-hidden">
        <div className="min-w-0 flex-none px-3 py-2 md:flex-1 md:overflow-auto">
          {empty ? (
            <p className="m-0 text-xs text-muted">
              还没看到任务切换：固件还没启动调度器，或者不是 ESP-IDF v5.x 的
              FreeRTOS（任务时间线按 IDF v5.5 的 TCB 布局识别）。
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
                  aria-label={`核 ${c}`}
                  className="mb-1.5"
                >
                  <h4 className="m-0 mb-0.5 text-xs font-medium text-muted">
                    核 {c}
                  </h4>
                  {rows.map((t) => {
                    const r = rowsOf.get(`${c}:${t}`);
                    const idle = isIdle(name(t));
                    return (
                      <div
                        key={t}
                        data-task={name(t)}
                        className="flex h-7 items-center"
                      >
                        <span
                          className={cn(
                            "flex-none truncate pr-2 font-mono text-xs",
                            nameW,
                            idle ? "text-muted" : "text-fg",
                          )}
                          title={`${name(t)} · 优先级 ${st.tasks[t]?.prio ?? "?"}${(st.tasks[t]?.core ?? -1) >= 0 ? ` · 绑定核 ${st.tasks[t]!.core}` : ""}`}
                        >
                          {name(t)}
                        </span>
                        <span className="relative h-5 min-w-0 flex-1 overflow-hidden rounded bg-field">
                          {r?.wait.map(([a, b], i) => (
                            <button
                              key={`w${i}`}
                              type="button"
                              tabIndex={-1}
                              aria-label={`${name(t)} 等待 ${ms(b - a).toFixed(1)} ms`}
                              onClick={() =>
                                setSel({ task: t, core: c, kind: "wait", t0: a, t1: b, pc: 0 })
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
                              aria-label={`${name(t)} 在跑 ${ms(s.t1 - s.t0).toFixed(2)} ms`}
                              onClick={() =>
                                setSel({ task: t, core: c, kind: "run", t0: s.t0, t1: s.t1, pc: s.pc })
                              }
                              className={cn(
                                "absolute cursor-pointer border-0 p-0",
                                idle ? "inset-y-[6px] rounded-sm" : "inset-y-0 rounded-[3px]",
                              )}
                              style={{
                                left: `${x(s.t0)}%`,
                                width: `max(1px, ${x(s.t1) - x(s.t0)}%)`,
                                background: idle ? "#d4d7dc" : color(t),
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
                  在跑
                </span>
                <span className="inline-flex items-center gap-1">
                  <i
                    className="inline-block h-2.5 w-4 rounded-sm border border-[#d9922b]"
                    style={{ background: WAIT_BG }}
                  />
                  等信号量 / 队列
                </span>
                <span className="inline-flex items-center gap-1">
                  <i className="inline-block h-1.5 w-4 rounded-sm bg-[#d4d7dc]" />
                  空闲
                </span>
                <span className="font-mono">
                  {switches} 次切换
                  {st.coreDropped + st.trimmed
                    ? ` · 丢弃 ${st.coreDropped + st.trimmed}`
                    : ""}
                </span>
              </div>
            </>
          )}
        </div>
        <aside
          aria-label="CPU 占用"
          className="flex flex-none flex-col gap-3 border-t border-line-soft bg-field px-3 py-2.5 md:w-[360px] md:overflow-auto md:border-t-0 md:border-l"
        >
          <div>
            <h4 className="m-0 mb-1.5 text-xs font-medium text-fg">
              最近 1 秒 CPU 占用
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
              <p className="m-0 text-xs text-muted">还没有数据</p>
            )}
          </div>
          {sel && (
            <div
              id="tasksSel"
              className="rounded-lg border border-line bg-surface px-3 py-2 text-xs"
            >
              <b className="font-medium">
                选中：{name(sel.task)}{" "}
                {sel.kind === "wait" ? "等待" : "在跑"}{" "}
                {ms(sel.t1 - sel.t0).toFixed(sel.t1 - sel.t0 < CPU_HZ / 100 ? 3 : 1)} ms
              </b>
              <p className="m-0 mt-1 text-muted">
                核 {sel.core} · {(sel.t0 / CPU_HZ).toFixed(4)}–
                {(sel.t1 / CPU_HZ).toFixed(4)} s · 优先级{" "}
                {st.tasks[sel.task]?.prio ?? "?"}
                {sel.kind === "wait"
                  ? " · 被切出时挂在队列 / 信号量的等待链表上"
                  : sel.pc
                    ? ` · 从 ${st.func(sel.pc) ?? "0x" + sel.pc.toString(16).padStart(8, "0")} 继续`
                    : ""}
              </p>
            </div>
          )}
          <div className="rounded-lg border border-dashed border-[#b9c3cf] px-3 py-2 text-xs text-muted">
            {st.syms ? (
              <>
                已载入 <b className="font-mono text-fg">{st.symsName}</b>（
                {st.syms.length} 个函数）：选中段会显示从哪个函数继续，导出的
                Perfetto 文件带 resume 字段。
              </>
            ) : (
              <>
                任务名来自固件内存，已识别。想看函数名，再拖一个{" "}
                <b className="font-mono text-fg">app.elf</b>。
              </>
            )}
            <label
              className={cn(
                "mt-2 flex h-7 w-fit cursor-pointer items-center gap-1 rounded-md border border-line bg-surface px-2 text-fg hover:bg-field",
                phone && "h-11 rounded-xl px-3",
              )}
            >
              <Icon n="upload" size={14} />
              上传 app.elf
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
