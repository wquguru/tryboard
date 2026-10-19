// Language picker. A native <select> keeps keyboard, screen-reader and mobile behaviour for free.
import { cn } from './cn';
import { LOCALES, locale, setLocale, t, type Locale } from '../i18n';

export function LangSelect({ className }: { className?: string }) {
  return (
    <label className={cn('relative inline-flex flex-none items-center text-muted hover:text-fg', className)}>
      <svg className="pointer-events-none absolute left-2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
      <select
        aria-label={t('Language')}
        data-lang-select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="h-8 cursor-pointer appearance-none rounded-md border border-line bg-transparent pr-2 pl-7 text-[12px] text-inherit max-md:h-11 max-md:text-[14px]"
      >
        {LOCALES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
