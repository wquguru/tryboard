// Header / footer of document pages (home, board picker). tools/gen_licenses.mjs copies these classes and the logo: keep in sync.
// Phone (< 768px, DESIGN_V2 §0/§5): nav moves into a full-screen drawer; Radix Dialog handles focus and Esc.
import { Dialog } from 'radix-ui';
import { cn } from './cn';
import { ThemeToggle } from './components';
import { LangSelect } from './lang';
import { Logo } from './logo';
import { ThemeSegment } from './theme-segment';
import { CHANGELOG, CHANGELOG_FEED, HOME, LICENSES } from './links';
import { locale, t } from '../i18n';

const navLink = 'rounded-md px-2.5 py-[5px] text-muted hover:bg-field hover:text-fg';
const navOn = 'text-fg font-medium shadow-[inset_0_-2px_0_var(--accent)] rounded-none hover:bg-transparent';

const Icon = ({ d, size = 22 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <a className="inline-flex flex-none items-center gap-1.5 max-md:min-h-11 max-md:gap-2" href={HOME} aria-label={t('TryBoard home')}>
      <Logo size={22} className="max-md:size-[26px]" />
      <b className="text-[14px] max-md:text-[17px]">{t('TryBoard')}</b>
      {/* Only the Chinese UI shows the Latin wordmark next to the native name (I18N §2 brand rule). */}
      {locale === 'zh' && <span className={cn('font-mono text-[10px] tracking-[0.08em] text-muted', subtitle && 'max-md:hidden')}>TRYBOARD</span>}
      {subtitle && <span className="ml-0.5 hidden text-[13px] text-muted max-md:inline">· {subtitle}</span>}
    </a>
  );
}

function MobileMenu({ links, current }: { links: [string, string][]; current?: string }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" id="siteMenu" aria-label={t('Menu')} className="ml-auto hidden size-11 flex-none cursor-pointer items-center justify-center rounded-[10px] text-fg hover:bg-field max-md:inline-flex">
          <Icon d="M4 7h16M4 12h16M4 17h16" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Content
          id="siteDrawer"
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg text-fg data-[state=open]:animate-[tb-drop_.18s_ease-out]"
        >
          <Dialog.Title className="sr-only">{t('Site menu')}</Dialog.Title>
          <div className="flex h-[52px] flex-none items-center gap-2 border-b border-line-soft pr-2 pl-4">
            <Brand />
            <Dialog.Close asChild>
              <button type="button" aria-label={t('Close menu')} className="ml-auto inline-flex size-11 cursor-pointer items-center justify-center rounded-[10px] hover:bg-field">
                <Icon d="M6 6l12 12M18 6L6 18" />
              </button>
            </Dialog.Close>
          </div>
          <nav aria-label={t('Site')} className="flex flex-col px-4 py-2">
            {links.map(([href, text]) => {
              const on = href === current;
              return (
                <Dialog.Close asChild key={href}>
                  <a
                    href={href}
                    aria-current={on ? 'page' : undefined}
                    className={cn('flex h-16 items-center justify-between border-b border-line-soft text-[20px] font-bold', on ? 'text-accent-ink' : 'text-fg')}
                  >
                    {text}
                    {on ? <span className="text-[12px] font-medium">{t('Current page')}</span> : <span className="text-muted"><Icon d="M9 6l6 6-6 6" size={18} /></span>}
                  </a>
                </Dialog.Close>
              );
            })}
          </nav>
          <p className="mx-4 my-3 rounded-xl bg-field p-3.5 text-[13px] leading-[1.6] text-muted">
            {t('On a phone you can watch, tweak values and press buttons; wiring and swapping firmware work best on a computer.')}
          </p>
          <div className="mt-auto flex flex-col gap-1 border-t border-line-soft px-4 pt-4 pb-10">
            <div className="flex min-h-12 items-center justify-between text-[15px]">
              {t('Dark mode')}
              <ThemeSegment />
            </div>
            <div className="flex min-h-12 items-center justify-between gap-3 text-[15px]">
              {t('Language')}
              <LangSelect />
            </div>
            <a href={LICENSES} className="flex h-11 items-center text-[15px] text-muted hover:text-fg">
              {t('Licenses & credits')}
            </a>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SiteHeader({ links, current, subtitle }: { links: [string, string][]; current?: string; subtitle?: string }) {
  return (
    <header className="pg-head sticky top-0 z-[5] flex items-center gap-6 border-b border-line bg-head-bg px-6 py-3.5 backdrop-blur max-md:h-[52px] max-md:gap-2 max-md:py-0 max-md:pr-2 max-md:pl-4">
      <Brand subtitle={subtitle} />
      <nav aria-label={t('Site')} className="flex flex-wrap gap-0.5 max-md:hidden">
        {links.map(([href, text]) => (
          <a key={href} href={href} className={cn(navLink, href === current && navOn)} aria-current={href === current ? 'page' : undefined}>
            {text}
          </a>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2 max-md:hidden">
        <LangSelect />
        <ThemeToggle />
      </div>
      <MobileMenu links={links} current={current} />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="pg-foot flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-t border-line px-6 py-3.5 text-[11px] text-muted max-sm:px-4 max-sm:py-3">
      <span>
        <b>{t('TryBoard')}</b>
        {locale === 'zh' && ' TryBoard'}
      </span>
      <a className="text-fg hover:text-accent-ink max-md:inline-flex max-md:min-h-11 max-md:items-center" href={LICENSES}>
        {t('Licenses & credits')}
      </a>
      <a className="text-fg hover:text-accent-ink max-md:inline-flex max-md:min-h-11 max-md:items-center" href={CHANGELOG}>
        {t('Changelog')}
      </a>
      <a className="text-fg hover:text-accent-ink max-md:inline-flex max-md:min-h-11 max-md:items-center" href={CHANGELOG_FEED} type="application/atom+xml">
        {t('Atom feed')}
      </a>
      <span className="flex-1" />
      <span lang="en">ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</span>
    </footer>
  );
}
