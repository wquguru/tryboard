// 作品首页（DESIGN §1、§5）：三张作品卡。卡片先放示意图；点「看真实固件跑」换成模拟器驱动的成品画面，
// 同一时间只跑一份（每份是一个 wasm worker），看不见就暂停。
import { LiveSim } from './live';
import { themeToggle } from './theme';

document.querySelector('.pg-head nav')!.after(themeToggle());
import { createShowcase, type ShowKind } from './views/showcase';
import { createProductView } from './views/product';
import { createLensProduct, createSpinProduct } from './views/lcdproducts';
import { PROCURE_TEMPLATES, bomTotal, getTemplate, templatePicks } from './catalog/templates';
import { CHECKED_AT, getPart } from './catalog/parts';
import { WORKS } from './app/works';
import { TEMPLATES } from './views/templates';
import { emptyFrame, type LiveFrame } from './views/common';
import type { LiveOptions } from './live';

// 作品卡自动出现：采购模版里有、HTML 里还没写死卡片的作品（P2-09 起的新作品），按这份说明生成。
// 示意图用成品的 2D 视图喂一帧演示数据；「看真实固件跑」换成真实固件驱动的同一个视图。
type LiveCfg = Pick<LiveOptions, 'i2c' | 'lcd' | 'encoder' | 'sonar'>;
const EXTRA: Record<string, { desc: string; live: LiveCfg; demo: Partial<LiveFrame>; script?: (sim: LiveSim, t: number) => void }> = {
  lamp: {
    desc: '转旋钮调亮度，按一下改成换颜色；8 颗 WS2812 藏在乳白灯罩里。',
    live: { i2c: [], encoder: { a: 6, b: 7, sw: 15 } },
    demo: { strips: { 5: Array.from({ length: 8 }, () => [0x40, 0x26, 0x0c]) } },
    // 演示：每 1.5 秒顺时针转一格（亮度 4 → 8 再停在顶）
    script: (sim, t) => t % 1.5 < 0.1 && sim.turnEncoder(1),
  },
  ruler: {
    desc: '对着墙一指，屏上显示距离；越近蜂鸣器响得越急，像倒车雷达。',
    live: { i2c: [{ kind: 'ssd1306', addr: 0x3c }], sonar: { trig: 17, echo: 18, cm: 42 } },
    demo: {},
    // 演示：挡板在 60 → 15 cm 之间来回
    script: (sim, t) => sim.setDistance(Math.round(37.5 + 22.5 * Math.cos(t / 3))),
  },
  tilt: {
    desc: '圆盘往哪边歪，屏上的小豆就往哪边滑；碰到圆边贴着边滑。',
    live: { i2c: [{ kind: 'qmi8658', addr: 0x6b }], lcd: true },
    demo: {},
    // 演示：每 2 秒换一个倾斜方向
    script: (sim, t) => {
      const k = Math.floor(t / 2) % 4;
      if (t % 2 < 0.1) sim.setImu({ pitch: [0, 20, 0, -20][k], roll: [25, 0, -25, 0][k], yaw: 0 });
    },
  },
};
{
  const box = document.querySelector<HTMLElement>('#works')!;
  const have = new Set([...box.querySelectorAll<HTMLElement>('.wk')].map((e) => e.dataset.work));
  for (const t of PROCURE_TEMPLATES) {
    if (t.id === 'blank' || have.has(t.id) || !WORKS[t.id] || !EXTRA[t.id]) continue;
    const a = document.createElement('article');
    a.className = 'wk';
    a.dataset.work = t.id;
    a.innerHTML = `<div class="wk-prev" data-show="${t.id}"></div>
<div class="wk-status mono" data-status>示意图 · 点「看真实固件跑」换成模拟器画面</div>
<div class="wk-body">
<div class="wk-h"><h2>${t.title}</h2><span class="mono muted">ESP32-S3</span></div>
<p class="wk-d">${EXTRA[t.id].desc}</p>
<div class="kv col"><span class="k">要买</span><span class="v txt" data-buy>—</span></div>
<div class="kv"><span class="k">检查点</span><span class="v mono" data-cps>—</span></div>
<div class="kv"><span class="k">参考价</span><span class="v mono" data-price>—</span></div>
<div class="wk-act"><button type="button" class="btn" data-run="${t.id}">看真实固件跑</button><a class="btn primary" data-go href="./app.html?work=${t.id}#shop">做这个</a></div>
</div>`;
    box.appendChild(a);
  }
}

const SERVO = 4;
const ENV = { temp: 23.5, humidity: 45, pressure: 101325 };
const FW: Record<ShowKind, { lcd: boolean; i2c: { kind: string; addr: number }[] }> = {
  weather: { lcd: false, i2c: [{ kind: 'ssd1306', addr: 0x3c }, { kind: 'bme280', addr: 0x76 }] },
  spin: { lcd: true, i2c: [] },
  lens: { lcd: true, i2c: [] },
};
// 卡片上的"要买"和参考价从元件库算，和采购页默认清单同一口径（必选 + 默认勾选的建议件，bomTotal），不写死
const yuan = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const shortName = (id: string) => getPart(id).name.split(/[（(]/)[0].trim();
const ACCESSORY = new Set(['cable', 'proto', 'power', 'passive']);
const KIND_NAME: Record<string, string> = { cable: '线材', proto: '面包板', power: '电源', passive: '阻容' };
for (const root of document.querySelectorAll<HTMLElement>('.wk')) {
  const id = root.dataset.work!;
  const t = getTemplate(id);
  const picks = templatePicks(id);
  const total = bomTotal(picks, t.board);
  const main = total.lines.filter((l) => !ACCESSORY.has(l.part.kind));
  const rest = total.lines.filter((l) => ACCESSORY.has(l.part.kind));
  const buy = root.querySelector<HTMLElement>('[data-buy]');
  const kinds = [...new Set(rest.map((l) => KIND_NAME[l.part.kind] ?? '配件'))];
  if (buy) buy.textContent = `${main.map((l) => shortName(l.part.id)).join('、')}${rest.length ? `；另配 ${rest.length} 种配件（${kinds.join('、')}）` : ''}`;
  const price = root.querySelector<HTMLElement>('[data-price]');
  if (price) price.innerHTML = `¥${yuan(total.lo)}–${yuan(total.hi)} <span class="muted">估算 · 核价 ${CHECKED_AT}</span>`;
}

const IDLE = '示意图 · 点「看真实固件跑」换成模拟器画面';

interface Card {
  kind: ShowKind;
  root: HTMLElement;
  prev: HTMLElement;
  status: HTMLElement;
  btn: HTMLButtonElement;
  sim: LiveSim | null;
}

// 卡片上的检查点数跟着作品定义走（web/src/app/works.ts），不在 HTML 里写死
for (const el of document.querySelectorAll<HTMLElement>('.wk')) {
  const n = WORKS[el.dataset.work ?? '']?.checkpoints.length;
  const v = el.querySelector<HTMLElement>('[data-cps]');
  if (v && n) v.textContent = `${n} 个`;
}

const cards: Card[] = [...document.querySelectorAll<HTMLElement>('.wk')].map((root) => {
  const kind = root.dataset.work as ShowKind;
  const prev = root.querySelector<HTMLElement>('[data-show]')!;
  showcase(prev, kind);
  return { kind, root, prev, status: root.querySelector<HTMLElement>('[data-status]')!, btn: root.querySelector<HTMLButtonElement>('[data-run]')!, sim: null };
});

/** 示意图：老三件用 showcase.ts 的插画；新作品用成品 2D 视图 + 一帧演示数据 */
function showcase(el: HTMLElement, kind: string) {
  const x = EXTRA[kind];
  if (!x) return createShowcase(el, kind as ShowKind);
  TEMPLATES[kind].product(el, { boot: () => {}, temp: () => {} }, { servoPin: SERVO }).update({ ...emptyFrame(), running: true, ...x.demo }, ENV.temp, {});
}

function stop(c: Card) {
  if (!c.sim) return;
  c.sim.dispose();
  c.sim = null;
  c.root.classList.remove('live');
  showcase(c.prev, c.kind);
  c.btn.textContent = '看真实固件跑';
  c.status.textContent = IDLE;
}

function run(c: Card) {
  for (const o of cards) if (o !== c) stop(o);
  const h = { boot: (d: boolean) => c.sim?.press(d), temp: (d: number) => c.sim?.setTemp(c.sim.env.temp + d) };
  const x = EXTRA[c.kind];
  const lcdView = x ? TEMPLATES[c.kind].product(c.prev, h, { servoPin: SERVO }) : c.kind === 'spin' ? createSpinProduct(c.prev, h, { servoPin: SERVO }) : c.kind === 'lens' ? createLensProduct(c.prev, h) : null;
  const wView = c.kind === 'weather' ? createProductView(c.prev, h, { servoPin: SERVO }) : null;
  let tail = '';
  let lastT = -1;
  const sim = new LiveSim({
    fw: `./fw/${c.kind}/flash.bin`,
    ...(x ? x.live : FW[c.kind]),
    env: ENV,
    onConsole(text) {
      // 状态行显示串口最后一行（weather 是 T= H= P= 读数）
      const lines = (tail + text).split('\n');
      tail = lines.pop() ?? '';
      const last = lines.map((l) => l.trim()).filter(Boolean).pop();
      if (last) c.status.textContent = `串口：${last.slice(0, 80)}`;
    },
    onFrame: (f, t) => {
      if (lcdView) lcdView.update(f, ENV.temp, {});
      else wView!.update(f, sim.env.temp, 0);
      // 新作品的演示输入（按模拟时间，每 0.1 s 看一次）
      if (x?.script && Number.isFinite(t) && Math.floor(t * 10) !== Math.floor(lastT * 10)) {
        lastT = t;
        x.script(sim, t);
      }
    },
  });
  c.sim = sim;
  c.root.classList.add('live');
  c.btn.textContent = '回到示意图';
  c.status.textContent = `正在启动 ${c.kind}/flash.bin（ESP32-S3）…`;
  sim.start().catch((e) => {
    c.status.textContent = `加载失败：${e}`;
    c.btn.textContent = '看真实固件跑';
  });
}

for (const c of cards) c.btn.onclick = () => (c.sim ? stop(c) : run(c));

// 卡片滚出视口就暂停模拟，省电
const io = new IntersectionObserver((es) => {
  for (const e of es) {
    const c = cards.find((x) => x.root === e.target);
    if (!c?.sim) continue;
    if (e.isIntersecting) c.sim.resume();
    else c.sim.pause();
  }
});
for (const c of cards) io.observe(c.root);
