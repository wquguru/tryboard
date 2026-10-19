// 选板作品（work=custom）在实验台上的两张卡（DESIGN_V2 §8.3，稿 LoopA）：
// 台面上的「摆好、连好了」说明卡，左栏底部的「检查点 · 按你的零件自动生成」。只管画，数据和动作由 bench.tsx 传进来。
import { ConfIcon } from '../ui/conf';
import { levelConf } from './genlevels';
import type { Level } from '../checks';
import { Icon } from './icons';

const btn = 'inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-line bg-surface px-2.5 text-xs text-fg hover:bg-field max-md:h-11';
const btnPri = 'inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-accent-strong bg-accent-strong px-2.5 text-xs font-medium text-on-accent max-md:h-11';

export function CustomPlacedCard({ n, sub, demo, busy, onFirmware, onBrief, onDemo, onClose }: { n: number; sub?: string; demo: string | null; busy: boolean; onFirmware: () => void; onBrief: () => void; onDemo: () => void; onClose: () => void }) {
  return (
    <div id="customPlaced" className="absolute top-1/2 left-1/2 z-3 w-[380px] max-w-[calc(100%-24px)] -translate-x-1/2 -translate-y-1/2 rounded-(--r) border border-line bg-surface p-4 text-fg shadow-panel">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <b className="block text-sm">按采购清单里的零件和选板引脚表，摆好、连好了 {n} 个</b>
          {sub && <p className="mt-1 mb-0 text-xs text-muted">{sub}</p>}
          <span className="mt-2 block text-[11px] font-medium text-muted">下一步：放进固件</span>
        </div>
        <button type="button" className="inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-md text-muted hover:bg-field max-md:size-11" aria-label="关闭" onClick={onClose}>
          <Icon n="x" size={14} />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button type="button" data-fw-open="" className={btnPri} onClick={onFirmware}>
          拖入 flash.bin
        </button>
        <button type="button" data-custom-brief="" className={btn} onClick={onBrief}>
          复制给 AI 的任务书
        </button>
        {demo && (
          <button type="button" data-custom-demo={demo} className={btn} disabled={busy} onClick={onDemo}>
            {busy ? '演示固件验收中…' : '先跑演示固件看看'}
          </button>
        )}
      </div>
    </div>
  );
}

/** ref = 参考 / 演示固件跑通（◐），ok = 自己的固件通过（✓） */
export type CpState = 'ok' | 'ref' | 'bad' | 'run' | 'todo';

export function CustomCheckCard({ levels, state, done, total, onPick, onExport, onBuy }: { levels: Level[]; state: (id: string) => CpState; done: number; total: number; onPick: (id: string) => void; onExport: () => void; onBuy: (() => void) | null }) {
  const judged = levels.filter((l) => !l.manual);
  const manual = levels.filter((l) => l.manual);
  const mark: Record<CpState, string> = { ok: '✓', ref: '◐', bad: '✗', run: '…', todo: '待运行' };
  const cls: Record<CpState, string> = { ok: 'text-ok-ink', ref: 'text-ok-ink', bad: 'text-bad-ink', run: 'text-muted', todo: 'text-muted' };
  return (
    <div id="cpCard" data-custom-cp="" className={`rounded-lg border p-2.5 text-xs ${onBuy ? 'border-line bg-ok-bg' : 'border-line bg-surface'}`}>
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>检查点 · 按你的零件自动生成</span>
        <span className="font-mono">
          {done}/{total}
        </span>
      </div>
      <ul className="m-0 mt-1.5 list-none p-0">
        {judged.map((l) => {
          const st = state(l.id);
          return (
            <li key={l.id}>
              <button type="button" data-cp={l.id} className="flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded px-1 text-left text-fg hover:bg-field max-md:min-h-11" title={`${levelConf(l)} · ${l.pass}`} onClick={() => onPick(l.id)}>
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
          <span className="text-[11px]">上真机才知道（不判、不计入）</span>
          {manual.map((l) => (
            <div key={l.id} className="flex items-center gap-1.5 px-1 py-0.5">
              <ConfIcon c="必须上真机" size={12} />
              <span className="min-w-0 flex-1 truncate">{l.title}</span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-1.5 mb-2 text-[11px] text-muted">{onBuy ? `${total} 个检查点全部通过：可以做成真的了。` : '拖入固件即逐条判；结果写「实际 x；要 y」。'}</p>
      <div className="flex flex-wrap gap-1.5">
        {onBuy && (
          <button type="button" id="cpBuy" className={btnPri} onClick={onBuy}>
            看真买卡 →
          </button>
        )}
        <button type="button" id="cpExport" className={btn} onClick={onExport}>
          导出检查点
        </button>
      </div>
    </div>
  );
}
