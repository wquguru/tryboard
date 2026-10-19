// 选板 v3（DESIGN_V2 §8.2，设计稿 docs/design-v2/select-v3：Rec 桌面、SelectCMobile 手机、FrA 术语、FrC 0 块板、UtilB 任务书）。
// 页面只管界面；结论全由 derive.ts（地址状态 → 推荐）和 brief.ts（任务书）算，同一个地址在页面、分享、采购、实验台算出同一个结果。
// 状态只走 state.ts 的 decode / encode：每次改动 replaceState 写回地址（不带「我已有」），所以复制地址栏就是分享。
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Collapsible, Dialog, Popover, RadioGroup } from 'radix-ui';
import { PARTS, TEMPLATES, type Template } from './data.ts';
import { capName, type Confidence } from './engine.ts';
import { EMPTY, decode, encode, loadHave, saveHave, type Budget, type SelectState } from './state.ts';
import {
  BUDGETS,
  MORE_CAPS,
  TEMPLATE_ORDER,
  addable,
  answers,
  avgCurrent,
  boardShort,
  changeText,
  confCounts,
  exposedCount,
  kindName,
  lasts,
  partName,
  partRows,
  pinFull,
  pinKind,
  pinName,
  relaxOptions,
  resolve,
  sanitize,
  simConf,
  sleepCurrent,
  trustRows,
  usedPins,
  yuan,
  type PartRow,
  type Result,
} from './derive.ts';
import { briefMarkdown, checkpointsOf } from './brief.ts';
import { PART_MAP, boardFor } from './catalogmap.ts';
import type { Plan } from './engine.ts';
import { Conf, ConfBar, ConfIcon } from '../ui/conf';
import { SiteFooter, SiteHeader } from '../ui/site';
import { SELECT, SITE_NAV, customLab, lab, selectLink } from '../ui/links';
import { cn } from '../ui/cn';

/** < 768px 用手机布局（DESIGN_V2 §0）。只渲染一套，免得 id 重复、术语「首次出现」算错 */
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

// ---------------------------------------------------------------- 项目线稿（DesA：120×96、描边 4、圆头；不用 emoji）
const TONE: Record<string, [string, string]> = {
  weather: ['#0B76C8', '#E5F4FF'],
  lights: ['#7A4BC9', '#F7F2FF'],
  usbkey: ['#B26A00', '#FFF6E5'],
  smarthome: ['#0E7A41', '#EAF7EF'],
};
const ART: Record<string, ReactNode> = {
  weather: (
    <>
      <rect x="14" y="20" width="60" height="40" rx="6" />
      <path d="M92 18v44" />
      <circle cx="92" cy="70" r="9" />
    </>
  ),
  lights: (
    <>
      <path d="M10 60c14-20 26-20 40 0s26 20 40 0" />
      <circle cx="38" cy="45" r="5" />
      <circle cx="74" cy="72" r="5" />
    </>
  ),
  usbkey: (
    <>
      <rect x="16" y="30" width="88" height="40" rx="8" />
      <rect x="30" y="42" width="16" height="16" rx="3" />
      <rect x="56" y="42" width="16" height="16" rx="3" />
    </>
  ),
  smarthome: (
    <>
      <path d="M20 50L60 18l40 32" />
      <path d="M32 42v36h56V42" />
      <path d="M52 78V58h16v20" />
    </>
  ),
  blink: (
    <>
      <circle cx="60" cy="40" r="20" />
      <path d="M50 66h20M53 76h14" />
    </>
  ),
  voice: (
    <>
      <rect x="48" y="12" width="24" height="44" rx="12" />
      <path d="M34 44a26 26 0 0 0 52 0M60 70v14" />
    </>
  ),
  camera: (
    <>
      <rect x="16" y="28" width="88" height="52" rx="8" />
      <circle cx="60" cy="54" r="15" />
      <path d="M42 28l6-10h24l6 10" />
    </>
  ),
  btaudio: (
    <>
      <path d="M22 40h16l22-18v52L38 56H22z" />
      <path d="M76 36a20 20 0 0 1 0 24M86 26a34 34 0 0 1 0 44" />
    </>
  ),
  more: <path d="M40 48h40M60 28v40" />,
};
function Art({ id, className }: { id: string; className?: string }) {
  const [ink, bg] = TONE[id] ?? ['#6F6F6F', '#F5F5F5'];
  return (
    <span className={cn('inline-flex flex-none items-center justify-center rounded-lg dark:!bg-field', className)} style={{ background: bg }}>
      <svg width="44" height="34" viewBox="0 0 120 96" fill="none" stroke={ink} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="dark:brightness-[1.7]">
        {ART[id]}
      </svg>
    </span>
  );
}

const Ico = ({ d, size = 16, className }: { d: string; size?: number; className?: string }) => (
  <svg className={cn('flex-none', className)} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const CHECK = 'M5 12.5l4.5 4.5L19 7';
const CHEV = 'M6 9l6 6 6-6';
const SHARE = 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1';

// ---------------------------------------------------------------- 术语（FrA）：只标页面上第一次出现的；两句话：是什么 + 对你的项目
type TermKey = 'GPIO' | 'I2C' | 'SPI' | 'PSRAM' | '深睡' | 'ADC' | 'PWM' | '原生 USB';
const TERM_WHAT: Record<TermKey, string> = {
  GPIO: '能自己定义用途的引脚。',
  I2C: '两根线挂多个传感器（SDA 数据、SCL 时钟，靠地址区分）。',
  SPI: '更快的四线接口，屏幕常用。',
  PSRAM: '外挂内存，摄像头 / 语音要。',
  深睡: '几乎断电，只留定时唤醒。',
  ADC: '把电压读成数字。',
  PWM: '快速开关，调亮度 / 舵机。',
  '原生 USB': '板子能当键盘 / U 盘。',
};

function termYou(k: TermKey, r: Result): string {
  const p = r.plan;
  if (!p) return '';
  const b = p.board;
  const byKind = (kind: string) => p.pins.filter((a) => pinKind(a.label, r.need.parts) === kind);
  const names = (kind: string) => r.need.parts.filter((id) => PARTS[id].needs.some((n) => n.kind === kind)).map(partName);
  const pinsOf = (kind: string) => Array.from(new Set(byKind(kind).flatMap((a) => a.pins))).map((x) => pinName(b, x));
  switch (k) {
    case 'GPIO':
      return `${boardShort(b)} 能用的 GPIO 有 ${exposedCount(p)} 个，你的项目占 ${usedPins(p).length} 个。`;
    case 'I2C': {
      const n = names('i2c');
      return n.length ? `${n.join('、')} 共用 ${pinsOf('i2c').join(' / ')} 两根线，地址不同所以不打架。` : '你的项目现在没用 I2C 器件。';
    }
    case 'SPI':
      return names('spi').length ? `${names('spi').join('、')}走 SPI，接 ${pinsOf('spi').join(' / ')}。` : '你的项目现在没用 SPI。';
    case 'PSRAM':
      return b.psramMB ? `${boardShort(b)} 带 ${b.psramMB}MB PSRAM${r.need.caps.includes('psram') ? '，你的项目要靠它放音频 / 图像。' : '，你的项目暂时用不上。'}` : `${boardShort(b)} 没有 PSRAM，你的项目也不需要。`;
    case '深睡':
      return answers(r.s).bat && p.power ? `${boardShort(b)} 整板深睡约 ${sleepCurrent(b.boardSleepUA)}，决定了电池能撑${lasts(p.power.days)}。` : '你没选「用电池」，深睡电流不影响你。';
    case 'ADC':
      return names('adc').length ? `${names('adc').join('、')}接 ${pinsOf('adc').join(' / ')}（ADC1，连 Wi-Fi 时也能读）。` : '你的项目现在没用 ADC。';
    case 'PWM':
      return names('pwm').length ? `${names('pwm').join('、')}用 PWM，接 ${pinsOf('pwm').join(' / ')}。` : '你的项目现在没用 PWM。';
    case '原生 USB':
      return p.chip.caps.includes('usb_otg') ? `${p.chip.name} 有原生 USB，插电脑就能当键盘。` : `${p.chip.name} 没有原生 USB，只能当串口，做不了键盘。`;
  }
}

function Term({ k, you, mobile }: { k: TermKey; you: string; mobile: boolean }) {
  const trigger = (
    <button type="button" data-term={k} className="cursor-help border-0 border-b border-dashed border-current bg-transparent p-0 font-[inherit] text-[inherit] leading-[inherit] text-accent-ink">
      {k}
    </button>
  );
  const body = (
    <>
      <p className="font-bold">
        {k}：{TERM_WHAT[k]}
      </p>
      <p className="mt-1.5">对你的项目：{you}</p>
    </>
  );
  if (mobile)
    return (
      <Dialog.Root>
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content data-term-pop={k} aria-describedby={undefined} className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-line bg-surface px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] text-[15px] leading-[1.7] text-fg">
            <Dialog.Title className="sr-only">{k}</Dialog.Title>
            {body}
            <Dialog.Close className="mt-4 h-12 w-full cursor-pointer rounded-xl border border-line bg-surface text-[15px]">知道了</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content data-term-pop={k} side="top" sideOffset={6} collisionPadding={12} className="z-50 w-[300px] rounded-[10px] border border-[#3a3a3a] bg-[#1E1E1E] p-3.5 text-[13px] leading-[1.6] text-white shadow-lg">
          {body}
          <Popover.Arrow className="fill-[#1E1E1E]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------- 小件
const Lbl = ({ children, className, id }: { children: ReactNode; className?: string; id?: string }) => (
  <p id={id} className={cn('mb-2.5 text-[12px] font-bold tracking-[.06em] text-muted', className)}>
    {children}
  </p>
);

function Switch({ on, flip, q, label }: { on: boolean; flip: () => void; q: string; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} data-q={q} onClick={flip} className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 text-left text-[14px]">
      {label}
      <span className={cn('relative h-[22px] w-10 flex-none rounded-full transition-colors', on ? 'bg-accent' : 'bg-line')}>
        <span className={cn('absolute top-[3px] size-4 rounded-full bg-white shadow transition-[left]', on ? 'left-[21px]' : 'left-[3px]')} />
      </span>
    </button>
  );
}

const simText = (p: Plan) => (p.chip.simulated === 'full' ? '能跑' : p.chip.simulated === 'partial' ? '部分能跑' : `暂不能 · 用 C3 代替运行`);

// ---------------------------------------------------------------- 页面
interface Step {
  prev: SelectState;
  text: string;
}

export function App() {
  const mobile = useMobile();
  const [s, setS] = useState<SelectState>(() => ({ ...sanitize(decode(location.search)), have: loadHave() }));
  const [hist, setHist] = useState<Step[]>([]);
  const [moreTpl, setMoreTpl] = useState(() => TEMPLATE_ORDER.indexOf(s.t || 'weather') >= 3);
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<'' | 'parts' | 'qs'>('');
  const [toast, setToast] = useState('');
  const r = useMemo(() => resolve(s), [s]);
  const md = useMemo(() => briefMarkdown(s), [s]);
  const a = answers(r.s);
  const p = r.plan;
  const share = selectLink(encode({ ...r.s, have: [] }, false));
  const go = p ? customLab(encode({ ...r.s, board: p.board.id, have: s.have }, true)) : '';

  // 地址就是分享链接：每次改动写回（不带「我已有」）。旧链接 ?t=weather 解出来再写回同样的串
  useEffect(() => {
    const q = encode({ ...r.s, have: [] }, false);
    try {
      history.replaceState(null, '', q ? `?${q}` : location.pathname);
    } catch {
      /* 预览环境可能不允许改地址 */
    }
  }, [r.s]);
  // 给测试读：剪贴板在无头浏览器里不可靠，任务书和状态从这里取
  useEffect(() => {
    (globalThis as unknown as { __tbSelect?: unknown }).__tbSelect = { state: r.s, have: s.have, brief: md, go, share };
  });
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  /** 改一步：记下「刚才」那句话（推荐变没变、多占哪些引脚、价差），能连续撤销。「我已有」不进撤销栈 */
  const change = (label: string, f: (x: SelectState) => SelectState) => {
    const next = sanitize(f(r.s));
    if (encode(next) === encode(r.s)) return;
    setHist((h) => [...h, { prev: r.s, text: changeText(label, r, resolve(next)) }]);
    setS({ ...next, have: s.have });
  };
  const undo = () => {
    const top = hist[hist.length - 1];
    if (!top) return;
    setHist((h) => h.slice(0, -1));
    setS({ ...top.prev, have: s.have });
  };
  const toggleHave = (ids: string[]) => {
    const on = ids.every((id) => s.have.includes(id));
    const have = on ? s.have.filter((x) => !ids.includes(x)) : Array.from(new Set([...s.have, ...ids]));
    saveHave(have);
    setS({ ...s, have });
  };
  const copy = (text: string, done: string) => {
    const ok = () => setToast(done);
    try {
      navigator.clipboard.writeText(text).then(ok, () => setToast('浏览器不让复制，请手动选中'));
    } catch {
      setToast('浏览器不让复制，请手动选中');
    }
  };
  const copyShare = () => copy(new URL(share, location.href).href, '分享链接已复制');
  const copyBrief = () => copy(md, '任务书已复制');

  const pickTpl = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    change(`换成「${t.short}」`, (x) => ({ ...EMPTY, t: id, budget: x.budget }));
  };
  const flipRow = (row: PartRow) => {
    if (row.fixed) return;
    const n = partName(row.key);
    if (row.key === 'battery') return change(a.bat ? '不用电池' : '用电池', (x) => ({ ...x, bat: !a.bat }));
    if (r.tpl.parts.includes(row.key)) return change(row.on ? `去掉${n}` : `加回${n}`, (x) => ({ ...x, rm: row.on ? [...x.rm, row.key] : x.rm.filter((y) => y !== row.key) }));
    change(row.on ? `去掉${n}` : `加了${n}`, (x) => ({ ...x, add: row.on ? x.add.filter((y) => y !== row.key) : [...x.add, row.key] }));
  };
  const addPart = (id: string) => {
    setAdding(false);
    change(`加了${partName(id)}`, (x) => ({ ...x, add: [...x.add, id] }));
  };
  const pickBoard = (id: string) => {
    if (!p || id === p.board.id) return;
    const b = r.plans.find((x) => x.board.id === id)!;
    change(`看 ${boardShort(b.board)}`, (x) => ({ ...x, board: id === r.plans[0].board.id ? '' : id }));
  };

  // 术语：每次渲染重新算，按 JSX 求值顺序 = 页面顺序，只给第一次出现的加下划线
  const seen = new Set<TermKey>();
  const T = (k: TermKey): ReactNode => {
    if (seen.has(k)) return k;
    seen.add(k);
    return <Term key={`term-${k}`} k={k} you={termYou(k, r)} mobile={mobile} />;
  };

  // ------------------------------------------------ 输入：项目
  const ordered = TEMPLATE_ORDER.map((id) => TEMPLATES.find((t) => t.id === id)!).filter(Boolean);
  const big = ordered.slice(0, 3);
  const rest = ordered.slice(3);
  const tplItem = (t: Template, kind: 'big' | 'small' | 'pill') => {
    const on = t.id === r.tpl.id;
    if (kind === 'pill')
      return (
        <RadioGroup.Item
          key={t.id}
          value={t.id}
          data-t={t.id}
          className="tpl h-11 flex-none cursor-pointer rounded-full border border-line bg-surface px-4 text-[14px] whitespace-nowrap data-[state=checked]:border-fg data-[state=checked]:bg-fg data-[state=checked]:text-bg"
        >
          {t.short}
        </RadioGroup.Item>
      );
    return (
      <RadioGroup.Item
        key={t.id}
        value={t.id}
        data-t={t.id}
        className={cn(
          'tpl flex cursor-pointer rounded-xl border border-line bg-surface text-left transition hover:border-hover-line',
          'data-[state=checked]:border-2 data-[state=checked]:border-accent data-[state=checked]:bg-accent-bg',
          kind === 'big' ? 'flex-col items-start gap-2 p-3 data-[state=checked]:p-[11px]' : 'min-h-11 items-center gap-2 px-3 py-1.5 data-[state=checked]:px-[11px] data-[state=checked]:py-[5px]',
        )}
      >
        {kind === 'big' && <Art id={t.id} className="h-[42px] w-[54px]" />}
        <span className={cn('text-[14px]', on && 'font-bold')}>{t.short}</span>
        {kind === 'big' && <small className="text-[11px] leading-[1.4] text-muted">{t.parts.map(partName).join(' · ')}</small>}
      </RadioGroup.Item>
    );
  };
  const projects = mobile ? (
    <RadioGroup.Root id="templates" aria-label="你想做什么" value={r.tpl.id} onValueChange={pickTpl} orientation="horizontal" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {ordered.map((t) => tplItem(t, 'pill'))}
    </RadioGroup.Root>
  ) : (
    <RadioGroup.Root id="templates" aria-labelledby="tpl-label" value={r.tpl.id} onValueChange={pickTpl}>
      <div className="grid grid-cols-4 gap-2">
        {big.map((t) => tplItem(t, 'big'))}
        <button
          type="button"
          id="moreTpl"
          aria-expanded={moreTpl}
          onClick={() => setMoreTpl(!moreTpl)}
          className="flex cursor-pointer flex-col items-start gap-2 rounded-xl border border-dashed border-hover-line bg-surface p-3 text-left text-[14px] text-muted hover:border-fg"
        >
          <Art id="more" className="h-[42px] w-[54px]" />
          更多 {rest.length} 个
          <small className="text-[11px]">{moreTpl ? '收起' : rest.map((t) => t.short).slice(0, 3).join(' · ') + '…'}</small>
        </button>
      </div>
      {moreTpl && <div className="mt-2 flex flex-wrap gap-2">{rest.map((t) => tplItem(t, 'small'))}</div>}
    </RadioGroup.Root>
  );

  // ------------------------------------------------ 输入：零件即清单
  const rows = partRows(r);
  const rowEl = (row: PartRow) => {
    const have = row.haveIds.every((id) => s.have.includes(id));
    return (
      <li key={row.key} data-row={row.key} className="flex min-h-11 items-center gap-2.5 border-t border-line-soft px-3 py-1.5 first:border-t-0">
        <button
          type="button"
          role="checkbox"
          aria-checked={row.on}
          aria-disabled={row.fixed || undefined}
          aria-label={row.name}
          data-part={row.key}
          onClick={() => flipRow(row)}
          className={cn('-m-2 flex size-11 flex-none items-center justify-center md:size-8', row.fixed ? 'cursor-default' : 'cursor-pointer')}
        >
          <span
            className={cn(
              'flex size-4 items-center justify-center rounded-[4px]',
              row.on ? (row.fixed ? 'bg-muted text-bg' : 'bg-accent text-white') : 'border-[1.5px] border-dashed border-hover-line',
            )}
          >
            {row.on && <Ico d={CHECK} size={12} className="[stroke-width:3]" />}
          </span>
        </button>
        <span className="min-w-0 flex-1">
          <span className={cn('block text-[13px] leading-[1.35]', !row.on && 'text-muted', have && 'line-through decoration-muted')}>{row.name}</span>
          <small className="block text-[11px] text-muted">
            {row.src}
            {PART_MAP[row.key] === null && ' · 试板里没有模型'}
          </small>
        </span>
        <span className="flex-none font-mono text-[11px] text-muted">{yuan(row.price)}</span>
        {row.on && (
          <button
            type="button"
            aria-pressed={have}
            data-have={row.key}
            onClick={() => toggleHave(row.haveIds)}
            className={cn('h-7 flex-none cursor-pointer rounded-full px-2.5 text-[11px] max-md:h-11 max-md:px-3 max-md:text-[12px]', have ? 'bg-line-soft text-fg' : 'border border-line text-muted')}
          >
            {have ? '我已有' : '我已有？'}
          </button>
        )}
      </li>
    );
  };
  const partsBox = (
    <div id="parts" className="overflow-hidden rounded-xl border border-line bg-surface">
      <p className="bg-field px-3 py-1.5 text-[12px] font-bold text-muted">必选 · {r.tpl.short}要用</p>
      <ul>{rows.filter((x) => x.group === 'need').map(rowEl)}</ul>
      <p className="bg-field px-3 py-1.5 text-[12px] font-bold text-muted">建议</p>
      <ul>{rows.filter((x) => x.group === 'suggest').map(rowEl)}</ul>
      <div className="border-t border-line-soft">
        <button type="button" id="addPart" aria-expanded={adding} onClick={() => setAdding(!adding)} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-[13px] text-accent-ink">
          + 加零件
        </button>
        {adding && (
          <ul id="partTable" className="border-t border-line-soft">
            {addable(r.s).map((id) => (
              <li key={id}>
                <button type="button" data-add={id} onClick={() => addPart(id)} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left text-[13px] hover:bg-field">
                  <span className="flex-1">{PARTS[id].name}</span>
                  {PART_MAP[id] === null && <Conf c="必须上真机" size={12} className="text-[11px] text-muted" />}
                  <span className="font-mono text-[11px] text-muted">{yuan(PARTS[id].priceCNY)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  // ------------------------------------------------ 输入：三个白话问题 + 预算 + 更多需求
  const questions = (
    <div id="questions">
      <Switch q="bat" label="用电池供电？" on={a.bat} flip={() => change(a.bat ? '不用电池' : '用电池', (x) => ({ ...x, bat: !a.bat }))} />
      <Switch q="net" label="要连网（Wi-Fi / 蓝牙）？" on={a.net} flip={() => change(a.net ? '不连网' : '要连网', (x) => ({ ...x, net: !a.net }))} />
      <Switch q="sim" label="要在试板里先跑通？" on={a.sim} flip={() => change(a.sim ? '不要求先在试板里跑通' : '要在试板里先跑通', (x) => ({ ...x, sim: !a.sim }))} />
      <p id="budget-label" className="mt-3 mb-1.5 text-[14px]">
        预算
      </p>
      <div id="budget" role="radiogroup" aria-labelledby="budget-label" className="grid grid-cols-4 gap-0.5 rounded-[10px] bg-field p-[3px] text-[13px]">
        {BUDGETS.map((b) => (
          <button
            key={b}
            type="button"
            role="radio"
            aria-checked={r.s.budget === b}
            data-budget={b}
            onClick={() => change(b ? `预算 ¥${b}` : '预算不限', (x) => ({ ...x, budget: b as Budget }))}
            className={cn('h-9 cursor-pointer rounded-lg max-md:h-11', r.s.budget === b ? 'bg-fg font-bold text-bg' : 'text-fg')}
          >
            {b ? `¥${b}` : '不限'}
          </button>
        ))}
      </div>
      <Collapsible.Root defaultOpen={r.s.req.length > 0} className="mt-3">
        <Collapsible.Trigger id="moreReq" className="group flex min-h-11 w-full cursor-pointer items-center justify-between text-left text-[13px] text-muted">
          更多需求（Thread、经典蓝牙、PSRAM、原生 USB…）
          <span className="flex items-center gap-1">
            {r.s.req.length > 0 && <b className="text-accent-ink">{r.s.req.length}</b>}
            <Ico d={CHEV} className="transition-transform group-data-[state=open]:rotate-180" />
          </span>
        </Collapsible.Trigger>
        <Collapsible.Content className="flex flex-wrap gap-1.5 pb-1">
          {MORE_CAPS.map((c) => {
            const on = r.s.req.includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                data-cap={c}
                onClick={() => change(on ? `不要${capName(c)}` : `要${capName(c)}`, (x) => ({ ...x, req: on ? x.req.filter((y) => y !== c) : [...x.req, c] }))}
                className={cn('inline-flex h-8 cursor-pointer items-center gap-1 rounded-full border px-3 text-[12px] max-md:h-11', on ? 'border-fg bg-fg text-bg' : 'border-line bg-surface')}
              >
                {on && <Ico d={CHECK} size={12} />}
                {capName(c)}
              </button>
            );
          })}
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  );

  // ------------------------------------------------ 结果：刚才
  const top = hist[hist.length - 1];
  const recent = top && (
    <div id="recent" role="status" className="flex items-center gap-3 rounded-[10px] bg-accent-bg px-3.5 py-2.5 text-[13px] text-accent-ink">
      <span className="min-w-0 flex-1">
        <b>刚才：</b>
        <span id="recentText">{top.text}</span>
      </span>
      <button type="button" id="undo" onClick={undo} className="h-8 flex-none cursor-pointer rounded-lg border border-accent-line bg-surface px-3 text-[13px] text-accent-ink max-md:h-11">
        撤销{hist.length > 1 ? `（${hist.length}）` : ''}
      </button>
    </div>
  );

  // ------------------------------------------------ 结果：0 块板（FrC）
  const none = !p && (
    <section id="none" className="rounded-[14px] border-2 border-line bg-surface p-5">
      <h2 className="text-[18px] font-bold">没有板子同时满足这 {r.need.caps.length + (r.s.budget ? 1 : 0) + (a.bat ? 1 : 0)} 个条件</h2>
      {(() => {
        const opts = relaxOptions(r);
        return opts.length ? (
          <>
            <p className="mt-2 text-[14px] text-muted">去掉其中一个就有：</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {opts.map((o) => (
                <li key={o.label}>
                  <button type="button" data-relax={o.label} onClick={() => change(o.label, () => o.next)} className="flex min-h-11 w-full cursor-pointer items-center justify-between rounded-lg border border-line px-3.5 text-left text-[14px] hover:border-accent">
                    {o.label} → {o.n} 块
                    <Ico d="M9 6l6 6-6 6" className="text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-2 text-[14px] text-muted">这些需求放在一起没有乐鑫芯片能做，换个项目试试。</p>
        );
      })()}
    </section>
  );

  // ------------------------------------------------ 结果：答案先行
  const sub = p ? boardFor(p.board.id).sub : undefined;
  const reason = (pl: Plan): ReactNode => {
    if (r.s.board && r.plans[0] !== pl) return <>你在对比里选了它；系统首推的是 {r.plans[0].board.name}。</>;
    const cheapest = [...r.plans].sort((x, y) => x.total[0] - y.total[0])[0] === pl;
    if (a.bat && pl.power)
      return (
        <>
          {T('深睡')}时整板只有 {sleepCurrent(pl.board.boardSleepUA)}，1000mAh 电池能撑{lasts(pl.power.days)}
          {pl.board.battery ? '，还自带锂电池充电' : ''}。
        </>
      );
    if (r.need.caps.includes('usb_otg')) return <>芯片带{T('原生 USB')}，插电脑就是键盘{cheapest ? '，也是能做的板里最便宜的' : ''}。</>;
    return <>满足你的全部条件{cheapest ? '，是其中最便宜的' : ''}{pl.chip.simulated !== 'none' ? '，买之前能在试板里先跑你的固件' : ''}。</>;
  };
  const stat = (k: string, v: ReactNode, c: Confidence, id: string) => (
    <div data-stat={id}>
      <p className="text-[12px] text-muted">{k}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[24px] leading-tight font-bold max-md:text-[20px]">
        {v}
        <span title={c} className="text-fg">
          <ConfIcon c={c} size={14} />
        </span>
      </p>
    </div>
  );
  const answer = p && (
    <section id="answer" className="rounded-[14px] border-2 border-accent bg-surface p-5 max-md:p-4">
      <p className="text-[12px] font-bold tracking-[.06em] text-accent-ink">买这块</p>
      <h2 id="boardName" className="mt-1 text-[30px] leading-tight font-bold max-md:text-[24px]">
        {p.board.name}
      </h2>
      <p className="mt-0.5 text-[13px] text-muted">
        {p.chip.name} · {p.board.maker}
        {r.s.board && ' · 你在对比里选的'}
      </p>
      <div className="mt-4 grid grid-cols-3 gap-4 max-md:gap-2">
        {stat('整套参考价', yuan(p.total), '估算', 'price')}
        {p.power ? stat('续航', lasts(p.power.days).replace('约 ', ''), p.power.confidence, 'life') : stat('续航', '插电用', '估算', 'life')}
        {stat('能跑固件', p.chip.simulated === 'none' ? '暂不能' : p.chip.simulated === 'full' ? '能' : '部分', simConf(p), 'sim')}
      </div>
      <p id="reason" className="mt-4 text-[14px] leading-[1.7]">
        {reason(p)}
        {sub && <span className="text-muted">（{sub}）</span>}
      </p>
    </section>
  );

  // ------------------------------------------------ 结果：为什么是它
  const whyRows = (pl: Plan): [ReactNode, Confidence][] => {
    const out: [ReactNode, Confidence][] = [];
    const kinds = new Set(pl.pins.map((x) => pinKind(x.label, r.need.parts)));
    const n = r.need.parts.length;
    if (pl.pinProblems.length) out.push([<>引脚不够：{pl.pinProblems.join('；')}</>, '估算']);
    else
      out.push([
        <>
          {n} 个零件都接得上，占 {usedPins(pl).length} 个 {T('GPIO')}（共 {exposedCount(pl)} 个）
          {kinds.has('i2c') && <>，传感器和屏幕共用 {T('I2C')} 两根线</>}
          {kinds.has('spi') && <>，彩屏走 {T('SPI')}</>}
          {kinds.has('pwm') && <>，{T('PWM')} 引脚够用</>}
          {kinds.has('adc') && <>，电位器接 {T('ADC')}</>}
        </>,
        '估算',
      ]);
    if (a.bat && pl.power) out.push([<>{T('深睡')} 时整板约 {sleepCurrent(pl.board.boardSleepUA)}，平均 {avgCurrent(pl.power.avgMA)}，电池{lasts(pl.power.days)}</>, pl.power.confidence]);
    if (r.need.caps.includes('usb_otg')) out.push([<>{T('原生 USB')}：能冒充键盘、U 盘</>, simConf(pl)]);
    if (r.need.caps.includes('psram')) out.push([<>{pl.board.psramMB}MB {T('PSRAM')}，放得下音频和图像</>, '估算']);
    const noModel = r.need.parts.filter((id) => PART_MAP[id] === null).map(partName);
    if (pl.chip.simulated === 'none') out.push([<>{pl.chip.name} 还不能仿真：试板里用 ESP32-C3 代替运行，结果只作参考</>, '必须上真机']);
    else out.push([<>能在试板里先跑你的固件（{pl.chip.name}{pl.chip.simulated === 'partial' ? '，部分外设是行为模拟' : ''}）</>, simConf(pl)]);
    if (noModel.length) out.push([<>{noModel.join('、')}试板里没有模型，这部分要上真机</>, '必须上真机']);
    const cheap = [...r.plans].sort((x, y) => x.total[0] - y.total[0])[0];
    if (cheap === pl) out.push([<>满足条件的 {r.plans.length} 块板里最便宜</>, '估算']);
    else out.push([<>比最便宜的 {boardShort(cheap.board)} 贵 ¥{Math.round(pl.total[0] - cheap.total[0])} 起</>, '估算']);
    return out.slice(0, 4);
  };
  const trust = p ? trustRows(p, r.need) : [];
  const why = p && (
    <section id="why" className="rounded-[14px] border border-line bg-surface p-5 max-md:p-4">
      <div className="flex items-center justify-between gap-4 max-md:flex-col max-md:items-start">
        <h3 className="text-[16px] font-bold">为什么是它</h3>
        <ConfBar counts={confCounts(trust)} className="w-[200px] text-fg" />
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 max-md:grid-cols-1">
        {whyRows(p).map(([t, c], i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-[1.6]">
            <span className="mt-[3px] text-fg" title={c}>
              <ConfIcon c={c} size={14} />
            </span>
            <span>{t}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {(['仿真验证', '行为模拟', '估算', '必须上真机'] as Confidence[]).map((c) => (
          <Conf key={c} c={c} size={11} />
        ))}
      </p>
    </section>
  );

  // ------------------------------------------------ 结果：全部细节
  const details = p && (
    <Collapsible.Root className="rounded-[14px] border border-line bg-surface">
      <Collapsible.Trigger id="detailsBtn" className="group flex min-h-12 w-full gap-3 cursor-pointer items-center justify-between px-5 text-left text-[14px] max-md:px-4">
        <span>
          <b>全部细节</b>
          <span className="text-muted">（引脚表、功耗分解、必须上真机、计算依据）</span>
        </span>
        <span className="flex flex-none items-center gap-1 whitespace-nowrap text-[13px] text-muted">
          <span className="group-data-[state=open]:hidden">展开</span>
          <span className="hidden group-data-[state=open]:inline">收起</span>
          <Ico d={CHEV} className="transition-transform group-data-[state=open]:rotate-180" />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content id="details" className="border-t border-line-soft px-5 pt-4 pb-5 text-[13px] max-md:px-4">
        <h4 className="mb-2 font-bold">引脚表</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-muted">
              <tr>
                <th className="py-1 pr-3 font-normal">用途</th>
                <th className="py-1 pr-3 font-normal">接口</th>
                <th className="py-1 pr-3 font-normal">引脚</th>
              </tr>
            </thead>
            <tbody>
              {p.pins.map((x) => {
                const k = pinKind(x.label, r.need.parts);
                const term = (['I2C', 'SPI', 'PWM', 'ADC', 'GPIO'] as string[]).includes(kindName(k)) ? T(kindName(k) as TermKey) : kindName(k);
                return (
                  <tr key={x.label} className="border-t border-line-soft">
                    <td className="py-1.5 pr-3">{x.label.split('（')[0]}</td>
                    <td className="py-1.5 pr-3">{term}</td>
                    <td className="py-1.5 pr-3 font-mono text-[12px]">{x.pins.map((n) => pinFull(p.board, n)).join(' / ') || x.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {p.pinProblems.length > 0 && <p className="mt-2 text-bad-ink">{p.pinProblems.join('；')}</p>}
        {p.power && (
          <>
            <h4 className="mt-4 mb-2 flex items-center gap-2 font-bold">
              功耗分解 <Conf c={p.power.confidence} size={12} className="text-[11px] font-normal text-muted" />
            </h4>
            <p className="leading-[1.7] text-muted">
              平均 {avgCurrent(p.power.avgMA)}，1000mAh 电池{lasts(p.power.days)}。{p.power.breakdown}
            </p>
          </>
        )}
        <h4 className="mt-4 mb-2 font-bold">必须上真机</h4>
        <ul className="flex flex-col gap-1.5">
          {trust
            .filter(([, c]) => c === '必须上真机')
            .map(([t]) => (
              <li key={t} className="flex gap-2">
                <ConfIcon c="必须上真机" size={13} className="mt-[3px]" />
                {t}
              </li>
            ))}
          {[...r.tpl.risks, ...p.warnings].map((t) => (
            <li key={t} className="flex gap-2 text-muted">
              <span className="mt-[9px] size-1 flex-none rounded-full bg-muted" />
              {t}
            </li>
          ))}
        </ul>
        <h4 className="mt-4 mb-2 font-bold">计算依据</h4>
        <ul className="flex flex-col gap-1">
          {trust.map(([t, c]) => (
            <li key={t} className="flex items-center justify-between gap-3 border-t border-line-soft py-1 first:border-t-0">
              <span>{t}</span>
              <Conf c={c} size={12} className="flex-none text-[12px] text-muted" />
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] leading-[1.7] text-muted">
          数据来自乐鑫芯片数据手册与开发板厂商公开资料，价格为常见网店价区间，以购买时为准。功耗按数据手册典型值估算，实测会因板子做工、信号强度、固件写法而变化。
          试板按零件生成的检查点：{checkpointsOf(r).map((c) => c.name).join('、')}。
        </p>
      </Collapsible.Content>
    </Collapsible.Root>
  );

  // ------------------------------------------------ 结果：三板对比
  const trio = p && !r.trio.some((x) => x.p === p) ? [...r.trio.slice(0, 2), { p, tag: '你选的' }] : r.trio;
  const cmpRows: [string, (x: Plan) => ReactNode][] = [
    ['参考价', (x) => yuan(x.total)],
    ['续航（估算）', (x) => (x.power ? lasts(x.power.days) : '插电用')],
    ['深睡', (x) => sleepCurrent(x.board.boardSleepUA)],
    ['在试板里', (x) => simText(x)],
  ];
  const compare = p && trio.length > 1 && (
    <section id="compare">
      <h3 className="mb-2.5 text-[16px] font-bold">{mobile ? '三块板对比 · 左右滑' : '三块板对比'}</h3>
      <div className={cn(mobile ? '-mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-1' : 'grid grid-cols-3 gap-3')}>
        {trio.map(({ p: x, tag }) => {
          const on = x === p;
          return (
            <button
              key={x.board.id}
              type="button"
              data-board={x.board.id}
              aria-pressed={on}
              onClick={() => pickBoard(x.board.id)}
              className={cn(
                'flex cursor-pointer flex-col rounded-xl border bg-surface p-4 text-left',
                mobile && 'w-[300px] flex-none snap-start',
                on ? 'border-2 border-accent p-[15px]' : 'border-line hover:border-hover-line',
              )}
            >
              <span className="text-[11px] font-bold tracking-[.06em] text-muted">{tag}</span>
              <span className="mt-0.5 text-[15px] font-bold">{boardShort(x.board)}</span>
              <dl className="mt-2.5 grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                {cmpRows.map(([k, f]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted">{k}</dt>
                    <dd className={cn('text-right', k === '在试板里' && x.chip.simulated === 'none' && 'text-muted')}>{f(x)}</dd>
                  </div>
                ))}
              </dl>
            </button>
          );
        })}
      </div>
    </section>
  );

  // ------------------------------------------------ 结果：任务书
  const brief = p && (
    <section id="briefBox" className="rounded-[14px] border border-line bg-surface p-5 max-md:p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[16px] font-bold">任务书</h3>
        <button type="button" id="copyBrief" onClick={copyBrief} className="h-9 cursor-pointer rounded-lg border border-line px-3 text-[13px] max-md:h-11">
          复制任务书
        </button>
      </div>
      <p className="mt-1 text-[12px] text-muted">贴给写代码的 AI 或自己照着做；验收一节就是试板会判的检查点。</p>
      <pre id="briefText" className="mt-3 max-h-[320px] overflow-auto rounded-lg bg-field p-3 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap">
        {md}
      </pre>
    </section>
  );

  // ------------------------------------------------ 下一步
  const goBtn = (cls: string) =>
    p && (
      <a id="go" href={go} className={cn('flex flex-col items-center justify-center rounded-xl bg-accent-strong text-on-accent hover:opacity-90', cls)}>
        <span className="text-[16px] font-bold">按这套开始做 →</span>
        <span className="text-[12px] opacity-90">进采购，清单已填好</span>
      </a>
    );
  const next = p && (
    <aside className="flex w-[300px] flex-none flex-col gap-2">
      {goBtn('h-14')}
      <button type="button" id="share" onClick={copyShare} className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line bg-surface text-[14px]">
        <Ico d={SHARE} /> 复制分享链接
      </button>
      <button type="button" onClick={copyBrief} className="h-10 cursor-pointer rounded-lg border border-line bg-surface text-[14px]">
        复制任务书
      </button>
      {r.tpl.work && (
        <a href={lab(r.tpl.work, 'shop')} className="mt-1 text-center text-[13px] text-accent-ink hover:underline">
          看现成的「{r.tpl.short}」作品
        </a>
      )}
      <p className="mt-1 text-[12px] leading-[1.6] text-muted">「我已有」的零件进采购时会标出来，不重复买。</p>
    </aside>
  );

  const toastEl = toast && (
    <p id="toast" role="status" className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-fg px-4 py-2 text-[13px] text-bg shadow-lg max-md:bottom-[88px]">
      {toast}
    </p>
  );

  // ------------------------------------------------ 手机（SelectCMobile）
  if (mobile) {
    const summaryParts = [...r.need.parts.map(partName), ...(a.bat ? ['锂电池'] : []), '线'].join(' · ');
    const summaryQs = [a.bat ? '用电池' : '插电', a.net ? '连 Wi-Fi' : '不连网', r.s.budget ? `预算 ¥${r.s.budget}` : '预算不限'].join(' · ');
    const sumRow = (k: 'parts' | 'qs', text: string) => (
      <button type="button" data-edit={k} aria-expanded={edit === k} onClick={() => setEdit(edit === k ? '' : k)} className="flex min-h-12 w-full cursor-pointer items-center gap-3 border-t border-line-soft px-4 text-left text-[14px] first:border-t-0">
        <span className="min-w-0 flex-1 truncate">{text}</span>
        <span className="text-accent-ink">{edit === k ? '收起' : '改'}</span>
      </button>
    );
    return (
      <div className="flex min-h-screen flex-col pb-[84px]">
        <SiteHeader current={SELECT} subtitle="选板" links={SITE_NAV} />
        <main className="flex flex-1 flex-col gap-3 px-4 pt-4 pb-6">
          <h1 className="text-[22px] font-bold">选板</h1>
          {projects}
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            {sumRow('parts', summaryParts)}
            {edit === 'parts' && <div className="border-t border-line-soft p-2">{partsBox}</div>}
            {sumRow('qs', summaryQs)}
            {edit === 'qs' && <div className="border-t border-line-soft px-4 pb-3">{questions}</div>}
          </div>
          {recent}
          {none}
          {answer}
          {why}
          {compare}
          {details}
          {brief}
          {r.tpl.work && (
            <a href={lab(r.tpl.work, 'shop')} className="flex min-h-11 items-center text-[14px] text-accent-ink">
              看现成的「{r.tpl.short}」作品
            </a>
          )}
        </main>
        <SiteFooter />
        {p && (
          <div id="mobileBar" className="fixed inset-x-0 bottom-0 z-[6] flex gap-2 border-t border-line-soft bg-bg px-4 pt-2.5 pb-[max(12px,env(safe-area-inset-bottom))]">
            {goBtn('h-12 flex-1')}
            <button type="button" id="share" aria-label="复制分享链接" onClick={copyShare} className="flex size-12 flex-none cursor-pointer items-center justify-center rounded-xl border border-line bg-surface">
              <Ico d={SHARE} size={20} />
            </button>
          </div>
        )}
        {toastEl}
      </div>
    );
  }

  // ------------------------------------------------ 桌面（Rec）
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader current={SELECT} subtitle="选板" links={SITE_NAV} />
      <main className="grid flex-1 grid-cols-[500px_1fr] max-lg:grid-cols-[420px_1fr]">
        <section aria-label="你的项目" className="border-r border-line-soft bg-field/40 px-[26px] py-6">
          <h1 className="text-[22px] font-bold">选板</h1>
          <p className="mt-1 mb-5 text-[13px] text-muted">选项目、勾零件、答三个问题，右边直接告诉你买哪块。</p>
          <Lbl id="tpl-label">你想做什么</Lbl>
          {projects}
          <Lbl className="mt-6">零件（就是清单）</Lbl>
          {partsBox}
          <Lbl className="mt-6">三个问题</Lbl>
          {questions}
        </section>
        <section aria-label="推荐" aria-live="polite" className="flex min-w-0 flex-col gap-4 px-8 py-6 max-lg:px-5">
          {recent}
          {none}
          {p && (
            <div className="flex gap-4 max-xl:flex-col">
              <div className="min-w-0 flex-1">{answer}</div>
              {next}
            </div>
          )}
          {why}
          {details}
          {compare}
          {brief}
        </section>
      </main>
      <SiteFooter />
      {toastEl}
    </div>
  );
}
