// 台面浮层（DESIGN_V2 §4.3）：右上视角按钮、左上「桌面 · 室温」、左下操作提示、「?」快捷键表，
// 加上实验台临时挂上来的卡片（bc.overlays：连线横幅、万用表、接错线、欠压、固件校验……）。
import { useEffect, useState } from 'react';
import { cn } from '../ui/cn';
import { actions, bc } from './chrome';
import { Icon } from './icons';
import { useStore } from './react';

const vb = 'flex size-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-xs font-medium text-fg hover:bg-field disabled:cursor-not-allowed disabled:text-muted';

const KEYS: [string, string][] = [
  ['⌘K', '命令框：搜命令、零件、引脚'],
  ['⌘Z / ⇧⌘Z', '撤销 / 重做（实验台时间线）'],
  ['V', '选择'],
  ['W', '改接：点一根线，再点新的引脚'],
  ['M', '万用表：点引脚量对地电压'],
  ['R', '尺子'],
  ['F', '对准选中的东西'],
  ['Esc', '退出当前工具 / 关闭弹层'],
  ['?', '打开这张表'],
];

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" aria-label="快捷键" id="keySheet" className="absolute top-14 right-3 z-6 w-[280px] rounded-(--r) border border-line bg-surface p-3 text-fg shadow-panel">
      <div className="mb-2 flex items-center justify-between">
        <b className="text-[13px]">快捷键</b>
        <button type="button" aria-label="关闭" className={cn(vb, 'size-6')} onClick={onClose}>
          <Icon n="x" size={14} />
        </button>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        {KEYS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="rounded border border-line bg-field px-1.5 font-mono text-[11px]">{k}</kbd>
            </dt>
            <dd className="m-0 text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function StageOverlays({ bench }: { bench: boolean }) {
  const c = useStore(bc);
  const [keys, setKeys] = useState(false);
  useEffect(() => {
    if (!bench) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,[contenteditable]')) return;
      if (e.key === '?') setKeys((v) => !v);
      else if (e.key === 'Escape') setKeys(false);
      else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) actions.view?.('fit');
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [bench]);
  if (!bench) return null;
  const v = actions.view;
  const full = () => {
    const el = document.getElementById('stage');
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el?.requestFullscreen?.();
  };
  return (
    <>
      {/* 左上：桌面标签、外观说明、操作提示叠成一列（台面下边留给工具条） */}
      <div className="pointer-events-none absolute top-3 left-3 z-2 flex flex-col items-start gap-1 max-[760px]:hidden">
        {c.room != null && (
          <div id="roomChip" className="rounded-full border border-line bg-(--panel) px-2.5 py-1 font-mono text-[11px] text-muted shadow-panel">
            桌面 · 室温 {c.room.toFixed(1)} °C
          </div>
        )}
        <span className="disclaimer pl-1 text-[11px] text-muted">外观示意，非乐鑫官方模型</span>
        <span className="pl-1 text-[11px] text-muted max-[1280px]:hidden">拖动旋转 · 右键平移 · 滚轮缩放 · 点零件看属性</span>
      </div>
      <div role="group" aria-label="视角" className="viewcube absolute top-3 right-3 z-2 flex gap-0.5 rounded-lg border border-line bg-(--panel) p-0.5 shadow-panel max-[760px]:hidden">
        <button type="button" data-view="top" title="俯视" aria-label="俯视" disabled={!v} onClick={() => v?.('top')} className={vb}>
          顶
        </button>
        <button type="button" data-view="front" title="正视" aria-label="正视" disabled={!v} onClick={() => v?.('front')} className={vb}>
          前
        </button>
        <span className="mx-0.5 my-1 w-px bg-line" />
        <button type="button" data-view="in" title="拉近" aria-label="拉近" disabled={!v} onClick={() => v?.('in')} className={vb}>
          <Icon n="plus" size={15} />
        </button>
        <button type="button" data-view="out" title="拉远" aria-label="拉远" disabled={!v} onClick={() => v?.('out')} className={vb}>
          <Icon n="minus" size={15} />
        </button>
        <button type="button" data-view="fit" title="对准选中（F）" aria-label="对准选中" disabled={!v} onClick={() => v?.('fit')} className={vb}>
          <Icon n="target" size={15} />
        </button>
        <button type="button" data-view="full" title="全屏" aria-label="全屏" onClick={full} className={vb}>
          <Icon n="full" size={15} />
        </button>
        <button type="button" id="keysBtn" aria-label="快捷键" title="快捷键（?）" aria-expanded={keys} onClick={() => setKeys((x) => !x)} className={vb}>
          <Icon n="help" size={15} />
        </button>
      </div>
      {keys && <Shortcuts onClose={() => setKeys(false)} />}
      {Object.entries(c.overlays).map(([k, n]) => (
        <div key={k} data-overlay={k} className="contents">
          {n}
        </div>
      ))}
    </>
  );
}
