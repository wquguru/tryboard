// 作品首页（DESIGN §1、§5）：首屏主张 + 四步流程、作品两列横卡、一行页脚。
// 作品卡按 app/works.ts 的作品定义生成（加一个作品就多一张卡）；预览里的示意图和真实固件运行是命令式的（cards.ts），由 effect 挂载。
// 同一时间只跑一份（每份一个 wasm worker）。
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/components';
import { SiteFooter, SiteHeader } from '../ui/site';
import { cn } from '../ui/cn';
import { bomTotal, getTemplate, templatePicks } from '../catalog/templates';
import { HOME_WORKS } from '../app/works';
import type { WorkDef } from '../app/types';
import { showcase, startLive } from './cards';

const STEPS: [string, string][] = [
  ['采购', '挑零件，看参考价'],
  ['实验台', '跑固件，逐条验收'],
  ['组装', '装进外壳，看读数变没变'],
  ['成品', '拿在手里什么样'],
];

// 参考价从元件库算，和采购页默认清单同一口径（必选 + 默认勾选的建议件，bomTotal），不写死
const yuan = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

export function App() {
  const [live, setLive] = useState<string | null>(null);
  return (
    <div className="flex min-h-screen flex-col text-[13px] leading-[1.6]">
      <SiteHeader
        current="#works"
        links={[
          ['#works', '作品'],
          ['./advisor.html', '选型助手'],
          ['./app.html?work=blank#bench', '空白实验台'],
        ]}
      />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-6 pb-16 max-sm:px-4 max-sm:pb-12">
        <section className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] items-center gap-12 pt-[72px] pb-14 max-[900px]:grid-cols-1 max-[900px]:gap-8 max-sm:pt-6 max-sm:pb-6">
          <div className="flex flex-col gap-4">
            <h1 className="text-[40px] font-semibold leading-[1.2] tracking-[-0.01em] text-balance max-sm:text-[28px]">买零件之前，先在网页上把它做出来</h1>
            <p className="text-[15px] text-muted">跑的是你编译出来的真实固件，不是动画。</p>
            {/* 手机上拖固件不顺手（DESIGN_V2 §5），第二个按钮换成选型助手 */}
            <div className="flex flex-wrap gap-2 max-md:grid max-md:grid-cols-2">
              <Button asChild variant="default" className="px-[18px] text-[13px] max-md:h-12 max-md:rounded-xl max-md:text-[14px] max-md:font-bold">
                <a href="#works">挑一个作品</a>
              </Button>
              <Button asChild className="px-[18px] text-[13px] max-md:hidden">
                <a id="haveFw" href="./app.html?work=blank#bench">
                  我有固件了
                </a>
              </Button>
              <Button asChild className="hidden h-12 rounded-xl text-[14px] max-md:inline-flex">
                <a id="pickBoard" href="./advisor.html">
                  帮我选板子
                </a>
              </Button>
            </div>
          </div>
          <ol aria-label="四步" className="grid border-l border-line max-md:hidden">
            {STEPS.map(([t, d], i) => (
              <li key={t} className="relative grid grid-cols-[56px_minmax(0,1fr)] py-3 before:absolute before:top-[19px] before:-left-1 before:size-[7px] before:rounded-full before:bg-accent before:content-['']">
                <span className="row-span-2 pt-1 pl-5 font-mono text-[11px] font-medium text-accent-ink">{String(i + 1).padStart(2, '0')}</span>
                <b className="text-[15px] font-medium">{t}</b>
                <span className="text-[12px] text-muted">{d}</span>
              </li>
            ))}
          </ol>
        </section>

        <div className="mb-3.5 flex items-baseline justify-between gap-3 border-t border-line pt-4">
          <b className="text-[15px] font-medium">
            作品 <span className="ml-1 text-[12px] font-normal text-muted">{HOME_WORKS.length} 个</span>
          </b>
          <a id="ownIdea" className="text-[12px] text-muted hover:text-accent-ink" href="./advisor.html">
            都不是想做的？用选型助手 →
          </a>
        </div>
        <section id="works" aria-label="作品" className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1 max-md:gap-2.5">
          {HOME_WORKS.map((w) => (
            <WorkCard key={w.id} w={w} live={live === w.id} onToggle={() => setLive((cur) => (cur === w.id ? null : w.id))} />
          ))}
        </section>
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

  // 手机（< 768px）：没在跑时是"缩略图 + 文字"的横排小卡（MobileSite 第 1 屏），缩略图是同一张示意图居中裁成方形；
  // 跑起来以后预览撑满整卡宽度。跑 / 停按钮放在正文里，桌面上绝对定位回预览左上角（正文不设定位，所以相对整卡）。
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
        className={cn('order-3 w-full truncate border-t border-line-soft bg-field px-3.5 py-1.5 font-mono text-[11px] text-accent-ink', !live && 'hidden')}
      />
      <div className={cn('flex min-w-0 flex-1 flex-col justify-center gap-2 px-4 py-3.5', !live && 'max-md:gap-1.5 max-md:p-0')}>
        <div>
          <h2 className="text-[16px] font-medium max-md:text-[15px] max-md:font-bold">{w.title}</h2>
          <span className="font-mono text-[11px] text-muted max-md:hidden">{w.card!.chip}</span>
        </div>
        {w.card?.blurb && <p className="line-clamp-2 text-[12px] leading-[1.5] text-muted">{w.card.blurb}</p>}
        <span data-price className="font-mono text-[12px] max-md:hidden">
          ¥{yuan(total.lo)}–{yuan(total.hi)} <span className="text-muted">估算</span>
        </span>
        <div className="hidden flex-wrap gap-1.5 text-[11px] max-md:flex">
          <span className="rounded-full bg-field px-[7px] text-fg">{w.card!.chip}</span>
          <span className="rounded-full bg-field px-[7px] text-fg">{w.checkpoints.length} 个检查点</span>
          <span className="rounded-full bg-field px-[7px] text-fg">
            约 ¥{yuan(total.lo)}–{yuan(total.hi)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="default" className="px-3 text-[13px] max-md:h-11 max-md:px-4">
            <a data-go href={`./app.html?work=${w.id}#shop`}>
              做这个
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
            {live && !failed ? '回到示意图' : '看真实固件跑'}
          </Button>
        </div>
      </div>
    </article>
  );
}
