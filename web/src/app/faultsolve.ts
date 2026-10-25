// Wiring faults via the net solver (P2-14): wirecheck's net params go to the wasm elec solver (stateless tb_fault), then
// datasheet limits pick the consequence. Own wasm instance on the main thread, so no worker needed; same numbers as tools/elec.
import { t } from '../i18n/index.ts';
import type { FaultEstimate, FaultNet, WireFault } from './wirecheck';

/** The two wasm exports used (tests pass node-instantiated exports directly). */
export interface FaultExports {
  tb_fault(kind: number, s3: number, a: number, b: number, c: number, d: number): number;
  tb_fault_out(k: number): number;
}

/** Raw result of one solve. */
export interface FaultRaw {
  i: number;
  vPin: number;
  v5: number;
  v33: number;
  limiter: number;
}

// Limits: ESP32-C3 datasheet v2.4 table 5-4 (I_OH 40 mA at max drive, VIH max VDD + 0.3 V); LED 20 mA is a common
// 3/5 mm red LED rating; 1 mA injection is a rule of thumb (Espressif gives no clamp-injection limit).
const I_OH_MAX = 0.04;
const LED_RATED = 0.02;
const INJECT_MAX = 0.001;
const VIH_MAX = 3.6;
const LIMITER = [t('wire and pin resistance'), t("the PC USB port's current limit"), t("the external supply's current limit"), t("the onboard LDO's current limit"), t('the onboard LDO dropping out')];

export function solveRaw(x: FaultExports, kind: number, args: number[], s3: boolean): FaultRaw {
  const [a = 0, b = 0, c = 0, d = 0] = args;
  const i = x.tb_fault(kind, s3 ? 1 : 0, a, b, c, d);
  return { i, vPin: x.tb_fault_out(0), v5: x.tb_fault_out(1), v33: x.tb_fault_out(2), limiter: x.tb_fault_out(3) };
}

const mA = (i: number) => (i >= 1 ? `${i.toFixed(2)} A` : `${(i * 1000).toFixed(i < 0.01 ? 1 : 0)} mA`);

/** Consequence text: current, which limit it exceeds, and what limits it. */
export function consequence(kind: number, r: FaultRaw): string {
  const I = Math.abs(r.i);
  if (kind === 1 || kind === 2) {
    const over = I > I_OH_MAX;
    const v = { i: mA(I), x: (I / I_OH_MAX).toFixed(1), v: r.vPin.toFixed(2) };
    return over
      ? t('About {i} flows into the pin output stage, over the datasheet 40 mA limit ({x}×); a few seconds of this can burn out this GPIO. The pin is pulled to {v} V.', v)
      : t('About {i} flows into the pin output stage; under 40 mA, but the two sides fight over the level, so readings are unreliable. The pin is pulled to {v} V.', v);
  }
  if (kind === 3) {
    const over = I > LED_RATED;
    const v = { i: mA(I), x: (I / LED_RATED).toFixed(1), v: r.vPin.toFixed(2) };
    // !over implies I ≤ 20 mA < 40 mA, so the GPIO-over-limit variant only exists with over.
    const head = !over
      ? t('About {i} flows through the LED (rated about 20 mA); the GPIO output is pulled to {v} V, near its drive limit.', v)
      : I > I_OH_MAX
        ? t('About {i} flows through the LED (rated about 20 mA): {x}× overcurrent, the LED will soon dim or burn out, and the GPIO is over its 40 mA limit too.', v)
        : t('About {i} flows through the LED (rated about 20 mA): {x}× overcurrent, the LED will soon dim or burn out; the GPIO output is pulled to {v} V, near its drive limit.', v);
    return `${head} ${t('With 220 Ω in series it would be about {i}.', { i: mA(Math.max(0, (3.3 - 1.8) / (220 + 33 + 10))) })}`;
  }
  if (kind === 4) {
    const who = LIMITER[r.limiter] ?? t('the power supply');
    return t('About {i} flows straight from the supply to ground, limited by {who}; the 5V rail drops to {v5} V and 3V3 to {v33} V, the chip browns out and resets, the USB port may cut power, and the jumper and regulator get hot.', { i: mA(I), who, v5: r.v5.toFixed(2), v33: r.v33.toFixed(2) });
  }
  if (kind === 5) {
    const harm = I > INJECT_MAX;
    const v = { v: r.vPin.toFixed(2), max: VIH_MAX, i: mA(I) };
    return harm
      ? t('The pin is raised to {v} V (limit {max} V) and about {i} flows through the clamp diode into the 3V3 rail, above the ~1 mA rule-of-thumb safe value; over time this damages the pin (Espressif gives no injection limit).', v)
      : t('The pin is raised to {v} V (limit {max} V) and about {i} flows through the clamp diode into the 3V3 rail; the current is small, but it still exceeds the voltage rating.', v);
  }
  return '';
}

/** Estimate for one fault: solve each case, keep the largest current (worst case). */
export function estimateNet(x: FaultExports, net: FaultNet, s3: boolean): FaultEstimate | undefined {
  let best: { r: FaultRaw; what: string } | undefined;
  for (const c of net.cases) {
    const r = solveRaw(x, net.kind, c.args, s3);
    if (!Number.isFinite(r.i)) continue;
    if (!best || Math.abs(r.i) > Math.abs(best.r.i)) best = { r, what: c.what };
  }
  if (!best) return undefined;
  return { mA: Math.round(Math.abs(best.r.i) * 1e4) / 10, what: best.what, text: consequence(net.kind, best.r) };
}

/** Each fault (rule + wires + net params) is solved once. */
export const faultKey = (f: WireFault, s3: boolean) => `${s3 ? 's3' : 'c3'}|${f.rule}|${f.wires.join(',')}|${JSON.stringify(f.net ?? null)}`;

let exP: Promise<FaultExports> | null = null;
const cache = new Map<string, FaultEstimate | undefined>();

/** Fill in cached estimates synchronously (no flicker on redraw); done is false if any are missing. */
export function applyCached(faults: WireFault[], s3: boolean): { faults: WireFault[]; done: boolean } {
  let done = true;
  const out = faults.map((f) => {
    if (!f.net) return f;
    const k = faultKey(f, s3);
    if (!cache.has(k)) {
      done = false;
      return f;
    }
    const e = cache.get(k);
    return e ? { ...f, estimate: e } : f;
  });
  return { faults: out, done };
}

/** Browser: the stateless solver exports (same cached wasm file as the simulator), loaded once. */
function faultWasm(): Promise<FaultExports> {
  exP ??= import('../assets').then(async ({ loadWasmModule }) => {
    const instance = await WebAssembly.instantiate(await loadWasmModule(), {});
    return instance.exports as unknown as FaultExports;
  });
  return exP;
}

/** Part card (H-13): GPIO-high LED current (A) through `ohm` with knee `vf` (tb_fault kind 3, b = Vf). */
export async function ledCurrent(ohm: number, vf: number, s3: boolean): Promise<number> {
  return solveRaw(await faultWasm(), 3, [ohm, vf], s3).i;
}

/** Browser: lazy-load the wasm (same cached file as the simulator) and add estimates to faults with a net. */
export async function enrichFaults(faults: WireFault[], s3: boolean): Promise<WireFault[]> {
  if (!faults.some((f) => f.net)) return faults;
  const x = await faultWasm();
  for (const f of faults) if (f.net && !cache.has(faultKey(f, s3))) cache.set(faultKey(f, s3), estimateNet(x, f.net, s3));
  return applyCached(faults, s3).faults;
}
