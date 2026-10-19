// Step 1 Shop (P0-07) + put the bought parts on the bench (P0-09).
// Timeline = BOM ops, so seeking back replays the list instead of storing snapshots.
import type { SceneSpec } from '../../board3d';
import { BOARDS, CHECKED_AT, PARTS, PART_BY_ID, getPart, type Kind, type Part } from '../../catalog/parts';
import { PROCURE_TEMPLATES, bomTotal, getTemplate } from '../../catalog/templates';
import { evaluate, type Finding } from '../../catalog/rules';
import { wkey } from '../works';
import { actions } from '../chrome';
import { initialHistory, opLabel, placement, push, replay, ruleInput, shortName, validHistory, type Bom, type BomHistory, type BomOp } from '../bom';
import type { StepCtx, StepImpl, WorkId } from '../types';
import { partLabel } from '../wiring';
import { PARAM_RANGE, type CaseParams } from '../enclosure';
import { download, exportCase, layoutFor, loadCaseParams, saveCaseParams } from '../casemesh';
import { Fragment, type ReactNode } from 'react';
import { cn } from '../../ui/cn';
import { NInput, NSelect } from '../../ui/native';
import { Btn, Btns, Field, Kv, KvT, LinkBtn, Mono, Muted, Note, Ph, Res, Sec, TnL, TnM, TreeEmpty, TreeGroup, VerdictLine, tnClass } from '../../ui/panel';
import { noteSaved } from '../saved';
import { lab } from '../../ui/links';
import { Conf, ConfIcon, confOfRule, type ConfLevel } from '../../ui/conf';
import { genLevels } from '../genlevels';
import { t } from '../../i18n';

const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
const yuan = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const range = (lo: number, hi: number) => `¥${yuan(lo)}–${yuan(hi)}`;

// ------------------------------------------------------------ local storage (per work)
const BOM_KEY = (w: string) => `tryboard-app-shop:${w}`;
const PLACED_KEY = (w: string) => `tryboard-app-placed:${w}`;

export function loadBom(work: string): BomHistory {
  try {
    const h = JSON.parse(localStorage.getItem(BOM_KEY(work)) ?? 'null');
    if (validHistory(h)) return h;
  } catch {
    /* corrupt data: fall back to the template default */
  }
  // Board-picker works (custom:<hash>) get their template registered as 'custom' by main.tsx from URL params
  return initialHistory(work.startsWith('custom:') ? 'custom' : PROCURE_TEMPLATES.some((x) => x.id === work) ? work : 'blank');
}
export function saveBom(work: string, h: BomHistory) {
  try {
    localStorage.setItem(BOM_KEY(work), JSON.stringify(h));
    noteSaved();
  } catch {
    /* private mode can't store: the list lives only on this page */
  }
}
export function loadPlaced(work: string): { scene: SceneSpec; ext5v: boolean } | null {
  try {
    const p = JSON.parse(localStorage.getItem(PLACED_KEY(work)) ?? 'null');
    if (p && Array.isArray(p.scene?.parts) && typeof p.ext5v === 'boolean') return p;
  } catch {
    /* same as above */
  }
  return null;
}
function savePlaced(work: string, scene: SceneSpec, ext5v: boolean) {
  try {
    localStorage.setItem(PLACED_KEY(work), JSON.stringify({ scene, ext5v }));
    noteSaved();
  } catch {
    /* same as above */
  }
}

// ------------------------------------------------------------ copy
const KIND: Record<Kind, string> = {
  board: t('Dev board'),
  sensor: t('Sensor'),
  display: t('Screen'),
  actuator: t('Actuator'),
  input: t('Input'),
  audio: t('Audio'),
  power: t('Power'),
  cable: t('Cables'),
  passive: t('Passives'),
  module: t('Module'),
  proto: t('Breadboard and prototyping'),
  enclosure: t('Enclosure'),
};
const SIM: Record<Part['sim']['level'], string> = {
  verified: t('An acceptance firmware has run this model'),
  estimated: t('The model is approximate; readings may be off'),
  none: t('Not in the simulator; counted only in the list and rules'),
};
/** Part sim level -> one of the four confidence levels (U-14: shown by icon, not color) */
const SIM_CONF: Record<Part['sim']['level'], ConfLevel> = { verified: '仿真验证', estimated: '行为模拟', none: '必须上真机' }; // lint: allow-cjk
const REAL_HW: ConfLevel = '必须上真机'; // lint: allow-cjk
const TPL_SHORT: Record<string, string> = { weather: t('Weather station'), spin: t('Little Yellow'), lens: t('Lens buddy'), usbkey: t('Mini keypad'), lamp: t('Knob lamp'), ruler: t('Ultrasonic ruler'), tilt: t('Tilt buddy'), blank: t('Blank') };


/** Tile glyph: not a real look, just enough to recognise the part category */
function Glyph({ p }: { p: Part }) {
  const svg = (body: ReactNode) => (
    <svg viewBox="0 0 64 40" aria-hidden="true">
      {body}
    </svg>
  );
  const pins = (x: number, y: number, n: number) => Array.from({ length: n }, (_, i) => <rect key={`p${x},${y},${i}`} x={x + i * 5} y={y} width="2" height="5" fill="#C9A227" />);
  if (p.id === 'gc9a01')
    return svg(
      <>
        <rect x="14" y="2" width="36" height="36" rx="4" fill="#1d3557" />
        <circle cx="32" cy="20" r="14" fill="#0b0f14" />
        <circle cx="32" cy="20" r="11" fill="#2b4a6f" />
      </>,
    );
  if (p.id.startsWith('buzzer'))
    return svg(
      <>
        <rect x="18" y="6" width="28" height="28" rx="3" fill={p.id === 'buzzer-module' ? '#2f5f9e' : 'none'} />
        <circle cx="32" cy="20" r="11" fill="#1f1f1f" />
        <circle cx="32" cy="20" r="3" fill="#555" />
      </>,
    );
  if (p.id === 'led-kit')
    return svg(
      ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db'].map((col, i) => (
        <Fragment key={i}>
          <path d={`M${10 + i * 13} 22 a5 5 0 0 1 10 0 v6 h-10 z`} fill={col} />
          <rect x={12 + i * 13} y="28" width="1.5" height="9" fill="#aaa" />
          <rect x={17 + i * 13} y="28" width="1.5" height="7" fill="#aaa" />
        </Fragment>
      )),
    );
  if (p.id.startsWith('cap-'))
    return svg(
      <>
        <rect x="24" y="4" width="16" height="26" rx="3" fill="#1f3b73" />
        <rect x="34" y="4" width="4" height="26" fill="#9fb3d9" />
        <rect x="28" y="30" width="2" height="8" fill="#aaa" />
        <rect x="34" y="30" width="2" height="6" fill="#aaa" />
      </>,
    );
  if (p.id.startsWith('ws2812'))
    return svg(
      <>
        <rect x="4" y="13" width="56" height="14" rx="2" fill="#16181b" />
        {Array.from({ length: 8 }, (_, i) => (
          <Fragment key={i}>
            <rect x={7 + i * 6.6} y="16" width="5" height="8" fill="#f2f0ea" />
            <circle cx={9.5 + i * 6.6} cy="20" r="1.8" fill="#ffb060" />
          </Fragment>
        ))}
      </>,
    );
  if (p.id === 'encoder')
    return svg(
      <>
        <rect x="14" y="6" width="36" height="28" rx="2" fill="#1f55b0" />
        <circle cx="32" cy="20" r="10" fill="#1b1d21" />
        <rect x="31" y="11" width="2" height="6" fill="#f2f2f2" />
        {pins(22, 34, 5)}
      </>,
    );
  if (p.id === 'hc-sr04')
    return svg(
      <>
        <rect x="4" y="8" width="56" height="24" rx="2" fill="#2f7fc8" />
        <circle cx="18" cy="20" r="9" fill="#b8bcc2" stroke="#8a8e94" />
        <circle cx="46" cy="20" r="9" fill="#b8bcc2" stroke="#8a8e94" />
      </>,
    );
  if (p.id === 'button')
    return svg(
      [0, 1, 2, 3].map((i) => (
        <Fragment key={i}>
          <rect x={6 + i * 14} y="12" width="11" height="11" rx="2" fill="#1f1f1f" />
          <circle cx={11.5 + i * 14} cy="17.5" r="3.2" fill="#555" />
        </Fragment>
      )),
    );
  if (p.id === 'lens-dome')
    return svg(
      <>
        <ellipse cx="32" cy="24" rx="20" ry="8" fill="#dfeefb" stroke="#9cc3e6" />
        <path d="M12 24 Q32 0 52 24" fill="#eef6fd" stroke="#9cc3e6" />
      </>,
    );
  switch (p.kind) {
    case 'board':
      return svg(
        <>
          <rect x="4" y="8" width="56" height="24" rx="2" fill="#1f2328" />
          <rect x="10" y="12" width="20" height="16" rx="1" fill="#b8bec6" />
          <rect x="54" y="16" width="8" height="8" rx="1" fill="#9aa0a6" />
          {pins(6, 4, 11)}
          {pins(6, 31, 11)}
        </>,
      );
    case 'sensor':
      return svg(
        <>
          <rect x="16" y="6" width="32" height="26" rx="2" fill={p.id === 'bme280' ? '#6b3fa0' : '#2f6f4f'} />
          <rect x="27" y="14" width="10" height="10" fill="#cfd3d8" />
          <circle cx="20" cy="10" r="2" fill="#fff" />
          {pins(22, 32, 4)}
        </>,
      );
    case 'display':
      return svg(
        <>
          <rect x="10" y="4" width="44" height="30" rx="2" fill="#1d4f91" />
          <rect x="14" y="10" width="36" height="20" fill="#0b0f14" />
          <rect x="18" y="14" width="18" height="3" fill="#7fc8ff" />
          {pins(24, 34, 4)}
        </>,
      );
    case 'actuator':
      return svg(
        <>
          <rect x="12" y="12" width="34" height="20" rx="2" fill="#2563c9" />
          <rect x="6" y="18" width="46" height="5" rx="1" fill="#2563c9" />
          <circle cx="22" cy="10" r="5" fill="#f4f4f4" stroke="#bbb" />
          <rect x="18" y="8" width="20" height="4" rx="2" fill="#f4f4f4" stroke="#bbb" />
          <path d="M46 26 q8 0 12 8" stroke="#c0392b" strokeWidth="2" fill="none" />
        </>,
      );
    case 'power':
      return svg(
        <>
          <rect x="8" y="8" width="24" height="24" rx="3" fill="#2b2b2b" />
          <path d="M32 20 C44 20 44 30 56 30" stroke="#2b2b2b" strokeWidth="3" fill="none" />
          <rect x="52" y="26" width="8" height="8" rx="1" fill="#555" />
        </>,
      );
    case 'cable':
      return svg(
        <>
          <path d="M8 28 C20 4 44 36 56 12" stroke={p.id.startsWith('dupont') ? '#e67e22' : '#333'} strokeWidth="3" fill="none" />
          <rect x="2" y="24" width="10" height="8" rx="1" fill="#222" />
          <rect x="52" y="8" width="10" height="8" rx="1" fill="#222" />
        </>,
      );
    case 'proto':
      return svg(
        <>
          <rect x="4" y="6" width="56" height="28" rx="2" fill="#f2f2ee" stroke="#d6d6cf" />
          <rect x="4" y="18" width="56" height="3" fill="#e2e2da" />
          {Array.from({ length: 40 }, (_, i) => (
            <rect key={i} x={8 + (i % 10) * 5} y={(i < 20 ? 9 : 23) + Math.floor((i % 20) / 10) * 5} width="2" height="2" fill="#9a9a90" />
          ))}
          <rect x="6" y="7" width="52" height="1" fill="#e74c3c" />
          <rect x="6" y="32" width="52" height="1" fill="#2e86de" />
        </>,
      );
    case 'audio':
      return svg(
        <>
          <circle cx="32" cy="20" r="13" fill="#1f1f1f" />
          <circle cx="32" cy="20" r="4" fill="#444" />
        </>,
      );
    case 'enclosure':
      return svg(
        <>
          <path d="M14 14 L32 6 L50 14 L50 30 L32 38 L14 30 Z" fill="#f5f2ea" stroke="#c9c2b0" />
          <path d="M14 14 L32 22 L50 14 M32 22 L32 38" stroke="#c9c2b0" fill="none" />
        </>,
      );
    case 'passive':
      return svg(<path d="M6 20 H18 l3 -6 l5 12 l5 -12 l5 12 l5 -12 l3 6 H58" stroke="#8a6d3b" strokeWidth="2" fill="none" />);
    default:
      return svg(
        <>
          <rect x="14" y="8" width="36" height="24" rx="2" fill="#3d6b5a" />
          <rect x="26" y="14" width="12" height="12" fill="#1f1f1f" />
          {pins(22, 32, 4)}
        </>,
      );
  }
}

// ------------------------------------------------------------ list lines
interface Line {
  partId: string;
  part: Part;
  qty: number;
  /** already translated */
  why: string;
  group: 'req' | 'sug' | 'case';
  required: boolean;
  checked: boolean;
  /** Marked "I have it" in the board picker: listed and checked, but left out of the total (custom) */
  have?: boolean;
}

function linesOf(b: Bom, have: string[] = []): Line[] {
  const tpl = getTemplate(b.template);
  const picked = (id: string) => b.picks.find((p) => p.partId === id);
  const out: Line[] = [];
  const seen = new Set<string>();
  // R27: an EXT5V actuator with no other EXT5V source makes the 5 V adapter required.
  // Grouping must match the rule, otherwise a "suggested" line could be removed and then blocked.
  const ext5vNeeded = b.picks.some((p) => { const q = getPart(p.partId); return q.kind === 'actuator' && q.supplyNet === 'EXT5V'; })
    && !b.picks.some((p) => p.partId !== 'psu-5v2a' && getPart(p.partId).provides?.net === 'EXT5V');
  const add = (partId: string, qty: number, why: string, required: boolean) => {
    if (seen.has(partId)) return;
    if (ext5vNeeded && partId === 'psu-5v2a') required = true;
    seen.add(partId);
    const part = getPart(partId);
    const p = picked(partId);
    const group = part.kind === 'enclosure' ? 'case' : required ? 'req' : 'sug';
    out.push({ partId, part, qty: p?.qty ?? qty, why, group, required, checked: !!p, ...(have.includes(partId) ? { have: true } : {}) });
  };
  // The board line always comes first; if the board was swapped, show the new one
  const boardLine = [...tpl.required, ...tpl.suggested].find((l) => getPart(l.partId).kind === 'board');
  add(b.board, 1, b.board === tpl.board ? (boardLine ? t(boardLine.why) : t('Runs the firmware')) : t('Swapped dev board (template uses {board})', { board: shortName(tpl.board) }), true);
  // A board with the part built in (Waveshare round-display board has GC9A01): demote it to removable, R29 explains
  const builtin = getPart(b.board).board?.builtin ?? [];
  for (const l of tpl.required) {
    if (getPart(l.partId).kind === 'board') continue;
    const bi = builtin.find((x) => x.partId === l.partId);
    if (bi) add(l.partId, l.qty, t('The board already has {what}; no need to buy it', { what: t(bi.what) }), false);
    else add(l.partId, l.qty, t(l.why), true);
  }
  for (const l of tpl.suggested) if (getPart(l.partId).kind !== 'board') add(l.partId, l.qty, t(l.why), false);
  for (const p of b.picks) if (getPart(p.partId).kind !== 'board') add(p.partId, p.qty ?? 1, t(b.extra[p.partId] ?? 'You added it'), false);
  return out;
}

/** Multi-line text (used to be joined with <br>) */
const lines2 = (xs: string[]) => xs.map((x, i) => (
  <Fragment key={i}>
    {i > 0 && <br />}
    {x}
  </Fragment>
));

/** External link button */
const ExtLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <LinkBtn href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </LinkBtn>
);

export function shopStep(): StepImpl {
  let ctx: StepCtx | null = null;
  let unsubs: (() => void)[] = [];
  let hooked = false;
  const openGroups: Record<string, boolean> = { req: true, sug: true, case: true, ok: false };

  const hist = () => ctx!.store.get().bom;
  const bom = () => replay(hist());
  /** Board-picker works only: parts I already have, and list-only parts without a model */
  const have = () => ctx?.custom?.plan.have ?? [];
  const lineList = (b: Bom) => linesOf(b, have());
  /** Total skips parts I have; model-less parts still have to be bought, so they count */
  const totalOf = (b: Bom) => {
    const h = have();
    const tot = bomTotal(b.picks.filter((p) => !h.includes(p.partId)), h.includes(b.board) ? undefined : b.board);
    const nm = ctx?.custom?.plan.noModel ?? [];
    const r = (x: number) => Math.round(x * 100) / 100;
    return { lo: r(tot.lo + nm.reduce((a, n) => a + n.price[0], 0)), hi: r(tot.hi + nm.reduce((a, n) => a + n.price[1], 0)), kinds: tot.lines.length + nm.length };
  };
  const selected = () => {
    const s = ctx!.store.get().selection;
    return s?.kind === 'part' ? s.id : null;
  };
  const select = (id: string) => ctx!.store.set({ selection: { kind: 'part', id } });
  const tiles = () => ctx?.shell.layer.el.querySelector<HTMLElement>('.shop-stage');

  function commit(op: BomOp) {
    const c = ctx!;
    const h = push(hist(), op);
    if (h === hist()) return false;
    c.store.set({ bom: h });
    saveBom(wkey(c.work), h);
    return true;
  }

  function toggle(l: Line) {
    const c = ctx!;
    if (l.required && l.checked) {
      // Required lines stay checked; say why instead of silently ignoring the click
      c.shell.toast(l.partId === bom().board ? t('The dev board can\'t be removed, only swapped: use "Swap dev board" below') : t('Required part, can\'t be removed: {part} ({why})', { part: shortName(l.partId), why: l.why }));
      if (selected() === l.partId) render();
      else select(l.partId);
      return;
    }
    // Template-required but built into the new board: a plain remove would be blocked on replay, so log it as the R29 fix
    const builtin = !!getPart(bom().board).board?.builtin?.some((x) => x.partId === l.partId);
    if (l.checked && builtin) commit({ t: 'fix', fix: { action: 'remove', partId: l.partId }, rule: 'R29' });
    else commit(l.checked ? { t: 'remove', partId: l.partId } : { t: 'add', partId: l.partId });
    select(l.partId);
  }

  // ------------------------------------------------------------ tree (the list)
  function renderTree() {
    const c = ctx!;
    const b = bom();
    const lines = lineList(b);
    const sel = selected();
    const total = totalOf(b);
    const noModel = c.custom?.plan.noModel ?? [];
    const nHave = lines.filter((l) => l.have && l.checked).length;
    const row = (l: Line) => {
      const lo = l.part.price.lo * l.qty;
      const hi = l.part.price.hi * l.qty;
      const name = t(l.part.name);
      const label = l.required ? t('Required, can\'t remove: {part}', { part: name }) : l.checked ? t('Remove {part}', { part: name }) : t('Add {part}', { part: name });
      return (
        <div key={l.partId} className={cn('bn', sel === l.partId && 'on', !l.checked && 'off')} data-id={l.partId} role="treeitem" aria-selected={sel === l.partId}>
          <input
            type="checkbox"
            defaultChecked={l.checked}
            className={l.required ? 'locked' : ''}
            aria-label={label}
            title={l.required ? t('Required, can\'t remove') : ''}
            onClick={(e) => {
              if (l.required) e.preventDefault();
              toggle(l);
            }}
          />
          <button type="button" className="bn-l text-fg" data-id={l.partId} onClick={() => select(l.partId)}>
            {shortName(l.partId)}
            {l.qty > 1 && (
              <>
                {' '}
                <Muted className="font-mono">×{l.qty}</Muted>
              </>
            )}
            {l.have && <> <span className="tag" data-have>{t('I have it')}</span></>}
          </button>
          <TnM className={l.have ? 'line-through' : ''}>{range(lo, hi)}</TnM>
        </div>
      );
    };
    const group = (key: Line['group'], title: string) => {
      const ls = lines.filter((l) => l.group === key);
      if (!ls.length) return null;
      const on = ls.filter((l) => l.checked).length;
      return (
        <TreeGroup g={key} title={title} count={`${on}/${ls.length}`} open={!!openGroups[key]} onToggle={(o) => (openGroups[key] = o)}>
          {ls.map(row)}
        </TreeGroup>
      );
    };
    const inBom = new Set(b.picks.map((p) => p.partId));
    const kinds = Object.keys(KIND) as Kind[];
    const opts = kinds
      .filter((k) => k !== 'board')
      .map((k) => {
        const ps = PARTS.filter((p) => p.kind === k && !inBom.has(p.id));
        return ps.length ? (
          <optgroup key={k} label={KIND[k]}>
            {ps.map((p) => (
              <option key={p.id} value={p.id}>
                {t(p.name)}
              </option>
            ))}
          </optgroup>
        ) : null;
      });
    c.shell.tree.render(
      <>
        <div role="group" aria-label={t('Shopping list')}>
          {group('req', t('Required'))}
          {group('sug', t('Suggested'))}
          {group('case', t('Enclosure'))}
          {noModel.length > 0 && (
            <TreeGroup g="nomodel" title={t('List only · not in the simulator')} count={String(noModel.length)} open onToggle={() => undefined}>
              {noModel.map((n) => (
                <div key={n.id} className="bn" data-nomodel={n.id} role="treeitem" aria-selected={false} title={t('Not in the simulator: listed only, not put on the bench')}>
                  <ConfIcon c={REAL_HW} size={14} />
                  <span className="bn-l text-fg">{t(n.name)}</span>
                  <TnM>{range(n.price[0], n.price[1])}</TnM>
                </div>
              ))}
            </TreeGroup>
          )}
        </div>
        <label className="addpart edit-only">
          <Muted>{t('Add from Parts')}</Muted>
          <NSelect
            aria-label={t('Add a part from Parts')}
            defaultValue=""
            on={{
              change: (e) => {
                const id = e.currentTarget.value;
                if (!id) return;
                commit({ t: 'add', partId: id });
                select(id);
              },
            }}
          >
            <option value="">{t('Pick a part…')}</option>
            {opts}
          </NSelect>
        </label>
        <div className="bom-total">
          <div className="bt-row">
            <span>{t('Estimated total')}</span>
            <b className="font-mono">{range(total.lo, total.hi)}</b>
          </div>
          <Muted className="block">
            {t('Kinds: {n}', { n: total.kinds })}
            {nHave ? ` · ${t('Parts I have, not counted: {n}', { n: nHave })}` : ''} · {t('Prices checked {date}', { date: CHECKED_AT })} · {t('Shipping not included')} · {t('Store prices may differ')}
          </Muted>
        </div>
      </>,
    );
  }

  // ------------------------------------------------------------ right panel: rule check + part details
  /** Board specs and on-board pin use (P1-12): makes the difference obvious when swapping boards */
  function boardSpec(part: Part) {
    const b = part.board!;
    const USB = { native: t('Native chip USB'), uart: t('USB-to-serial chip'), both: t('Native USB and USB-to-serial (two ports)') } as const;
    const tbc = t('To be checked');
    const psram = b.psram === 'none' || b.psramMB === 0 ? t('None') : b.psramMB === null || b.psram === null ? tbc : b.psram === 'octal' ? t('{n} MB (octal, uses GPIO33–37)', { n: b.psramMB }) : t('{n} MB (quad)', { n: b.psramMB });
    const gpios = (part.pins ?? []).filter((p) => p.gpio !== undefined).length;
    const occ = b.onboard.map((o) => `GPIO${o.gpio} ${t(o.what)}`);
    // Catalog todo notes are "field: text" (older entries used a full-width colon); a bare field name means "unknown"
    const todo = part.todo
      .filter((x) => x.startsWith('board') || x.startsWith('pins'))
      .map((x) => (/^[\w.]+$/.test(x) ? `${x} · ${tbc}` : t(x.replace(/^[\w.]+[:\uff1a]\s*/, ''))));
    return (
      <>
        <Sec>{t('Board')}</Sec>
        {b.version && <Kv k={t('Version')} v={b.version} />}
        <Kv k="flash" v={b.flashMB === null ? tbc : `${b.flashMB} MB`} />
        <Kv k="PSRAM" v={psram} />
        <Kv k="USB" v={b.usb ? USB[b.usb] : tbc} />
        <Kv k={t('GPIO broken out')} v={part.pins ? String(gpios) : tbc} />
        {occ.length > 0 && <KvT k={t('Used on board')}>{lines2(occ)}</KvT>}
        {todo.length > 0 && <KvT k={tbc}>{lines2(todo)}</KvT>}
        <Btns>
          {b.urls.map((u, i) => (
            <ExtLink key={i} href={u}>
              {t('Docs {n}', { n: i + 1 })} ↗
            </ExtLink>
          ))}
        </Btns>
      </>
    );
  }

  function fixLabel(f: Finding) {
    const fx = f.fix!;
    const part = shortName(fx.partId);
    return fx.action === 'add' ? t('Fix: add {part}', { part }) : fx.action === 'remove' ? t('Fix: remove {part}', { part }) : t('Fix: swap to {part}', { part });
  }
  /** Toast after a one-click fix: past tense of fixLabel */
  function fixDone(f: Finding) {
    const fx = f.fix!;
    const vars = { part: shortName(fx.partId), rule: t(f.title) };
    return fx.action === 'add' ? t('Added {part}: {rule}', vars) : fx.action === 'remove' ? t('Removed {part}: {rule}', vars) : t('Swapped to {part}: {rule}', vars);
  }

  function renderProps() {
    const c = ctx!;
    const b = bom();
    const all = evaluate(ruleInput(b));
    const probs = all.filter((f) => f.level !== 'ok').sort((x, y) => (x.level === y.level ? 0 : x.level === 'block' ? -1 : 1));
    const oks = all.filter((f) => f.level === 'ok');
    const nb = probs.filter((f) => f.level === 'block').length;
    const finding = (f: Finding, i: number) => (
      <div key={i} className={cn('rf', f.level)}>
        <div className="rf-h">
          <span className="mk">{f.level === 'block' ? '✗' : '!'}</span>
          <span className="rf-t">
            {f.level === 'block' ? t('Won\'t run') : t('Heads-up')} · {t(f.title)}
          </span>
          <Muted className="font-mono">{f.id}</Muted>
        </div>
        <div className="rf-d">{t(f.detail)}</div>
        <div className="rf-s">
          <Conf c={confOfRule(f.confidence)} /> · {t(f.source)}
        </div>
        {f.fix && PART_BY_ID[f.fix.partId] && (
          <Btn
            primary
            className="edit-only"
            data-fix={i}
            onClick={() => {
              if (commit({ t: 'fix', fix: f.fix!, rule: f.id })) {
                c.shell.toast(fixDone(f));
                select(f.fix!.partId);
              }
            }}
          >
            {fixLabel(f)}
          </Btn>
        )}
      </div>
    );
    const rules = (
      <>
        <Sec>{t('Rule check')}</Sec>
        {probs.length ? (
          <>
            <VerdictLine kind={nb ? 'bad' : 'warn'}>
              {nb
                ? probs.length > nb
                  ? t('Must fix: {n}, or the project won\'t run; suggestions: {m}', { n: nb, m: probs.length - nb })
                  : t('Must fix: {n}, or the project won\'t run', { n: nb })
                : t('Could be better: {n}', { n: probs.length })}
            </VerdictLine>
            {probs.map(finding)}
          </>
        ) : (
          <VerdictLine kind="ok">✓ {t('The list is complete; you can buy from it')}</VerdictLine>
        )}
        <details className="oks" open={openGroups.ok} onToggle={(e) => (openGroups.ok = e.currentTarget.open)}>
          <summary>{probs.length ? t('Checked: {n}, OK: {ok}', { n: oks.length + probs.length, ok: oks.length }) : t('Checked: {n}, all OK', { n: oks.length + probs.length })}</summary>
          {oks.map((f, i) => (
            <Res key={i} kind="ok">
              {t(f.title)} <Muted className="font-mono">{f.id}</Muted>
            </Res>
          ))}
        </details>
      </>
    );

    const id = selected();
    const part = id ? PART_BY_ID[id] : undefined;
    let detail: ReactNode;
    if (part) {
      const l = lineList(b).find((x) => x.partId === part.id);
      const qty = l?.qty ?? 1;
      const v = part.voltage;
      const cur = part.currentMa;
      const pr = part.price;
      detail = (
        <>
          <Sec>{t('Part')}</Sec>
          <Ph>{t(part.name)}</Ph>
          <KvT k={t('Model')}>{t(part.model)}</KvT>
          <Kv k={t('Category')} v={KIND[part.kind]} />
          {v.supply && <Kv k={t('Power supply')} v={v.supply[0] === v.supply[1] ? `${v.supply[0]} V` : `${v.supply[0]}–${v.supply[1]} V`} />}
          {v.logic !== null && <Kv k={t('Logic level')} v={`${v.logic} V`} />}
          {(cur.typ !== null || cur.peak !== null) && <Kv k={cur.est ? t('Current (estimated)') : t('Current draw')} v={t('{typ} / peak {peak} mA', { typ: cur.typ ?? '—', peak: cur.peak ?? '—' })} />}
          {part.i2cAddr && <Kv k={t('I2C address')} v={`${hex(part.i2cAddr.default)}${part.i2cAddr.alt.length ? ' / ' + part.i2cAddr.alt.map(hex).join(' / ') : ''}`} />}
          {part.sizeMm && <Kv k={t('Size')} v={`${part.sizeMm[0]} × ${part.sizeMm[1]}${part.sizeMm[2] !== null ? ' × ' + part.sizeMm[2] : ''} mm`} />}
          {part.board && boardSpec(part)}
          <Sec>{t('Reference price')}</Sec>
          <Kv k={qty > 1 ? t('Reference price ×{n}', { n: qty }) : t('Reference price')} v={range(pr.lo * qty, pr.hi * qty)} />
          <Kv k={t('Price checked on')} v={pr.checkedAt} />
          <Note>{t('Reference price: {source}. Store prices may differ.', { source: t(pr.source) })}</Note>
          <Sec>{t('Simulation level')}</Sec>
          <Field className={`sim-${part.sim.level}`}>
            <Conf c={SIM_CONF[part.sim.level]} />: {SIM[part.sim.level]}
          </Field>
          <Sec>{t('Why it\'s needed')}</Sec>
          <p className="why mt-0 mb-1">
            {l?.why ?? t('Not in the current list')}
            {l && (l.required ? <> <span className="tag">{t('Required')}</span></> : l.checked ? null : <> <span className="tag off">{t('Not selected')}</span></>)}
            {l?.have && <> <span className="tag">{t('I have it · not priced')}</span></>}
          </p>
          {part.note && <Note>{t(part.note)}</Note>}
          <Sec>{t('Search stores')}</Sec>
          <Btns>
            <ExtLink href={part.searchUrl.taobao}>{t('Search Taobao')} ↗</ExtLink>
            <ExtLink href={part.searchUrl.szlcsc}>{t('Search LCSC')} ↗</ExtLink>
          </Btns>
          <Note>
            {t('Search terms:')} <Mono>{part.keywords}</Mono>. {t('Just a search page, not a store recommendation.')}
          </Note>
        </>
      );
    } else
      detail = (
        <>
          <Sec>{t('Part')}</Sec>
          <TreeEmpty>{t('Click a part in the list on the left or in the middle to see details')}</TreeEmpty>
        </>
      );
    const caseT = part && /^enclosure-(weather|spin|lens|usbkey)$/.test(part.id) ? part.id.slice('enclosure-'.length) : null;
    c.shell.props.render(
      <>
        {rules}
        {caseT && caseDetail(caseT)}
        {detail}
      </>,
    );
    c.shell.setVerdict(nb ? t('Must fix: {n}', { n: nb }) : probs.length ? t('Suggestions: {n}', { n: probs.length }) : t('List complete'), nb ? 'bad' : probs.length ? 'warn' : 'ok');
  }

  // ------------------------------------------------------------ parametric enclosure (P1-08): size, params, warnings, export
  let caseOut: { text: string; ok: boolean } | null = null;
  const caseParamsOf = (w: string): CaseParams => (w === ctx!.work.id ? ctx!.store.get().caseParams : loadCaseParams(w));
  function caseDetail(w: string) {
    const p = caseParamsOf(w);
    const L = layoutFor(w, ctx!.store.get().bom, p);
    const dims = L.shape === 'rect' ? `${L.outer[0]} × ${L.outer[1]} × ${L.outer[2]} mm` : t('Base Ø{d} × {h} mm', { d: L.outer[0], h: L.outer[2] });
    const props = ctx!.shell.props.el;
    const slider = (k: keyof CaseParams, label: string, step: number) => {
      const [lo, hi] = PARAM_RANGE[k];
      return (
        <label className="case-p">
          <span className="k">{label}</span>
          <NInput
            type="range"
            min={lo}
            max={hi}
            step={step}
            defaultValue={p[k]}
            data-cp={k}
            aria-label={label}
            className="accent-(--accent)"
            on={{
              input: (e) => {
                const n = props.querySelector<HTMLInputElement>(`[data-cpn="${k}"]`);
                if (n) n.value = e.currentTarget.value;
              },
              change: (e) => setCase(w, { [k]: Number(e.currentTarget.value) }),
            }}
          />
          <NInput type="number" min={lo} max={hi} step={step} defaultValue={p[k]} data-cpn={k} className="font-mono" aria-label={t('{label} (number)', { label })} on={{ change: (e) => setCase(w, { [k]: Number(e.currentTarget.value) }) }} />
          <Muted>mm</Muted>
        </label>
      );
    };
    const exportAs = async (b: HTMLButtonElement, fmt: 'stl' | '3mf') => {
      const out = props.querySelector('#caseOut');
      b.disabled = true;
      if (out) out.textContent = t('Generating enclosure {fmt}…', { fmt: fmt.toUpperCase() });
      try {
        const r = await exportCase(w, ctx!.store.get().bom, caseParamsOf(w), fmt);
        download(r.name, r.bytes, fmt === 'stl' ? 'model/stl' : 'model/3mf');
        caseOut = { ok: r.check.ok, text: `${r.name} · ${(r.bytes.length / 1024).toFixed(0)} KB · ${r.check.text}` };
        (window as unknown as { __tbCase: unknown }).__tbCase = { name: r.name, bytes: r.bytes.length, check: r.check };
      } catch (e) {
        caseOut = { ok: false, text: t('Export failed: {err}', { err: String(e) }) };
      }
      if (ctx) renderProps();
    };
    return (
      <>
        <Sec>{t('Parametric enclosure · estimate, not calibrated on real hardware')}</Sec>
        <Ph>{t('Generated from the listed parts\' sizes')}</Ph>
        <Kv k={t('Outer size')} v={dims} />
        <Kv k={t('Inner / needed')} v={`${L.inner} / ${L.need} mm`} cls={L.inner < L.need ? 'bad' : ''} />
        <Kv k={t('Minimum height')} v={`${L.minHeight} mm`} />
        <div className="case-ps edit-only">
          {slider('height', L.shape === 'rect' ? t('Height') : t('Base height'), 0.5)}
          {slider('wall', t('Wall thickness'), 0.1)}
          {L.shape === 'rect' && slider('radius', t('Corner radius'), 0.5)}
        </div>
        {L.warnings.length ? (
          L.warnings.map((w, i) => (
            <Res key={i} kind="bad" mk="!">
              {w.text}
            </Res>
          ))
        ) : (
          <Res kind="ok">
            {t('All parts fit (inner {inner} mm, needed {need} mm)', { inner: L.inner, need: L.need })}
          </Res>
        )}
        <details className="oks">
          <summary>{t('Holes and mounts: {n}', { n: L.features.bottom.length + L.features.lid.length })}</summary>
          {[...L.features.bottom.map((f) => t('Bottom: {f}', { f })), ...L.features.lid.map((f) => t('Lid: {f}', { f }))].map((f, i) => (
            <Res key={i} kind="na">
              {f}
            </Res>
          ))}
        </details>
        <details className="oks">
          <summary>{t('Part sizes used')}</summary>
          {L.sizes.map((x, i) => (
            <Kv key={i} k={shortName(x.part)} v={x.est ? t('{size} mm (estimated)', { size: x.size.map((v) => +v.toFixed(1)).join(' × ') }) : `${x.size.map((v) => +v.toFixed(1)).join(' × ')} mm`} />
          ))}
        </details>
        <Btns>
          <Btn primary data-export="stl" onClick={(e) => void exportAs(e.currentTarget, 'stl')}>
            {t('Export STL')}
          </Btn>
          <Btn data-export="3mf" onClick={(e) => void exportAs(e.currentTarget, '3mf')}>
            {t('Export 3MF')}
          </Btn>
        </Btns>
        <Note id="caseOut">{caseOut ? <span className={caseOut.ok ? 'okc text-ok-ink' : 'bad text-bad-ink'}>{caseOut.text}</span> : t('The 3MF has the base and lid laid out for printing; upload it to a print service for a quote.')}</Note>
      </>
    );
  }
  function setCase(w: string, patch: Partial<CaseParams>) {
    const c = ctx!;
    const p = { ...caseParamsOf(w), ...patch };
    for (const k of Object.keys(PARAM_RANGE) as (keyof CaseParams)[]) p[k] = Math.min(PARAM_RANGE[k][1], Math.max(PARAM_RANGE[k][0], Number(p[k]) || PARAM_RANGE[k][0]));
    saveCaseParams(w, p);
    if (w === c.work.id) c.store.set({ caseParams: p });
    caseOut = null;
    renderProps();
  }

  // ------------------------------------------------------------ middle: part tiles
  function renderStage() {
    const c = ctx!;
    const b = bom();
    const lines = lineList(b);
    const sel = selected();
    const plan = c.custom?.plan;
    const card = (l: Line) => (
      <button key={l.partId} type="button" className={cn('pc text-fg', !l.checked && 'off', sel === l.partId && 'on')} data-id={l.partId} aria-pressed={sel === l.partId} title={t(l.part.name)} onClick={() => select(l.partId)}>
        <span className="pc-g">
          <Glyph p={l.part} />
        </span>
        <span className="pc-n">
          {shortName(l.partId)}
          {l.qty > 1 ? ` ×${l.qty}` : ''}
        </span>
        <span className="pc-m font-mono">{l.have ? t('I have it') : l.checked ? range(l.part.price.lo * l.qty, l.part.price.hi * l.qty) : t('Not selected')}</span>
        {l.required && <span className="pc-b">{t('Required')}</span>}
      </button>
    );
    const grp = (key: Line['group'], title: string) => {
      const ls = lines.filter((l) => l.group === key);
      return ls.length ? (
        <section className="ss-g">
          <div className="ss-h">{title}</div>
          <div className="ss-grid">{ls.map(card)}</div>
        </section>
      ) : null;
    };
    c.shell.layer.render(
      <div className="shop-stage" role="region" aria-label={t('Part tiles')}>
        <div className="ss-title">
          <b>{t(getTemplate(b.template).title)}</b>
          <Muted>
            {shortName(b.board)} · {t('Click a part for details; dashed ones are unselected suggestions')}
            {b.template !== c.work.id ? ` · ${t('Going to the Bench switches to this project (firmware too)')}` : ''}
          </Muted>
          {plan?.sub && <Muted className="block" data-sub>{plan.sub}</Muted>}
          {plan && <Muted className="block">{t('Step one only lists parts and reference prices; don\'t buy yet: buy once it works on the Bench.')}</Muted>}
        </div>
        {grp('req', t('Required'))}
        {grp('sug', t('Suggested'))}
        {grp('case', t('Enclosure'))}
        {plan && plan.noModel.length > 0 && (
          <section className="ss-g">
            <div className="ss-h">{t('List only · not in the simulator')}</div>
            <div className="ss-grid">
              {plan.noModel.map((n) => (
                <div key={n.id} className="pc text-fg off" data-nomodel={n.id} title={t('Not in the simulator: listed only, not put on the bench')}>
                  <span className="pc-n">{t(n.name)}</span>
                  <span className="pc-m font-mono">{range(n.price[0], n.price[1])}</span>
                  <Conf c={REAL_HW} />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>,
    );
  }

  function renderTimeline() {
    const h = hist();
    ctx!.shell.timeline.setSteps(h.ops.map((op, i) => ({ id: `bom:${i}`, ...opLabel(op) })));
    ctx!.shell.timeline.setCurrent(h.cur);
  }

  function render() {
    if (!ctx) return;
    renderTree();
    renderProps();
    renderStage();
    renderTimeline();
    ctx.shell.toolbar.setActive(`tpl:${bom().template}`);
  }

  // ------------------------------------------------------------ swap dev board: a card above the toolbar
  function boardPicker() {
    const c = ctx!;
    const b = bom();
    const tb = document.getElementById('toolbar')!.getBoundingClientRect();
    const st = c.shell.stage.getBoundingClientRect();
    c.shell.card.show(
      { x: tb.right - st.left - 140, y: tb.top - st.top - 8 },
      <div className="board-pick">
        <Sec>{t('Swap dev board')}</Sec>
        {BOARDS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={tnClass(p.id === b.board)}
            data-id={p.id}
            onClick={() => {
              c.shell.card.hide();
              if (commit({ t: 'board', partId: p.id })) select(p.id);
            }}
          >
            <TnL>{t(p.name)}</TnL>
            <TnM>{range(p.price.lo, p.price.hi)}</TnM>
          </button>
        ))}
        <Note>{t('Swapping boards keeps the wiring; pin conflicts show up in the rule check.')}</Note>
      </div>,
    );
    // The card lives in the 3D stage below the tile layer (stepLayer): disable tile clicks while open, or the card can't be clicked
    const tl = tiles();
    if (tl) tl.style.pointerEvents = 'none';
  }

  function onTool(id: string) {
    const c = ctx;
    if (!c || c.store.get().step !== 'shop') return;
    if (id.startsWith('tpl:')) {
      const tid = id.slice(4);
      const title = t(getTemplate(tid).title);
      if (tid === bom().template) return c.shell.toast(t('Already the list for "{title}"', { title }));
      commit({ t: 'template', id: tid });
      const n = lineList(bom()).filter((l) => l.required).length;
      c.shell.toast(tid !== c.work.id
        ? t('Applied "{title}": required parts: {n}, suggestions checked by default; the Bench will switch to this project\'s firmware', { title, n })
        : t('Applied "{title}": required parts: {n}, suggestions checked by default', { title, n }));
    } else if (id === 'board') boardPicker();
  }

  function onSeek(i: number) {
    const c = ctx;
    if (!c || c.store.get().step !== 'shop') return;
    const h = { ...hist(), cur: i };
    c.store.set({ bom: h });
    saveBom(wkey(c.work), h);
  }

  function defaultSelection() {
    const c = ctx!;
    const id = selected();
    const b = bom();
    if (id && lineList(b).some((l) => l.partId === id)) return;
    if (c.store.get().selection && c.store.get().selection?.kind !== 'part') return;
    const tpl = getTemplate(b.template);
    const first = tpl.required.find((l) => getPart(l.partId).kind !== 'board' && l.partId !== 'usb-c-cable');
    c.store.set({ selection: { kind: 'part', id: first?.partId ?? b.board } });
  }

  // ------------------------------------------------------------ put on the bench (P0-09)
  function place() {
    const c = ctx!;
    const b = bom();
    const p = placement(b);
    const power = p.ext5v ? t('USB and external 5 V') : 'USB';
    const skipped = p.skipped.length ? `; ${t('No default wiring, not put on the bench: {parts}', { parts: p.skipped.map(partLabel).join(', ') })}` : '';
    if (b.template !== c.work.id) {
      // The list switched project: firmware follows the project, so reload into its bench (DECISIONS 2026-10-16 enclosure)
      const target = b.template as WorkId;
      const h = hist();
      saveBom(target, { ops: h.ops.slice(0, h.cur + 1), cur: h.cur });
      savePlaced(target, { parts: p.parts as SceneSpec['parts'] }, p.ext5v);
      location.href = lab(target);
      return;
    }
    const scene: SceneSpec = { ...c.session.scene, parts: p.parts as SceneSpec['parts'] };
    savePlaced(wkey(c.work), scene, p.ext5v);
    // Board-picker checkpoints are generated from bench parts: if they change, reload so session and progress rebuild
    if (c.custom) {
      const { plan, levels } = c.custom;
      const next = genLevels({ boardName: plan.boardName, chip: plan.chip, parts: scene.parts, deepSleep: plan.deepSleep });
      if (JSON.stringify(next) !== JSON.stringify(levels)) {
        location.hash = 'bench';
        location.reload();
        return;
      }
    }
    c.session.applyScene(scene, { ext5v: p.ext5v });
    location.hash = 'bench';
    c.store.set({ selection: { kind: 'power', id: 'usb' } });
    c.shell.toast(t('Placed from the list: {n} ({parts}); power: {power}', { n: p.parts.length, parts: p.parts.map((x) => partLabel(x.type)).join(', ') || t('dev board only'), power }) + skipped);
  }

  return {
    mount(c) {
      ctx = c;
      if (!hooked) {
        hooked = true;
        c.shell.toolbar.onTool(onTool);
        c.shell.timeline.onSeek((i) => onSeek(i));
        c.shell.card.onHide(() => tiles()?.style.removeProperty('pointer-events'));
      }
      // Board-picker works can't switch templates (it would no longer be the picker's result; change it there)
      c.shell.toolbar.setGroups([
        ...(c.custom ? [] : [{ id: 'tpl', tools: PROCURE_TEMPLATES.map((x) => ({ id: `tpl:${x.id}`, label: TPL_SHORT[x.id] ?? t(x.title) })) }]),
        { id: 'board', tools: [{ id: 'board', label: t('Swap dev board…') }] },
      ]);
      if (c.store.get().selection?.kind !== 'part') c.store.set({ selection: null });
      defaultSelection();
      render();
      c.shell.setNext(t('Next: Bench →'), 'bench', '', place);
      // Top-bar Undo / ⌘Z walks the BOM history here (2026-10-18 walkthrough: timeline recorded it but Undo was greyed)
      actions.shopUndo = (d) => {
        const h = hist();
        const i = h.cur + d;
        if (i < 0 || i >= h.ops.length) return;
        const op = h.ops[d < 0 ? h.cur : i];
        onSeek(i);
        c.shell.toast(d < 0 ? t('Undone: {op}', { op: opLabel(op).label }) : t('Redone: {op}', { op: opLabel(op).label }));
      };
      unsubs = [
        c.store.subscribe(() => render(), ['selection']),
        // BOM changed (incl. timeline seek): reset selection if the part left the list, then redraw
        c.store.subscribe(() => {
          const before = c.store.get().selection;
          defaultSelection();
          if (c.store.get().selection === before) render();
        }, ['bom']),
      ];
    },
    unmount() {
      unsubs.forEach((u) => u());
      unsubs = [];
      // A shop selection (a BOM part id) means nothing on the Bench
      if (ctx?.store.get().selection?.kind === 'part') ctx.store.set({ selection: null });
      actions.shopUndo = undefined;
      ctx = null;
    },
  };
}
