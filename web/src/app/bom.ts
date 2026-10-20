// Shopping-list state is only an op log (template / add / remove / board swap / fix); the list is its replay.
// Seeking the timeline replays up to that step, no snapshots (DESIGN §3). Pure, tested with node --test.
import { t } from '../i18n/index.ts';
import { getTemplate, removePick, templatePicks, toScene, type Pick } from '../catalog/templates.ts';
import { applyFix } from '../catalog/fix.ts';
import type { Fix, RuleInput } from '../catalog/rules.ts';
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
  /** Where non-template parts came from ("added by rule R27" / "added from the parts library"). */
  extra: Record<string, string>;
}

export interface BomHistory {
  ops: BomOp[];
  /** Current step (< ops.length - 1 after seeking back on the timeline). */
  cur: number;
}

export const initialHistory = (template: string): BomHistory => ({ ops: [{ t: 'template', id: template }], cur: 0 });

function fromTemplate(id: string): Bom {
  const tpl = getTemplate(id);
  const picks = templatePicks(id);
  // The board is always listed (a suggestion in the blank template; its row can't be unticked in Shop).
  if (!picks.some((p) => p.partId === tpl.board)) picks.unshift({ partId: tpl.board, qty: 1 });
  return { template: id, board: tpl.board, picks, extra: {} };
}

const lineQty = (template: string, partId: string) => {
  const tpl = getTemplate(template);
  return [...tpl.required, ...tpl.suggested].find((l) => l.partId === partId)?.qty ?? 1;
};

function step(b: Bom, op: BomOp): Bom {
  switch (op.t) {
    case 'template':
      return fromTemplate(op.id);
    case 'add':
      if (b.picks.some((p) => p.partId === op.partId)) return b;
      return { ...b, picks: [...b.picks, { partId: op.partId, qty: lineQty(b.template, op.partId) }], extra: inTemplate(b.template, op.partId) ? b.extra : { ...b.extra, [op.partId]: t('Added from the parts library') } };
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
      if (op.fix.action !== 'remove' && !inTemplate(b.template, op.fix.partId)) extra[op.fix.partId] = t('Added after a rule check hint');
      return { ...b, board: n.board, picks: n.parts, extra };
    }
  }
}

export function inTemplate(template: string, partId: string) {
  const tpl = getTemplate(template);
  return [...tpl.required, ...tpl.suggested].some((l) => l.partId === partId);
}

/** Replay up to step `upto` (inclusive). A log naming parts dropped from the catalog is discarded (template defaults). */
export function replay(h: BomHistory, upto = h.cur): Bom {
  const first = h.ops[0];
  let b = fromTemplate(first?.t === 'template' ? first.id : 'blank');
  for (let i = 1; i <= Math.min(upto, h.ops.length - 1); i++) b = step(b, h.ops[i]);
  return b;
}

/** Append a step, dropping the branch after cur (like undo/redo). Ops that don't change the list aren't recorded. */
export function push(h: BomHistory, op: BomOp): BomHistory {
  const before = replay(h);
  const after = step(before, op);
  if (op.t !== 'template' && JSON.stringify(after) === JSON.stringify(before)) return h;
  const ops = [...h.ops.slice(0, h.cur + 1), op];
  return { ops, cur: ops.length - 1 };
}

/** Whether a log can be replayed (old logs in localStorage may name renamed parts). */
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

/** Rule-engine input: the list plus the template's default wiring and firmware usage. */
export function ruleInput(b: Bom): RuleInput {
  const tpl = getTemplate(b.template);
  return { template: b.template, board: b.board, parts: b.picks.map((p) => ({ ...p })), wiring: tpl.wiring.map((w) => ({ ...w })), firmware: { ...tpl.firmware } };
}

const short = (partId: string) => t(getPart(partId).name).split(/[（(]/)[0].trim(); // lint: allow-cjk (full-width paren in names)
export { short as shortName };

export function opLabel(op: BomOp): { icon: string; label: string } {
  switch (op.t) {
    case 'template':
      return { icon: '▤', label: t('Apply "{name}"', { name: t(getTemplate(op.id).title) }) };
    case 'add':
      return { icon: '+', label: t('Add {part}', { part: short(op.partId) }) };
    case 'remove':
      return { icon: '−', label: t('Remove {part}', { part: short(op.partId) }) };
    case 'board':
      return { icon: '⇄', label: t('Swap to {part}', { part: short(op.partId) }) };
    case 'fix':
      return { icon: '✓', label: t(op.fix.action === 'add' ? 'Add {part}' : op.fix.action === 'remove' ? 'Remove {part}' : 'Swap to {part}', { part: short(op.fix.partId) }) };
  }
}

export interface Placement {
  /** Same format as scene.parts in firmware/examples.json. */
  parts: { type: string; [k: string]: unknown }[];
  /** The list has an external 5 V supply (servo not on USB power). */
  ext5v: boolean;
  /** Listed parts the simulator models but that weren't placed for lack of default wiring. */
  skipped: string[];
}

/** After buying, place on the bench (P0-09): scene from template wiring; parts without wiring are listed, not placed. */
export function placement(b: Bom): Placement {
  const tpl = getTemplate(b.template);
  const raw = toScene(b.picks, tpl.wiring);
  const parts = raw.filter((p) => Object.entries(p).every(([, v]) => v !== undefined));
  const placedTypes = new Set(parts.map((p) => p.type));
  const SIM = new Set(['oled', 'bme280', 'servo', 'gc9a01', 'led', 'buzzer', 'mpu6050', 'qmi8658', 'cst816s', 'encoder', 'hcsr04', 'ws2812', 'dht11', 'ds18b20', 'pir', 'relay', 'ldr', 'rc522']);
  const skipped = raw.filter((p) => !parts.includes(p)).map((p) => p.type);
  // toScene drops unwired LEDs / buzzers silently; count them as skipped too.
  for (const p of b.picks) {
    const ty = ({ 'led-kit': 'led', 'buzzer-module': 'buzzer', 'buzzer-passive': 'buzzer' } as Record<string, string>)[p.partId];
    if (ty && SIM.has(ty) && !placedTypes.has(ty) && !skipped.includes(ty)) skipped.push(ty);
  }
  const ext5v = b.picks.some((p) => PART_BY_ID[p.partId]?.provides?.net === 'EXT5V');
  return { parts, ext5v, skipped };
}
