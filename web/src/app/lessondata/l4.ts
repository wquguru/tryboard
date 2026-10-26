// Lesson 4 (PLAN H-16): breathing light. LEDC PWM on GPIO5 fades the lesson-1 LED up and down; basics work, checkpoint basics-pwm.
// Only types come from lessons.ts (it imports this file), so shared values are rebuilt here with the same English keys.
import { t } from '../../i18n/index.ts';
import { LED_VF, ledAmps } from '../../bench3d/ledparams.ts';
import type { Lesson, LessonCallout, LessonParam, LessonWireNote } from '../lessons.ts';

const DS_S3 = t('ESP32-S3 datasheet');
const PEAK_MA = ledAmps(220, LED_VF.red) * 1000;

const C: Record<string, LessonCallout> = {
  chip: { key: 'chip', target: { kind: 'part', id: 'board' }, title: t('ESP32-S3 chip'), body: t('Its LEDC block makes the PWM by itself, without the CPU') },
  gpio: { key: 'gpio', target: { kind: 'pin', id: 'GPIO5' }, title: t('GPIO5 pin'), body: t('Switches between 3.3 V and 0 V 5000 times a second') },
  led: { key: 'led', target: { kind: 'part', id: 'led:5', anchor: 'led' }, title: t('LED'), body: t('Looks as bright as the share of time it is on') },
  res: { key: 'res', target: { kind: 'part', id: 'led:5', anchor: 'res' }, title: t('220 Ω resistor'), body: t('Limits the current. Without it the LED may burn out') },
  gnd: { key: 'gnd', target: { kind: 'wire', id: 'wire:GND~led:5:GND', anchor: '0' }, title: t('GND (ground)'), body: t('Current flows back to the board here') },
};
const pick = (...k: string[]) => k.map((x) => C[x]);

const WIRES: Record<string, LessonWireNote> = {
  'wire:GPIO5~led:5:IN': { to: t('{ohm} Ω resistor → LED long leg'), why: t('The code switches it between high (3.3 V) and low (0 V)') },
  'wire:GND~led:5:GND': { to: t('LED short leg'), why: t('Current flows back to the board here, closing the loop') },
};

const PARAMS: LessonParam[] = [
  { label: t('PWM frequency'), value: '5000 Hz', source: 'code' },
  { label: t('PWM resolution'), value: t('13 bits: duty 0 to 8191'), source: 'code' },
  { label: t('One breath'), value: '2000 ms', source: 'code' },
  { label: t('LED'), value: t('{color} LED, about {v} V', { color: t('Red'), v: LED_VF.red.toFixed(1) }), source: 'typical', live: 'led-vf' },
  { label: t('Resistor'), value: '220 Ω', source: 'bench', live: 'led-ohm' },
  { label: t('LED current while the pin is high'), value: `≈ ${PEAK_MA.toFixed(1)} mA`, source: 'estimate', live: 'led-ma' },
  { label: t('Average LED current at 50 % duty'), value: `≈ ${(PEAK_MA / 2).toFixed(1)} mA`, source: 'estimate' },
  { label: t('LEDC channels'), value: '8', source: 'datasheet', doc: DS_S3 },
];

export const lesson4: Lesson = {
  work: 'basics',
  checkpoint: 'basics-pwm',
  no: 4,
  title: t('Breathing light'),
  summary: t('Fade the LED up and down with PWM, like slow breathing.'),
  minutes: 10,
  buy: t('No new parts needed'),
  parts: ['led:5'],
  fw: 's3-fade',
  src: 'firmware/s3-fade/main/main.c',
  wireNotes: WIRES,
  code: [
    { line: 8, text: t('One breath (up and down) in milliseconds; the chips in step 5 swap in builds with 1000 or 4000') },
    { line: 12, text: t('13 bits give 8192 steps: 0 is off, 8191 is fully on') },
    { line: 19, text: t('Resolution: how finely the on-time can be set') },
    { line: 21, text: t('5000 on-off cycles a second, far too fast for the eye to see') },
    { line: 24, text: t('Start the LEDC timer with these settings') },
    { line: 26, text: t('Send this channel’s PWM out on GPIO5') },
    { line: 36, text: t('Count up to 50, then back down to 0') },
    { line: 37, text: t('Turn the step into a duty: step 50 = 8191 (fully on)') },
    { line: 38, text: t('Set the new duty: the share of each cycle the pin stays high') },
    { line: 39, text: t('Apply it; LEDC keeps switching the pin on its own') },
    { line: 41, text: t('Wait 20 ms (FADE_MS ÷ 100), then take the next step') },
  ],
  params: PARAMS,
  buyTip: t('No new parts: the LED and resistor from lesson 1 are enough. On the S3 almost any GPIO can carry PWM, so later you can dim LEDs on other pins too.'),
  pwm: [{ pin: 5, text: t('Brightness {pct}%'), line: 38 }],
  circuit: { pin: 5, path: ['wire:GPIO5~led:5:IN', 'led:5', 'wire:GND~led:5:GND'] },
  steps: [
    {
      id: 'pwm',
      title: t('What PWM is'),
      sub: t('Fast on-off looks dimmer'),
      body: t('An LED is either on or off, but GPIO5 can switch it 5000 times a second. If it is on for 30 % of each cycle, your eye sees the average: an LED at about 30 % brightness. That share of on-time is called the duty cycle.'),
      tasks: [
        { text: t('Click the LED to open its card'), done: 'select:led:5', how: t('Click the LED on the breadboard') },
        { text: t('At 5000 cycles a second, how long is one on-off cycle?'), done: 'reveal', answer: t('1 ÷ 5000 s = 0.2 ms. Far too short for the eye, which only sees the average.') },
      ],
      callouts: pick('led', 'gpio'),
    },
    {
      id: 'loop',
      title: t('Same loop as lesson 1'),
      sub: t('GPIO5 → resistor → LED → GND'),
      body: t('The wiring does not change: GPIO5 → 220 Ω resistor → LED → GND. Only the code is new: instead of staying high or low, GPIO5 now carries a fast square wave.'),
      tasks: [
        { text: t('Turn on "Show current"'), done: 'view:current', how: t('The "Show current" switch in the toolbar') },
        { text: t('Why does the LED still need its resistor if it is only on part of the time?'), done: 'reveal', answer: t('In every "on" moment the pin is at the full 3.3 V, so the peak current is the same as in lesson 1. The resistor limits that peak.') },
      ],
      callouts: pick('gpio', 'res', 'gnd'),
      codeLines: [26],
    },
    {
      id: 'code',
      title: t('Set up LEDC'),
      sub: t('5 kHz, 13 bits'),
      body: t('LEDC is the PWM generator inside the S3: once set up it switches the pin by itself. The timer picks 5000 Hz and 13-bit resolution, so the duty runs from 0 (off) to 8191 (fully on). The channel sends that timer out on GPIO5.'),
      tasks: [
        { text: t('Click the dev board: LEDC lives inside its chip'), done: 'select:board', how: t('Click the dev board on the bench') },
        { text: t('With 13 bits, which duty value gives half brightness?'), done: 'reveal', answer: t('About 4096, half of the 8192 steps (the code reaches 4095 at step 25).') },
      ],
      callouts: pick('chip', 'gpio'),
      codeLines: [19, 21],
    },
    {
      id: 'run',
      title: t('Run and watch it breathe'),
      sub: t('1 s up, 1 s down'),
      body: t('Click "Run": every 20 ms the loop sets a slightly higher duty, then a slightly lower one, so the LED fades up and down every 2 seconds. "What happened" adds a row each time the duty reaches another 20 %.'),
      tasks: [
        { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
        { text: t('Check: how many duty changes make one full breath?'), done: 'reveal', answer: t('100: 50 steps up and 50 steps down, 20 ms each, which is 2 seconds.') },
      ],
      callouts: pick('led', 'gpio'),
      codeLines: [38],
    },
    {
      id: 'tweak',
      title: t('Change it'),
      sub: t('Breathe faster or slower'),
      body: t('FADE_MS is the length of one breath. Change 2000 to 1000 and the LED breathes twice as fast; 4000 makes it calm and slow.'),
      tasks: [
        { text: t('Change 2000 to 1000'), done: 'chip:delay=1000', how: t('Click 1000 in the highlighted code line') },
        { text: t('Try 4000 and watch again'), done: 'chip:delay=4000', how: t('Click 4000 in the highlighted code line') },
        { text: t('How would you stop it at half brightness?'), done: 'reveal', answer: t('Use DUTY_MAX / 2 (4095) as the top of the ramp in line 37: the breath then peaks at 50 % duty.') },
      ],
      callouts: pick('led'),
      codeLines: [8],
      codeChips: { line: 8, values: [1000, 2000, 4000], current: 2000, fw: { 1000: 's3-fade-1000', 2000: 's3-fade', 4000: 's3-fade-4000' } },
    },
  ],
};
