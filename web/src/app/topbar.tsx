// 实验台 v2 顶栏（DESIGN_V2 §3、§4）：面包屑 + 切换作品、保存状态、撤销 / 重做、四步条、⌘K、运行状态、换固件、⋯ 菜单。
// 数据来自 chrome.ts（bc）；按钮的动作由 main.tsx / 实验台注册，没注册（不在实验台、会话还没起来）就灰掉。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { Logo } from '../ui/logo';
import { currentTheme, onTheme, setTheme } from '../theme';
import { actions, bc } from './chrome';
import { CmdkBox } from './cmdk';
import { Icon } from './icons';
import { useStore } from './react';
import { savedText } from './saved';
import { STEPS, type StepId } from './types';
import { WORKS } from './works';

/** 32×32 图标按钮 */
const ib =
  'ib inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-fg hover:bg-field disabled:cursor-not-allowed disabled:text-muted disabled:opacity-50 disabled:hover:bg-transparent';
export const menuPanel = 'absolute z-30 mt-1 min-w-[220px] rounded-(--r) border border-line bg-surface p-1 text-[13px] text-fg shadow-panel';
export const menuItem = 'flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-fg hover:bg-field disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent';

/** 点外面 / Esc 关掉的下拉 */
export function usePop() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** phone：手机顶栏居中的作品名（≥ 44 高，菜单铺满宽度） */
export function WorkMenu({ name, phone }: { name: string; phone?: boolean }) {
  const { open, setOpen, ref } = usePop();
  const cur = new URLSearchParams(location.search).get('work') ?? 'weather';
  return (
    <div ref={ref} className="relative min-w-0">
      <h1 className="m-0 min-w-0 text-sm">
        <button
          id="workMenuBtn"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          title="切换作品"
          onClick={() => setOpen(!open)}
          className={cn('inline-flex min-h-8 max-w-[220px] cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1 text-fg hover:bg-field', phone && 'min-h-11 max-w-full px-2 text-[15px]')}
        >
          <span id="workName" className="work truncate font-bold">
            {name}
          </span>
          <Icon n="down" size={14} className="flex-none text-muted" />
        </button>
      </h1>
      {open && (
        <div role="menu" aria-label="切换作品" id="workMenu" className={cn(menuPanel, 'left-0 max-h-[70vh] overflow-auto', phone && 'fixed top-12 right-2 left-2 [&_a]:min-h-11')}>
          {Object.values(WORKS).map((w) => (
            <a
              key={w.id}
              role="menuitemradio"
              aria-checked={w.id === cur}
              data-work={w.id}
              href={`./app.html?work=${w.id}${location.hash || '#bench'}`}
              className={cn(menuItem, 'no-underline', w.id === cur && 'font-medium')}
            >
              <span className="inline-flex w-4 flex-none justify-center text-accent-ink">{w.id === cur && <Icon n="check" size={14} />}</span>
              <span className="min-w-0 flex-1 truncate">{w.title}</span>
              <span className="flex-none font-mono text-[11px] text-muted">{w.checkpoints.length ? `${w.checkpoints.length} 个检查点` : '台面'}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Breadcrumb({ name }: { name: string }) {
  const { saved } = useStore(bc);
  // 每 30 s 刷新「刚刚 / n 分钟前」
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="crumb flex min-w-0 flex-none flex-col justify-center">
      <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
        <a href="./home.html" aria-label="试板首页" className="brand flex-none leading-none">
          <Logo size={22} />
        </a>
        <a
          id="crumbHome"
          href="./home.html"
          title="回到作品列表（未保存的连线会留在本机）"
          className="inline-flex min-h-8 flex-none items-center px-0.5 text-accent-ink no-underline underline-offset-3 hover:underline"
        >
          作品
        </a>
        <span className="text-muted">/</span>
        <WorkMenu name={name} />
      </div>
      <span id="savedState" className="-mt-1 pl-[34px] text-[11px] leading-none text-muted">
        {savedText(saved)}
      </span>
    </div>
  );
}

function StepBar({ step }: { step: StepId }) {
  const { locks, done, checkpoints } = useStore(bc);
  const ok = checkpoints.filter((c) => c.state === 'ok').length;
  return (
    <nav id="steps" role="tablist" aria-label="四个步骤" className="steps flex min-w-0 items-center justify-center">
      {STEPS.map((s, i) => {
        const on = s.id === step;
        const lock = locks[s.id];
        return (
          <div key={s.id} className="flex items-center">
            {i > 0 && <span aria-hidden="true" className="mx-1 h-0.5 w-5 rounded-full bg-line max-[1500px]:mx-0.5 max-[1500px]:w-2" />}
            <button
              type="button"
              role="tab"
              data-step={s.id}
              aria-selected={on}
              data-locked={lock ? '' : undefined}
              title={lock ?? (done[s.id] ? `${s.label} · 已完成` : s.label)}
              onClick={() => (location.hash = s.id)}
              className={cn(
                'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-[13px] whitespace-nowrap text-muted hover:bg-field',
                on && 'bg-accent-bg font-medium text-accent-ink hover:bg-accent-bg',
                done[s.id] && !on && 'text-ok-ink',
              )}
            >
              {done[s.id] && !on ? (
                <Icon n="check" size={14} />
              ) : (
                <span className={cn('inline-flex size-[18px] items-center justify-center rounded-full font-mono text-[11px]', on ? 'bg-accent-strong text-on-accent' : 'border border-line')}>{i + 1}</span>
              )}
              {s.label}
              {lock && <Icon n="lock" size={13} className="text-muted" />}
              {on && s.id === 'bench' && checkpoints.length > 0 && <span className="font-mono text-[11px] font-normal">{`${ok}/${checkpoints.length}`}</span>}
            </button>
          </div>
        );
      })}
    </nav>
  );
}

export const RUN_TEXT: Record<string, [string, string]> = {
  loading: ['加载中', 'bg-muted'],
  run: ['运行中', 'bg-ok'],
  pause: ['已暂停', 'bg-warn'],
  seek: ['回退停住', 'bg-accent'],
  busy: ['回退中…', 'bg-accent'],
  idle: ['没在跑', 'bg-muted'],
  nofw: ['没有固件', 'bg-muted'],
};
export const SPEEDS = [1, 2, 0.5];

function RunGroup({ bench }: { bench: boolean }) {
  const { run, speed } = useStore(bc);
  const [t, dot] = RUN_TEXT[run];
  const live = bench && (run === 'run' || run === 'pause' || run === 'seek');
  return (
    <div role="group" aria-label="运行状态" id="runGroup" data-run={run} className="flex h-8 flex-none items-center gap-0.5 rounded-lg border border-line pr-0.5 pl-2.5 max-[1280px]:hidden">
      <span className="inline-flex items-center gap-1.5 pr-1 text-xs whitespace-nowrap">
        <span className={cn('size-2 rounded-full', dot, run === 'run' && 'animate-pulse')} />
        <span id="runState">{t}</span>
      </span>
      {actions.speed && (
        <button
          type="button"
          id="runSpeed"
          className={cn(ib, 'w-auto px-1.5 font-mono text-xs')}
          disabled={!live}
          title="倍速：只改跑得快慢（墙钟），模拟时刻和结果不变"
          onClick={() => actions.speed!(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
        >
          {speed}×
        </button>
      )}
      <button
        type="button"
        id="runPause"
        className={ib}
        disabled={!live}
        title={run === 'run' ? '暂停' : run === 'seek' ? '从这一刻接着跑' : '继续'}
        aria-label={run === 'run' ? '暂停' : '继续'}
        onClick={() => (run === 'run' ? actions.pause?.() : actions.resume?.())}
      >
        <Icon n={run === 'run' ? 'pause' : 'play'} size={15} />
      </button>
      <button type="button" id="runRestart" className={ib} disabled={!bench || !actions.reboot || run === 'loading'} title="重启（重新上电，同「再跑一次」）" aria-label="重启" onClick={() => actions.reboot?.()}>
        <Icon n="restart" size={15} />
      </button>
    </div>
  );
}

/** phone：手机顶栏右边的 ⋯（44 的按钮、铺开的菜单，另加主题和换固件——手机顶栏放不下它们） */
export function MoreMenu({ toast, phone }: { toast: (t: string) => void; phone?: boolean }) {
  const { open, setOpen, ref } = usePop();
  const file = useRef<HTMLInputElement>(null);
  const [dark, setDark] = useState(currentTheme() === 'dark');
  useEffect(() => {
    if (!phone) return;
    const off = onTheme((t) => setDark(t === 'dark'));
    return () => void off();
  }, [phone]);
  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="relative flex-none">
      {/* 换固件的文件框一直挂着：菜单关了 change 照样到 */}
      {phone && (
        <input
          ref={file}
          type="file"
          accept=".bin"
          hidden
          id="fwPick"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            setOpen(false);
            if (f) actions.pickFirmware?.(f);
          }}
        />
      )}
      <button type="button" id="moreBtn" className={cn(ib, phone && 'size-11')} aria-haspopup="menu" aria-expanded={open} aria-label="更多：分享、导出输入日志、交给 AI 的任务书" title="更多" onClick={() => setOpen(!open)}>
        <Icon n="more" />
      </button>
      {open && (
        <div role="menu" id="moreMenu" className={cn(menuPanel, 'right-0 w-[280px]', phone && 'fixed top-12 right-2 w-[min(300px,calc(100vw-16px))] [&_button]:min-h-11')}>
          <button
            type="button"
            role="menuitem"
            data-more="link"
            className={menuItem}
            onClick={go(() => {
              void navigator.clipboard?.writeText(location.href).then(
                () => toast('已复制本页链接（只含作品和步骤；你的改动留在本机）'),
                () => toast('复制失败：浏览器不让写剪贴板'),
              );
            })}
          >
            <Icon n="link" size={15} />
            <span className="flex-1">
              复制本页链接
              <span className="block text-[11px] text-muted">只含作品和步骤，改动不随链接走</span>
            </span>
          </button>
          <button type="button" role="menuitem" data-more="inputs" className={menuItem} disabled={!actions.exportInputs} onClick={go(() => actions.exportInputs?.())}>
            <Icon n="download" size={15} />
            <span className="flex-1">
              导出输入日志
              <span className="block text-[11px] text-muted">命令行 tryboard run --inputs 可逐字节重放</span>
            </span>
          </button>
          <button type="button" role="menuitem" data-more="brief" className={menuItem} disabled={!actions.brief} onClick={go(() => actions.brief?.())}>
            <Icon n="doc" size={15} />
            <span className="flex-1">
              交给 AI 的任务书
              <span className="block text-[11px] text-muted">当前检查点的目标、接线和验收命令</span>
            </span>
          </button>
          {phone && (
            <>
              <button type="button" role="menuitem" id="swapFw" data-more="fw" className={menuItem} disabled={!actions.pickFirmware} onClick={() => file.current?.click()}>
                <Icon n="upload" size={15} />
                <span className="flex-1">
                  换固件
                  <span className="block text-[11px] text-muted">换一个 flash.bin 在台面上跑（文件不会上传）</span>
                </span>
              </button>
              <button type="button" role="menuitem" data-more="theme" className={cn(menuItem, 'theme-btn')} aria-pressed={dark} onClick={go(() => setTheme(dark ? 'light' : 'dark'))}>
                <Icon n={dark ? 'moon' : 'sun'} size={15} />
                <span className="flex-1">{dark ? '切到亮色' : '切到暗色'}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 主题切换：顶栏里只放图标（太阳 / 月亮），文字在 title */
function ThemeBtn() {
  const [dark, setDark] = useState(currentTheme() === 'dark');
  useEffect(() => {
    const off = onTheme((t) => setDark(t === 'dark'));
    return () => void off();
  }, []);
  const title = dark ? '切到亮色' : '切到暗色';
  return (
    <button type="button" className={cn(ib, 'theme-btn')} title={title} aria-label={title} aria-pressed={dark} onClick={() => setTheme(dark ? 'light' : 'dark')}>
      <Icon n={dark ? 'moon' : 'sun'} />
    </button>
  );
}

export function TopBar(p: { step: StepId; workName: string; right: ReactNode; toast: (t: string) => void }) {
  const { undo, redo } = useStore(bc);
  const bench = p.step === 'bench';
  const file = useRef<HTMLInputElement>(null);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <header
      id="topbar"
      className={cn(
        'topbar fixed inset-x-0 top-0 z-4 flex h-(--top-h) items-center gap-2.5 border-b border-line bg-surface px-3',
      )}
    >
      <Breadcrumb name={p.workName} />
      <span aria-hidden="true" className="h-6 w-px flex-none bg-line" />
      <div className="flex flex-none items-center">
        <button type="button" id="undoBtn" className={ib} disabled={!bench || !undo} title={bench ? `撤销（${mac ? '⌘Z' : 'Ctrl Z'}）：回到时间线上一步` : '只有实验台能撤销'} aria-label="撤销" onClick={() => actions.undo?.()}>
          <Icon n="undo" />
        </button>
        <button type="button" id="redoBtn" className={ib} disabled={!bench || !redo} title={bench ? `重做（${mac ? '⇧⌘Z' : 'Ctrl Shift Z'}）` : '只有实验台能重做'} aria-label="重做" onClick={() => actions.redo?.()}>
          <Icon n="redo" />
        </button>
      </div>
      <div className="flex min-w-0 flex-1 justify-center">
        <StepBar step={p.step} />
      </div>
      <CmdkBox />
      <RunGroup bench={bench} />
      <input
        ref={file}
        type="file"
        accept=".bin"
        hidden
        id="fwPick"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) actions.pickFirmware?.(f);
        }}
      />
      <button
        type="button"
        id="swapFw"
        disabled={!actions.pickFirmware}
        title="换一个 flash.bin 在台面上跑（文件不会上传）"
        onClick={() => file.current?.click()}
        className="h-8 flex-none cursor-pointer rounded-lg border-0 bg-accent-strong px-3 text-[13px] font-medium whitespace-nowrap text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:bg-field disabled:text-muted max-[1100px]:hidden"
      >
        换固件
      </button>
      {p.right}
      <MoreMenu toast={p.toast} />
      <ThemeBtn />
    </header>
  );
}
