// 采购清单的状态：只存操作日志（套用模版 / 加 / 去 / 换板 / 一键修），清单由日志重放得到。
// 时间线点回某一步 = 重放到那一步，不存快照（DESIGN §3）。纯函数，node --test 直接测。
import { getTemplate, removePick, templatePicks, toScene, type Pick } from '../catalog/templates.ts';
import { applyFix, type Fix, type RuleInput } from '../catalog/rules.ts';
import { PART_BY_ID, getPart } from '../catalog/parts.ts';

export type BomOp =
  | { t: 'template'; id: string }
  | { t: 'add'; partId: string }
  | { t: 'remove'; partId: string }
  | { t: 'board'; partId: string }
  | { t: 'fix'; fix: Fix; rule: string };

export interface Bom {
  template: string;
  board: string;
  picks: Pick[];
  /** 不在模版里的件是怎么来的（"规则 R27 补的" / "从元件库加的"） */
  extra: Record<string, string>;
}

export interface BomHistory {
  ops: BomOp[];
  /** 当前停在第几步（时间线点回去后 < ops.length - 1） */
  cur: number;
}

export const initialHistory = (template: string): BomHistory => ({ ops: [{ t: 'template', id: template }], cur: 0 });

function fromTemplate(id: string): Bom {
  const t = getTemplate(id);
  const picks = templatePicks(id);
  // 开发板总在清单里（空白模版的板子是建议件，这里也补上；采购页上开发板一行不能取消）
  if (!picks.some((p) => p.partId === t.board)) picks.unshift({ partId: t.board, qty: 1 });
  return { template: id, board: t.board, picks, extra: {} };
}

const lineQty = (template: string, partId: string) => {
  const t = getTemplate(template);
  return [...t.required, ...t.suggested].find((l) => l.partId === partId)?.qty ?? 1;
};

function step(b: Bom, op: BomOp): Bom {
  switch (op.t) {
    case 'template':
      return fromTemplate(op.id);
    case 'add':
      if (b.picks.some((p) => p.partId === op.partId)) return b;
      return { ...b, picks: [...b.picks, { partId: op.partId, qty: lineQty(b.template, op.partId) }], extra: inTemplate(b.template, op.partId) ? b.extra : { ...b.extra, [op.partId]: '从元件库加的' } };
    case 'remove': {
      const r = removePick(b.template, b.picks, op.partId);
      if (r.refused || op.partId === b.board) return b;
      const extra = { ...b.extra };
      delete extra[op.partId];
      return { ...b, picks: r.picks, extra };
    }
    case 'board': {
      if (op.partId === b.board) return b;
      const n = applyFix(ruleInput(b), { action: 'swap', partId: op.partId, replaces: b.board });
      return { ...b, board: n.board, picks: n.parts };
    }
    case 'fix': {
      const n = applyFix(ruleInput(b), op.fix);
      const extra = { ...b.extra };
      if (op.fix.action !== 'remove' && !inTemplate(b.template, op.fix.partId)) extra[op.fix.partId] = `规则 ${op.rule} 补的`;
      return { ...b, board: n.board, picks: n.parts, extra };
    }
  }
}

export function inTemplate(template: string, partId: string) {
  const t = getTemplate(template);
  return [...t.required, ...t.suggested].some((l) => l.partId === partId);
}

/** 重放到第 upto 步（含）。日志里有元件库已删掉的件时整份作废，回到模版默认 */
export function replay(h: BomHistory, upto = h.cur): Bom {
  const first = h.ops[0];
  let b = fromTemplate(first?.t === 'template' ? first.id : 'blank');
  for (let i = 1; i <= Math.min(upto, h.ops.length - 1); i++) b = step(b, h.ops[i]);
  return b;
}

/** 追加一步：停在中间时丢掉后面的分支（和撤销 / 重做一样）。不改变清单的操作不记 */
export function push(h: BomHistory, op: BomOp): BomHistory {
  const before = replay(h);
  const after = step(before, op);
  if (op.t !== 'template' && JSON.stringify(after) === JSON.stringify(before)) return h;
  const ops = [...h.ops.slice(0, h.cur + 1), op];
  return { ops, cur: ops.length - 1 };
}

/** 日志能不能重放（存在 localStorage 里的旧日志可能引用改名的件） */
export function validHistory(x: unknown): x is BomHistory {
  if (!x || typeof x !== 'object') return false;
  const h = x as BomHistory;
  if (!Array.isArray(h.ops) || !h.ops.length || typeof h.cur !== 'number' || h.cur < 0 || h.cur >= h.ops.length) return false;
  const ids = (op: BomOp) => (op.t === 'template' ? [] : op.t === 'fix' ? [op.fix.partId, ...(op.fix.replaces ? [op.fix.replaces] : [])] : [op.partId]);
  try {
    if (h.ops[0].t !== 'template') return false;
    getTemplate(h.ops[0].id);
    for (const op of h.ops) {
      if (op.t === 'template') getTemplate(op.id);
      for (const id of ids(op)) if (!PART_BY_ID[id]) return false;
    }
    replay(h, h.ops.length - 1);
    return true;
  } catch {
    return false;
  }
}

/** 规则引擎的输入：清单 + 模版的默认接线和固件用法 */
export function ruleInput(b: Bom): RuleInput {
  const t = getTemplate(b.template);
  return { template: b.template, board: b.board, parts: b.picks.map((p) => ({ ...p })), wiring: t.wiring.map((w) => ({ ...w })), firmware: { ...t.firmware } };
}

const short = (partId: string) => getPart(partId).name.split(/[（(]/)[0].trim();
export { short as shortName };

export function opLabel(op: BomOp): { icon: string; label: string } {
  switch (op.t) {
    case 'template':
      return { icon: '▤', label: `套用「${getTemplate(op.id).title}」` };
    case 'add':
      return { icon: '+', label: `加 ${short(op.partId)}` };
    case 'remove':
      return { icon: '−', label: `去 ${short(op.partId)}` };
    case 'board':
      return { icon: '⇄', label: `换 ${short(op.partId)}` };
    case 'fix':
      return { icon: '✓', label: `${op.fix.action === 'add' ? '补' : op.fix.action === 'remove' ? '去' : '换'} ${short(op.fix.partId)}（${op.rule}）` };
  }
}

export interface Placement {
  /** 与 firmware/examples.json 的 scene.parts 同格式 */
  parts: { type: string; [k: string]: unknown }[];
  /** 清单里有外接 5 V 电源（舵机不靠 USB） */
  ext5v: boolean;
  /** 在清单里、模拟器有模型、但没有默认接线所以没摆上的件 */
  skipped: string[];
}

/** 买完摆上实验台（P0-09）：按模版接线生成场景；缺接线的件不摆，列出来 */
export function placement(b: Bom): Placement {
  const t = getTemplate(b.template);
  const raw = toScene(b.picks, t.wiring);
  const parts = raw.filter((p) => Object.entries(p).every(([, v]) => v !== undefined));
  const placedTypes = new Set(parts.map((p) => p.type));
  const SIM = new Set(['oled', 'bme280', 'servo', 'gc9a01', 'led', 'buzzer']);
  const skipped = raw.filter((p) => !parts.includes(p)).map((p) => p.type);
  // toScene 对没接线的 LED / 蜂鸣器直接不输出，这里也算进"没摆上"
  for (const p of b.picks) {
    const ty = ({ 'led-kit': 'led', 'buzzer-module': 'buzzer', 'buzzer-passive': 'buzzer' } as Record<string, string>)[p.partId];
    if (ty && SIM.has(ty) && !placedTypes.has(ty) && !skipped.includes(ty)) skipped.push(ty);
  }
  const ext5v = b.picks.some((p) => PART_BY_ID[p.partId]?.provides?.net === 'EXT5V');
  return { parts, ext5v, skipped };
}
