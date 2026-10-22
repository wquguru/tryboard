// Three-way theme switch (system / light / dark) shared by the site drawer and the lab's phone ⋯ sheet.
// Lives apart from site.tsx so the lab bundle doesn't pull in the site header and Radix Dialog.
import { useEffect, useState } from 'react';
import { cn } from './cn';
import { initTheme, onTheme, setThemePref, themePref, type ThemePref } from '../theme';
import { t } from '../i18n';

/** Three-way theme switch for the phone drawer; the desktop header keeps the one-tap light / dark button. */
export function ThemeSegment() {
  initTheme();
  const [pref, setPref] = useState<ThemePref>(themePref);
  useEffect(() => {
    const off = onTheme(() => setPref(themePref()));
    return () => void off();
  }, []);
  const opts: [ThemePref, string][] = [
    ['system', t('System')],
    ['light', t('Light')],
    ['dark', t('Dark')],
  ];
  return (
    <div role="radiogroup" aria-label={t('Dark mode')} className="flex rounded-[10px] bg-field p-[3px] text-[13px]">
      {opts.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={pref === v}
          data-theme-pref={v}
          onClick={() => {
            setThemePref(v);
            setPref(v);
          }}
          className={cn('min-h-[38px] cursor-pointer rounded-lg px-3 text-muted max-md:min-h-11', pref === v && 'bg-surface font-medium text-fg shadow-[0_1px_3px_#0000001a] ring-1 ring-line')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
