// Lesson 7 (PLAN H-16): turn an SG90 servo with 50 Hz LEDC pulses; checkpoint weather 05, reference build s3-servo.
// Lines point at firmware/servo/main/main.c (s3-servo builds it with SERVO_GPIO=4); the feed has no PWM rows yet.
import { t } from '../../i18n/index.ts';
import type { Lesson, LessonCallout } from '../lessons.ts';

const SIG = 'wire:GPIO4~servo:PWM';
const VCC = 'wire:5V~servo:VCC';
const GND = 'wire:GND~servo:GND';
const DS = t('SG90 datasheet');

const C: Record<string, LessonCallout> = {
  servo: { key: 'servo', target: { kind: 'part', id: 'servo' }, title: t('SG90 servo'), body: t('Motor, gears and a control board in one box; the arm on top shows the angle') },
  sig: { key: 'sig', target: { kind: 'wire', id: SIG }, title: t('Orange wire: signal'), body: t('Carries the angle command as pulses; almost no current') },
  vcc: { key: 'vcc', target: { kind: 'wire', id: VCC }, title: t('Red wire: 5 V power'), body: t('Feeds the motor; this is where the big current flows') },
  gnd: { key: 'gnd', target: { kind: 'wire', id: GND }, title: t('Brown wire: ground'), body: t('Black on the bench; must share GND with the board') },
  pin: { key: 'pin', target: { kind: 'pin', id: 'GPIO4' }, title: t('GPIO4: signal pin'), body: t('Sends one pulse every 20 ms; its width sets the angle') },
  v5: { key: 'v5', target: { kind: 'wire', id: VCC, anchor: '0' }, title: t('5V pin'), body: t('Straight from USB here; a real build uses its own 5 V supply') },
  g0: { key: 'g0', target: { kind: 'wire', id: GND, anchor: '0' }, title: t('GND (ground)'), body: t('Signal and power both need this shared return') },
};

export const L7: Lesson = {
  work: 'weather',
  checkpoint: '05',
  no: 7,
  title: t('Turn a servo'),
  summary: t('Swing an SG90 servo arm from 0° to 180° with 50 Hz pulses.'),
  minutes: 10,
  buy: t('SG90 servo (plus a 5 V supply for real builds)'),
  parts: ['servo'],
  fw: 's3-servo',
  src: 'firmware/servo/main/main.c',
  wireNotes: {
    [SIG]: { to: t('Servo orange wire (signal)'), why: t('GPIO4 sends the 50 Hz pulses; the pulse width is the angle') },
    [VCC]: { to: t('Servo red wire (VCC)'), why: t('The motor runs on 5 V and can pull about 0.7 A, far more than 3V3 or a GPIO can give') },
    [GND]: { to: t('Servo brown wire (GND)'), why: t('Shared ground: without it the servo cannot read the pulses') },
  },
  code: [
    { line: 13, text: t('Angle to pulse: 500 µs + angle × 2000 ÷ 180, so 0° = 500 µs and 180° = 2500 µs') },
    { line: 14, text: t('Pulse to duty: the 20 ms period is 16384 steps, so 1500 µs ≈ 1228 steps') },
    { line: 21, text: t('14-bit timer: each period is split into 16384 steps of about 1.2 µs') },
    { line: 23, text: t('50 Hz: one pulse every 20 ms, the rate hobby servos expect') },
    { line: 28, text: t('Signal pin: this lesson builds with GPIO4 (the default 6 is for the C3 board)') },
    { line: 32, text: t('Start in the middle (90°) before the loop takes over') },
    { line: 35, text: t('The stops the arm visits, in order') },
    { line: 38, text: t('Set the new pulse width for this angle') },
    { line: 39, text: t('Apply it: the next pulse already has the new width') },
    { line: 40, text: t('Print the angle and pulse width in the serial log') },
    { line: 41, text: t('Hold 0.4 s: an SG90 needs about 0.3 s to cross the full 180°') },
  ],
  params: [
    { label: t('Signal pin'), value: 'GPIO4', source: 'bench' },
    { label: t('PWM frequency'), value: t('50 Hz (one pulse every 20 ms)'), source: 'code' },
    { label: t('Pulse → angle in this code'), value: '0.5 ms = 0° · 1.5 ms = 90° · 2.5 ms = 180°', source: 'code' },
    { label: t('Pulse range in the datasheet'), value: t('About 1–2 ms for −90° to +90°'), source: 'datasheet', doc: DS },
    { label: t('Full 180° in practice'), value: t('About 0.5–2.5 ms; the ends vary from servo to servo'), source: 'typical' },
    { label: t('Duty resolution'), value: t('14 bit: 16384 steps per 20 ms'), source: 'code' },
    { label: t('Servo supply'), value: '4.8–5 V', source: 'datasheet', doc: DS },
    { label: t('Speed'), value: t('About 0.1 s per 60° at 4.8 V'), source: 'datasheet', doc: DS },
    { label: t('Torque'), value: t('About 1.8 kgf·cm at 4.8 V'), source: 'datasheet', doc: DS },
    { label: t('Servo current'), value: t('About 0.15 A turning freely, about 0.7 A when starting or blocked'), source: 'estimate' },
    { label: t('Power on this bench'), value: t('The board 5V pin, fed by USB'), source: 'bench' },
  ],
  buyTip: t('When buying: the SG90 is fine for dials and light loads; the MG90S has metal gears in the same size. For a real build add a separate 5 V supply of at least 1 A and join its ground to the board GND. Feeding the servo from a PC USB port is exactly what the fault level "Reboots when the servo moves" breaks.'),
  steps: [
    {
      id: 'servo',
      title: t('Meet the SG90 servo'),
      sub: t('A motor that holds an angle'),
      body: t("A servo is a small motor with gears and a control board inside. You don't tell it to spin; you tell it which angle to hold, from 0° to 180°, and it turns its arm there and stays. It has three wires: orange signal, red 5 V power and brown ground."),
      tasks: [
        { text: t('Click the servo to see its specs'), done: 'select:servo', how: t('Click the blue servo on the bench') },
        { text: t('Which of the three wires carries the angle?'), done: 'reveal', answer: t('The orange one, on GPIO4. Red and brown only bring power; the angle is in the pulses on orange.') },
      ],
      callouts: [C.servo, C.sig, C.vcc, C.gnd],
      codeLines: [28],
    },
    {
      id: 'power',
      title: t('Signal on GPIO4, power on 5V'),
      sub: t('Why the servo gets its own supply'),
      body: t('The orange wire goes to GPIO4, which only sends the angle command and carries almost no current. The red wire goes to 5V, not 3V3: the motor needs about 5 V and can pull around 0.7 A when it starts or is blocked, far more than a pin or the 3.3 V regulator can give. On a real build give the servo its own 5 V supply and join the grounds, or the board voltage dips every time the arm moves and the chip resets.'),
      tasks: [
        { text: t('Click the GPIO4 pin'), done: 'select:GPIO4', how: t('Click the pin where the orange wire lands on the board') },
        { text: t('Think: why does the ground still have to be shared with a separate supply?'), done: 'reveal', answer: t('A pulse is "high" only compared with ground. With two grounds that are not joined, the servo cannot tell high from low and ignores the signal.') },
      ],
      callouts: [C.pin, C.v5, C.g0],
      codeLines: [28],
    },
    {
      id: 'pulse',
      title: t('Angle = pulse width'),
      sub: t('50 Hz, 0.5–2.5 ms'),
      body: t('Every 20 ms (50 times a second) GPIO4 sends one high pulse, and the servo reads the angle from how long the pulse stays high. In this code 0.5 ms means 0°, 1.5 ms means 90° and 2.5 ms means 180°, in a straight line. The chip\'s LEDC timer repeats the pulse by itself, so the code only sets a new width once per angle.'),
      tasks: [
        { text: t('Work out the pulse width for 45°'), done: 'reveal', answer: t('Line 13: 500 + 45 × 2000 ÷ 180 = 1000 µs, so 1.0 ms.') },
        { text: t('Find the 50 in the code'), done: 'reveal', answer: t('Line 23: freq_hz = 50, one pulse every 20 ms. Line 14 turns the pulse in µs into a share of those 20 ms.') },
      ],
      callouts: [C.pin, C.servo],
      codeLines: [13, 14, 23],
    },
    {
      id: 'run',
      title: t('Run and watch the arm'),
      sub: t('0° → 45° → 90° → 135° → 180°'),
      body: t('Click "Run": the arm steps to 0°, 45°, 90°, 135°, 180° and back to 90°, holding each angle for 0.4 s, then repeats. The serial log prints every angle with its pulse width. The checkpoint passes when GPIO4 runs at 50 Hz and the pulse goes through 0.5, 1.0, 1.5, 2.0 and 2.5 ms in order.'),
      tasks: [
        { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
        { text: t('Check the serial log: which pulse width goes with 135°?'), done: 'reveal', answer: t('2000 µs (2.0 ms): 500 + 135 × 2000 ÷ 180.') },
      ],
      callouts: [C.servo, C.sig],
      codeLines: [38, 39, 41],
    },
    {
      id: 'tweak',
      title: t('Change it'),
      sub: t('Your own angles'),
      body: t('The highlighted line lists the stops the arm visits. Change them to just 0 and 180 and the arm swings end to end; a longer delay makes it rest longer at each stop. If a real servo buzzes at 0° or 180°, its end stops sit a little inside the range, so try 10° and 170°.'),
      tasks: [
        { text: t('Think: what pulse would 200° ask for?'), done: 'reveal', answer: t('500 + 200 × 2000 ÷ 180 ≈ 2722 µs. That is past the end stop: the arm pushes against it, hums and draws its stall current.') },
        { text: t('Think: why would the board reset when the servo moves?'), done: 'reveal', answer: t('Each start pulls a burst of current from USB 5 V, the voltage sags and the chip\'s brown-out detector resets it. The fault level "Reboots when the servo moves" shows this; a separate 5 V supply with a shared ground fixes it.') },
      ],
      callouts: [C.servo, C.vcc],
      codeLines: [35],
    },
  ],
};
