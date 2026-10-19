// Imperative part of the project cards (ARCH "web 2D UI"): illustration, live firmware run in a wasm worker, serial status line.
// Running swaps the illustration for the simulator-driven product view and pauses while off-screen.
import { LiveSim, type LiveOptions } from '../live';
import { createShowcase, type ShowKind } from '../views/showcase';
import { createProductView } from '../views/product';
import { createLensProduct, createSpinProduct } from '../views/lcdproducts';
import { createKeypadView } from '../views/keypad';
import { TEMPLATES } from '../views/templates';
import { emptyFrame, type LiveFrame } from '../views/common';
import { t } from '../i18n';

// P2-09 cards: the illustration is the product 2D view fed one demo frame; plus the live device config and demo inputs by sim time.
type LiveCfg = Pick<LiveOptions, 'i2c' | 'lcd' | 'encoder' | 'sonar'>;
const EXTRA: Record<string, { live: LiveCfg; demo: Partial<LiveFrame>; script?: (sim: LiveSim, t: number) => void }> = {
  lamp: {
    live: { i2c: [], encoder: { a: 6, b: 7, sw: 15 } },
    demo: { strips: { 5: Array.from({ length: 8 }, () => [0x40, 0x26, 0x0c]) } },
    // Demo: one clockwise detent every 1.5 s (brightness 4 -> 8, then stays at the top).
    script: (sim, t) => t % 1.5 < 0.1 && sim.turnEncoder(1),
  },
  ruler: {
    live: { i2c: [{ kind: 'ssd1306', addr: 0x3c }], sonar: { trig: 17, echo: 18, cm: 42 } },
    demo: {},
    // Demo: the target moves between 60 and 15 cm.
    script: (sim, t) => sim.setDistance(Math.round(37.5 + 22.5 * Math.cos(t / 3))),
  },
  tilt: {
    live: { i2c: [{ kind: 'qmi8658', addr: 0x6b }], lcd: true },
    demo: {},
    // Demo: new tilt direction every 2 s.
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

/** Illustration: the first three works use showcase.ts art; newer ones use the product 2D view with one demo frame. */
export function showcase(el: HTMLElement, kind: string) {
  const x = EXTRA[kind];
  if (!x) return createShowcase(el, kind as ShowKind);
  TEMPLATES[kind].product(el, { boot: () => {}, temp: () => {} }, { servoPin: SERVO }).update({ ...emptyFrame(), running: true, ...x.demo }, ENV.temp, {});
}

/** Run real firmware in the card preview; the last serial line goes straight to the status line (high rate, no React state). Returns stop. */
export function startLive(kind: string, card: HTMLElement, prev: HTMLElement, status: HTMLElement, onFail: () => void) {
  let sim: LiveSim | null = null;
  const h = { boot: (d: boolean) => sim?.press(d), temp: (d: number) => sim && sim.setTemp(sim.env.temp + d) };
  const x = EXTRA[kind];
  const lcdView = x ? TEMPLATES[kind].product(prev, h, { servoPin: SERVO }) : kind === 'spin' ? createSpinProduct(prev, h, { servoPin: SERVO }) : kind === 'lens' ? createLensProduct(prev, h) : null;
  const wView = kind === 'weather' ? createProductView(prev, h, { servoPin: SERVO }) : null;
  // USB keypad: clicking a keycap grounds GPIO4..7; the virtual PC screen shows what the USB host received.
  const kView = kind === 'usbkey' ? createKeypadView(prev, { press: (pin, d) => sim?.pressPin(pin, d) }) : null;
  let tail = '';
  let lastT = -1;
  const s = new LiveSim({
    fw: `./fw/${kind}/flash.bin`,
    ...(x ? x.live : FW[kind as ShowKind]),
    env: ENV,
    onConsole(text) {
      // Status shows the last serial line (weather prints T= H= P=).
      const lines = (tail + text).split('\n');
      tail = lines.pop() ?? '';
      const last = lines.map((l) => l.trim()).filter(Boolean).pop();
      if (last) status.textContent = t('Serial: {line}', { line: last.slice(0, 80) });
    },
    onFrame: (f, t) => {
      if (lcdView) lcdView.update(f, ENV.temp, {});
      else wView?.update(f, s.env.temp, 0);
      // Demo inputs for newer works, checked every 0.1 s of sim time.
      if (x?.script && Number.isFinite(t) && Math.floor(t * 10) !== Math.floor(lastT * 10)) {
        lastT = t;
        x.script(s, t);
      }
    },
    onUsb: (v) => kView?.setUsb(v),
  });
  sim = s;
  status.textContent = t('Starting firmware (ESP32-S3)…');
  s.start().catch((e) => {
    status.textContent = t('Failed to load: {err}', { err: String(e) });
    onFail();
  });
  // Pause the sim when the card scrolls out of view to save power.
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
