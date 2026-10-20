// All-in-one boards with their own 3D model and on-board devices (E-03); split out of parts.ts (R-14 size limit).
import { AIO_CHIP } from '../chipid.ts';
import type { Draft } from './parts.ts';

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
