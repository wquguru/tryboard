// 选型助手 v2（DESIGN_V2 §2，设计稿 docs/design-v2/Advisor.dc.html；手机见 MobileSite 第 3、4 屏）。
// 逻辑全在 engine.ts / data.ts（纯函数），这里只管界面：输入（模板 / 硬要求 / 配件 / 预算）→ 结果（三个关键数、理由、接线、清单、可信度、备选）。
// "在试板里跑一遍"按推荐芯片从模板的示例里挑 examples.json 里真实存在、芯片对得上的那个，打开实验台（index.html?example=）。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RadioGroup, Toggle } from 'radix-ui';
import { PARTS, TEMPLATES, type Cap, type Template } from './data';
import { capName, recommend, type Confidence, type Need, type Plan } from './engine';
import { Badge, Button, Collapsible, Table } from '../ui/components';
import { SiteFooter, SiteHeader } from '../ui/site';
import { cn } from '../ui/cn';
import { WORKS } from '../app/works';

const SELECTABLE_CAPS: Cap[] = ['wifi', 'ble', 'bt_classic', 'thread', 'zigbee', 'usb_otg', 'camera', 'audio_in', 'audio_out', 'psram', 'display_rgb', 'touch', 'dac'];
const SELECTABLE_PARTS = Object.values(PARTS).filter((p) => p.id !== 'battery');
const BUDGETS: [number | undefined, string][] = [
  [undefined, '不限'],
  [60, '¥60 内'],
  [120, '¥120 内'],
  [200, '¥200 内'],
];

const CONF_VARIANT = { 仿真验证: 'ok', 行为模拟: 'info', 估算: 'warn', 必须上真机: 'bad' } as const;
const Conf = ({ c }: { c: Confidence }) => (
  <Badge variant={CONF_VARIANT[c]} className="conf font-bold">
    {c}
  </Badge>
);
const yuan = (p: [number, number]) => (p[0] === p[1] ? `¥${p[0]}` : `¥${p[0]}–${p[1]}`);
const lasts = (days: number) => (days >= 365 ? (days / 365).toFixed(1) + ' 年' : days.toFixed(0) + ' 天');
const avg = (mA: number) => (mA < 1 ? (mA * 1000).toFixed(0) + 'µA' : mA.toFixed(2) + 'mA');
const simLevel = (p: Plan): Confidence => (p.chip.simulated === 'full' ? '仿真验证' : p.chip.simulated === 'partial' ? '行为模拟' : '必须上真机');

function needOf(t: Template): Need {
  return {
    caps: t.needCaps.filter((c) => c !== 'low_power'),
    nice: [...(t.niceCaps ?? [])],
    parts: t.parts.filter((p) => p !== 'battery'),
    battery: t.needCaps.includes('low_power') || t.parts.includes('battery'),
    duty: t.duty,
  };
}

const toggled = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

/** < 768px 用手机布局（DESIGN_V2 §0）：折叠分区只在手机上折叠，桌面上直接展开（不放一个点了没反应的按钮） */
function useMobile() {
  const q = '(max-width: 767px)';
  const [m, setM] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return m;
}

// ---------------------------------------------------------------- 示例固件清单（真实数据：web/public/fw/examples.json）
type Example = { id: string; chip: string; title: string };
function useExamples() {
  const [ex, setEx] = useState<Map<string, Example> | null>(null);
  useEffect(() => {
    let off = false;
    fetch('./fw/examples.json')
      .then((r) => r.json())
      .then((list: Example[]) => !off && setEx(new Map(list.map((e) => [e.id, e]))))
      .catch(() => !off && setEx(new Map()));
    return () => void (off = true);
  }, []);
  return ex;
}
const exName = (e: Example) => e.title.split('：')[0];

interface TryPlan {
  /** 推荐芯片能跑的示例 */
  runs: Example[];
  /** 推荐芯片跑不了时，同类项目在别的芯片上能跑的示例 */
  other: Example[];
  work?: { id: string; title: string; chip: string };
}
function tryPlan(tpl: Template, p: Plan | undefined, ex: Map<string, Example> | null): TryPlan {
  const all = ex ? tpl.examples.map((id) => ex.get(id)).filter((e): e is Example => !!e) : [];
  const runs = p ? all.filter((e) => e.chip === p.chip.id) : [];
  const w = tpl.work ? WORKS[tpl.work] : undefined;
  return { runs, other: runs.length ? [] : all, work: w?.card ? { id: w.id, title: w.title, chip: w.card.chip } : undefined };
}
const runHref = (e: Example) => `./index.html?example=${e.id}`;

// ---------------------------------------------------------------- 小件
const Lbl = ({ children, className, id }: { children: ReactNode; className?: string; id?: string }) => (
  <p id={id} className={cn('mb-3 text-[12px] font-bold tracking-[.06em] text-muted', className)}>
    {children}
  </p>
);
const Check = ({ className }: { className?: string }) => (
  <svg className={cn('flex-none', className)} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7" />
  </svg>
);
const Alert = ({ className }: { className?: string }) => (
  <svg className={cn('flex-none', className)} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 8v5M12 16.5v.5" />
    <circle cx="12" cy="12" r="9.5" />
  </svg>
);
const Cross = ({ className }: { className?: string }) => (
  <svg className={cn('flex-none', className)} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M7 7l10 10M17 7L7 17" />
  </svg>
);
const Play = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 4.5v15L19.5 12z" />
  </svg>
);
const Chevron = ({ open }: { open?: boolean }) => (
  <svg className={cn('flex-none text-muted transition-transform', open && 'rotate-180')} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/** 理由 / 注意 / 问题：图标 + 颜色同时表达（不只靠颜色） */
function Points({ ok = [], warn = [], err = [] }: { ok?: string[]; warn?: string[]; err?: string[] }) {
  const row = (t: string, i: number, icon: ReactNode, kind: string) => (
    <li key={kind + i} data-kind={kind} className="flex gap-2.5 text-[14px] leading-[1.6]">
      <span className="mt-[3px]">{icon}</span>
      {t}
    </li>
  );
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {ok.map((t, i) => row(t, i, <Check className="text-ok" />, 'ok'))}
      {warn.map((t, i) => row(t, i, <Alert className="text-warn" />, 'warn'))}
      {err.map((t, i) => row(t, i, <Cross className="text-bad" />, 'err'))}
    </ul>
  );
}

/** 结果里的分区：手机上折叠成一行（"零件清单 · 6 项 ▾"），桌面上是小标题 + 内容 */
function Fold({ id, title, count, mobile, children, className }: { id: string; title: string; count?: string; mobile: boolean; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!mobile)
    return (
      <section data-fold={id} className={className}>
        <Lbl className="mb-1.5">{title}</Lbl>
        {children}
      </section>
    );
  return (
    <Collapsible.Root data-fold={id} open={open} onOpenChange={setOpen} className="border-t border-line-soft">
      <Collapsible.Trigger className="flex h-[52px] w-full cursor-pointer items-center justify-between px-[18px] text-left text-[14px]">
        <b>
          {title}
          {count && <span className="font-normal text-muted"> · {count}</span>}
        </b>
        <Chevron open={open} />
      </Collapsible.Trigger>
      <Collapsible.Content className="px-[18px] pb-4">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

const Stat = ({ k, v, sub, badge, tone }: { k: string; v: string; sub?: string; badge?: ReactNode; tone?: string }) => (
  <div data-stat={k} className="min-w-0 rounded-[10px] bg-field px-3.5 py-3 max-md:px-2.5 max-md:py-2.5">
    <div className="flex flex-wrap items-center gap-1 text-[12px] text-muted max-md:text-[11px]">
      {k} {badge}
    </div>
    <div className={cn('truncate text-[22px] font-bold leading-tight tracking-[-0.01em] max-md:text-[16px]', tone)}>{v}</div>
    {sub && <div className="truncate text-[12px] text-muted max-md:hidden">{sub}</div>}
  </div>
);

function chipLine(p: Plan) {
  return [p.chip.name, `${p.chip.core} ${p.chip.mhz}MHz`, `${p.chip.sramKB}KB SRAM`, `${p.board.flashMB}MB flash`, p.board.psramMB && `${p.board.psramMB}MB PSRAM`, p.board.size].filter(Boolean).join(' · ');
}

/** 每条结论有多可信：配件、芯片来自引擎的 simCoverage；引脚 / 续航是估算；充电、射频这些模拟器不管的，明说必须上真机 */
function trustRows(p: Plan, need: Need): [string, Confidence][] {
  const rows: [string, Confidence][] = p.simCoverage.map((s) => [s.part, s.level]);
  rows.push([`芯片 ${p.chip.name} 本身`, simLevel(p)]);
  rows.push(['引脚分配', '估算']);
  if (p.power) rows.push(['续航天数', p.power.confidence]);
  if (need.battery) rows.push(['锂电池充电、实际放电曲线', '必须上真机']);
  if (need.caps.some((c) => ['wifi', 'ble', 'bt_classic', 'thread', 'zigbee'].includes(c))) rows.push(['天线、无线距离', '必须上真机']);
  return rows;
}

function TryButtons({ t, plan }: { t: TryPlan; plan: Plan }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = [...plan.bom.map((b) => `${b.name}\t${yuan(b.price)}`), `合计\t${yuan(plan.total)}`].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  const [first, ...more] = t.runs;
  return (
    <div className="mt-7 flex flex-col gap-3 max-md:mt-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {first ? (
          <Button asChild variant="default" className="try h-11 rounded-[10px] px-5 text-[15px] font-bold max-md:hidden">
            <a href={runHref(first)} data-example={first.id}>
              <Play />
              在试板里跑「{exName(first)}」
            </a>
          </Button>
        ) : (
          <Button variant="outline" disabled className="h-11 rounded-[10px] px-5 text-[14px] max-md:hidden" title="这颗芯片还不能在试板里仿真">
            <Play />
            {plan.chip.name} 还不能在试板里跑
          </Button>
        )}
        <button type="button" onClick={copy} className="inline-flex min-h-11 cursor-pointer items-center text-[14px] text-accent-ink hover:underline" aria-live="polite">
          {copied ? '已复制到剪贴板' : '复制零件清单'}
        </button>
      </div>
      {more.length > 0 && (
        <p className="text-[13px] text-muted">
          也能跑：
          {more.map((e, i) => (
            <span key={e.id}>
              {i > 0 && ' · '}
              <a className="try text-accent-ink underline underline-offset-2 max-md:inline-flex max-md:min-h-11 max-md:items-center max-md:px-1" href={runHref(e)} data-example={e.id}>
                {exName(e)}
              </a>
            </span>
          ))}
        </p>
      )}
      {!first && t.other.length > 0 && (
        <p className="text-[13px] text-muted">
          同类项目可以先用 {t.other[0].chip === 'esp32s3' ? 'ESP32-S3' : 'ESP32-C3'} 跑一遍：
          {t.other.slice(0, 3).map((e, i) => (
            <span key={e.id}>
              {i > 0 && ' · '}
              <a className="text-accent-ink underline underline-offset-2 max-md:inline-flex max-md:min-h-11 max-md:items-center max-md:px-1" href={runHref(e)} data-example={e.id}>
                {exName(e)}
              </a>
            </span>
          ))}
        </p>
      )}
      {t.work && (
        <a className="inline-flex min-h-11 items-center text-[13px] text-accent-ink hover:underline md:min-h-0" href={`./app.html?work=${t.work.id}#shop`} data-work={t.work.id}>
          做完整作品「{t.work.title}」（{t.work.chip}）：采购 → 实验台 → 组装 → 成品 →
        </a>
      )}
    </div>
  );
}

function PlanCard({ p, rank, need, tpl, t, mobile, onBack }: { p: Plan; rank: number; need: Need; tpl: Template; t: TryPlan; mobile: boolean; onBack: () => void }) {
  const wires = p.pins.length;
  const sim = simLevel(p);
  return (
    <article data-board={p.board.id} className={cn('card overflow-hidden rounded-2xl border border-line bg-surface', rank === 0 && 'best')}>
      <div className="grid grid-cols-[1.15fr_1fr] max-md:grid-cols-1">
        <div className="border-r border-line-soft p-8 max-md:border-0 max-md:p-[18px]">
          <div className="flex flex-wrap items-center gap-2">
            {rank === 0 ? <Badge variant="solid">最合适</Badge> : <Badge>第 {rank + 1} 名</Badge>}
            <Badge>{p.board.maker}</Badge>
            {rank > 0 && (
              <button type="button" onClick={onBack} className="ml-auto inline-flex min-h-8 cursor-pointer items-center text-[13px] text-accent-ink hover:underline max-md:min-h-11">
                回到最合适的
              </button>
            )}
          </div>
          <h2 className="mt-3 mb-1 text-[30px] font-bold leading-tight max-md:mt-2.5 max-md:text-[22px]">{p.board.name}</h2>
          <p className="font-mono text-[12.5px] leading-[1.7] text-muted max-md:text-[11.5px]">{chipLine(p)}</p>

          <div className="mt-5 grid grid-cols-3 gap-2 max-md:mt-3.5">
            <Stat k="推荐芯片" v={p.chip.name} sub={`${p.chip.core} ${p.chip.mhz}MHz`} />
            <Stat k="整套" v={yuan(p.total)} sub={`${p.bom.length} 项 · 参考价`} />
            {p.power ? (
              <Stat k="续航" v={lasts(p.power.days)} badge={<Conf c={p.power.confidence} />} sub={`平均 ${avg(p.power.avgMA)} · 1000mAh`} />
            ) : (
              <Stat k="仿真" v={sim === '仿真验证' ? '完整' : sim === '行为模拟' ? '部分' : '还不能'} tone={sim === '仿真验证' ? 'text-ok-ink' : sim === '行为模拟' ? 'text-accent-ink' : 'text-bad-ink'} sub="在试板里" />
            )}
          </div>

          <div className="mt-6 max-md:mt-4">
            <Points ok={p.reasons.length ? p.reasons : ['满足全部需求']} warn={mobile ? p.warnings.slice(0, 2) : p.warnings} err={p.pinProblems} />
          </div>
          {!mobile && <TryButtons t={t} plan={p} />}
        </div>

        <div className="flex flex-col gap-6 p-8 max-md:gap-0 max-md:p-0">
          {p.power && !mobile && (
            <div>
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-[13px] text-muted">电池续航</span>
                <span className="text-[40px] font-bold leading-none tracking-[-0.02em]">
                  {p.power.days >= 365 ? (p.power.days / 365).toFixed(1) : p.power.days.toFixed(0)}
                  <span className="ml-1 text-[18px] font-medium">{p.power.days >= 365 ? '年' : '天'}</span>
                </span>
                <Conf c={p.power.confidence} />
              </div>
              <p className="mt-2 text-[12px] text-muted">
                1000mAh 锂电，平均 {avg(p.power.avgMA)}：{p.power.breakdown}
              </p>
            </div>
          )}
          <Fold id="pins" title="接线" count={wires ? `${wires} 组` : '无'} mobile={mobile}>
            {p.pins.length ? (
              <Table className="text-[14px] [&_td]:px-0 [&_td]:py-2.5">
                <tbody>
                  {p.pins.map((a, i) => (
                    <tr key={i}>
                      <td>
                        {a.label}
                        {a.note && <div className="text-[12px] text-warn-ink">{a.note}</div>}
                      </td>
                      <td className="text-right font-mono text-[13px] whitespace-nowrap">
                        {a.pins.length ? a.pins.map((x) => <div key={x}>{(p.board.labels?.[x] ? p.board.labels[x] + ' · ' : '') + 'GPIO' + x}</div>) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-[13px] text-muted">没有需要接线的配件。</p>
            )}
            <p className="mt-2 flex items-center gap-2 text-[12px] text-muted">
              引脚按板子丝印和芯片限制自动分配 <Conf c="估算" />
            </p>
          </Fold>
          {mobile && p.power && (
            <Fold id="power" title="续航怎么算的" count={lasts(p.power.days)} mobile>
              <p className="text-[13px] text-muted">
                1000mAh 锂电，平均 {avg(p.power.avgMA)}：{p.power.breakdown}
              </p>
            </Fold>
          )}
          {(tpl.risks.length > 0 || (mobile && p.warnings.length > 2)) && (
            <Fold id="risks" title="要注意" count={`${tpl.risks.length + (mobile ? Math.max(0, p.warnings.length - 2) : 0)} 条`} mobile={mobile}>
              <Points warn={[...(mobile ? p.warnings.slice(2) : []), ...tpl.risks]} />
            </Fold>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[1.15fr_1fr] border-t border-line-soft max-md:grid-cols-1 max-md:border-0">
        <Fold id="bom" title="零件清单" count={`${p.bom.length} 项`} mobile={mobile} className="border-r border-line-soft px-8 py-7">
          <Table className="text-[14px] [&_td]:px-0 [&_td]:py-2.5 [&_th]:px-0 [&_th]:py-2.5">
            <tbody>
              {p.bom.map((b, i) => (
                <tr key={i}>
                  <td>{b.name}</td>
                  <td className="text-right font-mono whitespace-nowrap">{yuan(b.price)}</td>
                </tr>
              ))}
              <tr>
                <th className="border-0!">合计</th>
                <th className="border-0! text-right! font-mono whitespace-nowrap text-fg!">{yuan(p.total)}</th>
              </tr>
            </tbody>
          </Table>
        </Fold>
        <Fold id="trust" title="每条结论有多可信" mobile={mobile} className="px-8 py-7">
          <Table className="text-[14px] [&_td]:px-0 [&_td]:py-2.5">
            <tbody>
              {trustRows(p, need).map(([k, c], i) => (
                <tr key={i}>
                  <td>{k}</td>
                  <td className="text-right">
                    <Conf c={c} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Fold>
      </div>
      {mobile && (
        <div className="border-t border-line-soft px-[18px] pb-2">
          <TryButtons t={t} plan={p} />
        </div>
      )}
    </article>
  );
}

function AltCard({ p, rank, onPick }: { p: Plan; rank: number; onPick: () => void }) {
  const why = p.reasons.find((r) => !r.includes('完整仿真')) ?? p.warnings[0] ?? p.reasons[0] ?? '';
  return (
    <button
      type="button"
      data-alt={p.board.id}
      onClick={onPick}
      className="alt flex cursor-pointer flex-col rounded-xl border border-line bg-surface p-5 text-left transition hover:-translate-y-px hover:border-hover-line max-md:w-[220px] max-md:flex-none max-md:snap-start max-md:p-3.5"
    >
      <b className="text-[16px] max-md:text-[14px]">{p.board.name}</b>
      <span className="mt-1.5 mb-3.5 line-clamp-2 text-[13px] text-muted max-md:mb-2 max-md:text-[12px]">{why}</span>
      <span className="mt-auto flex justify-between gap-2 text-[13px] max-md:text-[12px]">
        <span className="font-mono">{yuan(p.total)}</span>
        <span className="text-muted">{p.power ? `约 ${lasts(p.power.days)}` : `第 ${rank + 1} 名`}</span>
      </span>
    </button>
  );
}

export function App() {
  const mobile = useMobile();
  const ex = useExamples();
  const [tpl, setTpl] = useState<Template>(() => TEMPLATES.find((t) => t.id === new URLSearchParams(location.search).get('t')) ?? TEMPLATES[1]);
  const [need, setNeed] = useState<Need>(() => needOf(tpl));
  const [focus, setFocus] = useState<string | null>(null);
  const [moreTpl, setMoreTpl] = useState(false);
  const [inResult, setInResult] = useState(false);
  const resultRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      history.replaceState(null, '', `?t=${tpl.id}`);
    } catch {
      /* 预览环境可能不允许改地址 */
    }
  }, [tpl]);
  useEffect(() => setFocus(null), [need]);
  // 手机底部吸附按钮：结果区进入视野前是"看推荐"，进入后是"在试板里跑一遍"
  useEffect(() => {
    const el = resultRef.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver(([e]) => setInResult(e.isIntersecting), { rootMargin: '0px 0px -40% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const { plans, rejected } = useMemo(() => recommend(need), [need]);
  const rank = Math.max(0, plans.findIndex((p) => p.board.id === focus));
  const shown = plans[rank];
  const alts = plans.filter((p) => p !== shown).slice(0, 3);
  const t = tryPlan(tpl, shown, ex);

  const pick = (x: Template) => {
    setTpl(x);
    setNeed(needOf(x));
  };
  const setBattery = (on: boolean) =>
    setNeed((n) => ({ ...n, battery: on, duty: on ? (tpl.duty ?? { wakePerHour: 6, activeSec: 3, wifi: n.caps.includes('wifi') }) : tpl.duty }));
  const reqCount = need.caps.length + (need.battery ? 1 : 0) + (need.budget ? 1 : 0);
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const chipCls = 'h-[34px] rounded-full border-line bg-surface px-3.5 py-0 text-[13px] text-fg data-[state=on]:border-fg data-[state=on]:bg-fg data-[state=on]:text-bg max-md:h-11';
  const ReqChip = ({ on, flip, children, ...data }: { on: boolean; flip: () => void; children: ReactNode } & Record<`data-${string}`, string> & { id?: string }) => (
    <Toggle.Root pressed={on} onPressedChange={flip} className={cn('inline-flex cursor-pointer select-none items-center gap-1.5 border', chipCls)} {...data}>
      {on && <Check className="size-3.5" />}
      {children}
    </Toggle.Root>
  );

  return (
    <div className="flex min-h-screen flex-col max-md:pb-[76px]">
      <SiteHeader
        current="./advisor.html"
        subtitle="选型助手"
        links={[
          ['./home.html', '作品'],
          ['./advisor.html', '选型助手'],
          ['./app.html?work=blank#bench', '空白实验台'],
        ]}
      />
      <main className="flex-1">
        <section className="mx-auto max-w-[1120px] px-8 pt-[72px] pb-12 max-md:px-4 max-md:pt-5 max-md:pb-2">
          <p className="mb-4 font-mono text-[12px] tracking-[.1em] text-accent-ink max-md:hidden">选型助手</p>
          <h1 className="text-[48px] leading-[1.15] font-bold tracking-[-0.01em] max-md:text-[26px] max-md:leading-[1.25]">
            先选项目，
            <br className="max-md:hidden" />
            再看买哪块板
          </h1>
          <p className="mt-[18px] max-w-[560px] text-[17px] leading-[1.7] text-muted max-md:mt-2 max-md:text-[14px]">
            告诉我们你想做什么、有哪些硬要求，试板会给出芯片、开发板、零件清单和接线，并标出哪些结论已经在模拟器里跑过、哪些必须上真机。
          </p>
          <ol className="mt-8 flex flex-wrap gap-8 text-[14px] text-muted max-md:hidden">
            {['选一个项目', '勾上硬要求', '看结果，去实验台跑一遍'].map((s, i) => (
              <li key={s} className="flex items-center gap-2.5">
                <span className={cn('inline-flex size-[26px] items-center justify-center rounded-full font-mono text-[12px]', i === 0 ? 'bg-fg text-bg' : 'border-[1.5px] border-fg text-fg')}>{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
        </section>

        <section id="pick" className="mx-auto max-w-[1120px] scroll-mt-16 px-8 pb-12 max-md:px-4 max-md:pt-3 max-md:pb-5">
          <Lbl id="tpl-label">1 · 你想做什么</Lbl>
          <RadioGroup.Root
            id="templates"
            aria-labelledby="tpl-label"
            value={tpl.id}
            onValueChange={(id) => pick(TEMPLATES.find((x) => x.id === id)!)}
            className="grid grid-cols-2 gap-3 max-md:grid-cols-1 max-md:gap-2"
          >
            {TEMPLATES.map((x, i) => {
              const on = x.id === tpl.id;
              return (
                <RadioGroup.Item
                  key={x.id}
                  value={x.id}
                  data-t={x.id}
                  className={cn(
                    'tpl flex w-full cursor-pointer items-center gap-3.5 rounded-xl border border-line bg-surface px-[18px] py-4 text-left transition hover:border-hover-line max-md:min-h-14 max-md:gap-3 max-md:p-3.5',
                    'data-[state=checked]:border-2 data-[state=checked]:border-accent data-[state=checked]:bg-accent-bg data-[state=checked]:px-[17px] data-[state=checked]:py-[15px] max-md:data-[state=checked]:p-[13px]',
                    !moreTpl && i >= 4 && !on && 'max-md:hidden',
                  )}
                >
                  <span className={cn('w-[22px] flex-none font-mono text-[12px] max-md:hidden', on ? 'text-accent-ink' : 'text-muted')}>{String(i + 1).padStart(2, '0')}</span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-[15px] max-md:text-[14px]', on && 'font-bold')}>{x.title}</span>
                    <small className="mt-0.5 block text-[12px] text-muted">{x.parts.map((id) => PARTS[id].short).join(' · ')}</small>
                  </span>
                  {on && (
                    <svg className="flex-none" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" fill="var(--accent)" />
                      <path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </RadioGroup.Item>
              );
            })}
          </RadioGroup.Root>
          {!moreTpl && (
            <button type="button" onClick={() => setMoreTpl(true)} className="mt-2 hidden min-h-12 w-full cursor-pointer items-center gap-1 rounded-xl border border-line px-3.5 text-left text-[14px] text-muted max-md:flex">
              还有 {TEMPLATES.length - 4} 个 <Chevron />
            </button>
          )}
        </section>

        <section className="mx-auto max-w-[1120px] px-8 pb-14 max-md:px-4 max-md:pb-6">
          <Lbl id="caps-label">2 · 有什么硬要求（可多选）</Lbl>
          <div id="caps" role="group" aria-labelledby="caps-label" className="flex flex-wrap gap-2">
            <ReqChip id="battery" data-cap="battery" on={need.battery} flip={() => setBattery(!need.battery)}>
              电池供电，要省电
            </ReqChip>
            {SELECTABLE_CAPS.map((c) => (
              <ReqChip key={c} data-cap={c} on={need.caps.includes(c)} flip={() => setNeed((n) => ({ ...n, caps: toggled(n.caps, c) }))}>
                要{capName(c)}
              </ReqChip>
            ))}
          </div>
          <div className="mt-6 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-10 gap-y-6 max-md:mt-5 max-md:grid-cols-1">
            <div>
              <Lbl id="parts-label" className="mb-2.5">
                要用的配件
              </Lbl>
              <div id="parts" role="group" aria-labelledby="parts-label" className="flex flex-wrap gap-2">
                {SELECTABLE_PARTS.map((p) => (
                  <ReqChip key={p.id} data-part={p.id} on={need.parts.includes(p.id)} flip={() => setNeed((n) => ({ ...n, parts: toggled(n.parts, p.id) }))}>
                    {p.short}
                  </ReqChip>
                ))}
              </div>
            </div>
            <div>
              <Lbl id="budget-label" className="mb-2.5">
                预算（整套）
              </Lbl>
              <div id="budget" role="radiogroup" aria-labelledby="budget-label" className="flex rounded-[10px] bg-field p-[3px] text-[13px]">
                {BUDGETS.map(([v, label]) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={need.budget === v}
                    data-budget={v ?? 0}
                    onClick={() => setNeed((n) => ({ ...n, budget: v }))}
                    className={cn('h-[30px] cursor-pointer rounded-lg px-3 whitespace-nowrap text-muted max-md:h-11 max-md:flex-1 max-md:px-1', need.budget === v && 'bg-surface text-fg shadow-[0_1px_3px_#0000001a]')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section ref={resultRef} id="result" aria-live="polite" className="scroll-mt-14 bg-field pt-14 pb-[72px] max-md:pt-4 max-md:pb-8">
          <div className="mx-auto max-w-[1120px] px-8 max-md:px-4">
            <div className="flex items-center justify-between">
              <Lbl>3 · 推荐</Lbl>
              <button type="button" onClick={() => go('pick')} className="mb-3 hidden h-9 cursor-pointer items-center rounded-lg border border-line bg-surface px-3 text-[13px] max-md:inline-flex max-md:h-11">
                改条件
              </button>
            </div>
            {!shown ? (
              <div className="rounded-2xl border border-dashed border-line bg-surface p-[30px] text-center text-muted">
                没有一块板子同时满足这些需求。
                {rejected.slice(0, 4).map((r, i) => (
                  <div key={i}>
                    {r.board.name}：{r.why}
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div ref={cardRef} className="scroll-mt-16">
                  <PlanCard p={shown} rank={rank} need={need} tpl={tpl} t={t} mobile={mobile} onBack={() => setFocus(null)} />
                </div>
                {alts.length > 0 && (
                  <>
                    <Lbl className="mt-10 max-md:mt-5 max-md:mb-2">
                      也可以考虑<span className="hidden font-normal max-md:inline"> · 左右滑</span>
                    </Lbl>
                    <div id="alts" className="grid grid-cols-3 gap-3 max-md:-mx-4 max-md:flex max-md:snap-x max-md:scroll-px-4 max-md:overflow-x-auto max-md:px-4 max-md:pb-1">
                      {alts.map((p) => {
                        const r = plans.indexOf(p);
                        return (
                          <AltCard
                            key={p.board.id}
                            p={p}
                            rank={r}
                            onPick={() => {
                              setFocus(r === 0 ? null : p.board.id);
                              cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }}
                          />
                        );
                      })}
                    </div>
                  </>
                )}
              </>
            )}
            {rejected.length > 0 && (
              <Collapsible.Root className="mt-5 text-[14px] text-muted">
                <Collapsible.Trigger className="group inline-flex min-h-11 cursor-pointer items-center gap-1 md:min-h-8">
                  <span className="inline-block transition-transform group-data-[state=open]:rotate-90">▸</span> 另外 {rejected.length} 块为什么不合适
                </Collapsible.Trigger>
                <Collapsible.Content>
                  <Points err={rejected.map((r) => `${r.board.name}：${r.why}`)} />
                </Collapsible.Content>
              </Collapsible.Root>
            )}
            <p className="mt-10 text-[12px] leading-[1.7] text-muted">
              数据来自乐鑫芯片数据手册与开发板厂商公开资料，价格为常见网店价区间，以购买时为准。功耗按数据手册典型值估算，实测会因板子做工、信号强度、固件写法而变化。
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />

      {/* 手机底部吸附主按钮（MobileSite 第 3、4 屏） */}
      <div id="mobileBar" className="fixed inset-x-0 bottom-0 z-[6] hidden border-t border-line-soft bg-bg px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] max-md:block">
        {!inResult || !shown ? (
          <Button variant="default" className="h-12 w-full rounded-xl text-[15px] font-bold" onClick={() => go('result')}>
            看推荐 · {tpl.short}
            {reqCount > 0 && ` + ${reqCount} 个要求`}
          </Button>
        ) : t.runs[0] ? (
          <Button asChild variant="default" className="h-12 w-full rounded-xl text-[15px] font-bold">
            <a href={runHref(t.runs[0])} data-example={t.runs[0].id}>
              <Play />
              在试板里跑一遍
            </a>
          </Button>
        ) : (
          <Button variant="outline" disabled className="h-12 w-full rounded-xl text-[14px]">
            {shown.chip.name} 还不能在试板里跑
          </Button>
        )}
      </div>
    </div>
  );
}
