// ① 采购（P0-07）+ 买完摆上实验台（P0-09）。
// 左树：清单分组（必选 / 建议 / 外壳），合计参考价；中间：零件平铺（未选的建议件虚线）；
// 右栏：规则检查 + 选中零件详情；工具条：切模板、换开发板；时间线：清单变更，点回去 = 重放。
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

const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
const yuan = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const range = (lo: number, hi: number) => `¥${yuan(lo)}–${yuan(hi)}`;

// ------------------------------------------------------------ 本机存储（per work）
const BOM_KEY = (w: string) => `tryboard-app-shop:${w}`;
const PLACED_KEY = (w: string) => `tryboard-app-placed:${w}`;

export function loadBom(work: string): BomHistory {
  try {
    const h = JSON.parse(localStorage.getItem(BOM_KEY(work)) ?? 'null');
    if (validHistory(h)) return h;
  } catch {
    /* 存的东西坏了：回到模板默认 */
  }
  // 选板作品（custom:<哈希>）的模板在 main.tsx 里按地址参数注册成 'custom'
  return initialHistory(work.startsWith('custom:') ? 'custom' : PROCURE_TEMPLATES.some((t) => t.id === work) ? work : 'blank');
}
export function saveBom(work: string, h: BomHistory) {
  try {
    localStorage.setItem(BOM_KEY(work), JSON.stringify(h));
    noteSaved();
  } catch {
    /* 隐私模式存不了：清单只在本页有效 */
  }
}
export function loadPlaced(work: string): { scene: SceneSpec; ext5v: boolean } | null {
  try {
    const p = JSON.parse(localStorage.getItem(PLACED_KEY(work)) ?? 'null');
    if (p && Array.isArray(p.scene?.parts) && typeof p.ext5v === 'boolean') return p;
  } catch {
    /* 同上 */
  }
  return null;
}
function savePlaced(work: string, scene: SceneSpec, ext5v: boolean) {
  try {
    localStorage.setItem(PLACED_KEY(work), JSON.stringify({ scene, ext5v }));
    noteSaved();
  } catch {
    /* 同上 */
  }
}

// ------------------------------------------------------------ 文案
const KIND: Record<Kind, string> = {
  board: '开发板',
  sensor: '传感器',
  display: '屏幕',
  actuator: '执行器',
  input: '输入',
  audio: '声音',
  power: '电源',
  cable: '线材',
  passive: '阻容小件',
  module: '模块',
  proto: '面包板和原型',
  enclosure: '外壳',
};
const SIM: Record<Part['sim']['level'], string> = {
  verified: '有验收固件跑过这个模型',
  estimated: '模型是近似的，读数不一定准',
  none: '模拟器里没有它，只算进清单和规则',
};
/** 零件模拟程度 → 可信度四档（U-14：图标表达，不再按颜色） */
const SIM_CONF: Record<Part['sim']['level'], ConfLevel> = { verified: '仿真验证', estimated: '行为模拟', none: '必须上真机' };
const TPL_SHORT: Record<string, string> = { weather: '气象站', spin: '小黄', lens: '透镜小人', usbkey: '小键盘', lamp: '旋钮台灯', ruler: '超声波尺子', tilt: '体感小人', blank: '空白' };


/** 零件平铺用的示意小图（不是外观模型，只帮人认出是哪一类） */
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

// ------------------------------------------------------------ 清单的行
interface Line {
  partId: string;
  part: Part;
  qty: number;
  why: string;
  group: 'req' | 'sug' | 'case';
  required: boolean;
  checked: boolean;
  /** 选板时勾了「我已有」：照样列出、勾上，但不算进合计（custom） */
  have?: boolean;
}

function linesOf(b: Bom, have: string[] = []): Line[] {
  const t = getTemplate(b.template);
  const picked = (id: string) => b.picks.find((p) => p.partId === id);
  const out: Line[] = [];
  const seen = new Set<string>();
  // R27：清单里有走外接 5 V 的执行器、又没有别的 EXT5V 电源时，5 V 适配器是必选（分组和规则同一个口径，不然"建议"能删、删完又被阻断）
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
  // 开发板一行永远在最上面：模板里的板子换过就显示换后的
  const boardLine = [...t.required, ...t.suggested].find((l) => getPart(l.partId).kind === 'board');
  add(b.board, 1, b.board === t.board ? (boardLine?.why ?? '跑固件') : `换过的开发板（模板里是 ${shortName(t.board)}）`, true);
  // 换成自带同款器件的板（微雪圆屏板自带 GC9A01）：模板的必选件降为可去掉的建议件，R29 说为什么
  const builtin = getPart(b.board).board?.builtin ?? [];
  for (const l of t.required) {
    if (getPart(l.partId).kind === 'board') continue;
    const bi = builtin.find((x) => x.partId === l.partId);
    if (bi) add(l.partId, l.qty, `板上已经有${bi.what}，不用再买`, false);
    else add(l.partId, l.qty, l.why, true);
  }
  for (const l of t.suggested) if (getPart(l.partId).kind !== 'board') add(l.partId, l.qty, l.why, false);
  for (const p of b.picks) if (getPart(p.partId).kind !== 'board') add(p.partId, p.qty ?? 1, b.extra[p.partId] ?? '你加的', false);
  return out;
}

/** 多行文字（原来用 <br> 拼） */
const lines2 = (xs: string[]) => xs.map((x, i) => (
  <Fragment key={i}>
    {i > 0 && <br />}
    {x}
  </Fragment>
));

/** 外部链接按钮 */
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
  /** 选板作品：我已有的件、没模型只进清单的件（其他作品都是空） */
  const have = () => ctx?.custom?.plan.have ?? [];
  const lineList = (b: Bom) => linesOf(b, have());
  /** 合计：我已有的不算；没模型的件照样要买，加进去 */
  const totalOf = (b: Bom) => {
    const h = have();
    const t = bomTotal(b.picks.filter((p) => !h.includes(p.partId)), h.includes(b.board) ? undefined : b.board);
    const nm = ctx?.custom?.plan.noModel ?? [];
    const r = (x: number) => Math.round(x * 100) / 100;
    return { lo: r(t.lo + nm.reduce((a, n) => a + n.price[0], 0)), hi: r(t.hi + nm.reduce((a, n) => a + n.price[1], 0)), kinds: t.lines.length + nm.length };
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
      // 必选不能去：勾选框保持勾上，并说清楚为什么
      c.shell.toast(l.partId === bom().board ? '开发板不能去掉，只能换：用底部的「换开发板」' : `必选件不能去掉：${shortName(l.partId)}（${l.why}）`);
      if (selected() === l.partId) render();
      else select(l.partId);
      return;
    }
    // 模板必选、但新板子上已经焊了的件：日志里的普通 remove 会被"必选不能去"拦下，按 R29 的一键去掉记
    const builtin = !!getPart(bom().board).board?.builtin?.some((x) => x.partId === l.partId);
    if (l.checked && builtin) commit({ t: 'fix', fix: { action: 'remove', partId: l.partId }, rule: 'R29' });
    else commit(l.checked ? { t: 'remove', partId: l.partId } : { t: 'add', partId: l.partId });
    select(l.partId);
  }

  // ------------------------------------------------------------ 构建树（清单）
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
      const label = `${l.required ? '必选，不能去掉' : l.checked ? '去掉' : '加上'} ${l.part.name}`;
      return (
        <div key={l.partId} className={cn('bn', sel === l.partId && 'on', !l.checked && 'off')} data-id={l.partId} role="treeitem" aria-selected={sel === l.partId}>
          <input
            type="checkbox"
            defaultChecked={l.checked}
            className={l.required ? 'locked' : ''}
            aria-label={label}
            title={l.required ? '必选，不能去掉' : ''}
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
            {l.have && <> <span className="tag" data-have>我已有</span></>}
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
                {p.name}
              </option>
            ))}
          </optgroup>
        ) : null;
      });
    c.shell.tree.render(
      <>
        <div role="group" aria-label="采购清单">
          {group('req', '必选')}
          {group('sug', '建议')}
          {group('case', '外壳')}
          {noModel.length > 0 && (
            <TreeGroup g="nomodel" title="只进清单 · 模拟器里没有" count={String(noModel.length)} open onToggle={() => undefined}>
              {noModel.map((n) => (
                <div key={n.id} className="bn" data-nomodel={n.id} role="treeitem" aria-selected={false} title="模拟器里没有它：只进清单，不上实验台">
                  <ConfIcon c="必须上真机" size={14} />
                  <span className="bn-l text-fg">{n.name}</span>
                  <TnM>{range(n.price[0], n.price[1])}</TnM>
                </div>
              ))}
            </TreeGroup>
          )}
        </div>
        <label className="addpart edit-only">
          <Muted>从元件库加</Muted>
          <NSelect
            aria-label="从元件库加零件"
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
            <option value="">选一个零件…</option>
            {opts}
          </NSelect>
        </label>
        <div className="bom-total">
          <div className="bt-row">
            <span>合计参考价</span>
            <b className="font-mono">{range(total.lo, total.hi)}</b>
          </div>
          <Muted className="block">
            {total.kinds} 种{nHave ? ` · 我已有的 ${nHave} 件不计` : ''} · 核价 {CHECKED_AT} · 不含运费 · 以店铺实际为准
          </Muted>
        </div>
      </>,
    );
  }

  // ------------------------------------------------------------ 右栏：规则检查 + 零件详情
  /** 开发板的规格与板载占用（P1-12）：换板时一眼看出差在哪 */
  function boardSpec(part: Part) {
    const b = part.board!;
    const USB = { native: '芯片原生 USB', uart: 'USB 转串口芯片', both: '原生 USB 和 USB 转串口（两个口）' } as const;
    const psram = b.psram === 'none' || b.psramMB === 0 ? '无' : b.psramMB === null || b.psram === null ? '待核' : `${b.psramMB} MB（${b.psram === 'octal' ? '八线，占 GPIO33–37' : '四线'}）`;
    const gpios = (part.pins ?? []).filter((p) => p.gpio !== undefined).length;
    const occ = b.onboard.map((o) => `GPIO${o.gpio} ${o.what}`);
    const todo = part.todo.filter((t) => t.startsWith('board') || t.startsWith('pins')).map((t) => t.replace(/^[\w.]+：/, ''));
    return (
      <>
        <Sec>板子</Sec>
        {b.version && <Kv k="版本" v={b.version} />}
        <Kv k="flash" v={b.flashMB === null ? '待核' : `${b.flashMB} MB`} />
        <Kv k="PSRAM" v={psram} />
        <Kv k="USB" v={b.usb ? USB[b.usb] : '待核'} />
        <Kv k="引出 GPIO" v={part.pins ? String(gpios) : '待核'} />
        {occ.length > 0 && <KvT k="板载占用">{lines2(occ)}</KvT>}
        {todo.length > 0 && <KvT k="待核">{lines2(todo)}</KvT>}
        <Btns>
          {b.urls.map((u, i) => (
            <ExtLink key={i} href={u}>
              资料 {i + 1} ↗
            </ExtLink>
          ))}
        </Btns>
      </>
    );
  }

  function fixLabel(f: Finding) {
    const fx = f.fix!;
    return fx.action === 'add' ? `一键补上 ${shortName(fx.partId)}` : fx.action === 'remove' ? `一键去掉 ${shortName(fx.partId)}` : `一键换成 ${shortName(fx.partId)}`;
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
            {f.level === 'block' ? '跑不起来' : '提醒'} · {f.title}
          </span>
          <Muted className="font-mono">{f.id}</Muted>
        </div>
        <div className="rf-d">{f.detail}</div>
        <div className="rf-s">
          <Conf c={confOfRule(f.confidence)} /> · {f.source}
        </div>
        {f.fix && PART_BY_ID[f.fix.partId] && (
          <Btn
            primary
            className="edit-only"
            data-fix={i}
            onClick={() => {
              if (commit({ t: 'fix', fix: f.fix!, rule: f.id })) {
                c.shell.toast(`${fixLabel(f).replace('一键', '已')}：${f.title}`);
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
        <Sec>规则检查</Sec>
        {probs.length ? (
          <>
            <VerdictLine kind={nb ? 'bad' : 'warn'}>
              {probs.length} 条提醒{nb ? `，其中 ${nb} 条会让作品跑不起来` : ''}
            </VerdictLine>
            {probs.map(finding)}
          </>
        ) : (
          <VerdictLine kind="ok">✓ 清单没问题</VerdictLine>
        )}
        <details className="oks" open={openGroups.ok} onToggle={(e) => (openGroups.ok = e.currentTarget.open)}>
          <summary>{oks.length} 条规则通过</summary>
          {oks.map((f, i) => (
            <Res key={i} kind="ok">
              {f.title} <Muted className="font-mono">{f.id}</Muted>
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
          <Sec>零件</Sec>
          <Ph>{part.name}</Ph>
          <KvT k="型号">{part.model}</KvT>
          <Kv k="类别" v={KIND[part.kind]} />
          {v.supply && <Kv k="供电" v={v.supply[0] === v.supply[1] ? `${v.supply[0]} V` : `${v.supply[0]}–${v.supply[1]} V`} />}
          {v.logic !== null && <Kv k="逻辑电平" v={`${v.logic} V`} />}
          {(cur.typ !== null || cur.peak !== null) && <Kv k={`电流${cur.est ? '（估算）' : ''}`} v={`${cur.typ ?? '—'} / 峰值 ${cur.peak ?? '—'} mA`} />}
          {part.i2cAddr && <Kv k="I2C 地址" v={`${hex(part.i2cAddr.default)}${part.i2cAddr.alt.length ? ' / ' + part.i2cAddr.alt.map(hex).join(' / ') : ''}`} />}
          {part.sizeMm && <Kv k="尺寸" v={`${part.sizeMm[0]} × ${part.sizeMm[1]}${part.sizeMm[2] !== null ? ' × ' + part.sizeMm[2] : ''} mm`} />}
          {part.board && boardSpec(part)}
          <Sec>参考价</Sec>
          <Kv k={`参考价${qty > 1 ? ` ×${qty}` : ''}`} v={range(pr.lo * qty, pr.hi * qty)} />
          <Kv k="核价日期" v={pr.checkedAt} />
          <Note>参考价：{pr.source}。以店铺实际为准。</Note>
          <Sec>模拟程度</Sec>
          <Field className={`sim-${part.sim.level}`}>
            <Conf c={SIM_CONF[part.sim.level]} />：{SIM[part.sim.level]}
          </Field>
          <Sec>为什么需要</Sec>
          <p className="why mt-0 mb-1">
            {l?.why ?? '不在当前清单里'}
            {l && (l.required ? <> <span className="tag">必选</span></> : l.checked ? null : <> <span className="tag off">未选</span></>)}
            {l?.have && <> <span className="tag">我已有 · 不计价</span></>}
          </p>
          {part.note && <Note>{part.note}</Note>}
          <Sec>去店铺搜</Sec>
          <Btns>
            <ExtLink href={part.searchUrl.taobao}>淘宝搜索 ↗</ExtLink>
            <ExtLink href={part.searchUrl.szlcsc}>立创商城搜索 ↗</ExtLink>
          </Btns>
          <Note>
            搜索词：<Mono>{part.keywords}</Mono>。只是搜索页，不是推荐某家店。
          </Note>
        </>
      );
    } else
      detail = (
        <>
          <Sec>零件</Sec>
          <TreeEmpty>点左边清单或中间的零件看详情</TreeEmpty>
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
    // 结论：n 条提醒 / 清单没问题
    c.shell.setVerdict(probs.length ? `${probs.length} 条提醒` : '清单没问题', nb ? 'bad' : probs.length ? 'warn' : 'ok');
  }

  // ------------------------------------------------------------ 参数化外壳（P1-08）：尺寸、可调参数、警告、导出
  let caseOut: { text: string; ok: boolean } | null = null;
  const caseParamsOf = (t: string): CaseParams => (t === ctx!.work.id ? ctx!.store.get().caseParams : loadCaseParams(t));
  function caseDetail(t: string) {
    const p = caseParamsOf(t);
    const L = layoutFor(t, ctx!.store.get().bom, p);
    const dims = L.shape === 'rect' ? `${L.outer[0]} × ${L.outer[1]} × ${L.outer[2]} mm` : `底座 Ø${L.outer[0]} × ${L.outer[2]} mm`;
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
              change: (e) => setCase(t, { [k]: Number(e.currentTarget.value) }),
            }}
          />
          <NInput type="number" min={lo} max={hi} step={step} defaultValue={p[k]} data-cpn={k} className="font-mono" aria-label={`${label}（数字）`} on={{ change: (e) => setCase(t, { [k]: Number(e.currentTarget.value) }) }} />
          <Muted>mm</Muted>
        </label>
      );
    };
    const exportAs = async (b: HTMLButtonElement, fmt: 'stl' | '3mf') => {
      const out = props.querySelector('#caseOut');
      b.disabled = true;
      if (out) out.textContent = `正在生成外壳 ${fmt.toUpperCase()}…`;
      try {
        const r = await exportCase(t, ctx!.store.get().bom, caseParamsOf(t), fmt);
        download(r.name, r.bytes, fmt === 'stl' ? 'model/stl' : 'model/3mf');
        caseOut = { ok: r.check.ok, text: `${r.name} · ${(r.bytes.length / 1024).toFixed(0)} KB · ${r.check.text}` };
        (window as unknown as { __tbCase: unknown }).__tbCase = { name: r.name, bytes: r.bytes.length, check: r.check };
      } catch (e) {
        caseOut = { ok: false, text: `导出失败：${e}` };
      }
      if (ctx) renderProps();
    };
    return (
      <>
        <Sec>参数化外壳 · 估算，未经真机标定</Sec>
        <Ph>按清单零件尺寸生成</Ph>
        <Kv k="外形" v={dims} />
        <Kv k="内腔 / 需要" v={`${L.inner} / ${L.need} mm`} cls={L.inner < L.need ? 'bad' : ''} />
        <Kv k="最低高度" v={`${L.minHeight} mm`} />
        <div className="case-ps edit-only">
          {slider('height', L.shape === 'rect' ? '高度' : '底座高', 0.5)}
          {slider('wall', '壁厚', 0.1)}
          {L.shape === 'rect' && slider('radius', '圆角', 0.5)}
        </div>
        {L.warnings.length ? (
          L.warnings.map((w, i) => (
            <Res key={i} kind="bad" mk="!">
              {w.text}
            </Res>
          ))
        ) : (
          <Res kind="ok">
            零件都装得下（内腔 {L.inner} mm，需要 {L.need} mm）
          </Res>
        )}
        <details className="oks">
          <summary>开孔与定位（{L.features.bottom.length + L.features.lid.length} 处）</summary>
          {[...L.features.bottom.map((f) => `底：${f}`), ...L.features.lid.map((f) => `盖：${f}`)].map((f, i) => (
            <Res key={i} kind="na">
              {f}
            </Res>
          ))}
        </details>
        <details className="oks">
          <summary>用到的零件尺寸</summary>
          {L.sizes.map((x, i) => (
            <Kv key={i} k={shortName(x.part)} v={`${x.size.map((v) => +v.toFixed(1)).join(' × ')} mm${x.est ? '（估算）' : ''}`} />
          ))}
        </details>
        <Btns>
          <Btn primary data-export="stl" onClick={(e) => void exportAs(e.currentTarget, 'stl')}>
            导出 STL
          </Btn>
          <Btn data-export="3mf" onClick={(e) => void exportAs(e.currentTarget, '3mf')}>
            导出 3MF
          </Btn>
        </Btns>
        <Note id="caseOut">{caseOut ? <span className={caseOut.ok ? 'okc text-ok-ink' : 'bad text-bad-ink'}>{caseOut.text}</span> : '3MF 含底壳、顶盖，已按打印朝向摆好，可直接上传打印服务询价。'}</Note>
      </>
    );
  }
  function setCase(t: string, patch: Partial<CaseParams>) {
    const c = ctx!;
    const p = { ...caseParamsOf(t), ...patch };
    for (const k of Object.keys(PARAM_RANGE) as (keyof CaseParams)[]) p[k] = Math.min(PARAM_RANGE[k][1], Math.max(PARAM_RANGE[k][0], Number(p[k]) || PARAM_RANGE[k][0]));
    saveCaseParams(t, p);
    if (t === c.work.id) c.store.set({ caseParams: p });
    caseOut = null;
    renderProps();
  }

  // ------------------------------------------------------------ 中间：零件平铺
  function renderStage() {
    const c = ctx!;
    const b = bom();
    const lines = lineList(b);
    const sel = selected();
    const plan = c.custom?.plan;
    const card = (l: Line) => (
      <button key={l.partId} type="button" className={cn('pc text-fg', !l.checked && 'off', sel === l.partId && 'on')} data-id={l.partId} aria-pressed={sel === l.partId} title={l.part.name} onClick={() => select(l.partId)}>
        <span className="pc-g">
          <Glyph p={l.part} />
        </span>
        <span className="pc-n">
          {shortName(l.partId)}
          {l.qty > 1 ? ` ×${l.qty}` : ''}
        </span>
        <span className="pc-m font-mono">{l.have ? '我已有' : l.checked ? range(l.part.price.lo * l.qty, l.part.price.hi * l.qty) : '未选'}</span>
        {l.required && <span className="pc-b">必选</span>}
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
      <div className="shop-stage" role="region" aria-label="零件平铺">
        <div className="ss-title">
          <b>{getTemplate(b.template).title}</b>
          <Muted>
            {shortName(b.board)} · 点零件看详情，虚线是没选的建议件{b.template !== c.work.id ? ` · 去实验台时会换到这个作品（固件跟着换）` : ''}
          </Muted>
          {plan?.sub && <Muted className="block" data-sub>{plan.sub}</Muted>}
          {plan && <Muted className="block">第一步只列清单、看参考价，先不用真买：在实验台跑通了再买。</Muted>}
        </div>
        {grp('req', '必选')}
        {grp('sug', '建议')}
        {grp('case', '外壳')}
        {plan && plan.noModel.length > 0 && (
          <section className="ss-g">
            <div className="ss-h">只进清单 · 模拟器里没有</div>
            <div className="ss-grid">
              {plan.noModel.map((n) => (
                <div key={n.id} className="pc text-fg off" data-nomodel={n.id} title="模拟器里没有它：只进清单，不上实验台">
                  <span className="pc-n">{n.name}</span>
                  <span className="pc-m font-mono">{range(n.price[0], n.price[1])}</span>
                  <Conf c="必须上真机" />
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

  // ------------------------------------------------------------ 换开发板：工具条上方弹一张卡
  function boardPicker() {
    const c = ctx!;
    const b = bom();
    const tb = document.getElementById('toolbar')!.getBoundingClientRect();
    const st = c.shell.stage.getBoundingClientRect();
    c.shell.card.show(
      { x: tb.right - st.left - 140, y: tb.top - st.top - 8 },
      <div className="board-pick">
        <Sec>换开发板</Sec>
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
            <TnL>{p.name}</TnL>
            <TnM>{range(p.price.lo, p.price.hi)}</TnM>
          </button>
        ))}
        <Note>换板不改接线：有引脚冲突会在规则检查里列出。</Note>
      </div>,
    );
    // 卡片挂在 3D 台面里，层级在零件平铺（stepLayer）下面：开着时让平铺不接鼠标，否则点不到卡上的板子
    const t = tiles();
    if (t) t.style.pointerEvents = 'none';
  }

  function onTool(id: string) {
    const c = ctx;
    if (!c || c.store.get().step !== 'shop') return;
    if (id.startsWith('tpl:')) {
      const t = id.slice(4);
      if (t === bom().template) return c.shell.toast(`已经是「${getTemplate(t).title}」的清单`);
      commit({ t: 'template', id: t });
      const ls = lineList(bom());
      c.shell.toast(`套用「${getTemplate(t).title}」：必选 ${ls.filter((l) => l.required).length} 件，建议件按默认勾选${t !== c.work.id ? '；去实验台时会换成这个作品的固件' : ''}`);
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
    const t = getTemplate(b.template);
    const first = t.required.find((l) => getPart(l.partId).kind !== 'board' && l.partId !== 'usb-c-cable');
    c.store.set({ selection: { kind: 'part', id: first?.partId ?? b.board } });
  }

  // ------------------------------------------------------------ 摆上实验台（P0-09）
  function place() {
    const c = ctx!;
    const b = bom();
    const p = placement(b);
    const power = p.ext5v ? 'USB 和外接 5 V' : 'USB';
    const skipped = p.skipped.length ? `；${p.skipped.map(partLabel).join('、')}没有默认接线，没摆上台` : '';
    if (b.template !== c.work.id) {
      // 清单换了作品：固件跟着作品走，换到那个作品的工作台（整页重载，DECISIONS 2026-10-16 外壳）
      const target = b.template as WorkId;
      const h = hist();
      saveBom(target, { ops: h.ops.slice(0, h.cur + 1), cur: h.cur });
      savePlaced(target, { parts: p.parts as SceneSpec['parts'] }, p.ext5v);
      location.href = lab(target);
      return;
    }
    const scene: SceneSpec = { ...c.session.scene, parts: p.parts as SceneSpec['parts'] };
    savePlaced(wkey(c.work), scene, p.ext5v);
    // 选板作品的检查点按台面零件生成：零件变了检查点也变，整页重载（会话、进度都按新检查点建）
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
    c.shell.toast(`按清单摆上 ${p.parts.length} 件（${p.parts.map((x) => partLabel(x.type)).join('、') || '只有开发板'}）；供电：${power}${skipped}`);
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
      // 选板作品不给换模板（换了就不是选板结果了，回选板改）
      c.shell.toolbar.setGroups([
        ...(c.custom ? [] : [{ id: 'tpl', tools: PROCURE_TEMPLATES.map((t) => ({ id: `tpl:${t.id}`, label: TPL_SHORT[t.id] ?? t.title })) }]),
        { id: 'board', tools: [{ id: 'board', label: '换开发板…' }] },
      ]);
      if (c.store.get().selection?.kind !== 'part') c.store.set({ selection: null });
      defaultSelection();
      render();
      c.shell.setNext('下一步：实验台 →', 'bench', '', place);
      // 顶栏撤销 / ⌘Z 在采购这一步走清单历史（2026-10-18 走查：以前时间线记了，撤销却是灰的）
      actions.shopUndo = (d) => {
        const h = hist();
        const i = h.cur + d;
        if (i < 0 || i >= h.ops.length) return;
        const op = h.ops[d < 0 ? h.cur : i];
        onSeek(i);
        c.shell.toast(`${d < 0 ? '已撤销' : '已重做'}：${opLabel(op).label}`);
      };
      unsubs = [
        c.store.subscribe(() => render(), ['selection']),
        // 清单变了（含时间线点回去）：选中的件不在新清单里就换成默认选中，再画
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
      // 采购页的选中（清单里的零件 id）对实验台没有意义
      if (ctx?.store.get().selection?.kind === 'part') ctx.store.set({ selection: null });
      actions.shopUndo = undefined;
      ctx = null;
    },
  };
}
