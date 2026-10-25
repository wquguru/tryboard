// LED colour / series resistor parameters for the part card and 3D (H-13). All values are estimates.
export type LedColor = 'red' | 'green' | 'blue';

export const LED_HEX: Record<LedColor, number> = { red: 0xff2a1a, green: 0x22e04a, blue: 0x2a6bff };
/** Knee voltages, same as core/crates/elec/src/fault.rs LED_VF / LED_VF_GREEN / LED_VF_BLUE */
export const LED_VF: Record<LedColor, number> = { red: 1.8, green: 2.0, blue: 2.8 };
export const LED_OHMS = [100, 220, 330, 470, 1000, 2200, 10000] as const;
export const LED_OHM_DEFAULT = 220;

/** Unknown hex values count as red (the default lens colour). */
export const ledColor = (hex?: number): LedColor => (hex === LED_HEX.green ? 'green' : hex === LED_HEX.blue ? 'blue' : 'red');

/** 1000 → "1k", 2200 → "2.2k", 220 → "220" */
export const ohmText = (ohm: number) => (ohm >= 1000 ? `${+(ohm / 1000).toFixed(1)}k` : `${ohm}`);

/** Closed form of elec::fault::led for its piecewise-linear diode: (3.3 − Vf) / (R_high 33 + R + R_d 10). */
export const ledAmps = (ohm: number, vf: number) => Math.max(0, (3.3 - vf) / (33 + Math.max(ohm, 1e-3) + 10));

/** 3D brightness gain vs the default red 220 Ω LED; sqrt because the eye compresses intensity, clamped so 100 Ω doesn't blow out. */
export const ledBright = (ohm: number, color: LedColor) =>
  Math.min(1.6, Math.max(0.05, Math.sqrt(ledAmps(ohm, LED_VF[color]) / ledAmps(LED_OHM_DEFAULT, LED_VF.red))));

const DIGIT = [0x1a1a1a, 0x6d4c41, 0xc62828, 0xef6c00, 0xfdd835, 0x2e7d32, 0x1565c0, 0x6a1b9a, 0x9e9e9e, 0xf5f5f5];

/** E12 four-band code (two digits, multiplier, gold tolerance) for ohm ≥ 10: 220 = red red brown, 1k = brown black red. */
export function resistorBands(ohm: number): number[] {
  const e = Math.max(0, Math.floor(Math.log10(Math.max(ohm, 10))) - 1);
  const sig = Math.round(ohm / 10 ** e);
  return [DIGIT[Math.floor(sig / 10) % 10], DIGIT[sig % 10], DIGIT[Math.min(9, e)], 0xc9a227];
}
