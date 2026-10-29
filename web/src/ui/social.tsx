// Project links: GitHub repo and an X follow intent (x.com shows the follow prompt for the account).
import { Button } from './components';
import { cn } from './cn';
import { GITHUB, X_FOLLOW } from './links';
import { t } from '../i18n';

const GH = 'M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z';
const X = 'M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.2h1.7L7.4 4.73H5.58L16.67 19.2Z';

function Glyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Icon buttons for headers; `labels` adds the text for menus where there is room. */
export function SocialLinks({ className, labels }: { className?: string; labels?: boolean }) {
  const items: [string, string, string][] = [
    [GITHUB, GH, t('TryBoard on GitHub')],
    [X_FOLLOW, X, t('Follow @wquguru on X')],
  ];
  return (
    <div className={cn('flex flex-none items-center gap-1', className)}>
      {items.map(([href, d, label]) =>
        labels ? (
          <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="flex h-11 items-center gap-2 text-[15px] text-muted hover:text-fg">
            <Glyph d={d} />
            {label}
          </a>
        ) : (
          <Button key={href} asChild size="sm" className="size-8 flex-none px-0 max-md:size-11">
            <a href={href} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}>
              <Glyph d={d} />
            </a>
          </Button>
        ),
      )}
    </div>
  );
}
