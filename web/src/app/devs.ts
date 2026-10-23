// Simulator devices of a bench scene (worker boot / reconfigure / CLI replay header); split out of createSession (R-14 size).
import type { PartSpec, SceneSpec } from '../bench3d/spec';
import type { Battery } from '../simmsg';
import { boardDevs } from '../bench3d/boarddevs';
import { LDR_LUX_DEFAULT, PIR_HOLD_DEFAULT, partsEmpty, type PartsDevs } from '../partsdev.ts';

/** Live session state the device list depends on */
export interface DevState {
  battery: Battery | null;
  distance: number;
}

/** I2S audio parts as CLI --i2s entries (`kind`, or `kind@bclk:ws:data` with explicit pins): speaker shares the sound toggle; mic hears a test WAV. */
export const i2sOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'max98357a' || p.type === 'inmp441' ? [p.pins ? `${p.type}@${p.pins.join(':')}` : p.type] : []));

const i2cOf = (parts: PartSpec[]) => {
  const kind: Record<string, string> = { oled: 'ssd1306', bme280: 'bme280', mpu6050: 'mpu6050', qmi8658: 'qmi8658', cst816s: 'cst816s', aht20: 'aht20', ina219: 'ina219', ds3231: 'ds3231' };
  return parts.flatMap((p) => ('addr' in p && kind[p.type] ? [{ kind: p.type === 'oled' && p.ctl ? p.ctl : kind[p.type], addr: p.addr, ...('sda' in p ? { sda: p.sda, scl: p.scl } : {}) }] : []));
};
/** Bench screen: a bare TFT panel (F-04a2, = CLI --spi <panel>) or the GC9A01 round LCD (true) */
const lcdOf = (parts: PartSpec[]) => parts.find((p) => p.type === 'tft')?.panel ?? parts.some((p) => p.type === 'gc9a01');
/** GPIO wired to touch INT (CST816S on the bench). */
const touchIntOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'cst816s' ? [p.int] : []))[0];
/** Simulator devices of a scene: onboard ones of an all-in-one board (E-03) first, then bench parts; M5 boards add only the preset */
export const devsOf = (sc: SceneSpec, st: DevState) => {
  const bd = boardDevs(sc.board);
  const parts = sc.parts;
  return {
    i2c: [...(bd?.i2c ?? []), ...i2cOf(parts)],
    lcd: bd?.lcd ?? lcdOf(parts),
    battery: bd?.battery ? (st.battery ?? bd.battery) : undefined,
    servo: servoOf(parts),
    encoder: encoderOf(parts),
    sonar: sonarOf(parts, st.distance),
    dht11: dht11Of(parts),
    touchInt: bd?.touchInt ?? touchIntOf(parts),
    i2s: i2sOf(parts),
    board: bd?.preset,
    grove: bd?.preset ? sc.grove : undefined,
    parts: partsOf(parts),
  };
};
/** First encoder / ultrasonic on the bench, attached to the core at power-on. */
const encoderOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'encoder' ? [{ a: p.a, b: p.b, ...(p.sw !== undefined ? { sw: p.sw } : {}) }] : []))[0];
const sonarOf = (parts: PartSpec[], cm: number) => parts.flatMap((p) => (p.type === 'hcsr04' ? [{ trig: p.trig, echo: p.echo, cm }] : []))[0];
/** DHT11 data pin (first one; the core models one per pin, the CLI takes one). */
const dht11Of = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'dht11' ? [p.pin] : []))[0];
/** Signal pin of the first servo; the power network's servo load hangs on it. */
export const servoOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'servo' ? [p.pin] : []))[0];
/** F-04a parts: first of each type (the CLI takes one of each); undefined when none, so the device key stays as before */
export function partsOf(parts: PartSpec[]): PartsDevs | undefined {
  const out: PartsDevs = {};
  for (const p of parts) {
    if (p.type === 'ds18b20' && !out.ds18b20) out.ds18b20 = { pin: p.pin, n: p.n ?? 1 };
    if (p.type === 'pir' && !out.pir) out.pir = { pin: p.pin, hold: p.hold ?? PIR_HOLD_DEFAULT };
    if (p.type === 'relay' && !out.relay) out.relay = { pin: p.pin, ...(p.low ? { low: true } : {}) };
    if (p.type === 'ldr' && !out.ldr) out.ldr = { pin: p.pin, lux: p.lux ?? LDR_LUX_DEFAULT };
    if (p.type === 'rc522' && !out.rc522) out.rc522 = p.cs !== undefined ? { cs: p.cs } : {};
    // One IR link (CLI --ir RX,TX): first receiver and first IR LED
    if (p.type === 'irrx' && out.ir?.rx === undefined) out.ir = { ...out.ir, rx: p.pin };
    if (p.type === 'irled' && out.ir?.tx === undefined) out.ir = { ...out.ir, tx: p.pin };
  }
  return partsEmpty(out) ? undefined : out;
}
