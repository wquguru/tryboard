// One-click rule fixes, apart from the rule engine so the BOM replay on the bench does not pull every rule in (R-12).
import { getPart } from './parts.ts';
import type { Fix, RuleInput } from './rules.ts';

/** One-click fix: returns a new input (the original is not changed) */
export function applyFix(input: RuleInput, fix: Fix): RuleInput {
  const parts = input.parts.map((p) => ({ ...p }));
  const next: RuleInput = { ...input, parts };
  if (fix.action === 'add') {
    if (!parts.some((p) => p.partId === fix.partId)) parts.push({ partId: fix.partId, qty: 1 });
  } else if (fix.action === 'remove') {
    next.parts = parts.filter((p) => p.partId !== fix.partId && p.key !== fix.partId);
  } else {
    const old = fix.replaces;
    if (getPart(fix.partId).kind === 'board') {
      next.parts = parts.map((p) => (p.partId === (old ?? input.board) ? { ...p, partId: fix.partId } : p));
      next.board = fix.partId;
    } else if (old) {
      next.parts = parts.map((p) => (p.partId === old ? { ...p, partId: fix.partId } : p));
    } else parts.push({ partId: fix.partId, qty: 1 });
  }
  return next;
}
