// Part catalog: plain data shared by the shop, the rule engine and "put it on the bench" (P0-06, RESEARCH_PROCURE §1).
// Datasheet values only (unsure = null + todo); prices are manual estimates; links are search pages only (LICENSING).
import { AMOLED216 } from './aioboards.ts';

export type ChipId = 'esp32' | 'esp32c3' | 'esp32s3';

export type Kind =
  | 'board'
  | 'sensor'
  | 'display'
  | 'actuator'
  | 'input'
  | 'audio'
  | 'power'
  | 'cable'
  | 'passive'
  | 'module'
  | 'proto'
  | 'enclosure';

export type PinType =
  | 'power'
  | 'gnd'
  | 'io'
  | 'rst'
  | 'en'
  | 'i2c-sda'
  | 'i2c-scl'
  | 'spi-sclk'
  | 'spi-mosi'
  | 'spi-miso'
  | 'spi-cs'
  | 'spi-dc'
  | 'backlight'
  | 'pwm'
  | 'analog'
  | 'onewire'
  | 'ws2812-din'
  | 'ws2812-dout'
  | 'i2s-bclk'
  | 'i2s-ws'
  | 'i2s-data'
  | 'digital-in'
  | 'digital-out'
  | 'addr'
  | 'passive'
  | 'nc';

export interface Pin {
  /** Silkscreen / wire colour */
  label: string;
  type: PinType;
  /** Level on this line (V): number = fixed; 'vcc' = follows module supply; null = n/a or set externally */
  v: number | 'vcc' | null;
  /** GPIO behind a dev-board pin */
  gpio?: number;
  /** Direction seen from the module: out = module drives a level into the GPIO */
  dir?: 'in' | 'out' | 'bi';
  /** Pull or level the module puts on this line at power-up (strapping rules R05–R08) */
  boot?: 'pull-up' | 'pull-down' | 'drive-low' | 'drive-high';
  /** Current drawn from the pin when wired straight to a GPIO (mA), for R22 */
  loadMa?: number;
  note?: string;
}

export type OnboardKind = 'rgb' | 'led' | 'boot' | 'button' | 'lcd' | 'imu' | 'touch' | 'ir' | 'adc' | 'other';
export type BusRole = 'spi-sclk' | 'spi-mosi' | 'spi-miso' | 'i2c-sda' | 'i2c-scl';

export interface Onboard {
  gpio: number;
  what: string;
  kind: OnboardKind;
  /** Shareable bus line: an external pin with the same role only warns; any other use blocks */
  share?: BusRole;
}

/** Display control lines (R32 compares board and firmware) */
export interface LcdPins {
  sclk: number;
  mosi: number;
  cs: number;
  dc: number;
  rst: number;
  bl: number;
}

export interface BoardInfo {
  chip: ChipId;
  /** Hardware revision of one model (DevKitC-1 v1.0 / v1.1 differ in RGB pin, R23) */
  family?: string;
  version?: string;
  flashMB: number | null;
  psramMB: number | null;
  /** Octal PSRAM takes GPIO33–37 (R03); null = unverified */
  psram: 'none' | 'quad' | 'octal' | null;
  /** On-board pin use: kind=boot goes to strapping rules, the rest to R24 (lcd / imu / touch lines block) */
  onboard: Onboard[];
  /** Soldered-on parts equivalent to catalog parts (R29: buying another is a duplicate and steals pins) */
  builtin?: { partId: string; what: string }[];
  /** On-board display pins (R32: revisions differ; firmware for the other one shows a black screen) */
  lcd?: LcdPins;
  /** Source URLs (official user guide / wiki / schematic first) */
  urls: string[];
  /** GPIO of the on-board WS2812; null if none */
  rgbGpio: number | null;
  /** On-board 3.3 V regulator (R21) */
  ldo: { model: string | null; maxMa: number | null };
  /** USB: native = chip USB only; uart = USB-serial bridge only; both = two ports */
  usb: 'native' | 'uart' | 'both' | null;
  /** Has Li-ion charging on board (R27) */
  charger: boolean;
}

export interface Price {
  lo: number;
  hi: number;
  currency: 'CNY';
  /** Month the price was checked, YYYY-MM */
  checkedAt: string;
  source: string;
  /** Checked by a human item by item (agent estimates are false) */
  verified: boolean;
}

export type SimLevel = 'verified' | 'estimated' | 'none';

export interface Part {
  id: string;
  name: string;
  kind: Kind;
  model: string;
  /** Compatible chips (list all three for external modules that work with any) */
  chips: ChipId[];
  pins: Pin[] | null;
  voltage: { supply: [number, number] | null; logic: number | null };
  currentMa: { typ: number | null; peak: number | null; est: boolean; source: string };
  i2cAddr: { default: number; alt: number[]; how?: string } | null;
  /** On-module I2C pull-up (kΩ); null = unverified / n/a (R16 assumes 4.7 kΩ) */
  i2cPullupK?: number | null;
  /** Length × width × height (mm); unknown height is null */
  sizeMm: [number, number, number | null] | null;
  /** verified = model covered by acceptance firmware; estimated = approximate / estimate only; none = no model */
  sim: { level: SimLevel; model: string | null };
  price: Price;
  /** Marketplace search keywords (key specs); Chinese because the shops are Chinese */
  keywords: string;
  searchUrl: { taobao: string; szlcsc: string };
  /** Default supply net when no wiring is given */
  supplyNet?: '3V3' | '5V' | 'EXT5V' | 'BAT';
  /** This part supplies a rail (external PSU, regulator module) */
  provides?: { net: 'EXT5V' | 'EXT3V3'; maxMa: number };
  /** Accessories that must be bought with it (R27) */
  requires?: { partId: string; why: string }[];
  /** Metal parts / batteries block the antenna if placed near it (R26) */
  rfBlocker?: boolean;
  board?: BoardInfo;
  sources: string[];
  /** Fields to verify ("field: note"); every null field must appear here or in na */
  todo: string[];
  /** Fields that do not apply (a cable has no supply voltage): null by meaning, not missing data */
  na?: string[];
  note: string;
}

export const CHECKED_AT = '2026-10';
const PRICE_SRC = 'Estimated from typical Taobao prices, not individually verified, shipping excluded';

export const searchUrls = (kw: string) => ({
  taobao: 'https://s.taobao.com/search?q=' + encodeURIComponent(kw),
  szlcsc: 'https://so.szlcsc.com/global.html?k=' + encodeURIComponent(kw),
});

export type Draft = Omit<Part, 'price' | 'searchUrl' | 'todo' | 'sources' | 'chips' | 'i2cAddr' | 'sim' | 'sizeMm'> & {
  price: [number, number];
  sizeMm?: Part['sizeMm'];
  chips?: ChipId[];
  i2cAddr?: Part['i2cAddr'];
  sim?: Part['sim'];
  todo?: string[];
  sources?: string[];
};

// External modules only care about levels and buses, so the classic ESP32 works too (added in C-05)
const BOTH: ChipId[] = ['esp32', 'esp32c3', 'esp32s3'];

function P(d: Draft): Part {
  return {
    ...d,
    chips: d.chips ?? BOTH,
    i2cAddr: d.i2cAddr ?? null,
    sizeMm: d.sizeMm ?? null,
    sim: d.sim ?? { level: 'none', model: null },
    price: { lo: d.price[0], hi: d.price[1], currency: 'CNY', checkedAt: CHECKED_AT, source: PRICE_SRC, verified: false },
    searchUrl: searchUrls(d.keywords),
    sources: d.sources ?? [],
    todo: d.todo ?? [],
  };
}

const pin = (label: string, type: PinType, v: Pin['v'], extra: Partial<Pin> = {}): Pin => ({ label, type, v, ...extra });
const VCC = (label = 'VCC') => pin(label, 'power', 'vcc');
const GND = (label = 'GND') => pin(label, 'gnd', 0);

/** Dev-board header: numbers are GPIOs, the rest are power / ground / reset labels */
function header(list: (number | string)[], names: Record<number, string> = {}): Pin[] {
  return list.map((x) => {
    if (typeof x === 'number') return pin(names[x] ?? `GPIO${x}`, 'io', 3.3, { gpio: x, dir: 'bi' });
    if (x === 'GND' || x === 'G') return GND('GND');
    if (x === '3V3') return pin('3V3', 'power', 3.3);
    if (x === '5V' || x === 'VBUS' || x === 'VSYS') return pin(x, 'power', 5);
    if (x === 'RST' || x === 'EN') return pin(x, 'rst', 3.3);
    return pin(x, 'nc', null);
  });
}

// ESP32-S3-DevKitC-1 user guide v1.0 / v1.1 headers J1 / J3 (same headers; only the RGB LED moved)
const S3_DEVKITC_PINS = header(
  ['3V3', '3V3', 'RST', 4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9, 10, 11, 12, 13, 14, '5V', 'G',
   'G', 43, 44, 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0, 45, 48, 47, 21, 20, 19, 'G', 'G'],
  { 43: 'TX(GPIO43)', 44: 'RX(GPIO44)' },
);
// ESP32-C3-DevKitM-1 user guide J1 / J3
const C3_DEVKITM_PINS = header(
  ['G', '3V3', '3V3', 2, 3, 'G', 'RST', 'G', 0, 1, 10, 'G', '5V', '5V', 'G',
   'G', 21, 20, 'G', 9, 8, 'G', 7, 6, 5, 4, 'G', 18, 19, 'G'],
  { 21: 'TX(GPIO21)', 20: 'RX(GPIO20)' },
);
// ESP32-DevKitC V4 user guide J1 / J3 (VP / VN = GPIO36 / 39; SD0–SD3 / CMD / CLK go to the module flash)
const E32_DEVKITC_PINS = header(
  ['3V3', 'EN', 36, 39, 34, 35, 32, 33, 25, 26, 27, 14, 12, 'G', 13, 'SD2', 'SD3', 'CMD', '5V',
   'G', 23, 22, 1, 3, 21, 'G', 19, 18, 5, 17, 16, 4, 0, 2, 15, 'SD1', 'SD0', 'CLK'],
  { 36: 'VP(GPIO36)', 39: 'VN(GPIO39)', 1: 'TX(GPIO1)', 3: 'RX(GPIO3)' },
);
// Seeed XIAO: D0–D10 + 5V / GND / 3V3 (Seeed Wiki pin table; matches arduino-esp32 variants)
const xiaoPins = (gpios: number[]) => [
  ...gpios.map((g, i) => pin(`D${i}(GPIO${g})`, 'io', 3.3, { gpio: g, dir: 'bi' })),
  pin('5V', 'power', 5),
  GND(),
  pin('3V3', 'power', 3.3),
];

const BOARD_CURRENT_NOTE = 'Whole-board current is estimated in the rules from the chip datasheet, not listed here';

export const PARTS: Part[] = [
  // ───────── Dev boards ─────────
  // Source URLs live in board.urls; fields not found or contradicted between sources go to todo (P1-12)
  P({
    id: 's3-devkitc1-v10',
    name: 'ESP32-S3-DevKitC-1 v1.0 (N16R8)',
    kind: 'board',
    model: 'ESP32-S3-DevKitC-1-N16R8 v1.0 (module ESP32-S3-WROOM-1-N16R8)',
    chips: ['esp32s3'],
    pins: S3_DEVKITC_PINS,
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sim: { level: 'verified', model: 's3-devkitc' },
    price: [35, 70],
    keywords: 'ESP32-S3-DevKitC-1 N16R8 开发板', // lint: allow-cjk
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'devkitc1', version: 'v1.0', flashMB: 16, psramMB: 8, psram: 'octal',
      onboard: [{ gpio: 48, what: 'On-board WS2812 RGB LED', kind: 'rgb' }, { gpio: 0, what: 'BOOT button', kind: 'boot' }],
      rgbGpio: 48, ldo: { model: null, maxMa: null }, usb: 'both', charger: false,
      urls: ['https://docs.espressif.com/projects/esp-dev-kits/zh_CN/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.0.html'],
    },
    sources: ['Espressif ESP32-S3-DevKitC-1 user guide (v1.0 / v1.1 pin tables, RGB LED GPIO)', 'ESP32-S3-WROOM-1 datasheet (N16R8 = 16 MB flash + 8 MB octal PSRAM)'],
    todo: ['sizeMm: advisor/data.ts says 26×63 mm, no source found', 'board.ldo: enter regulator model and rated current from the schematic', 'currentMa: whole-board idle current not measured', 'model: memory config per the actual marking (most sold are N16R8; Espressif ordering table unverified)'],
    note: 'RGB LED on GPIO48 (v1.1 moved it to GPIO38; check the back silkscreen). Octal PSRAM takes GPIO33–37. Two Type-C ports: UART and native USB.',
  }),
  P({
    id: 's3-devkitc1-v11',
    name: 'ESP32-S3-DevKitC-1 v1.1 (N16R8)',
    kind: 'board',
    model: 'ESP32-S3-DevKitC-1-N16R8 v1.1 (module ESP32-S3-WROOM-1-N16R8)',
    chips: ['esp32s3'],
    pins: S3_DEVKITC_PINS,
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sim: { level: 'estimated', model: 's3-devkitc' },
    price: [35, 70],
    keywords: 'ESP32-S3-DevKitC-1 v1.1 N16R8',
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'devkitc1', version: 'v1.1', flashMB: 16, psramMB: 8, psram: 'octal',
      onboard: [{ gpio: 38, what: 'On-board WS2812 RGB LED', kind: 'rgb' }, { gpio: 0, what: 'BOOT button', kind: 'boot' }],
      rgbGpio: 38, ldo: { model: null, maxMa: null }, usb: 'both', charger: false,
      urls: ['https://docs.espressif.com/projects/esp-dev-kits/zh_CN/latest/esp32s3/esp32-s3-devkitc-1/user_guide.html'],
    },
    sources: ['Espressif ESP32-S3-DevKitC-1 user guide v1.1 (RGB LED moved to GPIO38)'],
    todo: ['sizeMm: same as v1.0', 'board.ldo: enter regulator model and rated current from the schematic', 'currentMa: whole-board idle current not measured'],
    note: 'Differs from v1.0 only in the RGB LED pin: v1.1 uses GPIO38. The 3D board and acceptance firmware follow v1.0 (GPIO48), so this board counts as a behavioral model only.',
  }),
  P({
    id: 'luat-s3',
    name: 'LuatOS ESP32-S3 core board',
    kind: 'board',
    model: 'LuatOS ESP32S3-Luatos-Core (memory config unverified)',
    chips: ['esp32s3'],
    pins: null,
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sim: { level: 'estimated', model: 'esp32s3' },
    price: [25, 45],
    keywords: '合宙 ESP32S3 核心板', // lint: allow-cjk
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'luat-core', flashMB: 8, psramMB: null, psram: null,
      onboard: [
        { gpio: 10, what: 'On-board LED A (active high)', kind: 'led' },
        { gpio: 11, what: 'On-board LED B (active high)', kind: 'led' },
        { gpio: 0, what: 'BOOT button', kind: 'boot' },
      ],
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: null, charger: false,
      urls: [
        'https://wiki.luatos.com/chips/esp32s3/board.html',
        'https://github.com/zephyrproject-rtos/zephyr/tree/main/boards/luatos/esp32s3_luatos_core',
        'https://docs.zephyrproject.org/latest/boards/luatos/esp32s3_luatos_core/doc/index.html',
      ],
    },
    sources: [
      'Zephyr esp32s3_luatos_core.dtsi (Apache-2.0): LEDs GPIO10 / GPIO11 active high, BOOT GPIO0, flash 8 MB',
      'LuatOS wiki (wiki.luatos.com; fetch failed 2026-10; no schematic licence, facts only)',
    ],
    todo: [
      'pins: header table not entered (LuatOS wiki unreachable this time; Zephyr only has a pinout image)',
      'board.flashMB: Zephyr says 8 MB; another Zephyr page version and many sellers say 16 MB; trust the marking',
      'board.psramMB: Zephyr page says 8 MB PSRAM; no LuatOS original seen',
      'board.psram: octal PSRAM or not is unverified (the rules warn as "unverified")',
      'board.onboard: Zephyr docs also mention "addressable RGB LED on GPIO38", contradicting the dtsi (two plain LEDs); check the schematic',
      'board.usb: USB type (native / CH343 serial bridge) unverified',
      'board.ldo',
      'sizeMm',
      'currentMa',
    ],
    note: 'Cheap and popular. Two on-board LEDs on GPIO10 / 11 (they light up when peripherals use those pins). Memory varies by batch, so check the flash / PSRAM marking before buying; an R8 (octal PSRAM) part can\'t use GPIO33–37 either.',
  }),
  P({
    id: 'xiao-s3',
    name: 'Seeed XIAO ESP32S3',
    kind: 'board',
    model: 'XIAO ESP32S3 (8 MB flash, 8 MB octal PSRAM)',
    chips: ['esp32s3'],
    pins: xiaoPins([1, 2, 3, 4, 5, 6, 43, 44, 7, 8, 9]),
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: [21, 17.8, null],
    sim: { level: 'estimated', model: 'esp32s3' },
    price: [50, 75],
    keywords: 'Seeed XIAO ESP32S3',
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'xiao', flashMB: 8, psramMB: 8, psram: 'octal',
      onboard: [{ gpio: 21, what: 'User LED (active low)', kind: 'led' }, { gpio: 0, what: 'BOOT button', kind: 'boot' }],
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'native', charger: true,
      urls: ['https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/', 'https://github.com/platformio/platform-espressif32/blob/develop/boards/seeed_xiao_esp32s3.json'],
    },
    sources: ['Seeed Wiki XIAO ESP32S3 pin table (facts only; the GPL-3.0 wiki source is not copied)', 'PlatformIO seeed_xiao_esp32s3.json: memory_type qio_opi (octal PSRAM)'],
    todo: ['board.ldo: regulator rated current unverified', 'currentMa', 'sizeMm[2]: board thickness (with parts) unverified', 'board.psram: Seeed Wiki only says 8 MB; "octal" comes from PlatformIO qio_opi'],
    note: 'Only 11 GPIOs broken out: D0–D10 map to GPIO1–9, 43, 44; GPIO21 drives the user LED; D2 (GPIO3) is a strapping pin but harmless with default eFuses; D6 / D7 are UART0; battery pads and a charger are on the back.',
  }),
  P({
    id: 'c3-devkitm1',
    name: 'ESP32-C3-DevKitM-1',
    kind: 'board',
    model: 'ESP32-C3-DevKitM-1 (module ESP32-C3-MINI-1, 4 MB in-package flash)',
    chips: ['esp32c3'],
    pins: C3_DEVKITM_PINS,
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sim: { level: 'verified', model: 'c3-devkitm' },
    price: [40, 60],
    keywords: 'ESP32-C3-DevKitM-1 开发板', // lint: allow-cjk
    supplyNet: '5V',
    board: {
      chip: 'esp32c3', family: 'devkitm1', flashMB: 4, psramMB: 0, psram: 'none',
      onboard: [{ gpio: 8, what: 'On-board WS2812 RGB LED', kind: 'rgb' }, { gpio: 9, what: 'BOOT button', kind: 'boot' }],
      rgbGpio: 8, ldo: { model: null, maxMa: null }, usb: 'uart', charger: false,
      urls: ['https://docs.espressif.com/projects/esp-dev-kits/zh_CN/latest/esp32c3/esp32-c3-devkitm-1/user_guide.html'],
    },
    sources: ['Espressif ESP32-C3-DevKitM-1 user guide (J1 / J3 pin tables, RGB LED GPIO8, BOOT GPIO9)'],
    todo: ['pins: header order typed in from the user guide; to be checked by script against arduino-esp32 variants', 'board.usb: whether the only USB port is USB-UART is unverified', 'board.ldo', 'sizeMm', 'currentMa'],
    note: 'GPIO8 drives the RGB LED and GPIO9 is BOOT; both are strapping pins, so keep peripherals off them.',
  }),
  P({
    id: 'esp32-devkitc-v4',
    name: 'ESP32-DevKitC V4 (WROOM-32E)',
    kind: 'board',
    model: 'ESP32-DevKitC V4 (module ESP32-WROOM-32E, 4 MB flash, CP2102 USB-UART)',
    chips: ['esp32'],
    pins: E32_DEVKITC_PINS,
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: [54.4, 27.9, null],
    sim: { level: 'verified', model: 'esp32-devkitc' },
    price: [20, 45],
    keywords: 'ESP32-DevKitC V4 WROOM-32E 开发板', // lint: allow-cjk
    supplyNet: '5V',
    board: {
      chip: 'esp32', family: 'devkitc', version: 'v4', flashMB: 4, psramMB: 0, psram: 'none',
      onboard: [{ gpio: 0, what: 'BOOT button', kind: 'boot' }],
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'uart', charger: false,
      urls: ['https://docs.espressif.com/projects/esp-dev-kits/zh_CN/latest/esp32/esp32-devkitc/user_guide.html'],
    },
    sources: ['Espressif ESP32-DevKitC V4 user guide (J1 / J3 pin tables, BOOT GPIO0, board size 54.4 × 27.9 mm)'],
    todo: ['sizeMm[2]: height not measured', 'board.ldo: enter regulator model and rated current from the schematic', 'currentMa: whole-board idle current not measured'],
    note: 'No user LED (power LED only), so blinking needs an external LED. The two headers are 1″ apart, leaving no free holes on one side of an 830-hole breadboard. GPIO34–39 are input only; GPIO0 / 2 / 5 / 12 / 15 are strapping pins. TryBoard simulates GPIO, LEDC, I2C and Wi-Fi networking (open / WPA2 AP, HTTP); Bluetooth, DAC, touch, Hall and RMT need real hardware.',
  }),
  P({
    id: 'xiao-c3',
    name: 'Seeed XIAO ESP32C3',
    kind: 'board',
    model: 'XIAO ESP32C3 (4 MB flash, no PSRAM)',
    chips: ['esp32c3'],
    pins: xiaoPins([2, 3, 4, 5, 6, 7, 21, 20, 8, 9, 10]),
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: [21, 17.8, null],
    sim: { level: 'estimated', model: 'esp32c3' },
    price: [35, 50],
    keywords: 'Seeed XIAO ESP32C3',
    supplyNet: '5V',
    board: {
      chip: 'esp32c3', family: 'xiao', flashMB: 4, psramMB: 0, psram: 'none',
      onboard: [{ gpio: 9, what: 'BOOT button', kind: 'boot' }],
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'native', charger: true,
      urls: ['https://wiki.seeedstudio.com/XIAO_ESP32C3_Getting_Started/'],
    },
    sources: ['Seeed Wiki XIAO ESP32C3 pin table (D0 / D8 / D9 = GPIO2 / 8 / 9 marked strapping; no LED_BUILTIN)', 'arduino-esp32 variants/XIAO_ESP32C3 (read to cross-check, not copied)'],
    todo: ['board.ldo: Seeed Wiki power section says 3V3 gives 700 mA, the spec table says 500 mA; they contradict', 'currentMa', 'sizeMm[2]: board thickness (with parts) unverified'],
    note: 'D0, D8, D9 are GPIO2, 8, 9, all strapping pins and a classic trap; D9 is also the BOOT button. D6 / D7 are UART0. No PSRAM, no user LED.',
  }),
  P({
    id: 'm5-atoms3',
    name: 'M5Stack AtomS3',
    kind: 'board',
    model: 'M5Stack AtomS3 (ESP32-S3FN8: 8 MB in-package flash, no PSRAM; 0.85″ 128×128 display)',
    chips: ['esp32s3'],
    // Bottom header G5 / G6 / G7 / G8 / G38 / G39 + HY2.0-4P (Grove) port G1 / G2
    pins: [...header(['5V', 'G', '3V3', 5, 6, 7, 8, 38, 39]), pin('Grove 白(G1)', 'io', 3.3, { gpio: 1, dir: 'bi' }), pin('Grove 黄(G2)', 'io', 3.3, { gpio: 2, dir: 'bi' })], // lint: allow-cjk
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: [24, 24, 13],
    sim: { level: 'estimated', model: 'esp32s3' },
    price: [85, 120],
    keywords: 'M5Stack AtomS3 ESP32-S3 带屏', // lint: allow-cjk
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'm5-atoms3', flashMB: 8, psramMB: 0, psram: 'none',
      onboard: [
        { gpio: 21, what: 'On-board display MOSI', kind: 'lcd', share: 'spi-mosi' },
        { gpio: 17, what: 'On-board display SCK', kind: 'lcd', share: 'spi-sclk' },
        { gpio: 15, what: 'On-board display CS', kind: 'lcd' },
        { gpio: 33, what: 'On-board display DC(RS)', kind: 'lcd' },
        { gpio: 34, what: 'On-board display RST', kind: 'lcd' },
        { gpio: 16, what: 'On-board display backlight', kind: 'lcd' },
        { gpio: 38, what: 'On-board IMU MPU6886 SDA (0x68, bus shared with the bottom header)', kind: 'imu', share: 'i2c-sda' },
        { gpio: 39, what: 'On-board IMU MPU6886 SCL', kind: 'imu', share: 'i2c-scl' },
        { gpio: 41, what: 'Button under the screen (low when pressed)', kind: 'button' },
        { gpio: 4, what: 'IR emitter', kind: 'ir' },
      ],
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'native', charger: false,
      urls: ['https://docs.m5stack.com/zh_CN/core/AtomS3', 'https://github.com/m5stack/M5Unified'],
    },
    sources: ['M5Stack AtomS3 docs (GC9107 display pins, IMU MPU6886 0x68 on G38/G39, header G5–G8 / G38 / G39, Grove G1 / G2)', 'M5Unified (MIT): button GPIO41 low when pressed', 'ESP32-S3 datasheet ordering info: S3FN8 = 8 MB in-package flash, no PSRAM'],
    todo: [
      'board.onboard: IR emitter on GPIO4 comes from AtomS3 Lite docs; full AtomS3 schematic unverified',
      'board.usb: M5 docs only say "Type-C power and download", not whether it is native USB (Arduino USB_CDC_ON_BOOT=1 suggests native); check the schematic',
      'board.ldo',
      'currentMa',
      'sizeMm: M5 site says 24×24×13 mm, not verified',
    ],
    note: 'Comes with a case and a 0.85″ display, but exposes only 8 GPIOs (6 on the header + 2 on Grove), and G38 / G39 share I2C with the on-board IMU. You run out fast with several modules.',
  }),
  P({
    id: 'ws-s3-lcd128',
    name: 'Waveshare ESP32-S3-LCD-1.28 round-display board (no touch)',
    kind: 'board',
    model: 'Waveshare ESP32-S3-LCD-1.28 (ESP32-S3R2: 2 MB quad PSRAM + 16 MB external flash; on-board 1.28″ GC9A01 round display, QMI8658 IMU)',
    chips: ['esp32s3'],
    // Two 1.27 mm headers H1 / H2, from the NuttX board doc GPIO table (which says "the schematic wins")
    pins: header(['VSYS', 'G', '3V3', 'RST', 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46]),
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sim: { level: 'estimated', model: 'esp32s3' },
    price: [70, 110],
    keywords: '微雪 ESP32-S3-LCD-1.28 圆屏', // lint: allow-cjk
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'ws-lcd128', version: 'No touch', flashMB: 16, psramMB: 2, psram: 'quad',
      onboard: [
        { gpio: 10, what: 'On-board round display SCLK', kind: 'lcd', share: 'spi-sclk' },
        { gpio: 11, what: 'On-board round display MOSI', kind: 'lcd', share: 'spi-mosi' },
        { gpio: 9, what: 'On-board round display CS', kind: 'lcd' },
        { gpio: 8, what: 'On-board round display DC', kind: 'lcd' },
        { gpio: 12, what: 'On-board round display RST', kind: 'lcd' },
        { gpio: 40, what: 'On-board round display backlight', kind: 'lcd' },
        { gpio: 6, what: 'On-board IMU QMI8658 SDA', kind: 'imu', share: 'i2c-sda' },
        { gpio: 7, what: 'On-board IMU QMI8658 SCL', kind: 'imu', share: 'i2c-scl' },
        { gpio: 47, what: 'On-board IMU INT1', kind: 'imu' },
        { gpio: 48, what: 'On-board IMU INT2', kind: 'imu' },
        { gpio: 1, what: 'Battery voltage sense (200 k / 100 k divider)', kind: 'adc' },
        { gpio: 0, what: 'BOOT button', kind: 'boot' },
      ],
      builtin: [{ partId: 'gc9a01', what: 'on-board 1.28″ GC9A01 round display' }],
      lcd: { sclk: 10, mosi: 11, cs: 9, dc: 8, rst: 12, bl: 40 },
      rgbGpio: null, ldo: { model: 'ME6217C33M5G', maxMa: 800 }, usb: 'uart', charger: true,
      urls: [
        'https://www.waveshare.com/wiki/ESP32-S3-LCD-1.28',
        'https://nuttx.apache.org/docs/latest/platforms/xtensa/esp32s3/boards/esp32s3-ws-lcd128/index.html',
      ],
    },
    sources: ['Waveshare wiki ESP32-S3-LCD-1.28 (pin table, ME6217C33M5G 800 mA, ETA6096 charger, CH343P serial bridge, S3R2 + 16 MB flash)', 'NuttX esp32s3-ws-lcd128 board doc (H1 / H2 header to GPIO map)'],
    todo: [
      'pins: header entered from the NuttX GPIO table; whether GPIO19 / 20 / 43 / 44 are broken out needs the schematic',
      'board.onboard: the Waveshare wiki pin table also lists TP_INT GPIO5 (should not exist on the no-touch version); the schematic wins',
      'sizeMm',
      'currentMa',
    ],
    note: 'All in one: round display, IMU and Li-ion charging are on the board, so no separate GC9A01 needed. The display takes GPIO8–12 and GPIO40 (the touch version moves reset to GPIO14 and backlight to GPIO2, so firmware is not interchangeable). USB is a CH343P serial bridge.',
  }),
  P({
    id: 'ws-s3-touch-lcd128',
    name: 'Waveshare ESP32-S3-Touch-LCD-1.28 round-display board (touch)',
    kind: 'board',
    model: 'Waveshare ESP32-S3-Touch-LCD-1.28 (ESP32-S3R2; GC9A01 round display, CST816S touch, QMI8658 IMU)',
    chips: ['esp32s3'],
    // A single SH1.0 connector P2 breaks out GPIO15–18 / 21 / 33
    pins: header(['VSYS', 'G', 'RST', 0, 15, 16, 17, 18, 21, 33]),
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sim: { level: 'estimated', model: 'esp32s3' },
    price: [80, 120],
    keywords: '微雪 ESP32-S3-Touch-LCD-1.28 触摸圆屏', // lint: allow-cjk
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'ws-lcd128', version: 'Touch', flashMB: 16, psramMB: 2, psram: 'quad',
      onboard: [
        { gpio: 10, what: 'On-board round display SCLK', kind: 'lcd', share: 'spi-sclk' },
        { gpio: 11, what: 'On-board round display MOSI', kind: 'lcd', share: 'spi-mosi' },
        { gpio: 12, what: 'On-board round display MISO', kind: 'lcd', share: 'spi-miso' },
        { gpio: 9, what: 'On-board round display CS', kind: 'lcd' },
        { gpio: 8, what: 'On-board round display DC', kind: 'lcd' },
        { gpio: 14, what: 'On-board round display RST', kind: 'lcd' },
        { gpio: 2, what: 'On-board round display backlight', kind: 'lcd' },
        { gpio: 6, what: 'On-board touch CST816S / IMU SDA', kind: 'touch', share: 'i2c-sda' },
        { gpio: 7, what: 'On-board touch CST816S / IMU SCL', kind: 'touch', share: 'i2c-scl' },
        { gpio: 5, what: 'Touch interrupt TP_INT', kind: 'touch' },
        { gpio: 13, what: 'Touch reset TP_RST', kind: 'touch' },
        { gpio: 4, what: 'IMU INT1', kind: 'imu' },
        { gpio: 3, what: 'IMU INT2', kind: 'imu' },
        { gpio: 1, what: 'Battery voltage sense (200 k / 100 k divider)', kind: 'adc' },
        { gpio: 0, what: 'BOOT button', kind: 'boot' },
      ],
      builtin: [{ partId: 'gc9a01', what: 'on-board 1.28″ GC9A01 round display (with touch)' }],
      lcd: { sclk: 10, mosi: 11, cs: 9, dc: 8, rst: 14, bl: 2 },
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'uart', charger: true,
      urls: [
        'https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-1.28',
        'https://nuttx.apache.org/docs/latest/platforms/xtensa/esp32s3/boards/esp32s3-ws-lcd128/index.html',
      ],
    },
    sources: ['Waveshare wiki ESP32-S3-Touch-LCD-1.28 (pin table: display RST GPIO14, backlight GPIO2, TP_RST GPIO13, IMU INT 4 / 3)', 'NuttX esp32s3-ws-lcd128 board doc (touch version P2 connector GPIO15–18 / 21 / 33)'],
    todo: [
      'board.onboard: the Waveshare wiki table also labels GPIO4 / 5 as MOSFET1_CS / MOSFET2_CS, overlapping IMU INT1 / TP_INT; check the schematic',
      'board.ldo: regulator model not found in the touch-version wiki (no-touch version uses ME6217C33M5G 800 mA)',
      'sizeMm',
      'currentMa',
    ],
    note: 'Same shape as the no-touch version, but display reset is on GPIO14 and backlight on GPIO2 (GPIO12 / 40 on the no-touch one), so firmware pins depend on the version. Only 6 GPIOs on the SH1.0 connector are exposed.',
  }),

  P({ ...AMOLED216, currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE } }),
  // ───────── Sensors ─────────
  P({
    id: 'bme280',
    name: 'BME280 temperature / humidity / pressure module (3.3 V)',
    kind: 'sensor',
    model: 'Bosch BME280 (GY-BME280 style module)',
    pins: [VCC('VCC'), GND(), pin('SCL', 'i2c-scl', 'vcc', { dir: 'bi' }), pin('SDA', 'i2c-sda', 'vcc', { dir: 'bi' }), pin('CSB', 'spi-cs', 'vcc'), pin('SDO', 'addr', 'vcc', { note: 'GND = 0x76, VCC = 0x77' })],
    voltage: { supply: [1.71, 3.6], logic: 3.3 },
    currentMa: { typ: 0.0036, peak: 0.714, est: false, source: 'BME280 datasheet: 3.6 µA at 1 Hz T/H/P; 714 µA during pressure measurement' },
    i2cAddr: { default: 0x76, alt: [0x77], how: 'Tie SDO to VCC for 0x77' },
    i2cPullupK: null,
    sim: { level: 'verified', model: 'bme280' },
    price: [10, 25],
    keywords: 'BME280 模块 3.3V I2C 温湿度气压', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['Bosch BME280 datasheet (electrical characteristics, I2C address)'],
    todo: ['i2cPullupK: on-module pull-up value varies by batch', 'sizeMm: module outline varies by seller'],
    note: 'Don\'t buy a BMP280 by mistake (no humidity, chip ID 0x58 instead of 0x60). The 5 V module has a regulator; the 3.3 V one connects straight to the chip, so 3V3 only.',
  }),
  P({
    id: 'aht20',
    name: 'AHT20 temperature / humidity module',
    kind: 'sensor',
    model: 'Aosong AHT20',
    pins: [VCC(), GND(), pin('SCL', 'i2c-scl', 'vcc', { dir: 'bi' }), pin('SDA', 'i2c-sda', 'vcc', { dir: 'bi' })],
    voltage: { supply: [2.0, 5.5], logic: null },
    currentMa: { typ: null, peak: 0.98, est: true, source: 'Estimate: AHT20 datasheet measurement current around 980 µA (to be checked word for word)' },
    i2cAddr: { default: 0x38, alt: [] },
    i2cPullupK: null,
    price: [3, 8],
    keywords: 'AHT20 温湿度传感器模块 I2C', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['Aosong AHT20 datasheet'],
    todo: ['currentMa: measurement current to be checked against the original; typ (average) not listed', 'voltage.logic: pull-ups go to VCC, so the level follows the supply', 'i2cPullupK', 'sizeMm'],
    note: 'Address fixed at 0x38. The module pull-ups go to VCC: on 5 V, SDA / SCL are 5 V, so power it from 3V3. Often sold as an AHT20 + BMP280 combo board.',
  }),
  P({
    id: 'dht22',
    name: 'DHT22 temperature / humidity module (3-pin, with pull-up)',
    kind: 'sensor',
    model: 'Aosong AM2302 / DHT22',
    pins: [VCC('+'), pin('OUT', 'onewire', 'vcc', { dir: 'bi', boot: 'pull-up' }), GND('-')],
    voltage: { supply: [3.3, 6], logic: null },
    currentMa: { typ: 1, peak: 1.5, est: false, source: 'AM2302 datasheet: 1–1.5 mA measuring, 40–50 µA standby' },
    price: [12, 25],
    keywords: 'DHT22 AM2302 温湿度模块', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['Aosong AM2302 datasheet'],
    todo: ['voltage.logic: data line pulled up to VCC, so the level follows the supply', 'sizeMm'],
    note: 'Proprietary single-wire protocol; at least 2 s between reads. The data line is pulled up to module VCC, so on 5 V it is a 5 V signal.',
  }),
  P({
    id: 'dht11',
    name: 'DHT11 temperature / humidity module (3-pin, with pull-up)',
    kind: 'sensor',
    model: 'Aosong DHT11',
    pins: [VCC('VCC'), pin('DATA', 'onewire', 'vcc', { dir: 'bi', boot: 'pull-up', note: 'Open drain; 10 kΩ pull-up on the module' }), GND()],
    voltage: { supply: [3.3, 5.5], logic: null },
    currentMa: { typ: 1, peak: 2.5, est: false, source: 'DHT11 datasheet: 0.5–2.5 mA measuring, 100–150 µA standby' },
    sim: { level: 'verified', model: 'dht11' },
    price: [3, 8],
    keywords: 'DHT11 温湿度传感器模块 三针', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['Aosong DHT11 datasheet'],
    todo: ['voltage.logic: data line pulled up to VCC, so the level follows the supply', 'sizeMm: module outline varies by seller'],
    note: 'Proprietary single-wire protocol timed in microseconds; at least 1 s between reads. Integer humidity, 0–50 °C ±2 °C. Firmware that bit-bangs it with busy-wait loops must be checked on a real board.',
  }),
  P({
    id: 'ds18b20',
    name: 'DS18B20 waterproof temperature probe (1 m)',
    kind: 'sensor',
    model: 'Maxim/ADI DS18B20',
    pins: [pin('红 VDD', 'power', 'vcc'), GND('黑 GND'), pin('黄 DQ', 'onewire', null, { dir: 'bi', note: 'Open drain; level set by an external 4.7 kΩ pull-up' })], // lint: allow-cjk
    voltage: { supply: [3.0, 5.5], logic: null },
    currentMa: { typ: 1, peak: 1.5, est: false, source: 'DS18B20 datasheet: 1 mA typ / 1.5 mA max converting, 750 nA standby' },
    price: [3, 10],
    keywords: 'DS18B20 防水探头 不锈钢', // lint: allow-cjk
    supplyNet: '3V3',
    requires: [{ partId: 'resistor-kit', why: 'DQ needs a 4.7 kΩ pull-up to 3V3, or reads fail' }],
    sources: ['DS18B20 datasheet'],
    todo: ['voltage.logic: open drain, set by the external pull-up', 'sizeMm: probe length varies by seller'],
    note: 'Pull-up goes to 3V3 (not 5 V). Several probes can share one wire, told apart by their 64-bit ROM codes.',
  }),
  P({
    id: 'hc-sr04',
    name: 'HC-SR04 ultrasonic rangefinder (5 V)',
    kind: 'sensor',
    model: 'HC-SR04',
    pins: [pin('VCC', 'power', 5), pin('Trig', 'digital-in', null, { dir: 'in', note: '10 µs high pulse triggers; 3.3 V usually works (TTL threshold), not calibrated on hardware' }), pin('Echo', 'digital-out', 5, { dir: 'out', boot: 'drive-low' }), GND()],
    voltage: { supply: [5, 5], logic: 5 },
    currentMa: { typ: 15, peak: 15, est: false, source: 'HC-SR04 module spec: 15 mA operating current' },
    sizeMm: [45, 20, 15],
    sim: { level: 'verified', model: 'hcsr04' },
    price: [3, 8],
    keywords: 'HC-SR04 超声波测距模块', // lint: allow-cjk
    supplyNet: '5V',
    requires: [{ partId: 'resistor-kit', why: 'Echo is 5 V; divide it to about 3.3 V with 1 kΩ / 2 kΩ' }],
    sources: ['HC-SR04 module spec (Elecfreaks version)'],
    note: 'Echo outputs 5 V and ESP32 pins are not 5 V tolerant. To skip the divider, buy a 3.3 V version (HC-SR04P / RCWL-1601).',
  }),
  P({
    id: 'mpu6050',
    name: 'MPU6050 6-axis module (GY-521)',
    kind: 'sensor',
    model: 'TDK InvenSense MPU-6050',
    pins: [VCC(), GND(), pin('SCL', 'i2c-scl', 3.3, { dir: 'bi' }), pin('SDA', 'i2c-sda', 3.3, { dir: 'bi' }), pin('XDA', 'nc', null), pin('XCL', 'nc', null), pin('AD0', 'addr', null, { note: 'Low = 0x68, high = 0x69' }), pin('INT', 'digital-out', 3.3, { dir: 'out' })],
    voltage: { supply: [3, 5], logic: 3.3 },
    currentMa: { typ: 3.9, peak: 3.9, est: true, source: 'Estimate: MPU-6000/6050 datasheet gyro 3.6 mA + accelerometer 500 µA (DMP not counted)' },
    i2cAddr: { default: 0x68, alt: [0x69], how: 'Pull AD0 high for 0x69' },
    i2cPullupK: null,
    sim: { level: 'verified', model: 'mpu6050' },
    price: [6, 15],
    keywords: 'MPU6050 GY-521 模块', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['MPU-6000/MPU-6050 Product Specification'],
    todo: ['voltage.logic: pull-ups to the on-module 3.3 V regulator (usual on GY-521); check the schematic', 'i2cPullupK', 'sizeMm'],
    note: 'The chip is discontinued; most on sale are clones. 0x68 clashes with the DS3231. Simulator: registers, ranges, sample rate and DATA_RDY follow the datasheet, readings come from the bench pose; FIFO and DMP are not simulated yet.',
  }),
  P({
    id: 'qmi8658',
    name: 'QMI8658 6-axis module',
    kind: 'sensor',
    model: 'QST QMI8658C 6-axis IMU breakout',
    pins: [VCC('VIN'), GND(), pin('SCL', 'i2c-scl', 3.3, { dir: 'bi' }), pin('SDA', 'i2c-sda', 3.3, { dir: 'bi' }), pin('SA0', 'addr', null, { note: 'High = 0x6B, low = 0x6A' }), pin('INT', 'digital-out', 3.3, { dir: 'out' })],
    voltage: { supply: [1.71, 3.6], logic: 3.3 },
    currentMa: { typ: 1.7, peak: 1.7, est: true, source: 'Estimate: QMI8658C datasheet 6-axis high-performance mode around 1.7 mA (to be checked word for word)' },
    i2cAddr: { default: 0x6b, alt: [0x6a], how: 'Tie SA0 to GND for 0x6A' },
    i2cPullupK: null,
    sim: { level: 'verified', model: 'qmi8658' },
    price: [8, 20],
    keywords: 'QMI8658 六轴 模块', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['QST QMI8658C datasheet (register map, ranges, I2C address)'],
    todo: ['i2cPullupK', 'sizeMm: breakout outline varies by seller'],
    note: 'This is the IMU on the Waveshare ESP32-S3 round-display boards. Without address auto-increment in CTRL1, burst reads keep reading the same register, and the simulator does the same. Data is treated as little-endian (not calibrated on hardware).',
  }),
  P({
    id: 'ds3231',
    name: 'DS3231 RTC module (ZS-042)',
    kind: 'module',
    model: 'Maxim/ADI DS3231 + AT24C32',
    pins: [pin('32K', 'digital-out', 'vcc', { dir: 'out' }), pin('SQW', 'digital-out', 'vcc', { dir: 'out' }), pin('SCL', 'i2c-scl', 'vcc', { dir: 'bi' }), pin('SDA', 'i2c-sda', 'vcc', { dir: 'bi' }), VCC(), GND()],
    voltage: { supply: [2.3, 5.5], logic: null },
    currentMa: { typ: 0.2, peak: 0.575, est: false, source: 'DS3231 datasheet: 200 µA active, 575 µA during temperature conversion (3.63 V)' },
    i2cAddr: { default: 0x68, alt: [], how: 'Fixed; the on-board EEPROM AT24C32 also takes 0x57' },
    i2cPullupK: 4.7,
    price: [8, 15],
    keywords: 'DS3231 时钟模块 AT24C32', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['DS3231 datasheet'],
    todo: ['voltage.logic: pull-ups go to VCC, so the level follows the supply', 'sizeMm'],
    note: 'The ZS-042 board has a battery charging circuit; with a non-rechargeable CR2032 people usually remove that diode or resistor (not calibrated on hardware).',
  }),
  P({
    id: 'ina219',
    name: 'INA219 current / voltage monitor module',
    kind: 'sensor',
    model: 'TI INA219',
    pins: [VCC(), GND(), pin('SCL', 'i2c-scl', 'vcc', { dir: 'bi' }), pin('SDA', 'i2c-sda', 'vcc', { dir: 'bi' }), pin('Vin+', 'passive', null), pin('Vin-', 'passive', null)],
    voltage: { supply: [3, 5.5], logic: null },
    currentMa: { typ: 0.7, peak: 1, est: false, source: 'INA219 datasheet: quiescent current 0.7 mA typ / 1 mA max' },
    i2cAddr: { default: 0x40, alt: [0x41, 0x44, 0x45], how: 'Change the address with the A0 / A1 pads' },
    i2cPullupK: null,
    price: [5, 12],
    keywords: 'INA219 模块 I2C 电流', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['TI INA219 datasheet'],
    todo: ['voltage.logic: pull-ups follow VCC', 'i2cPullupK', 'sizeMm'],
    note: 'Default 0x40 clashes with PCA9685 and HTU21D. The shunt is usually 0.1 Ω, giving about ±3.2 A range.',
  }),
  P({
    id: 'inmp441',
    name: 'INMP441 digital microphone (I2S)',
    kind: 'audio',
    model: 'TDK InvenSense INMP441',
    pins: [pin('SCK', 'i2s-bclk', 3.3, { dir: 'in' }), pin('WS', 'i2s-ws', 3.3, { dir: 'in' }), pin('SD', 'i2s-data', 3.3, { dir: 'out' }), pin('L/R', 'addr', null, { note: 'GND = left channel' }), pin('VDD', 'power', 3.3), GND()],
    voltage: { supply: [1.62, 3.63], logic: 3.3 },
    currentMa: { typ: 1.4, peak: 1.4, est: false, source: 'INMP441 datasheet: 1.4 mA operating current' },
    price: [8, 15],
    keywords: 'INMP441 I2S 麦克风模块', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['INMP441 datasheet'],
    todo: ['sizeMm'],
    note: '3.3 V supply only. The simulator does not support I2S microphones yet.',
  }),

  // ───────── Inputs ─────────
  P({
    id: 'button',
    name: '6×6 mm tactile button',
    kind: 'input',
    model: '6×6×5 mm 4-pin tactile switch',
    pins: [pin('A', 'passive', null), pin('B', 'passive', null)],
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: false, source: 'Passive part' },
    sizeMm: [6, 6, 5],
    sim: { level: 'verified', model: 'button' },
    price: [0.1, 0.5],
    keywords: '轻触按键 6x6x5 直插', // lint: allow-cjk
    sources: [],
    na: ['voltage: passive switch, no supply / logic level'],
    note: 'One side to a GPIO (enable the internal pull-up), the other to GND. Don\'t put it on C3 GPIO9 / S3 GPIO0 and hold it at power-up.',
  }),
  P({
    id: 'pot',
    name: '10 kΩ rotary potentiometer',
    kind: 'input',
    model: 'B10K single-gang potentiometer',
    pins: [pin('1', 'power', 'vcc'), pin('2', 'analog', 'vcc', { dir: 'out', note: 'Wiper, voltage between 0 and VCC' }), GND('3')],
    voltage: { supply: [0, 5], logic: null },
    currentMa: { typ: 0.33, peak: 0.33, est: true, source: 'Estimate: 3.3 V / 10 kΩ' },
    sim: { level: 'verified', model: 'pot' },
    price: [0.5, 2],
    keywords: 'B10K 电位器 单联', // lint: allow-cjk
    supplyNet: '3V3',
    sources: [],
    todo: ['voltage.logic: wiper voltage follows the supply across the ends', 'sizeMm', 'voltage.supply: rating depends on the model (only used up to 5 V here)'],
    note: 'Ends to 3V3 and GND (not 5 V), wiper to an ADC pin.',
  }),
  P({
    id: 'encoder',
    name: 'EC11 rotary encoder module (KY-040 style)',
    kind: 'input',
    model: 'EC11 encoder with pull-up resistors',
    pins: [pin('CLK', 'digital-out', 'vcc', { dir: 'out', boot: 'pull-up' }), pin('DT', 'digital-out', 'vcc', { dir: 'out', boot: 'pull-up' }), pin('SW', 'digital-out', null, { dir: 'out' }), pin('+', 'power', 'vcc'), GND()],
    voltage: { supply: [3.3, 5], logic: null },
    currentMa: { typ: 0.66, peak: 0.66, est: true, source: 'Estimate: two 10 kΩ pull-ups at 3.3 V' },
    sim: { level: 'verified', model: 'encoder' },
    price: [2, 6],
    keywords: 'EC11 旋转编码器模块 带按键', // lint: allow-cjk
    supplyNet: '3V3',
    sources: [],
    todo: ['voltage.logic: pull-ups go to +, so the level follows the supply', 'sizeMm', 'voltage.supply: sellers usually say 3.3–5 V, no datasheet seen'],
    note: 'CLK and DT are pulled up to "+": with "+" on 5 V the signals are 5 V. Mechanical contacts need software debouncing or PCNT.',
  }),

  // ───────── Displays ─────────
  P({
    id: 'ssd1306',
    name: '0.96″ OLED（SSD1306，I2C，128×64）',
    kind: 'display',
    model: 'SSD1306 0.96″ 4-pin I2C module',
    pins: [GND(), VCC(), pin('SCL', 'i2c-scl', null, { dir: 'bi' }), pin('SDA', 'i2c-sda', null, { dir: 'bi' })],
    voltage: { supply: [3.3, 5], logic: 3.3 },
    currentMa: { typ: 10, peak: 20, est: true, source: 'Estimate: varies with lit pixels, about 20 mA fully lit' },
    i2cAddr: { default: 0x3c, alt: [0x3d], how: 'Move the resistor on the back for 0x3D' },
    i2cPullupK: null,
    sim: { level: 'verified', model: 'ssd1306' },
    price: [8, 15],
    keywords: '0.96寸 OLED SSD1306 I2C 4针', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['Solomon Systech SSD1306 datasheet (command set, address)'],
    todo: ['pins[SCL/SDA].v: whether on-board pull-ups go to VCC or the regulated 3.3 V varies by batch', 'i2cPullupK', 'sizeMm'],
    note: 'Some batches have VCC and GND swapped, so wire by the silkscreen, not by the picture.',
  }),
  P({
    id: 'sh1106',
    name: '1.3″ OLED（SH1106，I2C，128×64）',
    kind: 'display',
    model: 'SH1106 1.3″ 4-pin I2C module',
    pins: [VCC(), GND(), pin('SCL', 'i2c-scl', null, { dir: 'bi' }), pin('SDA', 'i2c-sda', null, { dir: 'bi' })],
    voltage: { supply: [3.3, 5], logic: 3.3 },
    currentMa: { typ: 12, peak: 25, est: true, source: 'Estimate: same range as SSD1306, larger screen' },
    i2cAddr: { default: 0x3c, alt: [0x3d] },
    i2cPullupK: null,
    price: [12, 22],
    keywords: '1.3寸 OLED SH1106 I2C', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['Sino Wealth SH1106 datasheet (132×64 frame memory)'],
    todo: ['pins[SCL/SDA].v', 'i2cPullupK', 'sizeMm'],
    note: 'Looks like an SSD1306 but the driver differs: 132-column memory and no horizontal addressing mode, so an SSD1306 driver shows garbage or a 2-column shift. The simulator has no model for this screen yet.',
  }),
  P({
    id: 'gc9a01',
    name: '1.28″ round display (GC9A01, SPI, 240×240)',
    kind: 'display',
    model: 'GC9A01 1.28″ IPS round LCD module (8-pin)',
    pins: [VCC(), GND(), pin('SCL', 'spi-sclk', 3.3, { dir: 'in' }), pin('SDA', 'spi-mosi', 3.3, { dir: 'in' }), pin('RES', 'rst', 3.3, { dir: 'in' }), pin('DC', 'spi-dc', 3.3, { dir: 'in' }), pin('CS', 'spi-cs', 3.3, { dir: 'in' }), pin('BLK', 'backlight', 3.3, { dir: 'in' })],
    voltage: { supply: [3.3, 3.3], logic: 3.3 },
    currentMa: { typ: 25, peak: 40, est: true, source: 'Estimate: mostly the backlight, varies by seller' },
    sim: { level: 'verified', model: 'gc9a01' },
    price: [12, 25],
    keywords: '1.28寸 圆形 IPS GC9A01 SPI', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['GalaxyCore GC9A01 datasheet (command set)'],
    todo: ['voltage.supply: some modules have a regulator and take 5 V, depends on the seller', 'currentMa', 'sizeMm'],
    note: 'The "SDA / SCL" silkscreen is really SPI MOSI / SCLK, not I2C. Write-only, no MISO.',
  }),
  P({
    id: 'gc9a01-touch',
    name: '1.28″ touch round display (GC9A01 + CST816S)',
    kind: 'display',
    model: '1.28″ round IPS LCD with CST816S capacitive touch (Waveshare 1.28inch Touch LCD style, 12-pin)',
    pins: [
      VCC(), GND(), pin('SCL', 'spi-sclk', 3.3, { dir: 'in' }), pin('SDA', 'spi-mosi', 3.3, { dir: 'in' }), pin('RES', 'rst', 3.3, { dir: 'in' }), pin('DC', 'spi-dc', 3.3, { dir: 'in' }), pin('CS', 'spi-cs', 3.3, { dir: 'in' }), pin('BLK', 'backlight', 3.3, { dir: 'in' }),
      pin('TP_SDA', 'i2c-sda', 3.3, { dir: 'bi' }), pin('TP_SCL', 'i2c-scl', 3.3, { dir: 'bi' }), pin('TP_INT', 'digital-out', 3.3, { dir: 'out', note: 'Low while touched' }), pin('TP_RST', 'rst', 3.3, { dir: 'in' }),
    ],
    voltage: { supply: [3.3, 3.3], logic: 3.3 },
    currentMa: { typ: 27.5, peak: 43, est: true, source: 'Estimate: backlight about 25 mA (as gc9a01) + CST816S scanning in the mA range' },
    i2cAddr: { default: 0x15, alt: [] },
    i2cPullupK: null,
    sim: { level: 'verified', model: 'gc9a01+cst816s' },
    price: [25, 45],
    keywords: '1.28寸 圆形 触摸屏 GC9A01 CST816S', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['GalaxyCore GC9A01 datasheet (command set)', 'Hynitron CST816S register notes (0x01 gesture, 0x02 finger count, 0x03–0x06 coordinates, 0xA7 chip ID 0xB5)'],
    todo: ['voltage.supply: some modules have a regulator and take 5 V, depends on the seller', 'i2cPullupK', 'sizeMm', 'pins: header order differs by maker, follow the seller silkscreen'],
    note: 'The touch chip sleeps a few seconds after the last touch and stops answering I2C, so the driver must pulse TP_RST first or wait for INT before reading. The simulator does not model auto-sleep; confirm this on real hardware.',
  }),
  P({
    id: 'st7789',
    name: '1.54″ color display (ST7789, SPI, 240×240)',
    kind: 'display',
    model: 'ST7789 1.54″ IPS LCD module',
    pins: [GND(), VCC(), pin('SCL', 'spi-sclk', 3.3, { dir: 'in' }), pin('SDA', 'spi-mosi', 3.3, { dir: 'in' }), pin('RES', 'rst', 3.3, { dir: 'in' }), pin('DC', 'spi-dc', 3.3, { dir: 'in' }), pin('CS', 'spi-cs', 3.3, { dir: 'in' }), pin('BLK', 'backlight', 3.3, { dir: 'in' })],
    voltage: { supply: [3.3, 3.3], logic: 3.3 },
    currentMa: { typ: 25, peak: 50, est: true, source: 'Estimate: mostly the backlight' },
    price: [12, 28],
    keywords: '1.54寸 IPS ST7789 SPI 240x240', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['Sitronix ST7789V datasheet'],
    todo: ['voltage.supply: some modules have a regulator', 'currentMa', 'sizeMm'],
    note: 'Some 1.3″ 7-pin versions have no CS pin and need SPI mode 3. The simulator has no ST7789 model yet.',
  }),

  // ───────── Actuators / lights / sound ─────────
  P({
    id: 'sg90',
    name: 'SG90 servo (180°, plastic gears)',
    kind: 'actuator',
    model: 'TowerPro SG90 and compatibles',
    pins: [GND('棕 GND'), pin('红 VCC', 'power', 'vcc'), pin('橙 PWM', 'pwm', null, { dir: 'in', note: 'A 3.3 V signal usually drives it (not calibrated on hardware)' })], // lint: allow-cjk
    voltage: { supply: [4.8, 6], logic: null },
    currentMa: { typ: 150, peak: 700, est: true, source: 'Estimate: the spec gives no current; around 100 mA moving, several hundred mA stalled (measurements vary a lot by maker)' },
    sizeMm: [22.2, 11.8, 31],
    sim: { level: 'verified', model: 'servo' },
    price: [4, 10],
    keywords: 'SG90 舵机 180度', // lint: allow-cjk
    supplyNet: 'EXT5V',
    sources: ['TowerPro SG90 spec (4.8 V, 50 Hz, about 0.5–2.4 ms, size 22.2×11.8×31 mm)'],
    todo: ['currentMa: enter measured stall current per model', 'voltage.logic: spec gives no input threshold; 3.3 V usually drives it (not calibrated on hardware)'],
    note: 'Needs a 4.8–6 V supply, not 3V3. The start-up current spike can reset the board when powered from a computer USB port.',
  }),
  P({
    id: 'mg90s',
    name: 'MG90S servo (metal gears)',
    kind: 'actuator',
    model: 'TowerPro MG90S and compatibles',
    pins: [GND('棕 GND'), pin('红 VCC', 'power', 'vcc'), pin('橙 PWM', 'pwm', null, { dir: 'in' })], // lint: allow-cjk
    voltage: { supply: [4.8, 6], logic: null },
    currentMa: { typ: 200, peak: 800, est: true, source: 'Estimate: more torque than SG90, higher stall current (datasheet gives none)' },
    sizeMm: [22.8, 12.2, 28.5],
    sim: { level: 'estimated', model: 'servo' },
    price: [8, 18],
    keywords: 'MG90S 金属齿舵机', // lint: allow-cjk
    supplyNet: 'EXT5V',
    sources: ['TowerPro MG90S spec (size, voltage)'],
    todo: ['currentMa: enter per model', 'voltage.logic: spec gives no input threshold'],
    note: 'Same size and connector as the SG90, with sturdier gears. The simulator uses the same servo model (torque is not modelled).',
  }),
  P({
    id: 'ws2812-strip',
    name: 'WS2812B LED strip 1 m (60 LEDs, 5 V)',
    kind: 'actuator',
    model: 'WS2812B-5050 LED strip',
    pins: [pin('5V', 'power', 'vcc'), pin('DIN', 'ws2812-din', null, { dir: 'in', note: 'VIH = 0.7 × VDD' }), GND()],
    voltage: { supply: [3.5, 5.3], logic: null },
    currentMa: { typ: null, peak: 3600, est: true, source: 'Estimate: about 60 mA per LED at full white × 60 (common rule of thumb; the datasheet gives per-channel values)' },
    sizeMm: [1000, 10, null],
    sim: { level: 'verified', model: 'ws2812' },
    price: [12, 30],
    keywords: 'WS2812B 灯带 60灯 5V 1米', // lint: allow-cjk
    supplyNet: 'EXT5V',
    requires: [{ partId: 'psu-5v2a', why: 'The strip cannot be powered from the dev board USB' }],
    sources: ['WS2812B datasheet (VDD 3.5–5.3 V, VIH 0.7 VDD)'],
    todo: ['currentMa.typ: depends on brightness and colour', 'sizeMm[2]: thickness varies by seller (thicker with a waterproof sleeve)'],
    na: ['voltage.logic: data threshold follows the supply (VIH = 0.7 × VDD), not a fixed value'],
    note: 'Full white draws 3.6 A; a 5 V 2 A supply only covers about half brightness, so limit brightness in firmware. Put a 1000 µF capacitor across the supply.',
  }),
  P({
    id: 'ws2812-stick8',
    name: 'WS2812 8-LED stick',
    kind: 'actuator',
    model: 'WS2812B-5050 × 8 LED board',
    pins: [pin('5V', 'power', 'vcc'), pin('DIN', 'ws2812-din', null, { dir: 'in' }), GND(), pin('DOUT', 'ws2812-dout', null, { dir: 'out' })],
    voltage: { supply: [3.5, 5.3], logic: null },
    currentMa: { typ: null, peak: 480, est: true, source: 'Estimate: 60 mA × 8' },
    sim: { level: 'verified', model: 'ws2812' },
    price: [3, 8],
    keywords: 'WS2812 8位 灯条 RGB', // lint: allow-cjk
    supplyNet: '5V',
    sources: ['WS2812B datasheet'],
    todo: ['currentMa.typ', 'sizeMm'],
    na: ['voltage.logic: data threshold follows the supply (VIH = 0.7 × VDD), not a fixed value'],
    note: 'A few LEDs can run from the board 5V, but 480 mA at full white is close to the USB limit.',
  }),
  P({
    id: 'buzzer-active',
    name: 'Active buzzer 12 mm (bare part)',
    kind: 'actuator',
    model: 'TMB12A05-style active magnetic buzzer',
    pins: [pin('+', 'io', null, { dir: 'in', loadMa: 30 }), GND('-')],
    voltage: { supply: [3.5, 5.5], logic: null },
    currentMa: { typ: 30, peak: 30, est: true, source: 'Estimate: common specs say "≤ 30 mA"' },
    sizeMm: [12, 12, 9.5],
    price: [0.5, 2],
    keywords: '有源蜂鸣器 12095 5V', // lint: allow-cjk
    supplyNet: '5V',
    sources: [],
    todo: ['voltage.supply: 3 V and 5 V variants, per model'],
    na: ['voltage.logic: two-terminal part, no logic interface'],
    note: 'Beeps as soon as it is powered, one tone only. It draws more than a GPIO should supply, so drive it with a transistor, or buy a 3-pin module with one built in.',
  }),
  P({
    id: 'buzzer-passive',
    name: 'Passive buzzer 12 mm (bare part, magnetic)',
    kind: 'actuator',
    model: '12085-style passive magnetic buzzer (coil about 16 Ω)',
    pins: [pin('+', 'pwm', null, { dir: 'in', loadMa: 100 }), GND('-')],
    voltage: { supply: [3, 5], logic: null },
    currentMa: { typ: null, peak: 100, est: true, source: 'Estimate: the coil is only a dozen-odd ohms, far beyond what a GPIO can drive directly' },
    sizeMm: [12, 12, 8.5],
    price: [0.5, 2],
    keywords: '无源蜂鸣器 12085 16欧', // lint: allow-cjk
    supplyNet: '5V',
    sources: [],
    todo: ['currentMa: check against coil resistance', 'voltage.supply'],
    na: ['voltage.logic: two-terminal part, no logic interface'],
    note: 'Needs a PWM square wave to sound (resonance around 2.7 kHz) and can play melodies. Must be driven by a transistor.',
  }),
  P({
    id: 'buzzer-module',
    name: 'Passive buzzer module (3-pin, with transistor)',
    kind: 'actuator',
    model: 'Passive buzzer with S8050 driver module',
    pins: [VCC(), pin('I/O', 'pwm', null, { dir: 'in', note: 'Transistor base on the module, through a resistor' }), GND()],
    voltage: { supply: [3.3, 5], logic: null },
    currentMa: { typ: 30, peak: 60, est: true, source: 'Estimate: depends on drive voltage and duty cycle' },
    price: [1, 4],
    keywords: '无源蜂鸣器模块 低电平触发 三线', // lint: allow-cjk
    supplyNet: '3V3',
    sources: [],
    todo: ['currentMa', 'sizeMm', 'voltage.logic: some modules sound on low', 'voltage.supply: sellers usually say 3.3–5 V, no datasheet seen'],
    note: 'The weather station alarm uses this. Wire I/O straight to a GPIO.',
  }),
  P({
    id: 'max98357a',
    name: 'MAX98357A I2S amplifier module',
    kind: 'audio',
    model: 'ADI/Maxim MAX98357A',
    pins: [pin('LRC', 'i2s-ws', 3.3, { dir: 'in' }), pin('BCLK', 'i2s-bclk', 3.3, { dir: 'in' }), pin('DIN', 'i2s-data', 3.3, { dir: 'in' }), pin('GAIN', 'addr', null), pin('SD', 'en', null), GND(), pin('Vin', 'power', 'vcc')],
    voltage: { supply: [2.5, 5.5], logic: 3.3 },
    currentMa: { typ: 2.4, peak: 800, est: true, source: 'Datasheet quiescent 2.4 mA; peak is an estimate (5 V, 4 Ω, about 3 W out)' },
    price: [8, 18],
    keywords: 'MAX98357A I2S amplifier module',
    supplyNet: '5V',
    sources: ['MAX98357A datasheet (2.5–5.5 V, 3.2 W @ 5 V 4 Ω)'],
    todo: ['sizeMm'],
    note: 'Loudest on 5 V. Peak current is high and, on top of Wi-Fi, can make USB sag. The simulator has no I2S model yet.',
  }),
  P({
    id: 'speaker-3w',
    name: '4 Ω 3 W small speaker (40 mm)',
    kind: 'audio',
    model: '40 mm 4 Ω 3 W speaker',
    pins: [pin('+', 'passive', null), pin('-', 'passive', null)],
    voltage: { supply: null, logic: null },
    currentMa: { typ: null, peak: null, est: true, source: 'Set by the amplifier' },
    sizeMm: [40, 40, null],
    price: [2, 6],
    keywords: '4欧3W 喇叭 40mm', // lint: allow-cjk
    sources: [],
    todo: ['currentMa: set by the amplifier, not listed separately', 'voltage.supply: passive part, rated 3 W', 'sizeMm[2]: thickness varies by model'],
    na: ['voltage: passive part, use within its 3 W rating'],
    note: 'Connect to the MAX98357A +/− outputs, not to ground.',
  }),

  // ───────── Power / cables ─────────
  P({
    id: 'psu-5v2a',
    name: '5 V 2 A power adapter (DC 5.5×2.1)',
    kind: 'power',
    model: '5 V 2 A switching supply, DC 5.5×2.1 mm centre positive',
    pins: [pin('+', 'power', 5), GND('-')],
    voltage: { supply: [100, 240], logic: null },
    currentMa: { typ: null, peak: null, est: true, source: 'Supplies power, does not consume it' },
    price: [8, 20],
    keywords: '5V2A 电源适配器 DC5.5x2.1', // lint: allow-cjk
    provides: { net: 'EXT5V', maxMa: 2000 },
    requires: [{ partId: 'dc-jack', why: 'The plug needs a DC jack to turn it into two wires for the breadboard' }],
    sources: [],
    todo: ['currentMa: power parts do not consume current', 'sizeMm', 'voltage.supply: AC 100–240 V is the usual rating; the label on the unit you buy wins'],
    na: ['voltage.logic: power part'],
    note: 'Powers servos or LED strips separately; tie its ground to the dev board GND. Buy a certified one.',
  }),
  P({
    id: 'dc-jack',
    name: 'DC 5.5×2.1 jack to screw terminal',
    kind: 'power',
    model: 'DC-005 jack to screw terminal',
    pins: [pin('+', 'power', 'vcc'), GND('-')],
    voltage: { supply: [0, 24], logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Passive connector' },
    price: [0.5, 3],
    keywords: 'DC5.5x2.1 母座 接线端子 免焊', // lint: allow-cjk
    sources: [],
    todo: ['voltage.supply: voltage / current rating per model', 'sizeMm'],
    na: ['voltage.logic: connector'],
    note: 'Run two Dupont wires from the screw terminal to the breadboard power rails.',
  }),
  P({
    id: 'ams1117',
    name: 'AMS1117-3.3 regulator module',
    kind: 'power',
    model: 'AMS1117-3.3 LDO module',
    pins: [pin('VIN', 'power', 'vcc'), GND(), pin('3.3V', 'power', 3.3)],
    voltage: { supply: [4.75, 12], logic: null },
    currentMa: { typ: 5, peak: 5, est: false, source: 'AMS1117 datasheet: quiescent current about 5 mA' },
    price: [0.5, 3],
    keywords: 'AMS1117-3.3 regulator module',
    provides: { net: 'EXT3V3', maxMa: 800 },
    sources: ['AMS1117 datasheet (dropout about 1.1–1.3 V, max input 15 V, 1 A class output)'],
    todo: ['provides.maxMa: conservative 800 mA, limited by heat dissipation', 'sizeMm', 'voltage.supply: 12 V upper limit is conservative (datasheet max input 15 V); lower limit = 3.3 V + dropout'],
    na: ['voltage.logic: power part'],
    note: 'Drops 5 V to 3.3 V with about 1.1 V dropout. More current means more heat: roughly 1.7 V times the current.',
  }),
  P({
    id: 'usb-c-cable',
    name: 'USB-C data cable (carries data)',
    kind: 'cable',
    model: 'USB-A / USB-C to Type-C, USB 2.0 data cable',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Cable' },
    price: [5, 15],
    keywords: 'Type-C 数据线 USB2.0 可传数据', // lint: allow-cjk
    sources: [],
    todo: ['sizeMm'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'Many charging cables have power wires only and no data lines, so the computer won\'t see the board.',
  }),
  P({
    id: 'lipo-1000',
    name: '3.7 V LiPo battery 1000 mAh (with protection board)',
    kind: 'power',
    model: '103040-style 1000 mAh LiPo battery',
    pins: [pin('红 +', 'power', 3.7), GND('黑 -')], // lint: allow-cjk
    voltage: { supply: [3.0, 4.2], logic: null },
    currentMa: { typ: null, peak: null, est: true, source: 'Supplies power' },
    price: [10, 20],
    keywords: '3.7V 锂电池 1000mAh 带保护板 PH2.0', // lint: allow-cjk
    supplyNet: 'BAT',
    rfBlocker: true,
    requires: [{ partId: 'tp4056', why: 'A Li-ion battery needs a charge controller (not if the board charges it)' }],
    sources: ['Generic LiPo cell spec (nominal 3.7 V, full 4.2 V, cut-off about 3.0 V depending on the protection board)'],
    todo: ['currentMa: depends on discharge rate', 'sizeMm: varies by model', 'voltage.supply: cut-off voltage depends on the protection board'],
    na: ['voltage.logic: power part'],
    note: 'Check the plug polarity (PH2.0 red / black may be swapped). Don\'t place it right over the antenna.',
  }),
  P({
    id: 'tp4056',
    name: 'TP4056 USB-C Li-ion charger module (with protection)',
    kind: 'power',
    model: 'TP4056 + DW01A + FS8205A',
    pins: [pin('IN+', 'power', 5), GND('IN-'), pin('B+', 'power', 'vcc'), GND('B-'), pin('OUT+', 'power', 'vcc'), GND('OUT-')],
    voltage: { supply: [4.5, 5.5], logic: null },
    currentMa: { typ: 1000, peak: 1000, est: false, source: 'TP4056 datasheet: charge current set by RPROG, module default 1.2 kΩ ≈ 1 A' },
    price: [1, 4],
    keywords: 'TP4056 Type-C 充电模块 带保护', // lint: allow-cjk
    sources: ['TP4056 datasheet'],
    todo: ['sizeMm', 'voltage.supply: 4.5–5.5 V assumed for USB 5 V input, to be checked against the datasheet input range'],
    na: ['voltage.logic: power part'],
    note: '1 A is a bit fast for a 1000 mAh battery; swap RPROG to drop to 0.5 A.',
  }),

  // ───────── Breadboards / wires / passives ─────────
  P({
    id: 'breadboard-830',
    name: 'Breadboard, 830 holes',
    kind: 'proto',
    model: 'MB-102 830-hole breadboard',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Passive' },
    sizeMm: [165, 55, null],
    sim: { level: 'verified', model: 'breadboard' },
    price: [5, 12],
    keywords: '830孔 面包板 MB-102', // lint: allow-cjk
    requires: [{ partId: 'dupont-mm', why: 'A breadboard needs male-to-male Dupont wires' }],
    sources: ['Sellers usually list 16.5×5.5 cm'],
    todo: ['sizeMm[2]: thickness'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'The DevKitC-1 is about 25 mm wide, so on an 830-hole breadboard only one row of holes stays free on one side; two boards side by side is the usual fix.',
  }),
  P({
    id: 'breadboard-400',
    name: 'Breadboard, 400 holes',
    kind: 'proto',
    model: '400-hole half-size breadboard',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Passive' },
    sizeMm: [83, 55, null],
    price: [3, 8],
    keywords: '400孔 面包板', // lint: allow-cjk
    requires: [{ partId: 'dupont-mm', why: 'A breadboard needs male-to-male Dupont wires' }],
    sources: ['Sellers usually list 8.3×5.5 cm'],
    todo: ['sizeMm[2]: thickness'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'For modules; a dev board is too wide to leave holes free on both sides.',
  }),
  P({
    id: 'dupont-mm',
    name: 'Dupont wires male-to-male 20 cm (40 pcs)',
    kind: 'cable',
    model: '2.54 mm Dupont wire M-M',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Cable' },
    price: [3, 8],
    keywords: '杜邦线 公对公 20cm 40P', // lint: allow-cjk
    sources: [],
    todo: ['sizeMm: cable only rated by length, 20 cm'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'Thin wires drop voltage under servo or LED strip current, so keep power wires short.',
  }),
  P({
    id: 'dupont-mf',
    name: 'Dupont wires male-to-female 20 cm (40 pcs)',
    kind: 'cable',
    model: '2.54 mm Dupont wire M-F',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Cable' },
    price: [3, 8],
    keywords: '杜邦线 公对母 20cm 40P', // lint: allow-cjk
    sources: [],
    todo: ['sizeMm: cable only rated by length, 20 cm'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'Module header pins (male) into breadboard holes.',
  }),
  P({
    id: 'dupont-ff',
    name: 'Dupont wires female-to-female 20 cm (40 pcs)',
    kind: 'cable',
    model: '2.54 mm Dupont wire F-F',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Cable' },
    price: [3, 8],
    keywords: '杜邦线 母对母 20cm 40P', // lint: allow-cjk
    sources: [],
    todo: ['sizeMm: cable only rated by length, 20 cm'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'Dev board header straight to module header without a breadboard (for fitting into an enclosure).',
  }),
  P({
    id: 'resistor-kit',
    name: 'Resistor kit (incl. 220 Ω, 1 k, 2 k, 4.7 k, 10 k)',
    kind: 'passive',
    model: '1/4 W metal film resistors, 30-value kit',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Passive' },
    price: [5, 12],
    keywords: '电阻包 1/4W 金属膜 套装 30种', // lint: allow-cjk
    sources: [],
    todo: ['sizeMm'],
    na: ['pins: kit, each resistor has two ends', 'voltage: not applicable (1/4 W rating)'],
    note: 'LED current limiting (220 Ω), 5 V signal dividers (1 k / 2 k) and 1-Wire pull-ups (4.7 k) all come from here.',
  }),
  P({
    id: 'led-kit',
    name: '5 mm LED kit (red, yellow, green, blue, white)',
    kind: 'passive',
    model: '5 mm through-hole LED',
    pins: [pin('长脚 +', 'io', null, { dir: 'in', loadMa: 6 }), GND('短脚 -')], // lint: allow-cjk
    voltage: { supply: [1.8, 3.4], logic: null },
    currentMa: { typ: 6, peak: 20, est: true, source: 'Estimate: about 6 mA from 3.3 V through 220 Ω with a red Vf≈2 V; rated 20 mA' },
    sizeMm: [5, 5, 8.6],
    sim: { level: 'verified', model: 'led' },
    price: [2, 6],
    keywords: '5mm LED 发光二极管 套装', // lint: allow-cjk
    requires: [{ partId: 'resistor-kit', why: 'An LED needs a series current-limiting resistor' }],
    sources: [],
    todo: ['voltage.supply: Vf depends on colour'],
    na: ['voltage.logic: two-terminal part'],
    note: 'The long leg is positive. Always add a series resistor (220 Ω or more), or you burn the LED or damage the pin.',
  }),
  P({
    id: 'level-ahct125',
    name: '74AHCT125 level shifter (DIP-14)',
    kind: 'passive',
    model: '74AHCT125 quad buffer (TTL input thresholds)',
    pins: [pin('VCC', 'power', 5), GND(), pin('1A', 'digital-in', null, { dir: 'in' }), pin('1Y', 'digital-out', 5, { dir: 'out' }), pin('1OE', 'en', null)],
    voltage: { supply: [4.5, 5.5], logic: 5 },
    currentMa: { typ: 0.04, peak: 0.04, est: false, source: '74AHCT125 datasheet: ICC max 40 µA (static)' },
    price: [1, 4],
    keywords: '74AHCT125 DIP14',
    sources: ['TI SN74AHCT125 datasheet (VIH 2.0 V at 5 V supply)'],
    todo: ['sizeMm'],
    note: 'Lifts 3.3 V data to 5 V for WS2812 strips, one direction only. Tie OE to GND to enable.',
  }),
  P({
    id: 'level-bss138',
    name: '4-channel bidirectional level shifter module (BSS138)',
    kind: 'passive',
    model: 'BSS138 MOSFET bidirectional level shifter',
    pins: [pin('LV', 'power', 3.3), pin('HV', 'power', 5), GND(), pin('LV1', 'io', 3.3, { dir: 'bi' }), pin('HV1', 'io', 5, { dir: 'bi' })],
    voltage: { supply: [1.8, 5], logic: 3.3 },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Passive (pull-up current only)' },
    price: [1, 4],
    keywords: '4路 电平转换模块 BSS138 双向', // lint: allow-cjk
    sources: [],
    todo: ['sizeMm', 'voltage.supply: LV side 1.8 V minimum per seller, to be checked against the module schematic'],
    note: 'Good for I2C and slow signals; too slow for WS2812.',
  }),
  P({
    id: 'npn-s8050',
    name: 'S8050 NPN transistor (TO-92, with 1 kΩ base resistor)',
    kind: 'passive',
    model: 'S8050',
    pins: [pin('E', 'gnd', 0), pin('B', 'digital-in', null, { dir: 'in', loadMa: 2.6 }), pin('C', 'passive', null)],
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Switching part' },
    price: [0.05, 0.3],
    keywords: 'S8050 三极管 TO-92', // lint: allow-cjk
    sources: [],
    todo: ['Ic: rating varies by maker (500 mA–1.5 A), check the specific datasheet', 'sizeMm'],
    na: ['voltage: discrete transistor, see Vceo / Ic ratings (see todo Ic)'],
    note: 'Low-side switch: GPIO through 1 kΩ to B, E to GND, load between C and 5 V. Add a flyback diode for inductive loads (relays, motors).',
  }),
  P({
    id: 'cap-1000uf',
    name: '1000 µF 10 V electrolytic capacitor',
    kind: 'passive',
    model: '1000 µF / 10 V aluminium electrolytic',
    pins: [pin('+', 'passive', null), pin('-', 'gnd', 0)],
    voltage: { supply: [0, 10], logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Passive' },
    price: [0.3, 1.5],
    keywords: '1000uF 10V 电解电容', // lint: allow-cjk
    sources: ['Rated 10 V (the part number is the spec)'],
    todo: ['sizeMm'],
    na: ['voltage.logic: passive part'],
    note: 'Put it across the LED strip or servo supply to absorb start-up spikes.',
  }),
  P({
    id: 'header-pins',
    name: '2.54 mm pin header (40P, single row)',
    kind: 'proto',
    model: '2.54 mm single-row straight header',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Passive' },
    price: [0.5, 2],
    keywords: '2.54mm 单排排针 40P', // lint: allow-cjk
    sources: [],
    todo: ['sizeMm'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'Many modules ship with headers unsoldered and you solder them yourself; check the seller photos.',
  }),

  // ───────── Enclosures (per project) ─────────
  P({
    id: 'enclosure-weather',
    name: 'Weather station enclosure (3D-printed PLA)',
    kind: 'enclosure',
    model: 'TryBoard weather station enclosure (parametric, front panel and back shell)',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Mechanical part' },
    sizeMm: [70, 50, 32],
    sim: { level: 'estimated', model: 'assembly:weather' },
    price: [15, 40],
    keywords: '3D打印 PLA 定制', // lint: allow-cjk
    sources: ['web/src/views/templates.ts (enclosure 70×50×32 mm, estimated)'],
    todo: ['price: print services quote by volume'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'Download the STL and upload it to a print service for a quote (external link). Where you mount it changes the BME280 readings.',
  }),
  P({
    id: 'enclosure-spin',
    name: 'Spinner body and turntable base (3D-printed)',
    kind: 'enclosure',
    model: 'TryBoard spinner enclosure (base Ø60, height 110 mm)',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Mechanical part' },
    sizeMm: [60, 60, 110],
    sim: { level: 'estimated', model: 'assembly:spin' },
    price: [20, 50],
    keywords: '3D打印 PLA 定制', // lint: allow-cjk
    sources: ['web/src/views/templates.ts (base Ø60 mm, height 110 mm, estimated)'],
    todo: ['price: print services quote by volume'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'The servo bay sits in the base, and the round display cable runs through the hole in the shaft.',
  }),
  P({
    id: 'enclosure-lens',
    name: 'Lens buddy base and screen frame (3D-printed)',
    kind: 'enclosure',
    model: 'TryBoard lens buddy enclosure (base Ø50 mm, frame with two slot heights)',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Mechanical part' },
    sizeMm: [50, 50, 62],
    sim: { level: 'estimated', model: 'assembly:lens' },
    price: [12, 35],
    keywords: '3D打印 PLA 定制', // lint: allow-cjk
    sources: ['web/src/views/templates.ts (base Ø50 mm, total height 62 mm, estimated)'],
    todo: ['price: print services quote by volume'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'With the frame on the high slot, 8 mm above the screen, the lens magnifies about 1.35× (estimate).',
  }),
  P({
    id: 'enclosure-lamp',
    name: 'Knob lamp base and shade (3D-printed)',
    kind: 'enclosure',
    model: 'TryBoard knob lamp enclosure (base 80×60×36 mm, milky shade Ø70 mm)',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Mechanical part' },
    sizeMm: [80, 60, 110],
    sim: { level: 'estimated', model: 'assembly:lamp' },
    price: [18, 45],
    keywords: '3D打印 PLA 定制 乳白 灯罩', // lint: allow-cjk
    sources: ['web/src/views/templates.ts (base 80×60×36 mm, shade Ø70 mm, estimated)'],
    todo: ['price: print services quote by volume'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'Print the shade in milky PLA to diffuse the LEDs. Stick the strip on the light pipe, a little away from the shade wall, to avoid hot spots.',
  }),
  P({
    id: 'enclosure-ruler',
    name: 'Ultrasonic ruler enclosure (3D-printed)',
    kind: 'enclosure',
    model: 'TryBoard ultrasonic ruler enclosure (handheld 90×48×30 mm, two transducer holes at the front)',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Mechanical part' },
    sizeMm: [90, 48, 30],
    sim: { level: 'estimated', model: 'assembly:ruler' },
    price: [12, 35],
    keywords: '3D打印 PLA 定制', // lint: allow-cjk
    sources: ['web/src/views/templates.ts (enclosure 90×48×30 mm, transducer holes Ø17 mm, estimated)'],
    todo: ['price: print services quote by volume'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'Both transducers must poke out through the front panel holes. If they sit behind the holes, the sound hits the hole walls first and readings drop to a few centimetres.',
  }),
  P({
    id: 'enclosure-tilt',
    name: 'Tilt buddy disc enclosure (3D-printed)',
    kind: 'enclosure',
    model: 'TryBoard tilt buddy enclosure (disc Ø56 × 26 mm, round display on top)',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Mechanical part' },
    sizeMm: [56, 56, 26],
    sim: { level: 'estimated', model: 'assembly:tilt' },
    price: [12, 32],
    keywords: '3D打印 PLA 定制', // lint: allow-cjk
    sources: ['web/src/views/templates.ts (disc Ø56 × 26 mm, estimated)'],
    todo: ['price: print services quote by volume'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'Mount the 6-axis module flat on the base plate with the arrow facing forward; mounted backwards, the buddy climbs uphill.',
  }),
  P({
    id: 'enclosure-usbkey',
    name: 'USB keypad case and keycaps (3D-printed)',
    kind: 'enclosure',
    model: 'TryBoard USB keypad case (bottom shell, plate and 4 keycaps)',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Mechanical part' },
    sizeMm: [80, 40, 22],
    sim: { level: 'estimated', model: 'assembly:usbkey' },
    price: [12, 35],
    keywords: '3D打印 PLA 定制 键帽', // lint: allow-cjk
    sources: ['web/src/app/enclosure.ts (bottom shell 80×40 mm, estimated)'],
    todo: ['price: print services quote by volume'],
    na: ['pins: cable / mechanical part, no electrical pins', 'voltage: not applicable'],
    note: 'Line the dev board native USB port up with the opening at the back. Don\'t cover the WROOM antenna with a metal plate, or Wi-Fi gets worse (estimate).',
  }),
  P({
    id: 'lens-dome',
    name: 'Ø40 mm acrylic convex lens',
    kind: 'enclosure',
    model: 'Ø40 mm plano-convex / biconvex acrylic lens',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: 'Optical part' },
    sizeMm: [40, 40, null],
    sim: { level: 'estimated', model: 'assembly:lens' },
    price: [3, 12],
    keywords: '40mm 亚克力凸透镜 放大镜片', // lint: allow-cjk
    sources: [],
    todo: ['sizeMm[2]: thickness and focal length vary by seller (focal length sets magnification)'],
    na: ['pins: optical part', 'voltage: not applicable'],
    note: 'Match the focal length to the frame height: at 8 mm above the screen it magnifies about 1.35× (estimate).',
  }),
];

export const PART_BY_ID: Record<string, Part> = Object.fromEntries(PARTS.map((p) => [p.id, p]));

export function getPart(id: string): Part {
  const p = PART_BY_ID[id];
  if (!p) throw new Error(`Part library has no ${id}`);
  return p;
}

export const BOARDS = PARTS.filter((p) => p.kind === 'board');
