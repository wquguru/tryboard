// 选板 v3：地址状态（state.ts 的 SelectState）→ 推荐结果。页面、任务书（brief.ts）、采购页都从这里算，保证同一个地址算出同一个结论。
// 纯函数，不碰 DOM；import 带 .ts 后缀，node --test 能直接跑。
import { BOARDS, PARTS, TEMPLATES, type Board, type Cap, type Template } from './data.ts';
import { capName, recommend, type Confidence, type Need, type Plan, type Rejected } from './engine.ts';
import { PART_MAP, ALWAYS } from './catalogmap.ts';
import type { Budget, SelectState } from './state.ts';

/** 「更多需求」里能点名的硬需求（Wi-Fi 由「要连网」管，低功耗由「用电池」管） */
export const MORE_CAPS: Cap[] = ['ble', 'bt_classic', 'thread', 'zigbee', 'wifi6', 'usb_otg', 'camera', 'audio_in', 'audio_out', 'psram', 'display_rgb', 'touch', 'dac', 'ethernet'];
export const BUDGETS: Budget[] = [0, 60, 120, 200];
/** 项目卡顺序：前 3 个是大卡（都有现成作品），其余收进「更多」 */
export const TEMPLATE_ORDER = ['weather', 'lights', 'usbkey', 'blink', 'smarthome', 'voice', 'camera', 'btaudio'];

const DEFAULT_T = 'weather';
const NET_CAPS: Cap[] = ['wifi', 'ble'];

export const templateOf = (s: Pick<SelectState, 't'>): Template => TEMPLATES.find((t) => t.id === s.t) ?? TEMPLATES.find((t) => t.id === DEFAULT_T)!;

/** 地址里来的 id 可能是旧的或手敲错的：只留认得的，模板缺省补成默认项目 */
export function sanitize(s: SelectState): SelectState {
  const tpl = templateOf(s);
  const part = (id: string) => id in PARTS && id !== 'battery';
  const uniq = (xs: string[]) => Array.from(new Set(xs));
  return {
    ...s,
    t: tpl.id,
    add: uniq(s.add.filter((id) => part(id) && !tpl.parts.includes(id))),
    rm: uniq(s.rm.filter((id) => tpl.parts.includes(id) && id !== 'battery')),
    req: uniq(s.req.filter((c) => (MORE_CAPS as string[]).includes(c))),
    board: BOARDS.some((b) => b.id === s.board) ? s.board : '',
    have: uniq(s.have),
  };
}

/** 三个白话问题的模板默认值 */
export function defaults(tpl: Template) {
  return {
    bat: tpl.needCaps.includes('low_power') || tpl.parts.includes('battery'),
    net: tpl.needCaps.some((c) => NET_CAPS.includes(c)),
    // 只有不能仿真的芯片才做得了的项目（经典蓝牙），默认不要求先跑通
    sim: !tpl.needCaps.includes('bt_classic'),
  };
}

export function answers(s: SelectState) {
  const d = defaults(templateOf(s));
  return { bat: s.bat ?? d.bat, net: s.net ?? d.net, sim: s.sim ?? d.sim };
}

/** 选中的零件（不含电池：电池走「用电池」问题） */
export function selectedParts(s: SelectState): string[] {
  const tpl = templateOf(s);
  return [...tpl.parts.filter((p) => p !== 'battery' && !s.rm.includes(p)), ...s.add.filter((p) => p !== 'battery')];
}

export function needOf(s: SelectState): Need {
  const tpl = templateOf(s);
  const a = answers(s);
  let caps: Cap[] = tpl.needCaps.filter((c) => c !== 'low_power');
  if (a.net && !caps.some((c) => NET_CAPS.includes(c))) caps.push('wifi');
  if (!a.net) caps = caps.filter((c) => !NET_CAPS.includes(c));
  caps = Array.from(new Set([...caps, ...(s.req as Cap[])]));
  return {
    caps,
    nice: [...(tpl.niceCaps ?? [])],
    parts: selectedParts(s),
    battery: a.bat,
    duty: a.bat ? { ...(tpl.duty ?? { wakePerHour: 6, activeSec: 3, wifi: a.net }), wifi: a.net } : undefined,
    budget: s.budget || undefined,
    sim: a.sim,
  };
}

export type SimState = 'full' | 'partial' | 'none';
export const simOf = (p: Plan): SimState => p.chip.simulated;
export const simConf = (p: Plan): Confidence => (p.chip.simulated === 'full' ? '仿真验证' : p.chip.simulated === 'partial' ? '行为模拟' : '必须上真机');

export interface Result {
  s: SelectState;
  tpl: Template;
  need: Need;
  /** 满足硬需求、且在预算内的板（按分数排） */
  plans: Plan[];
  rejected: Rejected[];
  /** 当前展示的板：用户在对比里点过的，否则第一名 */
  plan?: Plan;
  /** 三板对比：最合适 / 最便宜 / 最省电（或下一名） */
  trio: { p: Plan; tag: string }[];
}

export function resolve(s0: SelectState): Result {
  const s = sanitize(s0);
  const tpl = templateOf(s);
  const need = needOf(s);
  const r = recommend(need);
  // 预算是硬条件：最低参考价都超了的板不进推荐（FrC：0 块时给「预算放宽」）
  const plans = s.budget ? r.plans.filter((p) => p.total[0] <= s.budget) : r.plans;
  const rejected = [...r.rejected, ...r.plans.filter((p) => !plans.includes(p)).map((p) => ({ board: p.board, why: `整套最低约 ¥${p.total[0]}，超出预算 ¥${s.budget}` }))];
  const plan = plans.find((p) => p.board.id === s.board) ?? plans[0];
  return { s, tpl, need, plans, rejected, plan, trio: trioOf(plans, need) };
}

function trioOf(plans: Plan[], need: Need) {
  if (!plans.length) return [];
  const out: { p: Plan; tag: string }[] = [{ p: plans[0], tag: '最合适' }];
  const rest = () => plans.filter((p) => !out.some((o) => o.p === p));
  const cheap = [...rest()].sort((a, b) => a.total[0] - b.total[0])[0];
  if (cheap && cheap.total[0] < plans[0].total[0]) out.push({ p: cheap, tag: '最便宜' });
  if (need.battery) {
    const low = [...rest()].sort((a, b) => a.board.boardSleepUA - b.board.boardSleepUA)[0];
    if (low && low.board.boardSleepUA < plans[0].board.boardSleepUA) out.push({ p: low, tag: '最省电' });
  }
  for (const p of rest()) {
    if (out.length >= 3) break;
    out.push({ p, tag: '备选' });
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------- 文字小件
export const yuan = (p: [number, number]) => (p[0] === p[1] ? `¥${fmtN(p[0])}` : `¥${fmtN(p[0])}–${fmtN(p[1])}`);
const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export const lasts = (days: number) => (days >= 365 ? `约 ${(days / 365).toFixed(1)} 年` : `约 ${days.toFixed(0)} 天`);
export const avgCurrent = (mA: number) => (mA < 1 ? (mA * 1000).toFixed(0) + 'µA' : mA.toFixed(2) + 'mA');
export const sleepCurrent = (uA: number) => (uA >= 1000 ? `${(uA / 1000).toFixed(uA % 1000 ? 1 : 0)}mA` : `${uA}µA`);
/** 引脚名：小板用丝印（D4），否则 GPIO 号 */
export const pinName = (b: Board, p: number) => b.labels?.[p] ?? `GPIO${p}`;
export const pinFull = (b: Board, p: number) => (b.labels?.[p] ? `${b.labels[p]} (GPIO${p})` : `GPIO${p}`);
export const partName = (id: string) => PARTS[id]?.short ?? id;
export const boardShort = (b: Board) => b.name.replace(/^Seeed /, '').replace(/（.*）$/, '');

/** 引脚分配那一行是哪种接口（引擎的 PinAssign 只有 label，按零件需求的 label 前缀找回来） */
export function pinKind(label: string, parts: string[]): string {
  for (const id of parts) for (const n of PARTS[id]?.needs ?? []) if (labelIs(label, n.label)) return n.kind;
  return 'gpio';
}
/** planPins 的 label 是「需求名」或「需求名（接口说明）」；彩屏两条需求都以「屏幕」开头，所以不能只比前缀 */
export const labelIs = (label: string, need: string) => label === need || label.startsWith(need + '（');
const KIND_NAME: Record<string, string> = { gpio: 'GPIO', adc: 'ADC', pwm: 'PWM', i2c: 'I2C', spi: 'SPI', i2s: 'I2S', rmt: 'RMT', uart: 'UART', usb: '原生 USB', camera: '摄像头' };
export const kindName = (k: string) => KIND_NAME[k] ?? k;

/** 用了几个引脚（去重） */
export const usedPins = (p: Plan) => Array.from(new Set(p.pins.flatMap((a) => a.pins)));
export const exposedCount = (p: Plan) => p.board.exposed?.length ?? p.chip.gpio;

/** 每条结论有多可信：零件看有没有模型（没有模型 = 必须上真机），芯片看能不能仿真，引脚 / 续航是估算，充电、射频模拟器不管 */
export function trustRows(p: Plan, need: Need): [string, Confidence][] {
  const rows: [string, Confidence][] = need.parts.map((id) => {
    const lv = p.simCoverage.find((x) => x.part === PARTS[id].name)?.level ?? '必须上真机';
    return [PARTS[id].name, PART_MAP[id] === null ? '必须上真机' : lv];
  });
  rows.push([`芯片 ${p.chip.name} 本身`, simConf(p)]);
  rows.push(['引脚分配', '估算']);
  if (p.power) rows.push(['电池续航', p.power.confidence]);
  if (need.battery) rows.push(['锂电池充电、实际放电曲线', '必须上真机']);
  if (need.caps.some((c) => ['wifi', 'ble', 'bt_classic', 'thread', 'zigbee', 'wifi6'].includes(c))) rows.push(['天线、无线距离', '必须上真机']);
  if (need.battery) rows.push(['深睡后能再唤醒', '必须上真机']);
  return rows;
}

export function confCounts(rows: [string, Confidence][]) {
  const c: Partial<Record<Confidence, number>> = {};
  for (const [, k] of rows) c[k] = (c[k] ?? 0) + 1;
  return c;
}

// ---------------------------------------------------------------- 零件清单（必选 / 建议）
export interface PartRow {
  /** 行 id：零件 id、'board'、'always'、'cable' */
  key: string;
  name: string;
  /** 来源小字 */
  src: string;
  price: [number, number];
  /** 勾上 = 进清单；fixed = 不能取消（板子、线材） */
  on: boolean;
  fixed?: boolean;
  /** 「我已有」记的 id（板子用选板板子 id，线材用采购目录 id） */
  haveIds: string[];
  group: 'need' | 'suggest';
}

export function partRows(r: Result): PartRow[] {
  const { s, tpl, plan } = r;
  const a = answers(s);
  const rows: PartRow[] = [];
  if (plan) rows.push({ key: 'board', name: plan.board.name, src: '推荐板', price: plan.board.priceCNY, on: true, fixed: true, haveIds: [plan.board.id], group: 'need' });
  for (const id of tpl.parts) {
    if (id === 'battery') continue;
    const off = s.rm.includes(id);
    rows.push({ key: id, name: PARTS[id].name, src: off ? '从项目去掉了 · 勾上恢复' : '来自项目', price: PARTS[id].priceCNY, on: !off, haveIds: [id], group: 'need' });
  }
  rows.push({ key: 'always', name: '面包板和杜邦线', src: '总会用到', price: [8, 15], on: true, fixed: true, haveIds: [...ALWAYS], group: 'need' });
  rows.push({ key: 'cable', name: '能传数据的 Type-C 线', src: '烧录和供电', price: [5, 15], on: true, fixed: true, haveIds: ['usb-c-cable'], group: 'need' });
  if (a.bat || tpl.parts.includes('battery'))
    rows.push({ key: 'battery', name: PARTS.battery.name, src: a.bat ? '因为「用电池」' : '用电池时要', price: PARTS.battery.priceCNY, on: a.bat, haveIds: ['battery'], group: 'suggest' });
  for (const id of s.add) rows.push({ key: id, name: PARTS[id].name, src: '你加的', price: PARTS[id].priceCNY, on: true, haveIds: [id], group: 'suggest' });
  for (const id of tpl.suggest ?? [])
    if (!s.add.includes(id) && !tpl.parts.includes(id)) rows.push({ key: id, name: PARTS[id].name, src: `${tpl.short}常加`, price: PARTS[id].priceCNY, on: false, haveIds: [id], group: 'suggest' });
  return rows;
}

/** 还能加的零件（「+ 加零件」打开的零件表） */
export function addable(s: SelectState): string[] {
  const tpl = templateOf(s);
  return Object.keys(PARTS).filter((id) => id !== 'battery' && !tpl.parts.includes(id) && !s.add.includes(id));
}

// ---------------------------------------------------------------- 「刚才」：这一步改变了什么
export function changeText(label: string, before: Result, after: Result): string {
  const pb = before.plan;
  const pa = after.plan;
  if (!pa) return `${label} → 没有板子同时满足了`;
  const parts: string[] = [];
  if (!pb || pb.board.id !== pa.board.id) parts.push(`推荐换成 ${pa.board.name}`);
  else {
    parts.push('推荐没变');
    const ub = new Set(usedPins(pb));
    const ua = new Set(usedPins(pa));
    const more = [...ua].filter((x) => !ub.has(x));
    const less = [...ub].filter((x) => !ua.has(x));
    if (more.length) parts.push(`多占 ${more.length} 个引脚 ${more.map((x) => pinName(pa.board, x)).join('、')}`);
    if (less.length) parts.push(`空出 ${less.length} 个引脚 ${less.map((x) => pinName(pa.board, x)).join('、')}`);
  }
  if (pb) {
    const d0 = pa.total[0] - pb.total[0];
    const d1 = pa.total[1] - pb.total[1];
    if (d0 || d1) {
      const sign = d0 + d1 >= 0 ? '+' : '−';
      // 差价超过 1 块就取整：「+¥40.9–61.5」这种小数在变化提示里只是噪音
      const r1 = (v: number) => (v >= 1 ? Math.round(v) : Math.round(v * 10) / 10);
      const x = [r1(Math.abs(d0)), r1(Math.abs(d1))].sort((m, n) => m - n) as [number, number];
      parts.push(`参考价 ${sign}${yuan(x)}`);
    } else parts.push('参考价不变');
    // 加零件常常悄悄吃掉续航（静态电流），不说出来用户会以为只多花了几块钱
    const lb = pb.power?.days;
    const la = pa.power?.days;
    if (lb !== undefined && la !== undefined && lasts(lb) !== lasts(la)) parts.push(`续航 ${lasts(lb)} → ${lasts(la)}`);
  }
  return `${label} → ${parts.join('，')}`;
}

// ---------------------------------------------------------------- 0 块板：去掉哪个条件就有
export interface Relax {
  label: string;
  next: SelectState;
  n: number;
}
export function relaxOptions(r: Result): Relax[] {
  const { s, need } = r;
  const out: Relax[] = [];
  const tryOne = (label: string, next: SelectState) => {
    const n = resolve(next).plans.length;
    if (n > 0) out.push({ label, next, n });
  };
  for (const c of s.req) tryOne(`去掉「${capName(c as Cap)}」`, { ...s, req: s.req.filter((x) => x !== c) });
  if (answers(s).net) tryOne('不要连网', { ...s, net: false });
  for (const id of need.parts)
    if (PARTS[id].caps?.length) {
      const tpl = templateOf(s);
      tryOne(`去掉${PARTS[id].short}`, tpl.parts.includes(id) ? { ...s, rm: [...s.rm, id] } : { ...s, add: s.add.filter((x) => x !== id) });
    }
  out.sort((a, b) => b.n - a.n);
  if (s.budget) {
    const up = BUDGETS.find((b) => b > s.budget && resolve({ ...s, budget: b }).plans.length > 0);
    const b: Budget = up ?? 0;
    const n = resolve({ ...s, budget: b }).plans.length;
    if (n > 0) out.push({ label: b ? `预算放宽到 ¥${b}` : '预算不限', next: { ...s, budget: b }, n });
  }
  return out;
}

/** 选板零件里哪些会上实验台（有模型的），给任务书和检查点用 */
export const benchParts = (parts: string[]) => parts.filter((id) => PART_MAP[id]);
