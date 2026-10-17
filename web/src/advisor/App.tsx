import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PARTS, TEMPLATES, type Cap, type Template } from './data';
import { capName, recommend, type Confidence, type Need, type Plan } from './engine';
import { Badge, Button, Card, Checkbox, Chip, Collapsible, StatusList, Table } from '../ui/components';
import { SiteHeader } from '../ui/site';
import { cn } from '../ui/cn';
import { RadioGroup } from 'radix-ui';

const SELECTABLE_CAPS: Cap[] = ['wifi', 'ble', 'bt_classic', 'thread', 'zigbee', 'usb_otg', 'camera', 'audio_in', 'audio_out', 'psram', 'display_rgb', 'touch', 'dac'];
const SELECTABLE_PARTS = Object.values(PARTS).filter((p) => p.id !== 'battery');

const CONF_VARIANT = { 仿真验证: 'ok', 行为模拟: 'info', 估算: 'warn', 必须上真机: 'bad' } as const;
const Conf = ({ c }: { c: Confidence }) => <Badge variant={CONF_VARIANT[c]} className="conf">{c}</Badge>;
const yuan = (p: [number, number]) => (p[0] === p[1] ? `¥${p[0]}` : `¥${p[0]}–${p[1]}`);
const lasts = (days: number) => (days >= 365 ? (days / 365).toFixed(1) + ' 年' : days.toFixed(0) + ' 天');
const avg = (mA: number) => (mA < 1 ? (mA * 1000).toFixed(0) + 'µA' : mA.toFixed(2) + 'mA');

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

const H2 = ({ step, children, className }: { step?: number; children: ReactNode; className?: string }) => (
  <h2 className={cn('mt-9 mb-3.5 flex items-center gap-2.5 text-lg font-bold', className)}>
    {step && <span className="inline-grid size-6 place-items-center rounded-full bg-accent-strong text-[13px] font-bold text-on-accent">{step}</span>}
    {children}
  </h2>
);
const H4 = ({ children }: { children: ReactNode }) => <h4 className="mt-4 mb-1.5 flex items-center gap-2 text-[13px] font-semibold tracking-[.3px] text-muted">{children}</h4>;
const Meta = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cn('mt-1 mb-3 text-[13px] text-muted', className)}>{children}</div>;

function chipLine(p: Plan, withSram: boolean) {
  return [
    p.chip.name,
    `${p.chip.core} ${p.chip.mhz}MHz`,
    withSram && `${p.chip.sramKB}KB SRAM`,
    `${p.board.flashMB}MB flash`,
    p.board.psramMB && `${p.board.psramMB}MB PSRAM`,
    p.board.size,
  ]
    .filter(Boolean)
    .join(' · ');
}

function AltCard({ p }: { p: Plan }) {
  return (
    <Card className="card px-[18px] py-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2.5">
        <h3 className="m-0 text-[17px] font-bold">{p.board.name}</h3>
        <span className="ml-auto font-mono text-accent-ink max-md:ml-0">{yuan(p.board.priceCNY)}</span>
      </div>
      <Meta>{chipLine(p, false)}</Meta>
      <StatusList kind="ok" items={p.reasons.slice(0, 2)} />
      <StatusList kind="warn" items={p.warnings.slice(0, 2)} />
      {p.power && <Meta className="mb-0">电池续航约 {lasts(p.power.days)}（估算）</Meta>}
    </Card>
  );
}

function BestCard({ p, tpl }: { p: Plan; tpl: Template }) {
  return (
    <Card className="card best mb-3.5 border-accent-line shadow-panel">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2.5">
        <Badge variant="solid">首选</Badge>
        <h3 className="m-0 text-[22px] font-bold">{p.board.name}</h3>
        <Badge>{p.board.maker}</Badge>
        <span className="ml-auto font-mono text-accent-ink max-md:ml-0">整套 {yuan(p.total)}</span>
      </div>
      <Meta>{chipLine(p, true)}</Meta>
      <div className="grid grid-cols-2 gap-[18px] max-md:grid-cols-1">
        <div>
          <H4>为什么选它</H4>
          <StatusList kind="ok" items={p.reasons.length ? p.reasons : ['满足全部需求']} />
          {p.warnings.length > 0 && (
            <>
              <H4>要注意</H4>
              <StatusList kind="warn" items={p.warnings} />
            </>
          )}
          {tpl.risks.length > 0 && (
            <>
              <H4>这类项目常见的坑</H4>
              <StatusList kind="warn" items={tpl.risks} />
            </>
          )}
          {p.pinProblems.length > 0 && (
            <>
              <H4>接线问题</H4>
              <StatusList kind="err" items={p.pinProblems} />
            </>
          )}
          {p.power && (
            <>
              <H4>
                电池续航（1000mAh 锂电） <Conf c={p.power.confidence} />
              </H4>
              <div className="flex flex-wrap items-baseline gap-5">
                <span className="font-mono text-[28px]">{lasts(p.power.days)}</span>
                <span className="text-[13px] text-muted">
                  平均 {avg(p.power.avgMA)} · {p.power.breakdown}
                </span>
              </div>
            </>
          )}
        </div>
        <div>
          <H4>
            引脚怎么接 <Conf c="估算" />
          </H4>
          {p.pins.length ? (
            <Table>
              <thead>
                <tr>
                  <th>接什么</th>
                  <th>引脚</th>
                </tr>
              </thead>
              <tbody>
                {p.pins.map((a, i) => (
                  <tr key={i}>
                    <td>
                      {a.label}
                      {a.note && <div className="text-[13px] text-muted">{a.note}</div>}
                    </td>
                    <td>
                      {a.pins.length
                        ? a.pins.map((x) => (
                            <span key={x} className="mr-[3px] rounded bg-field px-[5px] font-mono">
                              {p.board.labels?.[x] ? p.board.labels[x] + ' · ' : ''}GPIO{x}
                            </span>
                          ))
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-[13px] text-muted">没有需要接线的配件。</p>
          )}
          <H4>物料清单</H4>
          <Table>
            <thead>
              <tr>
                <th>物品</th>
                <th className="text-right! font-mono">参考价</th>
              </tr>
            </thead>
            <tbody>
              {p.bom.map((b, i) => (
                <tr key={i}>
                  <td>{b.name}</td>
                  <td className="text-right font-mono">{yuan(b.price)}</td>
                </tr>
              ))}
              <tr>
                <th>合计</th>
                <th className="text-right! font-mono">{yuan(p.total)}</th>
              </tr>
            </tbody>
          </Table>
          {p.simCoverage.length > 0 && (
            <>
              <H4>买之前能验证到哪一步</H4>
              <Table>
                <tbody>
                  {p.simCoverage.map((s, i) => (
                    <tr key={i}>
                      <td>{s.part}</td>
                      <td>
                        <Conf c={s.level} />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>芯片 {p.chip.name} 本身</td>
                    <td>
                      <Conf c={p.chip.simulated === 'full' ? '仿真验证' : p.chip.simulated === 'partial' ? '行为模拟' : '必须上真机'} />
                    </td>
                  </tr>
                </tbody>
              </Table>
            </>
          )}
        </div>
      </div>
      {p.chip.simulated === 'full' &&
        tpl.examples.map((e) => (
          <Button key={e} asChild variant="field" className="try mt-3.5 mr-2">
            <a href={`./index.html?example=${e}`}>▶ 在试板里跑「{e}」示例</a>
          </Button>
        ))}
    </Card>
  );
}

function Result({ need, tpl }: { need: Need; tpl: Template }) {
  const { plans, rejected } = useMemo(() => recommend(need), [need]);
  if (!plans.length)
    return (
      <div className="rounded-xl border border-dashed border-line p-[30px] text-center text-muted">
        没有一块板子同时满足这些需求。
        {rejected.slice(0, 4).map((r, i) => (
          <div key={i}>
            {r.board.name}：{r.why}
          </div>
        ))}
      </div>
    );
  const [best, ...rest] = plans;
  return (
    <>
      <BestCard p={best} tpl={tpl} />
      {rest.length > 0 && (
        <>
          <h3 className="mt-[22px] mb-2.5 text-[15px] font-bold">其他可选</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-3">
            {rest.slice(0, 3).map((p) => (
              <AltCard key={p.board.id} p={p} />
            ))}
          </div>
        </>
      )}
      {rejected.length > 0 && (
        <Collapsible.Root className="mt-3.5 text-sm text-muted">
          <Collapsible.Trigger className="group cursor-pointer">
            <span className="inline-block transition-transform group-data-[state=open]:rotate-90">▸</span> 另外 {rejected.length} 块为什么不合适
          </Collapsible.Trigger>
          <Collapsible.Content>
            <StatusList
              kind="err"
              items={rejected.map((r) => `${r.board.name}：${r.why}`)}
            />
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </>
  );
}

export function App() {
  const [tpl, setTpl] = useState<Template>(() => TEMPLATES.find((t) => t.id === new URLSearchParams(location.search).get('t')) ?? TEMPLATES[1]);
  const [need, setNeed] = useState<Need>(() => needOf(tpl));

  useEffect(() => {
    try {
      history.replaceState(null, '', `?t=${tpl.id}`);
    } catch {
      /* 预览环境可能不允许改地址 */
    }
  }, [tpl]);

  const pick = (t: Template) => {
    setTpl(t);
    setNeed(needOf(t));
  };
  const setBattery = (on: boolean) =>
    setNeed((n) => ({ ...n, battery: on, duty: on ? (tpl.duty ?? { wakePerHour: 6, activeSec: 3, wifi: n.caps.includes('wifi') }) : tpl.duty }));

  return (
    <>
      <SiteHeader
        current="./advisor.html"
        links={[
          ['./home.html', '作品'],
          ['./advisor.html', '选型助手'],
          ['./app.html?work=blank#bench', '空白实验台'],
        ]}
      />
      <main className="mx-auto max-w-[1120px] px-5 pt-6 pb-[60px] max-sm:px-4">
        <section>
          <h1 className="mt-3 mb-2 text-[30px] font-bold tracking-[-0.3px] max-md:text-2xl">先选项目，再看买哪块板</h1>
          <p className="mb-2 max-w-[760px] text-muted">
            选一个想做的项目，或者自己勾需求。下面会列出推荐的开发板、配件清单、引脚怎么接、电池能撑多久，还有哪些部分能先在模拟器里跑一遍，哪些必须上真机。
          </p>
        </section>
        <section>
          <H2 step={1}>你想做什么？</H2>
          <RadioGroup.Root
            id="templates"
            aria-label="项目模板"
            value={tpl.id}
            onValueChange={(id) => pick(TEMPLATES.find((t) => t.id === id)!)}
            className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 max-sm:grid-cols-2 max-sm:gap-2"
          >
            {TEMPLATES.map((t) => (
              <RadioGroup.Item
                key={t.id}
                value={t.id}
                data-t={t.id}
                className={cn(
                  'tpl cursor-pointer rounded-xl border border-line bg-surface px-4 py-3.5 text-left transition hover:-translate-y-px hover:border-hover-line max-sm:px-3 max-sm:py-2.5',
                  'data-[state=checked]:border-accent data-[state=checked]:shadow-[inset_0_0_0_1px_var(--accent)]',
                )}
              >
                <b className="my-1 block max-sm:text-sm">{t.title}</b>
                <span className="text-[13px] text-muted max-sm:hidden">{t.blurb}</span>
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </section>
        <section className="mt-6 rounded-xl border border-line bg-surface px-[18px] pt-1 pb-3.5">
          <H2 step={2} className="mt-[18px]">
            微调需求
          </H2>
          {(
            [
              ['必须支持', 'caps', SELECTABLE_CAPS.map((c) => ({ id: c, label: capName(c), on: need.caps.includes(c), flip: () => setNeed((n) => ({ ...n, caps: toggled(n.caps, c) })), data: { 'data-cap': c } }))],
              ['要用的配件', 'parts', SELECTABLE_PARTS.map((p) => ({ id: p.id, label: p.name, on: need.parts.includes(p.id), flip: () => setNeed((n) => ({ ...n, parts: toggled(n.parts, p.id) })), data: { 'data-part': p.id } }))],
            ] as const
          ).map(([label, id, chips]) => (
            <div key={id} className="grid grid-cols-[96px_1fr] gap-3 border-t border-line py-2 max-md:grid-cols-1 max-md:gap-1">
              <div className="pt-[5px] text-[13px] text-muted" id={`${id}-label`}>
                {label}
              </div>
              <div id={id} className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${id}-label`}>
                {chips.map((c) => (
                  <Chip key={c.id} pressed={c.on} onPressedChange={c.flip} {...c.data}>
                    {c.label}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
          <div className="grid grid-cols-[96px_1fr] gap-3 border-t border-line py-2 max-md:grid-cols-1 max-md:gap-1">
            <div className="pt-[5px] text-[13px] text-muted">供电</div>
            <div className="pt-1">
              <Checkbox id="battery" label="电池供电，要省电" checked={need.battery} onCheckedChange={(v) => setBattery(v === true)} />
            </div>
          </div>
        </section>
        <section>
          <H2 step={3}>推荐</H2>
          <div id="result" aria-live="polite">
            <Result need={need} tpl={tpl} />
          </div>
        </section>
        <footer className="mt-10 text-xs text-muted">
          数据来自乐鑫芯片数据手册与开发板厂商公开资料，价格为常见网店价区间，以购买时为准。功耗按数据手册典型值估算，实测会因板子做工、信号强度、固件写法而变化。
          <span lang="en">ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</span>{' '}
          <a href="./licenses.html">第三方授权</a>
        </footer>
      </main>
    </>
  );
}
