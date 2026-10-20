// Advisor engine: pure functions from needs to boards, pins, BOM, power estimate and risks.
// Display-only outputs are translated here; labels that code matches on stay raw English.
import { BOARDS, CHIPS, PARTS, type Board, type Cap, type Chip, type Template } from './data.ts';
import { t } from '../i18n/index.ts';

export type Confidence = '仿真验证' | '行为模拟' | '估算' | '必须上真机'; // lint: allow-cjk

export interface Need {
  caps: Cap[];
  nice: Cap[];
  parts: string[];
  battery: boolean;
  duty?: Template['duty'];
  budget?: number;
  /** Must run in TryBoard first: simulated chips score much higher (others stay listed, run on a C3 instead) */
  sim?: boolean;
}

export interface PinAssign {
  label: string;
  pins: number[];
  note?: string;
}

export interface Plan {
  board: Board;
  chip: Chip;
  score: number;
  reasons: string[];
  warnings: string[];
  pins: PinAssign[];
  pinProblems: string[];
  bom: { name: string; qty: number; price: [number, number] }[];
  total: [number, number];
  power?: { avgMA: number; days: number; breakdown: string; confidence: Confidence };
  simCoverage: { part: string; level: Confidence }[];
}

export interface Rejected {
  board: Board;
  why: string;
}

/** Partly simulated chips: modeled peripheral kinds (other parts need real hardware). Classic ESP32 has GPIO, LEDC, I2C (Wi-Fi is not a part) */
const SIM_KINDS: Partial<Record<string, string[]>> = { esp32: ['gpio', 'pwm', 'i2c'] };

const CAP_NAME: Record<Cap, string> = {
  wifi: 'Wi-Fi',
  wifi6: 'Wi-Fi 6',
  ble: 'BLE',
  bt_classic: 'Classic Bluetooth',
  thread: 'Thread',
  zigbee: 'Zigbee',
  usb_otg: 'native USB OTG',
  usb_serial: 'USB serial',
  camera: 'camera interface',
  audio_in: 'digital microphone (I2S)',
  audio_out: 'audio output (I2S)',
  display_spi: 'SPI display',
  display_rgb: 'RGB parallel display',
  psram: 'PSRAM',
  ai_accel: 'AI vector instructions',
  touch: 'capacitive touch',
  dac: 'DAC',
  ethernet: 'Ethernet MAC',
  low_power: 'low power',
  many_gpio: 'plenty of GPIO',
};
export const capName = (c: Cap) => t(CAP_NAME[c]);
// Chip notes name the caps they concern in English, so matching uses the raw name.
const hasCamera = (b: Board) => b.extras.some((e) => e.includes('camera'));

function boardCaps(b: Board, c: Chip): Set<Cap> {
  const s = new Set(c.caps);
  if (b.psramMB === 0) s.delete('psram');
  // A camera needs an on-board connector: hand-wiring 16 DVP lines is not realistic
  if (!hasCamera(b)) s.delete('camera');
  return s;
}

/** Pin plan: avoid flash / PSRAM / USB / UART0 / on-board pins; strapping pins go last with a note. */
export function planPins(b: Board, c: Chip, parts: string[], needUsb: boolean) {
  const reserved = new Map<number, string>();
  c.pins.flash.forEach((p) => reserved.set(p, 'flash'));
  if (b.psramMB > 0) c.pins.psramOctal?.forEach((p) => reserved.set(p, 'octal PSRAM'));
  if (needUsb) c.pins.usb.forEach((p) => reserved.set(p, 'USB D-/D+'));
  reserved.set(c.pins.uart0[0], 'UART TX (flashing and logs)');
  reserved.set(c.pins.uart0[1], 'UART RX (flashing and logs)');
  for (const [p, why] of Object.entries(b.usedPins)) reserved.set(Number(p), why);

  // S3 numbers 0–21 and 26–48; the classic has no 20, 24, 28–31
  const exists = (p: number) => {
    if (c.id === 'esp32s3') return p <= 21 || (p >= 26 && p <= 48);
    if (c.id === 'esp32') return p <= 39 && ![20, 24, 28, 29, 30, 31].includes(p);
    return p < c.gpio;
  };
  // Small boards expose some pins in silkscreen order, so I2C etc. get the usual positions first
  const candidates = b.exposed ?? Array.from({ length: 55 }, (_, i) => i);
  const free = candidates.filter((p) => exists(p) && !reserved.has(p));
  const strap = new Set(c.pins.strapping);
  const usable = [...free.filter((p) => !strap.has(p)), ...free.filter((p) => strap.has(p))];
  const used = new Set<number>();
  const take = (n: number, pool: number[], outputOk = true): number[] | null => {
    const got: number[] = [];
    for (const p of pool) {
      if (got.length === n) break;
      if (used.has(p)) continue;
      if (outputOk && c.pins.inputOnly?.includes(p)) continue;
      got.push(p);
    }
    if (got.length < n) return null;
    got.forEach((p) => used.add(p));
    return got;
  };
  const out: PinAssign[] = [];
  const problems: string[] = [];
  let i2c: number[] | null = null;
  let spi: number[] | null = null;
  let i2s: number[] | null = null;
  for (const id of parts) {
    const part = PARTS[id];
    for (const n of part.needs) {
      if (n.kind === 'camera') {
        if (hasCamera(b)) out.push({ label: part.name, pins: [], note: t('On-board camera connector') });
        else problems.push(t('{part}: this board has no camera connector', { part: t(part.name) }));
        continue;
      }
      if (n.kind === 'usb') continue;
      if (n.kind === 'i2c') {
        if (!i2c && b.i2cPins && b.i2cPins.every((p) => !used.has(p) && !reserved.has(p))) {
          i2c = [...b.i2cPins];
          i2c.forEach((p) => used.add(p));
        }
        i2c ??= take(2, usable);
        if (!i2c) problems.push(t('{label}: not enough pins', { label: t(n.label) }));
        else out.push({ label: `${n.label} (I2C SDA / SCL, shared bus)`, pins: i2c });
        continue;
      }
      if (n.kind === 'spi') {
        spi ??= take(3, usable);
        if (!spi) problems.push(t('{label}: not enough pins', { label: t(n.label) }));
        else out.push({ label: `${n.label} (SPI SCK / MOSI / CS)`, pins: spi });
        continue;
      }
      if (n.kind === 'i2s') {
        // Microphone and amplifier can share BCLK / WS, each with its own data line
        if (!i2s) {
          i2s = take(2, usable);
          if (!i2s) {
            problems.push(t('{label}: not enough pins', { label: t(n.label) }));
            continue;
          }
        }
        const d = take(1, usable);
        if (!d) problems.push(t('{label}: not enough pins', { label: t(n.label) }));
        else out.push({ label: `${n.label} (I2S BCLK / WS / data)`, pins: [...i2s, ...d] });
        continue;
      }
      const base = n.kind === 'adc' ? c.pins.adc1.filter((p) => !reserved.has(p) && (!b.exposed || b.exposed.includes(p))) : usable;
      const pool = n.prefer ? [...n.prefer.filter((p) => base.includes(p) && !strap.has(p)), ...base] : base;
      const got = take(n.count ?? 1, pool, n.kind !== 'adc');
      if (!got) problems.push(n.kind === 'adc' ? t('{label}: no free ADC1 pin', { label: t(n.label) }) : t('{label}: not enough pins', { label: t(n.label) }));
      else
        out.push({
          label: n.label,
          pins: got,
          note: got.some((p) => strap.has(p)) ? t('Uses a strapping pin: if external circuitry pulls it the wrong way at power-up, the board will not boot normally') : undefined,
        });
    }
  }
  return { pins: out, problems, reserved };
}

function estimatePower(b: Board, c: Chip, parts: string[], duty: NonNullable<Template['duty']>, capacity = 1000) {
  // Active phase: Wi-Fi connect + send averages between RX and TX peak, taken as RX + 15% × (TX - RX)
  const radio = duty.wifi ? c.power.rx + 0.15 * (c.power.txPeak - c.power.rx) : c.power.modemSleep;
  const periph = parts.reduce((s, id) => s + (PARTS[id].activeMA ?? 0), 0);
  const activeMA = radio + Math.min(periph, 200);
  const activeFrac = (duty.wakePerHour * duty.activeSec) / 3600;
  const sleepMA = b.boardSleepUA / 1000;
  const avg = activeFrac * activeMA + (1 - activeFrac) * sleepMA;
  const days = (capacity * 0.85) / avg / 24;
  return {
    avgMA: avg,
    days,
    breakdown: t('Active {pct}% of the time at about {ma} mA; deep sleep otherwise, board about {ua} µA', { pct: (activeFrac * 100).toFixed(2), ma: activeMA.toFixed(0), ua: b.boardSleepUA }),
    confidence: '估算' as Confidence, // lint: allow-cjk
  };
}

export function recommend(need: Need): { plans: Plan[]; rejected: Rejected[] } {
  const plans: Plan[] = [];
  const rejected: Rejected[] = [];
  const partCaps = need.parts.flatMap((p) => PARTS[p].caps ?? []);
  const required = Array.from(new Set([...need.caps, ...partCaps]));
  for (const b of BOARDS) {
    const c = CHIPS.find((x) => x.id === b.chip)!;
    const caps = boardCaps(b, c);
    const missing = required.filter((k) => k !== 'low_power' && !caps.has(k));
    if (missing.length) {
      rejected.push({ board: b, why: t('Missing {caps}', { caps: missing.map(capName).join(t(', ')) }) });
      continue;
    }
    const reasons: string[] = [];
    const warnings: string[] = b.caveats.map((w) => t(w));
    let score = 50;
    const niceHit = need.nice.filter((k) => caps.has(k));
    if (niceHit.length) {
      score += niceHit.length * 8;
      reasons.push(t('Also supports {caps}', { caps: niceHit.map(capName).join(t(', ')) }));
    }
    if (need.battery || need.caps.includes('low_power')) {
      if (b.battery) {
        score += 20;
        reasons.push(t('On-board Li-ion charging, board deep sleep about {ua} µA', { ua: b.boardSleepUA }));
      } else {
        score -= Math.min(30, b.boardSleepUA / 50);
        warnings.push(t('Board deep sleep about {current}, so the battery will not last', { current: b.boardSleepUA >= 1000 ? (b.boardSleepUA / 1000).toFixed(0) + ' mA' : b.boardSleepUA + ' µA' }));
      }
    }
    const midPrice = (b.priceCNY[0] + b.priceCNY[1]) / 2;
    score -= midPrice / 6;
    if (c.simulated === 'full') {
      score += 6;
      reasons.push(t('This chip is fully simulated, so you can run it online before buying'));
    } else if (c.simulated === 'partial') {
      score += 3;
    }
    if (need.sim && c.simulated !== 'none') score += 40;
    if (required.includes('usb_otg')) reasons.push(t('Native USB OTG: can pose as a keyboard, network adapter or flash drive'));
    if (required.includes('psram')) reasons.push(t('{mb} MB PSRAM, room for audio and image buffers', { mb: b.psramMB }));
    const { pins, problems } = planPins(b, c, need.parts, required.includes('usb_otg'));
    if (problems.length) score -= 25;
    const bom = [
      { name: b.name, qty: 1, price: b.priceCNY },
      ...need.parts.map((id) => ({ name: t(PARTS[id].name), qty: 1, price: PARTS[id].priceCNY })),
      // On battery the cell must be bought too: needOf drops battery from parts (no pins), so add it back here
      ...(need.battery && !need.parts.includes('battery') ? [{ name: t(PARTS.battery.name), qty: 1, price: PARTS.battery.priceCNY }] : []),
      { name: t('Breadboard and jumper wires'), qty: 1, price: [8, 15] as [number, number] },
      { name: t('Type-C cable that carries data'), qty: 1, price: [5, 15] as [number, number] },
    ];
    const total: [number, number] = [bom.reduce((s, x) => s + x.price[0], 0), bom.reduce((s, x) => s + x.price[1], 0)];
    if (need.budget && total[0] > need.budget) score -= 20;
    const power = need.duty ? estimatePower(b, c, need.parts, need.duty) : undefined;
    const kinds = SIM_KINDS[c.id];
    const simCoverage = need.parts.map((id) => ({
      part: PARTS[id].name,
      level: (c.simulated === 'none' || (kinds && !PARTS[id].needs.every((n) => kinds.includes(n.kind)))
        ? '必须上真机' // lint: allow-cjk
        : PARTS[id].simulated === 'full'
          ? '仿真验证' // lint: allow-cjk
          : PARTS[id].simulated === 'partial'
            ? '行为模拟' // lint: allow-cjk
            : '必须上真机') as Confidence, // lint: allow-cjk
    }));
    for (const n of c.notes) if (required.some((k) => n.includes(CAP_NAME[k]))) warnings.push(t(n));
    plans.push({ board: b, chip: c, score, reasons, warnings, pins, pinProblems: problems, bom, total, power, simCoverage });
  }
  plans.sort((a, b) => b.score - a.score);
  return { plans, rejected };
}
