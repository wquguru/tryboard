// Advisor data from Espressif datasheets / TRMs and board makers' public docs; prices are common 2026 shop ranges.
// Every entry needs a manual check before release (docs/ADVISOR.md). Display strings are English keys rendered via t().

export type Cap =
  | 'wifi'
  | 'wifi6'
  | 'ble'
  | 'bt_classic'
  | 'thread'
  | 'zigbee'
  | 'usb_otg'
  | 'usb_serial'
  | 'camera'
  | 'audio_in'
  | 'audio_out'
  | 'display_spi'
  | 'display_rgb'
  | 'psram'
  | 'ai_accel'
  | 'touch'
  | 'dac'
  | 'ethernet'
  | 'low_power'
  | 'many_gpio';

export interface Chip {
  id: string;
  name: string;
  core: string;
  mhz: number;
  sramKB: number;
  caps: Cap[];
  gpio: number;
  /** Pins to avoid: flash / PSRAM, USB, strapping */
  pins: { flash: number[]; strapping: number[]; usb: number[]; uart0: [number, number]; adc1: number[]; inputOnly?: number[]; psramOctal?: number[] };
  /** Typical current (mA), datasheet typical values at 3.3 V, room temperature */
  power: { txPeak: number; rx: number; modemSleep: number; lightSleepUA: number; deepSleepUA: number };
  notes: string[];
  simulated: 'full' | 'partial' | 'none';
}

export const CHIPS: Chip[] = [
  {
    id: 'esp32c3',
    name: 'ESP32-C3',
    core: 'Single-core RISC-V',
    mhz: 160,
    sramKB: 400,
    caps: ['wifi', 'ble', 'usb_serial', 'display_spi', 'low_power'],
    gpio: 22,
    pins: { flash: [12, 13, 14, 15, 16, 17], strapping: [2, 8, 9], usb: [18, 19], uart0: [21, 20], adc1: [0, 1, 2, 3, 4] },
    power: { txPeak: 335, rx: 82, modemSleep: 20, lightSleepUA: 130, deepSleepUA: 5 },
    notes: ['The USB port works only as a serial port or JTAG debugger; it cannot pose as a keyboard or flash drive', 'C3 ADC2 (GPIO5) has a hardware erratum and ESP-IDF no longer supports it, nothing to do with Wi-Fi. Use ADC1 (GPIO0–4) for analog', 'No Classic Bluetooth, so no Bluetooth speaker'],
    simulated: 'full',
  },
  {
    id: 'esp32s3',
    name: 'ESP32-S3',
    core: 'Dual-core Xtensa LX7',
    mhz: 240,
    sramKB: 512,
    caps: ['wifi', 'ble', 'usb_otg', 'usb_serial', 'camera', 'audio_in', 'audio_out', 'display_spi', 'display_rgb', 'psram', 'ai_accel', 'touch', 'many_gpio', 'low_power'],
    gpio: 45,
    pins: {
      flash: [26, 27, 28, 29, 30, 31, 32],
      strapping: [0, 3, 45, 46],
      usb: [19, 20],
      uart0: [43, 44],
      adc1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      psramOctal: [33, 34, 35, 36, 37],
    },
    power: { txPeak: 340, rx: 95, modemSleep: 30, lightSleepUA: 240, deepSleepUA: 8 },
    notes: ['On modules with 8 MB octal PSRAM such as N16R8, GPIO33–37 are taken by the PSRAM', 'ADC2 (GPIO11–20) is shared with Wi-Fi, so reads may time out with Wi-Fi on; put analog inputs on ADC1 (GPIO1–10) first', 'Has native USB OTG: can pose as a keyboard, network adapter or flash drive, and can also host a flash drive', 'Vector instructions speed up inference for offline wake words and small models'],
    simulated: 'partial',
  },
  {
    id: 'esp32c6',
    name: 'ESP32-C6',
    core: 'Single-core RISC-V plus an LP core',
    mhz: 160,
    sramKB: 512,
    caps: ['wifi', 'wifi6', 'ble', 'thread', 'zigbee', 'usb_serial', 'display_spi', 'low_power'],
    gpio: 31,
    pins: { flash: [24, 25, 26, 27, 28, 29, 30], strapping: [8, 9, 15], usb: [12, 13], uart0: [16, 17], adc1: [0, 1, 2, 3, 4, 5, 6] },
    power: { txPeak: 354, rx: 78, modemSleep: 25, lightSleepUA: 180, deepSleepUA: 7 },
    notes: ['Has both Wi-Fi 6 and Thread / Zigbee: the first pick for Matter smart home devices', 'Like the C3, the USB port works only as a serial port or JTAG debugger'],
    simulated: 'none',
  },
  {
    id: 'esp32',
    name: 'ESP32 (classic)',
    core: 'Dual-core Xtensa LX6',
    mhz: 240,
    sramKB: 520,
    caps: ['wifi', 'ble', 'bt_classic', 'dac', 'touch', 'ethernet', 'display_spi', 'audio_in', 'audio_out', 'many_gpio', 'camera', 'psram'],
    gpio: 34,
    pins: {
      flash: [6, 7, 8, 9, 10, 11],
      strapping: [0, 2, 5, 12, 15],
      usb: [],
      uart0: [1, 3],
      adc1: [32, 33, 34, 35, 36, 39],
      inputOnly: [34, 35, 36, 39],
    },
    power: { txPeak: 240, rx: 100, modemSleep: 30, lightSleepUA: 800, deepSleepUA: 10 },
    notes: ['The only model with Classic Bluetooth (A2DP speakers, SPP serial)', 'No native USB; the board relies on a CH340 / CP2102 USB-serial chip', 'The most tutorials, but new projects usually prefer S3 / C3 / C6'],
    // C-05: GPIO, LEDC, I2C and Wi-Fi (join AP, WPA2, HTTP) run; RMT, SPI, ADC, I2S, Bluetooth etc. have no model
    simulated: 'partial',
  },
  {
    id: 'esp32p4',
    name: 'ESP32-P4',
    core: 'Dual-core RISC-V',
    mhz: 400,
    sramKB: 768,
    caps: ['usb_otg', 'camera', 'display_rgb', 'audio_in', 'audio_out', 'psram', 'ai_accel', 'ethernet', 'many_gpio'],
    gpio: 55,
    pins: { flash: [], strapping: [34, 35, 36, 37, 38], usb: [24, 25], uart0: [37, 38], adc1: [16, 17, 18, 19, 20, 21, 22, 23] },
    power: { txPeak: 0, rx: 0, modemSleep: 80, lightSleepUA: 0, deepSleepUA: 0 },
    notes: ['No Wi-Fi or Bluetooth; dev boards usually add a C6 for wireless', 'MIPI camera and display ports plus H.264 encoding suit multimedia devices with a screen'],
    simulated: 'none',
  },
];

export interface Board {
  id: string;
  name: string;
  chip: string;
  maker: string;
  priceCNY: [number, number];
  flashMB: number;
  psramMB: number;
  size: string;
  extras: string[];
  /** Pins taken on the board: reason */
  usedPins: Record<number, string>;
  /** Small boards break out only some pins (in silkscreen D0, D1… order); absent means nearly all are broken out */
  exposed?: number[];
  /** Default I2C pins on the silkscreen [SDA, SCL] (tutorials and expansion boards follow them) */
  i2cPins?: [number, number];
  /** Silkscreen names, e.g. { 6: 'D4' } */
  labels?: Record<number, string>;
  /** Whole-board deep-sleep current (µA): LDO quiescent current, power LED and USB-UART chip dwarf the chip itself */
  boardSleepUA: number;
  battery: boolean;
  caveats: string[];
  simExample?: string;
}

export const BOARDS: Board[] = [
  {
    id: 'c3-devkitm',
    name: 'ESP32-C3-DevKitM-1',
    chip: 'esp32c3',
    maker: 'Espressif',
    priceCNY: [40, 60],
    flashMB: 4,
    psramMB: 0,
    size: '25 × 49mm',
    extras: ['WS2812 RGB LED (GPIO8)', 'BOOT / RST buttons', 'USB-UART chip'],
    usedPins: { 8: 'On-board RGB LED', 9: 'BOOT button' },
    boardSleepUA: 1000,
    battery: false,
    caveats: ['The power LED and USB-serial chip stay on, so the board still draws about 1 mA in deep sleep: not for battery use'],
    simExample: 'rgb',
  },
  {
    id: 'c3-supermini',
    name: 'ESP32-C3 SuperMini',
    chip: 'esp32c3',
    maker: 'Various third parties',
    priceCNY: [10, 18],
    flashMB: 4,
    psramMB: 0,
    size: '18 × 23mm',
    extras: ['On-board blue LED (GPIO8, active low)', 'Type-C wired to the chip USB'],
    exposed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21],
    usedPins: { 8: 'On-board LED (active low)', 9: 'BOOT button' },
    boardSleepUA: 300,
    battery: false,
    caveats: ['Small ceramic antenna, weaker than a PCB antenna; leave margin through walls', 'Build quality varies; some batches need lower Wi-Fi TX power to be stable'],
  },
  {
    id: 'xiao-c3',
    name: 'Seeed XIAO ESP32C3',
    chip: 'esp32c3',
    maker: 'Seeed Studio',
    priceCNY: [35, 50],
    flashMB: 4,
    psramMB: 0,
    size: '21 × 17.8mm',
    extras: ['Li-ion charging', 'External antenna connector'],
    i2cPins: [6, 7],
    exposed: [2, 3, 4, 5, 6, 7, 21, 20, 8, 9, 10],
    labels: { 2: 'D0', 3: 'D1', 4: 'D2', 5: 'D3', 6: 'D4', 7: 'D5', 21: 'D6', 20: 'D7', 8: 'D8', 9: 'D9', 10: 'D10' },
    usedPins: {},
    boardSleepUA: 45,
    battery: true,
    caveats: ['Only 11 GPIOs broken out'],
  },
  {
    id: 's3-devkitc-n16r8',
    name: 'ESP32-S3-DevKitC-1 (N16R8)',
    chip: 'esp32s3',
    maker: 'Espressif / compatibles',
    priceCNY: [35, 70],
    flashMB: 16,
    psramMB: 8,
    size: '26 × 63mm',
    extras: ['WS2812 RGB LED (GPIO48, GPIO38 on many compatibles)', 'Two Type-C ports: one to the USB-UART, one to native USB'],
    usedPins: { 0: 'BOOT button', 48: 'On-board RGB LED (GPIO48 on v1.0, GPIO38 on v1.1)' },
    boardSleepUA: 1000,
    battery: false,
    caveats: ['GPIO33–37 are taken by the octal PSRAM: on the header but unusable', 'When buying, check the board has a native USB port labeled "USB" or "OTG": phones and keyboard emulation need it'],
  },
  {
    id: 'xiao-s3-sense',
    name: 'Seeed XIAO ESP32S3 Sense',
    chip: 'esp32s3',
    maker: 'Seeed Studio',
    priceCNY: [100, 140],
    flashMB: 8,
    psramMB: 8,
    size: '21 × 17.8 × 15mm',
    extras: ['OV2640 / OV3660 camera (removable)', 'PDM digital microphone', 'microSD slot', 'Li-ion charging'],
    i2cPins: [5, 6],
    exposed: [1, 2, 3, 4, 5, 6, 43, 44, 7, 8, 9],
    labels: { 1: 'D0', 2: 'D1', 3: 'D2', 4: 'D3', 5: 'D4', 6: 'D5', 43: 'D6', 44: 'D7', 7: 'D8', 8: 'D9', 9: 'D10' },
    usedPins: { 42: 'Microphone PDM clock', 41: 'Microphone PDM data', 21: 'SD card chip select' },
    boardSleepUA: 60,
    battery: true,
    caveats: ['The camera gets noticeably hot over long runs and needs cooling', 'The expansion board takes most pins, leaving few GPIOs'],
  },
  {
    id: 'c6-devkitc',
    name: 'ESP32-C6-DevKitC-1',
    chip: 'esp32c6',
    maker: 'Espressif',
    priceCNY: [45, 70],
    flashMB: 8,
    psramMB: 0,
    size: '26 × 51mm',
    extras: ['WS2812 RGB LED (GPIO8)'],
    usedPins: { 8: 'On-board RGB LED', 9: 'BOOT button' },
    boardSleepUA: 1000,
    battery: false,
    caveats: ['The dev board power circuit is not low power; measure consumption on a module or a XIAO-style board'],
  },
  {
    id: 'xiao-c6',
    name: 'Seeed XIAO ESP32C6',
    chip: 'esp32c6',
    maker: 'Seeed Studio',
    priceCNY: [40, 55],
    flashMB: 4,
    psramMB: 0,
    size: '21 × 17.8mm',
    extras: ['Li-ion charging', 'Switchable on-board / external antenna'],
    i2cPins: [22, 23],
    exposed: [0, 1, 2, 21, 22, 23, 16, 17, 19, 20, 18],
    labels: { 0: 'D0', 1: 'D1', 2: 'D2', 21: 'D3', 22: 'D4', 23: 'D5', 16: 'D6', 17: 'D7', 19: 'D8', 20: 'D9', 18: 'D10' },
    usedPins: {},
    boardSleepUA: 15,
    battery: true,
    caveats: [],
  },
  {
    id: 'esp32-devkitc',
    name: 'ESP32-DevKitC (WROOM-32)',
    chip: 'esp32',
    maker: 'Espressif / compatibles',
    priceCNY: [20, 45],
    flashMB: 4,
    psramMB: 0,
    size: '28 × 55mm',
    extras: ['USB-UART (CP2102 / CH340)'],
    usedPins: { 0: 'BOOT button' },
    boardSleepUA: 6000,
    battery: false,
    caveats: ['Many old boards have micro-USB; buy the Type-C version', 'Whole-board deep-sleep current can reach several mA'],
  },
];

export interface Part {
  id: string;
  name: string;
  /** Short name on cards / buttons (project card subtitle on the advisor page) */
  short: string;
  priceCNY: [number, number];
  /** Interfaces needed: pin requirements */
  needs: { kind: 'gpio' | 'adc' | 'pwm' | 'i2c' | 'spi' | 'i2s' | 'rmt' | 'uart' | 'usb' | 'camera'; count?: number; label: string; /** Taken first when free and not strapping: the pin TryBoard's demo firmware uses (DHT11: c3-dht11 GPIO5) */ prefer?: number[] }[];
  caps?: Cap[];
  /** Extra current while active (mA) */
  activeMA?: number;
  simulated: 'full' | 'partial' | 'none';
}

export const PARTS: Record<string, Part> = {
  led: { id: 'led', short: 'LED', name: '5 mm LED and 220 Ω resistor', priceCNY: [0.1, 0.5], needs: [{ kind: 'pwm', label: 'LED' }], simulated: 'full' },
  button: { id: 'button', short: 'Button', name: 'Tactile button', priceCNY: [0.1, 0.5], needs: [{ kind: 'gpio', label: 'Button' }], simulated: 'full' },
  pot: { id: 'pot', short: 'Potentiometer', name: '10 kΩ potentiometer', priceCNY: [0.5, 2], needs: [{ kind: 'adc', label: 'Potentiometer' }], simulated: 'full' },
  servo: { id: 'servo', short: 'Servo', name: 'SG90 servo', priceCNY: [4, 10], needs: [{ kind: 'pwm', label: 'Servo signal' }], activeMA: 150, simulated: 'partial' },
  ws2812: { id: 'ws2812', short: 'WS2812B', name: 'WS2812B strip (60 LEDs per meter)', priceCNY: [12, 30], needs: [{ kind: 'rmt', label: 'Strip data' }], activeMA: 1200, simulated: 'full' },
  oled: { id: 'oled', short: 'OLED', name: '0.96" OLED (SSD1306, I2C)', priceCNY: [8, 15], needs: [{ kind: 'i2c', label: 'OLED' }], activeMA: 15, simulated: 'partial' },
  bme280: { id: 'bme280', short: 'BME280', name: 'BME280 temperature / humidity / pressure module', priceCNY: [10, 25], needs: [{ kind: 'i2c', label: 'BME280' }], activeMA: 1, simulated: 'partial' },
  tft: { id: 'tft', short: 'Color display', name: '1.69–2.4" SPI color display (ST7789 / ILI9341)', priceCNY: [15, 40], needs: [{ kind: 'spi', label: 'Display' }, { kind: 'gpio', count: 3, label: 'Display DC / RST / backlight' }], activeMA: 40, caps: ['display_spi'], simulated: 'none' },
  mic: { id: 'mic', short: 'Microphone', name: 'INMP441 digital microphone (I2S)', priceCNY: [8, 15], needs: [{ kind: 'i2s', label: 'Microphone' }], caps: ['audio_in'], simulated: 'none' },
  amp: { id: 'amp', short: 'Amplifier', name: 'MAX98357A amplifier and 3 W speaker', priceCNY: [10, 20], needs: [{ kind: 'i2s', label: 'Amplifier' }], activeMA: 300, caps: ['audio_out'], simulated: 'none' },
  buzzer: { id: 'buzzer', short: 'Buzzer', name: 'Passive buzzer module (3-pin, with transistor)', priceCNY: [1, 4], needs: [{ kind: 'pwm', label: 'Buzzer' }], activeMA: 30, simulated: 'partial' },
  relay: { id: 'relay', short: 'Relay', name: '5 V relay module (optocoupler isolated)', priceCNY: [3, 8], needs: [{ kind: 'gpio', label: 'Relay' }], activeMA: 70, simulated: 'full' },
  dht11: { id: 'dht11', short: 'DHT11', name: 'DHT11 temperature / humidity module (single-wire, 3-pin)', priceCNY: [3, 8], needs: [{ kind: 'gpio', label: 'DHT11 data', prefer: [5] }], activeMA: 1, simulated: 'partial' },
  pir: { id: 'pir', short: 'PIR sensor', name: 'HC-SR501 PIR sensor', priceCNY: [3, 8], needs: [{ kind: 'gpio', label: 'Motion sensing' }], simulated: 'full' },
  battery: { id: 'battery', short: 'Li-ion battery', name: '3.7 V Li-ion battery 1000 mAh', priceCNY: [10, 20], needs: [], simulated: 'none' },
  aht20: { id: 'aht20', short: 'AHT20', name: 'AHT20 temperature / humidity module (I2C)', priceCNY: [3, 8], needs: [{ kind: 'i2c', label: 'AHT20' }], activeMA: 1, simulated: 'partial' },
  rc522: { id: 'rc522', short: 'RC522', name: 'RC522 RFID reader (13.56 MHz, SPI) and cards', priceCNY: [6, 15], needs: [{ kind: 'spi', label: 'RFID reader' }, { kind: 'gpio', count: 2, label: 'RFID SDA / RST' }], activeMA: 25, simulated: 'partial' },
  irrx: { id: 'irrx', short: 'IR RX module', name: 'IR receiver (38 kHz, VS1838B or similar)', priceCNY: [1, 4], needs: [{ kind: 'rmt', label: 'IR receiver signal' }], activeMA: 1, simulated: 'full' },
  irled: { id: 'irled', short: 'IR TX LED', name: 'IR LED (940 nm) and remote control', priceCNY: [2, 8], needs: [{ kind: 'rmt', label: 'IR transmit LED signal' }], activeMA: 20, simulated: 'full' },
  camera: { id: 'camera', short: 'OV2640', name: 'OV2640 camera', priceCNY: [15, 30], needs: [{ kind: 'camera', label: 'Camera DVP' }], caps: ['camera', 'psram'], activeMA: 120, simulated: 'none' },
};

export interface Template {
  id: string;
  title: string;
  /** Short name on the mobile bottom button */
  short: string;
  emoji: string;
  blurb: string;
  needCaps: Cap[];
  niceCaps?: Cap[];
  parts: string[];
  /** Advisor v3 suggestions, unticked by default (dashed): common add-ons, ticking puts them in the list */
  suggest?: string[];
  /** Duty cycle for the power estimate: wakes per hour, active seconds per wake, networking */
  duty?: { wakePerHour: number; activeSec: number; wifi: boolean };
  /** Example firmware runnable in TryBoard (examples.json ids, C3 and S3 both listed; the UI picks by chip) */
  examples: string[];
  /** Matching full project (app/works.ts id): the result links straight to its shop page */
  work?: string;
  risks: string[];
}

export const TEMPLATES: Template[] = [
  {
    id: 'blink',
    short: 'Blink basics',
    title: 'First steps: LED, button, serial',
    emoji: '💡',
    blurb: 'Where microcontrollers start. Almost any board works; pick a cheap one with lots of tutorials.',
    needCaps: [],
    parts: ['led', 'button', 'pot'],
    suggest: ['buzzer'],
    examples: ['blink', 'button', 'fade', 'pot', 's3-blink', 's3-pot', 'esp32-blink', 'arduino-blink'],
    risks: [],
  },
  {
    id: 'weather',
    short: 'Thermo-hygrometer',
    title: 'Battery-powered thermo-hygrometer',
    emoji: '🌡️',
    blurb: 'Wakes every 10 minutes to measure and report, deep sleeps the rest. Whole-board sleep current is what matters.',
    needCaps: ['wifi', 'low_power'],
    parts: ['bme280', 'oled', 'battery'],
    suggest: ['buzzer', 'button'],
    duty: { wakePerHour: 6, activeSec: 3, wifi: true },
    examples: ['bme280', 'oled', 'weather', 's3-oled', 'c3-ili9341-temp', 'c3-sh1106-pir', 'c3-ds18b20', 'c3-dht11'],
    work: 'weather',
    risks: ['A dev board\'s power LED, LDO and USB-serial chip eat most of the battery. Pick a small board designed for batteries, or design your own', 'Wi-Fi connect time drives consumption: a static IP and a remembered channel cut each wake from 3 s to under 1 s'],
  },
  {
    id: 'lights',
    short: 'Mood light',
    title: 'Mood light / LED strip controller',
    emoji: '🌈',
    blurb: 'A WS2812 strip controlled from a phone web page; firmware like WLED works out of the box.',
    needCaps: ['wifi'],
    parts: ['ws2812', 'button'],
    suggest: ['pot'],
    examples: ['rgb', 's3-rgb', 'lamp', 'esp32-ir', 'arduino-lib-irremote'],
    work: 'lamp',
    risks: ['60 LEDs / m at full white draw about 3.6 A / m: give it its own supply, not the dev board\'s USB', 'A 3.3 V data line driving a 5 V strip is sometimes flaky; add a level shifter if needed'],
  },
  {
    id: 'smarthome',
    short: 'Smart home',
    title: 'Matter / Home Assistant smart home',
    emoji: '🏠',
    blurb: 'Join ecosystems such as Apple Home / Google / HA. Thread or Zigbee means C6 / H2 only.',
    needCaps: ['wifi'],
    niceCaps: ['thread', 'zigbee', 'wifi6'],
    parts: ['relay', 'pir', 'button'],
    suggest: ['oled'],
    examples: ['button', 'wifi-http', 's3-wifi-http', 'c3-pir-relay', 'c3-rc522', 'arduino-lib-pubsubclient'],
    risks: ['Switching mains with a relay needs an optocoupler-isolated module; wire it unpowered. The simulator cannot verify the mains side'],
  },
  {
    id: 'rfid',
    short: 'RFID door lock',
    title: 'RFID access control',
    emoji: '🪪',
    blurb: 'Swipe a card, the relay opens the lock, the screen shows who and the buzzer beeps. Any chip works; the RC522 needs one SPI bus.',
    needCaps: [],
    parts: ['rc522', 'relay', 'oled', 'buzzer'],
    suggest: ['button', 'tft'],
    examples: ['c3-rc522', 'c3-pir-relay'],
    risks: ['The relay switches a lock or mains: it must go on real hardware, with isolation (optocoupler module, enclosed, wired unpowered). The simulator cannot verify the load side', 'RC522 reads cards at only a few centimeters, and cheap clone cards or metal nearby make it flaky; test your own cards'],
  },
  {
    id: 'irremote',
    short: 'Infrared remote',
    title: 'IR remote control (receive and send)',
    emoji: '📡',
    blurb: 'Learn a TV or air conditioner remote, or turn the board into one. A 38 kHz receiver in, an IR LED out; the RMT peripheral handles the timing.',
    needCaps: [],
    parts: ['irrx', 'irled'],
    suggest: ['button', 'oled'],
    examples: ['arduino-lib-irremote-rx', 'arduino-lib-irremote', 'esp32-ir', 'arduino-ir-nec-rmt'],
    risks: ['A bare IR LED on a GPIO reaches only a couple of meters; add a transistor driver for room-wide range', 'Air conditioner remotes send long frames of their own protocol; check the protocol is supported before buying'],
  },
  {
    id: 'mqtt',
    short: 'Sensor to MQTT',
    title: 'Sensor data to the cloud over MQTT',
    emoji: '☁️',
    blurb: 'Read a BME280 (or AHT20) and publish to an MQTT broker, for Home Assistant, Grafana and the like.',
    needCaps: ['wifi'],
    parts: ['bme280'],
    suggest: ['aht20', 'oled', 'battery'],
    duty: { wakePerHour: 12, activeSec: 4, wifi: true },
    examples: ['arduino-lib-pubsubclient', 'bme280', 'wifi-http'],
    risks: ['MQTT and the virtual network run as behaviour only. Real Wi-Fi stability, broker authentication and TLS need real hardware', 'Self-heating from the board skews a temperature sensor placed next to it; keep it away or read it right after waking'],
  },
  {
    id: 'blephone',
    short: 'Phone link (BLE)',
    title: 'Connect a phone to the board (BLE)',
    emoji: '📱',
    blurb: 'Send readings to a phone app or take commands from it, with no router. C3, S3 and the classic ESP32 all do BLE.',
    needCaps: ['ble'],
    parts: ['button', 'led'],
    suggest: ['bme280', 'battery'],
    examples: ['c3-ble-hr'],
    risks: ['A virtual phone checks the protocol flow, not the real radio: range, pairing quirks and iOS / Android differences need real hardware', 'BLE and Wi-Fi share the radio; running both at once can drop packets'],
  },
  {
    id: 'usbkey',
    short: 'USB macro keypad',
    title: 'USB macro keypad / phone gadget',
    emoji: '⌨️',
    blurb: 'Make the board pose as a keyboard, mouse or network adapter. Only models with native USB OTG can.',
    needCaps: ['usb_otg'],
    parts: ['button'],
    suggest: ['led'],
    examples: ['usbkey', 's3-usb-keyboard'],
    work: 'usbkey',
    risks: ['Make sure you plug into the chip\'s native USB port, not the USB-serial one', 'iPhones and similar devices supply little USB power; complex peripherals need external power'],
  },
  {
    id: 'voice',
    short: 'Voice assistant',
    title: 'AI voice assistant (Xiaozhi-style)',
    emoji: '🗣️',
    blurb: 'Microphone in, a cloud LLM, speaker out, with a round display for a face. Mainstream designs use S3 + 8 MB PSRAM.',
    needCaps: ['wifi', 'audio_in', 'audio_out', 'psram'],
    niceCaps: ['display_spi', 'ai_accel'],
    parts: ['mic', 'amp', 'tft', 'battery'],
    suggest: ['button'],
    examples: ['s3-xiaozhi-lite', 's3-i2s-mic', 's3-i2s-tone'],
    risks: ['The LLM API needs a network and an account; only the offline wake word runs on the board', 'Amplifier and Wi-Fi together draw big peaks; the battery must deliver over 1 A'],
  },
  {
    id: 'camera',
    short: 'Camera',
    title: 'Camera monitor / pet cam',
    emoji: '📷',
    blurb: 'OV2640 stills or streaming, with PSRAM for frames. XIAO S3 Sense works out of the box.',
    needCaps: ['wifi', 'camera', 'psram'],
    parts: ['camera'],
    suggest: ['button'],
    examples: [],
    risks: ['Continuous streaming runs hot and power hungry: not for long battery use', 'Image quality tops out at 2 MP; do not expect a security camera'],
  },
  {
    id: 'btaudio',
    short: 'Bluetooth speaker',
    title: 'Bluetooth speaker / Classic Bluetooth serial',
    emoji: '🔊',
    blurb: 'A2DP audio needs Classic Bluetooth, which only the classic ESP32 has.',
    needCaps: ['bt_classic', 'audio_out'],
    parts: ['amp'],
    suggest: ['button'],
    examples: [],
    risks: [],
  },
];
