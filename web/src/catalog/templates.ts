// Shopping templates: what each project buys (required fixed, suggestions optional) and its default bench wiring.
// Wiring matches the scene of the same example in firmware/examples.json (catalog.test.ts compares them).
import { t } from '../i18n/index.ts';
import { getPart, type LcdPins, type Part } from './parts.ts';
import { LCD_WIRING } from '../chipid.ts';

/** One picked part: key tells apart several of the same model (defaults to partId) */
export interface Pick {
  partId: string;
  key?: string;
  qty?: number;
  /** Chosen I2C address (after a jumper change); defaults to the library default */
  addr?: number;
}

// One wire: a part pin to a net ('GPIOn', '3V3', '5V' = board 5V / VBUS, 'GND', 'EXT5V' = external 5 V rail, 'EXT3V3').
// via: the device in between (divider, level shifter, transistor), which the rules accept as a fix.
export interface Wire {
  part: string;
  pin: string;
  net: string;
  via?: 'divider' | 'level-shifter' | 'transistor';
}

export interface FirmwareUse {
  /** Whether the firmware turns on Wi-Fi (R12, R20, R21) */
  wifi?: boolean;
  /** Which GPIO the firmware treats as the on-board RGB LED (R23) */
  rgbGpio?: number;
  /** Firmware needs PSRAM (large frame buffers, camera, audio; R30) */
  psram?: boolean;
  /** Pins the firmware uses for the on-board display (R32: Waveshare touch and no-touch differ) */
  lcdPins?: LcdPins;
}

export interface BuyLine {
  partId: string;
  qty: number;
  why: string;
}

export interface ProcureTemplate {
  id: 'weather' | 'spin' | 'lens' | 'usbkey' | 'lamp' | 'ruler' | 'tilt' | 'door' | 'irlamp' | 'cloud' | 'blank' | 'custom';
  title: string;
  /** Matching level (firmware/levels.json id; level 07 variants are written 07:spin) */
  level: string | null;
  /** Matching example / product id (firmware/examples.json, views/templates.ts) */
  product: string | null;
  board: string;
  required: BuyLine[];
  /** checked: ticked by default */
  suggested: (BuyLine & { checked: boolean })[];
  wiring: Wire[];
  firmware: FirmwareUse;
}

const GC9A01_WIRING: Wire[] = [
  { part: 'gc9a01', pin: 'VCC', net: '3V3' },
  { part: 'gc9a01', pin: 'GND', net: 'GND' },
  { part: 'gc9a01', pin: 'SCL', net: 'GPIO12' },
  { part: 'gc9a01', pin: 'SDA', net: 'GPIO11' },
  { part: 'gc9a01', pin: 'CS', net: 'GPIO10' },
  { part: 'gc9a01', pin: 'DC', net: 'GPIO14' },
  { part: 'gc9a01', pin: 'RES', net: 'GPIO13' },
  { part: 'gc9a01', pin: 'BLK', net: 'GPIO15' },
];
const SERVO_EXT_WIRING: Wire[] = [
  { part: 'sg90', pin: '棕 GND', net: 'GND' }, // lint: allow-cjk
  { part: 'sg90', pin: '红 VCC', net: 'EXT5V' }, // lint: allow-cjk
  { part: 'sg90', pin: '橙 PWM', net: 'GPIO4' }, // lint: allow-cjk
  { part: 'dc-jack', pin: '+', net: 'EXT5V' },
  { part: 'dc-jack', pin: '-', net: 'GND' },
];
const SERVO: BuyLine = { partId: 'sg90', qty: 1, why: 'Servo for the dial needle or for turning around' };
// Servo supply is a ticked suggestion: removing it lets R27 / R20 explain the USB brown-out on the spot
// and the bench shows the under-voltage demo (docs/DECISIONS.md 2026-10-16 shopping page)
const SERVO_SUPPLY: (BuyLine & { checked: boolean })[] = [
  { partId: 'psu-5v2a', qty: 1, checked: true, why: 'Separate servo supply: on computer USB the start-up sag resets the board' },
  { partId: 'dc-jack', qty: 1, checked: true, why: 'Takes the power plug onto the breadboard' },
];
const CABLE: BuyLine = { partId: 'usb-c-cable', qty: 1, why: 'For flashing and the serial monitor; must be a data cable' };

export const PROCURE_TEMPLATES: ProcureTemplate[] = [
  {
    id: 'weather',
    title: 'Desk weather station',
    level: '06',
    product: 'weather',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: 'Firmware and the 3D board both follow v1.0 (RGB LED on GPIO48)' },
      { partId: 'bme280', qty: 1, why: 'Measures temperature, humidity and pressure' },
      { partId: 'ssd1306', qty: 1, why: 'Shows the readings' },
      SERVO,
      CABLE,
      { partId: 'dupont-mf', qty: 1, why: 'Module headers onto the breadboard' },
      { partId: 'enclosure-weather', qty: 1, why: 'Enclosure for assembly' },
    ],
    suggested: [
      ...SERVO_SUPPLY,
      { partId: 'breadboard-830', qty: 1, checked: true, why: 'Get it working on a breadboard before boxing it' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: 'Jumpers on the breadboard' },
      { partId: 'buzzer-module', qty: 1, checked: true, why: 'Beeps when the temperature is out of range (firmware GPIO5, audible on the product page)' },
      { partId: 'led-kit', qty: 1, checked: true, why: 'LED for checkpoints 01 / 02: shares GPIO5 with the buzzer, so a click while blinking is normal' },
      { partId: 'resistor-kit', qty: 1, checked: true, why: '220 Ω LED current limiting' },
      { partId: 'dupont-ff', qty: 1, checked: false, why: 'Connect headers directly when going into the enclosure' },
      { partId: 'cap-1000uf', qty: 1, checked: false, why: 'Across the servo supply to hold up the voltage while it moves' },
    ],
    wiring: [
      { part: 'ssd1306', pin: 'GND', net: 'GND' },
      { part: 'ssd1306', pin: 'VCC', net: '3V3' },
      { part: 'ssd1306', pin: 'SCL', net: 'GPIO9' },
      { part: 'ssd1306', pin: 'SDA', net: 'GPIO8' },
      { part: 'bme280', pin: 'VCC', net: '3V3' },
      { part: 'bme280', pin: 'GND', net: 'GND' },
      { part: 'bme280', pin: 'SCL', net: 'GPIO9' },
      { part: 'bme280', pin: 'SDA', net: 'GPIO8' },
      ...SERVO_EXT_WIRING,
      { part: 'buzzer-module', pin: 'VCC', net: '3V3' },
      { part: 'buzzer-module', pin: 'I/O', net: 'GPIO5' },
      { part: 'buzzer-module', pin: 'GND', net: 'GND' },
      { part: 'led-kit', pin: '长脚 +', net: 'GPIO5' }, // lint: allow-cjk
      { part: 'led-kit', pin: '短脚 -', net: 'GND' }, // lint: allow-cjk
    ],
    firmware: { wifi: false, rgbGpio: 48 },
  },
  {
    id: 'spin',
    title: 'Xiaohuang who turns around',
    level: '07:spin',
    product: 'spin',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: 'Acceptance firmware targets the S3' },
      { partId: 'gc9a01', qty: 1, why: 'Round display face' },
      SERVO,
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: 'Round display headers straight to the board' },
      { partId: 'enclosure-spin', qty: 1, why: 'Body and turntable base' },
    ],
    suggested: [
      ...SERVO_SUPPLY,
      { partId: 'breadboard-830', qty: 1, checked: true, why: 'Get it working before boxing it' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: 'Jumpers on the breadboard' },
      { partId: 'cap-1000uf', qty: 1, checked: false, why: 'Across the servo supply to hold up the voltage while it moves' },
      { partId: 'mg90s', qty: 1, checked: false, why: 'Metal gears if you want it to last longer' },
    ],
    wiring: [...GC9A01_WIRING, ...SERVO_EXT_WIRING],
    firmware: { wifi: false },
  },
  {
    id: 'lens',
    title: 'Little face in the lens',
    level: '07:lens',
    product: 'lens',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: 'Acceptance firmware targets the S3' },
      { partId: 'gc9a01', qty: 1, why: 'Round display eyes' },
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: 'Round display headers straight to the board' },
      { partId: 'enclosure-lens', qty: 1, why: 'Base and display bezel' },
      { partId: 'lens-dome', qty: 1, why: 'Magnifies the face so it looks more 3D' },
    ],
    suggested: [
      { partId: 'breadboard-830', qty: 1, checked: false, why: 'If you want to try it on a breadboard first' },
      { partId: 'dupont-mm', qty: 1, checked: false, why: 'Jumpers on the breadboard' },
    ],
    wiring: [...GC9A01_WIRING],
    firmware: { wifi: false },
  },
  {
    id: 'lamp',
    title: 'Knob lamp',
    level: 'lamp-3',
    product: 'lamp',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: 'Acceptance firmware targets the S3' },
      { partId: 'ws2812-stick8', qty: 1, why: 'Light: 8 WS2812s, DIN on GPIO5' },
      { partId: 'encoder', qty: 1, why: 'Knob: turn for brightness or color, press to switch' },
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: 'Module headers straight to the board' },
      { partId: 'enclosure-lamp', qty: 1, why: 'Lamp base and frosted shade' },
    ],
    suggested: [
      { partId: 'psu-5v2a', qty: 1, checked: true, why: 'Separate strip supply: 8 LEDs at full white take about 480 mA, which with the board exceeds the 500 mA of computer USB' },
      { partId: 'dc-jack', qty: 1, checked: true, why: 'Takes the power plug onto the breadboard' },
      { partId: 'level-ahct125', qty: 1, checked: true, why: 'A 5 V strip wants data above 3.5 V; driving it with 3.3 V sometimes garbles colors' },
      { partId: 'breadboard-830', qty: 1, checked: true, why: 'Get it working before boxing it' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: 'Jumpers on the breadboard' },
      { partId: 'cap-1000uf', qty: 1, checked: false, why: 'Across the strip supply to hold up the voltage; a must for long strips' },
    ],
    wiring: [
      { part: 'ws2812-stick8', pin: '5V', net: 'EXT5V' },
      { part: 'ws2812-stick8', pin: 'DIN', net: 'GPIO5', via: 'level-shifter' },
      { part: 'ws2812-stick8', pin: 'GND', net: 'GND' },
      { part: 'encoder', pin: 'GND', net: 'GND' },
      { part: 'encoder', pin: '+', net: '3V3' },
      { part: 'encoder', pin: 'SW', net: 'GPIO15' },
      { part: 'encoder', pin: 'DT', net: 'GPIO7' },
      { part: 'encoder', pin: 'CLK', net: 'GPIO6' },
      { part: 'dc-jack', pin: '+', net: 'EXT5V' },
      { part: 'dc-jack', pin: '-', net: 'GND' },
    ],
    firmware: { wifi: false },
  },
  {
    id: 'ruler',
    title: 'Ultrasonic ruler',
    level: 'ruler-3',
    product: 'ruler',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: 'Acceptance firmware targets the S3' },
      { partId: 'hc-sr04', qty: 1, why: 'Ranging: Trig GPIO17, Echo through a divider into GPIO18' },
      { partId: 'resistor-kit', qty: 1, why: 'Echo is 5 V: a 1 kΩ / 2 kΩ divider brings it to about 3.3 V' },
      { partId: 'ssd1306', qty: 1, why: 'Shows the distance' },
      { partId: 'buzzer-module', qty: 1, why: 'Beeps faster the closer it gets (GPIO5)' },
      CABLE,
      { partId: 'dupont-mf', qty: 1, why: 'Module headers onto the breadboard' },
      { partId: 'enclosure-ruler', qty: 1, why: 'Handheld enclosure with two sensor holes at the front' },
    ],
    suggested: [
      { partId: 'breadboard-830', qty: 1, checked: true, why: 'The divider resistors sit on the breadboard' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: 'Jumpers on the breadboard' },
      { partId: 'dupont-ff', qty: 1, checked: false, why: 'Connect headers directly when going into the enclosure' },
    ],
    wiring: [
      { part: 'hc-sr04', pin: 'VCC', net: '5V' },
      { part: 'hc-sr04', pin: 'Trig', net: 'GPIO17' },
      { part: 'hc-sr04', pin: 'Echo', net: 'GPIO18', via: 'divider' },
      { part: 'hc-sr04', pin: 'GND', net: 'GND' },
      { part: 'ssd1306', pin: 'GND', net: 'GND' },
      { part: 'ssd1306', pin: 'VCC', net: '3V3' },
      { part: 'ssd1306', pin: 'SCL', net: 'GPIO9' },
      { part: 'ssd1306', pin: 'SDA', net: 'GPIO8' },
      { part: 'buzzer-module', pin: 'VCC', net: '3V3' },
      { part: 'buzzer-module', pin: 'I/O', net: 'GPIO5' },
      { part: 'buzzer-module', pin: 'GND', net: 'GND' },
    ],
    firmware: { wifi: false },
  },
  {
    id: 'tilt',
    title: 'Tilt buddy',
    level: 'tilt-3',
    product: 'tilt',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: 'Acceptance firmware targets the S3' },
      { partId: 'qmi8658', qty: 1, why: 'Senses tilt (I2C 0x6B)' },
      { partId: 'gc9a01', qty: 1, why: 'Round display: the little bean slides on it' },
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: 'Module headers straight to the board' },
      { partId: 'enclosure-tilt', qty: 1, why: 'Disc enclosure with the round display on top' },
    ],
    suggested: [
      { partId: 'breadboard-830', qty: 1, checked: false, why: 'If you want to try it on a breadboard first' },
      { partId: 'dupont-mm', qty: 1, checked: false, why: 'Jumpers on the breadboard' },
    ],
    wiring: [
      ...GC9A01_WIRING,
      { part: 'qmi8658', pin: 'VIN', net: '3V3' },
      { part: 'qmi8658', pin: 'GND', net: 'GND' },
      { part: 'qmi8658', pin: 'SCL', net: 'GPIO9' },
      { part: 'qmi8658', pin: 'SDA', net: 'GPIO8' },
    ],
    firmware: { wifi: false },
  },
  {
    id: 'door',
    title: 'RFID door lock',
    level: 'door-4',
    product: 'door',
    board: 'c3-devkitm1',
    required: [
      { partId: 'c3-devkitm1', qty: 1, why: 'Acceptance firmware targets the C3' },
      { partId: 'rc522', qty: 1, why: 'Reads card UIDs over SPI (CS GPIO7, RST GPIO3); 3.3 V only' },
      { partId: 'sh1106', qty: 1, why: 'Shows WELCOME / DENIED and the lockout countdown (SDA GPIO2, SCL GPIO9)' },
      { partId: 'relay-1ch', qty: 1, why: 'Switches the door strike (IN GPIO10)' },
      { partId: 'buzzer-module', qty: 1, why: 'Short beep to open, long beep to refuse (GPIO1)' },
      { partId: 'led-kit', qty: 1, why: 'Red LED blinks on a refused card (GPIO0)' },
      { partId: 'resistor-kit', qty: 1, why: '330 Ω in series with the LED' },
      { partId: 'door-strike-12v', qty: 1, why: 'The lock itself, on the relay contacts: needs real hardware' },
      { partId: 'psu-12v1a', qty: 1, why: '12 V for the strike only, never into the dev board' },
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: 'Module headers straight to the board' },
      { partId: 'enclosure-door', qty: 1, why: 'Wall panel: card zone over the reader, screen window above it' },
    ],
    suggested: [
      { partId: 'breadboard-830', qty: 1, checked: true, why: 'LED and resistor sit on the breadboard' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: 'Jumpers on the breadboard' },
    ],
    wiring: [
      { part: 'rc522', pin: '3.3V', net: '3V3' },
      { part: 'rc522', pin: 'GND', net: 'GND' },
      { part: 'rc522', pin: 'SDA', net: 'GPIO7' },
      { part: 'rc522', pin: 'SCK', net: 'GPIO4' },
      { part: 'rc522', pin: 'MOSI', net: 'GPIO6' },
      { part: 'rc522', pin: 'MISO', net: 'GPIO5' },
      { part: 'rc522', pin: 'RST', net: 'GPIO3' },
      { part: 'sh1106', pin: 'GND', net: 'GND' },
      { part: 'sh1106', pin: 'VCC', net: '3V3' },
      { part: 'sh1106', pin: 'SCL', net: 'GPIO9' },
      { part: 'sh1106', pin: 'SDA', net: 'GPIO2' },
      { part: 'relay-1ch', pin: 'VCC', net: '5V' },
      { part: 'relay-1ch', pin: 'GND', net: 'GND' },
      { part: 'relay-1ch', pin: 'IN', net: 'GPIO10' },
      { part: 'buzzer-module', pin: 'VCC', net: '3V3' },
      { part: 'buzzer-module', pin: 'I/O', net: 'GPIO1' },
      { part: 'buzzer-module', pin: 'GND', net: 'GND' },
      { part: 'led-kit', pin: '长脚 +', net: 'GPIO0' }, // lint: allow-cjk
      { part: 'led-kit', pin: '短脚 -', net: 'GND' }, // lint: allow-cjk
    ],
    firmware: { wifi: false },
  },
  {
    id: 'irlamp',
    title: 'IR remote night light',
    level: 'irlamp-4',
    product: 'irlamp',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: 'Acceptance firmware targets the S3' },
      { partId: 'ws2812-stick8', qty: 1, why: 'Light: 8 WS2812s, DIN on GPIO5' },
      { partId: 'vs1838b', qty: 1, why: 'Receives the remote: OUT on GPIO4, powered from 3V3' },
      { partId: 'ir-remote-nec21', qty: 1, why: 'Digits pick a colour, VOL+ / VOL- set brightness, CH- (0x45) switches on and off' },
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: 'Module headers straight to the board' },
      { partId: 'enclosure-lamp', qty: 1, why: 'Lamp base and frosted shade (receiver window in the base)' },
    ],
    suggested: [
      { partId: 'psu-5v2a', qty: 1, checked: true, why: 'Separate strip supply: 8 LEDs at full white take about 480 mA, which with the board exceeds the 500 mA of computer USB' },
      { partId: 'dc-jack', qty: 1, checked: true, why: 'Takes the power plug onto the breadboard' },
      { partId: 'level-ahct125', qty: 1, checked: true, why: 'A 5 V strip wants data above 3.5 V; driving it with 3.3 V sometimes garbles colors' },
      { partId: 'breadboard-830', qty: 1, checked: true, why: 'Get it working before boxing it' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: 'Jumpers on the breadboard' },
    ],
    wiring: [
      { part: 'ws2812-stick8', pin: '5V', net: 'EXT5V' },
      { part: 'ws2812-stick8', pin: 'DIN', net: 'GPIO5', via: 'level-shifter' },
      { part: 'ws2812-stick8', pin: 'GND', net: 'GND' },
      { part: 'vs1838b', pin: 'OUT', net: 'GPIO4' },
      { part: 'vs1838b', pin: 'GND', net: 'GND' },
      { part: 'vs1838b', pin: 'VCC', net: '3V3' },
      { part: 'dc-jack', pin: '+', net: 'EXT5V' },
      { part: 'dc-jack', pin: '-', net: 'GND' },
    ],
    firmware: { wifi: false },
  },
  {
    id: 'cloud',
    title: 'Temperature and humidity to the cloud',
    level: 'cloud-4',
    product: 'cloud',
    board: 'c3-devkitm1',
    required: [
      { partId: 'c3-devkitm1', qty: 1, why: 'Acceptance firmware targets the C3; Wi-Fi is built in' },
      { partId: 'aht20', qty: 1, why: 'Temperature and humidity over I2C (SDA GPIO6, SCL GPIO7, address 0x38); power it from 3V3' },
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: 'Module header straight to the board' },
    ],
    suggested: [
      { partId: 'breadboard-830', qty: 1, checked: false, why: 'If you want to try it on a breadboard first' },
      { partId: 'dupont-mm', qty: 1, checked: false, why: 'Jumpers on the breadboard' },
    ],
    wiring: [
      { part: 'aht20', pin: 'VCC', net: '3V3' },
      { part: 'aht20', pin: 'GND', net: 'GND' },
      { part: 'aht20', pin: 'SCL', net: 'GPIO7' },
      { part: 'aht20', pin: 'SDA', net: 'GPIO6' },
    ],
    firmware: { wifi: true },
  },
  {
    id: 'usbkey',
    title: 'USB mini keypad',
    level: 'usbkey-3',
    product: 'usbkey',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: 'Needs native USB (the port labeled USB or OTG): C3 USB can only be a serial port, not a keyboard' },
      { partId: 'usb-c-cable', qty: 1, why: 'Data cable (not a charge-only one): plug into the OTG port' },
      { partId: 'button', qty: 4, why: 'K1–K3 send a, b, c; K4 is the macro key' },
      { partId: 'enclosure-usbkey', qty: 1, why: 'Bottom shell, plate and keycaps' },
    ],
    suggested: [
      { partId: 'breadboard-830', qty: 1, checked: true, why: 'Get it working on a breadboard before boxing it' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: 'Buttons to the board' },
    ],
    wiring: [
      { part: 'button', pin: 'A', net: 'GPIO4' },
      { part: 'button', pin: 'B', net: 'GND' },
      { part: 'button', pin: 'A', net: 'GPIO5' },
      { part: 'button', pin: 'B', net: 'GND' },
      { part: 'button', pin: 'A', net: 'GPIO6' },
      { part: 'button', pin: 'B', net: 'GND' },
      { part: 'button', pin: 'A', net: 'GPIO7' },
      { part: 'button', pin: 'B', net: 'GND' },
    ],
    firmware: { wifi: false },
  },
  {
    id: 'blank',
    title: 'Blank',
    level: null,
    product: null,
    board: 's3-devkitc1-v11',
    required: [CABLE],
    suggested: [
      { partId: 's3-devkitc1-v11', qty: 1, checked: true, why: 'Most boards bought new today are v1.1' },
      { partId: 'breadboard-830', qty: 1, checked: true, why: 'For building circuits' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: 'Jumpers on the breadboard' },
      { partId: 'dupont-mf', qty: 1, checked: true, why: 'Modules onto the breadboard' },
      { partId: 'resistor-kit', qty: 1, checked: true, why: 'Current limiting, dividers, pull-ups' },
      { partId: 'led-kit', qty: 1, checked: true, why: 'First experiment: light an LED' },
      { partId: 'button', qty: 4, checked: true, why: 'Input' },
    ],
    wiring: [],
    firmware: {},
  },
];

export const TEMPLATE_BY_ID: Record<string, ProcureTemplate> = Object.fromEntries(PROCURE_TEMPLATES.map((t) => [t.id, t]));

/** Template generated from the advisor result (work=custom, app/custom.ts): registered once at startup for replay, rules and bench */
export function registerTemplate(t: ProcureTemplate) {
  TEMPLATE_BY_ID[t.id] = t;
}

export function getTemplate(id: string): ProcureTemplate {
  const t = TEMPLATE_BY_ID[id];
  if (!t) throw new Error(`no shopping template ${id}`);
  return t;
}

/** Template required part: greyed tick on the shop page, cannot be removed (R27 blocks if it is) */
export function isRequired(templateId: string, partId: string): boolean {
  return getTemplate(templateId).required.some((l) => l.partId === partId);
}

/** Remove one part from the list; required parts are refused with a reason */
export function removePick(templateId: string, picks: Pick[], partId: string): { picks: Pick[]; refused?: string } {
  if (isRequired(templateId, partId)) {
    const l = getTemplate(templateId).required.find((x) => x.partId === partId)!;
    return { picks, refused: t('Required parts cannot be removed: {part} ({why})', { part: t(getPart(partId).name), why: t(l.why) }) };
  }
  return { picks: picks.filter((p) => p.partId !== partId && p.key !== partId) };
}

/** Template -> default picks (required + ticked suggestions; includeAll brings every suggestion) */
export function templatePicks(id: string, opts: { includeAll?: boolean } = {}): Pick[] {
  const t = getTemplate(id);
  const lines = [...t.required, ...t.suggested.filter((s) => opts.includeAll || s.checked)];
  const out: Pick[] = [];
  for (const l of lines) {
    const had = out.find((p) => p.partId === l.partId);
    if (had) had.qty = Math.max(had.qty ?? 1, l.qty);
    else out.push({ partId: l.partId, qty: l.qty });
  }
  return out;
}

/** A full rule engine input draft: board + picks + wiring + firmware use */
export function templateInput(id: string, opts: { includeAll?: boolean } = {}) {
  const t = getTemplate(id);
  return { template: t.id, board: t.board, parts: templatePicks(id, opts), wiring: t.wiring.map((w) => ({ ...w })), firmware: { ...t.firmware } };
}

/** BOM total (range, CNY); the board counts even when it is not in picks */
export function bomTotal(picks: Pick[], board?: string): { lo: number; hi: number; lines: { part: Part; qty: number; lo: number; hi: number }[] } {
  const all = [...picks];
  if (board && !all.some((p) => p.partId === board)) all.unshift({ partId: board, qty: 1 });
  const lines = all.map((p) => {
    const part = getPart(p.partId);
    const qty = p.qty ?? 1;
    return { part, qty, lo: part.price.lo * qty, hi: part.price.hi * qty };
  });
  const round = (x: number) => Math.round(x * 100) / 100;
  return { lo: round(lines.reduce((s, l) => s + l.lo, 0)), hi: round(lines.reduce((s, l) => s + l.hi, 0)), lines };
}

/** Part library -> bench scene part type (same names as examples.json scene.parts[].type) */
const SCENE_TYPE: Record<string, string> = { ssd1306: 'oled', bme280: 'bme280', sg90: 'servo', mg90s: 'servo', gc9a01: 'gc9a01', 'gc9a01-touch': 'gc9a01-touch', 'led-kit': 'led', 'buzzer-module': 'buzzer', 'buzzer-passive': 'buzzer', mpu6050: 'mpu6050', qmi8658: 'qmi8658', button: 'key', encoder: 'encoder', 'hc-sr04': 'hcsr04', 'ws2812-stick8': 'ws2812', 'ws2812-strip': 'ws2812', pot: 'pot', dht11: 'dht11', sh1106: 'oled', rc522: 'rc522', 'relay-1ch': 'relay', vs1838b: 'irrx', st7789: 'tft', 'st7789-240x320': 'tft', ili9341: 'tft' };
/** Bare SPI TFT catalog part -> panel (= CLI --spi name, F-04a2) */
const TFT_PANEL: Record<string, string> = { st7789: 'st7789-240x240', 'st7789-240x320': 'st7789-240x320', ili9341: 'ili9341' };
/** Keycap labels (usbkey: K1–K3 send a / b / c, K4 is the macro key) */
const KEY_CAPS = ['a', 'b', 'c', 'M'];

/** Wiring -> bench scene (for "place it on the bench after buying"; same format as examples.json scene.parts) */
export function toScene(picks: Pick[], wiring: Wire[]): { type: string; [k: string]: unknown }[] {
  const out: { type: string; [k: string]: unknown }[] = [];
  const gpioOf = (key: string, pinType: string) => {
    const part = getPart(picks.find((p) => (p.key ?? p.partId) === key)!.partId);
    for (const w of wiring) {
      if (w.part !== key) continue;
      const pin = part.pins?.find((x) => x.label === w.pin);
      const m = /^GPIO(\d+)$/.exec(w.net);
      if (pin?.type === pinType && m) return Number(m[1]);
    }
    return undefined;
  };
  // Order by first appearance in the wiring (matches examples.json scene order); unwired parts go last
  const firstWire = (p: Pick) => {
    const i = wiring.findIndex((w) => w.part === (p.key ?? p.partId));
    return i < 0 ? wiring.length : i;
  };
  const ordered = picks.map((p, i) => ({ p, i })).sort((a, b) => firstWire(a.p) - firstWire(b.p) || a.i - b.i).map((x) => x.p);
  for (const p of ordered) {
    const type = SCENE_TYPE[p.partId];
    if (!type) continue;
    const key = p.key ?? p.partId;
    const part = getPart(p.partId);
    if (type === 'oled' || type === 'bme280') {
      out.push({ type, addr: p.addr ?? part.i2cAddr!.default, sda: gpioOf(key, 'i2c-sda'), scl: gpioOf(key, 'i2c-scl'), ...(p.partId === 'sh1106' ? { ctl: 'sh1106' } : {}) });
    } else if (type === 'tft') {
      // The core wires SPI2 to the chip's fixed LCD pins: take them from the listed board (no board = unplaced, listed as skipped)
      const chip = picks.map((x) => getPart(x.partId).board?.chip).find((c) => c !== undefined);
      const w = chip ? LCD_WIRING[chip] : undefined;
      out.push({ type, panel: TFT_PANEL[p.partId], sclk: w?.sclk, mosi: w?.mosi, cs: w?.cs, dc: w?.dc, rst: w?.rst, bl: w?.bl });
    } else if (type === 'servo') {
      out.push({ type, pin: gpioOf(key, 'pwm') });
    } else if (type === 'mpu6050' || type === 'qmi8658') {
      const int = type === 'mpu6050' ? gpioOf(key, 'digital-out') : undefined;
      out.push({ type, addr: p.addr ?? part.i2cAddr!.default, sda: gpioOf(key, 'i2c-sda'), scl: gpioOf(key, 'i2c-scl'), ...(int !== undefined ? { int } : {}) });
    } else if (type === 'gc9a01') {
      // The simulator only knows the round display on SPI2; pins come from the firmware
      out.push({ type, spi: 2 });
    } else if (type === 'gc9a01-touch') {
      // Touch round display = display + its CST816S (touch pins found by label, since TP_RST and RES share the reset type)
      const byLabel = (label: string) => {
        const w = wiring.find((x) => x.part === key && x.pin === label);
        const m = w && /^GPIO(\d+)$/.exec(w.net);
        return m ? Number(m[1]) : undefined;
      };
      out.push({ type: 'gc9a01', spi: 2 });
      const rst = byLabel('TP_RST');
      out.push({ type: 'cst816s', addr: p.addr ?? part.i2cAddr!.default, sda: byLabel('TP_SDA'), scl: byLabel('TP_SCL'), int: byLabel('TP_INT'), ...(rst !== undefined ? { rst } : {}) });
    } else if (type === 'buzzer') {
      const pin = gpioOf(key, 'pwm');
      if (pin !== undefined) out.push({ type, pin });
    } else if (type === 'relay') {
      const pin = gpioOf(key, 'digital-in');
      if (pin !== undefined) out.push({ type, pin });
    } else if (type === 'rc522') {
      const cs = gpioOf(key, 'spi-cs'), sck = gpioOf(key, 'spi-sclk'), mosi = gpioOf(key, 'spi-mosi'), miso = gpioOf(key, 'spi-miso'), rst = gpioOf(key, 'rst');
      if (cs !== undefined) out.push({ type, cs, sck, mosi, miso, rst });
    } else if (type === 'irrx') {
      const pin = gpioOf(key, 'digital-out');
      if (pin !== undefined) out.push({ type, pin });
    } else if (type === 'led') {
      const pin = gpioOf(key, 'io');
      if (pin !== undefined) out.push({ type, pin });
    } else if (type === 'pot') {
      // A pot is placed only when its wiper is wired: stock templates leave it unwired, advisor custom templates wire it
      const pin = gpioOf(key, 'analog');
      if (pin !== undefined) out.push({ type, pin });
    } else if (type === 'dht11') {
      const pin = gpioOf(key, 'onewire');
      if (pin !== undefined) out.push({ type, pin });
    } else if (type === 'encoder' || type === 'hcsr04' || type === 'ws2812') {
      // Find by label (the three encoder lines share the digital-out type)
      const byLabel = (label: string) => {
        const w = wiring.find((x) => x.part === key && x.pin === label);
        const m = w && /^GPIO(\d+)$/.exec(w.net);
        return m ? Number(m[1]) : undefined;
      };
      if (type === 'encoder') {
        const a = byLabel('CLK'), b = byLabel('DT'), sw = byLabel('SW');
        if (a !== undefined && b !== undefined) out.push({ type, a, b, ...(sw !== undefined ? { sw } : {}) });
      } else if (type === 'hcsr04') {
        const trig = byLabel('Trig'), echo = byLabel('Echo');
        const div = wiring.find((x) => x.part === key && x.pin === 'Echo')?.via === 'divider';
        // Obstacle starts at 15 cm (sensor, board and target all fit the default camera)
        if (trig !== undefined && echo !== undefined) out.push({ type, trig, echo, ...(div ? {} : { divider: false }), cm: 15 });
      } else {
        const pin = byLabel('DIN');
        if (pin !== undefined) out.push({ type, pin, ...(p.partId === 'ws2812-strip' ? { n: 60 } : {}) });
      }
    } else if (type === 'key') {
      // One list line can be several buttons: one per A pin wired to a GPIO
      wiring.filter((w) => w.part === key && w.pin === 'A' && /^GPIO\d+$/.test(w.net)).forEach((w, i) => out.push({ type, pin: Number(w.net.slice(4)), cap: KEY_CAPS[i] ?? String(i + 1), label: `K${i + 1} · ${w.net}` }));
    }
  }
  return out;
}
