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
/** H-03: how one pin's edges read in "What happened" and which source line they point at. */
export interface LessonEvent {
  pin: number;
  /** Plain words for high / low, e.g. "LED on" / "LED off". */
  hi: string;
  lo: string;
  /** 1-based line in `Lesson.src` that drives the pin (input pins: the line that reacts to it). */
  line: number;
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
}

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
        tasks: [t('Turn on "Show current"'), t('While it runs, watch the current: why does the dashed line vanish when the LED is off?')],
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
    fw: 's3-button',
    src: 'firmware/button/main/main.c',
    events: [
      { pin: 0, hi: t('BOOT released'), lo: t('BOOT pressed'), line: 20, input: true },
      { pin: 5, hi: t('LED on'), lo: t('LED off'), line: 46 },
    ],
    circuit: { pin: 5, path: ['wire:GPIO5~led:5:IN', 'led:5', 'wire:GND~led:5:GND'] },
    steps: [
      {
        id: 'boot',
        title: t('Meet the BOOT button'),
        sub: t('A button already on the board'),
        body: t('The small BOOT button sits on the dev board, so this lesson needs no new parts. It is wired to GPIO0: the pin reads high (3.3 V) and drops to low (0 V) while you hold the button. The LED from lesson 1 stays on GPIO5.'),
        tasks: [t('Find the button labelled BOOT on the board'), t('Click it: it is a real button on the bench')],
        callouts: pick('boot', 'led'),
      },
      {
        id: 'inout',
        title: t('Input vs output'),
        sub: t('GPIO0 reads, GPIO5 drives'),
        body: t('An output pin is set by the code: GPIO5 pushes 3.3 V into the LED. An input pin is read by the code: GPIO0 only reports whether the button pulls it down to 0 V. The highlighted lines make GPIO5 an output and GPIO0 an input with a pull-up that keeps it high until pressed.'),
        tasks: [t('Find GPIO_MODE_OUTPUT and GPIO_MODE_INPUT in the code'), t('Think: why does GPIO0 read high when nobody presses?')],
        callouts: pick('boot', 'gpio'),
        codeLines: [26, 30],
      },
      {
        id: 'code',
        title: t('The lines that read the button'),
        sub: t('An interrupt, not constant checking'),
        body: t('The code does not check the button over and over. It asks the chip to call a small function, on_press, the moment GPIO0 falls from high to low: that is an interrupt. on_press only drops the time into a queue, and the main loop picks it up and flips the LED.'),
        tasks: [t('Find GPIO_INTR_NEGEDGE: "negative edge" means high to low'), t('Find on_press: the function the interrupt calls')],
        callouts: pick('boot'),
        codeLines: [32, 36],
      },
      {
        id: 'run',
        title: t('Run and press BOOT'),
        sub: t('One press, one flip'),
        body: t('Click "Run", then press BOOT. Each press should flip the LED once, and "What happened" lists the press and the LED change one after the other. Letting go of the button must not flip it again.'),
        tasks: [t('Click "Run"'), t('Press BOOT three times and count the LED flips')],
        callouts: pick('boot', 'led'),
        codeLines: [46],
      },
      {
        id: 'tweak',
        title: t('Think about it'),
        sub: t('Why wait 50 ms?'),
        body: t('A real button bounces: one press can touch and let go several times within a few milliseconds. The highlighted line ignores any press that comes less than 50 ms after the last one, which is called debouncing. Without it, one press could flip the LED two or three times.'),
        tasks: [t('Find 50000 in the code (microseconds, so 50 ms)'), t('Think: what if the wait were 500 ms and you pressed twice quickly?')],
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
    fw: 's3-oled',
    src: 'firmware/oled/main/main.c',
    i2c: [{ addr: 0x3c, text: t('Screen updated: {n} bytes sent'), line: 69 }],
    steps: [
      {
        id: 'oled',
        title: t('Meet the OLED and I2C'),
        sub: t('Two wires: SDA and SCL'),
        body: t('The OLED is a screen of 128 × 64 dots that each light up on their own. It talks to the board over I2C, which needs only two signal wires: SDA (data) on GPIO8 and SCL (clock) on GPIO9. With power and GND that makes four wires.'),
        tasks: [t('Follow the SDA and SCL wires from the screen to the board'), t('Click the screen to see its specs')],
        callouts: pick('oled', 'sda', 'scl'),
        codeLines: [31, 32],
      },
      {
        id: 'addr',
        title: t('Address 0x3C'),
        sub: t('Each I2C part has a number'),
        body: t('Several parts can share the same two I2C wires, so each one has an address. This screen answers to 0x3C, and every message the code sends to it starts with that number. At start-up the code also asks every address in turn and prints the ones that answer.'),
        tasks: [t('Find OLED_ADDR in the code'), t('Think: what would happen if the code used 0x3D?')],
        callouts: pick('oled', 'sda'),
        codeLines: [24, 51],
      },
      {
        id: 'fb',
        title: t('Frame buffer and refresh'),
        sub: t('Draw in memory, then send'),
        body: t('The code first draws the text into a block of memory called the frame buffer: 1024 bytes, one bit per dot. Then flush() sends the whole buffer to the screen in one go. Nothing on the screen changes until that flush.'),
        tasks: [t('Find the text() lines: they only draw into memory'), t('Find flush(): the line that really talks to the screen')],
        callouts: pick('oled'),
        codeLines: [60, 62, 69],
      },
      {
        id: 'run',
        title: t('Run and watch the screen'),
        sub: t('One refresh per second'),
        body: t('Click "Run" and the screen shows TryBoard and a progress bar. Every second the code redraws and sends about 1 KB to 0x3C, and "What happened" shows each send as one row. The bar growing one step per second tells you the refreshes arrive.'),
        tasks: [t('Click "Run"'), t('Check: one "Screen updated" row per second')],
        callouts: pick('oled', 'sda', 'scl'),
        codeLines: [69],
      },
      {
        id: 'tweak',
        title: t('Change it'),
        sub: t('Your own words'),
        body: t('The highlighted line writes "TryBoard" at size 2, where each letter is 12 dots wide. Put your own word there and it shows after the next flush. Keep it to 10 letters so it fits across 128 dots.'),
        tasks: [t('Pick a word of 10 letters or fewer to show'), t('Think: how many letters fit on one line at size 1 (6 dots each)?')],
        callouts: pick('oled'),
        codeLines: [62],
      },
    ],
  },
];

/** The lesson for this work's checkpoint, if one is written. */
export function lessonFor(work: string, checkpoint: string | undefined): Lesson | null {
  return LESSONS.find((l) => l.work === work && l.checkpoint === checkpoint) ?? null;
}
