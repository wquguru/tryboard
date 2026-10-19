// 选板结果 → 自定义作品（work=custom，DESIGN_V2 §8.3、DECISIONS「选板 v3」接口约定 1–3）。
// 地址参数（advisor/state.ts）→ 采购模板（必选 / 建议 / 我已有）+ 按选板引脚表生成的接线；纯函数，页面和测试共用。
// 引脚不在这里另算：用选板的 planPins，所以采购清单、实验台摆线、任务书里的引脚是同一张表。
import { decode, encode, type SelectState } from '../advisor/state.ts';
import { BOARDS, CHIPS, PARTS as ADV_PARTS, TEMPLATES, type Board } from '../advisor/data.ts';
import { planPins, recommend, type Need } from '../advisor/engine.ts';
import { ALWAYS, PART_MAP, boardFor } from '../advisor/catalogmap.ts';
import { PART_BY_ID, getPart } from '../catalog/parts.ts';
import type { BuyLine, ProcureTemplate, Wire } from '../catalog/templates.ts';

/** 选板里有、目录里没有模型的零件：只进清单，不上台 */
export interface NoModel {
  id: string;
  name: string;
  price: [number, number];
}

export interface CustomPlan {
  state: SelectState;
  /** 作品名（选板模板的标题） */
  title: string;
  /** 选板板子（advisor BOARDS id）与实验台板子（目录 id）；sub = 代替运行的说明 */
  advisorBoard: string;
  boardId: string;
  /** 实验台板子的短名（任务书、检查点里写） */
  boardName: string;
  sub?: string;
  chip: 'esp32' | 'esp32c3' | 'esp32s3';
  template: ProcureTemplate;
  noModel: NoModel[];
  /** 「我已有」：目录零件 id */
  have: string[];
  /** 电池供电又要深睡：生成「深睡后能再唤醒」（必须上真机） */
  deepSleep: boolean;
  /** 本机存档键：custom:<地址参数哈希>（换了选板结果就是新作品，旧摆台不复用） */
  wkey: string;
  /** 有没有能直接跑的演示固件（C3 + BME280 / OLED → c3-thermo） */
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

/** 选板页同一口径的需求（advisor/App.tsx needOf），再叠上地址里的三问和硬需求 */
function needOf(s: SelectState, parts: string[]): Need {
  const t = TEMPLATES.find((x) => x.id === s.t);
  let caps = (t?.needCaps ?? []).filter((c) => c !== 'low_power');
  if (s.net === true && !caps.includes('wifi')) caps = [...caps, 'wifi'];
  if (s.net === false) caps = caps.filter((c) => c !== 'wifi');
  for (const r of s.req) if (r !== 'low_power' && !caps.includes(r as never)) caps = [...caps, r as never];
  return {
    caps,
    nice: [...(t?.niceCaps ?? [])],
    parts: parts.filter((p) => p !== 'battery' && ADV_PARTS[p]),
    battery: parts.includes('battery'),
    duty: t?.duty,
    budget: s.budget || undefined,
  };
}

/** 选板零件：模板的 − rm + add；「用电池」问题直接决定有没有电池 */
export function selectParts(s: SelectState): string[] {
  const t = TEMPLATES.find((x) => x.id === s.t);
  let parts = (t?.parts ?? []).filter((p) => !s.rm.includes(p));
  for (const a of s.add) if (!parts.includes(a)) parts.push(a);
  if (s.bat === true && !parts.includes('battery')) parts.push('battery');
  if (s.bat === false) parts = parts.filter((p) => p !== 'battery');
  return parts.filter((p) => ADV_PARTS[p]);
}

/** 实验台板子 → 选板板子（代替运行时引脚按实验台上那块排） */
const BENCH_TO_ADVISOR: Record<string, string> = { 'xiao-c3': 'xiao-c3', 'c3-devkitm1': 'c3-devkitm', 's3-devkitc1-v11': 's3-devkitc-n16r8', 'xiao-s3': 'xiao-s3-sense' };

/** 按零件逐个 planPins，新多出来的那几条就是这个零件的（I2C 器件共用一条总线，各自拿到同一对引脚） */
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

/** 一个目录零件按分到的引脚接线；没分到引脚（板子引脚不够）就不接，摆台时会列进"没摆上" */
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
      return G(p[0]) ? [...w('棕 GND', 'GND'), ...w('红 VCC', 'EXT5V'), ...w('橙 PWM', G(p[0]))] : [];
    case 'ws2812-strip':
      return G(p[0]) ? [...w('5V', 'EXT5V'), ...w('DIN', G(p[0])), ...w('GND', 'GND')] : [];
    case 'button':
      return G(p[0]) ? [...w('A', G(p[0])), ...w('B', 'GND')] : [];
    case 'pot':
      return G(p[0]) ? [...w('1', '3V3'), ...w('2', G(p[0])), ...w('3', 'GND')] : [];
    case 'led-kit':
      return G(p[0]) ? [...w('长脚 +', G(p[0])), ...w('短脚 -', 'GND')] : [];
    default:
      return [];
  }
}

export function customPlan(search: string): CustomPlan {
  const state = decode(search);
  const tpl = TEMPLATES.find((x) => x.id === state.t);
  const title = tpl?.title ?? '我的项目';
  const parts = selectParts(state);
  const need = needOf(state, parts);
  let advisorBoard = state.board && BOARDS.some((b) => b.id === state.board) ? state.board : '';
  if (!advisorBoard) advisorBoard = recommend(need).plans[0]?.board.id ?? 'xiao-c3';
  const { boardId, sub } = boardFor(advisorBoard);
  const benchAdvisor = BOARDS.find((b) => b.id === BENCH_TO_ADVISOR[boardId]) ?? BOARDS.find((b) => b.id === 'xiao-c3')!;
  const chips = getPart(boardId).chips;
  const chip = chips.includes('esp32s3') ? 'esp32s3' : chips.includes('esp32') ? 'esp32' : 'esp32c3';

  // 有模型的才分引脚（无模型的继电器、人体红外不上台，也不占台上的引脚）
  const modeled = parts.filter((p) => PART_MAP[p] && ADV_PARTS[p].needs.length);
  const pins = pinsByPart(benchAdvisor, modeled);

  const boardName = getPart(boardId).name.split(/[（(]/)[0].trim();
  const required: BuyLine[] = [{ partId: boardId, qty: 1, why: sub ?? `选板推荐：${boardName}` }];
  const suggested: (BuyLine & { checked: boolean })[] = [];
  const wiring: Wire[] = [];
  const noModel: NoModel[] = [];
  const seen = new Set<string>([boardId]);
  const addReq = (partId: string, qty: number, why: string) => {
    if (seen.has(partId) || !PART_BY_ID[partId]) return;
    seen.add(partId);
    required.push({ partId, qty, why });
    for (const r of getPart(partId).requires ?? []) addReq(r.partId, 1, r.why);
  };
  const addSug = (partId: string, why: string) => {
    if (seen.has(partId) || !PART_BY_ID[partId]) return;
    seen.add(partId);
    suggested.push({ partId, qty: 1, checked: true, why });
    for (const r of getPart(partId).requires ?? []) addSug(r.partId, r.why);
  };
  for (const id of parts) {
    const m = PART_MAP[id];
    const a = ADV_PARTS[id];
    if (m === null || m === undefined) {
      noModel.push({ id, name: a.name, price: a.priceCNY });
      continue;
    }
    const why = state.add.includes(id) ? '你加的' : id === 'battery' && !tpl?.parts.includes('battery') ? '因为「用电池」' : `${tpl?.short ?? '项目'}要用`;
    addReq(m.partId, m.qty ?? 1, why);
    for (const w of m.with ?? []) addReq(w, 1, `配 ${a.short} 一起用`);
    wiring.push(...wiresFor(m.partId, pins[id] ?? []));
  }
  // 外接 5 V 的执行器（舵机、灯带）经 DC 母座接到面包板电源轨
  if (wiring.some((w) => w.net === 'EXT5V')) {
    addReq('dc-jack', 1, '电源插头转面包板');
    wiring.push({ part: 'dc-jack', pin: '+', net: 'EXT5V' }, { part: 'dc-jack', pin: '-', net: 'GND' });
  }
  addReq('usb-c-cable', 1, '烧录和看串口，要能传数据的线');
  for (const id of ALWAYS) addSug(id, '搭电路：面包板和杜邦线');

  // 我已有：选板零件 id 按对照表换成目录 id；面包板、线这种目录 id 原样认
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
  // c3-thermo 把 I2C 写死在 GPIO6 / 7（XIAO C3 的 D4 / D5）：引脚表不同就不给演示（跑了也只会应答 0 次）
  const i2cOn67 = wiring.filter((w) => w.pin === 'SDA' || w.pin === 'SCL').every((w) => w.net === (w.pin === 'SDA' ? 'GPIO6' : 'GPIO7'));
  const demo = chip === 'esp32c3' && (catIds.has('bme280') || catIds.has('ssd1306')) && i2cOn67 ? 'c3-thermo' : null;
  return { state, title, advisorBoard, boardId, boardName, sub, chip, template, noModel, have, deepSleep, wkey: `custom:${fnv(encode(state))}`, demo };
}
