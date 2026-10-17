// 实验台面板的小件（属性面板、构建树、快捷卡片共用，DESIGN §2）。
// 每个件保留原来的钩子类名（kv / v / fp / res / ok / bad / sec / tn / tg / drop / busy…）：网页测试和
// 命令式实时更新（按 data-live 找节点、classList.toggle('bad')）靠它们定位，样式全在 Tailwind 类里。
// 文字色一律用 *-ink（浅底上 4.5:1），原色只给点、边框和图形。
import { Children, type ComponentProps, type ReactNode } from 'react';
import { cn } from './cn';
import { Live, NInput, useInitText } from './native';

/** 面板里的按钮（也给命令式代码拼按钮用：asm3d 的"怎么装"选择框） */
export const btnClass = (primary = false, extra = '') =>
  cn(
    'btn inline-flex h-[30px] cursor-pointer items-center justify-center rounded-md border border-line bg-surface px-3 text-fg no-underline hover:border-hover-line',
    'disabled:cursor-not-allowed disabled:text-muted aria-pressed:border-accent aria-pressed:bg-accent-bg aria-pressed:text-accent-ink',
    '[&.warnb]:border-(--warn-line)',
    primary && 'primary border-accent-strong bg-accent-strong text-on-accent hover:border-accent-strong',
    extra,
  );

export function Btn({ primary, className, type = 'button', ...p }: ComponentProps<'button'> & { primary?: boolean }) {
  return <button type={type} className={btnClass(primary, className)} {...p} />;
}
export const LinkBtn = ({ primary, className, ...p }: ComponentProps<'a'> & { primary?: boolean }) => <a className={btnClass(primary, className)} {...p} />;

export const Btns = ({ col, className, ...p }: ComponentProps<'div'> & { col?: boolean }) => <div className={cn('btns mt-2 flex flex-wrap gap-1.5', col && 'col flex-col', className)} {...p} />;

export const Sec = ({ className, ...p }: ComponentProps<'div'>) => <div className={cn('sec mt-3.5 mb-1.5 text-[11px] font-medium text-muted', className)} {...p} />;

export const Ph = ({ mono, className, ...p }: ComponentProps<'div'> & { mono?: boolean }) => <div className={cn('ph mb-2 text-[15px] font-medium break-all', mono && 'font-mono', className)} {...p} />;

export const Note = ({ bad, className, ...p }: ComponentProps<'p'> & { bad?: boolean }) => <p className={cn('note my-2 text-xs text-muted', bad && 'bad text-bad-ink', className)} {...p} />;

export const Muted = ({ className, ...p }: ComponentProps<'span'>) => <span className={cn('text-muted', className)} {...p} />;
export const Mono = ({ className, ...p }: ComponentProps<'span'>) => <span className={cn('font-mono', className)} {...p} />;
export const Bad = ({ className, ...p }: ComponentProps<'span'>) => <span className={cn('bad text-bad-ink', className)} {...p} />;
export const Ok = ({ className, ...p }: ComponentProps<'span'>) => <span className={cn('ok text-ok-ink', className)} {...p} />;

export const Field = ({ className, ...p }: ComponentProps<'div'>) => <div className={cn('field rounded-md bg-field px-2.5 py-2', className)} {...p} />;

const preCls = 'm-0 max-h-[220px] overflow-auto rounded-md bg-field px-2.5 py-2 font-mono text-[11px] leading-[1.55] break-words whitespace-pre-wrap';
export const Brief = ({ className, ...p }: ComponentProps<'pre'>) => <pre className={cn('brief', preCls, className)} {...p} />;
export const Code = ({ className, ...p }: ComponentProps<'pre'>) => <pre className={cn('code mt-1.5 text-muted', preCls, className)} {...p} />;

const vCls = 'v min-w-0 text-right text-xs break-all [&.bad]:text-bad-ink';
/** 一行键值：值等宽右对齐；live 给了就是实时字段（初值空，由命令式代码填） */
export function Kv({ k, v, live, cls }: { k: ReactNode; v?: ReactNode; live?: string; cls?: string }) {
  const c = cn(vCls, 'font-mono', cls === 'fp' && 'fp font-medium', cls === 'bad' && 'bad text-bad-ink', cls === 'warnc' && 'warnc text-warn-ink');
  return (
    <div className="kv mb-1 flex justify-between gap-2.5 rounded-md bg-field px-2.5 py-1.5">
      <span className="k flex-none text-muted">{k}</span>
      {live ? <Live k={live} className={c} init={typeof v === 'string' ? v : ''} /> : <span className={c}>{v}</span>}
    </div>
  );
}
/** 长文字：键在上、值在下，正文字体 */
export function KvT({ k, children, className }: { k: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('kv col mb-1 flex flex-col gap-0.5 rounded-md bg-field px-2.5 py-1.5', className)}>
      <span className="k flex-none text-muted">{k}</span>
      {children !== undefined && <span className={cn(vCls, 'txt text-left text-[13px]')}>{children}</span>}
    </div>
  );
}
/** 键值框（键在上），下面放任意内容（滑块等） */
export const KvBox = ({ className, ...p }: ComponentProps<'div'>) => <div className={cn('kv col mb-1 flex flex-col gap-0.5 rounded-md bg-field px-2.5 py-1.5 [&_.k]:text-muted', className)} {...p} />;

export type ResKind = 'ok' | 'bad' | 'na' | 'warn';
const resMark: Record<ResKind, string> = { ok: '✓', bad: '✗', na: '·', warn: '!' };
/** 一条检查结果：符号 + 颜色一起表达（不只靠颜色） */
export function Res({ kind, mk, children, id, className }: { kind: ResKind; mk?: string; children?: ReactNode; id?: string; className?: string }) {
  return (
    <div
      id={id}
      className={cn(
        'res mb-[3px] flex gap-2 rounded-md bg-field px-2.5 py-[5px] text-xs [&_b]:font-medium',
        kind,
        // 原样式里 .bad 是全局红字：整条失败结果都是红的
        kind === 'bad' && 'bg-bad-bg text-bad-ink',
        kind === 'warn' && 'bg-warn-bg',
        kind === 'na' && 'text-muted',
        className,
      )}
    >
      <span className={cn('mk w-3 flex-none font-mono', kind === 'ok' && 'text-ok-ink', kind === 'bad' && 'text-bad-ink', kind === 'warn' && 'text-warn-ink')}>{mk ?? resMark[kind]}</span>
      <span>{children}</span>
    </div>
  );
}

export function VerdictLine({ kind, children }: { kind: 'ok' | 'bad' | 'warn'; children: ReactNode }) {
  return <div className={cn('verdict-line mb-1.5 font-medium', kind, kind === 'ok' && 'text-ok-ink', kind === 'bad' && 'text-bad-ink', kind === 'warn' && 'text-warn-ink')}>{children}</div>;
}

export const Seg = ({ className, ...p }: ComponentProps<'div'>) => <div role="radiogroup" className={cn('seg grid grid-cols-2 gap-0.5 rounded-lg bg-field p-0.5', className)} {...p} />;
export const SegB = ({ on, className, ...p }: ComponentProps<'button'> & { on: boolean }) => (
  <button
    type="button"
    aria-pressed={on}
    className={cn('segb cursor-pointer rounded-md border-0 bg-transparent px-2 py-1.5 text-xs text-muted aria-pressed:bg-(--seg-on) aria-pressed:font-medium aria-pressed:text-accent-ink aria-pressed:shadow-[0_1px_2px_#0000001a]', className)}
    {...p}
  />
);

/** 滑块 + 读数。输入框非受控、原生监听（测试脚本直接改 value 再派发事件）；读数文字由 onInput 里的代码或调用方改 */
export function Slider({ out, on, className, outId, ...p }: Omit<ComponentProps<typeof NInput>, 'type'> & { out: string; outId?: string }) {
  const o = useInitText<HTMLOutputElement>(out);
  return (
    <label className={cn('slider flex w-full items-center gap-2', className)}>
      <NInput type="range" className="min-w-0 flex-1 accent-(--accent)" on={on} {...p} />
      <output ref={o} id={outId} className="min-w-[76px] text-right font-mono text-xs" />
    </label>
  );
}

/** 拖放 / 点选固件的框。文件输入框挂原生 change（测试 uploadFile 派发的事件） */
export function Drop({ kind, busy, disabled, title, sub, onFile, className }: { kind: string; busy?: boolean; disabled?: boolean; title: ReactNode; sub: ReactNode; onFile?: (f: File) => void; className?: string }) {
  const over = (e: React.DragEvent<HTMLLabelElement>, on: boolean) => {
    e.preventDefault();
    e.currentTarget.classList.toggle('over', on);
  };
  return (
    <label
      data-drop={kind}
      className={cn(
        'drop relative mt-1.5 flex cursor-pointer flex-col items-center gap-0.5 rounded-[10px] border-[1.5px] border-dashed border-(--drop-line) bg-(--drop-bg) px-3 py-4 text-center',
        '[&.over]:border-accent [&.over]:bg-accent-bg [&_b]:font-medium [&>span]:text-xs [&>span]:text-muted',
        busy && 'busy cursor-progress border-solid border-accent',
        className,
      )}
      onDragOver={onFile ? (e) => over(e, true) : undefined}
      onDragLeave={onFile ? (e) => e.currentTarget.classList.remove('over') : undefined}
      onDrop={
        onFile
          ? (e) => {
              over(e, false);
              const f = e.dataTransfer?.files?.[0];
              if (f) onFile(f);
            }
          : undefined
      }
    >
      <NInput
        type="file"
        accept=".bin"
        className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
        disabled={disabled}
        on={
          onFile && {
            change: (e) => {
              const inp = e.currentTarget;
              const f = inp.files?.[0];
              inp.value = '';
              if (f) onFile(f);
            },
          }
        }
      />
      <b>{title}</b>
      <span>{sub}</span>
    </label>
  );
}

// ---------------------------------------------------------------- 构建树
export function TreeGroup({ g, title, count, open, onToggle, children }: { g?: string; title: ReactNode; count?: ReactNode; open: boolean; onToggle?: (open: boolean) => void; children: ReactNode }) {
  // 每组一棵 tree：summary 是原生开关，不能当 tree 的子节点（axe aria-required-children）
  return (
    <details className="tg group" data-g={g} open={open} onToggle={(e) => onToggle?.(e.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none justify-between px-1.5 pt-2 pb-1 text-[11px] font-medium text-muted select-none before:mr-1 before:text-[9px] before:content-['▸'] group-open:before:content-['▾'] [&::-webkit-details-marker]:hidden">
        <span className="flex-1">{title}</span>
        <span className="tn-m flex-none font-mono text-[11px] text-muted">{count}</span>
      </summary>
      <div role={Children.toArray(children).length ? 'tree' : undefined} aria-label={typeof title === 'string' ? title : undefined}>
        {children}
      </div>
    </details>
  );
}

export const tnClass = (on = false, isStatic = false) =>
  cn('tn flex min-h-7 w-full items-center gap-1.5 rounded-md border-0 bg-transparent py-[5px] pr-2 pl-[18px] text-left text-fg no-underline', isStatic ? 'static cursor-default' : 'cursor-pointer hover:bg-field', on && 'on bg-accent-bg hover:bg-accent-bg [&_.tn-m]:text-accent-ink');

export const TnL = ({ children }: { children: ReactNode }) => <span className="tn-l min-w-0 flex-1 truncate">{children}</span>;
export const TnM = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cn('tn-m flex-none font-mono text-[11px] text-muted', className)}>{children}</span>;
export type StKind = 'ok' | 'bad' | 'run' | 'warn' | 'muted';
export const TnSt = ({ kind, children }: { kind: StKind; children: ReactNode }) => (
  <span className={cn('tn-st flex-none font-mono text-[11px]', kind, { ok: 'text-ok-ink', bad: 'text-bad-ink', run: 'text-accent-ink', warn: 'text-warn-ink', muted: 'text-muted' }[kind])}>{children}</span>
);

/** 构建树里一个可点的条目 */
export function TreeNode({ on, label, meta, st, className, ...p }: Omit<ComponentProps<'button'>, 'children'> & { on?: boolean; label: ReactNode; meta?: ReactNode; st?: ReactNode }) {
  return (
    <button type="button" role="treeitem" aria-selected={!!on} className={cn(tnClass(on), className)} {...p}>
      <TnL>{label}</TnL>
      {meta ? <TnM>{meta}</TnM> : null}
      {st}
    </button>
  );
}
/** 只看不点的条目 */
export function TreeRow({ label, meta, st, on }: { label: ReactNode; meta?: ReactNode; st?: ReactNode; on?: boolean }) {
  return (
    <div className={tnClass(on, true)} role="treeitem" aria-selected={!!on}>
      <TnL>{label}</TnL>
      {meta ? <TnM>{meta}</TnM> : null}
      {st}
    </div>
  );
}

export const TreeEmpty = ({ children }: { children: ReactNode }) => <div role="treeitem" aria-disabled="true" className="tree-empty px-2.5 py-2 text-xs text-muted">{children}</div>;

/** 万用表读数：七段屏的感觉，仍用等宽字体 */
export function Meter({ sm }: { sm?: boolean }) {
  return (
    <div className={cn('meter rounded-md border border-line bg-field text-right', sm ? 'sm my-1 px-2 py-1.5' : 'mt-1.5 mb-2 px-3 py-2.5')}>
      <Live k="mv" init="—" className={cn('font-mono font-medium tracking-[0.02em]', sm ? 'text-lg' : 'text-[26px]')} />
    </div>
  );
}

/** 叠在台面上的说明卡（锁着、占位、没有模板） */
export const LockCard = ({ className, ...p }: ComponentProps<'div'>) => (
  <div className={cn('pnl lockcard max-w-[420px] rounded-(--r) border border-line bg-(--panel) px-5 pt-1 pb-4 shadow-panel max-md:max-w-none [&_.ph-t]:mt-0.5', className)} {...p} />
);
export const PhT = ({ className, ...p }: ComponentProps<'p'>) => <p className={cn('ph-t my-1 text-[15px] font-medium', className)} {...p} />;
