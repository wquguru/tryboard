// Step ④ Product (P1-10): product3d / lcd3d / works3d, SVG fallback without WebGL. Shares the live sim (no restart); mounting drift applies only here.
// The heat source warms the air around the station with a first-order lag (enclosure inertia); every reading comes from firmware.
import { createProduct3D, type ProductScene } from '../product3d';
import { createLcd3D, webglOk, type Lcd3D } from '../lcd3d';
import { createTilt3D, type Tilt3D } from '../tilt3d';
import { onFrame, PRIO } from '../../ui/frame';
import { createWork3D, type WorkKind, type WorkProduct3D } from '../works3d';
import { gravity } from '../../imupose';
import { createLensProduct, createSpinProduct } from '../../views/lcdproducts';
import { type Template } from '../../views/templates';
import { workTemplate } from '../../views/worktpl';
import { doorActs, doorButtons, doorLive, doorOnReader, doorRows, doorSerial, doorTap, doorTool } from './door';
import { cloudActs, cloudButtons, cloudLive, cloudRows, cloudSend, cloudSerial, cloudTool } from './cloud';
import { amoclockActs, amoclockButtons, amoclockLive, amoclockRows, amoclockSerial, amoclockTool, amoSync } from './amoclock';
import { dialHandlers, dialProduct3D, dialStandOf, dialtimerActs, dialtimerButtons, dialtimerLive, dialtimerRows, dialtimerSerial, dialtimerTool } from './dialtimer';
import type { Dial3D } from '../dial3d';
import { irlampActs, irlampButtons, irlampLive, irlampRows, irlampPress, irlampSend, irlampSerial, irlampTool } from './irlamp';
import { passedCount } from './bench';
import { emptyFrame, ledCss, servoAngle, type LiveFrame } from '../../views/common';
import type { AssemblyState, Session, StepCtx, StepImpl } from '../types';
import type { ReactNode } from 'react';
import type { TimelineStep } from '../timeline';
import { createKeypad3D, type Keypad3D } from '../keypad3d';
import { createKeypadView, KEYPAD_CAPS, KEYPAD_PINS } from '../../views/keypad';
import { isPhone, onPhoneChange, setMui } from '../mobile';
import type { Tool, ToolGroup } from '../toolbar';
import { HOME_WORKS } from '../works';
import { RECORD_SECONDS, download, recordCanvas, takePhoto, type Capturable, type Recording } from '../capture';
import { i2cLoad, i2cSay, i2cText, wifiSay, wifiText } from '../harness';
import { I2C_DEVICES } from '../asmstate';
import { setBc } from '../chrome';
import { BuyCard } from '../buycard';
import { buildChecklist } from '../checklist';
import { Checklist } from '../checklistview';
import { loadBom } from '../bomstore';
import { replay } from '../bom';
import { PROCURE_TEMPLATES, getTemplate, type BuyLine } from '../../catalog/templates';
import { loadHave } from '../../advisor/state';
import { PART_MAP } from '../../advisor/catalogmap';
import { Conf, type ConfLevel } from '../../ui/conf';
import { Said } from '../../ui/result';
import { t } from '../../i18n';

import { Host, Txt } from '../../ui/native';
import { Brief, Btn, Btns, Kv, LinkBtn, LockCard, Note, Ph, PhT, Res, Sec, TnL, TnM, TnSt, TreeEmpty, TreeGroup, TreeNode, TreeRow, btnClass, tnClass, type ResKind } from '../../ui/panel';
import { lab } from '../../ui/links';

/** Live field: starts as "—", updateLive rewrites it by data-live */
const row = (k: string, live: string) => <Kv key={live} k={k} live={live} v="—" />;
/** Status strip above the product (reference product / inclinometer) */
const Banner = ({ head, sub }: { head: string; sub: string }) => (
  <div className="prod-preview" role="status">
    <b>{head}</b>
    <span>{sub}</span>
  </div>
);
/** Colour swatch: live fields are built imperatively */
function swatch(bg: string) {
  const i = document.createElement('i');
  i.className = 'sw mr-1.5 inline-block size-2.5 rounded-[3px] border border-[#0002] align-[-1px]';
  i.style.background = bg;
  return i;
}

/** Max heating near the vent (℃) and enclosure time constant (s): illustrative, not calibrated on real hardware */
const HEAT_MAX = 14;
const TAU = 3;
/** Shared ConfLevel identifier owned by ui/conf.tsx */
const MUST_REAL: ConfLevel = '必须上真机'; // lint: allow-cjk

/** P0-18: first three things to do once the real board arrives (per project) */
const FIRST3: Record<string, [string, string][]> = {
  weather: [
    [t('Identify the board and the RGB LED pin'), t("The onboard RGB on ESP32-S3-DevKitC-1 is GPIO48 on v1.0 and moved to GPIO38 on v1.1. Flash blink first; if it doesn't light, change the pin in the firmware.")],
    [t('I2C scan + chip ID'), t('The "I2C scan" serial line should list 0x3C and 0x76. BME280 with SDO pulled high is 0x77; the chip ID should be 0x60, 0x58 means BMP280 (no humidity).')],
    [t('Calibrate temperature before and after closing the enclosure'), t('Put a thermometer next to it and compare after 10 minutes each time; write the difference into the firmware as an offset. Move the servo alone to the 1.5 ms center before fitting the needle.')],
  ],
  spin: [
    [t('Identify the board and the round display wiring'), t('Check SCLK 12 · MOSI 11 · CS 10 · DC 14 · RST 13 · BL 15. Some round display modules have no BL pin (backlight always on).')],
    [t('Power the servo separately and test it first'), t('On USB power alone the board may reset when the servo moves: run the servo from an external 5 V with ground shared with the dev board. Return it to the 90° center before fitting the horn.')],
    [t('Check the round display colours'), t('Inverted colours mean inversion (INVON) is off; red and blue swapped means the RGB / BGR order is wrong. Both show up in the simulator too, but trust the real screen.')],
  ],
  usbkey: [
    [t('Use the right port and a data cable'), t('ESP32-S3-DevKitC-1 has two Type-C ports: only the one marked USB (or OTG) is native USB; the one marked UART is just serial. Some cables only charge and have no data wires, so nothing appears on the computer.')],
    [t('Flash just the enumeration step first'), t("The computer should show a keyboard called TryBoard Macro Pad (Windows Device Manager / macOS System Information USB). If it doesn't, check that TinyUSB is enabled in sdkconfig with HID count ≥ 1.")],
    [t('For keys, check serial first, then the computer'), t('Each press should print KEY 1 a on serial. If serial shows it but the computer types nothing, the report descriptor is usually wrong, or the gap between press and release reports is too short.')],
  ],
  lens: [
    [t('Identify the board and the round display wiring'), t('Check SCLK 12 · MOSI 11 · CS 10 · DC 14 · RST 13 · BL 15. Some round display modules have no BL pin.')],
    [t('Check the round display colours'), t('Inverted colours mean inversion (INVON) is off; red and blue swapped means the RGB / BGR order is wrong.')],
    [t('Measure the lens height'), t('A lens about 8 mm above the screen magnifies about 1.35× (estimate). Real lenses have different focal lengths, so measure with a ruler before fixing the slot.')],
  ],
  lamp: [
    [t('Wire only the LED strip first, no knob'), t('Flash the firmware for the "LED strip on" checkpoint and make sure all 8 LEDs glow warm white before moving on. Swapped colours (red and green) mean the GRB order is wrong.')],
    [t('Power the LED strip separately, share ground'), t('Feed the strip 5 V from an external supply and always connect its ground to the dev board. Without a shared ground the data line has no reference and the LEDs flicker randomly.')],
    [t('Knob direction and feel'), t('Clockwise should brighten; if reversed, swap the CLK / DT wires. A real EC11 has mechanical bounce, so keep the PCNT glitch filter on.')],
  ],
  ruler: [
    [t('Measure the divider first'), t('Measure Echo after the 1 kΩ / 2 kΩ divider with a multimeter: at most about 3.3 V. Feeding it straight into a GPIO without the divider can damage the chip.')],
    [t('Check against a tape measure'), t('Measure a wall at 10 / 50 / 100 cm. The speed of sound changes with temperature (about 343 m/s at 20 ℃), so a 1–2 % error is normal.')],
    [t('The sensor must stick out of the enclosure'), t('If the sensor sits back inside its hole, readings drop to a few centimetres and the buzzer sounds constantly. After closing the enclosure, test again against a distant wall.')],
  ],
  tilt: [
    [t('Read the pose before drawing'), t('Flash the firmware for the "Read pose" checkpoint first: lying flat, pitch and roll should both be near 0. If WHO_AM_I is not 0x05, check the address first (SA0 to ground is 0x6A).')],
    [t('Check the orientation'), t('Lower the right side and roll should go positive. If not, the module is rotated: either turn it back or flip the sign in the firmware.')],
    [t('Check the round display colours'), t('Inverted colours mean inversion (INVON) is off; red and blue swapped means the RGB / BGR order is wrong.')],
  ],
};

/** What the web page can't show, only real hardware. Titles are English keys (also stored in localStorage), translated when rendered */
const CANNOT: Record<string, [string, string][]> = {
  weather: [
    ['OLED brightness and viewing angle', 'Only which pixels are lit is computed here, not brightness or viewing angle'],
    ['Buzzer tone and volume', 'This is a square-wave approximation; a real buzzer has a resonant peak and its volume depends on the drive'],
    ['Servo torque, jitter and noise', 'The needle inertia is illustrative; a real SG90 jitters and has backlash'],
    ['Actual temperature rise inside the enclosure', 'The "2.5 ℃ high next to the chip" is an estimate; measure it with a thermometer'],
    ['Actual RGB brightness and light-pipe effect', 'Screen brightness is exaggerated; the real LED is much dimmer'],
  ],
  spin: [
    ['Whether the servo has enough torque', "Body balance and horn screw tightness both matter; the web page doesn't compute forces"],
    ['Round display brightness and viewing angle', 'Only pixel colours are computed here, not brightness or viewing angle'],
    ['Turntable noise and jitter', 'An SG90 jitters slightly when holding; you only hear it on real hardware'],
  ],
  usbkey: [
    ['Compatibility with different computers / OSes', 'The virtual host walks through enumeration per the USB spec; real drivers, BIOS support and non-US keyboard layouts can only be tested for real'],
    ['Key feel and bounce', 'A press here is a clean low level; real switches bounce for a few milliseconds, so test debouncing on real hardware'],
    ['USB cable and port quality', "Cable length, loose contacts and charge-only cables are invisible on the web page"],
  ],
  lens: [
    ['Actual lens magnification and distortion', 'Magnification is estimated from the slot height'],
    ['Round display brightness and viewing angle', 'Only pixel colours are computed here, not brightness or viewing angle'],
  ],
  lamp: [
    ['Actual LED brightness and colour temperature', 'Glow is drawn from the 0–255 values the firmware writes, not photometry; the shade diffusion is illustrative'],
    ['EC11 feel and bounce', 'The knob here gives clean quadrature waveforms; real contacts bounce'],
    ['Supply voltage drop', 'Full white at 480 mA is an estimate; wire loss and voltage drop on long strips are not computed'],
  ],
  ruler: [
    ['Echoes from slanted, soft or narrow objects', 'Obstacles here are flat surfaces facing the sensor; real hardware may miss slopes or fabric'],
    ['Effect of temperature on the speed of sound', 'The firmware assumes 343 m/s and the simulator also echoes at 343 m/s'],
    ['Buzzer tone and volume', 'This is a square-wave approximation'],
  ],
  tilt: [
    ['IMU bias, noise and temperature drift', 'The simulator reads exactly the pose you set, with no noise'],
    ['Hand shake while holding it', "The pose here is what you drag; on real hardware the bean moves whenever your hand shakes"],
    ['Round display brightness and viewing angle', 'Only pixel colours are computed here, not brightness or viewing angle'],
  ],
};

const PARTS: Record<string, { id: string; name: string; about: string }[]> = {
  weather: [
    { id: 'shell', name: t('Enclosure 70×50×32 mm'), about: t('3D-printed enclosure (estimated size). The front panel goes on last; the vent is on the right and the BME280 should sit next to it.') },
    { id: 'dial', name: t('Dial needle · SG90'), about: t('GPIO4, 50 Hz, 0.5–2.5 ms pulse maps to 0–40 ℃. The needle angle comes straight from the firmware PWM; the inertia is illustrative.') },
    { id: 'oled', name: 'OLED 0.96″', about: t('SSD1306 (I2C 0x3C). The image is exactly what the firmware draws: big temperature, humidity and pressure below.') },
    { id: 'rgb', name: t('Onboard RGB · light pipe'), about: t('WS2812 (GPIO48): blue below 18 ℃, green below 28 ℃, otherwise red.') },
    { id: 'buzzer', name: t('Passive buzzer'), about: t('GPIO5: alarm at ≥ 30 ℃, 2.7 kHz, 200 ms on / 200 ms off; stops below 29 ℃. Muted by default.') },
    { id: 'boot', name: t('BOOT button'), about: t('GPIO0, pulls to ground when pressed: toggles ℃/℉ on the OLED (serial and the dial always use Celsius).') },
    { id: 'bme', name: 'BME280', about: t('Temperature / humidity / pressure, I2C 0x76. Where it is mounted decides whether it reads room temperature.') },
  ],
  spin: [
    { id: 'body', name: t('Minion body'), about: t('Yellow capsule body, a curl of hair on top, a dark screen visor in front (the round display sits inside) and a tool belt. Stands on an SG90 turntable.') },
    { id: 'servo', name: t('SG90 turntable'), about: t('GPIO4 PWM, turns back and forth ±60°.') },
    { id: 'lcd', name: t('Round display GC9A01'), about: t('SPI2; the image is exactly what the firmware draws.') },
    { id: 'boot', name: t('BOOT button'), about: t('Press once to turn back to the front, again to keep turning.') },
  ],
  usbkey: [
    { id: 'pad', name: t('USB keypad'), about: t('Enclosure 80×44×22 mm (estimate), one row of four keys: K1–K3 send a / b / c, K4 is a macro key that types Hello TryBoard and a newline.') },
    { id: 'keys', name: t('Keys K1–K4'), about: t('GPIO4 / 5 / 6 / 7, other side to ground, internal pull-up. Clicking a keycap in 3D presses it and pulls the pin low.') },
    { id: 'pc', name: t('Virtual computer'), about: t('USB virtual host: really enumerates per the USB spec (gets descriptors, sets the address, reads the report descriptor); the screen shows text rebuilt from the HID reports it receives.') },
  ],
  lens: [
    { id: 'lcd', name: t('Round display GC9A01'), about: t('SPI2; the image is exactly what the firmware draws.') },
    { id: 'dome', name: t('Convex lens dome'), about: t('Ø40 mm plano-convex lens; its height above the screen sets the magnification (estimate). Refraction in 3D is illustrative, not an optical simulation.') },
    { id: 'boot', name: t('BOOT button'), about: t('Changes the expression.') },
  ],
  lamp: [
    { id: 'strip', name: t('WS2812 × 8 · light pipe'), about: t('DIN on GPIO5 (RMT). Each LED colour is the frame the simulator decodes from the pin waveform.') },
    { id: 'knob', name: t('EC11 knob'), about: t('CLK GPIO6 · DT GPIO7 · SW GPIO15, PCNT 4× decoding. Drag or scroll to turn, click to press and switch between brightness and colour.') },
    { id: 'shade', name: t('Milky lampshade'), about: t('3D-printed milky PLA. With the strip against the shade wall, a row of bright spots shows on it (mounting effect, estimate).') },
  ],
  ruler: [
    { id: 'sonar', name: t('HC-SR04 sensor'), about: t('Trig GPIO17 · Echo through a divider to GPIO18. The simulator produces an echo width from the board distance (343 m/s).') },
    { id: 'oled', name: 'OLED 0.96″', about: t('SSD1306 (0x3C): distance in big digits with a distance bar below.') },
    { id: 'buzzer', name: t('Passive buzzer'), about: t('GPIO5, 2.7 kHz: within 1 m each beep is 40 ms with a gap of distance (cm) × 5 ms; within 10 cm it sounds continuously. Muted by default.') },
    { id: 'board', name: t('Wooden board'), about: t('Drag it back and forth on the desk: distance is measured from the sensor face, and the tape measure on the desk has 0 at the sensor.') },
  ],
  tilt: [
    { id: 'disc', name: t('Disc enclosure'), about: t('Drag to tilt it: drag right to lower the right side (roll +), drag down to lower the front (pitch +).') },
    { id: 'imu', name: t('QMI8658 IMU'), about: t('I2C 0x6B. The simulator computes gravity components from the disc pose; mounted backwards, pitch and roll are both reversed (mounting effect).') },
    { id: 'lcd', name: t('Round display GC9A01'), about: t('SPI2; the bean is drawn on this screen, exactly as the firmware draws it.') },
  ],
};

/** Buy card column 3 "check on real hardware": remembers ticked items locally, per project */
const MANUAL_KEY = (w: string) => `tryboard-manual:${w}`;
function loadManual(w: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MANUAL_KEY(w)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveManual(w: string, items: string[]) {
  try {
    localStorage.setItem(MANUAL_KEY(w), JSON.stringify(items));
  } catch {
    /* Private mode: ticks only last for this page */
  }
}

/** Still to buy: the replayed Shop list minus "I have". tryboard-have holds picker part ids, folded into catalog parts (plus extras)
 *  via the picker map; breadboard, jumper wires etc. are already catalog ids and compare as-is */
function remainingLines(work: string): BuyLine[] {
  const bom = replay(loadBom(work));
  const have = new Set<string>();
  for (const id of loadHave()) {
    const m = PART_MAP[id];
    if (m) [m.partId, ...(m.with ?? [])].forEach((x) => have.add(x));
    else have.add(id);
  }
  let lines: BuyLine[] = [];
  try {
    const tpl = getTemplate(bom.template);
    lines = [...tpl.required, ...tpl.suggested];
  } catch {
    /* Template gone: we only lose the "why buy" text */
  }
  return bom.picks
    .filter((p) => !have.has(p.partId))
    .map((p) => ({ partId: p.partId, qty: p.qty ?? 1, why: lines.find((l) => l.partId === p.partId)?.why ?? bom.extra[p.partId] ?? '' }));
}

/** These projects' products live in works3d.ts (P2-09) */
const WORK3D = new Set(['lamp', 'ruler', 'tilt', 'door', 'irlamp', 'cloud']);
/** Product-only 2D views (worktpl.ts PRODUCT_ONLY) until their 3D lands */
const PRODUCT_2D = new Set(['amoclock']);
const COLOR_LABEL: Record<string, string> = { warm: t('Warm white'), red: t('Red'), green: t('Green'), blue: t('Blue'), purple: t('Purple'), white: t('White') };

/** Expression names printed on the lens firmware's serial */
const MOOD_LABEL: Record<string, string> = { normal: t('Normal'), happy: t('Happy'), love: t('Love'), sleepy: t('Sleepy') };

/** Projects selectable in Product follow works.ts, so new projects appear automatically */
const WORK_LIST = HOME_WORKS.map((w) => ({ id: w.id, title: w.title }));

/** Reference assembly: every part placed, correct option for each choice (preview only, never written to the store) */
export function referenceAssembly(T: Template): AssemblyState {
  const placed = T.parts.map((p) => p.id);
  const choice: Record<string, string> = {};
  for (const p of T.parts) {
    const ok = p.spots?.find((x) => x.ok);
    if (ok) choice[p.id] = ok.key;
  }
  return { placed, choice, total: placed.length, clean: true, effects: T.effects({ placed, choice }), retest: null };
}
/** Phone product keys per work (board controls row); works not listed get BOOT (+ heater on weather) */
const WORK_ACTS: Record<string, () => Tool[]> = {
  lamp: () => [{ id: 'p-knob-l', label: t('Knob −1'), icon: 'minus' }, { id: 'p-knob-r', label: t('Knob +1'), icon: 'plus' }, { id: 'p-knob', label: t('Press knob'), icon: 'boot' }],
  ruler: () => [{ id: 'p-near', label: t('Board 10 cm closer'), icon: 'down' }, { id: 'p-far', label: t('Board 10 cm farther'), icon: 'up' }],
  door: doorActs,
  irlamp: irlampActs,
  cloud: cloudActs,
  amoclock: amoclockActs,

  dialtimer: dialtimerActs,
  tilt: () => [{ id: 'p-tilt-r', label: t('Lower the right side'), icon: 'tilt' }, { id: 'p-tilt-l', label: t('Lower the front left'), icon: 'tilt' }, { id: 'p-level', label: t('Make level'), icon: 'minus' }],
  usbkey: () => KEYPAD_PINS.map((pin, i) => ({ id: `p-key-${pin}`, label: `K${i + 1} · ${KEYPAD_CAPS[i]}`, icon: 'key' })),
};

/** Per-work Product hooks kept outside productStep (tools/lint_size.py): serial parser, readings, desktop buttons, live rows, toolbar keys */
type Btns = (id: string, label: string, f: () => void) => ReactNode;
const HOOKS: Record<string, { serial: typeof doorSerial; rows: typeof doorRows; buttons: (b: Btns, s: Session) => ReactNode[]; live: typeof irlampLive; tool: (id: string, s: Session) => void }> = {
  door: { serial: doorSerial, rows: doorRows, buttons: doorButtons, live: doorLive, tool: doorTool },
  irlamp: { serial: irlampSerial, rows: irlampRows, buttons: irlampButtons, live: irlampLive, tool: irlampTool },
  cloud: { serial: cloudSerial, rows: cloudRows, buttons: cloudButtons, live: cloudLive, tool: cloudTool },
  amoclock: { serial: amoclockSerial, rows: amoclockRows, buttons: amoclockButtons, live: amoclockLive, tool: amoclockTool },

  dialtimer: { serial: dialtimerSerial, rows: dialtimerRows, buttons: dialtimerButtons, live: dialtimerLive, tool: dialtimerTool },
};

export function productStep(): StepImpl {
  let ctx: StepCtx | null = null;
  let storeRef: StepCtx['store'] | null = null;
  let unsubs: (() => void)[] = [];
  let hooked = false;
  let node: HTMLElement | null = null;
  let scene3d: ProductScene | null = null;
  let lcd3d: Lcd3D | null = null;
  let keypad: Keypad3D | null = null;
  let dial3d: Dial3D | null = null;
  let keypadSvg: ReturnType<typeof createKeypadView> | null = null;
  /** The 10 s recording in progress */
  let rec: Recording | null = null;
  // Inclinometer (P2-03): no assembly template, the product is a box turned in the hand
  let tilt: Tilt3D | null = null;
  let tiltNode: HTMLElement | null = null;
  let tiltTimer = 0;
  let svgProduct: { update(f: LiveFrame, room: number, fx: object): void } | null = null;
  let work3d: WorkProduct3D | null = null;
  // P2-09: lamp level / mode / colour, ruler reading and beep rhythm, bean position (parsed from whole serial lines)
  let lamp = { level: 0, mode: '', color: '' };
  let ruler = { dist: '', beep: '' };
  let bean = { pos: '', edges: 0 };
  /** Distance / pose the user set (before mounting effects); restored when leaving Product */
  let rawCm = 25;
  let rawPose = { pitch: 0, roll: 0, yaw: 0 };
  let raf: (() => void) | null = null;
  let timer = 0;
  let sel = '';
  let room = 23.5;
  let air = 23.5;
  let heat = { on: false, prox: 0 };
  const events: TimelineStep[] = [];
  let unitF = false;
  /** lens expression and whether spin is parked facing front (parsed from whole serial lines) */
  let mood = '';
  let look = '';
  let alarm = false;
  let tail = '';
  /** Not fully assembled yet: show the reference assembly ("reference product"), labelled at the top */
  let preview = false;

  const sim = () => ctx?.session.sim ?? null;
  const frame = (): LiveFrame => sim()?.frame ?? emptyFrame();
  /** Screen (OLED / round display) has received a non-black frame: regression scripts use this */
  const lit = () => {
    const f = frame();
    const px = f.oled ?? f.lcd;
    return !!px && px.some((v: number) => v !== 0);
  };

  let event = (icon: string, label: string, status?: TimelineStep['status']) => {
    const sec = storeRef?.get().simSeconds ?? 0;
    events.push({ id: `ev:${events.length}`, icon, label: `${label} · ${sec.toFixed(1)} s`, status });
    if (events.length > 60) events.splice(0, events.length - 60);
    if (ctx?.store.get().step === 'product') {
      ctx.shell.timeline.setSteps(events);
      ctx.shell.timeline.setCurrent(events.length - 1);
    }
  };

  /** Serial from before entering Product (since this power-on): update state only, no timeline events */
  let quiet = false;
  function onSerial(text: string) {
    // Whole lines only: a line may be split across two ticks
    const lines = (tail + text).split('\n');
    tail = lines.pop() ?? '';
    const ev = event;
    if (quiet) event = () => {};
    try {
      parseLines(lines);
    } finally {
      event = ev;
    }
  }
  function parseLines(lines: string[]) {
    for (const raw of lines) {
      const l = raw.trim();
      HOOKS[ctx?.work.id ?? '']?.serial(l, event);
      if (l === 'ALARM ON') {
        alarm = true;
        event('!', t('Alarm: ≥ 30 ℃, buzzer sounding'), 'bad');
      } else if (l === 'ALARM OFF') {
        alarm = false;
        event('✓', t('Alarm cleared'), 'ok');
      } else if (/^MOOD \d+ \w+$/.test(l)) {
        mood = l.split(' ')[2];
        event('☺', t('Expression changed: {mood}', { mood: MOOD_LABEL[mood] ?? mood }));
      } else if (l === 'LOOK FRONT' || l === 'LOOK AROUND') {
        look = l === 'LOOK FRONT' ? 'front' : 'around';
        event('↻', look === 'front' ? t('Turned back to the front and stopped') : t('Turning left and right again'));
      } else if (/^LEVEL \d+$/.test(l)) {
        lamp.level = Number(l.slice(6));
      } else if (l === 'MODE color' || l === 'MODE level') {
        lamp.mode = l.slice(5);
        event('◎', lamp.mode === 'color' ? t('Knob now adjusts colour') : t('Knob now adjusts brightness'));
      } else if (/^COLOR \d+ \w+$/.test(l)) {
        lamp.color = l.split(' ')[2];
      } else if (/^DIST /.test(l)) {
        ruler.dist = l.slice(5);
      } else if (/^BEEP /.test(l)) {
        const b = l.slice(5);
        if (b !== ruler.beep) event(b === 'off' ? '○' : '♪', b === 'off' ? t('Buzzer stopped') : b === 'on' ? t('Too close: buzzer sounding continuously') : t('Beep rhythm: pause {gap}', { gap: b.replace('gap=', '') }), b === 'on' ? 'bad' : undefined);
        ruler.beep = b;
      } else if (/^EDGE /.test(l)) {
        bean.edges++;
        event('◉', t('Bean slid to the edge ({edge})', { edge: l.slice(5) }));
      } else if (/^POS /.test(l)) {
        bean.pos = l.slice(4).replace(/ pitch=.*$/, '');
      } else if (l === 'UNIT F' || l === 'UNIT C') {
        unitF = l === 'UNIT F';
        event('°', t('OLED switched to {unit}', { unit: unitF ? '℉' : '℃' }));
      }
    }
  }

  // ------------------------------------------------------------ heat: first-order lag towards the target temperature
  function tickHeat() {
    const c = ctx;
    if (!c) return;
    const target = room + (heat.on ? HEAT_MAX * heat.prox : 0);
    const next = air + (target - air) * (1 - Math.exp(-0.1 / TAU));
    if (Math.abs(next - air) > 0.001) air = Math.abs(next - target) < 0.02 ? target : next;
    if (Math.abs(air - (c.session.sim?.env.temp ?? air)) >= 0.05) c.session.setEnv({ temp: Math.round(air * 100) / 100 });
  }

  // ------------------------------------------------------------ panels
  /** Assembly shown in Product: the user's own when finished, otherwise the reference one */
  function assembly(): AssemblyState | null {
    const c = ctx;
    if (!c) return null;
    const T = workTemplate(c.work.id);
    return preview && T ? referenceAssembly(T) : c.store.get().assembly;
  }

  function renderTree() {
    const c = ctx!;
    const a = assembly();
    const T = workTemplate(c.work.id);
    const pickPart = (id: string) => {
      sel = sel === id ? '' : id;
      renderTree();
      renderProps();
    };
    const how =
      T && a ? (
        <TreeGroup title={preview ? t('Reference mounting') : t('Mounting')} count={preview ? t('Default correct mounting') : t('From Assemble')} open>
          {T.parts
            .filter((p) => p.spots)
            .map((p) => {
              const s = p.spots!.find((x) => x.key === a.choice[p.id]);
              return <TreeRow key={p.id} label={t('{part}: {choice}', { part: t(p.short), choice: s ? t(s.label) : '—' })} st={<TnSt kind={s?.ok ? 'ok' : 'warn'}>{s?.ok ? '✓' : '!'}</TnSt>} />;
            })}
          {!preview && <TreeRow label={t('Power-on retest')} st={<TnSt kind={a.retest === null ? 'muted' : a.retest ? 'ok' : 'bad'}>{a.retest === null ? t('Not tested') : a.retest ? '✓' : '✗'}</TnSt>} />}
        </TreeGroup>
      ) : null;
    c.shell.tree.render(
      <div role="group" aria-label={t('Product')}>
        <TreeGroup title={t('Project')} count={t('Switching reloads page')} open>
          {WORK_LIST.map((w) => (
            <a key={w.id} className={tnClass(w.id === c.work.id)} href={lab(w.id, 'product')} role="treeitem" aria-selected={w.id === c.work.id}>
              <TnL>{t(w.title)}</TnL>
              {w.id === c.work.id && <TnM>{t('Current project')}</TnM>}
            </a>
          ))}
        </TreeGroup>
        <TreeGroup title={t('Product')} count="" open>
          {(PARTS[c.work.id] ?? []).map((p) => (
            <TreeNode key={p.id} on={sel === p.id} data-id={p.id} label={p.name} onClick={() => pickPart(p.id)} />
          ))}
        </TreeGroup>
        {how}
      </div>,
    );
  }

  function renderProps() {
    const c = ctx!;
    const w = c.work.id;
    const weather = w === 'weather';
    const p = (PARTS[w] ?? []).find((x) => x.id === sel);
    const off = assembly()?.effects.sensorOffset ?? 0;
    const rows = weather
      ? [row(t('Around the station'), 'air'), row(t('BME280 reads'), 'rt'), row(t('OLED unit'), 'unit'), row(t('Dial needle'), 'needle'), row(t('Onboard RGB'), 'rgb'), row(t('Buzzer'), 'buzz'), row(t('Heat source'), 'heat')]
      : w === 'spin'
        ? [row(t('Servo'), 'servo'), row(t('Turntable'), 'turn'), row(t('State'), 'look')]
        : w === 'usbkey'
          ? [row(t('Computer sees'), 'usbstate'), row(t('Typed text'), 'typed')]
          : w === 'lens'
            ? [row(t('Expression'), 'mood'), row(t('Lens'), 'lens')]
            : w === 'lamp'
              ? [row(t('LED strip'), 'strip'), row(t('Brightness / colour'), 'lampst'), row(t('Knob mode'), 'lampmode'), row(t('Knob'), 'knob')]
              : w === 'ruler'
                ? [row(t('Board distance'), 'cm'), row(t('Sensor measures'), 'cmfx'), row(t('Firmware reading'), 'rdist'), row(t('Buzzer'), 'buzz')]
                : HOOKS[w]?.rows(row) ?? [row(t('Disc pose'), 'tpose'), row(t('IMU reads'), 'tfx'), row(t('Bean'), 'bean')];
    const b = (id: string, label: string, f: () => void) => (
      <Btn key={id} id={id} onClick={f}>
        {label}
      </Btn>
    );
    const acts =
      w === 'lamp'
        ? [b('pKnobL', t('Knob −1'), () => turnKnob(-1)), b('pKnobR', t('Knob +1'), () => turnKnob(1)), b('pKnobP', t('Press knob'), () => onTool('p-knob'))]
        : w === 'ruler'
          ? [b('pNear', t('Board 10 cm closer'), () => moveBoard(-10)), b('pFar', t('Board 10 cm farther'), () => moveBoard(10))]
          : w === 'tilt'
            ? [b('pTiltR', t('Lower the right side'), () => tiltTo({ pitch: 0, roll: 25, yaw: 0 })), b('pTiltL', t('Lower the front left'), () => tiltTo({ pitch: 20, roll: -25, yaw: 0 })), b('pLevel', t('Make level'), () => tiltTo({ pitch: 0, roll: 0, yaw: 0 }))]
            : HOOKS[w] ? HOOKS[w].buttons(b, c.session) : w === 'usbkey'
              ? []
              : [
                  <Btn key="pBoot" id="pBoot" onPointerDown={() => pressBoot(true)} onPointerUp={() => pressBoot(false)} onPointerLeave={() => pressBoot(false)}>
                    {t('Press BOOT')}
                  </Btn>,
                ];
    c.shell.props.render(
      <>
        {p && (
          <>
            <Sec>{t('Selected')}</Sec>
            <Ph>{p.name}</Ph>
            <Note>{p.about}</Note>
          </>
        )}
        <Sec>{t('Product · same firmware as the Bench')}</Sec>
        {row(t('Run'), 'run')}
        {rows}
        {off ? <Note bad>{t('Mounting: the BME280 sits against the chip and reads {off} ℃ above the surroundings (estimate). Go back to Assemble and move it next to the vent.', { off: off.toFixed(1) })}</Note> : null}
        {fxNote()}
        {assembly()?.effects.usbBlocked && <Note bad>{t("Mounting: the dev board is turned 180°, so the USB port faces the front wall, the cable won't go in and the computer sees no device. Go back to Assemble and point the USB port at the rear opening.")}</Note>}
        {harnessPanel()}
        {/* On phones these buttons already sit in the bottom toolbar (phoneGroups "act"); repeating them in the drawer is redundant */}
        <Btns className="max-md:hidden">
          {c.session.audio.hasSound && <Txt as="button" type="button" className={btnClass()} id="pSound" aria-pressed="false" onClick={() => toggleSound()} text={t('Sound: off')} />}
          {weather && <Txt as="button" type="button" className={btnClass()} id="pHeat" onClick={() => toggleHeat()} text={t('Heat source: off')} />}
          {acts}
        </Btns>
        <Sec>{t('Serial · last few lines')}</Sec>
        {/* Long serial output scrolls: it must be focusable for keyboard scrolling (axe scrollable-region-focusable) */}
        <Brief className="serial-tail" data-live="serial" tabIndex={0} aria-label={t('Last few serial lines')} />
        <Checklist key={w} work={w} title={c.work.title} items={checklistItems()} toast={(s) => c.shell.toast(s)} />
        <Sec className="flex items-center gap-1.5">
          {t("Can't be simulated")} · <Conf c={MUST_REAL} />
        </Sec>
        {(CANNOT[w] ?? []).map(([title, d]) => (
          <Res key={title} kind="na" mk="×">
            <b>{t(title)}</b> · {t(d)}
          </Res>
        ))}
        {!preview && <BuyCard {...buyProps()} />}
      </>,
    );
    updateLive();
  }

  /** D-06: project first steps + capability rules + result rows marked "needs real hardware" from saved checks */
  function checklistItems() {
    const c = ctx!;
    const s = c.store.get();
    const mustReal = c.work.checkpoints.flatMap((id) => (s.checks[id]?.rows ?? []).filter((r) => r.conf === MUST_REAL).map((r) => ({ text: r.text, note: r.note })));
    return buildChecklist({ first: FIRST3[c.work.id] ?? [], parts: c.session.scene.parts.map((p) => p.type), serial: c.session.consoleText(), mustReal });
  }

  // ------------------------------------------------------------ buy card (DESIGN_V2 §8.3, U-18)
  /** Data from existing local saves (the card never touches storage); manual items stored by English key so ticks survive a language switch */
  function buyProps() {
    const c = ctx!;
    const w = c.work.id;
    const keys = (CANNOT[w] ?? []).map(([k]) => k);
    const manual = keys.map((k) => t(k));
    const checked = loadManual(w)
      .filter((x) => keys.includes(x))
      .map((k) => t(k));
    const s = c.store.get();
    const ids = c.work.checkpoints;
    // No fingerprint for "all checkpoints": when all pass, use the last checkpoint's (the most complete level)
    const fp = ids.length && passedCount(c) === ids.length ? (s.checks[ids[ids.length - 1]]?.fingerprint ?? null) : null;
    // Example firmware loads as `<example>/flash.bin`; a dropped user firmware is a bare file name and is the only one worth downloading
    const ses = c.session;
    const userBin = ses.fwBuf && ses.fwName && !ses.fwName.includes('/') ? { buf: ses.fwBuf, name: ses.fwName } : null;
    return {
      checks: ids.length,
      remaining: remainingLines(w),
      fingerprint: fp,
      manual,
      checked,
      onToggleManual: (item: string) => {
        const key = keys.find((k) => t(k) === item) ?? item;
        const cur = loadManual(w);
        saveManual(w, cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]);
        renderProps();
      },
      onDownloadBin: userBin ? () => download(new Blob([userBin.buf], { type: 'application/octet-stream' }), userBin.name) : null,
    };
  }

  /** Mounting hints (lamp hot spots / blocked sensor / reversed IMU) */
  function fxNote() {
    const fx = assembly()?.effects ?? {};
    if (fx.glare) return <Note bad>{t('Mounting: the LED strip touches the shade, leaving a row of glaring spots on it (estimate). Go back to Assemble and stick the strip to the light pipe.')}</Note>;
    if (fx.sonarBlock) return <Note bad>{t('Mounting: the sensor sits back inside the enclosure hole, so the simulated HC-SR04 only measures the hole wall (about {cm} cm) and the buzzer sounds constantly. Go back to Assemble and let the sensor stick out of the front panel.', { cm: fx.sonarBlock })}</Note>;
    if (fx.hornOffset) return <Note bad>{t('Mounting: the servo horn is {deg}° off, so when the firmware says "front" it is actually crooked (same estimate as the old Bench). Go back to Assemble, centre the servo first, then press on the horn.', { deg: fx.hornOffset.toFixed(1) })}</Note>;
    if (fx.imuFlip) return <Note bad>{t('Mounting: the IMU is mounted backwards, so pitch and roll are both reversed and the bean climbs uphill. Go back to Assemble and mount it with the arrow facing forward.')}</Note>;
    return null;
  }
  function turnKnob(steps: number) {
    if (!ctx) return;
    ctx.session.turnEncoder(steps);
    knobPos += steps;
  }
  let knobPos = 0;
  /** Ruler: feed the user's distance (before mounting) to the simulator; a blocked sensor only sees the hole wall */
  function applyDistance(cm: number) {
    rawCm = cm;
    const b = assembly()?.effects.sonarBlock ?? 0;
    ctx?.session.setDistance(b ? Math.min(cm, b) : cm);
  }
  function moveBoard(d: number) {
    const cm = Math.max(2, Math.min(80, rawCm + d));
    work3d?.setDistance(cm);
    applyDistance(cm);
    event('↔', t('Board moved to {cm} cm', { cm: cm.toFixed(0) }));
  }
  /** Tilt figure: user pose -> pose seen by the IMU (pitch and roll negated when mounted backwards) */
  function applyPose(p: { pitch: number; roll: number; yaw: number }) {
    rawPose = { ...p };
    const flip = assembly()?.effects.imuFlip;
    ctx?.session.setPose(flip ? { pitch: -p.pitch, roll: -p.roll, yaw: p.yaw } : p);
  }
  function tiltTo(p: { pitch: number; roll: number; yaw: number }) {
    work3d?.setPose(p);
    applyPose(p);
    event('⟋', p.pitch || p.roll ? t('Tilt: pitch {pitch}°, roll {roll}°', { pitch: p.pitch, roll: p.roll }) : t('Make level'));
  }

  // ------------------------------------------------------------ harness (P2-11, estimate)
  function harnessPanel() {
    const c = ctx!;
    const fx = assembly()?.effects ?? {};
    const n = I2C_DEVICES[c.work.id] ?? 0;
    const mk = (v: string) => (v === 'ok' ? '✓' : v === 'marginal' ? '!' : '✗');
    const l = n && fx.i2cWireCm !== undefined ? i2cLoad(fx.i2cWireCm, n) : null;
    const wf = wifiText(fx.antennaDb ?? 0);
    const wk: ResKind = wf.level === 'ok' ? 'ok' : wf.level === 'marginal' ? 'warn' : 'bad';
    const sim = c.session.harnessText.trim();
    return (
      <>
        <Sec>{t('Harness and antenna · estimate, needs real hardware')}</Sec>
        {l && (
          <Res kind={l.verdict === 'ok' ? 'ok' : 'bad'} mk={mk(l.verdict)}>
            <Said say={i2cSay(l)} raw={i2cText(l)} />
          </Res>
        )}
        <Res kind={wk} mk={mk(wf.level)}>
          <Said say={PROCURE_TEMPLATES.find((x) => x.id === c.work.id)?.firmware.wifi ? wifiSay(fx.antennaDb ?? 0) : t("{say} (this project doesn't use Wi-Fi, so it isn't affected for now)", { say: wifiSay(fx.antennaDb ?? 0) })} raw={t('Antenna loss {db} dB, {text}', { db: fx.antennaDb ?? 0, text: wf.text })} />
        </Res>
        {sim && <Txt as="p" className="note my-2 font-mono text-xs text-muted" data-live="hz" text={simLines(sim)} />}
      </>
    );
  }
  /** Harness text arrives with the CLI's `[tryboard] ` prefix; show it as a localized "Simulator:" label */
  const simLines = (s: string) => s.replace(/\[tryboard\] (.*)/g, (_m, line: string) => t('Simulator: {line}', { line }));

  /** Product uses the assembled harness (preview uses the reference: ideal bus, unobstructed antenna) */
  function applyHarness() {
    const c = ctx!;
    const fx = assembly()?.effects ?? {};
    const want = { i2cWire: fx.i2cWireCm ?? -1, antenna: fx.antennaDb ?? 0 };
    const cur = c.session.harness;
    const h: { i2cWire?: number; antenna?: number } = {};
    if ((cur.i2cWire ?? -1) !== want.i2cWire) h.i2cWire = want.i2cWire;
    if ((cur.antenna ?? 0) !== want.antenna) h.antenna = want.antenna;
    if (Object.keys(h).length) c.session.setHarness(h);
  }

  // ------------------------------------------------------------ photo / 10 s recording (P2-10)
  function cur3d(): { capture(): Capturable; resetView(): void } | null {
    return scene3d ?? lcd3d ?? keypad ?? work3d ?? dial3d;
  }
  async function photo() {
    const c = ctx;
    const s = cur3d();
    if (!c || !s) return;
    try {
      const r = await takePhoto(s.capture(), c.work.id, c.work.title);
      event('◉', t('Photo {w}×{h}', { w: r.width, h: r.height }));
      c.shell.toast(t('Downloaded {name} ({w}×{h}, {kb} KB)', { name: r.name, w: r.width, h: r.height, kb: (r.bytes / 1024).toFixed(0) }));
    } catch (e) {
      c.shell.toast(t('Photo failed: {error}', { error: String(e) }));
    }
  }
  function record() {
    const c = ctx;
    const s = cur3d();
    if (!c || !s) return;
    if (rec) {
      rec.stop();
      return;
    }
    try {
      const audio = c.session.audio.recordStream();
      const r = recordCanvas(s.capture().renderer.domElement, c.work.id, audio);
      rec = r;
      event('●', audio ? t('Recording started (with sound)') : t('Recording started'));
      syncToolbar();
      renderProps();
      void r.done
        .then((v) => {
          event('■', t('Recording {s} s · {w}×{h}', { s: v.seconds.toFixed(1), w: v.width, h: v.height }));
          const kb = (v.bytes / 1024).toFixed(0);
          ctx?.shell.toast(v.audio ? t('Downloaded {name} ({kb} KB, with sound)', { name: v.name, kb }) : t('Downloaded {name} ({kb} KB)', { name: v.name, kb }));
        })
        .catch((e) => ctx?.shell.toast(t('Recording failed: {error}', { error: String(e) })))
        .finally(() => {
          if (rec === r) rec = null;
          if (ctx?.store.get().step === 'product') {
            syncToolbar();
            renderProps();
          }
        });
    } catch (e) {
      rec = null;
      c.shell.toast(t('Recording failed: {error}', { error: String(e) }));
    }
  }

  let bootDown = false;
  function pressBoot(down: boolean) {
    if (!ctx || down === bootDown) return;
    bootDown = down;
    ctx.session.pressBoot(down);
    if (down) event('●', t('BOOT pressed'));
  }
  function toggleSound() {
    const a = ctx!.session.audio;
    // The click is the user gesture: the AudioContext is created / resumed right now
    void a.setMuted(!a.state.muted).then(() => {
      event('♪', a.state.muted ? t('Sound off') : t('Sound on'));
      // The run group's sound button reads the same state
      setBc({ sound: { has: a.hasSound, on: !a.state.muted } });
      syncToolbar();
      updateLive();
    });
  }
  function toggleHeat() {
    if (!scene3d) return;
    scene3d.setHeat(!scene3d.heatOn);
  }

  function updateLive() {
    const c = ctx;
    if (!c) return;
    const el = c.shell.props.el;
    const set = (k: string, v: string, bad = false) => {
      const n = el.querySelector<HTMLElement>(`[data-live="${k}"]`);
      if (n) {
        n.textContent = v;
        n.classList.toggle('bad', bad);
      }
    };
    const s = c.store.get();
    const f = frame();
    const waiting = t('Waiting for firmware output…');
    set('run', s.run ? `#${s.run} · ${s.simSeconds.toFixed(1)} s` : t('Not powered'));
    set('air', heat.on ? t('{temp} ℃ (heat source on)', { temp: air.toFixed(1) }) : `${air.toFixed(1)} ℃`);
    set('rt', s.reading ? `${s.reading.t.toFixed(2)} ℃` : waiting, !!s.reading && s.reading.t >= 30);
    set('unit', unitF ? '℉' : '℃');
    const a = servoAngle(f.pwm, 4);
    set('needle', a === null ? t('No PWM') : `${a.toFixed(1)}° ≈ ${((a / 180) * 40).toFixed(1)} ℃`);
    const css = ledCss(f.running ? f.rgb : null);
    const rgb = el.querySelector<HTMLElement>('[data-live="rgb"]');
    if (rgb) {
      if (css && f.rgb) rgb.replaceChildren(swatch(css), `#${f.rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}`);
      else rgb.textContent = t('Off');
    }
    const au = c.session.audio.state;
    const out = au.muted ? t('Muted') : t('Audible');
    set('buzz', `${au.sounding ? t('Sounding {hz} Hz', { hz: au.lastFreq }) : alarm ? t('Alarm (intermittent)') : t('Silent')} · ${out}`, alarm);
    set('heat', heat.on ? t('On · {p}% close to the vent', { p: (heat.prox * 100).toFixed(0) }) : t('Off'));
    set('servo', a === null ? t('No PWM') : `${a.toFixed(1)}°`);
    if (lcd3d) set('turn', t('{deg}° (0° is the front)', { deg: `${lcd3d.turn() >= 0 ? '+' : ''}${lcd3d.turn().toFixed(0)}` }));
    set('look', look === 'front' ? t('Stopped facing front (press BOOT to continue)') : t('Turning left and right'));
    set('mood', mood ? t('{mood} (press BOOT for the next one)', { mood: MOOD_LABEL[mood] ?? mood }) : waiting);
    const uv = c.session.usb;
    const blocked = !!assembly()?.effects.usbBlocked;
    set('usbstate', blocked ? t("No device (the cable won't go in)") : uv ? `${uv.state}${uv.product ? ` · ${uv.product}` : ''}` : t('Waiting for device'), blocked || !uv?.configured);
    set('typed', blocked ? '—' : uv?.typed ? uv.typed.replace(/\r/g, '').replace(/\n/g, '↵') : t('(no input yet)'));
    const k = assembly()?.effects.lensScale ?? 1.35;
    set('lens', k > 1.2 ? t('High slot 8 mm · about {k}× magnification (estimate)', { k: k.toFixed(2) }) : t('Low slot 1 mm · about {k}× magnification (estimate)', { k: k.toFixed(2) }), k < 1.2);
    const snd = el.querySelector<HTMLButtonElement>('#pSound');
    if (snd) {
      snd.textContent = au.muted ? t('Sound: off') : t('Sound: on');
      snd.setAttribute('aria-pressed', String(!au.muted));
    }
    const ht = el.querySelector<HTMLButtonElement>('#pHeat');
    if (ht) ht.textContent = heat.on ? t('Heat source: on') : t('Heat source: off');
    if (c.work.id === 'lamp') {
      const strip = f.strips?.[5] ?? [];
      const st = el.querySelector<HTMLElement>('[data-live="strip"]');
      if (st) {
        if (strip.length) st.replaceChildren(...strip.map((x) => swatch(ledCss(x) ?? '#222')), ` #${(strip[0] ?? [0, 0, 0]).map((x) => x.toString(16).padStart(2, '0')).join('')}`);
        else st.textContent = t('Off');
      }
      // Firmware powers up at level 4, warm white, and only prints LEVEL / COLOR on change
      const lv = { level: lamp.level || 4, color: COLOR_LABEL[lamp.color] ?? (lamp.color || COLOR_LABEL.warm) };
      set('lampst', lamp.level || lamp.color || strip.some((x) => Math.max(...x) > 0) ? (lamp.level || lamp.color ? t('Brightness {level}/8 · {color}', lv) : t('Brightness {level}/8 · {color} (power-on default)', lv)) : waiting);
      set('lampmode', lamp.mode === 'color' ? t('Adjusting colour (press again to go back to brightness)') : t('Adjusting brightness (press to switch to colour)'));
      set('knob', t('Position {n} (counted since opening Product)', { n: `${knobPos >= 0 ? '+' : ''}${knobPos}` }));
    } else if (c.work.id === 'ruler') {
      const b = assembly()?.effects.sonarBlock ?? 0;
      set('cm', `${rawCm.toFixed(1)} cm`);
      set('cmfx', b && rawCm > b ? t('About {cm} cm (blocked by the hole wall)', { cm: b }) : `${Math.min(rawCm, b || rawCm).toFixed(1)} cm`, !!b && rawCm > b);
      set('rdist', ruler.dist || waiting);
      set('buzz', `${ruler.beep === 'on' ? t('Continuous') : ruler.beep.startsWith('gap=') ? t('Beep 40 ms · pause {gap}', { gap: ruler.beep.slice(4) }) : t('Silent')} · ${out}`, ruler.beep === 'on');
    } else if (c.work.id === 'tilt') {
      const flip = assembly()?.effects.imuFlip;
      set('tpose', t('Pitch {pitch}° · roll {roll}°', { pitch: rawPose.pitch.toFixed(0), roll: rawPose.roll.toFixed(0) }));
      set('tfx', flip ? t('Pitch {pitch}° · roll {roll}° (mounted backwards)', { pitch: (-rawPose.pitch).toFixed(0), roll: (-rawPose.roll).toFixed(0) }) : t('Matches the disc'), !!flip);
      set('bean', bean.pos ? t('{pos} · edge hits: {n}', { pos: bean.pos, n: bean.edges }) : waiting);
    } else HOOKS[c.work.id]?.live(set, waiting, f);
    const pre = el.querySelector<HTMLElement>('[data-live="serial"]');
    if (pre) {
      const lines = c.session.consoleText().split('\n').filter((l) => l.trim());
      pre.textContent = lines.slice(-6).join('\n');
    }
  }

  /** Phone product (P2-17): 3D fills the screen, the key grid is the toolbar; drag already orbits, so no "Rotate". Props-card actions
   *  (knob ±1, tilt, K1–K4) move into the grid as the same desktop actions; "Details" opens the props drawer for readings and caveats */
  function phoneGroups(): ToolGroup[] {
    const c = ctx!;
    const w = c.work.id;
    const act: Tool[] = WORK_ACTS[w]?.() ?? [{ id: 'p-boot', label: t('Press BOOT'), icon: 'boot' }, ...(w === 'weather' ? [{ id: 'p-heat', label: t('Heater'), icon: 'flame', kind: 'tag' as const, on: () => heat.on }] : [])];
    // Same verbs as the bench More drawer: board controls (incl. sound) -> capture, then the untitled run row (DESIGN_V2 §10.2)
    const a = c.session.audio;
    const snd: Tool[] = a.hasSound ? [{ id: 'p-sound', label: t('Sound'), icon: a.state.muted ? 'mute' : 'sound', kind: 'tag', on: () => !a.state.muted, offTag: t('muted') }] : [];
    return [
      { id: 'act', tools: [...act, ...snd] },
      ...(cur3d() ? [{ id: 'media', tools: [{ id: 'p-photo', label: t('Photo'), icon: 'camera' }, { id: 'p-rec', label: rec ? t('Stop recording') : t('Record {n} s', { n: RECORD_SECONDS }), icon: rec ? 'stop' : 'record' }] }] : []),
      { id: 'run', tools: [...(cur3d() ? [{ id: 'p-home', label: t('Reset view'), icon: 'home' }] : []), { id: 'p-info', label: t('Details'), icon: 'info' }, { id: 'p-rerun', label: t('Restart'), primary: true }] },
    ];
  }

  function syncToolbar() {
    const c = ctx!;
    if (isPhone()) {
      c.shell.toolbar.setGroups(phoneGroups());
      c.shell.toolbar.setActive(rec ? 'p-rec' : null);
      return;
    }
    // ProdCtl option B (DESIGN_V2 §8.4), split by verb: board actions live in the right panel next to readings,
    // the bottom bar keeps only recording (photo / video) next to the view; orbit and restart don't overlap, so they stay
    c.shell.toolbar.setGroups([
      ...(cur3d() ? [{ id: 'nav', tools: [{ id: 'p-orbit', label: t('Rotate'), key: t('Drag') }, { id: 'p-home', label: t('Reset view') }] }] : []),
      ...(cur3d() ? [{ id: 'media', tools: [{ id: 'p-photo', label: t('Photo') }, { id: 'p-rec', label: rec ? t('Stop recording') : t('Record {n} s', { n: RECORD_SECONDS }) }] }] : []),
      { id: 'run', tools: [{ id: 'p-rerun', label: t('Restart'), primary: true }] },
    ]);
    c.shell.toolbar.setActive(rec ? 'p-rec' : 'p-orbit');
  }

  function previewWhy() {
    const c = ctx!;
    const n = c.work.checkpoints.length;
    const d = passedCount(c);
    if (d < n) return t('Checkpoints {done}/{total}', { done: d, total: n });
    const a = c.store.get().assembly;
    return t('Assemble {done}/{total}', { done: a?.placed.length ?? 0, total: a?.total ?? workTemplate(c.work.id)?.parts.length ?? 0 });
  }

  /** In preview, Next leads to the missing checkpoints / Assemble; once assembled this is the last step */
  function syncNext() {
    const c = ctx!;
    if (!preview) {
      c.shell.setNext(t('Last step'), null, t('This is the last step'), undefined, 'end');
      return;
    }
    const n = c.work.checkpoints.length;
    if (passedCount(c) < n) {
      c.shell.setNext(t('Back to Bench · checkpoints left: {n}', { n: n - passedCount(c) }), 'bench', '', () => {
        const s = c.store.get();
        const first = c.work.checkpoints.find((id) => !s.checks[id]?.ok) ?? c.work.checkpoints[0];
        if (first) c.store.set({ selection: { kind: 'checkpoint', id: first } });
        location.hash = 'bench';
      });
    } else c.shell.setNext(t('Next: Assemble →'), 'assemble');
  }

  function syncVerdict() {
    const c = ctx!;
    if (preview) {
      c.shell.setVerdict(alarm ? t('Alarm') : previewWhy(), alarm ? 'bad' : 'idle');
      c.shell.onVerdict(() => (location.hash = passedCount(c) < c.work.checkpoints.length ? 'bench' : 'assemble'));
      return;
    }
    const a = c.store.get().assembly;
    const off = a?.effects.sensorOffset ?? 0;
    const fx = a?.effects ?? {};
    const fxBad = fx.glare ? t('Bright spots on the shade (mounting)') : fx.sonarBlock ? t('Reading blocked (mounting)') : fx.imuFlip ? t('Direction reversed (mounting)') : '';
    c.shell.setVerdict(alarm ? t('Alarm ≥ 30 ℃') : off ? t('Reading too high (mounting)') : fxBad || (a?.retest ? t('Retest ✓ · Product') : t('Product')), alarm || off || fxBad ? 'bad' : a?.retest ? 'ok' : 'idle');
    c.shell.onVerdict(() => (location.hash = 'assemble'));
  }

  function onTool(id: string) {
    const c = ctx;
    if (!c || c.store.get().step !== 'product') return;
    if (id === 'p-sound') toggleSound();
    else if (id === 'p-heat') toggleHeat();
    else if (id === 'p-home') cur3d()?.resetView();
    else if (id === 'p-photo') void photo();
    else if (id === 'p-rec') record();
    else if (id === 'p-rerun') c.session.reboot();
    else if (/^p-(card|ir|cloud|dial|amo)-/.test(id)) HOOKS[c.work.id]?.tool(id, c.session);
    else if (id === 'p-level') {
      if (WORK3D.has(c.work.id)) tiltTo({ pitch: 0, roll: 0, yaw: 0 });
      else c.session.setPose({ pitch: 0, roll: 0, yaw: 0 });
    } else if (id === 'p-knob') {
      c.session.pressEncoder(true);
      setTimeout(() => ctx?.session.pressEncoder(false), 150);
      event('●', t('Knob pressed'));
    } else if (id === 'p-knob-l') turnKnob(-1);
    else if (id === 'p-knob-r') turnKnob(1);
    else if (id === 'p-tilt-r') tiltTo({ pitch: 0, roll: 25, yaw: 0 });
    else if (id === 'p-tilt-l') tiltTo({ pitch: 20, roll: -25, yaw: 0 });
    else if (id === 'p-info') setMui({ props: true, sheet: 'peek' });
    else if (id.startsWith('p-key-')) {
      // USB keypad: same action as pressing a keycap in 3D (down 150 ms, then up)
      const pin = Number(id.slice(6));
      c.session.pressPin(pin, true);
      event('⌨', t('K{n} pressed', { n: KEYPAD_PINS.indexOf(pin) + 1 }));
      setTimeout(() => ctx?.session.pressPin(pin, false), 150);
    } else if (id === 'p-near') moveBoard(-10);
    else if (id === 'p-far') moveBoard(10);
    else if (id === 'p-boot') {
      pressBoot(true);
      setTimeout(() => pressBoot(false), 150);
    }
  }

  function build(c: StepCtx) {
    node = document.createElement('div');
    node.className = 'prod-stage';
    if (c.work.id === 'dialtimer') dialStandOf(assembly());
    if (c.work.id === 'weather') {
      scene3d = createProduct3D(node, {
        frame,
        servoPin: 4,
        sounding: () => c.session.audio.state.sounding,
        onBoot: (d) => pressBoot(d),
        onHeat: (on, prox) => {
          const was = heat.on;
          heat = { on, prox };
          if (was !== on) {
            event(on ? '≈' : '○', on ? t('Heat source on, placed by the vent') : t('Heat source off'));
            syncToolbar();
          }
        },
      });
      (window as unknown as { __tbProduct: unknown }).__tbProduct = {
        buttonPos: () => scene3d!.buttonScreenPos(),
        azimuth: () => scene3d!.azimuth(),
        needle: () => scene3d!.needle(),
        heat: () => ({ ...heat, air }),
        unit: () => (unitF ? 'F' : 'C'),
        alarm: () => alarm,
        screen: () => lit(),
      };
    } else if (WORK3D.has(c.work.id) && webglOk()) {
      work3d = createWork3D(node, {
        kind: c.work.id as WorkKind,
        frame: () => frame(),
        effects: () => assembly()?.effects ?? {},
        sounding: () => c.session.audio.state.sounding,
        onKnob: (n) => turnKnob(n),
        onKnobPress: (d) => {
          c.session.pressEncoder(d);
          if (d) event('●', t('Knob pressed'));
        },
        onDistance: (cm) => applyDistance(cm),
        distance: c.session.distance,
        onPose: (p) => applyPose(p),
        pose: c.store.get().pose, onKey: (cmd) => irlampPress(c.session, cmd), onCloud: (p) => cloudSend(c.session, p), ...(c.work.id === 'door' ? { onCard: (uid: string) => doorTap(c.session, uid), card: doorOnReader } : {}),
      });
      (window as unknown as { __tbProduct: unknown }).__tbProduct = {
        handlePos: () => work3d!.handleScreenPos(),
        azimuth: () => work3d!.azimuth(),
        state: () => work3d!.state(),
        lamp: () => ({ ...lamp }),
        ruler: () => ({ ...ruler, raw: rawCm }),
        bean: () => ({ ...bean }),
        strip: () => frame().strips?.[5] ?? [],
      };
    } else if (c.work.id === 'dialtimer' && webglOk()) {
      dial3d = dialProduct3D(node, c.session, frame, dialStandOf(assembly()));
    } else if (c.work.id === 'usbkey') {
      const press = (pin: number, d: boolean) => {
        c.session.pressPin(pin, d);
        if (d) event('⌨', t('K{n} pressed', { n: pin - 3 }));
      };
      if (webglOk()) keypad = createKeypad3D(node, { press });
      else {
        const box = document.createElement('div');
        box.className = 'prod-svg';
        node.appendChild(box);
        keypadSvg = createKeypadView(box, { press });
      }
      c.session.onUsb((v) => {
        const blocked = !!assembly()?.effects.usbBlocked;
        keypad?.setUsb(blocked ? null : v);
        keypadSvg?.setUsb(blocked ? null : v);
      });
      (window as unknown as { __tbProduct: unknown }).__tbProduct = {
        keyPos: (i: number) => keypad?.keyScreenPos(i) ?? null,
        azimuth: () => keypad?.azimuth() ?? 0,
        typed: () => c.session.usb?.typed ?? '',
        usbState: () => c.session.usb?.state ?? '',
      };
    } else if (webglOk() && !PRODUCT_2D.has(c.work.id)) {
      const w = c.work.id as 'spin' | 'lens';
      lcd3d = createLcd3D(node, {
        kind: w,
        frame,
        servoPin: 4,
        effects: () => assembly()?.effects ?? {},
        sounding: () => c.session.audio.state.sounding,
        onBoot: (d) => pressBoot(d),
      });
      (window as unknown as { __tbProduct: unknown }).__tbProduct = {
        buttonPos: () => lcd3d!.buttonScreenPos(),
        azimuth: () => lcd3d!.azimuth(),
        turn: () => lcd3d!.turn(),
        ext: () => lcd3d!.ext(),
        mood: () => mood,
        look: () => look,
        screen: () => lit(),
      };
    } else {
      const box = document.createElement('div');
      box.className = 'prod-svg';
      node.appendChild(box);
      const h = { boot: (d: boolean) => pressBoot(d), temp: () => {}, ir: (code: string) => irlampSend(c.session, code), mqtt: (cmd: string) => void c.session.sim?.mqttPub(cmd), ...dialHandlers(c.session), pwrkey: c.session.pwrKey, sync: () => amoSync(c.session) };
      svgProduct = c.work.id === 'spin' ? createSpinProduct(box, h, { servoPin: 4 }) : c.work.id === 'lens' ? createLensProduct(box, h) : workTemplate(c.work.id)!.product(box, h, { servoPin: 4 });
      const note = document.createElement('div');
      note.className = 'p3-disclaimer';
      note.textContent = webglOk() ? t('Appearance only (2D view for now)') : t("Appearance only (2D: this device doesn't support WebGL)");
      node.appendChild(note);
    }
  }

  function mountTilt(c: StepCtx) {
    if (!tiltNode) {
      tiltNode = document.createElement('div');
      tiltNode.className = 'prod-stage';
      tilt = createTilt3D(tiltNode, { pose: () => c.store.get().pose, onPose: (p) => c.session.setPose(p) });
      const note = document.createElement('div');
      note.className = 'p3-disclaimer';
      note.textContent = t('Appearance only · drag to turn the box');
      tiltNode.appendChild(note);
    }
    c.shell.layer.render(
      <>
        <Banner head={t('Inclinometer · turn it in your hand')} sub={t('This project has no enclosure. Turning the box turns the IMU on the Bench, and the readings follow live')} />
        <Host node={tiltNode} />
      </>,
    );
    tilt!.start();
    c.shell.tree.render(<TreeRow on label={t('Inclinometer · {chip}', { chip: c.session.scene.parts.some((p) => p.type === 'qmi8658') ? 'QMI8658' : 'MPU6050' })} />);
    c.shell.props.render(
      <>
        <Sec>{t('Box pose · as you turned it')}</Sec>
        {row(t('Pitch / roll / yaw'), 'tp')}
        {row(t('Expected (gravity components)'), 'tg')}
        <Sec>{t('Firmware reading · last serial line')}</Sec>
        {row(t('Pitch'), 'tip')}
        {row(t('Roll'), 'tir')}
        {row(t('Gyro'), 'tgy')}
        <Note>{t('While dragging, the gyro reads angular velocity and returns to zero 150 ms after release. Real-hardware bias, temperature drift and vibration noise are not included (not calibrated on real hardware).')}</Note>
      </>,
    );
    const tiltBar = () => {
      c.shell.toolbar.setGroups(
        isPhone()
          ? [{ id: 'run', tools: [{ id: 'p-level', label: t('Make level') }, { id: 'p-info', label: t('Details') }, { id: 'p-rerun', label: t('Restart'), primary: true }] }]
          : [
              { id: 'nav', tools: [{ id: 'p-orbit', label: t('Turn'), key: t('Drag') }, { id: 'p-level', label: t('Make level') }] },
              { id: 'run', tools: [{ id: 'p-rerun', label: t('Restart'), primary: true }] },
            ],
      );
      c.shell.toolbar.setActive(isPhone() ? null : 'p-orbit');
    };
    tiltBar();
    unsubs.push(onPhoneChange(tiltBar));
    c.shell.timeline.setSteps([]);
    c.shell.setNext(t('Last step'), null, t('This is the last step'), undefined, 'end');
    c.shell.setVerdict(t('Inclinometer · Product'), 'idle');
    c.shell.onVerdict(() => (location.hash = 'bench'));
    const set = (k: string, v: string, bad = false) => {
      const n = c.shell.props.el.querySelector<HTMLElement>(`[data-live="${k}"]`);
      if (n) {
        n.textContent = v;
        n.classList.toggle('bad', bad);
      }
    };
    const upd = () => {
      const s = c.store.get();
      const p = s.pose;
      set('tp', `${p.pitch.toFixed(1)}° / ${p.roll.toFixed(1)}° / ${p.yaw.toFixed(1)}°`);
      set('tg', gravity(p).map((v) => v.toFixed(3)).join(' / ') + ' g');
      set('tip', s.imu ? `${s.imu.pitch.toFixed(1)}°` : t('Waiting for firmware output…'));
      set('tir', s.imu ? `${s.imu.roll.toFixed(1)}°` : '—');
      set('tgy', s.imu?.gyro ? `${s.imu.gyro.map((v) => v.toFixed(1)).join(' / ')} °/s` : '—');
    };
    upd();
    tiltTimer = window.setInterval(upd, 100);
    (window as unknown as { __tbProduct: unknown }).__tbProduct = { center: () => tilt!.centerPos(), pose: () => c.store.get().pose, imu: () => c.store.get().imu };
  }

  function loopSvg() {
    const c = ctx;
    if (!c || !svgProduct) return;
    svgProduct.update(frame(), c.store.get().env.temp, assembly()?.effects ?? {});
  }

  return {
    mount(c) {
      ctx = c;
      if (!hooked) {
        hooked = true;
        storeRef = c.store;
        c.shell.toolbar.onTool(onTool);
        // Replay serial printed before we hooked in (lamp's LAMP ON / LEVEL at power-on), state only
        quiet = true;
        onSerial(c.session.consoleText() + '\n');
        quiet = false;
        c.session.onConsole((text) => onSerial(text));
        c.store.subscribe((s, prev) => {
          if (s.run > prev.run) {
            unitF = alarm = false;
            mood = look = '';
            lamp = { level: 0, mode: '', color: '' };
            ruler = { dist: '', beep: '' };
            bean = { pos: '', edges: 0 };
            event('▶', t('Power on · run #{run}', { run: s.run }));
          }
        }, ['run']);
      }
      if (c.work.id === 'imu') {
        mountTilt(c);
        return;
      }
      if (!workTemplate(c.work.id)) {
        c.shell.layer.render(
          <LockCard role="status">
            <Sec>{t('④ Product')}</Sec>
            <PhT>{t('{title} has no product', { title: c.work.id === 'blank' ? t('Blank project') : t(c.work.title) })}</PhT>
            <Btns>
              <LinkBtn primary href={lab('weather', 'product')}>
                {t('See the weather station product')}
              </LinkBtn>
            </Btns>
          </LockCard>,
        );
        c.shell.tree.render(<TreeEmpty>{t('No product')}</TreeEmpty>);
        c.shell.props.render(null);
        c.shell.toolbar.setGroups([]);
        c.shell.timeline.setSteps([]);
        return;
      }
      const own = c.store.get().assembly;
      // Unfinished assembly doesn't lock the page: show the reference product with the Bench's current firmware, labelled, and Next leads on
      preview = !own || own.placed.length < own.total;
      const a = assembly()!;
      if (c.work.id === 'dialtimer' && dial3d && dial3d.stand !== dialStandOf(a)) { dial3d.dispose(); dial3d = null; node = null; }
      if (!node) build(c);
      c.shell.layer.render(
        <>
          {preview && <Banner head={t('Reference product')} sub={t('Shown with the default correct mounting; it switches to yours once you finish assembling')} />}
          <Host node={node} />
        </>,
      );
      // Mounting drift only applies inside Product
      c.session.setSensorOffset(a?.effects.sensorOffset ?? 0);
      room = c.store.get().env.temp;
      air = room;
      if (!events.length && c.store.get().run) {
        const run = c.store.get().run;
        const on = a.effects.sensorOffset ? t('Power on · run #{run}, sensor heated {off} ℃ high', { run, off: a.effects.sensorOffset }) : t('Power on · run #{run}', { run });
        event('▶', preview ? t('Reference product · {text}', { text: on }) : on);
      }
      [scene3d, lcd3d, work3d, dial3d].forEach((x) => x?.start());
      // Mounting effects reach the simulator (blocked sensor, reversed IMU); restored to the user's setup when leaving Product
      if (c.work.id === 'ruler') {
        rawCm = c.session.distance < 0 ? 25 : c.session.distance;
        work3d?.setDistance(rawCm);
        applyDistance(rawCm);
      } else if (c.work.id === 'tilt') {
        rawPose = { ...c.store.get().pose };
        work3d?.setPose(rawPose);
        applyPose(rawPose);
      }
      keypad?.start();
      keypad?.setBlocked(!!a.effects.usbBlocked);
      if (keypad || keypadSvg) {
        const v = a.effects.usbBlocked ? null : c.session.usb;
        keypad?.setUsb(v);
        keypadSvg?.setUsb(v);
      }
      applyHarness();
      if (svgProduct) raf ??= onFrame(loopSvg, { priority: PRIO.ui, immediate: true });
      timer = window.setInterval(() => {
        tickHeat();
        updateLive();
        syncVerdict();
      }, 100);
      syncNext();
      renderTree();
      renderProps();
      syncToolbar();
      syncVerdict();
      c.shell.timeline.setSteps(events);
      c.shell.timeline.setCurrent(events.length - 1);
      unsubs = [
        onPhoneChange(() => syncToolbar()),
        c.store.subscribe(() => renderTree(), ['assembly']),
        c.store.subscribe(() => preview && (syncNext(), renderProps()), ['checks']),
        c.session.onHarness((text) => {
          const n = c.shell.props.el.querySelector('[data-live="hz"]');
          if (n) n.textContent = simLines(text.trim());
          else if (text.trim()) renderProps();
        }),
      ];
    },
    unmount() {
      unsubs.forEach((u) => u());
      unsubs = [];
      clearInterval(timer);
      clearInterval(tiltTimer);
      tilt?.stop();
      raf?.();
      raf = null;
      [scene3d, lcd3d, work3d, dial3d].forEach((x) => x?.stop());
      keypad?.stop();
      rec?.stop();
      if (ctx) {
        if (ctx.work.id === 'ruler') ctx.session.setDistance(rawCm);
        if (ctx.work.id === 'tilt') ctx.session.setPose(rawPose);
        // Leaving Product: drop the drift and heat source, back to room temperature
        if (heat.on) scene3d?.setHeat(false);
        heat = { on: false, prox: 0 };
        ctx.session.setSensorOffset(0);
        if (Math.abs(air - room) > 0.01) ctx.session.setEnv({ temp: room });
        air = room;
      }
      ctx = null;
    },
  };
}
