// Separate file so pure modules like app/wiring.ts (run by node --test) don't pull in three.js.
import type { ChipId } from './board3d';

/** Fixed I2S audio wiring per chip; the core uses it to tell whether speaker / mic are connected (see core i2s_pin).
 *  C3 has a single I2S, so speaker and mic share BCK / WS. */
export const I2S_WIRING: Record<ChipId, { spk: { bclk: number; lrc: number; din: number }; mic: { sck: number; ws: number; sd: number } }> = {
  esp32s3: { spk: { bclk: 16, lrc: 17, din: 18 }, mic: { sck: 39, ws: 40, sd: 41 } },
  esp32c3: { spk: { bclk: 0, lrc: 1, din: 2 }, mic: { sck: 0, ws: 1, sd: 3 } },
  // The core has no ESP32 I2S yet (outside C-05); common pins as placeholders.
  esp32: { spk: { bclk: 26, lrc: 25, din: 22 }, mic: { sck: 32, ws: 25, sd: 33 } },
};

type Wiring = (typeof I2S_WIRING)[ChipId];
/** Wiring of one I2S part: its own pins [bclk, ws, data] when the scene gives them (F-09b-2), else the chip default `def` */
export function spkPins(def: Wiring['spk'], p: { pins?: [number, number, number] }) {
  return p.pins ? { bclk: p.pins[0], lrc: p.pins[1], din: p.pins[2] } : def;
}
export function micPins(def: Wiring['mic'], p: { pins?: [number, number, number] }) {
  return p.pins ? { sck: p.pins[0], ws: p.pins[1], sd: p.pins[2] } : def;
}
