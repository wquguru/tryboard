// 作品卡里的命令式部分（不进 React 渲染，ARCH「网页 2D 界面」）：示意图、真实固件运行（wasm worker）、串口状态行。
// 卡片先放示意图；点「运行固件」换成模拟器驱动的成品画面，看不见就暂停（每份是一个 wasm worker）。
import { LiveSim, type LiveOptions } from '../live';
import { createShowcase, type ShowKind } from '../views/showcase';
import { createProductView } from '../views/product';
import { createLensProduct, createSpinProduct } from '../views/lcdproducts';
import { createKeypadView } from '../views/keypad';
import { TEMPLATES } from '../views/templates';
import { emptyFrame, type LiveFrame } from '../views/common';

// P2-09 新作品的卡片：示意图用成品的 2D 视图喂一帧演示数据；「运行固件」时的器件配置和演示输入（按模拟时间）。
type LiveCfg = Pick<LiveOptions, 'i2c' | 'lcd' | 'encoder' | 'sonar'>;
const EXTRA: Record<string, { live: LiveCfg; demo: Partial<LiveFrame>; script?: (sim: LiveSim, t: number) => void }> = {
  lamp: {
    live: { i2c: [], encoder: { a: 6, b: 7, sw: 15 } },
    demo: { strips: { 5: Array.from({ length: 8 }, () => [0x40, 0x26, 0x0c]) } },
    // 演示：每 1.5 秒顺时针转一格（亮度 4 → 8 再停在顶）
    script: (sim, t) => t % 1.5 < 0.1 && sim.turnEncoder(1),
  },
  ruler: {
    live: { i2c: [{ kind: 'ssd1306', addr: 0x3c }], sonar: { trig: 17, echo: 18, cm: 42 } },
    demo: {},
    // 演示：挡板在 60 → 15 cm 之间来回
    script: (sim, t) => sim.setDistance(Math.round(37.5 + 22.5 * Math.cos(t / 3))),
  },
  tilt: {
    live: { i2c: [{ kind: 'qmi8658', addr: 0x6b }], lcd: true },
    demo: {},
    // 演示：每 2 秒换一个倾斜方向
    script: (sim, t) => {
      const k = Math.floor(t / 2) % 4;
      if (t % 2 < 0.1) sim.setImu({ pitch: [0, 20, 0, -20][k], roll: [25, 0, -25, 0][k], yaw: 0 });
    },
  },
};

const SERVO = 4;
const ENV = { temp: 23.5, humidity: 45, pressure: 101325 };
const FW: Record<ShowKind, { lcd: boolean; i2c: { kind: string; addr: number }[] }> = {
  weather: { lcd: false, i2c: [{ kind: 'ssd1306', addr: 0x3c }, { kind: 'bme280', addr: 0x76 }] },
  spin: { lcd: true, i2c: [] },
  lens: { lcd: true, i2c: [] },
  usbkey: { lcd: false, i2c: [] },
};

/** 示意图：老三件用 showcase.ts 的插画；新作品用成品 2D 视图 + 一帧演示数据 */
export function showcase(el: HTMLElement, kind: string) {
  const x = EXTRA[kind];
  if (!x) return createShowcase(el, kind as ShowKind);
  TEMPLATES[kind].product(el, { boot: () => {}, temp: () => {} }, { servoPin: SERVO }).update({ ...emptyFrame(), running: true, ...x.demo }, ENV.temp, {});
}

/** 在卡片预览里跑真实固件；串口最后一行直接写状态行（高频，不走 React state）。返回停止函数 */
export function startLive(kind: string, card: HTMLElement, prev: HTMLElement, status: HTMLElement, onFail: () => void) {
  let sim: LiveSim | null = null;
  const h = { boot: (d: boolean) => sim?.press(d), temp: (d: number) => sim && sim.setTemp(sim.env.temp + d) };
  const x = EXTRA[kind];
  const lcdView = x ? TEMPLATES[kind].product(prev, h, { servoPin: SERVO }) : kind === 'spin' ? createSpinProduct(prev, h, { servoPin: SERVO }) : kind === 'lens' ? createLensProduct(prev, h) : null;
  const wView = kind === 'weather' ? createProductView(prev, h, { servoPin: SERVO }) : null;
  // USB 小键盘：点键帽 = 按下 GPIO4..7（接地），虚拟电脑屏幕上是 USB 主机收到的字
  const kView = kind === 'usbkey' ? createKeypadView(prev, { press: (pin, d) => sim?.pressPin(pin, d) }) : null;
  let tail = '';
  let lastT = -1;
  const s = new LiveSim({
    fw: `./fw/${kind}/flash.bin`,
    ...(x ? x.live : FW[kind as ShowKind]),
    env: ENV,
    onConsole(text) {
      // 状态行显示串口最后一行（weather 是 T= H= P= 读数）
      const lines = (tail + text).split('\n');
      tail = lines.pop() ?? '';
      const last = lines.map((l) => l.trim()).filter(Boolean).pop();
      if (last) status.textContent = `串口：${last.slice(0, 80)}`;
    },
    onFrame: (f, t) => {
      if (lcdView) lcdView.update(f, ENV.temp, {});
      else wView?.update(f, s.env.temp, 0);
      // 新作品的演示输入（按模拟时间，每 0.1 s 看一次）
      if (x?.script && Number.isFinite(t) && Math.floor(t * 10) !== Math.floor(lastT * 10)) {
        lastT = t;
        x.script(s, t);
      }
    },
    onUsb: (v) => kView?.setUsb(v),
  });
  sim = s;
  status.textContent = '正在启动固件（ESP32-S3）…';
  s.start().catch((e) => {
    status.textContent = `加载失败：${e}`;
    onFail();
  });
  // 卡片滚出视口就暂停模拟，省电
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!sim) continue;
      if (e.isIntersecting) sim.resume();
      else sim.pause();
    }
  });
  io.observe(card);
  return () => {
    io.disconnect();
    sim?.dispose();
    sim = null;
    status.textContent = '';
  };
}
