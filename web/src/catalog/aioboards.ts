// All-in-one boards with their own 3D model and on-board devices (E-03); split out of parts.ts (R-14 size limit).
import { AIO_CHIP } from '../chipid.ts';
import type { Draft } from './parts.ts';
import { pin } from './partdraft.ts';

/** currentMa is added in parts.ts (shared board note) */
export const AMOLED216: Omit<Draft, 'currentMa'> = {
  id: 'ws-s3-touch-amoled-216',
  name: 'Waveshare ESP32-S3-Touch-AMOLED-2.16 square AMOLED board (touch)',
  kind: 'board',
  model: 'Waveshare ESP32-S3-Touch-AMOLED-2.16 (ESP32-S3; CO5300 480×480 QSPI AMOLED, CST9220 touch, AXP2101 PMIC, PCF85063 RTC, ES8311 / ES7210 audio)',
  chips: [AIO_CHIP['ws-amoled216']],
  pins: null,
  voltage: { supply: [5, 5], logic: 3.3 },
  // Screen, touch, PMU (battery / USB / PWR key) and RTC run real firmware in acceptance; the audio codecs only answer chip-ID reads
  sim: { level: 'estimated', model: 'ws-amoled216' },
  price: [150, 230],
  keywords: '微雪 ESP32-S3-Touch-AMOLED-2.16 AMOLED 触摸', // lint: allow-cjk
  supplyNet: '5V',
  board: {
    chip: AIO_CHIP['ws-amoled216'], family: 'ws-amoled216', flashMB: null, psramMB: null, psram: null,
    onboard: [
      { gpio: 12, what: 'On-board AMOLED QSPI CS', kind: 'lcd' },
      { gpio: 38, what: 'On-board AMOLED QSPI CLK', kind: 'lcd' },
      { gpio: 4, what: 'On-board AMOLED QSPI D0', kind: 'lcd' },
      { gpio: 5, what: 'On-board AMOLED QSPI D1', kind: 'lcd' },
      { gpio: 6, what: 'On-board AMOLED QSPI D2', kind: 'lcd' },
      { gpio: 7, what: 'On-board AMOLED QSPI D3', kind: 'lcd' },
      { gpio: 39, what: 'On-board AMOLED reset', kind: 'lcd' },
      { gpio: 15, what: 'On-board I2C SDA (touch, PMU, RTC, audio codecs)', kind: 'touch', share: 'i2c-sda' },
      { gpio: 14, what: 'On-board I2C SCL (touch, PMU, RTC, audio codecs)', kind: 'touch', share: 'i2c-scl' },
      { gpio: 11, what: 'Touch interrupt TP_INT', kind: 'touch' },
      { gpio: 40, what: 'Touch reset TP_RST', kind: 'touch' },
      { gpio: 0, what: 'BOOT button', kind: 'boot' },
    ],
    rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'native', charger: true,
    urls: ['https://www.waveshare.com/wiki/ESP32-S3-Touch-AMOLED-2.16'],
  },
  sources: ['TryBoard acceptance firmware s3-co5300 / s3-amoled-i2c (pins as used there: QSPI CS 12, CLK 38, D0–D3 4–7, RST 39; I2C SDA 15, SCL 14, TP_INT 11, TP_RST 40)'],
  todo: [
    'pins: expansion header pin-out not entered; check the Waveshare wiki / schematic',
    'board.flashMB: flash size unverified',
    'board.psramMB: PSRAM size unverified',
    'board.psram: PSRAM type (quad / octal) unverified',
    'board.usb: whether the USB-C port is native USB only is unverified',
    'board.ldo: regulator model not checked (the AXP2101 provides the rails)',
    'sizeMm: the 3D model uses an estimated 44 × 50 mm outline; 2.16″ square panel active area ≈ 38.8 mm',
    'board.onboard: on-board IMU (QMI8658) and TF card pins not entered; the bench does not attach an IMU for this board',
    'currentMa',
  ],
  note: 'All in one: 2.16″ 480×480 AMOLED (CO5300, QSPI), capacitive touch, AXP2101 battery management with a PWR key, RTC and an audio codec pair. In the simulator the screen, touch, battery / USB / PWR key and RTC are modelled; the ES8311 / ES7210 audio codecs only answer ID reads (no sound).',
};

/** M5Stack Dial finished knob (G-16a); pins are only the free Grove ports */
export const M5DIAL: Omit<Draft, 'currentMa'> = {
  id: 'm5-dial',
  name: 'M5Stack Dial',
  kind: 'board',
  model: 'M5Stack Dial (M5StampS3: ESP32-S3FN8, 8 MB in-package flash, no PSRAM; 1.28″ 240×240 GC9A01 round display with FT3267 touch, rotary ring, BM8563 RTC, buzzer)',
  chips: [AIO_CHIP.m5dial],
  // Only the two Grove ports are broken out: Port A G13 / G15, Port B G1 / G2
  pins: [pin('5V', 'power', 5), pin('GND', 'gnd', 0), pin('Port A 黄(G13)', 'io', 3.3, { gpio: 13, dir: 'bi' }), pin('Port A 白(G15)', 'io', 3.3, { gpio: 15, dir: 'bi' }), pin('Port B 黄(G1)', 'io', 3.3, { gpio: 1, dir: 'bi' }), pin('Port B 白(G2)', 'io', 3.3, { gpio: 2, dir: 'bi' })], // lint: allow-cjk
  voltage: { supply: [5, 5], logic: 3.3 },
  sim: { level: 'verified', model: 'm5dial' },
  price: [180, 260],
  keywords: 'M5Stack Dial M5Dial 旋钮 圆屏 ESP32-S3', // lint: allow-cjk
  supplyNet: '5V',
  board: {
    chip: AIO_CHIP.m5dial, family: 'm5-dial', flashMB: 8, psramMB: 0, psram: 'none',
    onboard: [
      { gpio: 6, what: 'On-board round display SCLK', kind: 'lcd', share: 'spi-sclk' },
      { gpio: 5, what: 'On-board round display MOSI', kind: 'lcd', share: 'spi-mosi' },
      { gpio: 7, what: 'On-board round display CS', kind: 'lcd' },
      { gpio: 4, what: 'On-board round display DC', kind: 'lcd' },
      { gpio: 8, what: 'On-board round display RST', kind: 'lcd' },
      { gpio: 9, what: 'On-board round display backlight', kind: 'lcd' },
      { gpio: 11, what: 'Internal I2C SDA (FT3267 touch 0x38, BM8563 RTC 0x51)', kind: 'touch', share: 'i2c-sda' },
      { gpio: 12, what: 'Internal I2C SCL', kind: 'touch', share: 'i2c-scl' },
      { gpio: 14, what: 'Touch interrupt', kind: 'touch' },
      { gpio: 40, what: 'Rotary ring encoder A', kind: 'other' },
      { gpio: 41, what: 'Rotary ring encoder B', kind: 'other' },
      { gpio: 42, what: 'Press-down button (BtnA, low when pressed)', kind: 'button' },
      { gpio: 3, what: 'Buzzer (driven as 1-bit audio by M5Unified)', kind: 'other' },
      { gpio: 46, what: 'Power hold', kind: 'other' },
    ],
    builtin: [{ partId: 'gc9a01', what: 'on-board 1.28″ GC9A01 round display (with touch)' }],
    lcd: { sclk: 6, mosi: 5, cs: 7, dc: 4, rst: 8, bl: 9 },
    rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'native', charger: false,
    urls: ['https://docs.m5stack.com/en/core/M5Dial', 'https://github.com/m5stack/M5Unified'],
  },
  sources: ['M5Stack Dial docs (GC9A01 / FT3267 / BM8563 / encoder / buzzer pins, Port A G13 / G15, Port B G1 / G2)', 'M5Unified (MIT): board detection and Speaker on G3, BtnA on G42, power hold G46', 'Simulator board preset m5dial (core/crates/machine/src/boards.rs)'],
  todo: ['board.ldo', 'currentMa', 'sizeMm: M5 site lists about 45×45×32 mm, not verified', 'board.charger: battery connector and charging per the schematic not checked', 'board.onboard: WS1850S RFID (0x28) on the same I2C bus not listed (not modelled)'],
  note: 'A finished knob: the round touch screen, rotary ring, press button, RTC and buzzer are inside the case, so most projects need no wiring. Only the two Grove ports are free for extra modules.',
};
