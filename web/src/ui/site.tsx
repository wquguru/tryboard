// 文档型页面（首页、选板）的页头 / 页脚。授权页是 tools/gen_licenses.mjs 生成的静态页，用同一串类名和 logo（改这里要同步改那边）。
// 手机（< 768px，DESIGN_V2 §0）：导航收进汉堡菜单，菜单是全屏抽屉（Radix Dialog 管焦点和 Esc），见 DESIGN_V2 §5 / MobileSite 第 2 屏。
import { useEffect, useState } from 'react';
import { Dialog } from 'radix-ui';
import { cn } from './cn';
import { ThemeToggle } from './components';
import { Logo } from './logo';
import { initTheme, onTheme, setThemePref, themePref, type ThemePref } from '../theme';
import { HOME, LICENSES } from './links';

const navLink = 'rounded-md px-2.5 py-[5px] text-muted hover:bg-field hover:text-fg';
const navOn = 'text-fg font-medium shadow-[inset_0_-2px_0_var(--accent)] rounded-none hover:bg-transparent';

const Icon = ({ d, size = 22 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <a className="inline-flex flex-none items-center gap-1.5 max-md:min-h-11 max-md:gap-2" href={HOME} aria-label="试板 TryBoard 首页">
      <Logo size={22} className="max-md:size-[26px]" />
      <b className="text-[14px] max-md:text-[17px]">试板</b>
      <span className={cn('font-mono text-[10px] tracking-[0.08em] text-muted', subtitle && 'max-md:hidden')}>TRYBOARD</span>
      {subtitle && <span className="ml-0.5 hidden text-[13px] text-muted max-md:inline">· {subtitle}</span>}
    </a>
  );
}

/** 主题三段切换（跟随系统 / 浅 / 深）：手机菜单底部用；桌面页头仍是一键亮 / 暗 */
export function ThemeSegment() {
  initTheme();
  const [pref, setPref] = useState<ThemePref>(themePref);
  useEffect(() => {
    const off = onTheme(() => setPref(themePref()));
    return () => void off();
  }, []);
  const opts: [ThemePref, string][] = [
    ['system', '跟随系统'],
    ['light', '浅'],
    ['dark', '深'],
  ];
  return (
    <div role="radiogroup" aria-label="深色模式" className="flex rounded-[10px] bg-field p-[3px] text-[13px]">
      {opts.map(([v, t]) => (
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
          {t}
        </button>
      ))}
    </div>
  );
}

function MobileMenu({ links, current }: { links: [string, string][]; current?: string }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" id="siteMenu" aria-label="菜单" className="ml-auto hidden size-11 flex-none cursor-pointer items-center justify-center rounded-[10px] text-fg hover:bg-field max-md:inline-flex">
          <Icon d="M4 7h16M4 12h16M4 17h16" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Content
          id="siteDrawer"
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg text-fg data-[state=open]:animate-[tb-drop_.18s_ease-out]"
        >
          <Dialog.Title className="sr-only">站点菜单</Dialog.Title>
          <div className="flex h-[52px] flex-none items-center gap-2 border-b border-line-soft pr-2 pl-4">
            <Brand />
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭菜单" className="ml-auto inline-flex size-11 cursor-pointer items-center justify-center rounded-[10px] hover:bg-field">
                <Icon d="M6 6l12 12M18 6L6 18" />
              </button>
            </Dialog.Close>
          </div>
          <nav aria-label="站点" className="flex flex-col px-4 py-2">
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
                    {on ? <span className="text-[12px] font-medium">当前页</span> : <span className="text-muted"><Icon d="M9 6l6 6-6 6" size={18} /></span>}
                  </a>
                </Dialog.Close>
              );
            })}
          </nav>
          <p className="mx-4 my-3 rounded-xl bg-field p-3.5 text-[13px] leading-[1.6] text-muted">
            手机上可查看、调参数和按按键；连线和换固件建议用电脑。
          </p>
          <div className="mt-auto flex flex-col gap-1 border-t border-line-soft px-4 pt-4 pb-10">
            <div className="flex min-h-12 items-center justify-between text-[15px]">
              深色模式
              <ThemeSegment />
            </div>
            <a href={LICENSES} className="flex h-11 items-center text-[15px] text-muted hover:text-fg">
              授权与致谢
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
      <nav aria-label="站点" className="flex flex-wrap gap-0.5 max-md:hidden">
        {links.map(([href, text]) => (
          <a key={href} href={href} className={cn(navLink, href === current && navOn)} aria-current={href === current ? 'page' : undefined}>
            {text}
          </a>
        ))}
      </nav>
      <ThemeToggle className="ml-auto max-md:hidden" />
      <MobileMenu links={links} current={current} />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="pg-foot flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-t border-line px-6 py-3.5 text-[11px] text-muted max-sm:px-4 max-sm:py-3">
      <span>
        <b>试板</b> TryBoard
      </span>
      <a className="text-fg hover:text-accent-ink max-md:inline-flex max-md:min-h-11 max-md:items-center" href={LICENSES}>
        授权与致谢
      </a>
      <span className="flex-1" />
      <span lang="en">ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</span>
    </footer>
  );
}
