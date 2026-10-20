// Simulator devices of a bench scene (worker boot / reconfigure / CLI replay header); split out of createSession (R-14 size).
import type { PartSpec, SceneSpec } from '../bench3d/spec';
import type { Battery } from '../simmsg';
import { boardDevs } from '../bench3d/boarddevs';

/** Live session state the device list depends on */
export interface DevState {
  battery: Battery | null;
  distance: number;
}

/** I2S audio parts (pins fixed per chip): speaker shares the sound toggle; mic hears a 1 kHz test WAV. */
export const i2sOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'max98357a' || p.type === 'inmp441' ? [p.type] : []));

const i2cOf = (parts: PartSpec[]) => {
  const kind: Record<string, string> = { oled: 'ssd1306', bme280: 'bme280', mpu6050: 'mpu6050', qmi8658: 'qmi8658', cst816s: 'cst816s' };
  return parts.flatMap((p) => ('addr' in p && kind[p.type] ? [{ kind: kind[p.type], addr: p.addr }] : []));
};
/** GPIO wired to touch INT (CST816S on the bench). */
const touchIntOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'cst816s' ? [p.int] : []))[0];
/** Simulator devices of a scene: onboard ones of an all-in-one board (E-03) first, then bench parts */
export const devsOf = (sc: SceneSpec, st: DevState) => {
  const bd = boardDevs(sc.board);
  const parts = sc.parts;
  return {
    i2c: [...(bd?.i2c ?? []), ...i2cOf(parts)],
    lcd: bd?.lcd ?? parts.some((p) => p.type === 'gc9a01'),
    battery: bd ? (st.battery ?? bd.battery) : undefined,
    servo: servoOf(parts),
    encoder: encoderOf(parts),
    sonar: sonarOf(parts, st.distance),
    dht11: dht11Of(parts),
    touchInt: bd?.touchInt ?? touchIntOf(parts),
    i2s: i2sOf(parts),
  };
};
/** First encoder / ultrasonic on the bench, attached to the core at power-on. */
const encoderOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'encoder' ? [{ a: p.a, b: p.b, ...(p.sw !== undefined ? { sw: p.sw } : {}) }] : []))[0];
const sonarOf = (parts: PartSpec[], cm: number) => parts.flatMap((p) => (p.type === 'hcsr04' ? [{ trig: p.trig, echo: p.echo, cm }] : []))[0];
/** DHT11 data pin (first one; the core models one per pin, the CLI takes one). */
const dht11Of = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'dht11' ? [p.pin] : []))[0];
/** Signal pin of the first servo; the power network's servo load hangs on it. */
export const servoOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'servo' ? [p.pin] : []))[0];
