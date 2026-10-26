// Lesson 0 (PLAN H-16, design-v2/beginner/v3/Lesson0.dc.html): meet the dev board. No wiring, no firmware.
// Filed under lessonKey 'lesson-0' in the basics work; done once every task is ticked (course.ts tasksDone).
import { t } from '../../i18n/index.ts';
import type { Lesson, LessonCallout } from '../lessons.ts';

const DS_S3 = t('ESP32-S3 datasheet');

const C: Record<string, LessonCallout> = {
  usb: { key: 'usb', target: { kind: 'part', id: 'board', anchor: 'usb' }, title: t('USB-C port'), body: t('Power + code download') },
  boot: { key: 'boot', target: { kind: 'button', id: 'BOOT' }, title: t('BOOT button'), body: t('Lesson 2 uses it') },
  chip: { key: 'chip', target: { kind: 'part', id: 'board' }, title: t('Main chip'), body: t('The code you write runs here') },
  header: { key: 'header', target: { kind: 'pin', id: 'GPIO5' }, title: t('Pin header'), body: t('Each pin is one connection to the chip') },
  gpio: { key: 'gpio', target: { kind: 'pin', id: 'GPIO5' }, title: t('GPIO5 pin'), body: t('Lesson 1 lights an LED from here') },
  v33: { key: 'v33', target: { kind: 'pin', id: '3V3' }, title: t('3V3 pin'), body: t('Always 3.3 V while the board has power') },
  gnd: { key: 'gnd', target: { kind: 'pin', id: 'GND' }, title: t('GND (ground)'), body: t('0 V: where current returns to the board') },
  v5: { key: 'v5', target: { kind: 'pin', id: '5V' }, title: t('5V pin'), body: t('The 5 V from USB, before the regulator') },
  rst: { key: 'rst', target: { kind: 'button', id: 'RST' }, title: t('RST button'), body: t('Restarts the chip') },
};

export const LESSON_0: Lesson = {
  work: 'basics',
  checkpoint: 'lesson-0',
  no: 0,
  title: t('Meet the dev board'),
  summary: t('Find the USB-C port, the BOOT button, the chip and the pins. No wiring and no code yet.'),
  minutes: 5,
  buy: t('An ESP32-S3 dev board and a USB-C data cable'),
  // Only the board: the LED of the basics bench stays hidden until lesson 1
  parts: [],
  fw: '',
  src: '',
  params: [
    { label: t('Processor'), value: t('Dual-core Xtensa LX7, up to 240 MHz'), source: 'datasheet', doc: DS_S3 },
    { label: t('Memory (SRAM)'), value: '512 KB', source: 'datasheet', doc: DS_S3 },
    { label: t('Wireless'), value: t('2.4 GHz Wi-Fi + Bluetooth LE 5'), source: 'datasheet', doc: DS_S3 },
    { label: t('Chip supply voltage'), value: t('3.0 to 3.6 V (3.3 V on this board)'), source: 'datasheet', doc: DS_S3 },
    { label: t('Module on this board'), value: t('ESP32-S3-WROOM-1 N16R8: 16 MB flash, 8 MB PSRAM'), source: 'bench' },
    { label: t('USB power'), value: '5 V', source: 'typical' },
  ],
  buyTip: t('When buying: an ESP32-S3-DevKitC-1 or any ESP32-S3 board with USB-C. Check that the cable carries data: charge-only cables power the board but cannot load code.'),
  steps: [
    {
      id: 'find',
      title: t('Find these four on the board'),
      sub: t('USB-C, BOOT, chip, pins'),
      body: t('This is the ESP32-S3 dev board, the only thing on the bench in this lesson. Click each of the four things the cards point at. Rotate the view if one is hidden.'),
      tasks: [
        { text: t('Find the USB-C port'), done: 'select:board@usb', how: t('Click one of the two USB-C ports at the short end of the board') },
        { text: t('Find the BOOT button'), done: 'press:boot×1', how: t('Click the BOOT button next to the USB ports: it really presses it') },
        { text: t('Find the main chip'), done: 'select:board@chip', how: t('Click the metal can at the other end of the board') },
        { text: t('Find GPIO5 on the pin header'), done: 'select:GPIO5', how: t('Click the gold pin the "Pin header" card points at') },
      ],
      callouts: [C.usb, C.boot, C.chip, C.header],
    },
    {
      id: 'pins',
      title: t('Meet the pins'),
      sub: t('GPIO5, 3V3, GND'),
      body: t('Each gold pin on the two long edges connects to the chip, and its name is printed beside it. Pins named GPIO plus a number are the ones your code can switch between 3.3 V and 0 V. Power pins like 3V3 and GND never change.'),
      tasks: [
        { text: t('Find the 3V3 pin'), done: 'select:3V3', how: t('Click the pin the "3V3 pin" card points at') },
        { text: t('Find a GND pin'), done: 'select:GND', how: t('There are several GND pins: any of them counts') },
        { text: t('Why will lesson 1 drive its LED from GPIO5 and not from 3V3?'), done: 'reveal', answer: t('3V3 is always on, so an LED there could only stay lit. GPIO5 can be switched on and off by code, so it can blink.') },
      ],
      callouts: [C.gpio, C.v33, C.gnd],
    },
    {
      id: 'power',
      title: t('Power and code download'),
      sub: t('One cable does both'),
      body: t('The USB-C cable brings 5 V from the computer, and a regulator on the board turns it into the 3.3 V the chip runs on. The same cable carries your program into the chip. Holding BOOT while pressing RST puts the chip into download mode by hand.'),
      tasks: [
        { text: t('Find the 5V pin'), done: 'select:5V', how: t('Click the pin the "5V pin" card points at') },
        { text: t('Why does this board have two USB-C ports?'), done: 'reveal', answer: t('One goes through a USB-to-serial chip (UART), the other straight to the ESP32-S3\'s own USB. Either one powers the board and can load code.') },
        { text: t('What does the chip itself run on: 5 V or 3.3 V?'), done: 'reveal', answer: t('3.3 V. USB brings 5 V and the regulator on the board brings it down; a GPIO high level is 3.3 V too.') },
      ],
      callouts: [C.usb, C.v5, C.boot, C.rst],
    },
  ],
};
