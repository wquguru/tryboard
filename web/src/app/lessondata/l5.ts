// Lesson 5 (PLAN H-16): WS2812 colour strip on the knob lamp's first checkpoint (lamp · lamp-1, firmware lamp-strip).
// The feed counts lit LEDs per frame from worker ticks (the io trace only has the frame length and first colour).
import { t } from '../../i18n/index.ts';
import type { Lesson, LessonCallout } from '../lessons.ts';

const DS_WS = t('Worldsemi WS2812B datasheet');

const CALLOUTS: Record<string, LessonCallout> = {
  strip: { key: 'strip', target: { kind: 'part', id: 'ws2812' }, title: t('WS2812 strip × 8'), body: t('Each LED has its own tiny chip; one data wire drives them all') },
  din: { key: 'din', target: { kind: 'pin', id: 'GPIO5' }, title: t('GPIO5 → DIN'), body: t('The only data wire: the colours leave here as a stream of pulses') },
  v5: { key: 'v5', target: { kind: 'wire', id: 'wire:5V~ws2812:5V', anchor: '0' }, title: t('5 V supply'), body: t('The LEDs run on 5 V from USB, not on the 3.3 V pin') },
  gnd: { key: 'gnd', target: { kind: 'wire', id: 'wire:GND~ws2812:GND', anchor: '0' }, title: t('GND (ground)'), body: t('Shared ground: power returns here and the data is measured against it') },
  usb: { key: 'usb', target: { kind: 'part', id: 'board', anchor: 'usb' }, title: t('USB-C port'), body: t('Where the 5 V for the strip comes from') },
};
const pick = (...k: string[]) => k.map((x) => CALLOUTS[x]);

export const L5: Lesson = {
  work: 'lamp',
  checkpoint: 'lamp-1',
  no: 5,
  title: t('Colour LED strip'),
  summary: t('Light 8 colour LEDs one by one over a single data wire.'),
  minutes: 10,
  buy: t('WS2812 8-LED strip, 74AHCT125 level shifter'),
  parts: ['ws2812'],
  fw: 'lamp-strip',
  src: 'firmware/lamp/main/main.c',
  strip: [{ pin: 5, text: t('LEDs lit: {n} of {of}'), line: 54 }],
  wireNotes: {
    'wire:5V~ws2812:5V': { to: t('Strip 5V'), why: t('Power for the LEDs from USB 5 V: up to about 60 mA per LED') },
    'wire:GPIO5~ws2812:DIN': { to: t('Strip DIN (through the level shifter)'), why: t('The one data wire: every colour travels down it in turn') },
    'wire:GND~ws2812:GND': { to: t('Strip GND'), why: t('Shared ground: power returns here and the data is measured against it') },
  },
  code: [
    { line: 15, text: t("The strip's data pin: GPIO5") },
    { line: 16, text: t('How many LEDs are on the strip') },
    { line: 31, text: t('RMT clock 10 MHz: one tick is 0.1 µs') },
    { line: 36, text: t('A 0 bit: high for 3 ticks (0.3 µs), then low for 9 (0.9 µs)') },
    { line: 37, text: t('A 1 bit: high for 9 ticks (0.9 µs), then low for 3 (0.3 µs)') },
    { line: 38, text: t('Each byte goes out highest bit first, as the WS2812 expects') },
    { line: 49, text: t('Green byte first: the WS2812 wants G, R, B order') },
    { line: 50, text: t('Then the red byte') },
    { line: 51, text: t('Then the blue byte: 3 bytes = 24 bits per LED') },
    { line: 54, text: t('Hand all 24 bytes to RMT; it plays the pulses out by itself') },
    { line: 55, text: t('Wait until the last pulse has gone out') },
    { line: 62, text: t('Dim a colour: each channel × k ÷ 255') },
    { line: 66, text: t('Warm white: red FF, green 99, blue 33') },
    { line: 119, text: t('Send one frame: the first i LEDs lit, the rest off') },
    { line: 120, text: t('Wait 60 ms, then light one more') },
    { line: 122, text: t('All lit: say so in the serial log') },
  ],
  params: [
    { label: t('LEDs on the strip'), value: '8', source: 'bench' },
    { label: t('Data pin'), value: 'GPIO5 → DIN', source: 'bench' },
    { label: t('Bits per LED'), value: t('24 (green, red, blue: 8 each)'), source: 'datasheet', doc: DS_WS },
    { label: t('0 bit / 1 bit'), value: t('0.3 µs / 0.9 µs high, 1.2 µs in all'), source: 'code' },
    { label: t('Data rate'), value: t('About 800 kHz'), source: 'code' },
    { label: t('Strip supply'), value: '5 V', source: 'datasheet', doc: DS_WS },
    { label: t('One LED at full white'), value: t('About 60 mA (3 × 20 mA)'), source: 'typical' },
    { label: t('8 LEDs at full white'), value: '8 × 60 = 480 mA', source: 'estimate' },
    { label: t('Colour sent'), value: '#FF9933 × 64 ÷ 255 = #40260C', source: 'code' },
    { label: t("This lesson's dim warm white"), value: t('About 70 mA for all 8'), source: 'estimate' },
  ],
  buyTip: t('When buying: a WS2812B 8-LED stick or strip, plus a 74AHCT125 to lift the 3.3 V data to 5 V. Beyond about 8 LEDs at full brightness, give the strip its own 5 V supply and join its GND to the board.'),
  steps: [
    {
      id: 'strip',
      title: t('Meet the WS2812 strip'),
      sub: t('One data wire for all 8'),
      body: t('Each of the 8 LEDs has a tiny chip inside that remembers its own colour. They are chained: the first LED keeps the first 24 bits on the data wire and passes everything after them on to the next. So one wire from GPIO5 to DIN controls the whole strip, however long it is.'),
      tasks: [
        { text: t('Click the strip to see its specs'), done: 'select:ws2812', how: t('Click the LED strip on the bench') },
        { text: t('Count the wires going to the strip: how many carry data?'), done: 'reveal', answer: t('Three wires, only one of them data: 5V (red) is power, DIN (orange) from GPIO5 is data, GND (black) is the way back.') },
      ],
      callouts: pick('strip', 'din', 'gnd'),
      codeLines: [15, 16],
    },
    {
      id: 'power',
      title: t('Why 5 V, and how much current'),
      sub: t('About 60 mA per LED at full white'),
      body: t('WS2812 LEDs are made for 5 V, so the strip takes its power from the 5V pin (straight from USB) instead of the 3.3 V pin. Each LED has a red, a green and a blue part drawing up to about 20 mA each, so one LED at full white takes about 60 mA. The data pulses from GPIO5 are only 3.3 V, so on a real build a 74AHCT125 chip lifts them to 5 V on the way.'),
      tasks: [
        { text: t('Work it out: all 8 LEDs at full white'), done: 'reveal', answer: t('8 × 60 mA = 480 mA, close to the 500 mA a computer USB 2.0 port gives. That is about the most to run straight from USB.') },
        { text: t("Think: and at this lesson's dim warm white?"), done: 'reveal', answer: t('Each channel draws about 20 mA × value ÷ 255: red 64, green 38, blue 12 make about 9 mA per LED, so about 70 mA for all 8. An estimate: real LEDs vary.') },
      ],
      callouts: pick('v5', 'usb', 'gnd'),
      codeLines: [62, 119],
    },
    {
      id: 'bits',
      title: t('24 bits per LED, sent by RMT'),
      sub: t('Green, red, blue'),
      body: t('Each LED gets 24 bits: 8 for green, 8 for red, 8 for blue, in that order (GRB, not RGB). A 0 bit is a short high pulse (0.3 µs) and a 1 bit a long one (0.9 µs), far too fast to switch a pin by hand. The S3\'s RMT peripheral plays these pulses out by itself, so the code only hands it the bytes.'),
      tasks: [
        { text: t('Find where green goes first'), done: 'reveal', answer: t('Lines 49 to 51: grb[i * 3] gets green (bits 8 to 15 of the colour), then red, then blue.') },
        { text: t('Think: how long does one frame for all 8 LEDs take?'), done: 'reveal', answer: t('8 × 24 = 192 bits at 1.2 µs each is about 230 µs. Then the line stays low for over 280 µs so the LEDs know the frame is over.') },
      ],
      callouts: pick('din', 'strip'),
      codeLines: [36, 37, 49],
    },
    {
      id: 'run',
      title: t('Run: light them one by one'),
      sub: t('One more LED every 60 ms'),
      body: t('Click "Run": every 60 ms the code sends a frame for all 8 LEDs, each time with one more lit. The unlit ones get 0 for all three colours, which means off. When all 8 glow warm white the serial log prints LAMP ON 8.'),
      tasks: [
        { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
        { text: t('Watch all 8 LEDs light up'), done: 'strip:5=8', how: t('Run the code and watch the strip on the bench') },
      ],
      callouts: pick('strip', 'din'),
      codeLines: [119],
    },
    {
      id: 'tweak',
      title: t('Change it'),
      sub: t('Colour and brightness'),
      body: t('Line 119 sends WARM (#FF9933) scaled to 64 out of 255, which is why the strip glows a dim warm white. Change WARM to 0x0000FF for blue, or 64 to 255 for full brightness. Brighter means more current, so check the supply first.'),
      tasks: [
        { text: t('Think: what colour is 0x00FF00, and which byte goes out first?'), done: 'reveal', answer: t('Green. In GRB order the three bytes are FF 00 00: the green one is sent first.') },
        { text: t("Find where the strip's 5 V comes from"), done: 'select:board@usb', how: t('Click one of the two USB-C ports at the short end of the board') },
        { text: t('Think: can USB power a 60-LED strip at full white?'), done: 'reveal', answer: t('60 × 60 mA = 3.6 A, about seven times what a USB 2.0 port gives. It needs its own 5 V supply of 4 A or more, with its GND joined to the board.') },
      ],
      callouts: pick('strip', 'v5', 'usb'),
      codeLines: [66, 119],
    },
  ],
};
