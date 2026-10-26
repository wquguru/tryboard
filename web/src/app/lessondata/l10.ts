// Lesson 10 (PLAN H-16): the S3 as a USB keyboard; checkpoint usbkey-2 (enumerate + K1-K3 type "abc"), reference build usbkey.
// Lines point at firmware/usbkey/main/main.c; the virtual PC (laptop + USB tab) is the stock usbkey one.
import { t } from '../../i18n/index.ts';
import type { Lesson, LessonCallout } from '../lessons.ts';

const DS_S3 = t('ESP32-S3 datasheet');
const DS_C3 = t('ESP32-C3 datasheet');
const DS_HID = t('USB HID specification');
const K = [4, 5, 6] as const;
const IN = (p: number) => `wire:GPIO${p}~key:${p}:IN`;
const GND = (p: number) => `wire:GND~key:${p}:GND`;

const C: Record<string, LessonCallout> = {
  usb: { key: 'usb', target: { kind: 'part', id: 'board', anchor: 'usb' }, title: t('USB-C port: to the PC'), body: t('On a real S3 board use the port marked USB / OTG (GPIO19 / GPIO20)') },
  chip: { key: 'chip', target: { kind: 'part', id: 'board' }, title: t('ESP32-S3: USB built in'), body: t('Its USB OTG block speaks USB itself, no adapter chip needed') },
  k1: { key: 'k1', target: { kind: 'part', id: 'key:4' }, title: t('K1 sends a'), body: t('Click the keycap to press it') },
  k2: { key: 'k2', target: { kind: 'part', id: 'key:5' }, title: t('K2 sends b'), body: t('Same circuit, GPIO5') },
  k3: { key: 'k3', target: { kind: 'part', id: 'key:6' }, title: t('K3 sends c'), body: t('Same circuit, GPIO6') },
  pin: { key: 'pin', target: { kind: 'pin', id: 'GPIO4' }, title: t('GPIO4: reads K1'), body: t('Pulled up inside the chip: high when idle, low while pressed') },
  in1: { key: 'in1', target: { kind: 'wire', id: IN(4) }, title: t('Orange wire: key to GPIO'), body: t('Carries no power, only the pressed / released level') },
  gnd: { key: 'gnd', target: { kind: 'wire', id: GND(4), anchor: '0' }, title: t('GND (ground)'), body: t('A press connects the pin to here, so it reads 0') },
};

export const L10: Lesson = {
  work: 'usbkey',
  checkpoint: 'usbkey-2',
  no: 10,
  title: t('Build a USB keyboard'),
  summary: t('The ESP32-S3 tells the PC "I am a keyboard"; three keys type a, b and c.'),
  minutes: 15,
  buy: t('Tactile buttons × 3 (and an S3 board with a native USB port)'),
  parts: K.map((p) => `key:${p}`),
  fw: 'usbkey',
  src: 'firmware/usbkey/main/main.c',
  wireNotes: Object.fromEntries(
    K.flatMap((p, i) => [
      [IN(p), { to: [t('Button K1, one leg'), t('Button K2, one leg'), t('Button K3, one leg')][i], why: t('Pulled up to 3.3 V inside the chip; a press pulls it to 0 V') }],
      [GND(p), { to: [t('Button K1, other leg'), t('Button K2, other leg'), t('Button K3, other leg')][i], why: t('The press closes the switch to ground') }],
    ]),
  ),
  code: [
    { line: 13, text: t('Which GPIO each key is on: K1–K4 = GPIO4–7') },
    { line: 14, text: t('What K1–K3 type') },
    { line: 17, text: t('Report descriptor: "my reports are a standard keyboard\'s" (modifier byte + 6 key slots)') },
    { line: 22, text: t('Manufacturer name the PC shows') },
    { line: 23, text: t('Product name the PC shows: TryBoard Macro Pad') },
    { line: 30, text: t('Configuration descriptor: 1 interface, asks the PC for up to 100 mA') },
    { line: 31, text: t('HID interface, keyboard protocol: the PC polls endpoint 0x81 every 10 ms') },
    { line: 38, text: t('Table from a letter to its HID key code (a = 0x04) and whether Shift is needed') },
    { line: 51, text: t('Key-down report: "key a is held"') },
    { line: 52, text: t('Wait 12 ms so the PC (polling every 10 ms) sees it') },
    { line: 54, text: t('All-released report: without it the PC thinks the key is stuck and repeats it') },
    { line: 60, text: t('Inputs with the internal pull-up: idle = high') },
    { line: 71, text: t('Start TinyUSB with these descriptors; the PC can now enumerate') },
    { line: 73, text: t('Wait until the PC has finished enumerating (tud_mounted)') },
    { line: 75, text: t('Checkpoint marker: enumeration done') },
    { line: 82, text: t('Debounce: accept a new level only when two samples 10 ms apart agree') },
    { line: 84, text: t('Act once, on the press (level went low), and only while the PC is connected') },
    { line: 86, text: t('Serial line for each press, e.g. KEY 1 a') },
    { line: 87, text: t('Type the letter: press report + release report') },
    { line: 96, text: t('Sample the keys every 10 ms') },
  ],
  params: [
    { label: t('USB on the ESP32-S3'), value: t('USB OTG, full speed (12 Mbit/s), plus a USB Serial/JTAG port'), source: 'datasheet', doc: DS_S3 },
    { label: t('USB pins'), value: 'D− GPIO19 · D+ GPIO20', source: 'datasheet', doc: DS_S3 },
    { label: t('USB on the ESP32-C3'), value: t('USB Serial/JTAG only: serial log and debugging, it cannot act as a keyboard'), source: 'datasheet', doc: DS_C3 },
    { label: t('Keyboard report'), value: t('8 bytes: modifiers (Shift, Ctrl…), 1 reserved, up to 6 key codes'), source: 'datasheet', doc: DS_HID },
    { label: t('Key code of a / b / c'), value: '0x04 / 0x05 / 0x06', source: 'datasheet', doc: DS_HID },
    { label: t('PC polling interval'), value: '10 ms', source: 'code' },
    { label: t('Time per character'), value: t('24 ms (press 12 ms + release 12 ms), about 40 characters a second'), source: 'code' },
    { label: t('Debounce'), value: t('Sample every 10 ms, 2 matching samples'), source: 'code' },
    { label: t('Key pins'), value: 'K1 GPIO4 · K2 GPIO5 · K3 GPIO6', source: 'bench' },
    { label: t('Internal pull-up'), value: t('About 45 kΩ'), source: 'datasheet', doc: DS_S3 },
    { label: t('Switch bounce'), value: t('A few ms after each press or release'), source: 'typical' },
  ],
  buyTip: t('When buying: any ESP32-S3 board with two USB-C ports; the one marked USB or OTG is the native USB. A single-port board may only have a USB-serial chip on it, which cannot be a keyboard. ESP32-C3 and the classic ESP32 cannot do this; the ESP32-S2 can. Use a data cable, not a charge-only one.'),
  steps: [
    {
      id: 'keys',
      title: t('Meet the keys and the USB port'),
      sub: t('Three buttons, one cable to the PC'),
      body: t("Three buttons sit on the breadboard: K1, K2 and K3. The board's USB-C cable goes to a virtual PC: the laptop in 3D and the USB tab below. This time USB is more than power and code download, because the S3 will show up on the PC as a keyboard."),
      tasks: [
        { text: t('Click button K1'), done: 'select:key:4', how: t('Click the first button on the breadboard') },
        { text: t('Click the USB-C port'), done: 'select:board@usb', how: t('The port at the end of the board where the cable goes') },
      ],
      callouts: [C.k1, C.k2, C.k3, C.usb],
    },
    {
      id: 'wire',
      title: t('A button pulls the pin low'),
      sub: t('GPIO4–6, pull-ups, ground'),
      body: t('Each button has one leg on a GPIO and the other on GND. Inside the chip a weak pull-up (about 45 kΩ) holds the pin at 3.3 V, so it reads 1 until a press connects it to ground and it reads 0. That is why the breadboard needs no resistor.'),
      tasks: [
        { text: t('Click the GPIO4 pin'), done: 'select:GPIO4', how: t("Click the pin where K1's orange wire lands on the board") },
        { text: t('Think: what does GPIO4 read while K1 is held down?'), done: 'reveal', answer: t('0 (low). The switch connects it to GND, which beats the weak pull-up. Released, the pull-up brings it back to 1.') },
      ],
      callouts: [C.pin, C.in1, C.gnd],
      codeLines: [13, 60],
    },
    {
      id: 'enum',
      title: t('Enumeration: "I am a keyboard"'),
      sub: t('Descriptors answer the PC'),
      body: t('When the cable goes in, the PC asks the new device "who are you?" and the firmware answers with descriptors. They give a name (TryBoard Macro Pad), one interface of class HID with the keyboard protocol, and a report descriptor saying what each byte of a key report means. The PC then loads its built-in keyboard driver, so nothing has to be installed.'),
      tasks: [
        { text: t('Find the product name in the code'), done: 'reveal', answer: t('Line 23: "TryBoard Macro Pad". The PC shows it in its device list once enumeration is done.') },
        { text: t('Think: why does a USB keyboard need no driver install?'), done: 'reveal', answer: t('It says it is a standard HID keyboard (line 31), and every PC already has a driver for that class. Only unusual devices need their own driver.') },
      ],
      callouts: [C.chip, C.usb],
      codeLines: [17, 23, 31, 73],
    },
    {
      id: 'run',
      title: t('Run, then type abc'),
      sub: t('Key down, then all released'),
      body: t('Click "Run" and watch the USB tab reach "configured": the PC has enumerated the S3 as a keyboard. Every 10 ms the PC asks for news, and on a press the firmware answers with an 8-byte report holding the key code (a = 0x04), then an empty report 12 ms later. Press K1, K2 and K3 in order; the checkpoint passes when the PC types exactly abc.'),
      tasks: [
        { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
        { text: t('The PC enumerates the S3 as a keyboard'), done: 'usb:configured', how: t('Wait about a second after Run; the USB tab shows the device state') },
        { text: t('Type abc on the virtual PC'), done: 'usb:typed=abc', how: t('Click the K1, K2, K3 keycaps one at a time') },
      ],
      callouts: [C.k1, C.k2, C.k3],
      codeLines: [51, 54, 75, 87],
    },
    {
      id: 'tweak',
      title: t('Why only the S3? Change it'),
      sub: t('USB OTG vs USB Serial/JTAG'),
      body: t('To be a keyboard the chip must describe itself freely, which takes a USB OTG controller. The ESP32-C3 only has a fixed USB Serial/JTAG port that always shows up as a serial port and debugger. In the code, change the letters on the highlighted line and K1–K3 type something else.'),
      tasks: [
        { text: t('Think: could an ESP32-C3 board run this lesson?'), done: 'reveal', answer: t('No. Its USB is a fixed USB Serial/JTAG port that always presents itself as a serial port and debugger. Only chips with USB OTG (ESP32-S2, ESP32-S3) can choose to be a keyboard.') },
        { text: t('Think: what if the firmware never sent the empty report?'), done: 'reveal', answer: t('The PC would think a is still held and, after a short pause, repeat it: aaaaaa… That is what a stuck key looks like.') },
        { text: t('Think: how would K3 type a capital C?'), done: 'reveal', answer: t("Change 'c' to 'C' on line 14. The table on line 38 says C needs Shift, so line 51 sets the Left Shift bit in the modifier byte.") },
      ],
      callouts: [C.chip, C.k3],
      codeLines: [14],
    },
  ],
};
