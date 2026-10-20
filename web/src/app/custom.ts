// Advisor result -> custom work (work=custom, DESIGN_V2 §8.3, DECISIONS advisor v3 contract 1–3).
// Pins come from the advisor's planPins, so the shopping list, bench wiring and brief share one pin table.
import { t } from '../i18n/index.ts';
import { decode, encode, type SelectState } from '../advisor/state.ts';
import { BOARDS, CHIPS, PARTS as ADV_PARTS, TEMPLATES, type Board } from '../advisor/data.ts';
import { planPins, recommend, type Need } from '../advisor/engine.ts';
import { ALWAYS, PART_MAP, boardFor } from '../advisor/catalogmap.ts';
import { PART_BY_ID, getPart } from '../catalog/parts.ts';
import type { BuyLine, ProcureTemplate, Wire } from '../catalog/templates.ts';

/** Advisor parts without a catalog model: listed for purchase, not placed on the bench. */
export interface NoModel {
  id: string;
  name: string;
  price: [number, number];
}

export interface CustomPlan {
  state: SelectState;
  /** Work title (the advisor template title). */
  title: string;
  /** Advisor board (BOARDS id) and bench board (catalog id); sub explains the stand-in. */
  advisorBoard: string;
  boardId: string;
  /** Short bench board name used in the brief and checkpoints. */
  boardName: string;
  sub?: string;
  chip: 'esp32' | 'esp32c3' | 'esp32s3';
  template: ProcureTemplate;
  noModel: NoModel[];
  /** "I already have": catalog part ids. */
  have: string[];
  /** Battery + low power: adds a "wakes after deep sleep" check (real hardware only). */
  deepSleep: boolean;
  /** Local save key custom:<state hash>: a different advisor result is a new work. */
  wkey: string;
  /** Ready-to-run demo firmware, if any (C3 + BME280 / OLED -> c3-thermo). */
  demo: string | null;
}

function fnv(s: string) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Same need as advisor/App.tsx needOf, plus the URL's three answers and hard requirements. */
function needOf(s: SelectState, parts: string[]): Need {
  const tp = TEMPLATES.find((x) => x.id === s.t);
  let caps = (tp?.needCaps ?? []).filter((c) => c !== 'low_power');
  if (s.net === true && !caps.includes('wifi')) caps = [...caps, 'wifi'];
  if (s.net === false) caps = caps.filter((c) => c !== 'wifi');
  for (const r of s.req) if (r !== 'low_power' && !caps.includes(r as never)) caps = [...caps, r as never];
  return {
    caps,
    nice: [...(tp?.niceCaps ?? [])],
    parts: parts.filter((p) => p !== 'battery' && ADV_PARTS[p]),
    battery: parts.includes('battery'),
    duty: tp?.duty,
    budget: s.budget || undefined,
  };
}

/** Advisor parts: template − rm + add; the battery answer decides the battery outright. */
export function selectParts(s: SelectState): string[] {
  const tp = TEMPLATES.find((x) => x.id === s.t);
  let parts = (tp?.parts ?? []).filter((p) => !s.rm.includes(p));
  for (const a of s.add) if (!parts.includes(a)) parts.push(a);
  if (s.bat === true && !parts.includes('battery')) parts.push('battery');
  if (s.bat === false) parts = parts.filter((p) => p !== 'battery');
  return parts.filter((p) => ADV_PARTS[p]);
}

/** Bench board -> advisor board, so stand-in runs plan pins for the board actually on the bench. */
const BENCH_TO_ADVISOR: Record<string, string> = { 'xiao-c3': 'xiao-c3', 'c3-devkitm1': 'c3-devkitm', 's3-devkitc1-v11': 's3-devkitc-n16r8', 'xiao-s3': 'xiao-s3-sense' };

/** planPins part by part; the newly added rows belong to that part (I2C parts share one pin pair). */
function pinsByPart(b: Board, parts: string[]) {
  const c = CHIPS.find((x) => x.id === b.chip)!;
  const out: Record<string, number[][]> = {};
  let before = 0;
  for (let i = 0; i < parts.length; i++) {
    const { pins } = planPins(b, c, parts.slice(0, i + 1), false);
    out[parts[i]] = pins.slice(before).map((p) => p.pins);
    before = pins.length;
  }
  return out;
}

const G = (n: number | undefined) => (n === undefined ? null : `GPIO${n}`);

/** Wires for one catalog part; no pins (board ran out) = no wires, listed as not placed. */
function wiresFor(partId: string, pins: number[][]): Wire[] {
  const p = pins[0] ?? [];
  const w = (pin: string, net: string | null): Wire[] => (net ? [{ part: partId, pin, net }] : []);
  switch (partId) {
    case 'bme280':
    case 'ssd1306': {
      const [sda, scl] = [G(p[0]), G(p[1])];
      if (!sda || !scl) return [];
      return [...w('VCC', '3V3'), ...w('GND', 'GND'), ...w('SDA', sda), ...w('SCL', scl)];
    }
    case 'sg90':
      // Pin names must equal catalog/parts.ts pin ids.
      return G(p[0]) ? [...w('棕 GND', 'GND'), ...w('红 VCC', 'EXT5V'), ...w('橙 PWM', G(p[0]))] : []; // lint: allow-cjk
    case 'ws2812-strip':
      return G(p[0]) ? [...w('5V', 'EXT5V'), ...w('DIN', G(p[0])), ...w('GND', 'GND')] : [];
    case 'button':
      return G(p[0]) ? [...w('A', G(p[0])), ...w('B', 'GND')] : [];
    case 'pot':
      return G(p[0]) ? [...w('1', '3V3'), ...w('2', G(p[0])), ...w('3', 'GND')] : [];
    case 'dht11':
      return G(p[0]) ? [...w('VCC', '3V3'), ...w('DATA', G(p[0])), ...w('GND', 'GND')] : [];
    case 'led-kit':
      return G(p[0]) ? [...w('长脚 +', G(p[0])), ...w('短脚 -', 'GND')] : []; // lint: allow-cjk
    default:
      return [];
  }
}

export function customPlan(search: string): CustomPlan {
  const state = decode(search);
  const tpl = TEMPLATES.find((x) => x.id === state.t);
  const title = tpl?.title ? t(tpl.title) : t('My project');
  const parts = selectParts(state);
  const need = needOf(state, parts);
  let advisorBoard = state.board && BOARDS.some((b) => b.id === state.board) ? state.board : '';
  if (!advisorBoard) advisorBoard = recommend(need).plans[0]?.board.id ?? 'xiao-c3';
  const { boardId, sub } = boardFor(advisorBoard);
  const benchAdvisor = BOARDS.find((b) => b.id === BENCH_TO_ADVISOR[boardId]) ?? BOARDS.find((b) => b.id === 'xiao-c3')!;
  const chips = getPart(boardId).chips;
  const chip = chips.includes('esp32s3') ? 'esp32s3' : chips.includes('esp32') ? 'esp32' : 'esp32c3';

  // Only modelled parts get pins (relay, PIR etc. stay off the bench and take no pins).
  const modeled = parts.filter((p) => PART_MAP[p] && ADV_PARTS[p].needs.length);
  const pins = pinsByPart(benchAdvisor, modeled);

  const boardName = t(getPart(boardId).name).split(/[（(]/)[0].trim(); // lint: allow-cjk
  const required: BuyLine[] = [{ partId: boardId, qty: 1, why: sub ? t(sub) : t('Advisor pick: {board}', { board: boardName }) }];
  const suggested: (BuyLine & { checked: boolean })[] = [];
  const wiring: Wire[] = [];
  const noModel: NoModel[] = [];
  const seen = new Set<string>([boardId]);
  const addReq = (partId: string, qty: number, why: string) => {
    if (seen.has(partId) || !PART_BY_ID[partId]) return;
    seen.add(partId);
    required.push({ partId, qty, why });
    for (const r of getPart(partId).requires ?? []) addReq(r.partId, 1, t(r.why));
  };
  const addSug = (partId: string, why: string) => {
    if (seen.has(partId) || !PART_BY_ID[partId]) return;
    seen.add(partId);
    suggested.push({ partId, qty: 1, checked: true, why });
    for (const r of getPart(partId).requires ?? []) addSug(r.partId, t(r.why));
  };
  for (const id of parts) {
    const m = PART_MAP[id];
    const a = ADV_PARTS[id];
    if (m === null || m === undefined) {
      noModel.push({ id, name: t(a.name), price: a.priceCNY });
      continue;
    }
    const why = state.add.includes(id) ? t('You added it') : id === 'battery' && !tpl?.parts.includes('battery') ? t('Because of "Use a battery"') : tpl?.short ? t('Needed for {project}', { project: t(tpl.short) }) : t('Needed for the project');
    addReq(m.partId, m.qty ?? 1, why);
    for (const w of m.with ?? []) addReq(w, 1, t('Goes with {part}', { part: t(a.short) }));
    wiring.push(...wiresFor(m.partId, pins[id] ?? []));
  }
  // Externally powered actuators (servo, LED strip) reach the breadboard rail through a DC jack.
  if (wiring.some((w) => w.net === 'EXT5V')) {
    addReq('dc-jack', 1, t('Power plug to breadboard'));
    wiring.push({ part: 'dc-jack', pin: '+', net: 'EXT5V' }, { part: 'dc-jack', pin: '-', net: 'GND' });
  }
  addReq('usb-c-cable', 1, t('For flashing and serial; must be a data cable'));
  for (const id of ALWAYS) addSug(id, t('For building the circuit: breadboard and jumper wires'));

  // "Have": advisor ids map to catalog ids; catalog ids like breadboard/wires are accepted as-is.
  const have = state.have.flatMap((h) => (PART_MAP[h] ? [PART_MAP[h]!.partId, ...(PART_MAP[h]!.with ?? [])] : PART_BY_ID[h] ? [h] : []));
  const lowPower = !!tpl?.needCaps.includes('low_power') || state.req.includes('low_power');
  const deepSleep = parts.includes('battery') && lowPower;
  const template: ProcureTemplate = {
    id: 'custom',
    title,
    level: null,
    product: null,
    board: boardId,
    required,
    suggested,
    wiring,
    firmware: { wifi: need.caps.includes('wifi') },
  };
  const catIds = new Set([...required, ...suggested].map((l) => l.partId));
  // c3-thermo hardcodes I2C on GPIO6/7 (XIAO C3 D4/D5); other pin tables would get 0 ACKs, so no demo.
  const i2cOn67 = wiring.filter((w) => w.pin === 'SDA' || w.pin === 'SCL').every((w) => w.net === (w.pin === 'SDA' ? 'GPIO6' : 'GPIO7'));
  // c3-dht11 hardcodes DATA on GPIO5 (the advisor prefers it); I2C parts keep c3-thermo, which covers more checkpoints.
  const dhtOn5 = wiring.some((w) => w.part === 'dht11' && w.pin === 'DATA' && w.net === 'GPIO5');
  const i2cDemo = (catIds.has('bme280') || catIds.has('ssd1306')) && i2cOn67;
  const demo = chip !== 'esp32c3' ? null : i2cDemo ? 'c3-thermo' : catIds.has('dht11') && dhtOn5 && !catIds.has('bme280') && !catIds.has('ssd1306') ? 'c3-dht11' : null;
  return { state, title, advisorBoard, boardId, boardName, sub, chip, template, noModel, have, deepSleep, wkey: `custom:${fnv(encode(state))}`, demo };
}
