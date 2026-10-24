// Beginner lessons (PLAN H): five short steps per checkpoint, shown on the bench while beginner mode is on.
// Text is English through t() (zh / ja / ko in i18n lab.ts); code lines point at the checkpoint's reference source.
import { t } from '../i18n/index.ts';

/** A bench thing a callout points at: same shape as PickTarget (part / pin / wire / button + id). */
export interface LessonTarget {
  kind: 'part' | 'pin' | 'wire' | 'button';
  id: string;
  /** A named spot on it (PickTarget.anchor): board 'usb', LED part 'res' / 'led', wire '0' = board end. */
  anchor?: string;
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
  /** Prebuilt firmware per value (the web page cannot compile yet). */
  fw: Record<number, string>;
}
/** H-05 "Show me how": one beat of the scripted demo; it only draws over the bench, never changes its wiring. */
export interface DemoBeat {
  /** Short label under the progress bar. */
  short: string;
  title: string;
  body: string;
  /** Where the camera eases to; everything else dims. */
  focus: LessonTarget;
  /** Drag animation from pin `from` to pin `to` (bench wire `wire:<board pin>~<part pin>`, either order). */
  wire?: { from: string; to: string; color: string };
  /** Turn on "Show current" for this beat. */
  flow?: boolean;
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
  demo?: DemoBeat[];
}
/** H-03: how one pin's edges read in "What happened" and which source line they point at. */
export interface LessonEvent {
  pin: number;
  /** Plain words for high / low, e.g. "LED on" / "LED off". */
  hi: string;
  lo: string;
  /** 1-based line in `Lesson.src` that drives the pin. */
  line: number;
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
  /** Pin events the "What happened" feed narrates (H-03). */
  events?: LessonEvent[];
  steps: LessonStep[];
  /** H-04 "Show current": the loop drawn while `pin` is high (bench wire / part / pin ids, in current order). */
  circuit?: { pin: number; path: string[] };
}

const CALLOUTS: Record<string, LessonCallout> = {
  chip: { key: 'chip', target: { kind: 'part', id: 'board' }, title: t('ESP32-S3 chip'), body: t('The code you write runs here') },
  gpio: { key: 'gpio', target: { kind: 'pin', id: 'GPIO5' }, title: t('GPIO5 pin'), body: t('The code makes it output 3.3 V (high) or 0 V (low)') },
  usb: { key: 'usb', target: { kind: 'part', id: 'board', anchor: 'usb' }, title: t('USB-C port'), body: t('Goes to the computer: power + code download') },
  res: { key: 'res', target: { kind: 'part', id: 'led:5', anchor: 'res' }, title: t('220 Ω resistor'), body: t('Limits the current. Without it the LED may burn out') },
  led: { key: 'led', target: { kind: 'part', id: 'led:5', anchor: 'led' }, title: t('LED'), body: t('Long leg to positive; lights when current flows') },
  gnd: { key: 'gnd', target: { kind: 'wire', id: 'wire:GND~led:5:GND', anchor: '0' }, title: t('GND (ground)'), body: t('Current flows back to the board here') },
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
    events: [{ pin: 5, hi: t('LED on'), lo: t('LED off'), line: 22 }],
    circuit: { pin: 5, path: ['wire:GPIO5~led:5:IN', 'led:5', 'wire:GND~led:5:GND'] },
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
        demo: [
          {
            short: t('Find GPIO5'),
            title: t('Find GPIO5'),
            body: t('GPIO5 is the pin the code switches on and off. Each pin on the board connects to the column of breadboard holes right beside it.'),
            focus: { kind: 'pin', id: 'GPIO5' },
          },
          {
            short: t('Orange wire to resistor'),
            title: t("Orange wire: from GPIO5 to the resistor's left leg"),
            body: t("The 5 holes in one breadboard column are connected. So the wire doesn't have to touch the resistor: any hole in the same column as its left leg will do."),
            focus: { kind: 'wire', id: 'wire:GPIO5~led:5:IN' },
            wire: { from: 'GPIO5', to: 'led:5:IN', color: '#F08C2E' },
          },
          {
            short: t('Black wire to GND'),
            title: t("Black wire: from the LED's short leg back to GND"),
            body: t("The short leg is the LED's negative side. A black wire from its column back to a GND pin gives the current a way home to the board."),
            focus: { kind: 'wire', id: 'wire:GND~led:5:GND' },
            wire: { from: 'led:5:GND', to: 'GND', color: '#1E1E1E' },
          },
          {
            short: t('Current goes round'),
            title: t('Show current: one closed loop'),
            body: t('Now current can leave GPIO5, pass the resistor and the LED, and come back to GND. The blue dashes show that path; break it anywhere and the LED stays dark.'),
            focus: { kind: 'part', id: 'led:5' },
            flow: true,
          },
        ],
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
        codeChips: { line: 25, values: [100, 500, 1000], current: 500, fw: { 100: 's3-blink-100', 500: 's3-blink', 1000: 's3-blink-1000' } },
      },
    ],
  },
];

/** The lesson for this work's checkpoint, if one is written. */
export function lessonFor(work: string, checkpoint: string | undefined): Lesson | null {
  return LESSONS.find((l) => l.work === work && l.checkpoint === checkpoint) ?? null;
}
