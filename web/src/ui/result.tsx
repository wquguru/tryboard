// Result card (DESIGN_V2 §9 / §9.5): verdict, title, reason, rows grouped by device, one main action; raw data folded away.
// Raw data keeps the CLI-identical result lines and run ID (tests read them), shared by lab checkpoints and assembly re-checks.
import type { ReactNode } from 'react';
import { cn } from './cn';
import { Kv, Res } from './panel';
import { VERDICT, groupRows, type Verdict } from './say';
import { t } from '../i18n';
import { CONF_LEVELS, ConfIcon, confLabel, type ConfLevel } from './conf';

export type ResultRow = { ok: boolean | null; text: string; say?: string; tag?: string; dev?: string; conf?: ConfLevel; note?: string };

type Mark = 'ok' | 'bad' | 'warn' | 'na';

/** Drawn 16 px icons: the ✓✗ glyphs sit 1–2 px off the CJK baseline and drift with line height. */
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

/** Verdict pill: one of four words, with an icon so colour is not the only cue. */
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
  /** Small text right of the verdict (whose firmware, seconds simulated). */
  meta?: ReactNode;
  rows: ResultRow[];
  runId?: string;
  rawNote?: ReactNode;
  /** Action buttons: one main action per card. */
  children?: ReactNode;
  /** Extra under the reason (e.g. why a run stalled). */
  extra?: ReactNode;
}) {
  const groups = groupRows(rows);
  // Shifted after casing: amber triangles, not red crosses (it worked open, so it is not a code bug).
  const badMark: Mark = verdict === 'shifted' ? 'warn' : 'bad';
  // A single row equal to the title would just repeat it; skip it (still in raw data).
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
                  g.bad.map((r, i) => <Row key={i} mark={badMark} text={r.say ?? r.text} ok="bad" conf={r.conf} note={r.note} />)
                )}
                {g.bad.length > 0 && good.length > 0 ? (
                  <Row mark="ok" text={good.length > 1 ? t('The other {n} items are fine', { n: good.length }) : (good[0].say ?? good[0].text)} ok="ok" dim />
                ) : (
                  good.map((r, i) => <Row key={i} mark={r.ok === null ? 'na' : 'ok'} text={r.say ?? r.text} ok={r.ok === null ? 'na' : 'ok'} dim={r.ok === null} conf={r.conf} note={r.note} />)
                )}
              </div>
            );
          })}
        </div>
      )}
      {!echo && <ConfLegend rows={rows} />}
      {children && <div className="result-acts mt-3 flex flex-wrap gap-2">{children}</div>}
      {(rows.length > 0 || runId || rawNote) && (
        <details className="raw group mt-3 border-t border-line">
          <summary className="-mx-1 flex h-11 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-[13px] font-medium text-fg select-none hover:bg-field [&::-webkit-details-marker]:hidden">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="flex-none -rotate-90 transition-transform group-open:rotate-0">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t('Raw data')}
            <span className="text-xs font-normal text-muted">
              {rows.length > 0 && t('{n} results', { n: rows.length })}
              {rows.length > 0 && runId && ' + '}
              {runId && t('Run ID')}
            </span>
          </summary>
          <div className="pb-1">
            {rows.map((x, i) => (
              <Res key={i} kind={x.ok === null ? 'na' : x.ok ? 'ok' : 'bad'}>
                {x.text}
              </Res>
            ))}
            {runId && <Kv k={<span title={t('Same firmware and inputs give the same run ID on the web and the CLI, so the result is reproducible')}>{t('Run ID')}</span>} v={runId} cls="fp" />}
            {rawNote}
          </div>
        </details>
      )}
    </div>
  );
}

function Row({ mark, text, ok, dim, conf, note }: { mark: Mark; text: ReactNode; ok: 'ok' | 'bad' | 'na'; dim?: boolean; conf?: ConfLevel; note?: string }) {
  return (
    <div className={cn('flex min-h-9 gap-2 border-b border-line-soft py-1.5 text-[13px] leading-5', note ? 'items-start' : 'items-center', dim && 'text-muted')} data-ok={ok} data-conf={conf}>
      <Mark k={mark} className={note ? 'mt-0.5' : undefined} />
      <span className="min-w-0 flex-1">
        {text}
        {note && <span className="row-note mt-0.5 block text-xs leading-[18px] text-muted">{note}</span>}
      </span>
      {conf && (
        <span className="row-conf inline-flex flex-none items-center gap-1 text-[11px] text-muted" title={confLabel(conf)}>
          <ConfIcon c={conf} size={12} />
          <span className="max-md:sr-only">{confLabel(conf)}</span>
        </span>
      )}
    </div>
  );
}

const confHint = (c: ConfLevel) =>
  ({
    仿真验证: t('same as real hardware'), // lint: allow-cjk
    行为模拟: t('right flow, approximate values'), // lint: allow-cjk
    估算: t('typical part'), // lint: allow-cjk
    必须上真机: t('the simulator cannot prove this'), // lint: allow-cjk
  })[c];

/** Legend under the rows (D-05): only the levels that appear, so a plain card stays plain. */
function ConfLegend({ rows }: { rows: ResultRow[] }) {
  const used = CONF_LEVELS.filter((c) => rows.some((r) => r.conf === c));
  if (!used.length) return null;
  return (
    <div className="conf-legend mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
      {used.map((c) => (
        <span key={c} className="inline-flex items-center gap-1">
          <ConfIcon c={c} size={12} />
          <b className="font-medium text-fg">{confLabel(c)}</b> {confHint(c)}
        </span>
      ))}
    </div>
  );
}

/** Running card: same place and frame as the result card, swapped in place when done so the eye stays put. */
export function RunningCard({ title, meta, progress }: { title: ReactNode; meta?: ReactNode; progress?: ReactNode }) {
  return (
    <div className={cn('run-card mt-1 rounded-(--r) border border-line bg-surface p-4 max-md:p-3')} aria-live="polite">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-accent-bg px-2.5 text-xs font-medium text-accent-ink">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="animate-spin motion-reduce:animate-none">
            <path d="M8 2a6 6 0 1 1-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {t('Simulating')}
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

/** Result card buttons: 36 px tall on desktop, 44 px on phones. */
export const actCls = 'h-9 px-4 text-[14px] font-medium max-md:h-11';

/** One estimate: a plain sentence on top, raw numbers in small print below (for tests and power users). */
export const Said = ({ say, raw }: { say: ReactNode; raw: ReactNode }) => (
  <>
    <span data-say>{say}</span>
    <span data-raw className="mt-0.5 block font-mono text-[11px] leading-snug opacity-70">
      {raw}
    </span>
  </>
);
