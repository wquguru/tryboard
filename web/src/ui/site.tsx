// 文档型页面（首页等）的页头 / 页脚。授权页是 tools/gen_licenses.mjs 生成的静态页，用同一串类名和 logo（改这里要同步改那边）。
import { cn } from './cn';
import { ThemeToggle } from './components';
import { Logo } from './logo';

const navLink = 'rounded-md px-2.5 py-[5px] text-muted hover:bg-field hover:text-fg max-sm:px-1.5 max-sm:py-1 max-sm:text-[12px]';

export function SiteHeader({ links, current }: { links: [string, string][]; current?: string }) {
  return (
    <header className="pg-head sticky top-0 z-[5] flex items-center justify-between gap-4 border-b border-line bg-head-bg px-6 py-3.5 max-sm:px-4 max-sm:py-2.5">
      <a className="inline-flex flex-none items-center gap-1.5" href="./home.html">
        <Logo size={22} />
        <b className="text-[14px]">试板</b>
        <span className="font-mono text-[10px] tracking-[0.08em] text-muted">TRYBOARD</span>
      </a>
      <nav aria-label="站点" className="flex flex-wrap justify-end gap-0.5">
        {links.map(([href, text]) => (
          <a key={href} href={href} className={cn(navLink, href === current && 'bg-field text-fg')} aria-current={href === current ? 'page' : undefined}>
            {text}
          </a>
        ))}
      </nav>
      <ThemeToggle className="ml-1.5" />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="pg-foot flex flex-wrap gap-x-[18px] gap-y-1.5 border-t border-line px-6 py-3.5 text-[11px] text-muted max-sm:px-4 max-sm:py-3">
      <span>
        <b>试板</b> TryBoard
      </span>
      <a className="text-fg hover:text-accent-ink" href="./licenses.html">
        第三方授权
      </a>
      <span className="flex-1" />
      <span lang="en">ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</span>
    </footer>
  );
}
