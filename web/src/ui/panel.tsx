// Lab panel pieces (DESIGN §2). Hook classes (kv / v / fp / res / ok / bad / sec / tn / tg / drop / busy…) stay for web tests
// and imperative updates; styling is all Tailwind. Text uses *-ink colours (4.5:1), base colours only for dots and borders.
import { Children, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { cn } from './cn';
import { Live, NInput, useInitText } from './native';

/** Panel button class (also used by imperative code, e.g. the asm3d mounting picker). */
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
/** Key-value row, value monospaced and right-aligned; with `live` it is a live field filled by imperative code. */
export function Kv({ k, v, live, cls }: { k: ReactNode; v?: ReactNode; live?: string; cls?: string }) {
  const c = cn(vCls, 'font-mono', cls === 'fp' && 'fp font-medium', cls === 'bad' && 'bad text-bad-ink', cls === 'warnc' && 'warnc text-warn-ink');
  return (
    <div className="kv mb-1 flex justify-between gap-2.5 rounded-md bg-field px-2.5 py-1.5">
      <span className="k flex-none text-muted">{k}</span>
      {live ? <Live k={live} className={c} init={typeof v === 'string' ? v : ''} /> : <span className={c}>{v}</span>}
    </div>
  );
}
/** Long text: key above, value below in body font. */
export function KvT({ k, children, className }: { k: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('kv col mb-1 flex flex-col gap-0.5 rounded-md bg-field px-2.5 py-1.5', className)}>
      <span className="k flex-none text-muted">{k}</span>
      {children !== undefined && <span className={cn(vCls, 'txt text-left text-[13px]')}>{children}</span>}
    </div>
  );
}
/** Key box (key on top) holding arbitrary content such as sliders. */
export const KvBox = ({ className, ...p }: ComponentProps<'div'>) => <div className={cn('kv col mb-1 flex flex-col gap-0.5 rounded-md bg-field px-2.5 py-1.5 [&_.k]:text-muted', className)} {...p} />;

export type ResKind = 'ok' | 'bad' | 'na' | 'warn';
const resMark: Record<ResKind, string> = { ok: '✓', bad: '✗', na: '·', warn: '!' };
/** One check result: symbol plus colour, never colour alone. */
export function Res({ kind, mk, children, id, className }: { kind: ResKind; mk?: string; children?: ReactNode; id?: string; className?: string }) {
  return (
    <div
      id={id}
      className={cn(
        'res mb-[3px] flex gap-2 rounded-md bg-field px-2.5 py-[5px] text-xs [&_b]:font-medium',
        kind,
        // .bad was global red text in the old CSS: the whole failed row is red.
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

/** Slider plus readout. Uncontrolled with native listeners (tests set value and dispatch); the readout is updated by callers. */
export function Slider({ out, on, className, outId, ...p }: Omit<ComponentProps<typeof NInput>, 'type'> & { out: string; outId?: string }) {
  const o = useInitText<HTMLOutputElement>(out);
  return (
    <label className={cn('slider flex w-full items-center gap-2', className)}>
      <NInput type="range" className="min-w-0 flex-1 accent-(--accent)" on={on} {...p} />
      <output ref={o} id={outId} className="min-w-[76px] text-right font-mono text-xs" />
    </label>
  );
}

// H-38: panels remount on every render (shell.tsx createPanel key), and a fresh input would lose a file picked while the
// dialog was open. One input per drop kind moves into a remounted box and routes to the latest onFile of the box holding it.
const pickers = new Map<string, HTMLInputElement>();
const pickHandlers = new Map<string, (f: File) => void>();
function picker(kind: string) {
  let inp = pickers.get(kind);
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.bin';
    inp.className = 'pointer-events-none absolute h-px w-px overflow-hidden opacity-0';
    inp.addEventListener('change', () => {
      const f = inp!.files?.[0];
      inp!.value = '';
      if (f) pickHandlers.get(kind)?.(f);
    });
    pickers.set(kind, inp);
  }
  return inp;
}

/** Firmware drop / pick box; the file input uses a native change listener (fired by tests' uploadFile). */
export function Drop({ kind, busy, disabled, title, sub, onFile, className }: { kind: string; busy?: boolean; disabled?: boolean; title: ReactNode; sub: ReactNode; onFile?: (f: File) => void; className?: string }) {
  const box = useRef<HTMLLabelElement>(null);
  const own = (inp: HTMLInputElement) => {
    if (inp.parentNode !== box.current) box.current!.appendChild(inp);
    inp.disabled = !!disabled;
    if (onFile) pickHandlers.set(kind, onFile);
    else pickHandlers.delete(kind);
  };
  // H-43: adopt the input only when its box is gone, so a second live box of this kind can't steal it
  useLayoutEffect(() => {
    const inp = picker(kind);
    if (inp.parentNode === box.current || !inp.parentNode?.isConnected) own(inp);
  });
  const over = (e: React.DragEvent<HTMLLabelElement>, on: boolean) => {
    e.preventDefault();
    e.currentTarget.classList.toggle('over', on);
  };
  return (
    <label
      ref={box}
      data-drop={kind}
      // H-43: pointerdown precedes the label's activation, so the click opens the input moved into this box
      onPointerDown={() => !disabled && own(picker(kind))}
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
      <b>{title}</b>
      <span>{sub}</span>
    </label>
  );
}

// ---------------------------------------------------------------- build tree
export function TreeGroup({ g, title, count, open, onToggle, children }: { g?: string; title: ReactNode; count?: ReactNode; open: boolean; onToggle?: (open: boolean) => void; children: ReactNode }) {
  // One tree per group: summary is a native toggle and may not be a tree child (axe aria-required-children).
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

/** Clickable build-tree entry. */
export function TreeNode({ on, label, meta, st, className, ...p }: Omit<ComponentProps<'button'>, 'children'> & { on?: boolean; label: ReactNode; meta?: ReactNode; st?: ReactNode }) {
  return (
    <button type="button" role="treeitem" aria-selected={!!on} className={cn(tnClass(on), className)} {...p}>
      <TnL>{label}</TnL>
      {meta ? <TnM>{meta}</TnM> : null}
      {st}
    </button>
  );
}
/** Read-only entry. */
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

/** Multimeter readout: seven-segment feel, still monospace. */
export function Meter({ sm }: { sm?: boolean }) {
  return (
    <div className={cn('meter rounded-md border border-line bg-field text-right', sm ? 'sm my-1 px-2 py-1.5' : 'mt-1.5 mb-2 px-3 py-2.5')}>
      <Live k="mv" init="—" className={cn('font-mono font-medium tracking-[0.02em]', sm ? 'text-lg' : 'text-[26px]')} />
    </div>
  );
}

/** Info card over the stage (locked, placeholder, no template). */
export const LockCard = ({ className, ...p }: ComponentProps<'div'>) => (
  <div className={cn('pnl lockcard max-w-[420px] rounded-(--r) border border-line bg-(--panel) px-5 pt-1 pb-4 shadow-panel max-md:max-w-none [&_.ph-t]:mt-0.5', className)} {...p} />
);
export const PhT = ({ className, ...p }: ComponentProps<'p'>) => <p className={cn('ph-t my-1 text-[15px] font-medium', className)} {...p} />;
