// Harness (P2-11, estimate): I2C wire length -> rise time; metal/battery near the antenna -> RSSI. Constants match
// core/crates/elec/src/i2cbus.rs and soc/src/wifi/world.rs (test/elec.test.ts); the core applies the effect, this only hints the UI.
import { t } from '../i18n/index.ts';

export const PF_PER_CM = 1.0;
export const PF_PER_DEVICE = 10.0;
export const PF_BASE = 10.0;
export const PULLUP_PER_MODULE = 10_000;
export const PULLUP_INTERNAL = 45_000;
/** Default bench jumper length in cm (the common 10 cm breadboard wire). */
export const BENCH_WIRE_CM = 10;
/** Default assembled I2C harness length in cm: two 8 cm runs, board to OLED and BME280. */
export const CASE_WIRE_CM = 16;
/** UI hints assume 400 kHz (all reference firmware uses it); the core uses the configured clock. */
export const ASSUME_SCL_HZ = 400_000;

export const busPf = (wireCm: number, devices: number) => PF_BASE + PF_PER_DEVICE * devices + PF_PER_CM * Math.max(0, wireCm);
export const pullupOhm = (devices: number) => (devices === 0 ? PULLUP_INTERNAL : PULLUP_PER_MODULE / devices);
/** Rise time in ns: 0.8473 · R · C (UM10204 §7.1, 30% -> 70% VDD). */
export const riseNs = (wireCm: number, devices: number) => 0.8473 * pullupOhm(devices) * busPf(wireCm, devices) * 1e-3;
export const limitNs = (sclHz: number) => (sclHz <= 100_000.5 ? 1000 : sclHz <= 400_000.5 ? 300 : 120);
export type Verdict = 'ok' | 'marginal' | 'fail';
export const verdict = (rise: number, limit: number): Verdict => (rise <= limit ? 'ok' : rise <= 2 * limit ? 'marginal' : 'fail');
export const maxWireCm = (devices: number, sclHz = ASSUME_SCL_HZ) => Math.max(0, (limitNs(sclHz) / (0.8473 * pullupOhm(devices) * 1e-3) - PF_BASE - PF_PER_DEVICE * devices) / PF_PER_CM);

export interface I2cLoad {
  wireCm: number;
  devices: number;
  rise: number;
  limit: number;
  verdict: Verdict;
  maxCm: number;
}
export function i2cLoad(wireCm: number, devices: number, sclHz = ASSUME_SCL_HZ): I2cLoad {
  const rise = riseNs(wireCm, devices);
  const limit = limitNs(sclHz);
  return { wireCm, devices, rise, limit, verdict: verdict(rise, limit), maxCm: maxWireCm(devices, sclHz) };
}
export function i2cText(l: I2cLoad): string {
  const v = { rise: l.rise.toFixed(0), khz: (ASSUME_SCL_HZ / 1000).toFixed(0), limit: l.limit, max: l.maxCm.toFixed(0) };
  if (l.verdict === 'ok') return t('Rise time {rise} ns, {khz} kHz allows {limit} ns: within spec (this wiring can go up to about {max} cm)', v);
  if (l.verdict === 'marginal') return t('Rise time {rise} ns, {khz} kHz allows {limit} ns: out of spec, reads will be corrupted (wild readings, garbled calibration). Shorten to under {max} cm, or use 4.7 kΩ pull-ups and drop to 100 kHz', v);
  return t('Rise time {rise} ns, {khz} kHz allows {limit} ns: more than double, the device does not answer (NACK) and firmware init fails. Shorten to under {max} cm, or drop to 100 kHz', v);
}
/** Plain-language layer (DESIGN_V2 §9): verdict + fix; the numbers live in i2cText as fine print. */
export function i2cSay(l: I2cLoad): string {
  const max = l.maxCm.toFixed(0);
  if (l.verdict === 'ok') return t('I2C wire {cm} cm is fine; it can go up to {max} cm', { cm: l.wireCm, max });
  if (l.verdict === 'marginal') return t('I2C wire too long, readings will be wrong: shorten to under {max} cm', { max });
  return t('I2C wire too long, the sensor does not respond: shorten to under {max} cm', { max });
}

// ------------------------------------------------------------------ antenna obstruction
/** Virtual AP (TryBoard-WiFi) RSSI in open air, dBm; matches core world.rs. */
export const AP_RSSI = -42;
export const SCAN_MIN_DBM = -92;
export const LINK_MIN_DBM = -82;
export type Obstacle = 'none' | 'battery' | 'metal';
export const OBSTACLE_LABEL: Record<Obstacle, string> = { none: t('Nothing'), battery: t('Li-ion battery'), metal: t('Metal parts (screw posts, aluminium sheet, steel plate)') };
/** Loss in dB when touching the antenna (estimate): metal worst, battery next. */
export const OBSTACLE_DB: Record<Exclude<Obstacle, 'none'>, number> = { metal: 45, battery: 30 };
/** Distance in mm beyond which there is no effect (estimate: ~quarter wavelength at 2.4 GHz). */
export const OBSTACLE_RANGE_MM = 20;

/** Loss in whole dB: K × (1 − d / 20 mm), 0 when d ≥ 20 mm. */
export function antennaLossDb(o: Obstacle, distMm: number): number {
  if (o === 'none') return 0;
  const k = Math.max(0, 1 - Math.max(0, distMm) / OBSTACLE_RANGE_MM);
  return Math.round(OBSTACLE_DB[o] * k);
}
export const rssiAfter = (lossDb: number) => Math.max(-127, AP_RSSI - lossDb);
export function wifiText(lossDb: number): { rssi: number; level: Verdict; text: string } {
  const r = rssiAfter(lossDb);
  if (r < SCAN_MIN_DBM) return { rssi: r, level: 'fail', text: t('TryBoard-WiFi {rssi} dBm: not found in scan', { rssi: r }) };
  if (r < LINK_MIN_DBM) return { rssi: r, level: 'fail', text: t('TryBoard-WiFi {rssi} dBm: visible but cannot connect (below {min} dBm)', { rssi: r, min: LINK_MIN_DBM }) };
  if (lossDb >= 15) return { rssi: r, level: 'marginal', text: t('TryBoard-WiFi {rssi} dBm: connects, but the signal is weak and drops a little farther away', { rssi: r }) };
  return { rssi: r, level: 'ok', text: `TryBoard-WiFi ${r} dBm` };
}

/** One plain sentence for Wi-Fi; dBm stays in wifiText as fine print. */
export function wifiSay(lossDb: number): string {
  const r = rssiAfter(lossDb);
  if (r < SCAN_MIN_DBM) return t('The enclosure blocks the antenna: Wi-Fi not found');
  if (r < LINK_MIN_DBM) return t('The enclosure blocks the antenna: Wi-Fi cannot connect');
  if (lossDb >= 15) return t('Wi-Fi connects, but the signal is weak and drops a little farther from the router');
  return lossDb > 0 ? t('The enclosure barely affects Wi-Fi') : t('Nothing near the antenna, Wi-Fi unaffected');
}

/** Assembly harness choice (localStorage 'tryboard-app-harness:<work>'). */
export interface CaseHarness {
  i2cCm: number;
  obstacle: Obstacle;
  distMm: number;
}
export const defaultCaseHarness = (): CaseHarness => ({ i2cCm: CASE_WIRE_CM, obstacle: 'none', distMm: 20 });
const KEY = (work: string) => `tryboard-app-harness:${work}`;
export function loadCaseHarness(work: string): CaseHarness {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(work)) ?? 'null');
    if (v && typeof v.i2cCm === 'number' && ['none', 'battery', 'metal'].includes(v.obstacle) && typeof v.distMm === 'number') return v;
  } catch {
    /* Unreadable: use defaults. */
  }
  return defaultCaseHarness();
}
export function saveCaseHarness(work: string, h: CaseHarness) {
  try {
    localStorage.setItem(KEY(work), JSON.stringify(h));
    // Top bar "saved locally": node tests import this file, so signal via an event instead of importing the shell.
    globalThis.dispatchEvent?.(new Event('tb-saved'));
  } catch {
    /* Private mode: lasts for this page only. */
  }
}
