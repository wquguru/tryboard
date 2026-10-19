// Plain-language layer of results (DESIGN_V2 §9): verdict words, device names, headline summaries. Pure, so the CLI package can import it.
// The first layer is plain language only; the CLI-identical lines (CheckResult.text) go under "Raw data".
import { t } from '../i18n/index.ts';

/** Only four verdict words; colors in DESIGN_V2 §9.2 */
export const VERDICT = { ok: t('Pass'), bad: t('Fail'), stall: t('Did not finish'), shifted: t('Changed in the case') } as const;
export type Verdict = keyof typeof VERDICT;

/** Common I2C address -> chip name (unknown ones are "I2C device") */
const CHIP_AT: Record<number, string> = { 0x76: 'BME280', 0x77: 'BME280', 0x3c: 'SSD1306 screen', 0x3d: 'SSD1306 screen', 0x68: 'MPU6050', 0x69: 'MPU6050' };
export const chipAt = (addr: number) => t(CHIP_AT[addr] ?? 'I2C device');

/** What sits on a PWM pin: servos run at 50 Hz, buzzers in the audible band */
export function pwmDevice(freq: number, beeps: boolean): 'servo' | 'buzzer' | 'other' {
  if (Math.abs(freq - 50) <= 1) return 'servo';
  if (beeps || (freq >= 100 && freq <= 20000)) return 'buzzer';
  return 'other';
}

/** Servo pulse-width error as an angle: 0.5–2.5 ms spans 180° (SG90 class) */
export const servoDeg = (dms: number) => Math.round(Math.abs(dms) * 90);

/** A required count in plain words: 2 / at least 4 / 2–5 */
export function want(min: number, max?: number) {
  if (max === undefined) return t('at least {n}', { n: min });
  return min === max ? `${min}` : `${min}–${max}`;
}

type Row = { ok: boolean | null; say?: string; text: string; tag?: string; dev?: string };

/** One group per device (DESIGN_V2 §9.5): device name and pin written once; time windows and numbers stay in raw data */
export interface RowGroup<R extends Row = Row> {
  dev: string;
  /** Pin / address chip; hidden when it means the same as the device name (serial, USB, round LCD) */
  pin?: string;
  rows: R[];
  bad: R[];
  /** One sentence when two or more rows failed; a single failure uses its own say */
  sum?: string;
}

// Matched on the language-independent raw text, so the summary works in every UI language
const SILENT = /^GPIO\d+ (?:\S+ s beeped 0 times|has no PWM output)/;

export function groupRows<R extends Row>(rows: R[]): RowGroup<R>[] {
  const by = new Map<string, RowGroup<R>>();
  for (const r of rows) {
    const dev = r.dev ?? r.tag ?? t('Other');
    const key = `${dev}|${r.tag ?? ''}`;
    let g = by.get(key);
    if (!g) {
      g = { dev, pin: r.tag && r.tag !== dev ? r.tag : undefined, rows: [], bad: [] };
      by.set(key, g);
    }
    g.rows.push(r);
    if (r.ok === false) g.bad.push(r);
  }
  const out = [...by.values()];
  for (const g of out) {
    if (g.bad.length < 2) continue;
    // A buzzer whose every failure is "no sound / no signal" never beeped; otherwise just count, details below
    const silent = g.bad.every((r) => SILENT.test(r.text));
    g.sum = silent && g.dev === t('Buzzer') ? t('Buzzer never beeped') : t('{dev}: {n} problems', { dev: g.dev, n: g.bad.length });
  }
  // Failed groups first, order inside a group unchanged
  return out.sort((a, b) => Number(!a.bad.length) - Number(!b.bad.length));
}

/** Headline for a set of results (≤ 1.5 lines on a phone): all passed, or the one failing device's story, or a device count */
export function headline(rows: Row[]) {
  const judged = rows.filter((r) => r.ok !== null);
  if (!judged.some((r) => r.ok === false)) return judged.length > 1 ? t('All {n} checks passed', { n: judged.length }) : t('All passed');
  const bad = groupRows(rows).filter((g) => g.bad.length);
  if (bad.length > 1) return t('{n} devices have problems', { n: bad.length });
  return bad[0].sum ?? bad[0].bad[0].say ?? bad[0].bad[0].text;
}
