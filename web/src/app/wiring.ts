// Bench wiring: derived from the scene declaration (examples.json / scene placed by the BOM), plus "rewires" (injected faults).
// Pure, tested by node --test; ids follow scene-api 'wire:<board pin>~<part>:<silkscreen>', same as the 3D bench.
import type { PartSpec } from '../board3d';
import { isI2cMod } from '../bench3d/spec.ts';
import { BENCH_WIRE_CM } from './harness.ts';
import { LED_OHM_DEFAULT, ohmText } from '../bench3d/ledparams.ts';
import { I2S_WIRING, micPins, spkPins } from '../i2spins.ts';
import { t } from '../i18n/index.ts';
import { TFT_HEADER, TFT_PX } from '../lcdspec.ts';

const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

export interface PartInfo {
  name: string;
  model: string;
  iface: string;
  power: string;
}

/** Part type → display name (timeline, hints and build tree all use this so raw type names never leak into the UI) */
export const PART_LABEL: Record<PartSpec['type'], string> = { bme280: 'BME280', oled: 'OLED', servo: t('Servo'), gc9a01: t('Round screen'), tft: t('Color screen'), buzzer: t('Buzzer'), pot: t('Potentiometer'), led: 'LED', encoder: t('Encoder'), hcsr04: t('Ultrasonic'), mpu6050: 'MPU6050', qmi8658: 'QMI8658', cst816s: t('Touch'), max98357a: t('Speaker'), inmp441: t('Microphone'), key: t('Button'), ws2812: t('LED strip'), dht11: 'DHT11', ds18b20: 'DS18B20', pir: t('PIR sensor'), relay: t('Relay'), ldr: t('Light sensor'), rc522: 'RC522', irrx: t('IR receiver'), irled: t('IR LED'), aht20: 'AHT20', ina219: 'INA219', ds3231: 'DS3231' };
export const partLabel = (type: string) => PART_LABEL[type as PartSpec['type']] ?? t('Part');

export function partId(p: PartSpec) {
  return p.type === 'led' || p.type === 'key' ? `${p.type}:${p.pin}` : p.type;
}

/** H-09 bench view: only the parts in `keep` (null = all). Wires belong to their part, so they go with it; the sim keeps the full scene. */
export function sceneView<S extends { parts: PartSpec[] }>(spec: S, keep: readonly string[] | null): S {
  return keep ? { ...spec, parts: spec.parts.filter((p) => keep.includes(partId(p))) } : spec;
}

export function partInfo(p: PartSpec, ext5v = false): PartInfo {
  const i2c = (x: { addr: number; sda: number; scl: number }) => `I2C ${hex(x.addr)} · SDA GPIO${x.sda} · SCL GPIO${x.scl}`;
  switch (p.type) {
    case 'bme280':
      return { name: 'BME280', model: t('Bosch BME280 module (temperature / humidity / pressure)'), iface: i2c(p), power: '3V3' };
    case 'aht20':
      return { name: 'AHT20', model: t('Aosong AHT20 module (temperature / humidity)'), iface: i2c(p), power: '3V3' };
    case 'ina219':
      return { name: 'INA219', model: t("TI INA219 module (bus voltage / current, 0.1 Ω shunt): measures the board's USB 5 V rail"), iface: i2c(p), power: '3V3' };
    case 'ds3231':
      return { name: t('DS3231 clock'), model: t('ZS-042 DS3231 RTC module (clock + temperature; the AT24C32 EEPROM is not modelled)'), iface: i2c(p), power: '3V3' };
    case 'oled':
      if (p.ctl === 'sh1106') return { name: 'SH1106 OLED', model: t('1.3″ 128×64 monochrome OLED (SH1106, 132-column memory)'), iface: i2c(p), power: '3V3' };
      return { name: 'SSD1306 OLED', model: t('0.96″ 128×64 monochrome OLED (SSD1306)'), iface: i2c(p), power: '3V3' };
    case 'tft': {
      const [w, h] = TFT_PX[p.panel];
      const name = p.panel === 'ili9341' ? t('ILI9341 color screen') : t('ST7789 color screen');
      const size = p.panel === 'ili9341' ? '2.4″' : p.panel === 'st7789-240x240' ? '1.54″' : '2.0″';
      return { name, model: t('{size} {w}×{h} RGB TFT module ({ctl}, SPI)', { size, w, h, ctl: p.panel === 'ili9341' ? 'ILI9341' : 'ST7789' }), iface: `SPI2 · SCLK ${p.sclk} · MOSI ${p.mosi} · CS ${p.cs} · DC ${p.dc} · RST ${p.rst} · BL ${p.bl}`, power: '3V3' };
    }
    case 'servo':
      return { name: t('SG90 servo'), model: t('SG90 9 g micro servo, 50 Hz PWM, 0.5–2.5 ms pulse maps to 0–180°'), iface: t('Signal GPIO{pin}', { pin: p.pin }), power: ext5v ? t('5V (external 5 V 2 A)') : t('5V (straight from USB)') };
    case 'gc9a01':
      return { name: t('GC9A01 round screen'), model: t('1.28″ 240×240 RGB round screen (GC9A01)'), iface: 'SPI2 · SCLK 12 · MOSI 11 · CS 10 · DC 14 · RST 13 · BL 15', power: '3V3' };
    case 'pot':
      return { name: t('Potentiometer (GPIO{pin})', { pin: p.pin }), model: t('10 kΩ rotary potentiometer'), iface: t('Wiper GPIO{pin} (ADC)', { pin: p.pin }), power: '3V3' };
    case 'led':
      return { name: `LED (GPIO${p.pin})`, model: t('5 mm LED with a {ohm} Ω series resistor', { ohm: ohmText(p.ohm ?? LED_OHM_DEFAULT) }), iface: t('GPIO{pin}, lit when high', { pin: p.pin }), power: t('Via GPIO') };
    case 'key':
      return { name: p.cap ? t('Button {cap} (GPIO{pin})', { cap: p.cap, pin: p.pin }) : t('Button (GPIO{pin})', { pin: p.pin }), model: t('6×6 mm tactile switch with keycap'), iface: t('GPIO{pin}, grounded when pressed (internal pull-up)', { pin: p.pin }), power: t('No power needed') };
    case 'buzzer':
      return { name: t('Passive buzzer'), model: t('Passive buzzer module (3-pin, transistor, driven by an LEDC square wave)'), iface: t('I/O to GPIO{pin}', { pin: p.pin }), power: '3V3' };
    case 'encoder': {
      const pins = `CLK GPIO${p.a} · DT GPIO${p.b}${p.sw !== undefined ? ` · SW GPIO${p.sw}` : ''}`;
      return { name: t('EC11 rotary encoder'), model: t('EC11 encoder module (KY-040 style, 20 detents per turn, quadrature A/B plus push button, 10 kΩ pull-ups on board)'), iface: t('{pins} (counted by PCNT on S3)', { pins }), power: '3V3' };
    }
    case 'hcsr04': {
      const pins = `Trig GPIO${p.trig} · Echo GPIO${p.echo}`;
      return { name: t('HC-SR04 ultrasonic'), model: t('HC-SR04 ultrasonic ranger (2–400 cm, 40 kHz, 5 V Echo output)'), iface: p.divider === false ? t('{pins} (direct: 5 V into the GPIO will damage the pin)', { pins }) : t('{pins} (through a 1 kΩ / 2 kΩ divider to about 3.3 V)', { pins }), power: t('5V (USB 5V rail, about 15 mA)') };
    }
    case 'dht11':
      return { name: 'DHT11', model: t('DHT11 temperature / humidity module (0–50 °C ±2 °C, 20–90 %RH ±5 %, single-wire)'), iface: t('DATA GPIO{pin} (open drain, 10 kΩ pull-up on the module)', { pin: p.pin }), power: '3V3' };
    case 'mpu6050':
      return { name: t('MPU6050 6-axis'), model: t('GY-521 module (InvenSense MPU-6050, 3-axis accelerometer and 3-axis gyro)'), iface: `${i2c(p)}${p.int !== undefined ? ` · INT GPIO${p.int}` : ''}`, power: '3V3' };
    case 'qmi8658':
      return { name: t('QMI8658 6-axis'), model: t('QST QMI8658 6-axis IMU board'), iface: i2c(p), power: '3V3' };
    case 'cst816s':
      return { name: t('CST816S touch'), model: t('Capacitive touch layer on the round screen (Hynitron CST816S, single touch and gestures)'), iface: `${i2c(p)} · INT GPIO${p.int}${p.rst !== undefined ? ` · RST GPIO${p.rst}` : ''}`, power: t('3V3 (shared with the round screen)') };
    case 'max98357a': {
      const w = spkPins(I2S_WIRING.esp32s3.spk, p);
      return { name: t('MAX98357A amp and speaker'), model: t('MAX98357A I2S class-D amp module (3 W) with a Φ40 4 Ω speaker'), iface: `I2S · BCLK ${w.bclk} · LRC ${w.lrc} · DIN ${w.din}`, power: '5V' };
    }
    case 'ws2812': {
      const n = p.n ?? 8;
      return { name: t('WS2812 strip × {n}', { n }), model: t('WS2812B-5050 × 8 LED board (GRB, 800 kHz)'), iface: t('DIN GPIO{pin} (RMT transmit, level-shifted to 5 V by a 74AHCT125)', { pin: p.pin }), power: t('5V (about {ma} mA at full white, estimate)', { ma: n * 60 }) };
    }
    case 'inmp441': {
      const w = micPins(I2S_WIRING.esp32s3.mic, p);
      return { name: t('INMP441 microphone'), model: t('INMP441 I2S digital MEMS microphone module (24-bit, L/R grounded = left channel)'), iface: `I2S · SCK ${w.sck} · WS ${w.ws} · SD ${w.sd}`, power: '3V3' };
    }
    case 'ds18b20':
      return { name: (p.n ?? 1) > 1 ? t('DS18B20 probes × {n}', { n: p.n ?? 1 }) : 'DS18B20', model: t('DS18B20 waterproof 1-Wire temperature probe (−55–125 °C, ±0.5 °C, 12-bit)'), iface: t('DQ GPIO{pin} (1-Wire, 4.7 kΩ pull-up to 3V3)', { pin: p.pin }), power: '3V3' };
    case 'pir':
      return { name: t('HC-SR501 PIR sensor'), model: t('HC-SR501 passive infrared motion module (retriggerable, 3.3 V output)'), iface: t('OUT GPIO{pin} (high while motion is seen, hold {s} s)', { pin: p.pin, s: p.hold ?? 5 }), power: '5V' };
    case 'relay':
      return { name: t('Relay module'), model: t('1-channel 5 V relay module (SRD-05VDC, optocoupler input)'), iface: p.low ? t('IN GPIO{pin} (closes when low)', { pin: p.pin }) : t('IN GPIO{pin} (closes when high)', { pin: p.pin }), power: '5V' };
    case 'ldr':
      return { name: t('Photoresistor module'), model: t('GL5528 photoresistor with a 10 kΩ divider (brighter = higher voltage)'), iface: t('AO GPIO{pin} (ADC)', { pin: p.pin }), power: '3V3' };
    case 'rc522': {
      const pins = [p.cs !== undefined ? `SDA GPIO${p.cs}` : '', p.sck !== undefined ? `SCK GPIO${p.sck}` : '', p.mosi !== undefined ? `MOSI GPIO${p.mosi}` : '', p.miso !== undefined ? `MISO GPIO${p.miso}` : ''].filter(Boolean).join(' · ');
      return { name: t('RC522 RFID reader'), model: t('MFRC522 13.56 MHz RFID reader (reads card UIDs, SPI2)'), iface: `SPI2 · ${pins || t('CS on the chip default pin')}`, power: '3V3' };
    }
    case 'irrx':
      return { name: t('IR receiver'), model: t('VS1838B-class 38 kHz IR receiver (demodulated, active-low output)'), iface: t('OUT GPIO{pin} (low while a 38 kHz burst is seen)', { pin: p.pin }), power: '3V3' };
    case 'irled':
      return { name: t('IR LED'), model: t('940 nm IR LED module (current-limited, faces the receiver)'), iface: t('S GPIO{pin} (high = LED on, 38 kHz carrier from RMT / LEDC)', { pin: p.pin }), power: '—' };
  }
}

/** Pin role in the circuit: drive = the pin pushes its own level (can fight a GPIO output), load = driven by GPIO,
 *  bus = open-drain bus, power / gnd = supply */
export type PinRole = 'drive' | 'load' | 'bus' | 'power' | 'gnd';

export interface BenchWire {
  id: string;
  /** Board end (net name: GPIOn / 3V3 / 5V / EXT5V / GND) */
  a: string;
  /** Part end '<part id>:<silkscreen>' */
  b: string;
  part: string;
  pin: string;
  role: string;
  pinRole: PinRole;
  /** Display color name of the jumper wire */
  color: string;
  /** Series current-limiting resistor (Ω), LEDs only; 0 = none */
  ohm?: number;
  /** Removed by a rewire (still drawn on the bench, rule checks treat it as absent) */
  missing?: boolean;
  /** Was rewired (where it used to go) */
  from?: string;
  /** Wire length (cm, estimate; P2-11 I2C rise time) */
  lenCm: number;
  /** 5 V output divided down to 3.3 V before the GPIO (HC-SR04 Echo); false = direct */
  divider?: boolean;
}

/** Rewires that create faulty wiring for rule checks (debug hook / wiring tool), keyed by existing 3D wire ids */
export interface WireMods {
  /** Unplugged wires */
  drop?: string[];
  /** Move to another net: wire id → new net */
  retarget?: Record<string, string>;
  /** LEDs with the current-limiting resistor removed (part ids) */
  noResistor?: string[];
  /** Lengthen / shorten a part's wires (part id → cm, P2-11); unset ones use BENCH_WIRE_CM */
  lenCm?: Record<string, number>;
  /** Ultrasonic sensors with the Echo divider removed (part ids): 5 V straight into the GPIO */
  noDivider?: string[];
  /** Board-to-board jumpers (P2-14: e.g. ['3V3', 'GND'] shorts the rail to ground); part name is 'jumper' */
  jumpers?: [string, string][];
}

/** H-14 lesson wiring tab: the rows of the parts the bench draws for a lesson (`keep` = Lesson.parts, null = all). */
export const lessonWires = (parts: PartSpec[], keep: readonly string[] | null, ext5v = false, mods: WireMods = {}) =>
  wiresOf(sceneView({ parts }, keep).parts, ext5v, mods);

export function wiresOf(parts: PartSpec[], ext5v = false, mods: WireMods = {}): BenchWire[] {
  const w: BenchWire[] = [];
  const C = { black: t('Black'), red: t('Red'), yellow: t('Yellow'), green: t('Green'), orange: t('Orange'), purple: t('Purple'), blue: t('Blue'), cyan: t('Cyan'), grey: t('Grey') };
  const R = { gnd: t('Ground'), vcc: t('Power'), scl: t('I2C clock'), sda: t('I2C data'), key: t('Button (grounded when pressed)'), bclk: t('I2S bit clock'), lrc: t('I2S word clock') };
  const vbus = ext5v ? t('Power (external 5 V)') : t('Power (USB 5 V)');
  // Wire ids use the end drawn on the 3D bench (servo VCC is always drawn to the 5V pin; with external 5 V the net is EXT5V, id unchanged)
  const add = (a: string, part: string, pin: string, role: string, pinRole: PinRole, color: string, extra: Partial<BenchWire> = {}, drawnA = a) => {
    const b = `${part}:${pin}`;
    let id = `wire:${drawnA}~${b}`;
    for (let k = 2; w.some((x) => x.id === id); k++) id = `wire:${drawnA}~${b}#${k}`;
    w.push({ id, a, b, part, pin, role, pinRole, color, lenCm: mods.lenCm?.[part] ?? BENCH_WIRE_CM, ...extra });
  };
  for (const p of parts) {
    const id = partId(p);
    if (p.type === 'bme280' || p.type === 'oled' || isI2cMod(p)) {
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
      add('3V3', id, p.type === 'bme280' ? 'VIN' : 'VCC', R.vcc, 'power', C.red);
      add(`GPIO${p.scl}`, id, 'SCL', R.scl, 'bus', C.yellow);
      add(`GPIO${p.sda}`, id, 'SDA', R.sda, 'bus', C.green);
    } else if (p.type === 'servo') {
      add(`GPIO${p.pin}`, id, 'PWM', t('PWM signal'), 'load', C.orange);
      add(ext5v ? 'EXT5V' : '5V', id, 'VCC', vbus, 'power', C.red, {}, '5V');
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'gc9a01') {
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
      add('3V3', id, 'VCC', R.vcc, 'power', C.red);
      for (const [g, n, r] of [[12, 'SCL', 'SPI SCLK'], [11, 'SDA', 'SPI MOSI'], [13, 'RES', 'LCD RST'], [14, 'DC', 'LCD DC'], [10, 'CS', 'LCD CS'], [15, 'BLK', t('LCD backlight')]] as const) add(`GPIO${g}`, id, n, r, 'load', C.orange);
    } else if (p.type === 'tft') {
      // Firmware drives SPI2 on the chip's fixed LCD pins; SDO (MISO) stays open, as on most hobby wiring
      const role = { sclk: 'SPI SCLK', mosi: 'SPI MOSI', rst: 'LCD RST', dc: 'LCD DC', cs: 'LCD CS', bl: t('LCD backlight') } as const;
      for (const [n, r] of TFT_HEADER[p.panel]) {
        if (r === 'gnd') add('GND', id, n, R.gnd, 'gnd', C.black);
        else if (r === 'vcc') add('3V3', id, n, R.vcc, 'power', C.red);
        else if (r !== 'miso') add(`GPIO${p[r]}`, id, n, role[r], 'load', r === 'cs' ? C.purple : C.orange);
      }
    } else if (p.type === 'pot') {
      add('3V3', id, 'VCC', R.vcc, 'power', C.red);
      add(`GPIO${p.pin}`, id, 'OUT', t('Analog input (wiper)'), 'drive', C.orange);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'led') {
      add(`GPIO${p.pin}`, id, 'IN', t('Output (through {ohm} Ω)', { ohm: ohmText(p.ohm ?? LED_OHM_DEFAULT) }), 'load', C.orange, { ohm: p.ohm ?? LED_OHM_DEFAULT });
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'key') {
      // A button only pulls the pin to ground when pressed; it never drives high, so it is not "output on output"
      add(`GPIO${p.pin}`, id, 'IN', R.key, 'load', C.orange);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'encoder') {
      // KY-040: CLK / DT are pulled up to "+" on board and grounded by the contacts, so the module drives these lines
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
      add('3V3', id, '+', t('Power (pull-up)'), 'power', C.red);
      if (p.sw !== undefined) add(`GPIO${p.sw}`, id, 'SW', R.key, 'drive', C.purple);
      add(`GPIO${p.b}`, id, 'DT', t('Phase B (DT)'), 'drive', C.green);
      add(`GPIO${p.a}`, id, 'CLK', t('Phase A (CLK)'), 'drive', C.yellow);
    } else if (p.type === 'hcsr04') {
      add('5V', id, 'VCC', t('Power (5 V)'), 'power', C.red);
      add(`GPIO${p.trig}`, id, 'Trig', t('Trigger (GPIO outputs a 10 µs high pulse)'), 'load', C.orange);
      add(`GPIO${p.echo}`, id, 'Echo', p.divider === false ? t('Echo (5 V, direct)') : t('Echo (through a 1k/2k divider)'), 'drive', C.blue, { divider: p.divider !== false });
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'mpu6050' || p.type === 'qmi8658') {
      add('3V3', id, p.type === 'mpu6050' ? 'VCC' : 'VIN', R.vcc, 'power', C.red);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
      add(`GPIO${p.scl}`, id, 'SCL', R.scl, 'bus', C.yellow);
      add(`GPIO${p.sda}`, id, 'SDA', R.sda, 'bus', C.green);
      if (p.type === 'mpu6050' && p.int !== undefined) add(`GPIO${p.int}`, id, 'INT', t('Data-ready interrupt (module output)'), 'drive', C.cyan);
    } else if (p.type === 'cst816s') {
      // Touch wires live on the round-screen module (last 4 pins of the same header); power is shared with the screen
      add(`GPIO${p.sda}`, id, 'TP_SDA', t('Touch I2C data'), 'bus', C.green);
      add(`GPIO${p.scl}`, id, 'TP_SCL', t('Touch I2C clock'), 'bus', C.yellow);
      add(`GPIO${p.int}`, id, 'TP_INT', t('Touch interrupt (low while touched)'), 'drive', C.cyan);
      add(p.rst !== undefined ? `GPIO${p.rst}` : '3V3', id, 'TP_RST', t('Touch reset'), p.rst !== undefined ? 'load' : 'power', C.grey);
    } else if (p.type === 'buzzer') {
      // 3-pin module: I/O drives the buzzer through the module's transistor, the GPIO only drives the base
      add('3V3', id, 'VCC', R.vcc, 'power', C.red);
      add(`GPIO${p.pin}`, id, 'I/O', t('Square-wave drive (LEDC)'), 'load', C.orange);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'ws2812') {
      add(ext5v ? 'EXT5V' : '5V', id, '5V', vbus, 'power', C.red, {}, '5V');
      add(`GPIO${p.pin}`, id, 'DIN', t('Data (RMT, level-shifted)'), 'load', C.orange);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'max98357a') {
      const s = spkPins(I2S_WIRING.esp32s3.spk, p);
      add('5V', id, 'Vin', t('Power (5 V)'), 'power', C.red);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
      add(`GPIO${s.bclk}`, id, 'BCLK', R.bclk, 'load', C.yellow);
      add(`GPIO${s.lrc}`, id, 'LRC', R.lrc, 'load', C.green);
      add(`GPIO${s.din}`, id, 'DIN', t('I2S data (out)'), 'load', C.orange);
    } else if (p.type === 'inmp441') {
      const s = micPins(I2S_WIRING.esp32s3.mic, p);
      add('3V3', id, 'VDD', R.vcc, 'power', C.red);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
      add('GND', id, 'L/R', t('Channel select (grounded = left)'), 'gnd', C.black);
      add(`GPIO${s.sck}`, id, 'SCK', R.bclk, 'load', C.yellow);
      add(`GPIO${s.ws}`, id, 'WS', R.lrc, 'load', C.green);
      add(`GPIO${s.sd}`, id, 'SD', t('I2S data (in)'), 'drive', C.orange);
    } else if (p.type === 'ds18b20') {
      add('3V3', id, 'VDD', R.vcc, 'power', C.red);
      add(`GPIO${p.pin}`, id, 'DQ', t('1-Wire data (open drain, 4.7 kΩ pull-up)'), 'bus', C.yellow);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'pir') {
      add('5V', id, 'VCC', t('Power (5 V)'), 'power', C.red);
      add(`GPIO${p.pin}`, id, 'OUT', t('Motion output (3.3 V high)'), 'drive', C.yellow);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'relay') {
      add('5V', id, 'VCC', t('Power (5 V)'), 'power', C.red);
      add(`GPIO${p.pin}`, id, 'IN', t('Relay control input'), 'load', C.orange);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'ldr') {
      add('3V3', id, 'VCC', R.vcc, 'power', C.red);
      add(`GPIO${p.pin}`, id, 'AO', t('Analog light level'), 'drive', C.orange);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'irrx') {
      add('GPIO' + p.pin, id, 'OUT', t('IR receiver output (low = burst)'), 'drive', C.yellow);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
      add('3V3', id, 'VCC', R.vcc, 'power', C.red);
    } else if (p.type === 'irled') {
      add('GPIO' + p.pin, id, 'S', t('IR LED drive'), 'load', C.orange);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
    } else if (p.type === 'rc522') {
      // Only SDA (CS) reaches the model; the bus wires are drawn where they were placed (firmware sets SPI2 pins)
      add('3V3', id, '3.3V', R.vcc, 'power', C.red);
      add('GND', id, 'GND', R.gnd, 'gnd', C.black);
      const spi = [[p.cs, 'SDA', t('SPI chip select')], [p.sck, 'SCK', 'SPI SCLK'], [p.mosi, 'MOSI', 'SPI MOSI'], [p.rst, 'RST', t('Reader reset')]] as const;
      for (const [g, n, r] of spi) if (g !== undefined) add(`GPIO${g}`, id, n, r, 'load', n === 'SDA' ? C.purple : C.orange);
      if (p.miso !== undefined) add(`GPIO${p.miso}`, id, 'MISO', 'SPI MISO', 'drive', C.blue);
    }
  }
  const drop = new Set(mods.drop ?? []);
  const nores = new Set(mods.noResistor ?? []);
  const nodiv = new Set(mods.noDivider ?? []);
  for (const x of w) {
    if (drop.has(x.id)) x.missing = true;
    const to = mods.retarget?.[x.id];
    if (to && to !== x.a) {
      x.from = x.a;
      x.a = to;
    }
    if (x.ohm !== undefined && nores.has(x.part)) {
      x.ohm = 0;
      x.role = t('Output (direct, no resistor)');
    }
    if (x.divider !== undefined && nodiv.has(x.part)) x.divider = false;
  }
  for (const [a, b] of mods.jumpers ?? []) w.push({ id: `wire:${a}~${b}`, a, b, part: 'jumper', pin: b, role: t('Jumper ({a} → {b})', { a, b }), pinRole: 'power', color: t('Red'), lenCm: BENCH_WIRE_CM });
  return w;
}

/** Board pins in use (the build tree's "Pins" group lists only these) */
export function usedPins(wires: BenchWire[]): string[] {
  const seen = new Set<string>();
  for (const w of wires) if (!w.missing) seen.add(w.a);
  return [...seen];
}

export const emptyMods = (m: WireMods | null | undefined) => !m || (!m.drop?.length && !m.noResistor?.length && !m.noDivider?.length && !m.jumpers?.length && !Object.keys(m.retarget ?? {}).length && !Object.keys(m.lenCm ?? {}).length);

/** I2C buses: modules on the same SDA / SCL pair and total SDA wire length (cm); SCL is assumed equally long */
export function i2cBuses(parts: PartSpec[], wires: BenchWire[]): { key: string; parts: string[]; wireCm: number; wires: string[] }[] {
  const out = new Map<string, { key: string; parts: string[]; wireCm: number; wires: string[] }>();
  for (const p of parts) {
    if (p.type !== 'oled' && p.type !== 'bme280' && p.type !== 'mpu6050' && p.type !== 'qmi8658' && !isI2cMod(p)) continue;
    const key = `GPIO${p.sda}/GPIO${p.scl}`;
    const b = out.get(key) ?? { key, parts: [], wireCm: 0, wires: [] };
    const id = partId(p);
    b.parts.push(id);
    const own = wires.filter((w) => w.part === id && w.pinRole === 'bus' && !w.missing);
    b.wireCm += own.find((w) => w.pin === 'SDA')?.lenCm ?? 0;
    b.wires.push(...own.map((w) => w.id));
    out.set(key, b);
  }
  return [...out.values()];
}

/** Hand the harness to the simulator only if the bench changed a wire length (else ideal bus, as the CLI default); cm, -1 = ideal */
export function benchI2cWire(parts: PartSpec[], mods: WireMods): number {
  if (!Object.keys(mods.lenCm ?? {}).length) return -1;
  const buses = i2cBuses(parts, wiresOf(parts, false, mods));
  return buses.length ? Math.max(...buses.map((b) => b.wireCm)) : -1;
}
