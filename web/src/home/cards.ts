// Imperative part of the project cards (ARCH "web 2D UI"): illustration, live firmware run in a wasm worker, serial status line.
// Running swaps the illustration for the simulator-driven product view and pauses while off-screen.
import { LiveSim, type LiveOptions } from '../live';
import { createShowcase, type ShowKind } from '../views/showcase';
import { createProductView } from '../views/product';
import { createLensProduct, createSpinProduct } from '../views/lcdproducts';
import { createKeypadView } from '../views/keypad';
import { workTemplate } from '../views/worktpl';
import { DOOR_CARDS, doorNow, parseDoorLine } from '../views/doorproduct';
import { IRLAMP_CMD, irlampNow, parseIrlampLine } from '../views/irlampproduct';
import { irCode } from '../app/irfeed';
import { cloudCmd, cloudIdle, cloudNow, parseCloudLine } from '../views/cloudproduct';
import { emptyFrame, type LiveFrame } from '../views/common';
import { t } from '../i18n';

// P2-09 cards: the illustration is the product 2D view fed one demo frame; plus the live device config and demo inputs by sim time.
// fw: published firmware id when it isn't the work id; line: each serial line (door state for the lock picture); seed: illustration state.
type LiveCfg = Pick<LiveOptions, 'i2c' | 'lcd' | 'encoder' | 'sonar' | 'parts'>;
type Extra = { live: LiveCfg; demo: Partial<LiveFrame>; script?: (sim: LiveSim, t: number) => void; fw?: string; chip?: string; line?: (l: string) => void; seed?: () => void };
const EXTRA: Record<string, Extra> = {
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
  door: {
    fw: 'c3-door',
    chip: 'ESP32-C3',
    live: { i2c: [{ kind: 'sh1106', addr: 0x3c }], parts: { rc522: {}, relay: { pin: 10 } } },
    demo: {},
    // Demo: every 3 s tap the whitelisted card, lift it, tap an unknown card, lift it.
    script: (sim, t) => t % 3 < 0.1 && sim.partInput({ kind: 'card', uid: [DOOR_CARDS.ok, 'none', DOOR_CARDS.bad, 'none'][Math.floor(t / 3) % 4] }),
    line: (l) => parseDoorLine(l, doorNow),
  },
  irlamp: {
    fw: 's3-irlamp',
    live: { i2c: [], parts: { ir: { rx: 4 } } },
    demo: { strips: { 5: Array.from({ length: 8 }, () => [0x80, 0x4c, 0x19]) } },
    // Demo: every 1.5 s press the next of digits 1..9 (colour), then VOL- / VOL+ once round the cycle.
    script: (sim, t) => {
      const k = [...IRLAMP_CMD.digits, IRLAMP_CMD.down, IRLAMP_CMD.up][Math.floor(t / 1.5) % 11];
      if (t > 1 && t % 1.5 < 0.1) sim.partInput({ kind: 'ir', code: irCode(k) });
    },
    line: (l) => parseIrlampLine(l, irlampNow),
  },
  cloud: {
    fw: 'c3-cloud',
    chip: 'ESP32-C3',
    live: { i2c: [{ kind: 'aht20', addr: 0x38 }] },
    demo: {},
    // Demo: the room drifts ±1.5 ℃ and at 6 s the cloud asks for a report every 2 s.
    script: (sim, t) => {
      if (t > 6 && t < 6.1) sim.mqttPub(cloudCmd('interval=2'));
      if (t % 1 < 0.1) sim.setTemp(Math.round((23.5 + 1.5 * Math.sin(t / 5)) * 10) / 10);
    },
    line: (l) => parseCloudLine(l, cloudNow),
    // Illustration: a dashboard with a few reports already in (replaced by the real run's banner reset)
    seed: () => Object.assign(cloudNow, cloudIdle(), { ip: '192.168.4.100', mqtt: true, sub: true, reports: [23.1, 23.4, 23.6, 23.5].map((v, i) => ({ seq: i, t: v, h: 45, ...(i ? { gap: 5 } : {}) })) }),
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
  x.seed?.();
  workTemplate(kind)!.product(el, { boot: () => {}, temp: () => {} }, { servoPin: SERVO }).update({ ...emptyFrame(), running: true, ...x.demo }, ENV.temp, {});
}

/** Run real firmware in the card preview; the last serial line goes straight to the status line (high rate, no React state). Returns stop. */
export function startLive(kind: string, card: HTMLElement, prev: HTMLElement, status: HTMLElement, onFail: () => void) {
  let sim: LiveSim | null = null;
  const h = { boot: (d: boolean) => sim?.press(d), temp: (d: number) => sim && sim.setTemp(sim.env.temp + d), ir: (code: string) => sim?.partInput({ kind: 'ir', code }), mqtt: (cmd: string) => sim?.mqttPub(cmd) };
  const x = EXTRA[kind];
  const lcdView = x ? workTemplate(kind)!.product(prev, h, { servoPin: SERVO }) : kind === 'spin' ? createSpinProduct(prev, h, { servoPin: SERVO }) : kind === 'lens' ? createLensProduct(prev, h) : null;
  const wView = kind === 'weather' ? createProductView(prev, h, { servoPin: SERVO }) : null;
  // USB keypad: clicking a keycap grounds GPIO4..7; the virtual PC screen shows what the USB host received.
  const kView = kind === 'usbkey' ? createKeypadView(prev, { press: (pin, d) => sim?.pressPin(pin, d) }) : null;
  let tail = '';
  let lastT = -1;
  const s = new LiveSim({
    fw: `./fw/${x?.fw ?? kind}/flash.bin`,
    ...(x ? x.live : FW[kind as ShowKind]),
    env: ENV,
    onConsole(text) {
      // Status shows the last serial line (weather prints T= H= P=).
      const lines = (tail + text).split('\n');
      tail = lines.pop() ?? '';
      if (x?.line) lines.forEach((l) => x.line!(l.trim()));
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
  status.textContent = t('Starting firmware ({chip})…', { chip: x?.chip ?? 'ESP32-S3' });
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
