// Projects home page (DESIGN §1, §5): one card per work in app/works.ts; previews and live firmware are imperative (cards.ts).
// Only one card runs at a time (each run is a wasm worker).
import { Fragment, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/components';
import { SiteFooter, SiteHeader } from '../ui/site';
import { BLANK_LAB, HOME, SELECT, SITE_NAV, lab } from '../ui/links';
import { cn } from '../ui/cn';
import { bomTotal, getTemplate, templatePicks } from '../catalog/templates';
import { HOME_WORKS } from '../app/works';
import type { WorkDef } from '../app/types';
import { showcase, startLive } from './cards';
import { t } from '../i18n';

const STEPS: [string, string][] = [
  [t('Shop'), t('Make a parts list and check prices; no need to buy yet')],
  [t('Lab'), t('Run the firmware and check each item')],
  [t('Assemble'), t('Put it in the case and re-check readings')],
  [t('Product'), t('Preview the finished product')],
];

// Price comes from the parts catalog with the same basis as the shop's default list (bomTotal), never hard-coded.
const yuan = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

export function App() {
  const [live, setLive] = useState<string | null>(null);
  return (
    <div className="flex min-h-screen flex-col text-[13px] leading-[1.6]">
      <SiteHeader
        current="#works"
        links={SITE_NAV.map(([href, text]): [string, string] => (href === HOME ? ['#works', text] : [href, text]))}
      />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-6 pb-16 max-sm:px-4 max-sm:pb-12">
        <section className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] items-center gap-12 pt-[72px] pb-14 max-[900px]:grid-cols-1 max-[900px]:gap-8 max-sm:pt-6 max-sm:pb-6">
          <div className="flex flex-col gap-4">
            <h1 className="text-[40px] font-semibold leading-[1.2] tracking-[-0.01em] text-balance max-sm:text-[28px]">
              {/* CJK breaks anywhere and would split words: translations mark phrase chunks with |, lines break only between them. */}
              {t('TryBoard: a completely free online lab for AI hardware').split('|').map((c) => (
                <Fragment key={c}>
                  <span className="inline-block">{c.trimEnd()}</span>
                  {/* A trailing space inside an inline-block collapses; keep it outside so ko words stay apart. */}
                  {c !== c.trimEnd() && ' '}
                </Fragment>
              ))}
            </h1>
            <p className="text-[15px] text-muted">{t('Realistic 3D animation that runs your real firmware')}</p>
            {/* Dragging firmware in is awkward on a phone (DESIGN_V2 §5), so the second button becomes the board picker. */}
            <div className="flex flex-wrap gap-2 max-md:grid max-md:grid-cols-2">
              <Button asChild variant="default" className="px-[18px] text-[13px] max-md:h-12 max-md:rounded-xl max-md:text-[14px] max-md:font-bold">
                <a href="#works">{t('Pick a project')}</a>
              </Button>
              <Button asChild className="px-[18px] text-[13px] max-md:hidden">
                <a id="haveFw" href={BLANK_LAB}>
                  {t('Run my firmware')}
                </a>
              </Button>
              <Button asChild className="hidden h-12 rounded-xl text-[14px] max-md:inline-flex">
                <a id="pickBoard" href={SELECT}>
                  {t('Pick a board')}
                </a>
              </Button>
            </div>
          </div>
          <ol aria-label={t('Four steps')} className="grid border-l border-line max-md:hidden">
            {STEPS.map(([name, d], i) => (
              <li key={name} className="relative grid grid-cols-[56px_minmax(0,1fr)] py-3 before:absolute before:top-[19px] before:-left-1 before:size-[7px] before:rounded-full before:bg-accent before:content-['']">
                <span className="row-span-2 pt-1 pl-5 font-mono text-[11px] font-medium text-accent-ink">{String(i + 1).padStart(2, '0')}</span>
                <b className="text-[15px] font-medium">{name}</b>
                <span className="text-[12px] text-muted">{d}</span>
              </li>
            ))}
          </ol>
        </section>

        <div className="mb-3.5 flex items-baseline justify-between gap-3 border-t border-line pt-4">
          <b className="text-[15px] font-medium">
            {t('Projects')} <span className="ml-1 text-[12px] font-normal text-muted">{t('{n} total', { n: HOME_WORKS.length })}</span>
          </b>
          <a id="ownIdea" className="text-[12px] text-muted hover:text-accent-ink" href={SELECT}>
            {t('Nothing you want to build? Pick a board →')}
          </a>
        </div>
        <section id="works" aria-label={t('Projects')} className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1 max-md:gap-2.5">
          {HOME_WORKS.map((w) => (
            <WorkCard key={w.id} w={w} live={live === w.id} onToggle={() => setLive((cur) => (cur === w.id ? null : w.id))} />
          ))}
        </section>
        <p className="mt-4 mb-0 text-[13px] text-muted">
          <a id="faultsLink" className="inline-flex min-h-11 items-center hover:text-accent-ink md:min-h-0" href={lab('faults', 'bench')}>
            {t('Find the fault: four broken benches to repair →')}
          </a>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

function WorkCard({ w, live, onToggle }: { w: WorkDef; live: boolean; onToggle: () => void }) {
  const card = useRef<HTMLElement>(null);
  const prev = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const total = bomTotal(templatePicks(w.id), getTemplate(w.id).board);

  useEffect(() => {
    const el = prev.current!;
    if (!live) {
      showcase(el, w.id);
      return;
    }
    return startLive(w.id, card.current!, el, status.current!, () => setFailed(true));
  }, [live, w.id]);

  // Phone: idle cards are thumbnail + text rows (MobileSite screen 1); a running preview spans the card.
  // The run button lives in the body and is absolutely positioned over the preview on desktop (relative to the card).
  return (
    <article
      ref={card}
      data-work={w.id}
      data-cps={w.checkpoints.length}
      className={cn('wk relative flex min-w-0 overflow-hidden rounded-xl border border-line bg-surface max-md:rounded-[14px]', live ? 'live flex-wrap border-accent max-md:flex-col' : 'max-md:gap-3 max-md:p-3')}
    >
      <div
        ref={prev}
        data-show={w.id}
        className={cn(
          'wk-prev flex w-[52%] flex-none items-center [background:var(--stage-bg)] [&>*]:w-full',
          live ? 'max-md:w-full' : 'max-md:size-[84px] max-md:justify-center max-md:overflow-hidden max-md:rounded-[10px] max-md:[&>*]:w-[150px] max-md:[&>*]:max-w-none max-md:[&>*]:flex-none',
        )}
      />
      <div
        ref={status}
        data-status
        // Desktop: the status line overlays the preview's bottom edge so running cards keep their height and neighbours don't jump.
        className={cn('order-3 w-full truncate border-t border-line-soft bg-field px-3.5 py-1.5 font-mono text-[11px] text-accent-ink md:absolute md:bottom-0 md:left-0 md:z-[1] md:w-[52%] md:bg-field/90', !live && 'hidden')}
      />
      <div className={cn('flex min-w-0 flex-1 flex-col justify-center gap-2 px-4 py-3.5', !live && 'max-md:gap-1.5 max-md:p-0')}>
        <div>
          <h2 className="text-[16px] font-medium max-md:text-[15px] max-md:font-bold">{t(w.title)}</h2>
          <span className="font-mono text-[11px] text-muted max-md:hidden">{w.card!.chip}</span>
        </div>
        {w.card?.blurb && <p className="line-clamp-2 text-[12px] leading-[1.5] text-muted">{t(w.card.blurb)}</p>}
        <span data-price className="font-mono text-[12px] max-md:hidden">
          ¥{yuan(total.lo)}–{yuan(total.hi)} <span className="text-muted">{t('estimate')}</span>
        </span>
        <div className="hidden flex-wrap gap-1.5 text-[11px] max-md:flex">
          <span className="rounded-full bg-field px-[7px] text-fg">{w.card!.chip}</span>
          <span className="rounded-full bg-field px-[7px] text-fg">{t('{n} checkpoints', { n: w.checkpoints.length })}</span>
          <span className="rounded-full bg-field px-[7px] text-fg">
            {t('about ¥{lo}–{hi}', { lo: yuan(total.lo), hi: yuan(total.hi) })}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="default" className="px-3 text-[13px] max-md:h-11 max-md:px-4">
            <a data-go href={lab(w.id, 'shop')}>
              {t('Start building')}
            </a>
          </Button>
          <Button
            type="button"
            data-run={w.id}
            className={cn(
              'absolute top-2.5 left-2.5 z-[2] h-[30px] gap-0 rounded-full bg-head-bg px-2.5 text-[11px] before:whitespace-pre before:text-accent-ink',
              'max-md:static max-md:h-11 max-md:bg-surface max-md:px-3 max-md:text-[12px]',
              live ? "before:content-['■_']" : "before:content-['▶_']",
            )}
            onClick={() => {
              setFailed(false);
              onToggle();
            }}
          >
            {live && !failed ? t('Stop') : t('Run firmware')}
          </Button>
        </div>
      </div>
    </article>
  );
}
