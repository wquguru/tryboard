// Two lab cards for advisor-built work=custom (DESIGN_V2 §8.3, mock LoopA): the "placed and wired" card on the bench and the
// auto-generated checkpoint card at the bottom of the left column. Render only; data and actions come from bench.tsx.
import { t } from '../i18n';
import { ConfIcon, type ConfLevel } from '../ui/conf';
import { levelConf } from './genlevels';
import type { Level } from '../checks';
import { Icon } from './icons';

const MANUAL: ConfLevel = '必须上真机'; // lint: allow-cjk (ConfLevel id)
// ConfLevel ids are Chinese identifiers (ui/conf.tsx); show them through English keys.
const CONF_NAME: Record<ConfLevel, string> = {
  仿真验证: t('Simulation-verified'), // lint: allow-cjk
  行为模拟: t('Behavioral model'), // lint: allow-cjk
  估算: t('Estimate'), // lint: allow-cjk
  必须上真机: t('Real hardware only'), // lint: allow-cjk
};

const btn = 'inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-line bg-surface px-2.5 text-xs text-fg hover:bg-field max-md:h-11';
const btnPri = 'inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-accent-strong bg-accent-strong px-2.5 text-xs font-medium text-on-accent max-md:h-11';

export function CustomPlacedCard({ n, sub, demo, busy, onFirmware, onBrief, onDemo, onClose }: { n: number; sub?: string; demo: string | null; busy: boolean; onFirmware: () => void; onBrief: () => void; onDemo: () => void; onClose: () => void }) {
  return (
    <div id="customPlaced" className="absolute top-1/2 left-1/2 z-3 w-[380px] max-w-[calc(100%-24px)] -translate-x-1/2 -translate-y-1/2 rounded-(--r) border border-line bg-surface p-4 text-fg shadow-panel">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <b className="block text-sm">{t('Placed and wired {n} parts from the shopping list and the pin table', { n })}</b>
          {sub && <p className="mt-1 mb-0 text-xs text-muted">{sub}</p>}
          <span className="mt-2 block text-[11px] font-medium text-muted">{t('Next: add firmware')}</span>
        </div>
        <button type="button" className="inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-md text-muted hover:bg-field max-md:size-11" aria-label={t('Close')} onClick={onClose}>
          <Icon n="x" size={14} />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button type="button" data-fw-open="" className={btnPri} onClick={onFirmware}>
          {t('Drop in flash.bin')}
        </button>
        <button type="button" data-custom-brief="" className={btn} onClick={onBrief}>
          {t('Copy the brief for AI')}
        </button>
        {demo && (
          <button type="button" data-custom-demo={demo} className={btn} disabled={busy} onClick={onDemo}>
            {busy ? t('Checking the demo firmware…') : t('Try the demo firmware first')}
          </button>
        )}
      </div>
    </div>
  );
}

/** ref = reference/demo firmware passed (◐), ok = your own firmware passed (✓). */
export type CpState = 'ok' | 'ref' | 'bad' | 'run' | 'todo';

export function CustomCheckCard({ levels, state, done, total, onPick, onExport, onBuy }: { levels: Level[]; state: (id: string) => CpState; done: number; total: number; onPick: (id: string) => void; onExport: () => void; onBuy: (() => void) | null }) {
  const judged = levels.filter((l) => !l.manual);
  const manual = levels.filter((l) => l.manual);
  const mark: Record<CpState, string> = { ok: '✓', ref: '◐', bad: '✗', run: '…', todo: t('Not run') };
  const cls: Record<CpState, string> = { ok: 'text-ok-ink', ref: 'text-ok-ink', bad: 'text-bad-ink', run: 'text-muted', todo: 'text-muted' };
  return (
    <div id="cpCard" data-custom-cp="" className={`rounded-lg border p-2.5 text-xs ${onBuy ? 'border-line bg-ok-bg' : 'border-line bg-surface'}`}>
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>{t('Checkpoints · generated from your parts')}</span>
        <span className="font-mono">
          {done}/{total}
        </span>
      </div>
      <ul className="m-0 mt-1.5 list-none p-0">
        {judged.map((l) => {
          const st = state(l.id);
          return (
            <li key={l.id}>
              <button type="button" data-cp={l.id} className="flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded px-1 text-left text-fg hover:bg-field max-md:min-h-11" title={`${CONF_NAME[levelConf(l)]} · ${l.pass}`} onClick={() => onPick(l.id)}>
                <ConfIcon c={levelConf(l)} size={12} />
                <span className="min-w-0 flex-1 truncate">{l.title}</span>
                <span className={`flex-none ${cls[st]}`}>{mark[st]}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {manual.length > 0 && (
        <div className="mt-1.5 border-t border-line-soft pt-1.5 text-muted" data-cp-manual="">
          <span className="text-[11px]">{t('Only real hardware can tell (not judged, not counted)')}</span>
          {manual.map((l) => (
            <div key={l.id} className="flex items-center gap-1.5 px-1 py-0.5">
              <ConfIcon c={MANUAL} size={12} />
              <span className="min-w-0 flex-1 truncate">{l.title}</span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-1.5 mb-2 text-[11px] text-muted">{onBuy ? t('All {n} checkpoints passed: ready to build it for real.', { n: total }) : t('Drop in firmware to judge each one; results read "got x; need y".')}</p>
      <div className="flex flex-wrap gap-1.5">
        {onBuy && (
          <button type="button" id="cpBuy" className={btnPri} onClick={onBuy}>
            {t('See the buy card →')}
          </button>
        )}
        <button type="button" id="cpExport" className={btn} onClick={onExport}>
          {t('Export checkpoints')}
        </button>
      </div>
    </div>
  );
}
