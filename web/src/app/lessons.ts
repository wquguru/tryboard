// Beginner lessons (PLAN H): five short steps per checkpoint, shown on the bench while beginner mode is on.
// Text is English through t() (zh / ja / ko in i18n lab.ts); code lines point at the checkpoint's reference source.
import { t } from '../i18n/index.ts';

/** A bench thing a callout points at: same shape as PickTarget (part / pin / wire / button + id). */
export interface LessonTarget {
  kind: 'part' | 'pin' | 'wire' | 'button';
  id: string;
}
export interface LessonCallout {
  /** Stable key for H-02 cards (chip, gpio, usb, res, led, gnd). */
  key: string;
  target: LessonTarget;
  title: string;
  body: string;
}
/** Clickable numbers in a code line (H-06: prebuilt delay variants). */
export interface CodeChips {
  line: number;
  values: number[];
  current: number;
}
export interface LessonStep {
  id: string;
  title: string;
  /** One-line hint under the title in the step list. */
  sub: string;
  /** At most three sentences. */
  body: string;
  tasks: string[];
  callouts: LessonCallout[];
  /** 1-based lines in `Lesson.src` to highlight for this step (H-03 follows events instead while running). */
  codeLines?: number[];
  codeChips?: CodeChips;
}
export interface Lesson {
  work: string;
  checkpoint: string;
  /** "Lesson N" in the top bar. */
  no: number;
  title: string;
  summary: string;
  minutes: number;
  /** Parts this lesson adds to the shopping list. */
  buy: string;
  /** Built-in firmware the lesson runs (= the level's ref) and its source file. */
  fw: string;
  src: string;
  steps: LessonStep[];
}

const CALLOUTS: Record<string, LessonCallout> = {
  chip: { key: 'chip', target: { kind: 'part', id: 'board' }, title: t('ESP32-S3 chip'), body: t('The code you write runs here') },
  gpio: { key: 'gpio', target: { kind: 'pin', id: 'GPIO5' }, title: t('GPIO5 pin'), body: t('The code makes it output 3.3 V (high) or 0 V (low)') },
  usb: { key: 'usb', target: { kind: 'part', id: 'board' }, title: t('USB-C port'), body: t('Goes to the computer: power + code download') },
  res: { key: 'res', target: { kind: 'part', id: 'led:5' }, title: t('220 Ω resistor'), body: t('Limits the current. Without it the LED may burn out') },
  led: { key: 'led', target: { kind: 'part', id: 'led:5' }, title: t('LED'), body: t('Long leg to positive; lights when current flows') },
  gnd: { key: 'gnd', target: { kind: 'pin', id: 'GND' }, title: t('GND (ground)'), body: t('Current flows back to the board here') },
};
const pick = (...k: string[]) => k.map((x) => CALLOUTS[x]);

export const LESSONS: Lesson[] = [
  {
    work: 'weather',
    checkpoint: '01',
    no: 1,
    title: t('Light up an LED'),
    summary: t('Make the external LED blink every half second.'),
    minutes: 8,
    buy: t('LED, 220 Ω resistor'),
    fw: 's3-blink',
    src: 'firmware/blink/main/main.c',
    steps: [
      {
        id: 'board',
        title: t('Meet the dev board'),
        sub: t('Chip, USB port, pins'),
        body: t('This is the ESP32-S3 dev board. It straddles the groove in the middle of the breadboard, and each pin connects to the column of holes beside it. This lesson only uses two pins: GPIO5 and GND.'),
        tasks: [t('Click the chip and see how many pins it has'), t('Rotate the view and find the USB-C port')],
        callouts: pick('chip', 'usb', 'gpio'),
      },
      {
        id: 'parts',
        title: t('Place the LED and resistor'),
        sub: t('The long leg is positive'),
        body: t('An LED only conducts one way: the long leg (positive) faces the resistor, the short leg faces GND. The resistor holds back extra current. 220 Ω makes the LED bright enough without burning it out.'),
        tasks: [t('Click the LED to change its colour'), t('Switch the resistor to 1 kΩ and see if it gets dimmer')],
        callouts: pick('led', 'res'),
      },
      {
        id: 'loop',
        title: t('Close the loop'),
        sub: t('GPIO5 → resistor → LED → GND'),
        body: t('Two jumper wires close the circuit into a loop: GPIO5 → resistor → LED → GND. The LED only lights when current can go all the way round. Turn on "Show current" to see the path.'),
        tasks: [t('Turn on "Show current"'), t('Pull out the black wire and see what happens to the current')],
        callouts: pick('gpio', 'res', 'gnd'),
        codeLines: [18],
      },
      {
        id: 'run',
        title: t('Run the code'),
        sub: t('Flips every 0.5 s'),
        body: t('Click "Run": every 0.5 s the code switches GPIO5 between high and low, and the LED blinks along. The highlighted line is the one that just ran.'),
        tasks: [t('Click "Run"'), t('Check: every blink matches one gpio_set_level call')],
        callouts: pick('gpio', 'led'),
        codeLines: [22],
      },
      {
        id: 'tweak',
        title: t('Change it'),
        sub: t('Make it blink faster'),
        body: t('Change the delay from 500 to 100 and the LED blinks faster. Change one number, see the result right away: that is how you will work on your own projects too.'),
        tasks: [t('Change 500 to 100'), t('Try 1000 and watch again')],
        callouts: pick('led'),
        codeLines: [25],
        codeChips: { line: 25, values: [100, 500, 1000], current: 500 },
      },
    ],
  },
];

/** The lesson for this work's checkpoint, if one is written. */
export function lessonFor(work: string, checkpoint: string | undefined): Lesson | null {
  return LESSONS.find((l) => l.work === work && l.checkpoint === checkpoint) ?? null;
}
