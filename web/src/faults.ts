// Fault checkpoints (F-05): a bench that starts broken, plus the switches a player may change to fix it.
// Same merge rules as merge_args / fault_level in tools/check.py, so web and CLI run identical args (same fingerprint).
import type { Level } from './checks';
import type { SceneSpec } from './bench3d/spec';

export interface FaultKnob {
  /** CLI flag taking one value (--i2c-wire / --antenna-loss / --power / --servo / --i2c-bus) */
  flag: string;
  name: string;
  options: { v: string; label: string }[];
}

export interface Fault {
  /** The bench as found, laid over the level's args */
  args?: string[];
  /** Reference bench fix (check.py --ref runs it and expects PASS) */
  fix?: string[];
  /** Reference firmware fix (check.py --ref runs it on the bench as found) */
  fix_ref?: string;
  knobs?: FaultKnob[];
}

/** Flag/value pairs over args: a flag already there gets the new value, others append */
export function mergeArgs(base: string[], overlay: string[]): string[] {
  const out = [...base];
  for (let i = 0; i + 1 < overlay.length; i += 2) {
    const k = overlay[i];
    const j = out.indexOf(k);
    if (j >= 0 && j + 1 < out.length) out[j + 1] = overlay[i + 1];
    else out.push(k, overlay[i + 1]);
  }
  return out;
}

/** Knob values as found: each knob's value in fault.args, else its first option */
export function foundKnobs(l: Level): Record<string, string> {
  const f = l.fault ?? {};
  const args = mergeArgs(l.args ?? [], f.args ?? []);
  return Object.fromEntries((f.knobs ?? []).map((k) => {
    const i = args.indexOf(k.flag);
    return [k.flag, i >= 0 ? args[i + 1] : k.options[0]?.v ?? ''];
  }));
}

/** Knob values as CLI flags, in knob order */
export function knobFlags(l: Level, values: Record<string, string>): string[] {
  return (l.fault?.knobs ?? []).flatMap((k) => (values[k.flag] === undefined ? [] : [k.flag, values[k.flag]]));
}

/** The fault checkpoint as a plain level: bench as found, then the player's switches */
export function faultLevel(l: Level, values: Record<string, string> = {}): Level {
  if (!l.fault) return l;
  const args = mergeArgs(mergeArgs(l.args ?? [], l.fault.args ?? []), knobFlags(l, values));
  return { ...l, args };
}

/** Check command with the current switches (bench firmware → --ref, else the player's .bin) */
export function faultCommand(l: Level, values: Record<string, string>, own: boolean): string {
  const k = knobFlags(l, values).join(' ');
  return `tools/check.py ${own ? 'app.bin' : '--ref'} --level ${l.id}${k ? ' ' + k : ''}`;
}

/** Bench parts moved by `--i2c-bus` switches (G-02): each listed kind@addr goes to that SDA / SCL, so the 3D wires,
 *  the wiring check (W8) and the live sim match the check run. null = scene already matches */
export function faultScene(scene: SceneSpec, l: Level, values: Record<string, string>): SceneSpec | null {
  const at = new Map<number, { kind: string; sda: number; scl: number }>();
  for (const k of l.fault?.knobs ?? []) {
    if (k.flag !== '--i2c-bus' || values[k.flag] === undefined) continue;
    const [pins, devs = ''] = values[k.flag].split(':');
    const kv = Object.fromEntries(pins.split(',').map((x) => x.split('=')));
    for (const d of devs.split(',').filter(Boolean)) {
      const [kind, addr] = d.split('@');
      at.set(parseInt(addr, 16), { kind, sda: Number(kv.sda), scl: Number(kv.scl) });
    }
  }
  let moved = false;
  const parts = scene.parts.map((p) => {
    if (!('sda' in p) || !('addr' in p)) return p;
    const m = at.get(p.addr);
    // Scene type oled carries an SSD1306 / SH1106; other I2C parts use the CLI kind as their type
    if (!m || !(p.type === m.kind || (p.type === 'oled' && /^(ssd1306|sh1106)$/.test(m.kind)))) return p;
    if (p.sda === m.sda && p.scl === m.scl) return p;
    moved = true;
    return { ...p, sda: m.sda, scl: m.scl };
  });
  return moved ? { ...scene, parts } : null;
}
