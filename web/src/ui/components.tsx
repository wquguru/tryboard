// shadcn-style base components (modelled on shadcn/ui, MIT; rewritten to DESIGN §2, not copied).
// Interactive parts use Radix primitives so keyboard, focus and aria state come for free.
import { useEffect, useState, type ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Checkbox as RCheckbox, Collapsible as RCollapsible, Slot, Toggle } from 'radix-ui';
import { cn } from './cn';
import { Icon } from '../app/icons';
import { currentTheme, initTheme, onTheme, setTheme } from '../theme';
import { t } from '../i18n';

const button = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-sm transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-accent-strong bg-accent-strong text-on-accent hover:opacity-90',
        outline: 'border-line bg-surface text-fg hover:border-hover-line',
        ghost: 'border-transparent bg-transparent text-muted hover:bg-field hover:text-fg',
        field: 'border-line bg-field text-fg hover:border-accent',
      },
      size: { sm: 'h-[30px] px-2.5 text-xs', md: 'h-9 px-3.5', lg: 'h-10 px-4' },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

/** Same styles for buttons built by imperative modules (e.g. the sound key in audio.ts). */
export const buttonVariants = button;

export function Button({ className, variant, size, asChild, ...p }: ComponentProps<'button'> & VariantProps<typeof button> & { asChild?: boolean }) {
  const C = asChild ? Slot.Root : 'button';
  return <C className={cn(button({ variant, size }), className)} {...p} />;
}

const badge = cva('inline-flex items-center rounded-full px-2 py-px text-xs whitespace-nowrap', {
  variants: {
    variant: {
      outline: 'border border-line text-muted',
      solid: 'border border-accent-strong bg-accent-strong text-on-accent font-bold',
      ok: 'bg-ok-bg text-ok-ink',
      info: 'bg-accent-bg text-accent-ink',
      warn: 'bg-warn-bg text-warn-ink',
      bad: 'bg-bad-bg text-bad-ink',
    },
  },
  defaultVariants: { variant: 'outline' },
});

export const Badge = ({ className, variant, ...p }: ComponentProps<'span'> & VariantProps<typeof badge>) => <span className={cn(badge({ variant }), className)} {...p} />;

export const Card = ({ className, ...p }: ComponentProps<'div'>) => <div className={cn('rounded-[14px] border border-line bg-surface px-[22px] py-5', className)} {...p} />;

/** Pressable pill (multi-select tag); Radix Toggle maintains aria-pressed. */
export function Chip({ className, ...p }: ComponentProps<typeof Toggle.Root>) {
  return (
    <Toggle.Root
      className={cn(
        'inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full border border-line bg-surface px-[11px] py-[3px] text-[13px] text-fg',
        'data-[state=on]:border-accent data-[state=on]:bg-accent-bg data-[state=on]:text-accent-ink',
        className,
      )}
      {...p}
    />
  );
}

export function Checkbox({ className, label, ...p }: ComponentProps<typeof RCheckbox.Root> & { label: string }) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-[13px]">
      <RCheckbox.Root
        className={cn('grid size-4 place-items-center rounded border border-hover-line bg-surface data-[state=checked]:border-accent-strong data-[state=checked]:bg-accent-strong', className)}
        {...p}
      >
        <RCheckbox.Indicator className="text-[11px] leading-none text-on-accent">✓</RCheckbox.Indicator>
      </RCheckbox.Root>
      {label}
    </label>
  );
}

export const Collapsible = RCollapsible;

/** Status list: symbol plus colour (DESIGN §2), never colour alone. */
export function StatusList({ kind, items, className }: { kind: 'ok' | 'warn' | 'err'; items: string[]; className?: string }) {
  const mark = { ok: <span className="absolute left-0 text-ok-ink">✓</span>, warn: <span className="absolute left-1 font-bold text-warn-ink">!</span>, err: <span className="absolute left-0 text-bad-ink">✗</span> }[kind];
  return (
    <ul className={cn('m-0 list-none p-0', className)}>
      {items.map((text, i) => (
        <li key={i} className="relative py-[3px] pl-[22px] text-sm">
          {mark}
          {text}
        </li>
      ))}
    </ul>
  );
}

export const Table = ({ className, ...p }: ComponentProps<'table'>) => (
  <table className={cn('w-full border-collapse text-[13px] [&_td]:border-b [&_td]:border-line [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_th]:border-b [&_th]:border-line [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted', className)} {...p} />
);

/** Light / dark toggle; same storage as the old pages' themeToggle(). */
export function ThemeToggle({ className }: { className?: string }) {
  initTheme();
  const [dark, setDark] = useState(currentTheme() === 'dark');
  useEffect(() => {
    const off = onTheme((th) => setDark(th === 'dark'));
    return () => void off();
  }, []);
  const title = dark ? t('Switch to light') : t('Switch to dark');
  return (
    <Button size="sm" className={cn('theme-btn size-8 flex-none px-0', className)} title={title} aria-label={title} aria-pressed={dark} onClick={() => setTheme(dark ? 'light' : 'dark')}>
      {/* Same icon button as the lab top bar (DESIGN_V2 §6.3: one theme switch site-wide). */}
      <Icon n={dark ? 'moon' : 'sun'} />
    </Button>
  );
}
