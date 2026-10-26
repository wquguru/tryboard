// Beginner lessons (PLAN H): five short steps per checkpoint, shown on the bench while beginner mode is on.
// Text is English through t() (zh / ja / ko in i18n lab.ts); code lines point at the checkpoint's reference source.
import { t } from '../i18n/index.ts';
import { LED_VF, ledAmps, ohmText, type LedColor } from '../bench3d/ledparams.ts';
import { L7 } from './lessondata/l7.ts';
import { L5 } from './lessondata/l5.ts';
import { LESSON_0 } from './lessondata/l0.ts';
import { L11 } from './lessondata/l11.ts';

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
/** H-10: one "Try it" line; `done` is the signal that ticks it (lessontasks.ts parseDone). */
export interface LessonTask {
  text: string;
  /** One line of "how to do it" under the task while it waits. */
  how?: string;
  /** `run` | `reveal` | `view:current` | `select:<id>` | `prop:<part>.<key>=<v>` | `chip:delay=<ms>` | `press:boot×<n>` | `oled:<lit dots>` | `follow:temp` | `asm:done`. */
  done: string;
  /** reveal: the answer shown when the learner opens it. */
  answer?: string;
}
export interface LessonStep {
  id: string;
  title: string;
  /** One-line hint under the title in the step list. */
  sub: string;
  /** At most three sentences. */
  body: string;
  tasks: LessonTask[];
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
  /** 1-based line in `Lesson.src` that drives the pin (input pins: the line that reacts to it). */
  line: number;
  /** Line for the high edge when it differs (BOOT released: the loop waiting for the next press, not the ISR). */
  hiLine?: number;
  /** The pin is read, not driven (H-08 button). */
  input?: boolean;
}
/** H-08: writes to one I2C address read as one feed row; transactions closer than 100 ms add to the same row. */
export interface LessonI2c {
  addr: number;
  /** Row text with {n} = bytes written, e.g. "Screen updated: {n} bytes". */
  text: string;
  /** 1-based line in `Lesson.src` that sends the bytes. */
  line: number;
}
/** H-14 "Code explained": one line of `Lesson.src` in plain words. */
export interface LessonCodeNote {
  line: number;
  text: string;
}
/** H-14: where a parameter comes from (the chip shown next to it). */
export type ParamSource = 'bench' | 'code' | 'datasheet' | 'typical' | 'estimate';
export interface LessonParam {
  label: string;
  value: string;
  source: ParamSource;
  /** datasheet: which document (no page numbers). */
  doc?: string;
  /** Recomputed from the bench LED, which the H-13 part card can change. */
  live?: 'led-ohm' | 'led-vf' | 'led-ma';
}
/** H-14 wiring tab: beginner words for one wiring.ts row (key = BenchWire.id); `{ohm}` = the row's resistor. */
export interface LessonWireNote {
  to: string;
  why: string;
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
  /** I2C writes the feed narrates (H-08). */
  i2c?: LessonI2c[];
  steps: LessonStep[];
  /** H-04 "Show current": the loop drawn while `pin` is high (bench wire / part / pin ids, in current order). */
  circuit?: { pin: number; path: string[] };
  /** H-09: part ids (wiring.ts partId) the bench draws while this lesson is up; missing = the work's full set. Sim devices are untouched. */
  parts?: string[];
  /** H-14 tabs: explained source lines, parameters with sources, words for wiring rows, a shopping tip. */
  code?: LessonCodeNote[];
  params?: LessonParam[];
  wireNotes?: Record<string, LessonWireNote>;
  buyTip?: string;
  /** H-16 capstone: the parameters tab also lists every written course lesson's parts and buy tip, with a link to the Shop step. */
  buyAll?: boolean;
}

const COLOR_NAME: Record<LedColor, string> = { red: t('Red'), green: t('Green'), blue: t('Blue') };
/** H-14: a live LED parameter for the LED on the bench (same model as the H-13 card: elec::fault::led). */
export function ledParamValue(live: NonNullable<LessonParam['live']>, ohm: number, color: LedColor): string {
  const vf = LED_VF[color];
  if (live === 'led-ohm') return ohm > 0 ? `${ohmText(ohm)} Ω` : t('None (removed)');
  if (live === 'led-vf') return t('{color} LED, about {v} V', { color: COLOR_NAME[color], v: vf.toFixed(1) });
  // 43 Ω = the pin's output resistance (33) + the diode's slope (10), as in ledparams.ledAmps
  return `(3.3 − ${vf.toFixed(1)}) ÷ (${ohm} + 43 Ω) ≈ ${(ledAmps(ohm, vf) * 1000).toFixed(1)} mA`;
}

const LED_WIRES: Record<string, LessonWireNote> = {
  'wire:GPIO5~led:5:IN': { to: t('{ohm} Ω resistor → LED long leg'), why: t('The code switches it between high (3.3 V) and low (0 V)') },
  'wire:GND~led:5:GND': { to: t('LED short leg'), why: t('Current flows back to the board here, closing the loop') },
};
const DS_S3 = t('ESP32-S3 datasheet');
const LED_PARAMS = (): LessonParam[] => [
  { label: t('LED'), value: ledParamValue('led-vf', 220, 'red'), source: 'typical', live: 'led-vf' },
  { label: t('Resistor'), value: ledParamValue('led-ohm', 220, 'red'), source: 'bench', live: 'led-ohm' },
  { label: t('LED current'), value: ledParamValue('led-ma', 220, 'red'), source: 'estimate', live: 'led-ma' },
];

const CALLOUTS: Record<string, LessonCallout> = {
  chip: { key: 'chip', target: { kind: 'part', id: 'board' }, title: t('ESP32-S3 chip'), body: t('The code you write runs here') },
  gpio: { key: 'gpio', target: { kind: 'pin', id: 'GPIO5' }, title: t('GPIO5 pin'), body: t('The code makes it output 3.3 V (high) or 0 V (low)') },
  usb: { key: 'usb', target: { kind: 'part', id: 'board', anchor: 'usb' }, title: t('USB-C port'), body: t('Goes to the computer: power + code download') },
  res: { key: 'res', target: { kind: 'part', id: 'led:5', anchor: 'res' }, title: t('220 Ω resistor'), body: t('Limits the current. Without it the LED may burn out') },
  led: { key: 'led', target: { kind: 'part', id: 'led:5', anchor: 'led' }, title: t('LED'), body: t('Long leg to positive; lights when current flows') },
  gnd: { key: 'gnd', target: { kind: 'wire', id: 'wire:GND~led:5:GND', anchor: '0' }, title: t('GND (ground)'), body: t('Current flows back to the board here') },
  boot: { key: 'boot', target: { kind: 'button', id: 'BOOT' }, title: t('BOOT button'), body: t('Wired to GPIO0: reads low (0 V) while pressed') },
  oled: { key: 'oled', target: { kind: 'part', id: 'oled' }, title: t('0.96″ OLED screen'), body: t('128 × 64 dots; the code tells it which dots to light') },
  sda: { key: 'sda', target: { kind: 'pin', id: 'GPIO8' }, title: t('SDA = GPIO8'), body: t('Data wire: carries the bytes, one bit at a time') },
  scl: { key: 'scl', target: { kind: 'pin', id: 'GPIO9' }, title: t('SCL = GPIO9'), body: t('Clock wire: one tick per bit') },
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
    parts: ['led:5'],
    fw: 's3-blink',
    src: 'firmware/blink/main/main.c',
    wireNotes: LED_WIRES,
    code: [
      { line: 8, text: t('Half a second between changes; the delay chips in step 5 swap in builds with 100 or 1000') },
      { line: 17, text: t('Put GPIO5 back to a plain pin, whatever it did before') },
      { line: 18, text: t('Make GPIO5 an output: from now on the code decides its level') },
      { line: 21, text: t('Flip the remembered state: 1 becomes 0, 0 becomes 1') },
      { line: 22, text: t('Drive the pin: 1 = 3.3 V (LED on), 0 = 0 V (LED off)') },
      { line: 23, text: t('Print a line in the serial log so you can follow along') },
      { line: 25, text: t('Wait BLINK_MS, then go round the loop again') },
    ],
    params: [
      ...LED_PARAMS(),
      { label: t('What a GPIO can supply'), value: t('About 20 mA at the default drive strength'), source: 'datasheet', doc: DS_S3 },
      { label: t('GPIO high level'), value: '3.3 V', source: 'datasheet', doc: DS_S3 },
      { label: t('Blink interval'), value: '500 ms', source: 'code' },
    ],
    buyTip: t('When buying: anything from 220 Ω to 1 kΩ works, more resistance means a dimmer LED. A bag of 5 mm LEDs and a box of resistors covers the first lessons.'),
    events: [{ pin: 5, hi: t('LED on'), lo: t('LED off'), line: 22 }],
    circuit: { pin: 5, path: ['wire:GPIO5~led:5:IN', 'led:5', 'wire:GND~led:5:GND'] },
    steps: [
      {
        id: 'board',
        title: t('Meet the dev board'),
        sub: t('Chip, USB port, pins'),
        body: t('This is the ESP32-S3 dev board. It straddles the groove in the middle of the breadboard, and each pin connects to the column of holes beside it. This lesson only uses two pins: GPIO5 and GND.'),
        tasks: [
          { text: t('Click the chip and see how many pins it has'), done: 'select:board', how: t('Click the dev board on the bench: its card lists the pins') },
          { text: t('Rotate the view and find the USB-C port'), done: 'reveal', answer: t('At one short end of the board, where the "USB-C port" card points. It brings power and code from the computer.') },
        ],
        callouts: pick('chip', 'usb', 'gpio'),
      },
      {
        id: 'parts',
        title: t('Place the LED and resistor'),
        sub: t('The long leg is positive'),
        body: t('An LED only conducts one way: the long leg (positive) faces the resistor, the short leg faces GND. The resistor holds back extra current. 220 Ω makes the LED bright enough without burning it out.'),
        tasks: [
          { text: t('Click the LED to change its colour'), done: 'select:led:5', how: t('Click the LED on the breadboard') },
          { text: t('Switch the resistor to 1 kΩ and see if it gets dimmer'), done: 'prop:led:5.ohm=1000', how: t('Click the LED, then pick 1k Ω under Series resistor in its card') },
        ],
        callouts: pick('led', 'res'),
      },
      {
        id: 'loop',
        title: t('Close the loop'),
        sub: t('GPIO5 → resistor → LED → GND'),
        body: t('Two jumper wires close the circuit into a loop: GPIO5 → resistor → LED → GND. The LED only lights when current can go all the way round. Turn on "Show current" to see the path.'),
        tasks: [
          { text: t('Turn on "Show current"'), done: 'view:current', how: t('The "Show current" switch in the toolbar') },
          { text: t('While it runs, watch the current: why does the dashed line vanish when the LED is off?'), done: 'reveal', answer: t('GPIO5 goes low (0 V): both ends of the loop are at the same voltage, so no current flows.') },
        ],
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
        tasks: [
          { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
          { text: t('Check: every blink matches one gpio_set_level call'), done: 'reveal', answer: t('Yes: each "LED on" / "LED off" row in What happened points at line 22, the gpio_set_level call.') },
        ],
        callouts: pick('gpio', 'led'),
        codeLines: [22],
      },
      {
        id: 'tweak',
        title: t('Change it'),
        sub: t('Make it blink faster'),
        body: t('Change the delay from 500 to 100 and the LED blinks faster. Change one number, see the result right away: that is how you will work on your own projects too.'),
        tasks: [
          { text: t('Change 500 to 100'), done: 'chip:delay=100', how: t('Click 100 in the highlighted code line') },
          { text: t('Try 1000 and watch again'), done: 'chip:delay=1000', how: t('Click 1000 in the highlighted code line') },
        ],
        callouts: pick('led'),
        codeLines: [25],
        codeChips: { line: 25, values: [100, 500, 1000], current: 500, fw: { 100: 's3-blink-100', 500: 's3-blink', 1000: 's3-blink-1000' } },
      },
    ],
  },
  {
    work: 'weather',
    checkpoint: '02',
    no: 2,
    title: t('Press to light up'),
    summary: t('Each press of the BOOT button turns the LED on or off.'),
    minutes: 8,
    buy: t('No new parts needed'),
    parts: ['led:5'],
    fw: 's3-button',
    src: 'firmware/button/main/main.c',
    wireNotes: LED_WIRES,
    code: [
      { line: 17, text: t('Runs the moment the button pulls GPIO0 low (an interrupt)') },
      { line: 20, text: t('Hand the press time to the main loop; an interrupt must stay short') },
      { line: 26, text: t('GPIO5 is an output for the LED, as in lesson 1') },
      { line: 31, text: t('The internal pull-up keeps GPIO0 high until the button is pressed') },
      { line: 32, text: t('Fire on the falling edge: high to low is the moment of the press') },
      { line: 36, text: t('Connect GPIO0 to on_press') },
      { line: 42, text: t('Sleep until a press arrives, using no CPU meanwhile') },
      { line: 43, text: t('Ignore presses closer than 50 ms: one press bounces several times') },
      { line: 46, text: t('Toggle the LED') },
    ],
    params: [
      { label: t('BOOT button'), value: t('GPIO0, low while pressed'), source: 'bench' },
      { label: t('Internal pull-up'), value: t('About 45 kΩ'), source: 'datasheet', doc: DS_S3 },
      { label: t('How long a button bounces'), value: t('A few milliseconds'), source: 'typical' },
      { label: t('Debounce window'), value: '50 ms', source: 'code' },
      ...LED_PARAMS().slice(1),
    ],
    buyTip: t('When buying: nothing new, the BOOT button is on the dev board. A 6 × 6 mm tactile button on any free GPIO works the same way.'),
    events: [
      { pin: 0, hi: t('BOOT released'), lo: t('BOOT pressed'), line: 20, hiLine: 42, input: true },
      { pin: 5, hi: t('LED on'), lo: t('LED off'), line: 46 },
    ],
    circuit: { pin: 5, path: ['wire:GPIO5~led:5:IN', 'led:5', 'wire:GND~led:5:GND'] },
    steps: [
      {
        id: 'boot',
        title: t('Meet the BOOT button'),
        sub: t('A button already on the board'),
        body: t('The small BOOT button sits on the dev board, so this lesson needs no new parts. It is wired to GPIO0: the pin reads high (3.3 V) and drops to low (0 V) while you hold the button. The LED from lesson 1 stays on GPIO5.'),
        tasks: [
          { text: t('Find the button labelled BOOT on the board'), done: 'reveal', answer: t('Follow the "BOOT button" card: the small button marked BOOT. Its neighbour RST restarts the chip.') },
          { text: t('Click it: it is a real button on the bench'), done: 'press:boot×1', how: t('Click BOOT on the board, or the Button tool') },
        ],
        callouts: pick('boot', 'led'),
      },
      {
        id: 'inout',
        title: t('Input vs output'),
        sub: t('GPIO0 reads, GPIO5 drives'),
        body: t('An output pin is set by the code: GPIO5 pushes 3.3 V into the LED. An input pin is read by the code: GPIO0 only reports whether the button pulls it down to 0 V. The highlighted lines make GPIO5 an output and GPIO0 an input with a pull-up that keeps it high until pressed.'),
        tasks: [
          { text: t('Find GPIO_MODE_OUTPUT and GPIO_MODE_INPUT in the code'), done: 'reveal', answer: t('Line 26 makes GPIO5 (the LED) an output; line 30 makes GPIO0 (BOOT) an input.') },
          { text: t('Think: why does GPIO0 read high when nobody presses?'), done: 'reveal', answer: t('Line 31 turns on the pull-up: a weak resistor holds GPIO0 at 3.3 V until the button connects it to GND.') },
        ],
        callouts: pick('boot', 'gpio'),
        codeLines: [26, 30],
      },
      {
        id: 'code',
        title: t('The lines that read the button'),
        sub: t('An interrupt, not constant checking'),
        body: t('The code does not check the button over and over. It asks the chip to call a small function, on_press, the moment GPIO0 falls from high to low: that is an interrupt. on_press only drops the time into a queue, and the main loop picks it up and flips the LED.'),
        tasks: [
          { text: t('Find GPIO_INTR_NEGEDGE: "negative edge" means high to low'), done: 'reveal', answer: t('Line 32: the interrupt fires the moment GPIO0 falls from high to low, that is, when you press.') },
          { text: t('Find on_press: the function the interrupt calls'), done: 'reveal', answer: t('Line 17 defines it; line 36 hooks it to GPIO0 with gpio_isr_handler_add.') },
        ],
        callouts: pick('boot'),
        codeLines: [32, 36],
      },
      {
        id: 'run',
        title: t('Run and press BOOT'),
        sub: t('One press, one flip'),
        body: t('Click "Run", then press BOOT. Each press should flip the LED once, and "What happened" lists the press and the LED change one after the other. Letting go of the button must not flip it again.'),
        tasks: [
          { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
          { text: t('Press BOOT three times and count the LED flips'), done: 'press:boot×3', how: t('Click BOOT on the board, or the Button tool') },
        ],
        callouts: pick('boot', 'led'),
        codeLines: [46],
      },
      {
        id: 'tweak',
        title: t('Think about it'),
        sub: t('Why wait 50 ms?'),
        body: t('A real button bounces: one press can touch and let go several times within a few milliseconds. The highlighted line ignores any press that comes less than 50 ms after the last one, which is called debouncing. Without it, one press could flip the LED two or three times.'),
        tasks: [
          { text: t('Find 50000 in the code (microseconds, so 50 ms)'), done: 'reveal', answer: t('Line 43: a press closer than 50 ms to the last one is ignored, so one bouncy press counts once.') },
          { text: t('Think: what if the wait were 500 ms and you pressed twice quickly?'), done: 'reveal', answer: t('The second press lands inside the 500 ms window and is ignored: the LED flips only once.') },
        ],
        callouts: pick('boot', 'led'),
        codeLines: [43],
      },
    ],
  },
  {
    work: 'weather',
    checkpoint: '03',
    no: 3,
    title: t('Write on a small screen'),
    summary: t('Draw text on the OLED screen over two I2C wires.'),
    minutes: 10,
    buy: t('0.96″ OLED screen (SSD1306, I2C)'),
    parts: ['led:5', 'oled'],
    fw: 's3-oled',
    src: 'firmware/oled/main/main.c',
    wireNotes: {
      ...LED_WIRES,
      'wire:GND~oled:GND': { to: t('Screen GND'), why: t('Shared ground for the screen') },
      'wire:3V3~oled:VCC': { to: t('Screen VCC'), why: t("Powers the screen from the board's 3.3 V") },
      'wire:GPIO9~oled:SCL': { to: t('Screen SCL'), why: t('Clock wire: one tick per bit') },
      'wire:GPIO8~oled:SDA': { to: t('Screen SDA'), why: t('Data wire: carries the bytes, one bit at a time') },
    },
    code: [
      { line: 31, text: t('SDA pin: this lesson builds with GPIO8 (the default 6 is for the C3 board)') },
      { line: 32, text: t('SCL pin: this lesson builds with GPIO9') },
      { line: 35, text: t("I2C lines need pull-ups: the chip's internal ones are switched on; most modules add their own too") },
      { line: 51, text: t('0x3C: the address this screen answers to') },
      { line: 52, text: t('400 kHz: 400 000 clock ticks per second on SCL') },
      { line: 56, text: t('Wake the screen up and set it to 128 × 64') },
      { line: 60, text: t('Clear the picture in memory: 1024 bytes, one bit per dot') },
      { line: 62, text: t('Draw "TryBoard" into memory at double size; nothing is sent yet') },
      { line: 69, text: t('Send the whole picture over I2C; only now does the screen change') },
      { line: 73, text: t('Wait a second, then draw the next frame') },
    ],
    params: [
      { label: t('Screen'), value: t('128 × 64 dots, 1 bit each'), source: 'datasheet', doc: t('SSD1306 datasheet') },
      { label: t('I2C address'), value: '0x3C', source: 'bench' },
      { label: t('I2C pins'), value: 'SDA GPIO8 · SCL GPIO9', source: 'bench' },
      { label: t('I2C clock'), value: '400 kHz', source: 'code' },
      { label: t('One full screen'), value: '128 × 64 ÷ 8 = 1024 B', source: 'code' },
      { label: t('Screen supply'), value: '3.3 V', source: 'bench' },
    ],
    buyTip: t('When buying: get the 4-pin I2C version (GND VCC SCL SDA), not the 7-pin SPI one, and check the pin order printed on the module: it differs between sellers.'),
    i2c: [{ addr: 0x3c, text: t('Screen updated: {n} bytes sent'), line: 69 }],
    steps: [
      {
        id: 'oled',
        title: t('Meet the OLED and I2C'),
        sub: t('Two wires: SDA and SCL'),
        body: t('The OLED is a screen of 128 × 64 dots that each light up on their own. It talks to the board over I2C, which needs only two signal wires: SDA (data) on GPIO8 and SCL (clock) on GPIO9. With power and GND that makes four wires.'),
        tasks: [
          { text: t('Follow the SDA and SCL wires from the screen to the board'), done: 'reveal', answer: t('SDA goes to GPIO8 and SCL to GPIO9: the two cards on the board pins mark them.') },
          { text: t('Click the screen to see its specs'), done: 'select:oled', how: t('Click the OLED screen on the breadboard') },
        ],
        callouts: pick('oled', 'sda', 'scl'),
        codeLines: [31, 32],
      },
      {
        id: 'addr',
        title: t('Address 0x3C'),
        sub: t('Each I2C part has a number'),
        body: t('Several parts can share the same two I2C wires, so each one has an address. This screen answers to 0x3C, and every message the code sends to it starts with that number. At start-up the code also asks every address in turn and prints the ones that answer.'),
        tasks: [
          { text: t('Find OLED_ADDR in the code'), done: 'reveal', answer: t('Line 24 defines it as 0x3C; line 51 hands it to the I2C driver.') },
          { text: t('Think: what would happen if the code used 0x3D?'), done: 'reveal', answer: t('Nothing answers at 0x3D: the write gets no ACK, flush() returns an error and the screen stays dark.') },
        ],
        callouts: pick('oled', 'sda'),
        codeLines: [24, 51],
      },
      {
        id: 'fb',
        title: t('Frame buffer and refresh'),
        sub: t('Draw in memory, then send'),
        body: t('The code first draws the text into a block of memory called the frame buffer: 1024 bytes, one bit per dot. Then flush() sends the whole buffer to the screen in one go. Nothing on the screen changes until that flush.'),
        tasks: [
          { text: t('Find the text() lines: they only draw into memory'), done: 'reveal', answer: t('Lines 62 to 64 draw into a 1 KB buffer in memory; nothing is sent to the screen yet.') },
          { text: t('Find flush(): the line that really talks to the screen'), done: 'reveal', answer: t('Line 69: flush() sends the whole buffer over I2C in one go.') },
        ],
        callouts: pick('oled'),
        codeLines: [60, 62, 69],
      },
      {
        id: 'run',
        title: t('Run and watch the screen'),
        sub: t('One refresh per second'),
        body: t('Click "Run" and the screen shows TryBoard and a progress bar. Every second the code redraws and sends about 1 KB to 0x3C, and "What happened" shows each send as one row. The bar growing one step per second tells you the refreshes arrive.'),
        tasks: [
          { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
          { text: t('Check: one "Screen updated" row per second'), done: 'reveal', answer: t('Yes: the loop redraws, calls flush() and waits 1000 ms (line 73), so each row is one refresh.') },
        ],
        callouts: pick('oled', 'sda', 'scl'),
        codeLines: [69],
      },
      {
        id: 'tweak',
        title: t('Change it'),
        sub: t('Your own words'),
        body: t('The highlighted line writes "TryBoard" at size 2, where each letter is 12 dots wide. Put your own word there and it shows after the next flush. Keep it to 10 letters so it fits across 128 dots.'),
        tasks: [
          { text: t('Pick a word of 10 letters or fewer to show'), done: 'reveal', answer: t('At size 2 each letter is 12 dots wide, so 10 letters use 120 of the 128 dots.') },
          { text: t('Think: how many letters fit on one line at size 1 (6 dots each)?'), done: 'reveal', answer: t('128 ÷ 6 = 21 letters, with 2 dots to spare.') },
        ],
        callouts: pick('oled'),
        codeLines: [62],
      },
    ],
  },
  L7,
  L5,
  LESSON_0,
  L11,
];

/** The lesson for this work's checkpoint, if one is written. */
export function lessonFor(work: string, checkpoint: string | undefined): Lesson | null {
  return LESSONS.find((l) => l.work === work && l.checkpoint === checkpoint) ?? null;
}
