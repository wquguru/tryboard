import { t } from '../i18n/index.ts';

/** D-06: "test these first when the board arrives", generated from the project's parts, serial and result rows */
export interface CheckItem {
  /** Stable English id, stored in localStorage so ticks survive a language switch */
  key: string;
  title: string;
  how: string;
  why: string;
  minutes: number;
}

export interface ChecklistInput {
  /** Project-specific first steps (already translated): [title, how] */
  first: [string, string][];
  /** Scene part types on the bench (pot, servo, ws2812, dht11, …) */
  parts: string[];
  /** Serial output of the last run */
  serial: string;
  /** Result rows the card marked "needs real hardware" */
  mustReal: { text: string; note?: string }[];
}

interface Rule {
  key: string;
  when: (i: ChecklistInput) => boolean;
  item: () => Omit<CheckItem, 'key'>;
}

const has = (i: ChecklistInput, ...types: string[]) => i.parts.some((p) => types.includes(p));

// Ordered by how often each one bites first-time builders (docs/PITFALLS.md)
const RULES: Rule[] = [
  {
    key: 'wifi-rssi',
    when: (i) => /\bwifi:/.test(i.serial),
    item: () => ({ title: t('Is the Wi-Fi signal strong enough'), how: t('Put the board where it will really live and read RSSI on serial: above -75 dBm is stable. Also make sure the router offers 2.4 GHz.'), why: t('The signal strength in the simulator is a number you set.'), minutes: 5 }),
  },
  {
    key: 'timing',
    when: (i) => has(i, 'dht11') || i.mustReal.length > 0,
    item: () => ({ title: t('Are single-wire readings stable'), how: t('Read the sensor 100 times in a row and count checksum failures: fewer than 2 passes.'), why: t('The firmware times pulses with busy-wait loops, and a real CPU runs at a different speed than the simulator.'), minutes: 5 }),
  },
  {
    key: 'adc-cal',
    when: (i) => has(i, 'pot', 'soil', 'ldr', 'ntc') || /\badc_cali|ADC\d? ?raw/i.test(i.serial),
    item: () => ({ title: t('Calibrate the analog readings'), how: t('Measure the pin voltage with a multimeter at both ends and the middle, compare with serial, and write your end points (e.g. DRY / WET) into the code.'), why: t('The ADC is modelled on a typical chip; every chip and sensor is a little different.'), minutes: 10 }),
  },
  {
    key: 'peak-current',
    when: (i) => has(i, 'servo', 'ws2812', 'max98357a'),
    item: () => ({ title: t('Does USB power hold at peak load'), how: t('Put a USB power meter inline, move the servo / turn the LEDs full white / play loud, and watch for resets or flicker.'), why: t('Supply current is estimated from datasheets (about ±30 %), not measured.'), minutes: 5 }),
  },
  {
    key: 'audio',
    when: (i) => has(i, 'inmp441', 'max98357a', 'buzzer'),
    item: () => ({ title: t('Listen for noise and volume'), how: t('Play the test sound at low and full volume; hiss or clicks usually mean a shared ground or a long data wire.'), why: t('Audio here is clean digital samples; analog noise and speaker response are not simulated.'), minutes: 5 }),
  },
  {
    key: 'imu-bias',
    when: (i) => has(i, 'mpu6050', 'qmi8658'),
    item: () => ({ title: t('Measure the IMU bias at rest'), how: t('Leave it flat for a minute and log pitch / roll: subtract the average in the firmware.'), why: t('The simulator reads exactly the pose you set, with no noise or bias.'), minutes: 5 }),
  },
];

export function buildChecklist(i: ChecklistInput): CheckItem[] {
  const out: CheckItem[] = i.first.map(([title, how], n) => ({ key: `first:${n}`, title, how, why: t('Boards and modules differ between sellers and revisions.'), minutes: 5 }));
  for (const r of RULES) if (r.when(i)) out.push({ key: r.key, ...r.item() });
  const seen = new Set<string>();
  for (const row of i.mustReal) {
    if (seen.has(row.text)) continue;
    seen.add(row.text);
    out.push({ key: `row:${row.text}`, title: t('Recheck: {text}', { text: row.text }), how: row.note ?? t('Repeat this check on the real board.'), why: t('The result card marks this row as needing real hardware.'), minutes: 5 });
  }
  return out;
}

/** Plain text for "Copy list": checkbox, number, how and why on indented lines */
export function checklistText(title: string, items: CheckItem[], done: string[]): string {
  const lines = [title, ''];
  items.forEach((it, n) => {
    lines.push(`[${done.includes(it.key) ? 'x' : ' '}] ${n + 1}. ${it.title} (${t('{n} min', { n: it.minutes })})`);
    lines.push(`    ${it.how}`);
    lines.push(`    ${t("Why it can't be simulated: {why}", { why: it.why })}`);
  });
  return lines.join('\n') + '\n';
}
