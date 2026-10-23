// Bench wiring rules (P0-12): check every actual bench wire (scene-derived + rewired) for burn / no-work faults.
// Shop rules (catalog/rules.ts) check the list + template wiring; both share voltage conventions and sources. Pure function.
import type { PartSpec } from '../board3d';
import { isI2cMod } from '../bench3d/spec.ts';
import { t } from '../i18n/index.ts';
import { RULE_BY_ID, netVolt, type Confidence } from '../catalog/rulemeta.ts';
import { i2cBuses, partId, partInfo, type BenchWire } from './wiring.ts';
import { i2cLoad, i2cText } from './harness.ts';

/** Fault netlist (P2-14) for the elec solver (faultsolve.ts → wasm tb_fault); kind matches tb_fault */
export interface FaultNet {
  /** 1 part output vs GPIO; 2 two parts fighting; 3 LED + series R (Ω); 4 rail to GND; 5 5 V via R into GPIO (clamp) */
  kind: 1 | 2 | 3 | 4 | 5;
  /** Solved once per case, worst (largest current) wins; args map to tb_fault a, b, c, d */
  cases: { args: number[]; what: string }[];
}

/** Solver estimate (mA and consequence), set once it arrives */
export interface FaultEstimate {
  mA: number;
  /** Which case was worst (pot turned fully…) */
  what: string;
  text: string;
}

export interface WireFault {
  rule: 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7' | 'W8';
  level: 'block' | 'warn';
  title: string;
  /** Wires to highlight (3D bench wire ids) */
  wires: string[];
  /** Short label drawn on the wire */
  short: string;
  detail: string;
  source: string;
  confidence: Confidence;
  net?: FaultNet;
  estimate?: FaultEstimate;
}

export const WIRE_RULES: Record<WireFault['rule'], { title: string; source: string; confidence: Confidence }> = {
  // confidence values are the Confidence enum of catalog/rules.ts (machine values, rendered via confOfRule)
  W1: { title: t('Output wired to output'), source: t('ESP32-C3 / S3 datasheet, GPIO drive strength; two push-pull outputs tied together short out'), confidence: '数据手册' }, // lint: allow-cjk
  W2: { title: t('5 V into GPIO'), source: t(RULE_BY_ID.R17.source), confidence: RULE_BY_ID.R17.confidence },
  W3: { title: t('LED without current-limiting resistor'), source: t('5 mm LED spec (20 mA rated); ESP32 datasheet GPIO drive current'), confidence: '数据手册' }, // lint: allow-cjk
  W4: { title: t('Ground not connected'), source: t('Circuit basics: without a common ground the signal has no reference level'), confidence: '经验规则' }, // lint: allow-cjk
  W5: { title: t('I2C address conflict'), source: t(RULE_BY_ID.R15.source), confidence: RULE_BY_ID.R15.confidence },
  W7: { title: t('Power short'), source: t('Circuit basics: a rail tied straight to ground; current solved by elec (USB port 500 mA limit, onboard LDO; parameters in DECISIONS, electrical model)'), confidence: '估算' }, // lint: allow-cjk
  W8: { title: t('I2C pins differ from the firmware'), source: t('Simulation: the firmware routed its I2C controller to these pads (GPIO matrix); devices on other pads never see the bus'), confidence: '数据手册' }, // lint: allow-cjk
  W6: { title: t('I2C wire too long'), source: t('I2C spec UM10204 §7.1: t_r = 0.8473·R·C, 300 ns max at 400 kHz; 1 pF/cm wire capacitance and 10 kΩ module pull-ups are estimates'), confidence: '必须上真机' }, // lint: allow-cjk
};

/** Part-side output drive for the P2-14 solver (estimate): hi / lo = [volts, source Ω]. Pots / contacts use the worst
 *  case (wiper at the end, contact closed, 1 Ω); CMOS push-pull is assumed similar to the ESP32 default drive */
export function driverModel(type: string | undefined, pin: string, divider?: boolean): { hi?: [number, number]; lo?: [number, number]; what: string } {
  if (type === 'pot') return { hi: [3.3, 1], lo: [0, 1], what: t('Pot wiper at the end (≈ tied straight to 3V3 / GND)') };
  if (type === 'encoder') return { hi: [3.3, 10_000], lo: [0, 1], what: t('Encoder {pin} contact closed to ground', { pin }) };
  if (type === 'hcsr04') return divider === false ? { hi: [5, 50], lo: [0, 50], what: t('HC-SR04 Echo direct (5 V push-pull, about 50 Ω)') } : { hi: [3.33, 667], lo: [0, 667], what: t('HC-SR04 Echo via 1k / 2k divider') };
  return { hi: [3.3, 33], lo: [0, 35.36], what: t('{pin} push-pull output', { pin }) };
}

const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

/** `fw`: pads the running firmware drove its I2C controllers on (session.i2cFw); W8 stays silent until it is known */
export function checkWiring(parts: PartSpec[], wires: BenchWire[], fw: { sda: number; scl: number }[] = []): WireFault[] {
  const out: WireFault[] = [];
  const live = wires.filter((w) => !w.missing);
  const name = (pid: string) => {
    const p = parts.find((x) => partId(x) === pid);
    return p ? partInfo(p).name : pid;
  };
  const typeOf = (pid: string) => parts.find((x) => partId(x) === pid)?.type;
  const push = (rule: WireFault['rule'], level: WireFault['level'], ws: string[], short: string, detail: string, net?: FaultNet) =>
    out.push({ rule, level, title: WIRE_RULES[rule].title, wires: ws, short, detail, source: WIRE_RULES[rule].source, confidence: WIRE_RULES[rule].confidence, ...(net ? { net } : {}) });

  // W1: a part drives the GPIO net (pot wiper etc.) while the GPIO also drives a load, or two parts drive it
  const byNet = new Map<string, BenchWire[]>();
  for (const w of live) if (/^GPIO\d+$/.test(w.a)) byNet.set(w.a, [...(byNet.get(w.a) ?? []), w]);
  for (const [net, ws] of byNet) {
    const drivers = ws.filter((w) => w.pinRole === 'drive');
    const loads = ws.filter((w) => w.pinRole === 'load');
    // Solver: part output vs GPIO (both polarities), or one part high vs the other low
    const models = drivers.map((w) => driverModel(typeOf(w.part), w.pin, w.divider));
    const cases: FaultNet['cases'] = [];
    let fnet: FaultNet;
    if (loads.length) {
      for (const m of models) for (const d of [m.hi, m.lo]) if (d) cases.push({ args: d, what: t('{what}, GPIO drives the opposite level', { what: m.what }) });
      fnet = { kind: 1, cases };
    } else {
      for (const a of models) for (const b of models) if (a !== b && a.hi && b.lo) cases.push({ args: [...a.hi, ...b.lo], what: t('{a} pulls high, {b} pulls low', { a: a.what, b: b.what }) });
      fnet = { kind: 2, cases };
    }
    if (drivers.length >= 2 || (drivers.length && loads.length))
      push(
        'W1',
        'block',
        [...drivers, ...loads].map((w) => w.id),
        t('{net}: both sides are outputs', { net }),
        loads.length
          ? t('On {net}, {drivers} drive a level while the firmware also drives {loads} from {net}: one high and one low is a short and can burn the GPIO. Split them onto two GPIOs.', { net, drivers: drivers.map((w) => name(w.part)).join(', '), loads: loads.map((w) => name(w.part)).join(', ') })
          : t('On {net}, {drivers} all drive a level, two outputs tied together: one high and one low is a short and can burn the GPIO. Split them onto two GPIOs.', { net, drivers: drivers.map((w) => name(w.part)).join(', ') }),
        fnet,
      );
  }

  // W2: module powered from 5 V, so its pull-ups / outputs reach 5 V and feed a GPIO
  for (const pid of new Set(live.map((w) => w.part))) {
    const own = live.filter((w) => w.part === pid);
    const vcc = own.find((w) => w.pinRole === 'power');
    // Outputs divided down to 3.3 V don't count (HC-SR04 Echo 1 kΩ / 2 kΩ)
    // HC-SR501 runs off its own 3.3 V regulator, so OUT stays 3.3 V on a 5 V supply (F-04a)
    const sig = own.filter((w) => (w.pinRole === 'bus' || w.pinRole === 'drive') && /^GPIO\d+$/.test(w.a) && w.divider !== true && typeOf(pid) !== 'pir');
    const v = netVolt(vcc?.a ?? null);
    // Solver: 5 V via module pull-up (I2C 10 kΩ estimate, as W6) or push-pull (driverModel high Ω) into the clamp diode
    const clamp: FaultNet = {
      kind: 5,
      cases: sig.map((w) => (w.pinRole === 'bus' ? { args: [10_000], what: t('{pin} pulled up to 5 V through the module 10 kΩ', { pin: w.pin }) } : { args: [driverModel(typeOf(pid), w.pin, w.divider).hi?.[1] ?? 33], what: t('{pin} outputs a 5 V high', { pin: w.pin }) })),
    };
    if (vcc && v !== null && v > 3.6 && sig.length) push('W2', 'block', [vcc.id, ...sig.map((w) => w.id)], t('5 V into GPIO'), t("{part} {pin} is on {net} ({v} V), so its {sigs} pull-ups or outputs are also {v} V and go straight into {gpios}; ESP32 pins aren't 5 V tolerant. Move it to 3V3 or add a level shifter.", { part: name(pid), pin: vcc.pin, net: vcc.a, v, sigs: sig.map((w) => w.pin).join(', '), gpios: sig.map((w) => w.a).join(', ') }), clamp);
  }
  // Signal wire plugged straight into 5 V (GPIO end moved to 5V)
  for (const w of live) {
    if (w.pinRole === 'power' || w.pinRole === 'gnd') continue;
    const v = netVolt(w.a);
    if (v !== null && v > 3.6 && w.from && /^GPIO\d+$/.test(w.from)) push('W2', 'block', [w.id], t('5 V into GPIO'), t('{part} {pin} was moved to {net}; it was on {from}.', { part: name(w.part), pin: w.pin, net: w.a, from: w.from }));
  }

  // W3: LED straight on a GPIO with no series resistor
  for (const w of live) if (w.ohm === 0) push('W3', 'block', [w.id], t('LED without current-limiting resistor'), t('{part} is wired straight to {net}: 3.3 V minus the LED drop leaves about 1.2 V across the GPIO driver, far above 20 mA (estimate); the LED and pin may both fail. Add a 220 Ω–1 kΩ resistor.', { part: name(w.part), net: w.a }), { kind: 3, cases: [{ args: [0], what: t('{net} drives a red LED high with no resistor', { net: w.a }) }] });

  // W7: rail tied to ground (jumper from 3V3 / 5V / external 5 V to GND)
  const RAIL: Record<string, number> = { '3V3': 0, '5V': 1, EXT5V: 2 };
  for (const w of live) {
    if (w.part !== 'jumper') continue;
    const [r, g] = w.a === 'GND' ? [w.b, w.a] : [w.a, w.b];
    if (g !== 'GND' || RAIL[r] === undefined) continue;
    push('W7', 'block', [w.id], t('{rail} shorted to GND', { rail: r }), t('A jumper ties {rail} straight to GND: the supply is shorted and current is limited only by the source and wire resistance; the board browns out and the wire and regulator get hot. Remove this wire.', { rail: r }), { kind: 4, cases: [{ args: [RAIL[r]], what: t('{rail} to ground via a jumper (about 0.05 Ω)', { rail: r }) }] });
  }

  // W4: part has no ground (ground wire pulled)
  for (const pid of new Set(wires.map((w) => w.part))) {
    const own = wires.filter((w) => w.part === pid);
    if (!own.some((w) => w.pinRole === 'gnd')) continue;
    if (own.some((w) => w.pinRole === 'gnd' && !w.missing && w.a === 'GND')) continue;
    const g = own.filter((w) => w.pinRole === 'gnd');
    push('W4', 'block', g.map((w) => w.id), t('Ground not connected'), t("{part} GND isn't connected to the board GND: with no common reference, readings jump around or nothing works. Plug the ground wire back in.", { part: name(pid) }));
  }

  // W5: two devices with the same address on one I2C bus
  const buses = new Map<string, { pid: string; addr: number }[]>();
  for (const p of parts) if (p.type === 'oled' || p.type === 'bme280' || p.type === 'mpu6050' || p.type === 'qmi8658' || p.type === 'cst816s' || isI2cMod(p)) {
    const k = `${p.sda}/${p.scl}`;
    buses.set(k, [...(buses.get(k) ?? []), { pid: partId(p), addr: p.addr }]);
  }
  for (const list of buses.values()) {
    const by = new Map<number, string[]>();
    for (const x of list) by.set(x.addr, [...(by.get(x.addr) ?? []), x.pid]);
    for (const [addr, who] of by) {
      if (who.length < 2) continue;
      const ws = live.filter((w) => who.includes(w.part) && w.pinRole === 'bus' && w.pin === 'SDA').map((w) => w.id);
      push('W5', 'block', ws, t('Address {addr} conflict', { addr: hex(addr) }), t('{parts} are all {addr} on the same SDA / SCL: both answer at once and readings get garbled. Change one address jumper (BME280 0x76 / 0x77, SSD1306 0x3C / 0x3D, MPU6050 AD0 0x68 / 0x69, QMI8658 SA0 0x6B / 0x6A).', { parts: who.map(name).join(', '), addr: hex(addr) }));
    }
  }
  // W6: long wires add bus capacitance and rise time exceeds the I2C spec (P2-11, estimate; the core uses the same formula)
  for (const b of i2cBuses(parts, live)) {
    const l = i2cLoad(b.wireCm, b.parts.length);
    if (l.verdict === 'ok') continue;
    push('W6', l.verdict === 'fail' ? 'block' : 'warn', b.wires, t('Rise {ns} ns', { ns: l.rise.toFixed(0) }), t('SDA wiring for {parts} totals {cm} cm (estimate, verify on hardware): {verdict}.', { parts: b.parts.map(name).join(', '), cm: b.wireCm.toFixed(0), verdict: i2cText(l) }));
  }
  // W8 (P2-16): a part's SDA / SCL wires (after rewiring) aren't the pads the firmware drives; bit-banged buses aren't seen
  for (const p of fw.length ? parts : []) {
    if (!('sda' in p) || !('addr' in p)) continue;
    const own = live.filter((w) => w.part === partId(p) && w.pinRole === 'bus');
    const at = (pin: string) => Number(/^GPIO(\d+)$/.exec(own.find((w) => w.pin === pin)?.a ?? '')?.[1] ?? NaN);
    const [sda, scl] = [at('SDA'), at('SCL')];
    if (Number.isNaN(sda) || Number.isNaN(scl) || fw.some((f) => f.sda === sda && f.scl === scl)) continue;
    const swapped = fw.find((f) => f.sda === scl && f.scl === sda);
    const f = swapped ?? fw[0];
    const args = { part: partInfo(p).name, addr: hex(p.addr), fsda: f.sda, fscl: f.scl, sda, scl };
    const ws = own.filter((w) => w.pin === 'SDA' || w.pin === 'SCL').map((w) => w.id);
    if (swapped) push('W8', 'warn', ws, t('SDA / SCL swapped'), t("{part} ({addr}) has SDA and SCL swapped: the firmware drives SDA on GPIO{fsda} and SCL on GPIO{fscl}, so a scan won't find it. Swap the two wires.", args));
    else push('W8', 'warn', ws, t('Firmware uses GPIO{fsda} / GPIO{fscl}', args), t("{part} ({addr}) is on SDA GPIO{sda} / SCL GPIO{scl}, but the firmware drives I2C on SDA GPIO{fsda} / SCL GPIO{fscl}, so a scan won't find it. Move the wires, or change the pins in the firmware.", args));
  }
  return out;
}

/** First fault per wire (the 3D highlight shows one sentence per wire) */
export function faultByWire(faults: WireFault[]): Map<string, WireFault> {
  const m = new Map<string, WireFault>();
  for (const f of faults) for (const w of f.wires) if (!m.has(w)) m.set(w, f);
  return m;
}
