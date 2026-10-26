// Lesson 8 (PLAN H-16): read a BME280 over I2C; checkpoint weather 04, reference build s3-bme280.
// Lines point at firmware/bme280/main/main.c (s3-bme280 builds it with SDA 8 / SCL 9); the OLED stays in the sim, so the scan also finds 0x3C.
import { t } from '../../i18n/index.ts';
import type { Lesson, LessonCallout } from '../lessons.ts';

const SDA = 'wire:GPIO8~bme280:SDA';
const SCL = 'wire:GPIO9~bme280:SCL';
const VIN = 'wire:3V3~bme280:VIN';
const GND = 'wire:GND~bme280:GND';
const DS = t('BME280 datasheet');

const C: Record<string, LessonCallout> = {
  bme: { key: 'bme', target: { kind: 'part', id: 'bme280' }, title: t('BME280 sensor'), body: t('One tiny chip measures temperature, humidity and air pressure') },
  sda: { key: 'sda', target: { kind: 'wire', id: SDA }, title: t('SDA = GPIO8'), body: t('Data wire: carries the bytes, one bit at a time') },
  scl: { key: 'scl', target: { kind: 'wire', id: SCL }, title: t('SCL = GPIO9'), body: t('Clock wire: one tick per bit') },
  vin: { key: 'vin', target: { kind: 'wire', id: VIN, anchor: '0' }, title: t('3V3 power'), body: t('The sensor runs on 3.3 V and draws well under 1 mA') },
  gnd: { key: 'gnd', target: { kind: 'wire', id: GND, anchor: '0' }, title: t('GND (ground)'), body: t('Shared ground: the bits on SDA and SCL are measured against it') },
  pin8: { key: 'pin8', target: { kind: 'pin', id: 'GPIO8' }, title: t('GPIO8: the shared data line'), body: t('Every I2C part on the bus hangs on this same pin') },
  pin9: { key: 'pin9', target: { kind: 'pin', id: 'GPIO9' }, title: t('GPIO9: the shared clock line'), body: t('The board drives the clock; the parts only listen to it') },
};

export const L8: Lesson = {
  work: 'weather',
  checkpoint: '04',
  no: 8,
  title: t('Read temperature and humidity'),
  summary: t('Read temperature, humidity and air pressure from a BME280 over I2C.'),
  minutes: 12,
  buy: t('BME280 module (I2C)'),
  parts: ['bme280'],
  fw: 's3-bme280',
  src: 'firmware/bme280/main/main.c',
  wireNotes: {
    [SDA]: { to: t('Sensor SDA'), why: t('Data wire: carries the bytes, one bit at a time') },
    [SCL]: { to: t('Sensor SCL'), why: t('Clock wire: one tick per bit') },
    [VIN]: { to: t('Sensor VIN'), why: t("Powers the sensor from the board's 3.3 V") },
    [GND]: { to: t('Sensor GND'), why: t('Shared ground for the sensor') },
  },
  code: [
    { line: 16, text: t('0x76: the address this sensor answers to (0x77 if its SDO pin is tied high)') },
    { line: 23, text: t('rd(): send the register number, then read the answer, in one I2C transaction') },
    { line: 36, text: t('SDA pin: this lesson builds with GPIO8 (the default 6 is for the C3 board)') },
    { line: 37, text: t('SCL pin: this lesson builds with GPIO9') },
    { line: 40, text: t("I2C lines need pull-ups: the chip's internal ones are switched on; most modules add their own too") },
    { line: 45, text: t('Bus scan: knock on every address and print the ones that answer') },
    { line: 48, text: t('Talk to 0x76 only, at 100 kHz: 100 000 clock ticks per second on SCL') },
    { line: 52, text: t('Read the chip ID register: a real BME280 answers 0x60') },
    { line: 56, text: t('Read the factory calibration: every chip has its own correction numbers') },
    { line: 62, text: t('Turn humidity measuring on (it is off after power-up)') },
    { line: 64, text: t('Normal mode: the sensor now measures by itself, again and again') },
    { line: 68, text: t('Wait one second between readings') },
    { line: 70, text: t('Read the 8 result bytes: pressure, temperature, humidity, all raw') },
    { line: 74, text: t('Raw count → °C × 100 with the datasheet formula (2350 = 23.50 °C)') },
    { line: 76, text: t('Raw count → humidity in % × 1024') },
    { line: 77, text: t('Print one line: T= °C, H= %, P= hPa') },
  ],
  params: [
    { label: t('I2C address'), value: t('0x76 (SDO to GND) · 0x77 (SDO to 3.3 V)'), source: 'datasheet', doc: DS },
    { label: t('Address on this bench'), value: '0x76', source: 'bench' },
    { label: t('I2C pins'), value: 'SDA GPIO8 · SCL GPIO9', source: 'bench' },
    { label: t('I2C clock'), value: '100 kHz', source: 'code' },
    { label: t('Readings'), value: t('One line per second'), source: 'code' },
    { label: t('Temperature accuracy'), value: t('±1 °C (0–65 °C)'), source: 'datasheet', doc: DS },
    { label: t('Humidity accuracy'), value: t('±3 %RH (20–80 %RH)'), source: 'datasheet', doc: DS },
    { label: t('Pressure accuracy'), value: t('±1 hPa'), source: 'datasheet', doc: DS },
    { label: t('Measuring range'), value: t('−40–85 °C · 0–100 %RH · 300–1100 hPa'), source: 'datasheet', doc: DS },
    { label: t('Chip ID'), value: '0x60', source: 'datasheet', doc: DS },
    { label: t('Sensor supply'), value: '3.3 V', source: 'bench' },
    { label: t('Self-heating'), value: t('A sensor right next to the chip can read 1–3 °C high'), source: 'estimate' },
  ],
  buyTip: t('When buying: look for "BME280" printed on the listing and a chip ID of 0x60. Many cheap modules are really a BMP280 (chip ID 0x58), which has no humidity at all. Pick a 3.3 V module, or one with a regulator if you power it from 5 V, and check which address its SDO pad selects.'),
  i2c: [{ addr: 0x76, text: t('Sensor read: {n} bytes on the bus'), line: 23, reads: true }],
  steps: [
    {
      id: 'bme280',
      title: t('Meet the BME280'),
      sub: t('Three readings from one chip'),
      body: t('The BME280 is a sensor about the size of a grain of rice on a small board. It measures three things: temperature in °C, relative humidity in % (how much water the air holds) and air pressure in hPa. It talks I2C, like the OLED in lesson 3: SDA on GPIO8, SCL on GPIO9, plus 3.3 V and GND.'),
      tasks: [
        { text: t('Click the sensor to see its specs'), done: 'select:bme280', how: t('Click the small purple BME280 board on the bench') },
        { text: t('Which three numbers does it give?'), done: 'reveal', answer: t('Temperature (°C), humidity (%) and air pressure (hPa). Pressure changes with the weather and with height: about 1 hPa per 8 m.') },
      ],
      callouts: [C.bme, C.sda, C.scl, C.vin, C.gnd],
      codeLines: [36, 37],
    },
    {
      id: 'bus',
      title: t('Address 0x76, one shared bus'),
      sub: t('Several parts on the same two wires'),
      body: t('I2C is a bus: many parts share the same SDA and SCL wires, each with its own address, and the BME280 answers to 0x76 (or 0x77 when its SDO pin is tied high). At start-up the code knocks on every address and prints the ones that answer, then talks only to 0x76. You will also see 0x3C: the OLED from lesson 3 is still on these wires in the simulator, even though this lesson hides it.'),
      tasks: [
        { text: t('Click GPIO8, the shared data pin'), done: 'select:GPIO8', how: t('Click the pin where the green SDA wire lands on the board') },
        { text: t('Think: how could you read two BME280s on one bus?'), done: 'reveal', answer: t('Tie the second one\'s SDO pin to 3.3 V so it answers at 0x77, then add a second device at 0x77 in the code. Same two wires, two addresses.') },
      ],
      callouts: [C.pin8, C.pin9, C.bme],
      codeLines: [16, 45, 48],
    },
    {
      id: 'calc',
      title: t('From raw counts to °C'),
      sub: t('Calibration and the datasheet formula'),
      body: t('The sensor does not send "23.5 °C". It sends raw counts, and every chip is a little different, so the factory stores correction numbers inside each one. The code reads those once at start-up, then every second reads 8 raw bytes and runs the formulas from the BME280 datasheet to turn them into °C, % and hPa.'),
      tasks: [
        { text: t('Find where the code reads the calibration'), done: 'reveal', answer: t('Lines 56 and 57 read 26 + 7 bytes of calibration; line 58 unpacks them. This happens once, before the loop.') },
        { text: t('Think: comp_t returns 2350. What temperature is that?'), done: 'reveal', answer: t('23.50 °C: the formula works in hundredths of a degree so it never needs decimals. Line 77 prints 2350 ÷ 100 and the remainder.') },
      ],
      callouts: [C.bme, C.sda],
      codeLines: [56, 70, 74],
    },
    {
      id: 'run',
      title: t('Run and read the serial log'),
      sub: t('One line per second'),
      body: t('Click "Run": the serial log shows the bus scan and "chip id 0x60 OK", then one line per second like T=23.50 C H=45.00 % P=1013.25 hPa. "What happened" shows each read as one row: the code sends the register number, then the sensor answers with 8 bytes. The checkpoint passes when every line matches the environment set by the check.'),
      tasks: [
        { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
        { text: t('Check the serial log: which addresses did the scan find?'), done: 'reveal', answer: t('0x3C and 0x76: the OLED and this sensor, on the same two wires.') },
      ],
      callouts: [C.bme, C.sda, C.scl],
      codeLines: [68, 70, 77],
    },
    {
      id: 'tweak',
      title: t('Change the weather'),
      sub: t('Drag the sliders, watch the numbers'),
      body: t('The simulator decides what the air around the sensor is like: click the sensor, drag the temperature or humidity slider in its card, and within a second the next serial line shows the new value. Pressure has its own slider under Environment in the build tree. On a real desk, a hand near the sensor or a breath on it does the same.'),
      tasks: [
        { text: t('Drag the temperature slider and watch T= follow'), done: 'env:temp', how: t('Click the BME280, then drag Ambient temperature in its card') },
        { text: t('Change the humidity and watch H= follow'), done: 'env:humidity', how: t('Click the BME280, then drag Humidity in its card') },
      ],
      callouts: [C.bme],
      codeLines: [74, 76],
    },
  ],
};
