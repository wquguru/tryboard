// 作品首页（DESIGN §1、§5）：三张作品卡。卡片先放示意图；点「看真实固件跑」换成模拟器驱动的成品画面，
// 同一时间只跑一份（每份是一个 wasm worker），看不见就暂停。
import { LiveSim } from './live';
import { createShowcase, type ShowKind } from './views/showcase';
import { createProductView } from './views/product';
import { createLensProduct, createSpinProduct } from './views/lcdproducts';
import { WORKS } from './app/works';

const SERVO = 4;
const ENV = { temp: 23.5, humidity: 45, pressure: 101325 };
const FW: Record<ShowKind, { lcd: boolean; i2c: { kind: string; addr: number }[] }> = {
  weather: { lcd: false, i2c: [{ kind: 'ssd1306', addr: 0x3c }, { kind: 'bme280', addr: 0x76 }] },
  spin: { lcd: true, i2c: [] },
  lens: { lcd: true, i2c: [] },
};
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
    onFrame: (f) => (lcdView ? lcdView.update(f, ENV.temp, {}) : wView!.update(f, sim.env.temp, 0)),
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
