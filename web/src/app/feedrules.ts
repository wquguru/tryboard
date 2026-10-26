// Pure pieces of the H-16 feed rules (servo / strip / ADC), kept out of lessonfeed.tsx so node tests can load them.
// Servo rows come from LEDC io events; strip and ADC rows from worker ticks (the io trace has no lit count or ADC samples).

/** Commanded servo angle from one LEDC event (b = duty × 65535, v = Hz × 1000); null when no pulse is going out. */
export function servoPulse(b: number, v: number): { deg: number; us: number } | null {
  if (b <= 0 || b >= 65535 || v <= 0) return null;
  const us = (b / 65535 / (v / 1000)) * 1e6;
  // Same mapping as the 3D arm (views/common servoAngle): 0.5 ms = 0°, 2.5 ms = 180°
  const deg = Math.max(0, Math.min(180, Math.round(((us - 500) / 2000) * 180)));
  return { deg, us: Math.round(us) };
}

/** LEDs with any colour channel above 0 in one WS2812 frame. */
export const litCount = (leds: number[][]) => leds.filter((c) => c.some((x) => x > 0)).length;

/** Should a new ADC reading make a row: the first one, or one that moved at least `step` codes from the last row. */
export const adcMoved = (last: number | undefined, raw: number, step: number) => last === undefined || Math.abs(raw - last) >= step;
