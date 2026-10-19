// 结果卡（DESIGN_V2 §9 / §9.5）：状态词 + 一句标题 + 一句原因 + 按器件分组的逐条 + 一个主动作，原始数据收进折叠。
// 实验台检查点、组装开机复测共用。原始数据里保留与命令行逐字一致的结论行和运行编号（测试也从这里读）。
import type { ReactNode } from 'react';
import { cn } from './cn';
import { Kv, Res } from './panel';
import { VERDICT, groupRows, type Verdict } from './say';

export type ResultRow = { ok: boolean | null; text: string; say?: string; tag?: string; dev?: string };

type Mark = 'ok' | 'bad' | 'warn' | 'na';

/** 16 px 图标：字符 ✓✗ 和中文基线差 1–2 px，行高一变就飘，所以自绘 */
export function Mark({ k, size = 16, className }: { k: Mark; size?: number; className?: string }) {
  const body = {
    ok: <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
    bad: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
    warn: (
      <>
        <path d="M8 2.5l6 11H2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8 6.8v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
    na: <circle cx="8" cy="8" r="2" fill="currentColor" />,
  }[k];
  const tone = { ok: 'text-ok-ink', bad: 'text-bad-ink', warn: 'text-warn-ink', na: 'text-muted' }[k];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className={cn('flex-none', tone, className)}>
      {body}
    </svg>
  );
}

const pill: Record<Verdict, string> = {
  ok: 'bg-ok-bg text-ok-ink',
  bad: 'bg-bad-bg text-bad-ink',
  stall: 'bg-field text-fg',
  shifted: 'bg-warn-bg text-warn-ink',
};
const pillMark: Record<Verdict, Mark> = { ok: 'ok', bad: 'bad', stall: 'na', shifted: 'warn' };

/** 状态词胶囊：只用四个词之一，带图标（不只靠颜色区分） */
export const VerdictPill = ({ v }: { v: Verdict }) => (
  <span className={cn('inline-flex h-6 flex-none items-center gap-1.5 rounded-full px-2.5 text-xs font-medium', pill[v])}>
    <Mark k={pillMark[v]} size={12} className="text-current" />
    {VERDICT[v]}
  </span>
);

const card = 'result-card mt-1 rounded-(--r) border bg-surface p-4 max-md:p-3';
const border: Record<Verdict, string> = { ok: 'border-line', bad: 'border-(--bad-line)', stall: 'border-line', shifted: 'border-(--warn-line)' };

export function ResultCard({ verdict, title, why, meta, rows, runId, rawNote, children, extra }: {
  verdict: Verdict;
  title: ReactNode;
  why?: ReactNode;
  /** 状态词右边的小字（谁的固件、模拟了几秒） */
  meta?: ReactNode;
  rows: ResultRow[];
  runId?: string;
  rawNote?: ReactNode;
  /** 动作按钮：一张卡只有一个主动作 */
  children?: ReactNode;
  /** 原因下面的补充（没跑完的原因小字等） */
  extra?: ReactNode;
}) {
  const groups = groupRows(rows);
  // 装壳后变了：没过的行用琥珀三角，不用红叉（开盖时是好的，不是代码错）
  const badMark: Mark = verdict === 'shifted' ? 'warn' : 'bad';
  // 只有一条且和标题同一句：逐条就是在重复标题，不画（原始数据里还在）
  const echo = rows.length === 1 && typeof title === 'string' && (rows[0].say ?? rows[0].text) === title;
  return (
    <div className={cn(card, border[verdict])} data-verdict={verdict}>
      <div className="verdict-line flex items-center gap-2">
        <VerdictPill v={verdict} />
        {meta && <span className="min-w-0 truncate text-xs text-muted">{meta}</span>}
      </div>
      <div className="result-title mt-2 text-[15px] leading-[22px] font-semibold text-fg md:text-base">{title}</div>
      {why && <p className="mt-1 mb-0 text-[13px] leading-5 text-muted">{why}</p>}
      {extra}
      {groups.length > 0 && !echo && (
        <div className="result-rows mt-3">
          {groups.map((g, gi) => {
            const good = g.rows.filter((r) => r.ok !== false);
            return (
              <div key={gi} className="result-group mt-2 first:mt-0" data-dev={g.dev}>
                <div className="flex h-7 items-center gap-2 border-b border-line text-xs font-semibold text-fg">
                  <span>{g.dev}</span>
                  {g.pin && <span className="rounded bg-field px-1.5 py-px font-mono text-[11px] font-medium text-muted">{g.pin}</span>}
                </div>
                {g.sum ? (
                  <div className="flex min-h-9 items-start gap-2 border-b border-line-soft py-2 text-[13px] leading-5" data-ok="bad">
                    <Mark k={badMark} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      {g.sum}
                      {g.bad.map((r, i) => (
                        <span key={i} className="mt-0.5 block text-xs leading-4 text-muted">
                          {r.say ?? r.text}
                        </span>
                      ))}
                    </span>
                  </div>
                ) : (
                  g.bad.map((r, i) => <Row key={i} mark={badMark} text={r.say ?? r.text} ok="bad" />)
                )}
                {g.bad.length > 0 && good.length > 0 ? (
                  <Row mark="ok" text={good.length > 1 ? `其余 ${good.length} 项正常` : (good[0].say ?? good[0].text)} ok="ok" dim />
                ) : (
                  good.map((r, i) => <Row key={i} mark={r.ok === null ? 'na' : 'ok'} text={r.say ?? r.text} ok={r.ok === null ? 'na' : 'ok'} dim={r.ok === null} />)
                )}
              </div>
            );
          })}
        </div>
      )}
      {children && <div className="result-acts mt-3 flex flex-wrap gap-2">{children}</div>}
      {(rows.length > 0 || runId || rawNote) && (
        <details className="raw group mt-3 border-t border-line">
          <summary className="-mx-1 flex h-11 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-[13px] font-medium text-fg select-none hover:bg-field [&::-webkit-details-marker]:hidden">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="flex-none -rotate-90 transition-transform group-open:rotate-0">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            原始数据
            <span className="text-xs font-normal text-muted">
              {rows.length > 0 && `${rows.length} 条结论`}
              {rows.length > 0 && runId && ' + '}
              {runId && '运行编号'}
            </span>
          </summary>
          <div className="pb-1">
            {rows.map((x, i) => (
              <Res key={i} kind={x.ok === null ? 'na' : x.ok ? 'ok' : 'bad'}>
                {x.text}
              </Res>
            ))}
            {runId && <Kv k={<span title="同一固件、同样输入，网页和命令行的运行编号相同，说明结果可复现">运行编号</span>} v={runId} cls="fp" />}
            {rawNote}
          </div>
        </details>
      )}
    </div>
  );
}

function Row({ mark, text, ok, dim }: { mark: Mark; text: ReactNode; ok: 'ok' | 'bad' | 'na'; dim?: boolean }) {
  return (
    <div className={cn('flex min-h-9 items-center gap-2 border-b border-line-soft py-1.5 text-[13px] leading-5', dim && 'text-muted')} data-ok={ok}>
      <Mark k={mark} />
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  );
}

/** 跑中卡：和结果卡同一位置、同一外框，跑完原地换成结果，眼睛不用找 */
export function RunningCard({ title, meta, progress }: { title: ReactNode; meta?: ReactNode; progress?: ReactNode }) {
  return (
    <div className={cn('run-card mt-1 rounded-(--r) border border-line bg-surface p-4 max-md:p-3')} aria-live="polite">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-accent-bg px-2.5 text-xs font-medium text-accent-ink">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="animate-spin motion-reduce:animate-none">
            <path d="M8 2a6 6 0 1 1-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          模拟中
        </span>
        {meta && <span className="min-w-0 truncate text-xs text-muted">{meta}</span>}
      </div>
      <div className="mt-2 text-[15px] leading-[22px] font-semibold md:text-base">{title}</div>
      {progress && <div className="mt-1 text-[13px] leading-5 text-muted">{progress}</div>}
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-field">
        <div className="h-full w-1/3 animate-[tb-run_1.2s_ease-in-out_infinite] rounded-full bg-accent-strong motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/** 结果卡里的按钮：桌面 36 高，手机 44 高 */
export const actCls = 'h-9 px-4 text-[14px] font-medium max-md:h-11';

/** 单条估算结论：上面一句人话，下面一行小字原数（测试和高级用户读小字） */
export const Said = ({ say, raw }: { say: ReactNode; raw: ReactNode }) => (
  <>
    <span data-say>{say}</span>
    <span data-raw className="mt-0.5 block font-mono text-[11px] leading-snug opacity-70">
      {raw}
    </span>
  </>
);
