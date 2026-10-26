// Lesson 11 (PLAN H-16): capstone desk weather station; checkpoint weather 06 (case), reference build weather.
// No `parts`: the whole scene is on the bench, so the Wiring tab is the generated pin table (lessonWires).
import { t } from '../../i18n/index.ts';
import type { Lesson, LessonCallout } from '../lessons.ts';
import { LED_VF, ledAmps } from '../../bench3d/ledparams.ts';

const SDA = 'wire:GPIO8~oled:SDA';
const BME_SDA = 'wire:GPIO8~bme280:SDA';
const SERVO = 'wire:GPIO4~servo:PWM';
const SERVO_VCC = 'wire:5V~servo:VCC';
const BUZZ = 'wire:GPIO5~buzzer:I/O';
const LED = 'wire:GPIO5~led:5:IN';
const DS_S3 = t('ESP32-S3 datasheet');

const C: Record<string, LessonCallout> = {
  oled: { key: 'oled', target: { kind: 'part', id: 'oled' }, title: t('OLED: the display'), body: t('Shows the big temperature, humidity and pressure (lesson 3)') },
  bme: { key: 'bme', target: { kind: 'part', id: 'bme280' }, title: t('BME280: the sensor'), body: t('Measures temperature, humidity and pressure on the same I2C bus (lesson 8)') },
  servo: { key: 'servo', target: { kind: 'part', id: 'servo' }, title: t('Servo: the dial'), body: t('Its arm points at the temperature like a needle (lesson 7)') },
  buzzer: { key: 'buzzer', target: { kind: 'part', id: 'buzzer' }, title: t('Buzzer: the alarm'), body: t('Beeps when it gets to 30 °C or hotter') },
  led: { key: 'led', target: { kind: 'part', id: 'led:5' }, title: t('LED: alarm light'), body: t('Shares GPIO5 with the buzzer, so it flickers with the beeps (lesson 1)') },
  boot: { key: 'boot', target: { kind: 'button', id: 'BOOT' }, title: t('BOOT: unit button'), body: t('Switches the screen between °C and °F (lesson 2)') },
  sda: { key: 'sda', target: { kind: 'wire', id: SDA }, title: t('One I2C bus, two parts'), body: t('OLED and BME280 share GPIO8 / GPIO9; their addresses tell them apart') },
  gpio4: { key: 'gpio4', target: { kind: 'pin', id: 'GPIO4' }, title: t('GPIO4: servo pulses'), body: t('50 Hz; the pulse width follows the temperature') },
  gpio5: { key: 'gpio5', target: { kind: 'pin', id: 'GPIO5' }, title: t('GPIO5: buzzer and LED'), body: t('A 2.7 kHz square wave while the alarm is on') },
  v5: { key: 'v5', target: { kind: 'wire', id: SERVO_VCC }, title: t('Servo power: the big current'), body: t('Up to about 0.7 A when it starts; the rest of the station needs far less') },
  board: { key: 'board', target: { kind: 'part', id: 'board' }, title: t('Keep the sensor away from the chip'), body: t('The chip and regulator warm up; a BME280 right next to them reads high') },
};

export const L11: Lesson = {
  work: 'weather',
  checkpoint: '06',
  no: 11,
  title: t('Capstone: desk weather station'),
  summary: t('Put the parts from the earlier lessons together, check pins and power, fit the case and make a shopping list.'),
  minutes: 20,
  buy: t('Everything from lessons 1–8, plus a case'),
  buyAll: true,
  fw: 'weather',
  src: 'firmware/weather/main/main.c',
  wireNotes: {
    'wire:GND~oled:GND': { to: t('OLED GND'), why: t('Shared ground for the display') },
    'wire:3V3~oled:VCC': { to: t('OLED VCC'), why: t('The display runs on 3.3 V and draws about 10 mA') },
    'wire:GPIO9~oled:SCL': { to: t('OLED SCL (clock)'), why: t('I2C clock, shared with the BME280') },
    [SDA]: { to: t('OLED SDA (data)'), why: t('I2C data; the OLED answers at address 0x3C') },
    'wire:GND~bme280:GND': { to: t('BME280 GND'), why: t('Shared ground for the sensor') },
    'wire:3V3~bme280:VIN': { to: t('BME280 VIN'), why: t('3.3 V; the sensor draws well under 1 mA') },
    'wire:GPIO9~bme280:SCL': { to: t('BME280 SCL (clock)'), why: t('Same clock line as the OLED') },
    [BME_SDA]: { to: t('BME280 SDA (data)'), why: t('Same data line as the OLED; the BME280 answers at 0x76') },
    [SERVO]: { to: t('Servo orange wire (signal)'), why: t('GPIO4 sends 50 Hz pulses; the width follows the temperature') },
    [SERVO_VCC]: { to: t('Servo red wire (VCC)'), why: t('The motor runs on 5 V and can pull about 0.7 A, far more than 3V3 or a GPIO can give') },
    'wire:GND~servo:GND': { to: t('Servo brown wire (GND)'), why: t('Shared ground: without it the servo cannot read the pulses') },
    'wire:3V3~buzzer:VCC': { to: t('Buzzer module VCC'), why: t('Powers the transistor on the buzzer module') },
    [BUZZ]: { to: t('Buzzer module I/O'), why: t('GPIO5 sends the 2.7 kHz tone while the alarm is on') },
    'wire:GND~buzzer:GND': { to: t('Buzzer module GND'), why: t('Shared ground for the buzzer') },
    [LED]: { to: t('LED long leg (+), through its resistor'), why: t('Same pin as the buzzer, so the light blinks with the beeps') },
    'wire:GND~led:5:GND': { to: t('LED short leg (−)'), why: t('Back to ground to close the loop') },
  },
  code: [
    { line: 23, text: t('Alarm threshold: 30.00 °C (temperatures are kept in hundredths of a degree)') },
    { line: 24, text: t('Alarm turns off below 29.00 °C: the 1 °C gap stops it chattering at the edge') },
    { line: 47, text: t('BOOT interrupt: only stamps the time and hands it to the main loop') },
    { line: 58, text: t('Temperature to servo pulse: 500 µs + t ÷ 2, so 0 °C = 0.5 ms and 40 °C = 2.5 ms') },
    { line: 67, text: t('Servo timer at 50 Hz, the same as lesson 7') },
    { line: 146, text: t('Draw the temperature in big digits (3× font)') },
    { line: 156, text: t('Send the whole frame to the OLED over I2C') },
    { line: 222, text: t('Read 8 bytes from the BME280: pressure, temperature, humidity') },
    { line: 227, text: t('Colour for the board RGB LED: blue below 18 °C, green below 28 °C, red above') },
    { line: 235, text: t('Temperature becomes the servo angle') },
    { line: 242, text: t('Redraw the screen with the new reading') },
    { line: 245, text: t('One serial line per reading: T, H, P, LED colour and pulse width') },
    { line: 250, text: t('Alarm with hysteresis: on at 30 °C, off below 29 °C') },
    { line: 268, text: t('Debounce: ignore a second press within 50 ms') },
    { line: 270, text: t('Each press flips °C / °F') },
  ],
  events: [{ pin: 0, hi: t('BOOT released'), lo: t('BOOT pressed'), line: 212, hiLine: 267, input: true }],
  i2c: [
    { addr: 0x3c, text: t('Screen updated: {n} bytes sent'), line: 156 },
    { addr: 0x76, text: t('Asked the BME280 for a reading: {n} bytes sent'), line: 38 },
  ],
  params: [
    { label: t('I2C pins (OLED + BME280)'), value: t('SDA GPIO8 · SCL GPIO9'), source: 'bench' },
    { label: t('Servo signal'), value: 'GPIO4', source: 'bench' },
    { label: t('Buzzer and LED'), value: 'GPIO5', source: 'bench' },
    { label: t('Unit button'), value: t('BOOT (GPIO0)'), source: 'code' },
    { label: t('Board RGB LED'), value: t('GPIO48 (on the board)'), source: 'code' },
    { label: t('Reading period'), value: t('Every 0.5 s'), source: 'code' },
    { label: t('Alarm'), value: t('On at 30 °C, off below 29 °C, 2.7 kHz beeps'), source: 'code' },
    { label: t('Board and chip, Wi-Fi off'), value: t('About 43 mA'), source: 'estimate' },
    { label: t('OLED screen'), value: t('About 10 mA (more with many dots lit)'), source: 'estimate' },
    { label: t('BME280 sensor'), value: t('Under 1 mA (a few µA between readings)'), source: 'datasheet', doc: t('BME280 datasheet') },
    { label: t('LED current'), value: `${(ledAmps(220, LED_VF.red) * 1000).toFixed(1)} mA`, source: 'estimate', live: 'led-ma' },
    { label: t('Buzzer module while beeping'), value: t('About 30 mA'), source: 'estimate' },
    { label: t('3.3 V side in total'), value: t('About 60 mA, about 90 mA while the alarm beeps'), source: 'estimate' },
    { label: t('Servo on 5 V'), value: t('About 0.15 A turning, about 0.7 A when starting or blocked'), source: 'estimate' },
    { label: t('Worst case from 5 V'), value: t('About 0.8 A, more than a USB 2.0 port\'s 0.5 A'), source: 'estimate' },
    { label: t('3.3 V regulator on the board'), value: t('Up to 800 mA'), source: 'datasheet', doc: t('SGM2212 datasheet') },
    { label: t('What a GPIO can supply'), value: t('About 20 mA at the default drive strength'), source: 'datasheet', doc: DS_S3 },
  ],
  buyTip: t('Buy the parts in the list below once, plus a case with vents that keeps the BME280 away from the board. For the servo add a separate 5 V supply of at least 1 A and join its ground to the board GND. The Shop step has the full parts list with links.'),
  steps: [
    {
      id: 'parts',
      title: t('Every part and its job'),
      sub: t('Six parts, one station'),
      body: t('This station joins the earlier lessons: the BME280 measures the room, the OLED shows the reading, the servo arm points at the temperature and the BOOT button switches between °C and °F. The buzzer and the LED on GPIO5 warn you at 30 °C or hotter, and the board RGB LED turns blue, green or red with the temperature. Every 0.5 s one reading from the BME280 drives all of them.'),
      tasks: [
        { text: t('Click the BME280 to see its specs'), done: 'select:bme280', how: t('Click the small sensor board on the bench') },
        { text: t('Click the buzzer'), done: 'select:buzzer', how: t('Click the black buzzer module on the bench') },
        { text: t('Which part decides what all the others show?'), done: 'reveal', answer: t('The BME280. Every 0.5 s the code reads it, then sets the screen, the servo angle, the RGB colour and the alarm from that one temperature.') },
      ],
      callouts: [C.bme, C.oled, C.servo, C.buzzer],
      codeLines: [222, 235, 242],
    },
    {
      id: 'pins',
      title: t('The pin table'),
      sub: t('Who sits on which pin'),
      body: t('The "Wiring" tab lists every wire on this bench; it is built from the bench itself, so it is always right. The OLED and the BME280 share GPIO8 and GPIO9 because I2C is a bus where each part has its own address (0x3C and 0x76). The buzzer and the LED share GPIO5, so the light blinks with the beeps.'),
      tasks: [
        { text: t('Click GPIO8, the I2C data pin'), done: 'select:GPIO8', how: t('Click the pin where the two SDA wires land on the board') },
        { text: t('Think: why can two parts share GPIO8 but the servo cannot share GPIO4 with the buzzer?'), done: 'reveal', answer: t('I2C parts take turns: the chip calls one address at a time. The servo and the buzzer both need their own steady signal on the pin all the time, 50 Hz pulses for one and a 2.7 kHz tone for the other.') },
      ],
      callouts: [C.sda, C.gpio4, C.gpio5, C.led],
      codeLines: [156, 222],
    },
    {
      id: 'power',
      title: t('How much current?'),
      sub: t('Estimate first, then pick the supply'),
      body: t('On the 3.3 V side the board and chip take about 43 mA, the OLED about 10 mA, the BME280 almost nothing, the LED a few mA and the buzzer module about 30 mA while beeping: about 60–90 mA in total, easy for the board. The servo takes about 0.15 A turning and about 0.7 A for a moment when it starts, so the worst case is about 0.8 A from 5 V, more than a USB 2.0 port gives. A real station therefore feeds the servo from its own 5 V supply with a shared ground; all figures here are estimates, not measured on real hardware.'),
      tasks: [
        { text: t('Click the servo: it is the part that needs the most current'), done: 'select:servo', how: t('Click the blue servo on the bench') },
        { text: t('Think: which single part sets the size of the power supply?'), done: 'reveal', answer: t('The servo. Everything else together is under 0.1 A; the servo can pull about 0.7 A when it starts, so the supply is sized for it.') },
      ],
      callouts: [C.v5, C.servo, C.oled],
    },
    {
      id: 'run',
      title: t('Run the whole station'),
      sub: t('Screen, needle and alarm together'),
      body: t('Click "Run": the OLED shows the temperature in big digits, the servo arm swings to match, the board RGB LED turns green at 23.5 °C and the serial log prints a line every 0.5 s. Then click the BME280 and drag "Ambient temperature": the reading, the needle and the colour all follow, and from 30 °C the buzzer and the LED beep until it drops below 29 °C. Press BOOT to switch the screen to °F.'),
      tasks: [
        { text: t('Click "Run"'), done: 'run', how: t('The "Run this lesson\'s code" button below') },
        { text: t('The OLED shows the temperature'), done: 'oled:300', how: t('Wait about a second after starting; the big digits light up the screen') },
        { text: t('Change the room temperature and watch the reading follow'), done: 'follow:temp', how: t('Click the BME280 on the bench and drag "Ambient temperature", or press "Add heat source"') },
        { text: t('Press BOOT to switch to °F'), done: 'press:boot×1', how: t('Click BOOT on the board, or the Button tool') },
      ],
      callouts: [C.oled, C.servo, C.bme, C.boot],
      codeLines: [235, 245, 250, 270],
    },
    {
      id: 'case',
      title: t('Into the case, then shop'),
      sub: t('Assemble, then the shopping list'),
      body: t('The case is fitted in the "Assemble" step at the top of the page, which unlocks once all six weather checkpoints pass; to try it right away, use ⋯ → "Change firmware" → "Run the whole route with built-in firmware". Put the BME280 at the vents, away from the board, because the chip and regulator warm up and a sensor next to them reads high. Come back afterwards: the task ticks itself, and the "Parameters" tab holds the shopping list from every lesson.'),
      tasks: [
        { text: t('Fit every part in the case'), done: 'asm:done', how: t('"Assemble" step at the top of the page; unlock it with ⋯ → "Change firmware" → "Run the whole route with built-in firmware"') },
        { text: t('Think: why should the BME280 sit away from the board in the case?'), done: 'reveal', answer: t('The chip, the regulator and the OLED all turn power into heat. Inside a closed case they warm the air around them by a few degrees, so a sensor next to them reports the case, not the room. Put it at the vents, as far from the board as the wires allow.') },
      ],
      callouts: [C.board, C.bme],
    },
  ],
};
