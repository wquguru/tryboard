// 作品首页（DESIGN §1、§5）：作品卡按 app/works.ts 的作品定义生成（加一个作品就多一张卡）。卡片先放示意图；
// 点「看真实固件跑」换成模拟器驱动的成品画面，同一时间只跑一份（每份是一个 wasm worker），看不见就暂停。
import { LiveSim } from './live';
import { themeToggle } from './theme';

document.querySelector('.pg-head nav')!.after(themeToggle());
import { createShowcase, type ShowKind } from './views/showcase';
import { createProductView } from './views/product';
import { createLensProduct, createSpinProduct } from './views/lcdproducts';
import { bomTotal, getTemplate, templatePicks } from './catalog/templates';
import { CHECKED_AT, getPart } from './catalog/parts';
import { HOME_WORKS, WORKS } from './app/works';
import { createKeypadView } from './views/keypad';

const escH = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
document.getElementById('works')!.innerHTML = HOME_WORKS.map(
  (w) => `<article class="wk" data-work="${w.id}">
  <div class="wk-prev" data-show="${w.id}"></div>
  <div class="wk-status mono" data-status>示意图 · 点「看真实固件跑」换成模拟器画面</div>
  <div class="wk-body">
    <div class="wk-h"><h2>${escH(w.title)}</h2><span class="mono muted">${escH(w.card!.chip)}</span></div>
    <p class="wk-d">${escH(w.card!.blurb)}</p>
    <div class="kv col"><span class="k">要买</span><span class="v txt" data-buy>—</span></div>
    <div class="kv"><span class="k">检查点</span><span class="v mono" data-cps>${w.checkpoints.length} 个</span></div>
    <div class="kv"><span class="k">参考价</span><span class="v mono" data-price>—</span></div>
    <div class="wk-act"><button type="button" class="btn" data-run="${w.id}">看真实固件跑</button><a class="btn primary" data-go href="./app.html?work=${w.id}#shop">做这个</a></div>
  </div>
</article>`,
).join('');

const SERVO = 4;
const ENV = { temp: 23.5, humidity: 45, pressure: 101325 };
const FW: Record<ShowKind, { lcd: boolean; i2c: { kind: string; addr: number }[] }> = {
  weather: { lcd: false, i2c: [{ kind: 'ssd1306', addr: 0x3c }, { kind: 'bme280', addr: 0x76 }] },
  spin: { lcd: true, i2c: [] },
  lens: { lcd: true, i2c: [] },
  usbkey: { lcd: false, i2c: [] },
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
  createShowcase(prev, kind);
  return { kind, root, prev, status: root.querySelector<HTMLElement>('[data-status]')!, btn: root.querySelector<HTMLButtonElement>('[data-run]')!, sim: null };
});

function stop(c: Card) {
  if (!c.sim) return;
  c.sim.dispose();
  c.sim = null;
  c.root.classList.remove('live');
  createShowcase(c.prev, c.kind);
  c.btn.textContent = '看真实固件跑';
  c.status.textContent = IDLE;
}

function run(c: Card) {
  for (const o of cards) if (o !== c) stop(o);
  const h = { boot: (d: boolean) => c.sim?.press(d), temp: (d: number) => c.sim?.setTemp(c.sim.env.temp + d) };
  const lcdView = c.kind === 'spin' ? createSpinProduct(c.prev, h, { servoPin: SERVO }) : c.kind === 'lens' ? createLensProduct(c.prev, h) : null;
  const wView = c.kind === 'weather' ? createProductView(c.prev, h, { servoPin: SERVO }) : null;
  // USB 小键盘：点键帽 = 按下 GPIO4..7（接地），虚拟电脑屏幕上是 USB 主机收到的字
  const kView = c.kind === 'usbkey' ? createKeypadView(c.prev, { press: (pin, d) => c.sim?.pressPin(pin, d) }) : null;
  let tail = '';
  const sim = new LiveSim({
    fw: `./fw/${c.kind}/flash.bin`,
    ...FW[c.kind],
    env: ENV,
    onConsole(text) {
      // 状态行显示串口最后一行（weather 是 T= H= P= 读数）
      const lines = (tail + text).split('\n');
      tail = lines.pop() ?? '';
      const last = lines.map((l) => l.trim()).filter(Boolean).pop();
      if (last) c.status.textContent = `串口：${last.slice(0, 80)}`;
    },
    onFrame: (f) => (lcdView ? lcdView.update(f, ENV.temp, {}) : wView ? wView.update(f, sim.env.temp, 0) : undefined),
    onUsb: (v) => kView?.setUsb(v),
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
