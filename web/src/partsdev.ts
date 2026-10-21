// F-04a: the F-04c / F-04d tutorial parts (DS18B20, PIR, relay, photoresistor, RC522) as one device bundle.
// Same flags as core/crates/cli/src/parts.rs and main.rs wire_sensor_args; shared by worker, simrun, inputlog and devs.
import type { WasmExports } from './wasm.gen.ts';
import { RC522_CS, type SimChip } from './chipid.ts';

export interface PartsDevs {
  /** --ds18b20 PIN,N: one 1-Wire bus with n probes (device i reads env + 0.5·i °C) */
  ds18b20?: { pin: number; n: number };
  /** --pir PIN,HOLD: HC-SR501 output, hold seconds (CLI default 5) */
  pir?: { pin: number; hold: number };
  /** --relay PIN[,low]: relay module IN, low = closes on a low input */
  relay?: { pin: number; low?: boolean };
  /** --ldr PIN,LUX: photoresistor divider on an ADC pad, initial light (CLI default 300 lux) */
  ldr?: { pin: number; lux: number };
  /** --spi rc522[@cs=N]: RC522 on SPI2; cs undefined = the chip default (C3 GPIO7, S3 GPIO10) */
  rc522?: { cs?: number };
}

export const PIR_HOLD_DEFAULT = 5;
export const LDR_LUX_DEFAULT = 300;
/** machine/src/parts.rs rc522_default_cs */
export const rc522DefaultCs = (chip: string | undefined) => RC522_CS[chip as SimChip] ?? 10;

/** True when nothing is attached (keeps logs and boot messages free of an empty object) */
export const partsEmpty = (p: PartsDevs | undefined) => !p || !(p.ds18b20 || p.pir || p.relay || p.ldr || p.rc522);

/** CLI --spi item for the RC522 ('rc522' when CS is the chip default) */
export function rc522Spec(p: PartsDevs | undefined, chip: string | undefined): string | undefined {
  if (!p?.rc522) return undefined;
  const cs = p.rc522.cs;
  return cs === undefined || cs === rc522DefaultCs(chip) ? 'rc522' : `rc522@cs=${cs}`;
}

/** CLI flags other than --spi (rc522 joins the --spi list in cliArgs) */
export function partsArgs(p: PartsDevs | undefined): string[] {
  if (!p) return [];
  const a: string[] = [];
  if (p.ds18b20) a.push('--ds18b20', p.ds18b20.n > 1 ? `${p.ds18b20.pin},${p.ds18b20.n}` : String(p.ds18b20.pin));
  if (p.pir) a.push('--pir', p.pir.hold === PIR_HOLD_DEFAULT ? String(p.pir.pin) : `${p.pir.pin},${p.pir.hold}`);
  if (p.relay) a.push('--relay', p.relay.low ? `${p.relay.pin},low` : String(p.relay.pin));
  if (p.ldr) a.push('--ldr', p.ldr.lux === LDR_LUX_DEFAULT ? String(p.ldr.pin) : `${p.ldr.pin},${p.ldr.lux}`);
  return a;
}

/** Inverse of partsArgs + the rc522 item of --spi (levels.json / accept args) */
export function partsFromArgs(val: (flag: string) => string | undefined): PartsDevs | undefined {
  const nums = (s: string) => s.split(',').map((x) => x.trim());
  const out: PartsDevs = {};
  const ds = val('--ds18b20');
  if (ds) {
    const [p, n] = nums(ds);
    out.ds18b20 = { pin: Number(p), n: n === undefined ? 1 : Number(n) };
  }
  const pir = val('--pir');
  if (pir) {
    const [p, h] = nums(pir);
    out.pir = { pin: Number(p), hold: h === undefined ? PIR_HOLD_DEFAULT : Number(h) };
  }
  const relay = val('--relay');
  if (relay) {
    const [p, l] = nums(relay);
    out.relay = { pin: Number(p), ...(l === 'low' ? { low: true } : {}) };
  }
  const ldr = val('--ldr');
  if (ldr) {
    const [p, l] = nums(ldr);
    out.ldr = { pin: Number(p), lux: l === undefined ? LDR_LUX_DEFAULT : Number(l) };
  }
  const rc = (val('--spi') ?? '').split(',').find((d) => d.startsWith('rc522'));
  if (rc) {
    const m = /@cs=(\d+)/.exec(rc);
    out.rc522 = m ? { cs: Number(m[1]) } : {};
  }
  return partsEmpty(out) ? undefined : out;
}

/** PIR or relay or DS18B20 attached: the CLI then runs 1 ms slices (main.rs has_parts / wire_sensors); the LDR alone does not */
export const partsTimed = (p: PartsDevs | undefined) => !!(p && (p.ds18b20 || p.pir || p.relay));

type Ex = Pick<WasmExports, 'memory' | 'tb_alloc' | 'tb_free'> & Partial<Pick<WasmExports, 'tb_ds18b20_attach' | 'tb_pir_attach' | 'tb_relay_attach' | 'tb_ldr_attach' | 'tb_lcd_attach_spec' | 'tb_part_action'>>;

function withText(e: Ex, s: string, f: (p: number, n: number) => number): number {
  const b = new TextEncoder().encode(s);
  const p = e.tb_alloc(b.length);
  new Uint8Array(e.memory.buffer, p, b.length).set(b);
  const r = f(p, b.length);
  e.tb_free(p, b.length);
  return r;
}

/** Screen by CLI --spi name (F-04a2 TFT panels; same call as --spi ili9341). Returns an error text or null */
export function attachLcdSpec(e: Ex, name: string): string | null {
  if (!e.tb_lcd_attach_spec) return `--spi ${name}: this wasm build has no tb_lcd_attach_spec`;
  return withText(e, name, (q, n) => e.tb_lcd_attach_spec!(q, n)) === 0 ? null : `--spi ${name}: rejected on this chip`;
}

/** Attach at power-up, before env_set (CLI order: wire sensors, parts, --env; --spi later). Returns an error text or null */
export function attachParts(e: Ex, p: PartsDevs | undefined, chip: string | undefined): string | null {
  if (!p) return null;
  if (p.ds18b20) e.tb_ds18b20_attach?.(p.ds18b20.pin, p.ds18b20.n);
  if (p.pir) e.tb_pir_attach?.(p.pir.pin, p.pir.hold);
  if (p.relay) e.tb_relay_attach?.(p.relay.pin, p.relay.low ? 0 : 1);
  if (p.ldr && e.tb_ldr_attach && e.tb_ldr_attach(p.ldr.pin, p.ldr.lux) !== 0) return `--ldr ${p.ldr.pin}: not an ADC pin on this chip`;
  const rc = rc522Spec(p, chip);
  if (rc && e.tb_lcd_attach_spec && withText(e, rc, (q, n) => e.tb_lcd_attach_spec!(q, n)) !== 0) return `--spi ${rc}: rejected (C3 / S3 only)`;
  return null;
}

/** Script action pir= / lux= / card= through the core; true = applied (unknown or rejected actions stay out of the log) */
export function partAction(e: Ex, act: string): boolean {
  if (!e.tb_part_action) return false;
  return withText(e, act, (q, n) => e.tb_part_action!(q, n)) === 0;
}
