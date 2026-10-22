// Assembly templates: parts (bottom-up), placement options, fit checks (estimates), effects on the product, product view.
// Effects the simulator can model (sensor temperature) go into it; pure geometry / optics (horn offset, lens zoom) only change the picture, marked as estimates.
import { t } from '../i18n';
import type { LiveFrame } from './common';
import { createProductView, type ProductHandlers } from './product';
import { createLensProduct, createSpinProduct } from './lcdproducts';
import { createDoorProduct } from './doorproduct';
import { createIrlampProduct } from './irlampproduct';
import { createLampProduct, createRulerProduct, createTiltProduct, type WorkEffects } from './workproducts';
import { createKeypadView } from './keypad';
import { CHIP_HEAT_OFFSET } from './chipheat';

export interface Spot {
  key: string;
  /** Choice button text */
  label: string;
  /** Position-only wording for ghost tags (defaults to label) */
  where?: string;
  /** Part top-left in the layer's local coords; only for choices that differ by position */
  at?: [number, number];
  ok: boolean;
  msg: [string, string];
}
export interface Part {
  id: string;
  name: string;
  short: string;
  /** Flat drawing for the parts tray (100×60) */
  mini: string;
  /** Installed look (layer-local 180×100; for choices with `at`, origin is the part's top-left) */
  iso: string;
  /** Dashed drop box [x, y, w, h] (choices with `at` use spotSize) */
  ghost?: number[];
  spotSize?: [number, number];
  spots?: Spot[];
  okMsg?: [string, string];
}
export interface Effects extends WorkEffects {
  sensorOffset?: number;
  hornOffset?: number;
  lensScale?: number;
  /** Harness (P2-11, estimate): total I2C cable length (I2C works only) and antenna loss (dB); fed to the simulator */
  i2cWireCm?: number;
  antennaDb?: number;
  /** USB port blocked by the case (usbkey): no cable, so the virtual computer sees no device */
  usbBlocked?: boolean;
  /** IR receiver behind the opaque base wall (irlamp): no remote code arrives, so ir= inputs are dropped */
  irBlock?: boolean;
}

/** Recessed sonar hears the hole wall first, so readings clamp to this many cm (estimate, not calibrated on hardware) */
export const SONAR_BLOCK_CM = 3;

/** Re-test inputs as the installed sensors see them: blocked sonar clamps dist=, a flipped IMU negates imu= pitch / roll,
 *  a blocked reader turns card= into none, a receiver behind the opaque wall drops every ir= code. */
export function effectScript(script: string | undefined, fx: Effects): string | undefined {
  if (!script || (!fx.sonarBlock && !fx.imuFlip && !fx.cardBlock && !fx.irBlock)) return script;
  return script
    .split(';')
    .map((e) => {
      const m = /^(\s*[\d.]+\s*:\s*)(dist|imu|card|ir)=(.*)$/.exec(e);
      if (!m) return e;
      if (m[2] === 'ir' && fx.irBlock) return '';
      if (m[2] === 'card' && fx.cardBlock) return `${m[1]}card=none`;
      if (m[2] === 'dist' && fx.sonarBlock) {
        const d = Number(m[3]);
        return `${m[1]}dist=${d < 0 || d > fx.sonarBlock ? fx.sonarBlock : d}`;
      }
      if (m[2] === 'imu' && fx.imuFlip) {
        const v = m[3].split(',').map(Number);
        const flip = v.map((x, i) => (i === 0 || i === 1 || i === 3 || i === 4 ? -x : x)).map((x) => (Object.is(x, -0) ? 0 : x));
        return `${m[1]}imu=${flip.join(',')}`;
      }
      return e;
    })
    .filter((e) => e !== '')
    .join(';');
}
export interface Picked {
  placed: string[];
  choice: Record<string, string>;
}
export interface Template {
  id: string;
  caption: string;
  parts: Part[];
  tray: string[];
  intro: [string, string];
  checks(s: Picked): { label: string; ok: boolean | null; text: string }[];
  effects(s: Picked): Effects;
  product(el: HTMLElement, h: ProductHandlers, opts: { servoPin: number }): { update(f: LiveFrame, room: number, fx: Effects): void };
}

const has = (s: Picked, k: string) => s.placed.includes(k);
const row = (label: string, done: boolean, ok: boolean, good: string, bad = '') => ({ label, ok: done ? ok : null, text: done ? (ok ? '✓ ' + good : '! ' + bad) : '—' });

export { CHIP_HEAT_OFFSET };
/** SG90 output spline has 25 teeth, so one tooth off is 14.4° */
export const SPLINE_TOOTH = 360 / 25;

const SHELL_ISO = '<rect width="180" height="100" rx="10" fill="#E9E5DC" stroke="#8A867E" stroke-width="1.5"/><rect x="8" y="8" width="164" height="84" rx="6" fill="#D6D1C6"/><rect y="40" width="10" height="20" fill="#3A3936"/>';
const BOARD_ISO = '<rect x="20" y="20" width="120" height="60" rx="3" fill="#141414"/><rect x="74" y="28" width="56" height="44" rx="2" fill="#BDB9B0"/><rect x="14" y="40" width="10" height="18" fill="#8A867E"/><circle cx="50" cy="32" r="4" fill="#22C55E"/>';
const BOARD_MINI = '<rect x="2" y="10" width="96" height="40" rx="3" fill="#141414"/><rect x="50" y="15" width="42" height="30" rx="2" fill="#BDB9B0"/><rect y="22" width="8" height="14" fill="#8A867E"/><circle cx="22" cy="18" r="3.5" fill="#22C55E"/>';
const SERVO_MINI = '<rect x="20" y="16" width="60" height="30" rx="3" fill="#2B5FD9"/><rect x="12" y="24" width="76" height="6" rx="2" fill="#2B5FD9"/><circle cx="36" cy="16" r="8" fill="#F7F6F3"/><path d="M36 16 L60 6" stroke="#F7F6F3" stroke-width="4" stroke-linecap="round"/>';
const LCD_MINI = '<circle cx="50" cy="30" r="28" fill="#1A1A19"/><circle cx="50" cy="30" r="22" fill="#06070A"/><rect x="38" y="22" width="8" height="14" rx="4" fill="#7CF5FF"/><rect x="54" y="22" width="8" height="14" rx="4" fill="#7CF5FF"/>';
const LCD_ISO = '<circle cx="90" cy="50" r="36" fill="#1A1A19"/><circle cx="90" cy="50" r="28" fill="#06070A"/><rect x="76" y="40" width="9" height="18" rx="4" fill="#7CF5FF"/><rect x="95" y="40" width="9" height="18" rx="4" fill="#7CF5FF"/>';

export const WEATHER: Template = {
  id: 'weather',
  caption: t('Weather station · case 70×50×32 mm (estimate)'),
  intro: [t('Drag the parts into the case'), t('Start with the bottom layer')],
  tray: ['servo', 'shell', 'oled', 'bme', 'front', 'board'],
  parts: [
    { id: 'shell', name: t('Back shell'), short: t('Back shell'), ghost: [0, 0, 180, 100], okMsg: [t('Back shell in place'), t('USB-C cutout faces back')],
      mini: '<rect width="100" height="60" rx="8" fill="#E9E5DC" stroke="#8A867E" stroke-width="1.5"/><rect x="6" y="6" width="88" height="48" rx="5" fill="#D6D1C6"/><path d="M86 18 L92 18 M86 26 L92 26 M86 34 L92 34 M86 42 L92 42" stroke="#8A867E" stroke-width="2"/><rect y="24" width="6" height="12" fill="#3A3936"/>',
      iso: SHELL_ISO + '<path d="M160 30 L172 30 M160 40 L172 40 M160 50 L172 50 M160 60 L172 60 M160 70 L172 70" stroke="#8A867E" stroke-width="2.5"/>' },
    { id: 'board', name: t('ESP32-S3 dev board'), short: t('Board'), ghost: [20, 20, 120, 60], okMsg: [t('Board clipped in'), t('GPIO4 to servo · SDA/SCL to screen and sensor')], mini: BOARD_MINI, iso: BOARD_ISO },
    { id: 'bme', name: 'BME280', short: 'BME280', spotSize: [36, 30],
      mini: '<rect x="32" y="12" width="36" height="34" rx="3" fill="#6A3FA0"/><rect x="44" y="22" width="12" height="12" fill="#C9C6BF"/><path d="M38 46 L38 54 M46 46 L46 54 M54 46 L54 54 M62 46 L62 54" stroke="#E8C547" stroke-width="2"/>',
      iso: '<rect width="36" height="30" rx="2" fill="#6A3FA0"/><rect x="12" y="9" width="12" height="12" fill="#C9C6BF"/>',
      spots: [
        { key: 'A', label: t('Next to the vent'), where: t('By the vent'), at: [128, 40], ok: true, msg: [t('Sensor sits by the vent'), t('It reads the room temperature')] },
        { key: 'B', label: t('Next to the board'), where: t('By the board'), at: [74, 28], ok: false, msg: [t('Sensor touches the chip'), t('The chip warms it, reading about {n} ℃ high', { n: CHIP_HEAT_OFFSET })] },
      ] },
    { id: 'servo', name: t('SG90 servo'), short: t('Servo'), ghost: [56, 14, 56, 30], okMsg: [t('Servo shaft centred on the dial'), t('The needle sweeps 0 ℃ to 40 ℃')], mini: SERVO_MINI,
      iso: '<rect x="56" y="14" width="56" height="30" rx="3" fill="#2B5FD9"/><rect x="74" y="4" width="10" height="10" fill="#F7F6F3"/>' },
    { id: 'oled', name: 'OLED 0.96″', short: 'OLED', ghost: [50, 52, 80, 40], okMsg: [t('Screen cable 8 cm'), t('Reaches the front panel from the board')],
      mini: '<rect x="12" y="4" width="76" height="52" rx="3" fill="#1C4F86"/><rect x="18" y="12" width="64" height="34" fill="#050608"/><path d="M26 24 L46 24 M26 32 L60 32" stroke="#D7F3FF" stroke-width="3"/>',
      iso: '<rect x="50" y="52" width="80" height="40" rx="3" fill="#1C4F86"/><rect x="56" y="58" width="68" height="28" fill="#050608"/>' },
    { id: 'front', name: t('Front panel'), short: t('Front panel'), ghost: [0, 0, 180, 100], okMsg: [t('Closed'), t('Click “Next: product”')],
      mini: '<rect width="100" height="60" rx="8" fill="#F2EFE8" stroke="#8A867E" stroke-width="1.5"/><path d="M28 28 A22 22 0 0 1 72 28" fill="none" stroke="#141414" stroke-width="2"/><rect x="32" y="34" width="36" height="16" rx="2" fill="none" stroke="#141414" stroke-width="2"/>',
      iso: '<rect width="180" height="100" rx="10" fill="#F2EFE8" stroke="#8A867E" stroke-width="1.5" opacity="0.7"/><path d="M50 46 A40 40 0 0 1 130 46" fill="none" stroke="#141414" stroke-width="2"/><rect x="56" y="58" width="68" height="28" rx="3" fill="none" stroke="#141414" stroke-width="2"/>' },
  ],
  checks: (s) => [
    row(t('Sensor position'), has(s, 'bme'), s.choice.bme === 'A', t('By the vent, accurate'), t('Against the chip, about {n} ℃ high', { n: CHIP_HEAT_OFFSET })),
    row(t('Screen cable'), has(s, 'oled'), true, t('8 cm, needs ≥ 6 cm')),
    row(t('Servo axis'), has(s, 'servo'), true, t('Centred on the dial')),
    row(t('Inner height'), has(s, 'front'), true, t('27 / 32 mm used')),
  ],
  effects: (s) => ({ sensorOffset: s.choice.bme === 'B' ? CHIP_HEAT_OFFSET : 0 }),
  product: (el, h, o) => {
    const p = createProductView(el, h, o);
    return { update: (f, room, fx) => p.update(f, room, fx.sensorOffset ?? 0) };
  },
};

export const SPIN: Template = {
  id: 'spin',
  caption: t('Little Yellow · base Ø60 mm, 110 mm tall (estimate)'),
  intro: [t('Build Little Yellow'), t('Start with the base')],
  tray: ['lcd', 'base', 'hair', 'servo', 'body', 'board'],
  parts: [
    { id: 'base', name: t('Turntable base'), short: t('Base'), ghost: [0, 0, 180, 100], okMsg: [t('Base in place'), t('Servo bay faces up')],
      mini: '<ellipse cx="50" cy="34" rx="46" ry="22" fill="#2A2A28"/><ellipse cx="50" cy="28" rx="46" ry="22" fill="#3A3936"/><rect x="34" y="20" width="32" height="16" rx="2" fill="#141414"/>',
      iso: '<rect width="180" height="100" rx="40" fill="#3A3936" stroke="#141414" stroke-width="1.5"/><rect x="62" y="32" width="56" height="36" rx="3" fill="#141414"/>' },
    { id: 'servo', name: t('SG90 servo'), short: t('Servo'), ghost: [62, 32, 56, 36], mini: SERVO_MINI,
      iso: '<rect x="62" y="32" width="56" height="36" rx="3" fill="#2B5FD9"/><circle cx="90" cy="50" r="10" fill="#F7F6F3"/>',
      spots: [
        { key: 'C', label: t('Centre the servo, then fit the horn'), ok: true, msg: [t('Servo turned to 90° first'), t('Then the horn: front faces front')] },
        { key: 'X', label: t('Just push the horn on'), ok: false, msg: [t('Horn is one tooth off'), t('The front will be {n}° off', { n: SPLINE_TOOTH.toFixed(1) })] },
      ] },
    { id: 'board', name: t('ESP32-S3 dev board'), short: t('Board'), ghost: [20, 20, 120, 60], okMsg: [t('Board goes into the body'), t('GPIO4 to servo · SPI to round screen')], mini: BOARD_MINI, iso: BOARD_ISO },
    { id: 'lcd', name: t('Round screen GC9A01'), short: t('Round screen'), ghost: [54, 14, 72, 72], okMsg: [t('Round screen sits where the face is'), t('Cable runs through the axle hole')], mini: LCD_MINI, iso: LCD_ISO },
    { id: 'body', name: t('Body shell'), short: t('Body'), ghost: [0, 0, 180, 100], okMsg: [t('Body snapped on'), t('The belt hides the screws')],
      mini: '<rect x="22" y="2" width="56" height="56" rx="26" fill="#FFC933" stroke="#141414" stroke-width="2"/><rect x="22" y="40" width="56" height="6" fill="#2F2A57"/><circle cx="50" cy="22" r="11" fill="#141414"/>',
      iso: '<rect width="180" height="100" rx="46" fill="#FFC933" stroke="#141414" stroke-width="1.5" opacity="0.75"/><circle cx="90" cy="50" r="36" fill="none" stroke="#141414" stroke-width="2"/>' },
    { id: 'hair', name: t('Hair curl'), short: t('Curl'), ghost: [70, 30, 40, 40], okMsg: [t('Fitted'), t('Click “Next: product”')],
      mini: '<path d="M44 52 C30 30 44 8 62 14 C76 20 72 40 58 38" fill="none" stroke="#141414" stroke-width="5" stroke-linecap="round"/>',
      iso: '<path d="M80 60 C66 40 80 22 98 28 C112 34 108 52 94 50" fill="none" stroke="#141414" stroke-width="5" stroke-linecap="round"/>' },
  ],
  checks: (s) => [
    row(t('Horn centred'), has(s, 'servo'), s.choice.servo === 'C', t('Facing front'), t('{n}° off (one tooth)', { n: SPLINE_TOOTH.toFixed(1) })),
    row(t('Round screen cable'), has(s, 'lcd'), true, t('Through the axle hole, slack for ±60°')),
    row(t('Centre of mass'), has(s, 'body'), true, t('Above the axle, the SG90 can turn it')),
    row(t('Total height'), has(s, 'hair'), true, '110 mm'),
  ],
  effects: (s) => ({ hornOffset: s.choice.servo === 'X' ? SPLINE_TOOTH : 0 }),
  product: (el, h, o) => createSpinProduct(el, h, o),
};

export const LENS: Template = {
  id: 'lens',
  caption: t('Lens buddy · base Ø50 mm, lens Ø40 mm (estimate)'),
  intro: [t('Build the lens buddy'), t('Start with the base')],
  tray: ['dome', 'board', 'bezel', 'base', 'lcd'],
  parts: [
    { id: 'base', name: t('Base'), short: t('Base'), ghost: [0, 0, 180, 100], okMsg: [t('Base in place'), t('USB-C faces back')],
      mini: '<rect x="4" y="18" width="92" height="30" rx="14" fill="#EDEAE2" stroke="#BDB9B0" stroke-width="1.5"/>',
      iso: '<rect width="180" height="100" rx="30" fill="#EDEAE2" stroke="#BDB9B0" stroke-width="1.5"/>' },
    { id: 'board', name: t('ESP32-S3 dev board'), short: t('Board'), ghost: [20, 20, 120, 60], okMsg: [t('Board goes into the base'), t('SPI cable faces up')], mini: BOARD_MINI, iso: BOARD_ISO },
    { id: 'lcd', name: t('Round screen GC9A01'), short: t('Round screen'), ghost: [54, 14, 72, 72], okMsg: [t('Round screen clips into the bracket'), t('Screen faces up')], mini: LCD_MINI, iso: LCD_ISO },
    { id: 'bezel', name: t('Screen bezel'), short: t('Bezel'), ghost: [46, 6, 88, 88], okMsg: [t('Bezel holds the screen down'), t('The bezel has two click positions')],
      mini: '<circle cx="50" cy="30" r="27" fill="none" stroke="#BDB9B0" stroke-width="7"/>',
      iso: '<circle cx="90" cy="50" r="40" fill="none" stroke="#D6D1C6" stroke-width="8"/>' },
    { id: 'dome', name: t('Convex lens dome'), short: t('Lens dome'), ghost: [46, 6, 88, 88],
      mini: '<circle cx="50" cy="30" r="26" fill="#BFD3E6" fill-opacity="0.5" stroke="#8A9BAD" stroke-width="2"/><path d="M34 20 A20 20 0 0 1 48 10" fill="none" stroke="#FFF" stroke-width="3"/>',
      iso: '<circle cx="90" cy="50" r="40" fill="#BFD3E6" fill-opacity="0.45" stroke="#8A9BAD" stroke-width="2"/>',
      spots: [
        { key: 'H', label: t('High notch (8 mm above screen)'), ok: true, msg: [t('Lens 8 mm above the screen'), t('About 1.35× magnification, looks more 3D')] },
        { key: 'N', label: t('Low notch (touching the screen)'), ok: false, msg: [t('Lens touches the screen'), t('Barely magnifies, looks flat')] },
      ] },
  ],
  checks: (s) => [
    row(t('Lens height'), has(s, 'dome'), s.choice.dome === 'H', t('8 mm above screen, about 1.35×'), t('Touching the screen, about 1.08×')),
    row(t('Screen cable'), has(s, 'lcd'), true, t('10 cm, reaches the board')),
    row(t('Bezel clips'), has(s, 'bezel'), true, t('All 4 clips engaged')),
    row(t('Total height'), has(s, 'dome'), true, '62 mm'),
  ],
  effects: (s) => ({ lensScale: s.choice.dome === 'N' ? 1.08 : 1.35 }),
  product: (el, h) => createLensProduct(el, h),
};

const KNOB_MINI = '<rect x="28" y="12" width="44" height="36" rx="3" fill="#1f55b0"/><circle cx="50" cy="30" r="13" fill="#1B1D21"/><rect x="48" y="18" width="4" height="8" fill="#F2F2F2"/>';
const STRIP_MINI = '<rect x="4" y="22" width="92" height="16" rx="2" fill="#16181b"/>' + Array.from({ length: 8 }, (_, i) => `<rect x="${9 + i * 11}" y="26" width="8" height="8" fill="#F2F0EA"/><circle cx="${13 + i * 11}" cy="30" r="2.6" fill="#FFB060"/>`).join('');
const OLED_MINI = '<rect x="12" y="4" width="76" height="52" rx="3" fill="#1C4F86"/><rect x="18" y="12" width="64" height="34" fill="#050608"/><path d="M26 24 L46 24 M26 32 L60 32" stroke="#D7F3FF" stroke-width="3"/>';

export const LAMP: Template = {
  id: 'lamp',
  caption: t('Knob lamp · base 80×60×36 mm, shade Ø70 mm (estimate)'),
  intro: [t('Build the lamp'), t('Start with the lamp base')],
  tray: ['shade', 'knob', 'base', 'strip', 'board'],
  parts: [
    { id: 'base', name: t('Lamp base'), short: t('Lamp base'), ghost: [0, 0, 180, 100], okMsg: [t('Lamp base in place'), t('DC jack and USB-C on the back')],
      mini: '<rect x="4" y="14" width="92" height="36" rx="8" fill="#3A3936"/><rect x="40" y="6" width="20" height="10" fill="#E8E5DE"/>',
      iso: '<rect width="180" height="100" rx="16" fill="#3A3936" stroke="#141414" stroke-width="1.5"/><rect x="80" y="34" width="20" height="32" rx="3" fill="#E8E5DE"/>' },
    { id: 'board', name: t('ESP32-S3 dev board'), short: t('Board'), ghost: [20, 20, 120, 60], okMsg: [t('Board clips into the lamp base'), t('GPIO5 to strip · GPIO6/7/15 to knob')], mini: BOARD_MINI, iso: BOARD_ISO },
    { id: 'knob', name: t('EC11 knob'), short: t('Knob'), ghost: [132, 56, 40, 36], okMsg: [t('Knob shaft through the front panel'), t('7 mm sticks out, easy to press')], mini: KNOB_MINI,
      iso: '<rect x="132" y="56" width="40" height="36" rx="3" fill="#1f55b0"/><circle cx="152" cy="74" r="12" fill="#1B1D21"/>' },
    { id: 'strip', name: t('WS2812 strip'), short: t('LED strip'), spotSize: [96, 18], mini: STRIP_MINI,
      iso: '<rect width="96" height="18" rx="2" fill="#16181b"/>' + Array.from({ length: 8 }, (_, i) => `<circle cx="${8 + i * 11.4}" cy="9" r="3.4" fill="#FFB060"/>`).join(''),
      spots: [
        { key: 'A', label: t('On the light pipe (15 mm from shade)'), at: [42, 41], ok: true, msg: [t('Strip on the light pipe'), t('The shade glows evenly')] },
        { key: 'B', label: t('Against the inside of the shade'), at: [42, 4], ok: false, msg: [t('LEDs touch the shade'), t('8 glaring hot spots on the shade, uneven light (estimate)')] },
      ] },
    { id: 'shade', name: t('Opal shade'), short: t('Shade'), ghost: [0, 0, 180, 100], okMsg: [t('Shade snapped on'), t('Click “Next: product”')],
      mini: '<path d="M20 56 C14 30 24 6 50 4 C76 6 86 30 80 56 Z" fill="#F4F1EA" stroke="#BDB9B0" stroke-width="2"/>',
      iso: '<rect width="180" height="100" rx="40" fill="#F4F1EA" stroke="#BDB9B0" stroke-width="1.5" opacity="0.7"/>' },
  ],
  checks: (s) => [
    row(t('Strip position'), has(s, 'strip'), s.choice.strip === 'A', t('On the light pipe, 15 mm from shade, even light'), t('Against the shade, a row of hot spots')),
    row(t('Knob'), has(s, 'knob'), true, t('Shaft 7 mm out of the panel, easy to press')),
    row(t('Power'), has(s, 'base'), true, t('Strip on external 5 V, DC jack on the back')),
    row(t('Total height'), has(s, 'shade'), true, '110 mm'),
  ],
  effects: (s) => ({ glare: s.choice.strip === 'B' }),
  product: (el) => createLampProduct(el, { pin: 5 }),
};

export const RULER: Template = {
  id: 'ruler',
  caption: t('Ultrasonic ruler · case 90×48×30 mm, sensor holes Ø17 mm (estimate)'),
  intro: [t('Build the ruler'), t('Start with the back shell')],
  tray: ['front', 'oled', 'sonar', 'buzzer', 'shell', 'board'],
  parts: [
    { id: 'shell', name: t('Back shell'), short: t('Back shell'), ghost: [0, 0, 180, 100], okMsg: [t('Back shell in place'), t('USB-C cutout at the tail')],
      mini: '<rect width="100" height="60" rx="8" fill="#2B5FD9" stroke="#1E4BB5" stroke-width="1.5"/><rect x="6" y="6" width="88" height="48" rx="5" fill="#244FB8"/>',
      iso: '<rect width="180" height="100" rx="12" fill="#2B5FD9" stroke="#1E4BB5" stroke-width="1.5"/><rect x="8" y="8" width="164" height="84" rx="8" fill="#244FB8"/><rect x="172" y="30" width="8" height="40" fill="#141414"/>' },
    { id: 'board', name: t('ESP32-S3 dev board'), short: t('Board'), ghost: [14, 20, 120, 60], okMsg: [t('Board clipped in'), t('GPIO17/18 to sensor · SDA/SCL to screen · GPIO5 to buzzer')], mini: BOARD_MINI,
      iso: '<rect x="14" y="20" width="120" height="60" rx="3" fill="#141414"/><rect x="68" y="28" width="56" height="44" rx="2" fill="#BDB9B0"/>' },
    { id: 'sonar', name: t('HC-SR04 sensor'), short: t('Sensor'), spotSize: [26, 72],
      mini: '<rect x="8" y="16" width="84" height="28" rx="3" fill="#2F7FC8"/><circle cx="30" cy="30" r="11" fill="#B8BCC2"/><circle cx="70" cy="30" r="11" fill="#B8BCC2"/>',
      iso: '<rect width="26" height="72" rx="3" fill="#2F7FC8"/><circle cx="13" cy="18" r="10" fill="#B8BCC2"/><circle cx="13" cy="54" r="10" fill="#B8BCC2"/>',
      spots: [
        { key: 'A', label: t('Transducers poke out of the front holes'), at: [150, 14], ok: true, msg: [t('Both transducers stick out 1 mm'), t('Sound goes straight to the object ahead')] },
        { key: 'B', label: t('Transducers 6 mm behind the holes'), at: [140, 14], ok: false, msg: [t('Transducers recessed in the holes'), t('Echoes bounce off the hole wall first: reads about {n} cm and the buzzer never stops', { n: SONAR_BLOCK_CM })] },
      ] },
    { id: 'buzzer', name: t('Passive buzzer module'), short: t('Buzzer'), ghost: [108, 72, 28, 24], okMsg: [t('Buzzer lined up with the sound hole'), t('Sound comes out the side')],
      mini: '<rect x="30" y="10" width="40" height="40" rx="3" fill="#1f55b0"/><circle cx="50" cy="30" r="14" fill="#141416"/>',
      iso: '<rect x="108" y="72" width="28" height="24" rx="2" fill="#1f55b0"/><circle cx="122" cy="84" r="9" fill="#141416"/>' },
    { id: 'oled', name: 'OLED 0.96″', short: 'OLED', ghost: [30, 30, 80, 40], okMsg: [t('Screen lined up with the top window'), t('Cable 8 cm')], mini: OLED_MINI,
      iso: '<rect x="30" y="30" width="80" height="40" rx="3" fill="#1C4F86"/><rect x="36" y="36" width="68" height="28" fill="#050608"/>' },
    { id: 'front', name: t('Top cover and front panel'), short: t('Top cover'), ghost: [0, 0, 180, 100], okMsg: [t('Closed'), t('Click “Next: product”')],
      mini: '<rect width="100" height="60" rx="8" fill="#3A6DE0" stroke="#1E4BB5" stroke-width="1.5"/><rect x="18" y="16" width="44" height="26" rx="2" fill="none" stroke="#F2F2F2" stroke-width="2"/>',
      iso: '<rect width="180" height="100" rx="12" fill="#3A6DE0" stroke="#1E4BB5" stroke-width="1.5" opacity="0.7"/><rect x="36" y="36" width="68" height="28" rx="2" fill="none" stroke="#F2F2F2" stroke-width="2"/>' },
  ],
  checks: (s) => [
    row(t('Sonar position'), has(s, 'sonar'), s.choice.sonar === 'A', t('1 mm out of the front panel, measures what is ahead'), t('Recessed, reads about {n} cm', { n: SONAR_BLOCK_CM })),
    row(t('Echo divider'), has(s, 'board'), true, t('1 kΩ / 2 kΩ on the Echo line')),
    row(t('Screen cable'), has(s, 'oled'), true, t('8 cm, needs ≥ 6 cm')),
    row(t('Sound hole'), has(s, 'buzzer'), true, t('Buzzer faces the side sound hole')),
  ],
  effects: (s) => ({ sonarBlock: s.choice.sonar === 'B' ? SONAR_BLOCK_CM : 0 }),
  product: (el) => createRulerProduct(el),
};

export const TILT: Template = {
  id: 'tilt',
  caption: t('Tilt buddy · disc Ø56 × 26 mm (estimate)'),
  intro: [t('Build the tilt buddy'), t('Start with the bottom shell')],
  tray: ['lcd', 'imu', 'lid', 'base', 'board'],
  parts: [
    { id: 'base', name: t('Disc bottom shell'), short: t('Bottom shell'), ghost: [0, 0, 180, 100], okMsg: [t('Bottom shell in place'), t('USB-C cutout on the side')],
      mini: '<ellipse cx="50" cy="32" rx="46" ry="24" fill="#ECE9E2" stroke="#BDB9B0" stroke-width="1.5"/>',
      iso: '<rect width="180" height="100" rx="46" fill="#ECE9E2" stroke="#BDB9B0" stroke-width="1.5"/><path d="M150 50 L166 50 M160 44 L166 50 L160 56" stroke="#8A867E" stroke-width="2" fill="none"/>' },
    { id: 'imu', name: t('QMI8658 6-axis IMU'), short: t('IMU'), ghost: [128, 37, 34, 26],
      mini: '<rect x="30" y="14" width="40" height="32" rx="3" fill="#1C6B4A"/><rect x="44" y="24" width="12" height="12" fill="#141414"/><path d="M50 18 L50 10 M46 14 L50 10 L54 14" stroke="#F2F2F2" stroke-width="2" fill="none"/>',
      iso: '<rect x="128" y="37" width="34" height="26" rx="2" fill="#1C6B4A"/><rect x="139" y="44" width="12" height="12" fill="#141414"/>',
      spots: [
        { key: 'A', label: t('Flat on the base, arrow forward'), ok: true, msg: [t('IMU flat on the base, X axis forward'), t('Bean rolls the way you tilt')] },
        { key: 'B', label: t('Turned 180°, backwards'), ok: false, msg: [t('IMU is backwards'), t('Pitch and roll are reversed, Bean climbs uphill')] },
      ] },
    { id: 'board', name: t('ESP32-S3 dev board'), short: t('Board'), ghost: [10, 20, 110, 60], okMsg: [t('Board goes into the bottom shell'), t('SPI to round screen · I2C to IMU')], mini: BOARD_MINI,
      iso: '<rect x="10" y="20" width="110" height="60" rx="3" fill="#141414"/><rect x="62" y="28" width="52" height="44" rx="2" fill="#BDB9B0"/>' },
    { id: 'lcd', name: t('Round screen GC9A01'), short: t('Round screen'), ghost: [54, 14, 72, 72], okMsg: [t('Round screen clips into the top'), t('Screen faces up')], mini: LCD_MINI, iso: LCD_ISO },
    { id: 'lid', name: t('Top cover'), short: t('Top cover'), ghost: [0, 0, 180, 100], okMsg: [t('Top cover holds the round screen'), t('Click “Next: product”')],
      mini: '<circle cx="50" cy="30" r="27" fill="none" stroke="#BDB9B0" stroke-width="7"/>',
      iso: '<rect width="180" height="100" rx="46" fill="#F2EFE8" stroke="#BDB9B0" stroke-width="1.5" opacity="0.7"/><circle cx="90" cy="50" r="36" fill="none" stroke="#141414" stroke-width="2"/>' },
  ],
  checks: (s) => [
    row(t('IMU orientation'), has(s, 'imu'), s.choice.imu === 'A', t('Flat, arrow forward, correct'), t('Backwards, Bean climbs uphill')),
    row(t('IMU position'), has(s, 'imu'), true, t('Near the disc centre, spinning won’t skew readings (estimate)')),
    row(t('Round screen cable'), has(s, 'lcd'), true, t('8 cm, reaches the board')),
    row(t('Total height'), has(s, 'lid'), true, '26 mm'),
  ],
  effects: (s) => ({ imuFlip: s.choice.imu === 'B' }),
  product: (el) => createTiltProduct(el),
};

const KEYS_ISO = [0, 1, 2, 3].map((i) => `<rect x="${36 + i * 30}" y="38" width="20" height="20" rx="3" fill="#1B1D21"/>`).join('');
const CAPS_ISO = [0, 1, 2, 3].map((i) => `<rect x="${32 + i * 30}" y="34" width="28" height="28" rx="5" fill="${i === 3 ? '#0D99FF' : '#F2EFE8'}" stroke="#141414" stroke-width="1.5"/>`).join('');

export const USBKEY: Template = {
  id: 'usbkey',
  caption: t('USB keypad · case 80×44×22 mm (estimate)'),
  intro: [t('Build the keypad'), t('Start with the bottom shell')],
  tray: ['caps', 'board', 'plate', 'base', 'keys'],
  parts: [
    { id: 'base', name: t('Bottom shell'), short: t('Bottom shell'), ghost: [0, 0, 180, 100], okMsg: [t('Bottom shell in place'), t('USB-C cutout on the back')],
      mini: '<rect width="100" height="60" rx="8" fill="#E9E5DC" stroke="#8A867E" stroke-width="1.5"/><rect x="6" y="6" width="88" height="48" rx="5" fill="#D6D1C6"/><rect x="0" y="22" width="6" height="14" fill="#3A3936"/>',
      iso: SHELL_ISO },
    { id: 'board', name: t('ESP32-S3 dev board'), short: t('Board'), ghost: [20, 20, 120, 60], mini: BOARD_MINI, iso: BOARD_ISO,
      spots: [
        { key: 'U', label: t('USB / OTG port toward the back cutout'), ok: true, msg: [t('USB port lined up with the cutout'), t('The cable fits, the computer sees a keyboard')] },
        { key: 'R', label: t('Backwards 180°, USB port faces front'), ok: false, msg: [t('USB port hits the front wall'), t('No cable fits, the computer sees no device')] },
      ] },
    { id: 'keys', name: t('Tactile switches × 4'), short: t('Switches'), ghost: [30, 32, 120, 32], okMsg: [t('Switches clip in under the plate'), t('K1–K4 to GPIO4–7, other side to GND')],
      mini: '<rect x="4" y="18" width="92" height="24" rx="3" fill="#2A2A28"/>' + [0, 1, 2, 3].map((i) => `<rect x="${10 + i * 22}" y="22" width="16" height="16" rx="2" fill="#1B1D21" stroke="#555"/>`).join(''),
      iso: KEYS_ISO },
    { id: 'plate', name: t('Plate'), short: t('Plate'), ghost: [0, 0, 180, 100], okMsg: [t('Plate on'), t('4 key holes line up with the switches')],
      mini: '<rect width="100" height="60" rx="8" fill="#F2EFE8" stroke="#8A867E" stroke-width="1.5"/>' + [0, 1, 2, 3].map((i) => `<rect x="${12 + i * 21}" y="22" width="14" height="14" fill="#8A867E"/>`).join(''),
      iso: '<rect width="180" height="100" rx="10" fill="#F2EFE8" stroke="#8A867E" stroke-width="1.5" opacity="0.7"/>' + [0, 1, 2, 3].map((i) => `<rect x="${34 + i * 30}" y="36" width="24" height="24" fill="#3A3936"/>`).join('') },
    { id: 'caps', name: t('Keycaps × 4'), short: t('Keycaps'), ghost: [30, 32, 120, 32], okMsg: [t('Keycaps pressed on'), t('Click “Next: product”')],
      mini: [0, 1, 2, 3].map((i) => `<rect x="${6 + i * 23}" y="16" width="20" height="20" rx="4" fill="${i === 3 ? '#0D99FF' : '#F2EFE8'}" stroke="#141414"/>`).join(''),
      iso: CAPS_ISO },
  ],
  checks: (s) => [
    row(t('USB port direction'), has(s, 'board'), s.choice.board === 'U', t('Lined up with the back cutout'), t('Faces front, no cable fits')),
    row(t('Key travel'), has(s, 'caps'), true, t('Keycaps 1.5 mm above the plate, full travel')),
    row(t('Inner height'), has(s, 'plate'), true, t('Switches and board use 14 / 18 mm')),
  ],
  effects: (s) => ({ usbBlocked: s.choice.board === 'R' }),
  product: (el, h) => {
    const v = createKeypadView(el, { press: (pin, d) => h.press?.(pin, d) });
    return { update: () => {}, setUsb: v.setUsb };
  },
};

// G-03 RFID door: wall panel 86×120×28 mm lying on its side (120 mm across), about 1.16 px per mm
const RC522_MINI = '<rect x="20" y="4" width="60" height="52" rx="3" fill="#1F4FA8"/><rect x="28" y="10" width="44" height="34" rx="6" fill="none" stroke="#E8C547" stroke-width="2.5"/><rect x="34" y="46" width="32" height="6" fill="#E8C547"/>';
const RC522_ISO = '<rect x="104" y="14" width="46" height="70" rx="3" fill="#1F4FA8"/><rect x="110" y="20" width="34" height="50" rx="6" fill="none" stroke="#E8C547" stroke-width="2.5"/><rect x="146" y="30" width="4" height="34" fill="#E8C547"/>';

export const DOOR: Template = {
  id: 'door',
  caption: t('RFID door · wall panel 86×120×28 mm (estimate)'),
  intro: [t('Build the door reader'), t('Start with the back box')],
  tray: ['front', 'rc522', 'led', 'oled', 'relay', 'buzzer', 'back', 'board'],
  parts: [
    { id: 'back', name: t('Steel back box'), short: t('Back box'), ghost: [0, 0, 180, 100], okMsg: [t('Back box screwed to the wall'), t('Cable entry at the bottom')],
      mini: '<rect x="8" y="4" width="84" height="52" rx="6" fill="#8A8E94" stroke="#5A5E64" stroke-width="1.5"/><rect x="14" y="10" width="72" height="40" rx="4" fill="#9EA3A9"/><circle cx="50" cy="30" r="5" fill="#5A5E64"/>',
      iso: '<rect x="20" width="140" height="100" rx="8" fill="#8A8E94" stroke="#5A5E64" stroke-width="1.5"/><rect x="26" y="6" width="128" height="88" rx="5" fill="#9EA3A9"/><circle cx="90" cy="50" r="6" fill="#5A5E64"/>' },
    { id: 'board', name: t('ESP32-C3 dev board'), short: t('Board'), ghost: [26, 66, 57, 30], okMsg: [t('Board on standoffs, off the steel'), t('SPI to reader · I2C to screen · GPIO10 to relay')], mini: BOARD_MINI,
      iso: '<rect x="26" y="66" width="57" height="30" rx="3" fill="#141414"/><rect x="56" y="70" width="23" height="22" rx="2" fill="#BDB9B0"/><circle cx="36" cy="72" r="3" fill="#22C55E"/>' },
    { id: 'relay', name: t('Relay module'), short: t('Relay'), ghost: [26, 2, 58, 30], okMsg: [t('Relay module in place'), t('Strike on COM / NO, 12 V stays off the board')],
      mini: '<rect x="12" y="10" width="76" height="40" rx="3" fill="#1F55B0"/><rect x="20" y="16" width="34" height="28" rx="2" fill="#2563EB"/><rect x="62" y="18" width="20" height="24" fill="#2E8B57"/>',
      iso: '<rect x="26" y="2" width="58" height="30" rx="3" fill="#1F55B0"/><rect x="32" y="7" width="26" height="20" rx="2" fill="#2563EB"/><rect x="64" y="8" width="16" height="18" fill="#2E8B57"/>' },
    { id: 'buzzer', name: t('Passive buzzer module'), short: t('Buzzer'), ghost: [86, 36, 15, 37], okMsg: [t('Buzzer behind the sound slots'), t('GPIO1, 2.7 kHz')],
      mini: '<rect x="30" y="10" width="40" height="40" rx="3" fill="#1f55b0"/><circle cx="50" cy="30" r="14" fill="#141416"/>',
      iso: '<rect x="86" y="36" width="15" height="37" rx="2" fill="#1f55b0"/><circle cx="93.5" cy="48" r="6" fill="#141416"/>' },
    { id: 'led', name: t('Red LED + 330 Ω'), short: t('Red LED'), ghost: [86, 80, 14, 14], okMsg: [t('LED pushed into the panel hole'), t('GPIO0 through 330 Ω')],
      mini: '<circle cx="50" cy="26" r="12" fill="#E5484D"/><rect x="38" y="26" width="24" height="10" fill="#E5484D"/><path d="M44 36 L44 54 M56 36 L56 50" stroke="#8A867E" stroke-width="2.5"/>',
      iso: '<rect x="86" y="80" width="14" height="14" rx="2" fill="#2A2A28"/><circle cx="93" cy="87" r="5" fill="#E5484D"/>' },
    { id: 'oled', name: 'OLED 1.3″ SH1106', short: 'OLED', ghost: [34, 34, 41, 39], okMsg: [t('Screen lined up with the window'), t('Cable 10 cm')], mini: OLED_MINI,
      iso: '<rect x="34" y="34" width="41" height="39" rx="3" fill="#1C4F86"/><rect x="37" y="42" width="35" height="22" fill="#050608"/>' },
    { id: 'rc522', name: t('RC522 reader module'), short: 'RC522', ghost: [104, 14, 46, 70], mini: RC522_MINI, iso: RC522_ISO,
      spots: [
        { key: 'A', label: t('Against the card zone, 2 mm behind the front'), ok: true, msg: [t('Reader against the card zone'), t('Cards read through 2 mm of plastic')] },
        { key: 'B', label: t('On the steel back box, 24 mm behind the front'), ok: false, msg: [t('Reader on the steel back box'), t('Steel behind the antenna and 24 mm of air: no card is ever read (estimate)')] },
      ] },
    { id: 'front', name: t('Front panel'), short: t('Front panel'), ghost: [0, 0, 180, 100], okMsg: [t('Closed'), t('Click “Next: product”')],
      mini: '<rect x="8" y="4" width="84" height="52" rx="6" fill="#2F3338"/><rect x="18" y="16" width="26" height="18" rx="2" fill="none" stroke="#F2F2F2" stroke-width="2"/><rect x="56" y="12" width="28" height="36" rx="4" fill="none" stroke="#9AA3AD" stroke-width="2" stroke-dasharray="4 3"/>',
      iso: '<rect x="20" width="140" height="100" rx="10" fill="#2F3338" stroke="#141414" stroke-width="1.5" opacity="0.72"/><rect x="37" y="42" width="35" height="22" rx="2" fill="none" stroke="#F2F2F2" stroke-width="2"/><rect x="104" y="14" width="46" height="70" rx="6" fill="none" stroke="#9AA3AD" stroke-width="2" stroke-dasharray="5 4"/><circle cx="93" cy="87" r="3" fill="#E5484D"/>' },
  ],
  checks: (s) => [
    row(t('Reader position'), has(s, 'rc522'), s.choice.rc522 === 'A', t('Against the card zone, reads through 2 mm of plastic'), t('On the steel back box, no card is read')),
    row(t('Strike wiring'), has(s, 'relay'), true, t('12 V strike on COM / NO, never into the board (needs real hardware)')),
    row(t('Screen window'), has(s, 'oled'), true, t('1.3″ module lined up, cable 10 cm')),
    row(t('Board mounting'), has(s, 'board'), true, t('On plastic standoffs, 6 mm off the steel')),
  ],
  effects: (s) => ({ cardBlock: s.choice.rc522 === 'B' }),
  product: (el) => createDoorProduct(el),
};

// G-04 IR night light: the knob lamp's base 80×60×36 mm and Ø70 mm shade; the knob hole becomes a 12×8 mm IR window
const IRRX_MINI = '<rect x="38" y="6" width="24" height="26" rx="2" fill="#141416"/><circle cx="50" cy="16" r="8" fill="#26262B"/><path d="M42 32 L42 54 M50 32 L50 54 M58 32 L58 54" stroke="#8A867E" stroke-width="2.5"/>';
const SHIFTER_MINI = '<rect x="18" y="12" width="64" height="36" rx="3" fill="#1F55B0"/><rect x="34" y="20" width="32" height="20" rx="1" fill="#141414"/><path d="M38 20 L38 14 M46 20 L46 14 M54 20 L54 14 M62 20 L62 14" stroke="#BDB9B0" stroke-width="2"/>';

export const IRLAMP: Template = {
  id: 'irlamp',
  caption: t('IR night light · base 80×60×36 mm, shade Ø70 mm, IR window 12×8 mm (estimate)'),
  intro: [t('Build the night light'), t('Start with the lamp base')],
  tray: ['shade', 'irrx', 'base', 'strip', 'board', 'shifter'],
  parts: [
    { id: 'base', name: t('Lamp base'), short: t('Lamp base'), ghost: [0, 0, 180, 100], okMsg: [t('Lamp base in place'), t('IR window in the front, DC jack on the back')],
      mini: '<rect x="4" y="14" width="92" height="36" rx="8" fill="#3A3936"/><rect x="40" y="6" width="20" height="10" fill="#E8E5DE"/><rect x="72" y="28" width="12" height="8" rx="1" fill="#3A1418"/>',
      iso: '<rect width="180" height="100" rx="16" fill="#3A3936" stroke="#141414" stroke-width="1.5"/><rect x="80" y="34" width="20" height="32" rx="3" fill="#E8E5DE"/><rect x="138" y="94" width="28" height="6" rx="1" fill="#3A1418"/>' },
    { id: 'board', name: t('ESP32-S3 dev board'), short: t('Board'), ghost: [20, 20, 120, 60], okMsg: [t('Board clips into the lamp base'), t('GPIO4 from the receiver · GPIO5 to the level shifter')], mini: BOARD_MINI, iso: BOARD_ISO },
    { id: 'shifter', name: t('74AHCT125 level shifter'), short: t('Level shifter'), ghost: [146, 16, 28, 30], okMsg: [t('Level shifter next to the board'), t('GPIO5 3.3 V lifted to 5 V for the strip DIN')], mini: SHIFTER_MINI,
      iso: '<rect x="146" y="16" width="28" height="30" rx="2" fill="#1F55B0"/><rect x="152" y="22" width="16" height="18" fill="#141414"/>' },
    { id: 'strip', name: t('WS2812 strip'), short: t('LED strip'), spotSize: [96, 18], mini: STRIP_MINI,
      iso: '<rect width="96" height="18" rx="2" fill="#16181b"/>' + Array.from({ length: 8 }, (_, i) => `<circle cx="${8 + i * 11.4}" cy="9" r="3.4" fill="#FFB060"/>`).join(''),
      spots: [
        { key: 'A', label: t('On the light pipe (15 mm from shade)'), at: [42, 41], ok: true, msg: [t('Strip on the light pipe'), t('The shade glows evenly')] },
        { key: 'B', label: t('Against the inside of the shade'), at: [42, 4], ok: false, msg: [t('LEDs touch the shade'), t('8 glaring hot spots on the shade, uneven light (estimate)')] },
      ] },
    { id: 'irrx', name: t('VS1838B IR receiver'), short: t('IR receiver'), spotSize: [20, 16], mini: IRRX_MINI,
      iso: '<rect width="20" height="16" rx="2" fill="#141416"/><circle cx="10" cy="11" r="5" fill="#26262B"/>',
      spots: [
        { key: 'A', label: t('In the IR window'), at: [142, 82], ok: true, msg: [t('Receiver in the IR window'), t('The remote reaches it from across the room')] },
        { key: 'B', label: t('Behind the solid wall'), at: [142, 52], ok: false, msg: [t('Receiver behind the opaque wall'), t('3 mm of opaque PLA blocks the 940 nm light: no remote code arrives (estimate)')] },
      ] },
    { id: 'shade', name: t('Opal shade'), short: t('Shade'), ghost: [0, 0, 180, 100], okMsg: [t('Shade snapped on'), t('Click “Next: product”')],
      mini: '<path d="M20 56 C14 30 24 6 50 4 C76 6 86 30 80 56 Z" fill="#F4F1EA" stroke="#BDB9B0" stroke-width="2"/>',
      iso: '<rect width="180" height="100" rx="40" fill="#F4F1EA" stroke="#BDB9B0" stroke-width="1.5" opacity="0.7"/>' },
  ],
  checks: (s) => [
    row(t('IR receiver'), has(s, 'irrx'), s.choice.irrx === 'A', t('Dome in the IR window, in sight of the remote'), t('Behind the opaque wall, no remote code gets through')),
    row(t('Strip position'), has(s, 'strip'), s.choice.strip === 'A', t('On the light pipe, 15 mm from shade, even light'), t('Against the shade, a row of hot spots')),
    row(t('Level shifter'), has(s, 'shifter'), true, t('74AHCT125 drives DIN at 5 V logic')),
    row(t('Power'), has(s, 'base'), true, t('Strip on external 5 V 2 A, up to 488 mA at full white (estimate)')),
  ],
  effects: (s) => ({ glare: s.choice.strip === 'B', irBlock: s.choice.irrx === 'B' }),
  // Same strip on GPIO5 as the knob lamp; G-04b's irlamp product view replaces this after the merge
  product: (el, h) => createIrlampProduct(el, { pin: 5, send: h.ir }),
};

export const TEMPLATES: Record<string, Template> = { weather: WEATHER, spin: SPIN, lens: LENS, usbkey: USBKEY, lamp: LAMP, ruler: RULER, tilt: TILT, door: DOOR, irlamp: IRLAMP };
