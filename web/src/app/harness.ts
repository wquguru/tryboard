// 线束（P2-11，估算，必须上真机）：I2C 排线长度 → 上升时间；金属件 / 电池靠近天线 → RSSI 降低。
// 常数与 core/crates/elec/src/i2cbus.rs、core/crates/soc/src/wifi/world.rs 一致（test/elec.test.ts 对拍同一组数）；
// 模拟器里真正生效的是内核那一份（读回字节出错、AP 听不到），这里只给界面算提示。全是确定性公式，不引入随机。

export const PF_PER_CM = 1.0;
export const PF_PER_DEVICE = 10.0;
export const PF_BASE = 10.0;
export const PULLUP_PER_MODULE = 10_000;
export const PULLUP_INTERNAL = 45_000;
/** 实验台上一根杜邦线默认多长（cm，估算：面包板上常用的 10 cm 线） */
export const BENCH_WIRE_CM = 10;
/** 组装时 I2C 排线总长默认值（cm）：开发板到 OLED、BME280 两段 8 cm */
export const CASE_WIRE_CM = 16;
/** 网页提示按 400 kHz 算（参考固件都用 400 kHz；内核按固件实际配置的频率判） */
export const ASSUME_SCL_HZ = 400_000;

export const busPf = (wireCm: number, devices: number) => PF_BASE + PF_PER_DEVICE * devices + PF_PER_CM * Math.max(0, wireCm);
export const pullupOhm = (devices: number) => (devices === 0 ? PULLUP_INTERNAL : PULLUP_PER_MODULE / devices);
/** 上升时间（ns）：0.8473 · R · C（I2C 规范 UM10204 §7.1，30% → 70% VDD） */
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
  const base = `上升时间 ${l.rise.toFixed(0)} ns，${(ASSUME_SCL_HZ / 1000).toFixed(0)} kHz 允许 ${l.limit} ns`;
  if (l.verdict === 'ok') return `${base}，在规范内（这个接法最长约 ${l.maxCm.toFixed(0)} cm）`;
  if (l.verdict === 'marginal') return `${base}：超出规范，读回的字节会错（读数离谱、校准数据乱）。缩短到 ${l.maxCm.toFixed(0)} cm 以内，或换 4.7 kΩ 上拉、降到 100 kHz`;
  return `${base}：超过两倍，器件不应答（NACK），固件初始化就失败。缩短到 ${l.maxCm.toFixed(0)} cm 以内，或降到 100 kHz`;
}

// ------------------------------------------------------------------ 天线遮挡
/** 虚拟 AP（TryBoard-WiFi）在开阔处的信号（dBm），与内核 world.rs 一致 */
export const AP_RSSI = -42;
export const SCAN_MIN_DBM = -92;
export const LINK_MIN_DBM = -82;
export type Obstacle = 'none' | 'battery' | 'metal';
export const OBSTACLE_LABEL: Record<Obstacle, string> = { none: '没有', battery: '锂电池', metal: '金属件（螺丝柱、铝片、钢定位板）' };
/** 贴着天线时的衰减（dB，估算）：金属挡得最狠，电池次之 */
export const OBSTACLE_DB: Record<Exclude<Obstacle, 'none'>, number> = { metal: 45, battery: 30 };
/** 离天线多远就不再影响（mm，估算：2.4 GHz 近场约四分之一波长量级） */
export const OBSTACLE_RANGE_MM = 20;

/** 衰减（dB，整数）：K × (1 − d / 20 mm)，d ≥ 20 mm 为 0 */
export function antennaLossDb(o: Obstacle, distMm: number): number {
  if (o === 'none') return 0;
  const k = Math.max(0, 1 - Math.max(0, distMm) / OBSTACLE_RANGE_MM);
  return Math.round(OBSTACLE_DB[o] * k);
}
export const rssiAfter = (lossDb: number) => Math.max(-127, AP_RSSI - lossDb);
export function wifiText(lossDb: number): { rssi: number; level: Verdict; text: string } {
  const r = rssiAfter(lossDb);
  if (r < SCAN_MIN_DBM) return { rssi: r, level: 'fail', text: `TryBoard-WiFi ${r} dBm：扫描都收不到` };
  if (r < LINK_MIN_DBM) return { rssi: r, level: 'fail', text: `TryBoard-WiFi ${r} dBm：扫得到但连不上（低于 ${LINK_MIN_DBM} dBm）` };
  if (lossDb >= 15) return { rssi: r, level: 'marginal', text: `TryBoard-WiFi ${r} dBm：能连，信号弱，远一点就会掉线` };
  return { rssi: r, level: 'ok', text: `TryBoard-WiFi ${r} dBm` };
}

/** 组装时的线束选择（存 localStorage 'tryboard-app-harness:<work>'） */
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
    /* 存不了就用默认 */
  }
  return defaultCaseHarness();
}
export function saveCaseHarness(work: string, h: CaseHarness) {
  try {
    localStorage.setItem(KEY(work), JSON.stringify(h));
  } catch {
    /* 隐私模式：只在本页有效 */
  }
}
