// 「换固件 ▾」菜单（U-08，设计稿 docs/design-v2/unify/Bench、MobileFw）：取代旧实验台的示例下拉 + 上传按钮。
// 一个菜单装下所有「换一个程序跑」的路：按芯片列示例、作品自带的参考固件、最近用过、上传自己的 .bin。
// 桌面是顶栏按钮下的下拉，手机是底部抽屉；开关状态在 bc.fwMenu，空台面卡、手机 ⋯ 菜单也能打开它。
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../ui/cn';
import { actions, bc, BLANK, setBc } from './chrome';
import { CHIP_NAME, chipOf, exampleHref, loadExamples, type Chip, type Example } from './examples';
import { Icon } from './icons';
import { useStore } from './react';
import { menuItem, menuPanel } from './topbar';

const RECENT_KEY = 'tryboard-recent-fw';
type Recent = { kind: 'example'; id: string; title: string; at: number } | { kind: 'file'; name: string; at: number };

export function recentFw(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.slice(0, 3) : [];
  } catch {
    return [];
  }
}
/** 打开示例 / 上传文件时记一笔；文件只记名字（内容不存，浏览器也不让重读），点它重新选文件 */
export function pushRecent(r: Recent) {
  const key = (x: Recent) => (x.kind === 'example' ? `e:${x.id}` : `f:${x.name}`);
  const list = [r, ...recentFw().filter((x) => key(x) !== key(r))].slice(0, 3);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式：不记 */
  }
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const open = (v: boolean) => setBc({ fwMenu: v });

/** 顶栏按钮 + 下拉 / 抽屉。文件框一直挂着：菜单关了 change 照样到 */
export function FwMenu({ phone }: { phone?: boolean }) {
  const { fwMenu, fw, chip: cur } = useStore(bc);
  const file = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [exs, setExs] = useState<Example[]>([]);
  const [chip, setChip] = useState<Chip>(cur);
  const [all, setAll] = useState(false);
  useEffect(() => void loadExamples().then(setExs), []);
  // 每次打开都从台面上的芯片开始
  useEffect(() => {
    if (fwMenu) {
      setChip(cur);
      setAll(false);
    }
  }, [fwMenu, cur]);
  useEffect(() => {
    if (!fwMenu) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-fw-open]') && open(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && open(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [fwMenu]);
  const running = (e: Example) => fw === `${e.id}/flash.bin`;
  // 正在跑的示例排最前，收起时也看得到「正在跑」
  const list = exs.filter((e) => chipOf(e) === chip).sort((a, b) => +running(b) - +running(a));
  const shown = all ? list : list.slice(0, 5);
  const recent = recentFw().filter((r) => !(r.kind === 'example' && fw === `${r.id}/flash.bin`));
  const item = cn(menuItem, 'no-underline', phone && 'min-h-11');
  const sec = 'px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted';
  const panel = (
    <div
      ref={ref}
      role="menu"
      id="fwMenu"
      aria-label="换固件"
      className={
        phone
          ? 'fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-auto rounded-t-2xl border-t border-line bg-surface px-2 pt-2 pb-[calc(12px+env(safe-area-inset-bottom))] text-[14px] text-fg shadow-[0_-8px_24px_#00000026]'
          : cn(menuPanel, 'right-0 max-h-[min(640px,80vh)] w-[340px] overflow-auto')
      }
    >
      {phone && <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 rounded-full bg-line" />}
      <div className="flex items-center gap-2 px-2.5 py-1">
        <b className={phone ? 'text-[16px]' : 'text-[13px]'}>换固件</b>
        <div role="radiogroup" aria-label="芯片" className="ml-auto flex rounded-lg bg-field p-0.5">
          {(['esp32c3', 'esp32s3'] as Chip[]).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={chip === c}
              data-chip={c}
              onClick={() => (setChip(c), setAll(false))}
              className={cn(
                'cursor-pointer rounded-md border-0 bg-transparent px-2.5 font-mono text-[11.5px] text-muted',
                phone ? 'min-h-11 min-w-[88px]' : 'h-6',
                chip === c && 'bg-surface font-medium text-fg shadow-[0_1px_2px_#0000001a]',
              )}
            >
              {phone ? CHIP_NAME[c] : CHIP_NAME[c].replace('ESP32-', '')}
            </button>
          ))}
        </div>
      </div>
      <div className={sec}>示例</div>
      {shown.map((e) => {
        const on = running(e);
        return (
          <a key={e.id} role="menuitem" data-ex={e.id} href={exampleHref(e.id)} aria-current={on || undefined} className={cn(item, on && 'bg-accent-bg')}>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{e.title}</span>
              <span className="block truncate text-[11px] text-muted">
                {e.tags.filter((t) => !t.startsWith('✓')).slice(0, 3).join(' · ')}
                {on && ' · 正在跑'}
              </span>
            </span>
          </a>
        );
      })}
      {list.length > 5 && !all && (
        <button type="button" role="menuitem" data-fw="all" className={cn(item, 'text-accent-ink')} onClick={() => setAll(true)}>
          {`全部 ${list.length} 个 ${CHIP_NAME[chip].replace('ESP32-', '')} 示例…`}
        </button>
      )}
      {!BLANK && actions.loadRef && (
        <>
          <div className={sec}>这个作品</div>
          <button type="button" role="menuitem" data-fw="ref" className={item} onClick={() => (open(false), actions.loadRef?.())}>
            <Icon n="restart" size={15} />
            <span className="min-w-0 flex-1">
              换回参考固件
              <span className="block text-[11px] text-muted">作品自带的固件；检查点只认你自己上传的</span>
            </span>
          </button>
        </>
      )}
      {recent.length > 0 && <div className={sec}>最近用过</div>}
      {recent.map((r) =>
        r.kind === 'example' ? (
          <a key={`e:${r.id}`} role="menuitem" data-recent={r.id} href={exampleHref(r.id)} className={item}>
            <Icon n="restart" size={15} />
            <span className="min-w-0 flex-1 truncate">{`示例 · ${r.title}`}</span>
            <span className="flex-none font-mono text-[11px] text-muted">{hhmm(r.at)}</span>
          </a>
        ) : (
          <button key={`f:${r.name}`} type="button" role="menuitem" data-recent-file={r.name} title="浏览器不保存文件内容：点它重新选这个文件" className={item} onClick={() => file.current?.click()}>
            <Icon n="doc" size={15} />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{r.name}</span>
            <span className="flex-none font-mono text-[11px] text-muted">{hhmm(r.at)}</span>
          </button>
        ),
      )}
      <div className="my-1 h-px bg-line" />
      <button type="button" role="menuitem" data-fw="upload" className={item} disabled={!actions.pickFirmware} onClick={() => file.current?.click()}>
        <Icon n="upload" size={15} />
        <span className="min-w-0 flex-1">
          上传自己的 .bin…
          <span className="block text-[11px] text-muted">ESP-IDF / Arduino 导出的完整 flash 镜像，芯片按文件头识别；拖到台面上也行（文件不会上传）</span>
        </span>
      </button>
    </div>
  );
  return (
    <div className={cn('relative flex-none', phone && 'contents')}>
      <input
        ref={file}
        type="file"
        accept=".bin"
        hidden
        id="fwPick"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          open(false);
          if (f) actions.pickFirmware?.(f);
        }}
      />
      {!phone && (
        <button
          type="button"
          id="swapFw"
          data-fw-open=""
          aria-haspopup="menu"
          aria-expanded={fwMenu}
          title="换一个程序在台面上跑：示例、参考固件或你自己的 .bin"
          onClick={() => open(!fwMenu)}
          className="inline-flex h-8 flex-none cursor-pointer items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-[13px] whitespace-nowrap text-fg hover:bg-field max-[1100px]:hidden"
        >
          换固件
          <Icon n="down" size={14} className="text-muted" />
        </button>
      )}
      {/* 手机抽屉挂到 body：顶栏自成层叠上下文（z-20），留在里面会被串口抽屉、底栏盖住 */}
      {fwMenu &&
        phone &&
        createPortal(
          <>
            <div aria-hidden="true" className="fixed inset-0 z-40 bg-[#0000004d]" onClick={() => open(false)} />
            {panel}
          </>,
          document.body,
        )}
      {fwMenu && !phone && panel}
    </div>
  );
}

/** 打开换固件菜单（空台面卡、手机 ⋯ 用）。带 data-fw-open 的元素点了不会被「点外面关掉」立刻关上 */
export const openFwMenu = () => open(true);
