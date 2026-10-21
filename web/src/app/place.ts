// Place parts on the bench (P2-16): only parts with a pin-level device model, so a wired part really reaches the sim;
// others are greyed out with a reason. Step pins use wiresOf pin names so wire ids match rewiring and the wiring check.
import type { ChipId, PartSpec, SceneSpec } from '../board3d.ts';
import { LCD_WIRING } from '../chipid.ts';
import { TFT_HEADER, type TftPanel, type TftPinRole } from '../lcdspec.ts';
import { t } from '../i18n/index.ts';
import { getPart } from '../catalog/parts.ts';
import { partId, wiresOf, type WireMods } from './wiring.ts';

/** Which board pin kind this step wants; a wrong power rail is left to the wiring check. */
export type Want = 'gpio' | 'gnd' | 'power';
export interface PlaceStep {
  /** Pin name from wiresOf (part of the wire id). */
  pin: string;
  /** Shown to the user: silkscreen or wire colour. */
  label: string;
  want: Want;
  /** Default rail; picking the other one is recorded as a retarget and judged by the wiring check. */
  def?: '3V3' | '5V';
  /** May be left unconnected (MPU6050 INT, encoder switch). */
  optional?: boolean;
  /** Only the chip's fixed LCD pin of this role fits (F-04a2 TFT: the core wires SPI2 to LCD_WIRING) */
  fixed?: Exclude<TftPinRole, 'gnd' | 'vcc' | 'miso'>;
}
export interface PlaceDef {
  partId: string;
  name: string;
  type: PartSpec['type'];
  steps: PlaceStep[];
  /** TFT panel (type 'tft') / OLED controller (type 'oled'), carried into the scene part */
  panel?: TftPanel;
  ctl?: 'sh1106';
}

const G = (pin: string, label = pin): PlaceStep => ({ pin, label, want: 'gpio' });
const GND = (label = 'GND'): PlaceStep => ({ pin: 'GND', label, want: 'gnd' });
const P = (pin: string, def: '3V3' | '5V', label = pin): PlaceStep => ({ pin, label, want: 'power', def });
const I2C = (vcc: string, vlabel = vcc): PlaceStep[] => [P(vcc, '3V3', vlabel), GND(), G('SCL'), G('SDA')];
/** TFT header in silkscreen order; SDO (MISO) is skipped: the firmware never reads the panel */
const TFT = (panel: TftPanel): PlaceStep[] =>
  TFT_HEADER[panel].flatMap(([n, r]): PlaceStep[] => (r === 'gnd' ? [GND()] : r === 'vcc' ? [P(n, '3V3')] : r === 'miso' ? [] : [{ ...G(n), fixed: r }]));

const DEFS: Record<string, Omit<PlaceDef, 'partId' | 'name'>> = {
  'led-kit': { type: 'led', steps: [G('IN', t('Long leg + (via 220 Ω)')), GND(t('Short leg −'))] },
  button: { type: 'key', steps: [G('IN', t('Pin A')), GND(t('Pin B'))] },
  'buzzer-module': { type: 'buzzer', steps: [P('VCC', '3V3'), G('I/O'), GND()] },
  sg90: { type: 'servo', steps: [G('PWM', t('Orange PWM')), P('VCC', '5V', t('Red VCC')), GND(t('Brown GND'))] },
  mg90s: { type: 'servo', steps: [G('PWM', t('Orange PWM')), P('VCC', '5V', t('Red VCC')), GND(t('Brown GND'))] },
  pot: { type: 'pot', steps: [P('VCC', '3V3', t('Pin 1')), G('OUT', t('Pin 2 (wiper)')), GND(t('Pin 3'))] },
  bme280: { type: 'bme280', steps: I2C('VIN', 'VCC') },
  ssd1306: { type: 'oled', steps: I2C('VCC') },
  sh1106: { type: 'oled', steps: I2C('VCC'), ctl: 'sh1106' },
  ili9341: { type: 'tft', steps: TFT('ili9341'), panel: 'ili9341' },
  st7789: { type: 'tft', steps: TFT('st7789-240x240'), panel: 'st7789-240x240' },
  'st7789-240x320': { type: 'tft', steps: TFT('st7789-240x320'), panel: 'st7789-240x320' },
  mpu6050: { type: 'mpu6050', steps: [...I2C('VCC'), { ...G('INT'), optional: true }] },
  qmi8658: { type: 'qmi8658', steps: I2C('VIN') },
  encoder: { type: 'encoder', steps: [GND(), P('+', '3V3'), G('CLK'), G('DT'), { ...G('SW'), optional: true }] },
  'hc-sr04': { type: 'hcsr04', steps: [P('VCC', '5V'), G('Trig'), G('Echo', t('Echo (via 1k/2k divider)')), GND()] },
  'ws2812-stick8': { type: 'ws2812', steps: [P('5V', '5V'), G('DIN'), GND()] },
  'ws2812-strip': { type: 'ws2812', steps: [P('5V', '5V'), G('DIN'), GND()] },
  dht11: { type: 'dht11', steps: [P('VCC', '3V3'), G('DATA'), GND()] },
  ds18b20: { type: 'ds18b20', steps: [P('VDD', '3V3', t('Red VDD')), G('DQ', t('Yellow DQ (4.7 kΩ pull-up)')), GND(t('Black GND'))] },
  'hc-sr501': { type: 'pir', steps: [P('VCC', '5V'), G('OUT'), GND()] },
  'relay-1ch': { type: 'relay', steps: [P('VCC', '5V'), G('IN'), GND()] },
  'ldr-module': { type: 'ldr', steps: [P('VCC', '3V3'), G('AO', t('AO (ADC pin)')), GND()] },
  rc522: { type: 'rc522', steps: [P('3.3V', '3V3'), GND(), G('SDA', t('SDA (chip select)')), G('SCK'), G('MOSI'), G('MISO'), { ...G('RST'), optional: true }] },
};

/** Why a part cannot be placed (hint on the greyed-out library entry). */
const WHY: Record<string, string> = {
  gc9a01: t('The round display pins are fixed to SPI2 by the firmware and cannot be rewired on the bench: tick it in the shopping list to place it'),
  'gc9a01-touch': t('The round display pins are fixed to SPI2 by the firmware and cannot be rewired on the bench: tick it in the shopping list to place it'),
  max98357a: t('I2S pins are fixed per chip: tick it in the shopping list to place it'),
  inmp441: t('I2S pins are fixed per chip: tick it in the shopping list to place it'),
  'buzzer-passive': t('The bench only models the 3-pin buzzer module: use "Buzzer module" instead'),
};

/** Placeable: per-wire steps; otherwise the reason. */
export function placeDef(id: string): PlaceDef | { why: string } {
  const d = DEFS[id];
  const part = getPart(id);
  if (d) return { partId: id, name: t(part.name), ...d };
  if (WHY[id]) return { why: WHY[id] };
  if (part.sim.level === 'none') return { why: t('No simulation model: on the bench it would only be decoration; neither the wiring check nor the firmware can see it') };
  return { why: t('No pin-level model for it on the bench yet: see the confidence notes in Shop') };
}

/** Which bench pins (listPins ids: GPIOn / 3V3 / 5V / GND) fit this step. */
export function pinOk(want: Want, id: string): boolean {
  if (want === 'gpio') return /^GPIO\d+$/.test(id);
  if (want === 'gnd') return id === 'GND';
  return id === '3V3' || id === '5V';
}

/** GPIO a fixed-pin step needs on this chip (bench pin id), or null for a free step */
export const fixedPin = (step: PlaceStep, chip: ChipId) => (step.fixed ? `GPIO${LCD_WIRING[chip][step.fixed]}` : null);
/** Step accepts this bench pin: right kind, and the fixed LCD pin when the step has one */
export const stepOk = (step: PlaceStep, id: string, chip: ChipId) => pinOk(step.want, id) && (!step.fixed || id === fixedPin(step, chip));
/** Firmware for another chip switches the board: the core wires SPI2 to that chip's LCD pins, so the TFT's wires follow */
export function retargetTft(scene: SceneSpec, chip: ChipId) {
  for (const p of scene.parts) if (p.type === 'tft') Object.assign(p, LCD_WIRING[chip]);
}

/** Conflicts before placing: same single-instance module already present, or I2C address taken. */
export function placeConflict(def: PlaceDef, scene: SceneSpec): string | null {
  if (def.type === 'led' || def.type === 'key') return null;
  // The core has one LCD slot: a TFT cannot join the round display (or another TFT)
  const lcd = def.type === 'tft' && scene.parts.find((p) => p.type === 'gc9a01' || p.type === 'tft');
  if (lcd) return t('There is already a screen on the bench: the simulator drives one SPI display at a time');
  const same = scene.parts.find((p) => p.type === def.type);
  if (same) return t('There is already a {name} on the bench (one of each module, except LEDs and buttons)', { name: def.name });
  const addr = getPart(def.partId).i2cAddr?.default;
  if (addr !== undefined) {
    const hit = scene.parts.find((p) => 'addr' in p && p.addr === addr);
    if (hit) return t('I2C address 0x{addr} is already taken by the {type} on the bench', { addr: addr.toString(16), type: hit.type });
  }
  return null;
}

const gpio = (net: string | undefined) => (net && /^GPIO(\d+)$/.test(net) ? Number(net.slice(4)) : undefined);

/** Wired pins (step pin -> board pin id) -> scene part + power retargets for non-default rails. */
export function buildPlaced(def: PlaceDef, got: Record<string, string>, ext5v = false): { spec: PartSpec; retarget: Record<string, string> } {
  const g = (pin: string) => gpio(got[pin]);
  const addr = getPart(def.partId).i2cAddr?.default ?? 0;
  let spec: PartSpec;
  switch (def.type) {
    case 'led':
    case 'key':
    case 'buzzer':
    case 'servo':
    case 'pot':
      spec = { type: def.type, pin: g(def.steps.find((s) => s.want === 'gpio')!.pin)! };
      break;
    case 'dht11':
      spec = { type: 'dht11', pin: g('DATA')! };
      break;
    case 'ws2812':
      spec = { type: 'ws2812', pin: g('DIN')!, ...(def.partId === 'ws2812-strip' ? { n: 60 } : {}) };
      break;
    case 'oled':
      spec = { type: 'oled', addr, sda: g('SDA')!, scl: g('SCL')!, ...(def.ctl ? { ctl: def.ctl } : {}) };
      break;
    case 'bme280':
    case 'qmi8658':
      spec = { type: def.type, addr, sda: g('SDA')!, scl: g('SCL')! };
      break;
    case 'tft': {
      const pin = (r: string) => g(def.steps.find((s) => s.fixed === r)!.pin)!;
      spec = { type: 'tft', panel: def.panel!, sclk: pin('sclk'), mosi: pin('mosi'), cs: pin('cs'), dc: pin('dc'), rst: pin('rst'), bl: pin('bl') };
      break;
    }
    case 'mpu6050': {
      const int = g('INT');
      spec = { type: 'mpu6050', addr, sda: g('SDA')!, scl: g('SCL')!, ...(int !== undefined ? { int } : {}) };
      break;
    }
    case 'encoder': {
      const sw = g('SW');
      spec = { type: 'encoder', a: g('CLK')!, b: g('DT')!, ...(sw !== undefined ? { sw } : {}) };
      break;
    }
    case 'hcsr04':
      // Obstacle starts at 15 cm, same as when placed from Shop.
      spec = { type: 'hcsr04', trig: g('Trig')!, echo: g('Echo')!, cm: 15 };
      break;
    case 'ds18b20':
      spec = { type: 'ds18b20', pin: g('DQ')! };
      break;
    case 'pir':
      // Short hold so a tap is visible quickly; the CLI default is 5 s
      spec = { type: 'pir', pin: g('OUT')!, hold: 2 };
      break;
    case 'relay':
      spec = { type: 'relay', pin: g('IN')! };
      break;
    case 'ldr':
      spec = { type: 'ldr', pin: g('AO')! };
      break;
    case 'rc522': {
      const rst = g('RST');
      spec = { type: 'rc522', cs: g('SDA')!, sck: g('SCK')!, mosi: g('MOSI')!, miso: g('MISO')!, ...(rst !== undefined ? { rst } : {}) };
      break;
    }
    default:
      throw new Error(`cannot place ${def.type}`);
  }
  const retarget: Record<string, string> = {};
  const wires = wiresOf([spec], ext5v);
  for (const s of def.steps) {
    if (s.want !== 'power' || !got[s.pin] || got[s.pin] === s.def) continue;
    const w = wires.find((x) => x.part === partId(spec) && x.pin === s.pin);
    if (w) retarget[w.id] = got[s.pin];
  }
  return { spec, retarget };
}

/** Merge into existing rewiring, keeping other parts' retargets. */
export function mergeMods(mods: WireMods, retarget: Record<string, string>): WireMods {
  return Object.keys(retarget).length ? { ...mods, retarget: { ...mods.retarget, ...retarget } } : mods;
}
