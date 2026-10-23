// Advisor v3: URL state (state.ts SelectState) to result. Page, brief and shop all derive here so one URL gives one answer.
// Pure functions, no DOM; .ts import suffixes let node --test run it directly.
import { BOARDS, PARTS, TEMPLATES, type Board, type Cap, type Template } from './data.ts';
import { capName, recommend, type Confidence, type Need, type Plan, type Rejected } from './engine.ts';
import { PART_MAP, ALWAYS, exampleOnly } from './catalogmap.ts';
import type { Budget, SelectState } from './state.ts';
import { t } from '../i18n/index.ts';
import { ADVISOR_RUN, capConf } from '../trust.ts';

/** Hard needs listed under "More needs" (Wi-Fi comes from the network question, low power from the battery one) */
export const MORE_CAPS: Cap[] = ['ble', 'bt_classic', 'thread', 'zigbee', 'wifi6', 'usb_otg', 'camera', 'audio_in', 'audio_out', 'psram', 'display_rgb', 'touch', 'dac', 'ethernet'];
export const BUDGETS: Budget[] = [0, 60, 120, 200];
/** Project card order: first 3 are big cards (all have full projects), the rest go under "More" */
export const TEMPLATE_ORDER = ['weather', 'lights', 'usbkey', 'blink', 'smarthome', 'rfid', 'irremote', 'mqtt', 'blephone', 'voice', 'camera', 'btaudio'];

const DEFAULT_T = 'weather';
const NET_CAPS: Cap[] = ['wifi', 'ble'];

export const templateOf = (s: Pick<SelectState, 't'>): Template => TEMPLATES.find((t) => t.id === s.t) ?? TEMPLATES.find((t) => t.id === DEFAULT_T)!;

/** URL ids may be stale or mistyped: keep known ones, default the template */
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

/** Template defaults for the three plain questions */
export function defaults(tpl: Template) {
  return {
    bat: tpl.needCaps.includes('low_power') || tpl.parts.includes('battery'),
    net: tpl.needCaps.some((c) => NET_CAPS.includes(c)),
    // Projects only an unsimulated chip can do (Classic Bluetooth) do not default to run-first
    sim: !tpl.needCaps.includes('bt_classic'),
  };
}

export function answers(s: SelectState) {
  const d = defaults(templateOf(s));
  return { bat: s.bat ?? d.bat, net: s.net ?? d.net, sim: s.sim ?? d.sim };
}

/** Selected parts (battery excluded: it follows the battery question) */
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
export const simConf = (p: Plan): Confidence => (p.chip.simulated === 'full' ? '仿真验证' : p.chip.simulated === 'partial' ? '行为模拟' : '必须上真机'); // lint: allow-cjk

export interface Result {
  s: SelectState;
  tpl: Template;
  need: Need;
  /** Boards meeting hard needs within budget (by score) */
  plans: Plan[];
  rejected: Rejected[];
  /** Board on show: the one picked in the comparison, else the top one */
  plan?: Plan;
  /** Three-board comparison: best fit / cheapest / lowest power (or next best) */
  trio: { p: Plan; tag: string }[];
}

export function resolve(s0: SelectState): Result {
  const s = sanitize(s0);
  const tpl = templateOf(s);
  const need = needOf(s);
  const r = recommend(need);
  // Budget is hard: boards whose lowest price exceeds it drop out (FrC: zero boards offers a looser budget)
  const plans = s.budget ? r.plans.filter((p) => p.total[0] <= s.budget) : r.plans;
  const rejected = [...r.rejected, ...r.plans.filter((p) => !plans.includes(p)).map((p) => ({ board: p.board, why: t('Whole kit from about ¥{price}, over the ¥{budget} budget', { price: p.total[0], budget: s.budget }) }))];
  const plan = plans.find((p) => p.board.id === s.board) ?? plans[0];
  return { s, tpl, need, plans, rejected, plan, trio: trioOf(plans, need) };
}

function trioOf(plans: Plan[], need: Need) {
  if (!plans.length) return [];
  const out: { p: Plan; tag: string }[] = [{ p: plans[0], tag: t('Best fit') }];
  const rest = () => plans.filter((p) => !out.some((o) => o.p === p));
  const cheap = [...rest()].sort((a, b) => a.total[0] - b.total[0])[0];
  if (cheap && cheap.total[0] < plans[0].total[0]) out.push({ p: cheap, tag: t('Cheapest') });
  if (need.battery) {
    const low = [...rest()].sort((a, b) => a.board.boardSleepUA - b.board.boardSleepUA)[0];
    if (low && low.board.boardSleepUA < plans[0].board.boardSleepUA) out.push({ p: low, tag: t('Lowest power') });
  }
  for (const p of rest()) {
    if (out.length >= 3) break;
    out.push({ p, tag: t('Alternative') });
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------- text helpers
export const yuan = (p: [number, number]) => (p[0] === p[1] ? `¥${fmtN(p[0])}` : `¥${fmtN(p[0])}–${fmtN(p[1])}`);
const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
/** Battery life without "about", for stat tiles */
export const lastsN = (days: number) => (days >= 365 ? t('{n} years', { n: (days / 365).toFixed(1) }) : t('{n} days', { n: days.toFixed(0) }));
export const lasts = (days: number) => t('about {span}', { span: lastsN(days) });
export const avgCurrent = (mA: number) => (mA < 1 ? (mA * 1000).toFixed(0) + ' µA' : mA.toFixed(2) + ' mA');
export const sleepCurrent = (uA: number) => (uA >= 1000 ? `${(uA / 1000).toFixed(uA % 1000 ? 1 : 0)} mA` : `${uA} µA`);
/** Pin name: silkscreen on small boards (D4), else the GPIO number */
export const pinName = (b: Board, p: number) => b.labels?.[p] ?? `GPIO${p}`;
export const pinFull = (b: Board, p: number) => (b.labels?.[p] ? `${b.labels[p]} (GPIO${p})` : `GPIO${p}`);
export const partName = (id: string) => (PARTS[id] ? t(PARTS[id].short) : id);
export const boardShort = (b: Board) => b.name.replace(/^Seeed /, '').replace(/ ?[（(].*[）)]$/, ''); // lint: allow-cjk

/** Interface kind of a pin row (PinAssign only has a label, so match it back to the part need label) */
export function pinKind(label: string, parts: string[]): string {
  for (const id of parts) for (const n of PARTS[id]?.needs ?? []) if (labelIs(label, n.label)) return n.kind;
  return 'gpio';
}
/** planPins labels are "need" or "need (bus)"; both display needs start with "Display", so a bare prefix is not enough */
export const labelIs = (label: string, need: string) => label === need || label.startsWith(need + ' (');
/** Display text of a planPins label: the need and its bus suffix are translated separately */
export function labelText(label: string): string {
  const i = label.indexOf(' (');
  if (i < 0 || !label.endsWith(')')) return t(label);
  return t('{label} ({bus})', { label: t(label.slice(0, i)), bus: t(label.slice(i + 2, -1)) });
}
const KIND_NAME: Record<string, string> = { gpio: 'GPIO', adc: 'ADC', pwm: 'PWM', i2c: 'I2C', spi: 'SPI', i2s: 'I2S', rmt: 'RMT', uart: 'UART', usb: 'Native USB', camera: 'Camera' };
export const kindName = (k: string) => KIND_NAME[k] ?? k;

/** Pins used (deduplicated) */
export const usedPins = (p: Plan) => Array.from(new Set(p.pins.flatMap((a) => a.pins)));
export const exposedCount = (p: Plan) => p.board.exposed?.length ?? p.chip.gpio;

/** Mic + speaker + Wi-Fi: a networked voice assistant (F-09b-2) */
export const isVoice = (caps: readonly string[]) => ['wifi', 'audio_in', 'audio_out'].every((c) => caps.includes(c));

/** Confidence per claim: parts by model (none = real board only), chip by simulation, pins / battery estimated, charging and RF real board only */
export function trustRows(p: Plan, need: Need): [string, Confidence][] {
  const rows: [string, Confidence][] = need.parts.map((id) => {
    const lv = p.simCoverage.find((x) => x.part === PARTS[id].name)?.level ?? '必须上真机'; // lint: allow-cjk
    const c: Confidence = PART_MAP[id] === null && !exampleOnly(id) ? '必须上真机' : exampleOnly(id) ? '行为模拟' : lv; // lint: allow-cjk
    // G-08: no simulated / behavioural claim without a web model; a CLI-only model says so in the label
    const on = ADVISOR_RUN[id]?.on ?? 'none';
    return [on === 'cli' ? t('{part} (the command line can simulate it)', { part: t(PARTS[id].name) }) : t(PARTS[id].name), capConf(c, on)];
  });
  if (need.parts.includes('relay')) rows.push([t('Relay contacts and the mains side'), '必须上真机']); // lint: allow-cjk
  rows.push([t('The {chip} chip itself', { chip: t(p.chip.name) }), simConf(p)]);
  rows.push([t('Pin assignment'), '估算']); // lint: allow-cjk
  if (p.chip.id === 'esp32') {
    // Classic-ESP32-only parts TryBoard does not model (C-05)
    if (need.caps.some((c) => c === 'bt_classic')) rows.push([t('Classic Bluetooth (ESP32)'), '必须上真机']); // lint: allow-cjk
    if (need.caps.some((c) => c === 'dac' || c === 'touch')) rows.push([t('DAC / capacitive touch / Hall sensor (ESP32)'), '必须上真机']); // lint: allow-cjk
  }
  if (p.power) rows.push([t('Battery life'), p.power.confidence]);
  if (need.battery) rows.push([t('Li-ion charging, real discharge curve'), '必须上真机']); // lint: allow-cjk
  if (need.caps.some((c) => ['wifi', 'ble', 'bt_classic', 'thread', 'zigbee', 'wifi6'].includes(c))) rows.push([t('Antenna, wireless range'), '必须上真机']); // lint: allow-cjk
  if (isVoice(need.caps)) {
    // F-09b-2: the xiaozhi-protocol link runs against a virtual server; on-device speech processing is not modelled
    rows.push([t('Voice link (device ↔ server protocol)'), '行为模拟']); // lint: allow-cjk
    rows.push([t('Wake word, echo cancellation (AEC)'), '必须上真机']); // lint: allow-cjk
  }
  if (need.battery) rows.push([t('Wakes again after deep sleep'), '必须上真机']); // lint: allow-cjk
  return rows;
}

export function confCounts(rows: [string, Confidence][]) {
  const c: Partial<Record<Confidence, number>> = {};
  for (const [, k] of rows) c[k] = (c[k] ?? 0) + 1;
  return c;
}

// ---------------------------------------------------------------- parts list (needed / suggested)
export interface PartRow {
  /** Row id: part id, 'board', 'always' or 'cable' */
  key: string;
  name: string;
  /** Small source note */
  src: string;
  price: [number, number];
  /** Ticked = in the list; fixed = cannot untick (board, cables) */
  on: boolean;
  fixed?: boolean;
  /** Ids stored for "I have it" (advisor board id for boards, shop catalog id for cables) */
  haveIds: string[];
  group: 'need' | 'suggest';
}

export function partRows(r: Result): PartRow[] {
  const { s, tpl, plan } = r;
  const a = answers(s);
  const rows: PartRow[] = [];
  if (plan) rows.push({ key: 'board', name: plan.board.name, src: t('Recommended board'), price: plan.board.priceCNY, on: true, fixed: true, haveIds: [plan.board.id], group: 'need' });
  for (const id of tpl.parts) {
    if (id === 'battery') continue;
    const off = s.rm.includes(id);
    rows.push({ key: id, name: t(PARTS[id].name), src: off ? t('Removed from the project · tick to restore') : t('From the project'), price: PARTS[id].priceCNY, on: !off, haveIds: [id], group: 'need' });
  }
  rows.push({ key: 'always', name: t('Breadboard and jumper wires'), src: t('Always needed'), price: [8, 15], on: true, fixed: true, haveIds: [...ALWAYS], group: 'need' });
  rows.push({ key: 'cable', name: t('Type-C cable that carries data'), src: t('Flashing and power'), price: [5, 15], on: true, fixed: true, haveIds: ['usb-c-cable'], group: 'need' });
  if (a.bat || tpl.parts.includes('battery'))
    rows.push({ key: 'battery', name: t(PARTS.battery.name), src: a.bat ? t('Because of "Battery powered"') : t('Needed on battery'), price: PARTS.battery.priceCNY, on: a.bat, haveIds: ['battery'], group: 'suggest' });
  for (const id of s.add) rows.push({ key: id, name: t(PARTS[id].name), src: t('Added by you'), price: PARTS[id].priceCNY, on: true, haveIds: [id], group: 'suggest' });
  for (const id of tpl.suggest ?? [])
    if (!s.add.includes(id) && !tpl.parts.includes(id)) rows.push({ key: id, name: t(PARTS[id].name), src: t('Common for {project}', { project: t(tpl.short) }), price: PARTS[id].priceCNY, on: false, haveIds: [id], group: 'suggest' });
  return rows;
}

/** Parts that can still be added (the "+ Add part" list) */
export function addable(s: SelectState): string[] {
  const tpl = templateOf(s);
  return Object.keys(PARTS).filter((id) => id !== 'battery' && !tpl.parts.includes(id) && !s.add.includes(id));
}

// ---------------------------------------------------------------- "Just now": what this step changed
export function changeText(label: string, before: Result, after: Result): string {
  const pb = before.plan;
  const pa = after.plan;
  if (!pa) return t('{label} → no board meets everything any more', { label });
  const parts: string[] = [];
  if (!pb || pb.board.id !== pa.board.id) parts.push(t('recommendation changes to {board}', { board: pa.board.name }));
  else {
    parts.push(t('recommendation unchanged'));
    const ub = new Set(usedPins(pb));
    const ua = new Set(usedPins(pa));
    const more = [...ua].filter((x) => !ub.has(x));
    const less = [...ub].filter((x) => !ua.has(x));
    const list = (xs: number[]) => xs.map((x) => pinName(pa.board, x)).join(t(', '));
    if (more.length) parts.push(more.length === 1 ? t('uses 1 more pin {pins}', { pins: list(more) }) : t('uses {n} more pins {pins}', { n: more.length, pins: list(more) }));
    if (less.length) parts.push(less.length === 1 ? t('frees 1 pin {pins}', { pins: list(less) }) : t('frees {n} pins {pins}', { n: less.length, pins: list(less) }));
  }
  if (pb) {
    const d0 = pa.total[0] - pb.total[0];
    const d1 = pa.total[1] - pb.total[1];
    if (d0 || d1) {
      const sign = d0 + d1 >= 0 ? '+' : '−';
      // Round differences over ¥1: decimals like "+¥40.9–61.5" are noise in a change note
      const r1 = (v: number) => (v >= 1 ? Math.round(v) : Math.round(v * 10) / 10);
      const x = [r1(Math.abs(d0)), r1(Math.abs(d1))].sort((m, n) => m - n) as [number, number];
      parts.push(t('reference price {delta}', { delta: sign + yuan(x) }));
    } else parts.push(t('reference price unchanged'));
    // Added parts often quietly cut battery life (quiescent current); say so, or it looks like only a few yuan
    const lb = pb.power?.days;
    const la = pa.power?.days;
    if (lb !== undefined && la !== undefined && lasts(lb) !== lasts(la)) parts.push(t('battery life {from} → {to}', { from: lasts(lb), to: lasts(la) }));
  }
  return t('{label} → {changes}', { label, changes: parts.join(t('; ')) });
}

// ---------------------------------------------------------------- zero boards: which condition to drop
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
  for (const c of s.req) tryOne(t('Drop "{cap}"', { cap: capName(c as Cap) }), { ...s, req: s.req.filter((x) => x !== c) });
  if (answers(s).net) tryOne(t('No network'), { ...s, net: false });
  for (const id of need.parts)
    if (PARTS[id].caps?.length) {
      const tpl = templateOf(s);
      tryOne(t('Drop {part}', { part: t(PARTS[id].short) }), tpl.parts.includes(id) ? { ...s, rm: [...s.rm, id] } : { ...s, add: s.add.filter((x) => x !== id) });
    }
  out.sort((a, b) => b.n - a.n);
  if (s.budget) {
    const up = BUDGETS.find((b) => b > s.budget && resolve({ ...s, budget: b }).plans.length > 0);
    const b: Budget = up ?? 0;
    const n = resolve({ ...s, budget: b }).plans.length;
    if (n > 0) out.push({ label: b ? t('Raise the budget to ¥{budget}', { budget: b }) : t('No budget limit'), next: { ...s, budget: b }, n });
  }
  return out;
}

/** Advisor parts that go on the bench (those with a model), for the brief and checkpoints */
export const benchParts = (parts: string[]) => parts.filter((id) => PART_MAP[id]);
