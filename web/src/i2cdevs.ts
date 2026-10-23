// I2C devices at power-up (P2-16): bench parts carry the SDA / SCL pads the user wired and sit on CLI --i2c-bus pin buses,
// so wrong pads mean the firmware can't find them; board presets and home cards stay pin-less on legacy --i2c (I2C0).
import type { WasmExports } from './wasm.gen';

export interface I2cDev {
  kind: string;
  addr: number;
  sda?: number;
  scl?: number;
}

const KIND: Record<string, number> = { ssd1306: 1, bme280: 2, mpu6050: 3, qmi8658: 4, cst816s: 5, ft6236: 6, cst9220: 7, axp2101: 8, pcf85063: 9, es8311: 10, es7210: 11, sh1106: 12, aht20: 13, ina219: 14, ds3231: 15 };
const item = (d: I2cDev) => `${d.kind}@0x${d.addr.toString(16)}`;
const pinned = (d: I2cDev): d is Required<I2cDev> => d.sda !== undefined && d.scl !== undefined;

/** Pinned devices grouped by (SDA, SCL), in first-seen order: one pin bus each */
function buses(list: I2cDev[]) {
  const out = new Map<string, { sda: number; scl: number; devs: I2cDev[] }>();
  for (const d of list.filter(pinned)) {
    const k = `${d.sda},${d.scl}`;
    if (!out.has(k)) out.set(k, { sda: d.sda, scl: d.scl, devs: [] });
    out.get(k)!.devs.push(d);
  }
  return [...out.values()];
}

/** CLI arguments: `--i2c` for pin-less devices, then one `--i2c-bus sda=N,scl=N:kind@addr,...` per pad pair (CLI order) */
export function i2cArgs(list: I2cDev[]): string[] {
  const legacy = list.filter((d) => !pinned(d));
  return [...(legacy.length ? ['--i2c', legacy.map(item).join(',')] : []), ...buses(list).flatMap((b) => ['--i2c-bus', `sda=${b.sda},scl=${b.scl}:${b.devs.map(item).join(',')}`])];
}

/** Attach like the CLI parses i2cArgs: legacy devices first, then pin buses; a refused bus (pads shared with another pair) is skipped */
export function attachI2c(e: WasmExports, list: I2cDev[]) {
  for (const d of list.filter((x) => !pinned(x))) e.tb_i2c_attach(KIND[d.kind] ?? 0, d.addr);
  for (const b of buses(list)) {
    const bus = e.tb_i2c_bus_add(b.sda, b.scl, 1);
    if (bus < 0) {
      console.warn(`--i2c-bus sda=${b.sda},scl=${b.scl}: pad already on another bus, devices not attached`);
      continue;
    }
    for (const d of b.devs) e.tb_i2c_attach_bus(bus, KIND[d.kind] ?? 0, d.addr);
  }
}

/** Pads the firmware routed I2C controllers 0 / 1 to (wasm tb_i2c_fw_pins); empty before any access */
export function fwI2cPins(e: WasmExports): { sda: number; scl: number }[] {
  if (!e.tb_i2c_fw_pins) return [];
  return [0, 1].flatMap((p) => {
    const v = e.tb_i2c_fw_pins(p);
    return v < 0 ? [] : [{ sda: v & 0xff, scl: (v >> 8) & 0xff }];
  });
}
