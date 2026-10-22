// Checkpoints generated from the bench parts (DECISIONS 2026-10-18 board picker v3, contract 3): custom projects have too many combinations
// to hand-write in levels.json. Pure and deterministic; judge fields match check.py --level-json so fingerprints agree.
import type { PartSpec } from '../board3d';
import { t } from '../i18n';
import { CHIP_LABEL } from '../chips.ts';
import { i2cArgs } from '../i2cdevs.ts';
import type { Level } from '../checks.ts';
import type { ConfLevel } from '../ui/conf.tsx';

export interface GenInput {
  /** Bench board name (goes into the brief). */
  boardName: string;
  chip: 'esp32' | 'esp32c3' | 'esp32s3';
  parts: PartSpec[];
  /** Battery plus deep sleep adds a "wakes from deep sleep" checkpoint (real hardware only, not judged). */
  deepSleep: boolean;
}

const hex2 = (n: number) => '0x' + n.toString(16).padStart(2, '0');
const I2C_KIND: Record<string, { kind: string; name: string }> = { bme280: { kind: 'bme280', name: 'BME280' }, oled: { kind: 'ssd1306', name: 'OLED' }, mpu6050: { kind: 'mpu6050', name: 'MPU6050' }, qmi8658: { kind: 'qmi8658', name: 'QMI8658' } };

/** Confidence of a checkpoint: manual ones and DHT11 readings (busy-wait timed, D-03) need hardware; I2C ack and servo pulse
 *  are behavioural; the rest are acceptance-tested. */
export function levelConf(l: Level): ConfLevel {
  if (l.manual || (l.numeric?.length && l.args?.includes('--dht11'))) return '必须上真机'; // lint: allow-cjk (ConfLevel id, ui/conf.tsx)
  if (l.i2c_ack?.length || l.pwm) return '行为模拟'; // lint: allow-cjk
  return '仿真验证'; // lint: allow-cjk
}

export function genLevels(g: GenInput): Level[] {
  const i2c = g.parts.flatMap((p) => ('addr' in p && 'sda' in p && I2C_KIND[p.type] ? [{ ...I2C_KIND[p.type], addr: p.addr, sda: p.sda, scl: p.scl }] : [])).sort((a, b) => a.addr - b.addr);
  const servo = g.parts.find((p): p is Extract<PartSpec, { type: 'servo' }> => p.type === 'servo');
  const strip = g.parts.find((p): p is Extract<PartSpec, { type: 'ws2812' }> => p.type === 'ws2812');
  const oled = g.parts.some((p) => p.type === 'oled');
  const dht = g.parts.find((p): p is Extract<PartSpec, { type: 'dht11' }> => p.type === 'dht11');
  // Every checkpoint carries the bench devices (--i2c-bus, env; bootOptions maps them for the web); servo runs on external 5 V.
  const args = [
    // P2-16: devices sit on the wired SDA / SCL pads (--i2c-bus), like the bench
    ...(i2c.length ? [...i2cArgs(i2c), '--i2c-log'] : []),
    '--env', '23.5,45,101325',
    ...(servo ? ['--servo', String(servo.pin), '--power', 'ext'] : []),
    ...(dht ? ['--dht11', String(dht.pin)] : []),
  ];
  const wiring = [
    ...i2c.map((d) => t('{name} (I2C address {addr}): SDA=GPIO{sda}, SCL=GPIO{scl}', { name: d.name, addr: hex2(d.addr), sda: d.sda, scl: d.scl })),
    ...(servo ? [t('Servo signal: GPIO{pin} (50 Hz, external 5 V supply)', { pin: servo.pin })] : []),
    ...(strip ? [t('LED strip data DIN: GPIO{pin}', { pin: strip.pin })] : []),
    ...(dht ? [t('DHT11 DATA: GPIO{pin} (open drain, 10 kΩ pull-up on the module)', { pin: dht.pin })] : []),
  ];
  const chipName = CHIP_LABEL[g.chip];
  const brief = (goal: string, pass: string) =>
    [
      t('Write firmware for {board} ({chip}) with ESP-IDF 5.x.', { board: g.boardName, chip: chipName }),
      t('Goal: {goal}', { goal }),
      ...(wiring.length ? [t('Wiring:'), ...wiring.map((w) => `- ${w}`)] : []),
      t('Pass condition: {pass}', { pass }),
      t('Submit only flash.bin (merged image, starting at 0x0).'),
    ].join('\n');
  const out: Level[] = [];
  const add = (l: Omit<Level, 'id' | 'buy' | 'learn' | 'brief' | 'ref' | 'work' | 'seconds' | 'args'> & { manual?: boolean }) => {
    const id = `custom-${out.length + 1}`;
    out.push({ id, ...l, buy: '', learn: '', brief: brief(l.goal, l.pass), ref: null, work: 'custom', seconds: 3, args: [...args] });
  };
  add({ title: t('Boots without crashing, prints to serial'), goal: t('Start normally after power-on and print something to serial'), pass: t('No panic / abort within 3 s, at least 1 line of serial output'), boots: true });
  for (const d of i2c) add({ title: t('I2C {addr} responds ({name})', { addr: hex2(d.addr), name: d.name }), goal: t('Access {name} over I2C', { name: d.name }), pass: t('{name} ({addr}) ACKs its address byte at least once', { name: d.name, addr: hex2(d.addr) }), i2c_ack: [{ addr: d.addr, min: 1 }] });
  if (oled) add({ title: t('OLED receives a frame'), goal: t('Draw something on the OLED (text or readings)'), pass: t('The last OLED frame lights at least 50 pixels'), oled_min_pixels: 50 });
  if (strip) add({ title: t('LED strip receives data'), goal: t('Send color data to the WS2812 strip with RMT'), pass: t('At least 1 WS2812 frame decoded on GPIO{pin}', { pin: strip.pin }), ws2812: { pin: strip.pin, min_frames: 1 } });
  if (servo) add({ title: t('Servo signal'), goal: t('Output a 50 Hz servo signal with LEDC'), pass: t('50 Hz PWM on GPIO{pin}, pulse width 0.5–2.5 ms', { pin: servo.pin }), pwm: { pin: servo.pin, freq: 50, min: 0.075, max: 0.075, tol: 0.05 } });
  // c3-dht11 prints its first reading line about 1 s after boot, inside the 3 s run
  if (dht)
    add({
      title: t('DHT11 reading'),
      goal: t('Read the DHT11 with your own single-wire driver and print temperature and humidity to serial'),
      pass: t('Serial prints "{line}" matching the environment (23.5 °C ±1, 45 %RH ±1)', { line: '温度 <°C> 湿度 <%RH>' }), // lint: allow-cjk (firmware printf)
      numeric: [
        { name: 'Temperature', regex: '温度 (-?[\\d.]+) 湿度', value: 23.5, tol: 1 }, // lint: allow-cjk (firmware printf)
        { name: 'Humidity', regex: '湿度 ([\\d.]+)', value: 45, tol: 1 }, // lint: allow-cjk
      ],
    });
  if (g.deepSleep) add({ title: t('Wakes again after deep sleep'), goal: t('Deep sleep after measuring, wake on a timer and measure again'), pass: t("The web can't judge this: deep-sleep current and wake-up must be measured on real hardware"), manual: true });
  return out;
}
