// ① 采购（P0-07）+ 买完摆上实验台（P0-09）。
// 左树：清单分组（必选 / 建议 / 外壳），合计参考价；中间：零件平铺（未选的建议件虚线）；
// 右栏：规则检查 + 选中零件详情；工具条：切模版、换开发板；时间线：清单变更，点回去 = 重放。
import type { SceneSpec } from '../../board3d';
import { BOARDS, CHECKED_AT, PARTS, PART_BY_ID, getPart, type Kind, type Part } from '../../catalog/parts';
import { PROCURE_TEMPLATES, bomTotal, getTemplate } from '../../catalog/templates';
import { evaluate, type Finding } from '../../catalog/rules';
import { initialHistory, opLabel, placement, push, replay, ruleInput, shortName, validHistory, type Bom, type BomHistory, type BomOp } from '../bom';
import type { StepCtx, StepImpl, WorkId } from '../types';
import { partLabel } from '../wiring';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
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
    /* 存的东西坏了：回到模版默认 */
  }
  return initialHistory(PROCURE_TEMPLATES.some((t) => t.id === work) ? work : 'blank');
}
export function saveBom(work: string, h: BomHistory) {
  try {
    localStorage.setItem(BOM_KEY(work), JSON.stringify(h));
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
  passive: '阻容 / 小件',
  module: '模块',
  proto: '面包板 / 原型',
  enclosure: '外壳',
};
const SIM: Record<Part['sim']['level'], string> = {
  verified: '模拟器验证过：有验收固件跑过这个模型',
  estimated: '行为近似：只进估算，读数不一定准',
  none: '模拟器里没有它：只算进清单和规则',
};
const TPL_SHORT: Record<string, string> = { weather: '气象站', spin: '小黄', lens: '透镜小人', blank: '空白' };

/** 零件平铺用的示意小图（不是外观模型，只帮人认出是哪一类） */
function glyph(p: Part): string {
  const svg = (body: string) => `<svg viewBox="0 0 64 40" aria-hidden="true">${body}</svg>`;
  const pins = (x: number, y: number, n: number) => Array.from({ length: n }, (_, i) => `<rect x="${x + i * 5}" y="${y}" width="2" height="5" fill="#C9A227"/>`).join('');
  if (p.id === 'gc9a01') return svg(`<rect x="14" y="2" width="36" height="36" rx="4" fill="#1d3557"/><circle cx="32" cy="20" r="14" fill="#0b0f14"/><circle cx="32" cy="20" r="11" fill="#2b4a6f"/>`);
  if (p.id.startsWith('buzzer')) return svg(`<rect x="18" y="6" width="28" height="28" rx="3" fill="${p.id === 'buzzer-module' ? '#2f5f9e' : 'none'}"/><circle cx="32" cy="20" r="11" fill="#1f1f1f"/><circle cx="32" cy="20" r="3" fill="#555"/>`);
  if (p.id === 'led-kit') return svg(`${['#e74c3c', '#f1c40f', '#2ecc71', '#3498db'].map((col, i) => `<path d="M${10 + i * 13} 22 a5 5 0 0 1 10 0 v6 h-10 z" fill="${col}"/><rect x="${12 + i * 13}" y="28" width="1.5" height="9" fill="#aaa"/><rect x="${17 + i * 13}" y="28" width="1.5" height="7" fill="#aaa"/>`).join('')}`);
  if (p.id.startsWith('cap-')) return svg(`<rect x="24" y="4" width="16" height="26" rx="3" fill="#1f3b73"/><rect x="34" y="4" width="4" height="26" fill="#9fb3d9"/><rect x="28" y="30" width="2" height="8" fill="#aaa"/><rect x="34" y="30" width="2" height="6" fill="#aaa"/>`);
  if (p.id === 'lens-dome') return svg(`<ellipse cx="32" cy="24" rx="20" ry="8" fill="#dfeefb" stroke="#9cc3e6"/><path d="M12 24 Q32 0 52 24" fill="#eef6fd" stroke="#9cc3e6"/>`);
  switch (p.kind) {
    case 'board':
      return svg(`<rect x="4" y="8" width="56" height="24" rx="2" fill="#1f2328"/><rect x="10" y="12" width="20" height="16" rx="1" fill="#b8bec6"/><rect x="54" y="16" width="8" height="8" rx="1" fill="#9aa0a6"/>${pins(6, 4, 11)}${pins(6, 31, 11)}`);
    case 'sensor':
      return svg(`<rect x="16" y="6" width="32" height="26" rx="2" fill="${p.id === 'bme280' ? '#6b3fa0' : '#2f6f4f'}"/><rect x="27" y="14" width="10" height="10" fill="#cfd3d8"/><circle cx="20" cy="10" r="2" fill="#fff"/>${pins(22, 32, 4)}`);
    case 'display':
      return svg(`<rect x="10" y="4" width="44" height="30" rx="2" fill="#1d4f91"/><rect x="14" y="10" width="36" height="20" fill="#0b0f14"/><rect x="18" y="14" width="18" height="3" fill="#7fc8ff"/>${pins(24, 34, 4)}`);
    case 'actuator':
      return svg(`<rect x="12" y="12" width="34" height="20" rx="2" fill="#2563c9"/><rect x="6" y="18" width="46" height="5" rx="1" fill="#2563c9"/><circle cx="22" cy="10" r="5" fill="#f4f4f4" stroke="#bbb"/><rect x="18" y="8" width="20" height="4" rx="2" fill="#f4f4f4" stroke="#bbb"/><path d="M46 26 q8 0 12 8" stroke="#c0392b" stroke-width="2" fill="none"/>`);
    case 'power':
      return svg(`<rect x="8" y="8" width="24" height="24" rx="3" fill="#2b2b2b"/><path d="M32 20 C44 20 44 30 56 30" stroke="#2b2b2b" stroke-width="3" fill="none"/><rect x="52" y="26" width="8" height="8" rx="1" fill="#555"/>`);
    case 'cable':
      return svg(`<path d="M8 28 C20 4 44 36 56 12" stroke="${p.id.startsWith('dupont') ? '#e67e22' : '#333'}" stroke-width="3" fill="none"/><rect x="2" y="24" width="10" height="8" rx="1" fill="#222"/><rect x="52" y="8" width="10" height="8" rx="1" fill="#222"/>`);
    case 'proto':
      return svg(`<rect x="4" y="6" width="56" height="28" rx="2" fill="#f2f2ee" stroke="#d6d6cf"/><rect x="4" y="18" width="56" height="3" fill="#e2e2da"/>${Array.from({ length: 40 }, (_, i) => `<rect x="${8 + (i % 10) * 5}" y="${(i < 20 ? 9 : 23) + Math.floor((i % 20) / 10) * 5}" width="2" height="2" fill="#9a9a90"/>`).join('')}<rect x="6" y="7" width="52" height="1" fill="#e74c3c"/><rect x="6" y="32" width="52" height="1" fill="#2e86de"/>`);
    case 'audio':
      return svg(`<circle cx="32" cy="20" r="13" fill="#1f1f1f"/><circle cx="32" cy="20" r="4" fill="#444"/>`);
    case 'enclosure':
      return svg(`<path d="M14 14 L32 6 L50 14 L50 30 L32 38 L14 30 Z" fill="#f5f2ea" stroke="#c9c2b0"/><path d="M14 14 L32 22 L50 14 M32 22 L32 38" stroke="#c9c2b0" fill="none"/>`);
    case 'passive':
      return svg(`<path d="M6 20 H18 l3 -6 l5 12 l5 -12 l5 12 l5 -12 l3 6 H58" stroke="#8a6d3b" stroke-width="2" fill="none"/>`);
    default:
      return svg(`<rect x="14" y="8" width="36" height="24" rx="2" fill="#3d6b5a"/><rect x="26" y="14" width="12" height="12" fill="#1f1f1f"/>${pins(22, 32, 4)}`);
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
}

function linesOf(b: Bom): Line[] {
  const t = getTemplate(b.template);
  const picked = (id: string) => b.picks.find((p) => p.partId === id);
  const out: Line[] = [];
  const seen = new Set<string>();
  const add = (partId: string, qty: number, why: string, required: boolean) => {
    if (seen.has(partId)) return;
    seen.add(partId);
    const part = getPart(partId);
    const p = picked(partId);
    const group = part.kind === 'enclosure' ? 'case' : required ? 'req' : 'sug';
    out.push({ partId, part, qty: p?.qty ?? qty, why, group, required, checked: !!p });
  };
  // 开发板一行永远在最上面：模版里的板子换过就显示换后的
  const boardLine = [...t.required, ...t.suggested].find((l) => getPart(l.partId).kind === 'board');
  add(b.board, 1, b.board === t.board ? (boardLine?.why ?? '跑固件') : `换过的开发板（模版是 ${shortName(t.board)}）`, true);
  // 换成自带同款器件的板（微雪圆屏板自带 GC9A01）：模版的必选件降为可去掉的建议件，R29 说为什么
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

export function shopStep(): StepImpl {
  let ctx: StepCtx | null = null;
  let layer: HTMLElement | null = null;
  let unsubs: (() => void)[] = [];
  let hooked = false;
  const openGroups: Record<string, boolean> = { req: true, sug: true, case: true, ok: false };

  const hist = () => ctx!.store.get().bom;
  const bom = () => replay(hist());
  const selected = () => {
    const s = ctx!.store.get().selection;
    return s?.kind === 'part' ? s.id : null;
  };
  const select = (id: string) => ctx!.store.set({ selection: { kind: 'part', id } });

  function commit(op: BomOp) {
    const c = ctx!;
    const h = push(hist(), op);
    if (h === hist()) return false;
    c.store.set({ bom: h });
    saveBom(c.work.id, h);
    return true;
  }

  function toggle(l: Line) {
    const c = ctx!;
    if (l.required) {
      // 必选不能去：勾选框保持勾上，并说清楚为什么
      c.shell.toast(l.partId === bom().board ? '开发板不能去掉，只能换：用底部的「换开发板」' : `必选件不能去掉：${shortName(l.partId)}（${l.why}）`);
      if (selected() === l.partId) render();
      else select(l.partId);
      return;
    }
    // 模版必选、但新板子上已经焊了的件：日志里的普通 remove 会被"必选不能去"拦下，按 R29 的一键去掉记
    const builtin = !!getPart(bom().board).board?.builtin?.some((x) => x.partId === l.partId);
    if (l.checked && builtin) commit({ t: 'fix', fix: { action: 'remove', partId: l.partId }, rule: 'R29' });
    else commit(l.checked ? { t: 'remove', partId: l.partId } : { t: 'add', partId: l.partId });
    select(l.partId);
  }

  // ------------------------------------------------------------ 构建树（清单）
  function renderTree() {
    const c = ctx!;
    const b = bom();
    const lines = linesOf(b);
    const sel = selected();
    const total = bomTotal(b.picks, b.board);
    const row = (l: Line) => {
      const lo = l.part.price.lo * l.qty;
      const hi = l.part.price.hi * l.qty;
      return `<div class="bn ${sel === l.partId ? 'on' : ''} ${l.checked ? '' : 'off'}" data-id="${esc(l.partId)}" role="treeitem" aria-selected="${sel === l.partId}">
<input type="checkbox" ${l.checked ? 'checked' : ''} class="${l.required ? 'locked' : ''}" aria-label="${l.required ? '必选，不能去掉' : l.checked ? '去掉' : '加上'} ${esc(l.part.name)}" title="${l.required ? '必选，不能去掉' : ''}" />
<button type="button" class="bn-l" data-id="${esc(l.partId)}">${esc(shortName(l.partId))}${l.qty > 1 ? ` <span class="mono muted">×${l.qty}</span>` : ''}</button>
<span class="tn-m">${range(lo, hi)}</span></div>`;
    };
    const group = (key: Line['group'], title: string) => {
      const ls = lines.filter((l) => l.group === key);
      if (!ls.length) return '';
      const on = ls.filter((l) => l.checked).length;
      return `<details class="tg" data-g="${key}" ${openGroups[key] ? 'open' : ''}><summary><span>${title}</span><span class="tn-m">${on}/${ls.length}</span></summary><div role="group">${ls.map(row).join('')}</div></details>`;
    };
    const inBom = new Set(b.picks.map((p) => p.partId));
    const kinds = Object.keys(KIND) as Kind[];
    const opts = kinds
      .filter((k) => k !== 'board')
      .map((k) => {
        const ps = PARTS.filter((p) => p.kind === k && !inBom.has(p.id));
        return ps.length ? `<optgroup label="${KIND[k]}">${ps.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>` : '';
      })
      .join('');
    c.shell.tree.innerHTML = `<div role="tree" aria-label="采购清单">
${group('req', '必选')}
${group('sug', '建议')}
${group('case', '外壳')}
</div>
<label class="addpart edit-only"><span class="muted">从元件库加</span><select aria-label="从元件库加零件"><option value="">选一个零件…</option>${opts}</select></label>
<div class="bom-total"><div class="bt-row"><span>合计参考价</span><b class="mono">${range(total.lo, total.hi)}</b></div><div class="muted">${total.lines.length} 种 · 核价 ${CHECKED_AT} · 不含运费 · 以店铺实际为准</div></div>`;
    c.shell.tree.querySelectorAll<HTMLDivElement>('.bn').forEach((el) => {
      const l = lines.find((x) => x.partId === el.dataset.id)!;
      el.querySelector<HTMLButtonElement>('.bn-l')!.onclick = () => select(l.partId);
      const cb = el.querySelector<HTMLInputElement>('input')!;
      cb.onclick = (e) => {
        if (l.required) e.preventDefault();
        toggle(l);
      };
    });
    c.shell.tree.querySelectorAll<HTMLDetailsElement>('details.tg').forEach((d) => d.addEventListener('toggle', () => (openGroups[d.dataset.g!] = d.open)));
    const sel2 = c.shell.tree.querySelector<HTMLSelectElement>('.addpart select')!;
    sel2.onchange = () => {
      const id = sel2.value;
      if (!id) return;
      commit({ t: 'add', partId: id });
      select(id);
    };
  }

  // ------------------------------------------------------------ 右栏：规则检查 + 零件详情
  const kv = (k: string, v: string, cls = '') => `<div class="kv"><span class="k">${k}</span><span class="v mono ${cls}">${v}</span></div>`;
  const kvT = (k: string, v: string) => `<div class="kv col"><span class="k">${k}</span><span class="v txt">${v}</span></div>`;
  const sec = (t: string) => `<div class="sec">${t}</div>`;

  /** 开发板的规格与板载占用（P1-12）：换板时一眼看出差在哪 */
  function boardSpec(part: Part) {
    const b = part.board!;
    const USB = { native: '芯片原生 USB', uart: 'USB 转串口芯片', both: '原生 USB + USB 转串口（两个口）' } as const;
    const psram = b.psram === 'none' || b.psramMB === 0 ? '无' : b.psramMB === null || b.psram === null ? '待核' : `${b.psramMB} MB（${b.psram === 'octal' ? '八线，占 GPIO33–37' : '四线'}）`;
    const gpios = (part.pins ?? []).filter((p) => p.gpio !== undefined).length;
    const occ = b.onboard.map((o) => `GPIO${o.gpio} ${esc(o.what)}`).join('<br>');
    const todo = part.todo.filter((t) => t.startsWith('board') || t.startsWith('pins')).map((t) => esc(t)).join('<br>');
    return `${sec('板子')}${b.version ? kv('版本', esc(b.version)) : ''}${kv('flash', b.flashMB === null ? '待核' : `${b.flashMB} MB`)}${kv('PSRAM', psram)}${kv('USB', b.usb ? USB[b.usb] : '待核')}${kv('引出 GPIO', part.pins ? String(gpios) : '待核')}
${occ ? kvT('板载占用', occ) : ''}${todo ? kvT('待核', todo) : ''}
<div class="btns">${b.urls.map((u, i) => `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener noreferrer">资料 ${i + 1} ↗</a>`).join('')}</div>`;
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
    const finding = (f: Finding, i: number) => `<div class="rf ${f.level}"><div class="rf-h"><span class="mk">${f.level === 'block' ? '✗' : '!'}</span><span class="rf-t">${f.level === 'block' ? '阻断' : '提醒'} · ${esc(f.title)}</span><span class="mono muted">${f.id}</span></div>
<div class="rf-d">${esc(f.detail)}</div><div class="rf-s">可信度：${esc(f.confidence)} · ${esc(f.source)}</div>${f.fix && PART_BY_ID[f.fix.partId] ? `<button type="button" class="btn primary edit-only" data-fix="${i}">${esc(fixLabel(f))}</button>` : ''}</div>`;
    const rules = `${sec('规则检查')}${
      probs.length
        ? `<div class="verdict-line ${probs.some((f) => f.level === 'block') ? 'bad' : 'warn'}">${probs.length} 条提醒${probs.some((f) => f.level === 'block') ? `，其中 ${probs.filter((f) => f.level === 'block').length} 条会让作品跑不起来` : ''}</div>${probs.map(finding).join('')}`
        : `<div class="verdict-line ok">✓ 清单没问题</div>`
    }<details class="oks" ${openGroups.ok ? 'open' : ''}><summary>${oks.length} 条规则通过</summary>${oks.map((f) => `<div class="res ok"><span class="mk">✓</span><span><span class="mono">${f.id}</span> ${esc(f.title)}</span></div>`).join('')}</details>`;

    const id = selected();
    const part = id ? PART_BY_ID[id] : undefined;
    let detail = '';
    if (part) {
      const l = linesOf(b).find((x) => x.partId === part.id);
      const qty = l?.qty ?? 1;
      const v = part.voltage;
      const cur = part.currentMa;
      const pr = part.price;
      detail = `${sec('零件')}<div class="ph">${esc(part.name)}</div>
${kvT('型号', esc(part.model))}${kv('类别', KIND[part.kind])}
${v.supply ? kv('供电', v.supply[0] === v.supply[1] ? `${v.supply[0]} V` : `${v.supply[0]}–${v.supply[1]} V`) : ''}${v.logic !== null ? kv('逻辑电平', `${v.logic} V`) : ''}
${cur.typ !== null || cur.peak !== null ? kv(`电流${cur.est ? '（估算）' : ''}`, `${cur.typ ?? '—'} / 峰值 ${cur.peak ?? '—'} mA`) : ''}
${part.i2cAddr ? kv('I2C 地址', `${hex(part.i2cAddr.default)}${part.i2cAddr.alt.length ? ' / ' + part.i2cAddr.alt.map(hex).join(' / ') : ''}`) : ''}
${part.sizeMm ? kv('尺寸', `${part.sizeMm[0]} × ${part.sizeMm[1]}${part.sizeMm[2] !== null ? ' × ' + part.sizeMm[2] : ''} mm`) : ''}
${part.board ? boardSpec(part) : ''}
${sec('参考价')}${kv(`参考价${qty > 1 ? ` ×${qty}` : ''}`, range(pr.lo * qty, pr.hi * qty))}${kv('核价日期', esc(pr.checkedAt))}
<p class="note">参考价，${esc(pr.source)}${pr.verified ? '' : '。'}以店铺实际为准。</p>
${sec('模拟程度')}<div class="field sim-${part.sim.level}">${SIM[part.sim.level]}${part.sim.model ? `<div class="muted">${esc(part.sim.model)}</div>` : ''}</div>
${sec('为什么需要')}<p class="why">${esc(l?.why ?? '不在当前清单里')}${l ? (l.required ? ' <span class="tag">必选</span>' : l.checked ? '' : ' <span class="tag off">未选</span>') : ''}</p>
${part.note ? `<p class="note">${esc(part.note)}</p>` : ''}
${sec('去店铺搜')}<div class="btns"><a class="btn" href="${esc(part.searchUrl.taobao)}" target="_blank" rel="noopener noreferrer">淘宝搜索 ↗</a><a class="btn" href="${esc(part.searchUrl.szlcsc)}" target="_blank" rel="noopener noreferrer">立创商城搜索 ↗</a></div>
<p class="note">搜索词：<span class="mono">${esc(part.keywords)}</span>。只是搜索页，不是推荐某家店。</p>`;
    } else detail = `${sec('零件')}<div class="tree-empty">点左边清单或中间的零件看详情</div>`;
    c.shell.props.innerHTML = rules + detail;
    c.shell.props.querySelectorAll<HTMLButtonElement>('[data-fix]').forEach((btn) => {
      btn.onclick = () => {
        const f = probs[Number(btn.dataset.fix)];
        if (commit({ t: 'fix', fix: f.fix!, rule: f.id })) {
          c.shell.toast(`${fixLabel(f).replace('一键', '已')}（${f.id}）`);
          select(f.fix!.partId);
        }
      };
    });
    c.shell.props.querySelector<HTMLDetailsElement>('details.oks')?.addEventListener('toggle', (e) => (openGroups.ok = (e.target as HTMLDetailsElement).open));
    // 结论：n 条提醒 / 清单没问题
    const nb = probs.filter((f) => f.level === 'block').length;
    c.shell.setVerdict(probs.length ? `${probs.length} 条提醒` : '清单没问题', nb ? 'bad' : probs.length ? 'warn' : 'ok');
  }

  // ------------------------------------------------------------ 中间：零件平铺
  function renderStage() {
    const b = bom();
    const lines = linesOf(b);
    const sel = selected();
    const card = (l: Line) => `<button type="button" class="pc ${l.checked ? '' : 'off'} ${sel === l.partId ? 'on' : ''}" data-id="${esc(l.partId)}" aria-pressed="${sel === l.partId}" title="${esc(l.part.name)}">
<span class="pc-g">${glyph(l.part)}</span><span class="pc-n">${esc(shortName(l.partId))}${l.qty > 1 ? ` ×${l.qty}` : ''}</span><span class="pc-m mono">${l.checked ? range(l.part.price.lo * l.qty, l.part.price.hi * l.qty) : '未选'}</span>${l.required ? '<span class="pc-b">必选</span>' : ''}</button>`;
    const grp = (key: Line['group'], title: string) => {
      const ls = lines.filter((l) => l.group === key);
      return ls.length ? `<section class="ss-g"><div class="ss-h">${title}</div><div class="ss-grid">${ls.map(card).join('')}</div></section>` : '';
    };
    layer!.innerHTML = `<div class="shop-stage" aria-label="零件平铺"><div class="ss-title"><b>${esc(getTemplate(b.template).title)}</b><span class="muted">${esc(shortName(b.board))} · 点零件看详情，虚线是没选的建议件${b.template !== ctx!.work.id ? ` · 摆上实验台会换到这个作品（固件跟着换）` : ''}</span></div>${grp('req', '必选')}${grp('sug', '建议')}${grp('case', '外壳')}</div>`;
    layer!.querySelectorAll<HTMLButtonElement>('.pc').forEach((el) => (el.onclick = () => select(el.dataset.id!)));
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
    const box = document.createElement('div');
    box.className = 'board-pick';
    box.innerHTML = `<div class="sec">换开发板</div>${BOARDS.map((p) => `<button type="button" class="tn ${p.id === b.board ? 'on' : ''}" data-id="${p.id}"><span class="tn-l">${esc(p.name)}</span><span class="tn-m">${range(p.price.lo, p.price.hi)}</span></button>`).join('')}<p class="note">换板不改接线：引脚冲突由规则检查当场说。</p>`;
    box.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach(
      (el) =>
        (el.onclick = () => {
          c.shell.card.hide();
          if (commit({ t: 'board', partId: el.dataset.id! })) select(el.dataset.id!);
        }),
    );
    const tb = document.getElementById('toolbar')!.getBoundingClientRect();
    const st = c.shell.stage.getBoundingClientRect();
    c.shell.card.show({ x: tb.right - st.left - 140, y: tb.top - st.top - 8 }, box);
    // 卡片挂在 3D 台面里，层级在零件平铺（stepLayer）下面：开着时让平铺不接鼠标，否则点不到卡上的板子
    const tiles = layer?.querySelector<HTMLElement>('.shop-stage');
    if (tiles) tiles.style.pointerEvents = 'none';
  }

  function onTool(id: string) {
    const c = ctx;
    if (!c || c.store.get().step !== 'shop') return;
    if (id.startsWith('tpl:')) {
      const t = id.slice(4);
      if (t === bom().template) return c.shell.toast(`已经是「${getTemplate(t).title}」的清单`);
      commit({ t: 'template', id: t });
      const ls = linesOf(bom());
      c.shell.toast(`套用「${getTemplate(t).title}」：必选 ${ls.filter((l) => l.required).length} 件，建议件按默认勾选${t !== c.work.id ? '；摆上实验台时会换成这个作品的固件' : ''}`);
    } else if (id === 'board') boardPicker();
  }

  function onSeek(i: number) {
    const c = ctx;
    if (!c || c.store.get().step !== 'shop') return;
    const h = { ...hist(), cur: i };
    c.store.set({ bom: h });
    saveBom(c.work.id, h);
  }

  function defaultSelection() {
    const c = ctx!;
    const id = selected();
    const b = bom();
    if (id && linesOf(b).some((l) => l.partId === id)) return;
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
    const power = p.ext5v ? 'USB + 外接 5 V' : 'USB';
    const skipped = p.skipped.length ? `；${p.skipped.map(partLabel).join('、')}没有默认接线，没摆` : '';
    if (b.template !== c.work.id) {
      // 清单换了作品：固件跟着作品走，换到那个作品的工作台（整页重载，DECISIONS 2026-10-16 外壳）
      const target = b.template as WorkId;
      const h = hist();
      saveBom(target, { ops: h.ops.slice(0, h.cur + 1), cur: h.cur });
      savePlaced(target, { parts: p.parts as SceneSpec['parts'] }, p.ext5v);
      location.href = `./app.html?work=${target}#bench`;
      return;
    }
    const scene: SceneSpec = { ...c.session.scene, parts: p.parts as SceneSpec['parts'] };
    savePlaced(c.work.id, scene, p.ext5v);
    c.session.applyScene(scene, { ext5v: p.ext5v });
    location.hash = 'bench';
    c.store.set({ selection: { kind: 'power', id: 'usb' } });
    c.shell.toast(`按清单摆上 ${p.parts.length} 件（${p.parts.map((x) => partLabel(x.type)).join('、') || '只有开发板'}）；供电：${power}${skipped}`);
  }

  return {
    mount(el, c) {
      ctx = c;
      layer = el;
      if (!hooked) {
        hooked = true;
        c.shell.toolbar.onTool(onTool);
        c.shell.timeline.onSeek((i) => onSeek(i));
        c.shell.card.onHide(() => layer?.querySelector<HTMLElement>('.shop-stage')?.style.removeProperty('pointer-events'));
      }
      c.shell.toolbar.setGroups([
        { id: 'tpl', tools: PROCURE_TEMPLATES.map((t) => ({ id: `tpl:${t.id}`, label: TPL_SHORT[t.id] ?? t.title })) },
        { id: 'board', tools: [{ id: 'board', label: '换开发板…' }] },
      ]);
      if (c.store.get().selection?.kind !== 'part') c.store.set({ selection: null });
      defaultSelection();
      render();
      c.shell.setNext('摆上实验台 →', 'bench', '', place);
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
      ctx = null;
      layer = null;
    },
  };
}

