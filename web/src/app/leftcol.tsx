// 实验台 v2 左栏（DESIGN_V2 §4.2）：构建树 / 元件库 / 接线表 三个页签 + 「加零件」+ 底部检查点卡。
// 构建树仍是 shell 的 tree 面板（各步骤自己画）；元件库、接线表和检查点卡由实验台填进 left 这个 store，
// 别的步骤不填，左栏就只剩构建树。
import { useState, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { commit, useStore } from './react';
import { createStore } from './store';
import { Icon } from './icons';

export interface LeftData {
  lib: ReactNode;
  wires: ReactNode;
  wireCount: number;
  card: ReactNode;
}
const left = createStore<LeftData>({ lib: null, wires: null, wireCount: 0, card: null });
export const setLeft = (p: Partial<LeftData>) => commit(() => left.set(p));

type Tab = 'tree' | 'lib' | 'wires';
const tabCls =
  'h-8 flex-1 cursor-pointer rounded-md border-0 bg-transparent px-1 text-xs text-muted hover:text-fg aria-selected:bg-(--seg-on) aria-selected:font-medium aria-selected:text-fg aria-selected:shadow-[0_1px_2px_#0000001a]';

export function LeftColumn({ step, tree }: { step: string; tree: ReactNode }) {
  const d = useStore(left);
  const [tab, setTab] = useState<Tab>('tree');
  const bench = step === 'bench';
  // 只有实验台有元件库和接线表；离开实验台回到构建树
  const cur: Tab = bench ? tab : 'tree';
  return (
    <>
      {bench && (
        <div role="tablist" aria-label="左栏" className="mx-2 mt-2 flex flex-none gap-0.5 rounded-lg bg-field p-0.5 max-[760px]:hidden">
          {(
            [
              ['tree', '构建树'],
              ['lib', '元件库'],
              ['wires', `接线表${d.wireCount ? ` ${d.wireCount}` : ''}`],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" data-left={id} aria-selected={cur === id} onClick={() => setTab(id)} className={tabCls}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div className={cn('flex min-h-0 flex-1 flex-col', cur !== 'tree' && 'hidden')}>{tree}</div>
      {bench && cur === 'lib' && <div className="min-h-0 flex-1 overflow-auto px-2 py-2">{d.lib}</div>}
      {bench && cur === 'wires' && <div className="min-h-0 flex-1 overflow-auto px-2 py-2">{d.wires}</div>}
      {bench && (
        <div className="flex-none px-2 pb-2 max-[760px]:hidden">
          <a
            id="addPart"
            href="#shop"
            title="零件从采购清单来：在采购里勾上，再「摆上实验台」"
            className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-dashed border-hover-line text-xs text-muted no-underline hover:border-accent hover:text-accent-ink"
          >
            <Icon n="plus" size={14} />
            加零件
          </a>
        </div>
      )}
      {bench && d.card && <div className="flex-none border-t border-line-soft p-2 max-[760px]:hidden">{d.card}</div>}
    </>
  );
}
