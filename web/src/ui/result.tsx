// 结果卡（DESIGN_V2 §9）：状态词 + 一句标题 + 一句原因 + 人话逐条，原始数据收进折叠。
// 实验台检查点、组装开机复测共用。原始数据里保留与命令行逐字一致的结论行和运行编号（测试也从这里读）。
import type { ReactNode } from 'react';
import { cn } from './cn';
import { Kv, Res } from './panel';
import { VERDICT, type Verdict } from './say';

export type ResultRow = { ok: boolean | null; text: string; say?: string; tag?: string };

const pill: Record<Verdict, string> = {
  ok: 'bg-ok-bg text-ok-ink',
  bad: 'bg-bad-bg text-bad-ink',
  stall: 'bg-field text-fg',
  shifted: 'bg-warn-bg text-warn-ink',
};

/** 状态词胶囊：只用四个词之一 */
export const VerdictPill = ({ v }: { v: Verdict }) => <span className={cn('inline-flex h-5 flex-none items-center rounded-full px-2 text-[11px] font-medium', pill[v])}>{VERDICT[v]}</span>;

export function ResultCard({ verdict, title, why, meta, rows, runId, rawNote, children }: {
  verdict: Verdict;
  title: ReactNode;
  why?: ReactNode;
  /** 状态词右边的小字（谁的固件、模拟了几秒） */
  meta?: ReactNode;
  rows: ResultRow[];
  runId?: string;
  rawNote?: ReactNode;
  /** 动作按钮 */
  children?: ReactNode;
}) {
  // 人话逐条：没过的排前面
  const human = [...rows].sort((a, b) => Number(a.ok !== false) - Number(b.ok !== false));
  return (
    <div className="result-card" data-verdict={verdict}>
      <div className="verdict-line mb-1 flex items-center gap-2 text-xs">
        <VerdictPill v={verdict} />
        {meta && <span className="min-w-0 truncate text-muted">{meta}</span>}
      </div>
      <div className="result-title mb-1 text-[15px] leading-snug font-medium text-fg">{title}</div>
      {why && <p className="my-1.5 text-xs leading-relaxed text-muted">{why}</p>}
      <div className="result-rows mt-2">
        {human.map((x, i) => (
          <div key={i} className="flex items-start gap-2 border-b border-line py-1.5 text-[13px] last:border-b-0" data-ok={x.ok === null ? 'na' : x.ok ? 'ok' : 'bad'}>
            <span className={cn('w-3 flex-none font-mono', x.ok === true && 'text-ok-ink', x.ok === false && 'text-bad-ink', x.ok === null && 'text-muted')} aria-label={x.ok === null ? '不判' : x.ok ? '通过' : '没通过'}>
              {x.ok === null ? '·' : x.ok ? '✓' : '✗'}
            </span>
            <span className={cn('min-w-0 flex-1', x.ok === null && 'text-muted')}>{x.say ?? x.text}</span>
            {x.tag && <span className="flex-none font-mono text-[11px] text-muted">{x.tag}</span>}
          </div>
        ))}
      </div>
      {children}
      <details className="raw mt-2 text-xs">
        <summary className="cursor-pointer py-1 text-muted select-none">原始数据</summary>
        <div className="mt-1">
          {rows.map((x, i) => (
            <Res key={i} kind={x.ok === null ? 'na' : x.ok ? 'ok' : 'bad'}>
              {x.text}
            </Res>
          ))}
          {runId && <Kv k={<span title="同一固件、同样输入，网页和命令行的运行编号相同，说明结果可复现">运行编号</span>} v={runId} cls="fp" />}
          {rawNote}
        </div>
      </details>
    </div>
  );
}

/** 单条估算结论：上面一句人话，下面一行小字原数（测试和高级用户读小字） */
export const Said = ({ say, raw }: { say: ReactNode; raw: ReactNode }) => (
  <>
    <span data-say>{say}</span>
    <span data-raw className="mt-0.5 block font-mono text-[11px] leading-snug opacity-70">
      {raw}
    </span>
  </>
);
