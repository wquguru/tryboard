// Lesson 9 (PLAN H-16): a potentiometer read by the ADC, on the course-only `adc` bench (firmware s3-pot, no checkpoint).
// lamp-2 (the planned slot) uses an EC11 encoder, not a pot, so this lesson moved (DECISIONS 2026-10-26 H-16 lesson 9).
import { t } from '../../i18n/index.ts';
import type { Lesson, LessonCallout } from '../lessons.ts';

const DS_S3 = t('ESP32-S3 datasheet');
const IDF_ADC = t('ESP-IDF programming guide (ESP32-S3): ADC oneshot');

const CALLOUTS: Record<string, LessonCallout> = {
  pot: { key: 'pot', target: { kind: 'part', id: 'pot' }, title: t('10 kΩ potentiometer'), body: t('Drag the knob sideways to turn it') },
  wiper: { key: 'wiper', target: { kind: 'pin', id: 'GPIO4' }, title: t('GPIO4 ← wiper'), body: t('ADC1 channel 3: the chip measures the voltage here') },
  v33: { key: 'v33', target: { kind: 'wire', id: 'wire:3V3~pot:VCC', anchor: '0' }, title: t('3V3 → one end'), body: t('The top of the divider: 3.3 V') },
  gnd: { key: 'gnd', target: { kind: 'wire', id: 'wire:GND~pot:GND', anchor: '0' }, title: t('GND → other end'), body: t('The bottom of the divider: 0 V') },
  led: { key: 'led', target: { kind: 'part', id: 'led:5', anchor: 'led' }, title: t('LED on GPIO5'), body: t('Its brightness follows the reading') },
  chip: { key: 'chip', target: { kind: 'part', id: 'board' }, title: t('ESP32-S3 chip'), body: t('The ADC inside turns volts into a number') },
};
const pick = (...k: string[]) => k.map((x) => CALLOUTS[x]);

export const L9: Lesson = {
  work: 'adc',
  checkpoint: 'lesson-9',
  no: 9,
  title: t('Turn a knob'),
  summary: t('Read a potentiometer with the ADC and let it set the LED brightness.'),
  minutes: 12,
  buy: t('10 kΩ potentiometer'),
  parts: ['pot', 'led:5'],
  fw: 's3-pot',
  src: 'firmware/pot/main/main.c',
  wireNotes: {
    'wire:3V3~pot:VCC': { to: t('Potentiometer end pin 1'), why: t('One end of the resistor track sits at 3.3 V') },
    'wire:GPIO4~pot:OUT': { to: t('Potentiometer middle pin (wiper)'), why: t('The wiper voltage, anywhere from 0 to 3.3 V, goes to the ADC') },
    'wire:GND~pot:GND': { to: t('Potentiometer end pin 3'), why: t('The other end sits at 0 V, closing the divider') },
    'wire:GPIO5~led:5:IN': { to: t('{ohm} Ω resistor → LED long leg'), why: t('PWM from the code: the bigger the reading, the longer it stays on') },
    'wire:GND~led:5:GND': { to: t('LED short leg'), why: t('Current flows back to the board here, closing the loop') },
  },
  code: [
    { line: 10, text: t('Which ADC channel to read; the S3 build sets channel 3 = GPIO4') },
    { line: 22, text: t('Use ADC unit 1: it keeps working when Wi-Fi is on') },
    { line: 24, text: t('12 dB attenuation (range up to about 3.1 V), 12-bit results (0–4095)') },
    { line: 25, text: t('Apply those settings to the knob channel') },
    { line: 27, text: t('LED PWM: 5 kHz, 12 bits, so duty runs 0–4095 like the reading') },
    { line: 37, text: t('Read the wiper once: raw is a number from 0 to 4095') },
    { line: 38, text: t('Use the reading straight as the LED duty: higher = brighter') },
    { line: 40, text: t('Only print when the reading moved by more than 40') },
    { line: 41, text: t('Print raw, about how many mV (raw × 3100 ÷ 4095) and the brightness in %') },
    { line: 46, text: t('Seen both ends (below 100 and above 3500): print TRYBOARD_OK pot') },
    { line: 47, text: t('Read again 50 ms later, 20 times a second') },
  ],
  params: [
    { label: t('Potentiometer'), value: t('10 kΩ, ends on 3V3 and GND'), source: 'bench' },
    { label: t('Wiper pin'), value: t('GPIO4 = ADC1 channel 3'), source: 'datasheet', doc: DS_S3 },
    { label: t('Current through the track'), value: t('3.3 V ÷ 10 kΩ ≈ 0.33 mA'), source: 'estimate' },
    { label: t('Wiper voltage'), value: t('3.3 V × (how far the knob is turned)'), source: 'estimate' },
    { label: t('ADC resolution'), value: t('12 bits: 0–4095'), source: 'datasheet', doc: DS_S3 },
    { label: t('Range at 12 dB attenuation'), value: t('About 0–3.1 V'), source: 'datasheet', doc: IDF_ADC },
    { label: t('Other attenuations'), value: t('0 / 2.5 / 6 dB: about 0.95 / 1.25 / 1.75 V'), source: 'datasheet', doc: IDF_ADC },
    { label: t('ADC1 / ADC2 pins'), value: t('ADC1: GPIO1–10; ADC2: GPIO11–20'), source: 'datasheet', doc: DS_S3 },
    { label: t('1.55 V on a typical chip'), value: t('Raw about 1852 (an ideal ADC would give 2048)'), source: 'typical' },
    { label: t('mV in the serial log'), value: 'raw × 3100 ÷ 4095', source: 'code' },
    { label: t('Reads per second'), value: t('20 (every 50 ms)'), source: 'code' },
  ],
  buyTip: t('When buying: any 10 kΩ linear (B10K) potentiometer works; a breadboard-friendly one has 3 pins in a row. Put the wiper on an ADC1 pin (GPIO1–10 on the S3): ADC2 pins stop reading once Wi-Fi starts, which the "Find the fault" checkpoint fault-adc shows.'),
  steps: [
    {
      id: 'pot',
      title: t('Meet the potentiometer'),
      sub: t('A knob with three pins'),
      body: t('Inside the potentiometer is a 10 kΩ resistor track with a pin at each end, and a third pin in the middle called the wiper. Turning the knob slides the wiper along the track. On the bench you turn it by dragging the knob sideways.'),
      tasks: [
        { text: t('Click the potentiometer to see its specs'), done: 'select:pot', how: t('Click the potentiometer on the bench') },
        { text: t('Count its pins: which one moves when you turn the knob?'), done: 'reveal', answer: t('Three pins. The two ends are fixed to the track (3V3 and GND here); only the middle one, the wiper, moves along it.') },
      ],
      callouts: pick('pot', 'v33', 'gnd'),
    },
    {
      id: 'divider',
      title: t('A voltage divider'),
      sub: t('0 to 3.3 V on the wiper'),
      body: t('One end of the track is at 3.3 V and the other at 0 V, so the voltage drops evenly along it. The wiper picks off the voltage where it sits: near the GND end it is close to 0 V, near the 3V3 end close to 3.3 V. That is a voltage divider, and the wiper goes to GPIO4.'),
      tasks: [
        { text: t('Think: knob in the middle, what voltage is on the wiper?'), done: 'reveal', answer: t('Half of 3.3 V, about 1.65 V: the wiper splits the 10 kΩ into 5 kΩ above and 5 kΩ below.') },
        { text: t('Think: how much current does the potentiometer draw?'), done: 'reveal', answer: t('3.3 V ÷ 10 kΩ ≈ 0.33 mA, wherever the knob is: the whole track always sits between 3V3 and GND. The ADC pin itself takes almost nothing.') },
      ],
      callouts: pick('v33', 'wiper', 'gnd'),
    },
    {
      id: 'adc',
      title: t('The ADC turns volts into a number'),
      sub: t('0–4095, 12 bits'),
      body: t('The chip cannot use a voltage directly, so its ADC (analog-to-digital converter) measures it and gives a whole number from 0 to 4095. Line 24 picks 12 dB attenuation, which lets the ADC take up to about 3.1 V; without it the range would stop near 1 V. Line 22 uses ADC unit 1, because unit 2 is busy whenever Wi-Fi is on.'),
      tasks: [
        { text: t('Think: what would an ideal ADC read at 1.55 V?'), done: 'reveal', answer: t('1.55 ÷ 3.1 × 4095 ≈ 2048, half way. A typical real chip reads about 1852: each chip is a little off, which is why ESP-IDF has calibration (adc_cali).') },
        { text: t('Find where the reading becomes the LED brightness'), done: 'reveal', answer: t('Line 38: ledc_set_duty gets raw itself. The PWM is also 12 bits, so 0 is off and 4095 is fully on.') },
      ],
      callouts: pick('wiper', 'chip'),
      codeLines: [22, 24, 37],
    },
    {
      id: 'run',
      title: t('Run: turn the knob'),
      sub: t('Watch the number and the LED'),
      body: t('Click "Run", then drag the potentiometer knob left and right. Every 50 ms the code reads GPIO4, prints a line whenever the number moves by more than 40 and sets the LED to match. Turn it all the way both ways: once it has seen both ends the log prints TRYBOARD_OK pot.'),
      tasks: [
        { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
        { text: t('Turn the knob all the way down: reading below 100'), done: 'adc:4<100', how: t('Drag the potentiometer knob to the left') },
        { text: t('Turn the knob all the way up: reading above 3500'), done: 'adc:4>3500', how: t('Drag the potentiometer knob to the right') },
      ],
      callouts: pick('pot', 'led'),
      codeLines: [37, 41],
    },
    {
      id: 'tweak',
      title: t('Change it'),
      sub: t('Range and pin'),
      body: t('The 12 dB on line 24 sets the range. With ADC_ATTEN_DB_0 the ADC only takes up to about 0.95 V, so most of the knob would read 4095. Moving the wiper to another pin is fine as long as it is an ADC1 pin.'),
      tasks: [
        { text: t('Think: with 0 dB attenuation, where does the reading hit 4095?'), done: 'reveal', answer: t('At about 0.95 V, less than a third of the way round: from there to the 3V3 end every position reads 4095. Small signals get finer steps, big ones get clipped.') },
        { text: t('Think: in a project with Wi-Fi on, can the wiper go to GPIO11?'), done: 'reveal', answer: t('Better not: GPIO11 is on ADC2, and on the S3 ADC2 reads fail with a timeout once Wi-Fi starts. Keep it on GPIO1–10 (ADC1). The fault-adc checkpoint shows exactly this.') },
      ],
      callouts: pick('wiper', 'chip'),
      codeLines: [24],
    },
  ],
};
