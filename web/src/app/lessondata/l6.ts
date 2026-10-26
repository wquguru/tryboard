// H-16 lesson 6 "Make a sound": a passive buzzer on GPIO6 plays do re mi from an LEDC square wave.
// Code lines point at firmware/s3-buzzer/main/main.c; the feed narrates each note start (Lesson.tones).
import { t } from '../../i18n/index.ts';
import type { Lesson, LessonCallout } from '../lessons.ts';

const C: Record<string, LessonCallout> = {
  buzzer: { key: 'buzzer', target: { kind: 'part', id: 'buzzer' }, title: t('Passive buzzer'), body: t('No oscillator inside: it only sounds while it gets a square wave') },
  io: { key: 'io', target: { kind: 'pin', id: 'GPIO6' }, title: t('GPIO6 = signal'), body: t('The LEDC square wave leaves the chip here; its frequency is the pitch') },
  gnd: { key: 'gnd', target: { kind: 'wire', id: 'wire:GND~buzzer:GND', anchor: '0' }, title: t('GND (ground)'), body: t('Current flows back to the board here') },
};
const pick = (...k: string[]) => k.map((x) => C[x]);

export const L6: Lesson = {
  work: 'basics',
  checkpoint: 'basics-buzz',
  no: 6,
  title: t('Make a sound'),
  summary: t('Play do re mi on a passive buzzer with a square wave.'),
  minutes: 10,
  buy: t('Passive buzzer module (3-pin)'),
  parts: ['buzzer'],
  fw: 's3-buzzer',
  src: 'firmware/s3-buzzer/main/main.c',
  tones: [{ pin: 6, text: t('Buzzer plays {note}'), notes: { 262: 'do', 294: 're', 330: 'mi' }, line: 60 }],
  wireNotes: {
    'wire:3V3~buzzer:VCC': { to: t('Buzzer VCC'), why: t("Powers the module's little driver transistor from 3.3 V") },
    'wire:GPIO6~buzzer:I/O': { to: t('Buzzer I/O'), why: t('The square wave from LEDC: its frequency is the note you hear') },
    'wire:GND~buzzer:GND': { to: t('Buzzer GND'), why: t('Shared ground for the buzzer') },
  },
  code: [
    { line: 8, text: t('The buzzer signal is on GPIO6 (GPIO5 is the LED from lesson 1)') },
    { line: 18, text: t('The melody: a list of note names and frequencies in Hz') },
    { line: 26, text: t('Set the square wave to this frequency: the pitch of the note') },
    { line: 28, text: t('Duty 512 of 1024: high half the time, low half the time') },
    { line: 34, text: t('Duty 0: the pin stays low and the buzzer goes quiet') },
    { line: 44, text: t('The LEDC timer starts at 262 Hz (do)') },
    { line: 49, text: t('The LEDC channel sends that wave out on the buzzer pin') },
    { line: 61, text: t('Print the note on serial, e.g. "音符 do 262 Hz"') },
    { line: 62, text: t('Let the note sound for 270 ms') },
    { line: 64, text: t('A 30 ms rest, so two equal notes in a row are heard as two') },
  ],
  params: [
    { label: t('Notes played'), value: 'do 262 Hz · re 294 Hz · mi 330 Hz', source: 'code' },
    { label: t('Duty while sounding'), value: '512 / 1024 = 50 %', source: 'code' },
    { label: t('Note length'), value: '270 ms + 30 ms', source: 'code' },
    { label: t('Signal pin'), value: 'GPIO6', source: 'bench' },
    { label: t('Loudness'), value: t('about 80 dB at 10 cm'), source: 'typical' },
    { label: t('Loudest around'), value: t('about 2–4 kHz (its resonance)'), source: 'typical' },
  ],
  buyTip: t('When buying: ask for a passive buzzer. An active one has its own oscillator and only beeps one fixed tone when powered (sellers often mark it with a sealed top or a sticker). 3-pin modules (VCC, I/O, GND) include a transistor, so the GPIO only sends the signal.'),
  steps: [
    {
      id: 'part',
      title: t('Meet the passive buzzer'),
      sub: t('Active or passive?'),
      body: t('An active buzzer has its own oscillator: give it power and it beeps one fixed tone. A passive buzzer has none, so the chip must send it a square wave, and the wave\'s frequency is the pitch you hear. That is why only a passive buzzer can play a tune.'),
      tasks: [
        { text: t('Click the buzzer to see its specs'), done: 'select:buzzer', how: t('Click the round black buzzer on the breadboard') },
        { text: t('Think: what does an active buzzer do with this tune code?'), done: 'reveal', answer: t('It just beeps at its own fixed pitch whenever the pin is high; the frequencies in the code make no difference.') },
      ],
      callouts: pick('buzzer'),
      codeLines: [8],
    },
    {
      id: 'wire',
      title: t('Three wires'),
      sub: t('VCC, I/O, GND'),
      body: t('VCC goes to 3V3 and GND to GND, which power the small transistor on the module. The I/O pin goes to GPIO6 and carries the square wave. GPIO5 stays with the LED from lesson 1, and GPIO6 is the free pin right next to it.'),
      tasks: [
        { text: t('Follow the I/O wire from the buzzer to the board'), done: 'reveal', answer: t('It goes to GPIO6: the card on the board pin marks it.') },
        { text: t('Think: why not drive the buzzer straight from 3V3?'), done: 'reveal', answer: t('A steady 3.3 V never changes, so a passive buzzer\'s membrane moves once and stays put: you hear a click, not a tone.') },
      ],
      callouts: pick('buzzer', 'io', 'gnd'),
    },
    {
      id: 'code',
      title: t('A square wave from LEDC'),
      sub: t('Frequency = pitch'),
      body: t('LEDC is the chip\'s PWM unit, the same one that dims an LED. ledc_set_freq() picks how many times per second the pin goes high and low, and duty 512 of 1024 keeps it high half of each cycle. Duty 0 keeps the pin low, which is silence.'),
      tasks: [
        { text: t('Find the line that sets the pitch'), done: 'reveal', answer: t('Line 26: ledc_set_freq() with the note\'s frequency in Hz.') },
        { text: t('Think: how many times a second does the membrane move for mi?'), done: 'reveal', answer: t('330 times: one push and one release per cycle of the 330 Hz wave.') },
      ],
      callouts: pick('io'),
      codeLines: [26, 28, 34],
    },
    {
      id: 'run',
      title: t('Run and listen'),
      sub: t('do re mi, over and over'),
      body: t('Click "Run": the membrane on the bench starts to shake and "What happened" adds one row per note. Turn on the sound button to hear it. Each note lasts 300 ms, so the three notes repeat about three times a second.'),
      tasks: [
        { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
        { text: t('Check: the rows go do, re, mi, do, re, mi…'), done: 'reveal', answer: t('Yes: line 60 sets each note in turn, and the 30 ms rests between them add no rows.') },
      ],
      callouts: pick('buzzer', 'io'),
      codeLines: [60, 61],
    },
    {
      id: 'tweak',
      title: t('Change it'),
      sub: t('Another tune'),
      body: t('The melody is just the list at the top of the code. Swap in other names and frequencies and the same loop plays your tune. Here is the start of "Frère Jacques": do re mi do, do re mi do.'),
      tasks: [
        { text: t('Write "Frère Jacques" as a list of notes'), done: 'reveal', answer: t('{"do",262}, {"re",294}, {"mi",330}, {"do",262}, then the same four again.') },
        { text: t('Think: what frequency is the next note up, fa?'), done: 'reveal', answer: t('About 349 Hz. One octave up doubles the frequency: high do is 523 Hz.') },
      ],
      callouts: pick('buzzer'),
      codeLines: [18, 19, 20, 21],
    },
  ],
};
