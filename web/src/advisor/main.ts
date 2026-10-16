import { PARTS, TEMPLATES, type Cap, type Template } from './data';
import { capName, recommend, type Confidence, type Need, type Plan } from './engine';
import { themeToggle } from '../theme';

document.querySelector('.top nav')!.after(themeToggle());

const $ = (id: string) => document.getElementById(id)!;
const SELECTABLE_CAPS: Cap[] = ['wifi', 'ble', 'bt_classic', 'thread', 'zigbee', 'usb_otg', 'camera', 'audio_in', 'audio_out', 'psram', 'display_rgb', 'touch', 'dac'];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let current: Template = TEMPLATES[0];
const need: Need = { caps: [], nice: [], parts: [], battery: false };

function applyTemplate(t: Template) {
  current = t;
  need.caps = [...t.needCaps.filter((c) => c !== 'low_power')];
  need.nice = [...(t.niceCaps ?? [])];
  need.parts = [...t.parts.filter((p) => p !== 'battery')];
  need.battery = t.needCaps.includes('low_power') || t.parts.includes('battery');
  need.duty = t.duty;
  render();
}

function renderControls() {
  $('templates').innerHTML = TEMPLATES.map(
    (t) => `<button class="tpl ${t.id === current.id ? 'on' : ''}" data-t="${t.id}"><b>${esc(t.title)}</b><span>${esc(t.blurb)}</span></button>`,
  ).join('');
  $('caps').innerHTML = SELECTABLE_CAPS.map((c) => `<span class="chip ${need.caps.includes(c) ? 'on' : ''}" data-cap="${c}">${capName(c)}</span>`).join('');
  $('parts').innerHTML = Object.values(PARTS)
    .filter((p) => p.id !== 'battery')
    .map((p) => `<span class="chip ${need.parts.includes(p.id) ? 'on' : ''}" data-part="${p.id}">${esc(p.name)}</span>`)
    .join('');
  ($('battery') as HTMLInputElement).checked = need.battery;
}

const CONF_CLASS: Record<Confidence, string> = { 仿真验证: 'c1', 行为模拟: 'c2', 估算: 'c3', 必须上真机: 'c4' };
const conf = (c: Confidence) => `<span class="conf ${CONF_CLASS[c]}">${c}</span>`;
const yuan = (p: [number, number]) => (p[0] === p[1] ? `¥${p[0]}` : `¥${p[0]}–${p[1]}`);

function planCard(p: Plan, best: boolean) {
  const pins = p.pins.length
    ? `<table><tr><th>接什么</th><th>引脚</th></tr>${p.pins
        .map((a) => `<tr><td>${esc(a.label)}${a.note ? `<div class="meta">${esc(a.note)}</div>` : ''}</td><td>${a.pins.map((x) => `<span class="pin">${p.board.labels?.[x] ? p.board.labels[x] + ' · ' : ''}GPIO${x}</span>`).join('') || '—'}</td></tr>`)
        .join('')}</table>`
    : '<p class="meta">没有需要接线的配件。</p>';
  const bom = `<table><tr><th>物品</th><th class="num">参考价</th></tr>${p.bom.map((b) => `<tr><td>${esc(b.name)}</td><td class="num">${yuan(b.price)}</td></tr>`).join('')}<tr><th>合计</th><th class="num">${yuan(p.total)}</th></tr></table>`;
  const power = p.power
    ? `<h4>电池续航（1000mAh 锂电） ${conf(p.power.confidence)}</h4><div class="power"><span class="big">${p.power.days >= 365 ? (p.power.days / 365).toFixed(1) + ' 年' : p.power.days.toFixed(0) + ' 天'}</span><span class="meta">平均 ${p.power.avgMA < 1 ? (p.power.avgMA * 1000).toFixed(0) + 'µA' : p.power.avgMA.toFixed(2) + 'mA'} · ${esc(p.power.breakdown)}</span></div>`
    : '';
  const sim = p.simCoverage.length
    ? `<h4>买之前能验证到哪一步</h4><table>${p.simCoverage.map((s) => `<tr><td>${esc(s.part)}</td><td>${conf(s.level)}</td></tr>`).join('')}<tr><td>芯片 ${esc(p.chip.name)} 本身</td><td>${conf(p.chip.simulated === 'full' ? '仿真验证' : p.chip.simulated === 'partial' ? '行为模拟' : '必须上真机')}</td></tr></table>`
    : '';
  const tries = current.examples.length && p.chip.simulated === 'full'
    ? current.examples.map((e) => `<a class="try" href="./index.html?example=${e}">▶ 在试板里跑「${e}」示例</a>`).join('')
    : '';
  if (!best) {
    return `<div class="card"><div class="head"><h3>${esc(p.board.name)}</h3><span class="price">${yuan(p.board.priceCNY)}</span></div>
      <div class="meta">${esc(p.chip.name)} · ${esc(p.chip.core)} ${p.chip.mhz}MHz · ${p.board.flashMB}MB flash${p.board.psramMB ? ` · ${p.board.psramMB}MB PSRAM` : ''} · ${esc(p.board.size)}</div>
      <ul class="list ok">${p.reasons.slice(0, 2).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <ul class="list warn">${p.warnings.slice(0, 2).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      ${p.power ? `<div class="meta">电池续航约 ${p.power.days >= 365 ? (p.power.days / 365).toFixed(1) + ' 年' : p.power.days.toFixed(0) + ' 天'}（估算）</div>` : ''}</div>`;
  }
  return `<div class="card best">
    <div class="head"><span class="badge best">首选</span><h3>${esc(p.board.name)}</h3><span class="badge">${esc(p.board.maker)}</span><span class="price">整套 ${yuan(p.total)}</span></div>
    <div class="meta">${esc(p.chip.name)} · ${esc(p.chip.core)} ${p.chip.mhz}MHz · ${p.chip.sramKB}KB SRAM · ${p.board.flashMB}MB flash${p.board.psramMB ? ` · ${p.board.psramMB}MB PSRAM` : ''} · ${esc(p.board.size)}</div>
    <div class="grid2">
      <div><h4>为什么选它</h4><ul class="list ok">${p.reasons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>满足全部需求，价格合适</li>'}</ul>
        ${p.warnings.length ? `<h4>要注意</h4><ul class="list warn">${p.warnings.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${current.risks.length ? `<h4>这类项目常见的坑</h4><ul class="list warn">${current.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${p.pinProblems.length ? `<h4>接线问题</h4><ul class="list err">${p.pinProblems.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${power}
      </div>
      <div><h4>引脚怎么接 ${conf('估算')}</h4>${pins}<h4>物料清单</h4>${bom}${sim}</div>
    </div>
    ${tries}
  </div>`;
}

function renderResult() {
  const { plans, rejected } = recommend(need);
  if (!plans.length) {
    $('result').innerHTML = `<div class="empty">没有一块板子同时满足这些需求。${rejected.length ? '<br/>' + rejected.slice(0, 4).map((r) => `${esc(r.board.name)}：${esc(r.why)}`).join('<br/>') : ''}</div>`;
    return;
  }
  const [best, ...rest] = plans;
  $('result').innerHTML =
    planCard(best, true) +
    (rest.length ? `<h2 style="font-size:15px;margin:22px 0 10px">其他可选</h2><div class="alt">${rest.slice(0, 3).map((p) => planCard(p, false)).join('')}</div>` : '') +
    (rejected.length
      ? `<details><summary>不合适的 ${rejected.length} 块板子，以及原因</summary><ul class="list err">${rejected.map((r) => `<li><b>${esc(r.board.name)}</b>：${esc(r.why)}</li>`).join('')}</ul></details>`
      : '');
}

function render() {
  renderControls();
  renderResult();
  try {
    history.replaceState(null, '', `?t=${current.id}`);
  } catch {
    /* 预览环境可能不允许改地址 */
  }
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-t],[data-cap],[data-part]') as HTMLElement | null;
  if (!el) return;
  if (el.dataset.t) applyTemplate(TEMPLATES.find((t) => t.id === el.dataset.t)!);
  else if (el.dataset.cap) {
    const c = el.dataset.cap as Cap;
    need.caps = need.caps.includes(c) ? need.caps.filter((x) => x !== c) : [...need.caps, c];
    render();
  } else if (el.dataset.part) {
    const p = el.dataset.part;
    need.parts = need.parts.includes(p) ? need.parts.filter((x) => x !== p) : [...need.parts, p];
    render();
  }
});
$('battery').addEventListener('change', (e) => {
  need.battery = (e.target as HTMLInputElement).checked;
  need.duty = need.battery ? (current.duty ?? { wakePerHour: 6, activeSec: 3, wifi: need.caps.includes('wifi') }) : current.duty;
  render();
});

const start = TEMPLATES.find((t) => t.id === new URLSearchParams(location.search).get('t')) ?? TEMPLATES[1];
applyTemplate(start);
