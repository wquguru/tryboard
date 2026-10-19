// Shopping / wiring rule engine (R01–R27 from docs/RESEARCH_PROCURE.md §2, board-specific R28–R32 from P1-12): pure and
// deterministic so CLI and web agree. Levels follow ESPHome pin checks: cannot boot = block, works with a catch = warn.
import { t } from '../i18n/index.ts';
import { CHIPS, type Cap } from '../advisor/data.ts';
import { BOARDS, PART_BY_ID, getPart, type BoardInfo, type ChipId, type LcdPins, type OnboardKind, type Part, type Pin } from './parts.ts';
import { TEMPLATE_BY_ID, type FirmwareUse, type Pick, type Wire } from './templates.ts';
export { applyFix } from './fix.ts';
import { RULES, netVolt, type Confidence } from './rulemeta.ts';
export { RULES, RULE_BY_ID, netVolt, type Confidence, type RuleMeta } from './rulemeta.ts';

export type Level = 'block' | 'warn' | 'ok';

export interface Fix {
  action: 'add' | 'remove' | 'swap';
  partId: string;
  /** swap: the part being replaced (the old board id when swapping boards) */
  replaces?: string;
}

export interface Finding {
  id: string;
  level: Level;
  title: string;
  detail: string;
  source: string;
  confidence: Confidence;
  /** Where it fired: part key, pin or GPIO */
  where?: string;
  fix?: Fix;
}

export interface RuleInput {
  /** Board id (part library kind = board) */
  board: string;
  parts: Pick[];
  /** Optional wiring. Without it only list-level checks run and pin rules report "no wiring" */
  wiring?: Wire[];
  firmware?: FirmwareUse;
  /** Chip capabilities the project needs (R25) */
  needs?: Extract<Cap, 'usb_otg' | 'camera' | 'bt_classic'>[];
  /** Assembly state (R26) */
  assembly?: { metalCase?: boolean; nearAntenna?: string[] };
  /** Shopping template id (R27 checks its required parts) */
  template?: string;
}

// ───────── Chip facts ─────────
// flash / USB / UART0 / ADC1 / RF peak current come from advisor/data.ts; the rest from ESP-IDF v5.5.1 soc_caps.h and datasheets
interface ChipFacts {
  name: string;
  gpios: number[];
  flash: number[];
  psramOctal: number[];
  bootPin: number;
  /** Pins sampled at power-up whose level changes boot (R28); S3 GPIO3 only matters after the JTAG-select eFuse, so it is left out */
  straps: number[];
  usb: number[];
  uart0: number[];
  adc1: number[];
  adc2: number[];
  rmtTx: number;
  ledc: number;
  i2c: number;
  caps: Set<Cap>;
  txPeakMa: number;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const adv = (id: string) => CHIPS.find((c) => c.id === id)!;

export const CHIP_FACTS: Record<ChipId, ChipFacts> = {
  esp32: {
    name: 'ESP32',
    // The classic chip has no GPIO20, 24, 28–31
    gpios: [...range(0, 19), 21, 22, 23, 25, 26, 27, ...range(32, 39)],
    flash: adv('esp32').pins.flash,
    psramOctal: [],
    bootPin: 0,
    straps: [0, 2, 5, 12, 15],
    usb: [],
    uart0: [...adv('esp32').pins.uart0],
    adc1: range(32, 39),
    adc2: [0, 2, 4, 12, 13, 14, 15, 25, 26, 27],
    rmtTx: 8,
    ledc: 16,
    i2c: 2,
    caps: new Set(adv('esp32').caps),
    txPeakMa: adv('esp32').power.txPeak,
  },
  esp32c3: {
    name: 'ESP32-C3',
    gpios: range(0, 21),
    flash: adv('esp32c3').pins.flash,
    psramOctal: [],
    bootPin: 9,
    straps: [2, 8, 9],
    usb: adv('esp32c3').pins.usb,
    uart0: [...adv('esp32c3').pins.uart0],
    adc1: adv('esp32c3').pins.adc1,
    adc2: [5],
    rmtTx: 2,
    ledc: 6,
    i2c: 1,
    caps: new Set(adv('esp32c3').caps),
    txPeakMa: adv('esp32c3').power.txPeak,
  },
  esp32s3: {
    name: 'ESP32-S3',
    gpios: [...range(0, 21), ...range(26, 48)],
    flash: adv('esp32s3').pins.flash,
    psramOctal: adv('esp32s3').pins.psramOctal ?? [],
    bootPin: 0,
    straps: [0, 45, 46],
    usb: adv('esp32s3').pins.usb,
    uart0: [...adv('esp32s3').pins.uart0],
    adc1: adv('esp32s3').pins.adc1,
    adc2: range(11, 20),
    rmtTx: 4,
    ledc: 8,
    i2c: 2,
    caps: new Set(adv('esp32s3').caps),
    txPeakMa: adv('esp32s3').power.txPeak,
  },
};

/** Whole-board peak without Wi-Fi (estimate: CPU at full speed + on-board USB-UART / power LED, not measured) */
export const BOARD_IDLE_MA = 100;
/** USB 2.0 port rating 500 mA */
export const USB_LIMIT_MA = 500;
/** Assume 500 mA when the LDO rating is not entered */
export const LDO_DEFAULT_MA = 500;
/** Suggested max load for one GPIO driving directly (mA, default drive level) */
export const GPIO_LOAD_MA = 20;
/** I2C pull-up sink limit (NXP UM10204 standard / fast mode 3 mA) */
export const I2C_SINK_MA = 3;

// ───────── Context ─────────
interface Inst {
  key: string;
  part: Part;
  qty: number;
  addr?: number;
}
interface GpioUse {
  gpio: number;
  inst: Inst;
  pin: Pin;
  wire: Wire;
}

interface Ctx {
  input: RuleInput;
  board: Part;
  info: BoardInfo;
  chip: ChipFacts;
  insts: Inst[];
  wiring: Wire[] | null;
  uses: GpioUse[];
  has: (partId: string) => boolean;
  hasExt5V: boolean;
  supplyNet: (i: Inst) => string | null;
  pinVolt: (i: Inst, p: Pin) => number | null;
  wired: (i: Inst) => boolean;
  chipLoadMa: number;
}

function makeCtx(input: RuleInput): Ctx {
  const board = getPart(input.board);
  if (board.kind !== 'board' || !board.board) throw new Error(`${input.board} is not a board`);
  const info = board.board;
  const chip = CHIP_FACTS[info.chip];
  const insts: Inst[] = input.parts
    .filter((p) => p.partId !== input.board && PART_BY_ID[p.partId]?.kind !== 'board')
    .map((p) => ({ key: p.key ?? p.partId, part: getPart(p.partId), qty: p.qty ?? 1, addr: p.addr }));
  const ids = new Set(input.parts.map((p) => p.partId).concat(input.board));
  const has = (id: string) => ids.has(id);
  const hasExt5V = insts.some((i) => i.part.provides?.net === 'EXT5V');
  const wiring = input.wiring && input.wiring.length ? input.wiring : null;
  const wiresOf = (i: Inst) => (wiring ?? []).filter((w) => w.part === i.key);
  const pinOf = (i: Inst, label: string) => i.part.pins?.find((p) => p.label === label);
  const wired = (i: Inst) => wiresOf(i).length > 0;
  const supplyNet = (i: Inst): string | null => {
    if (!i.part.pins || i.part.provides) return null;
    const w = wiresOf(i).find((w) => pinOf(i, w.pin)?.type === 'power');
    let net = w ? w.net : (i.part.supplyNet ?? null);
    // Without a supply on the external 5 V rail, power really comes from the board 5V
    if (net === 'EXT5V' && !hasExt5V) net = '5V';
    return net;
  };
  const pinVolt = (i: Inst, p: Pin) => (p.v === 'vcc' ? netVolt(supplyNet(i)) : p.v);
  const uses: GpioUse[] = [];
  for (const w of wiring ?? []) {
    const m = /^GPIO(\d+)$/.exec(w.net);
    if (!m) continue;
    const inst = insts.find((i) => i.key === w.part);
    const pin = inst && pinOf(inst, w.pin);
    if (inst && pin) uses.push({ gpio: Number(m[1]), inst, pin, wire: w });
  }
  const chipLoadMa = input.firmware?.wifi ? chip.txPeakMa : BOARD_IDLE_MA;
  return { input, board, info, chip, insts, wiring, uses, has, hasExt5V, supplyNet, pinVolt, wired, chipLoadMa };
}

const at = (u: GpioUse) => `${u.inst.key}.${u.pin.label} → GPIO${u.gpio}`;
const noWiring = () => t('No wiring given, pin checks skipped');
const onlyC3 = () => t('Only applies to ESP32-C3');
const onlyS3 = () => t('Only applies to ESP32-S3');
/** Display name of a part in the current language */
const nm = (p: Part) => t(p.name);

/** A rule returns its findings; a string means it did not fire (the string is shown in the UI) */
type RuleFn = (c: Ctx) => Partial<Finding>[] | string;

function f(level: 'block' | 'warn', detail: string, where?: string, fix?: Fix): Partial<Finding> {
  return { level, detail, where, fix };
}

/** Uses that land on any of the given GPIOs */
const usesOn = (c: Ctx, gpios: number[]) => c.uses.filter((u) => gpios.includes(u.gpio));

const isLow = (p: Pin) => p.boot === 'pull-down' || p.boot === 'drive-low';
const isHigh = (p: Pin) => p.boot === 'pull-up' || p.boot === 'drive-high';

const IMPL: Record<string, RuleFn> = {
  R01: (c) => {
    if (c.info.chip !== 'esp32c3') return onlyC3();
    if (!c.wiring) return noWiring();
    return usesOn(c, c.chip.flash).map((u) => f('block', t('GPIO{gpio} is wired to the in-package flash and cannot be a normal IO; move to GPIO0–7 / 10.', { gpio: u.gpio }), at(u)));
  },
  R02: (c) => {
    if (c.info.chip !== 'esp32s3') return onlyS3();
    if (!c.wiring) return noWiring();
    return usesOn(c, c.chip.flash).map((u) => f('block', t('GPIO{gpio} is a flash / PSRAM SPI pin; connecting a peripheral stops the chip from booting.', { gpio: u.gpio }), at(u)));
  },
  R03: (c) => {
    if (c.info.chip !== 'esp32s3') return onlyS3();
    if (!c.wiring) return noWiring();
    const hit = usesOn(c, c.chip.psramOctal);
    const board = nm(c.board);
    if (c.info.psram === 'octal') return hit.map((u) => f('block', t('{board} has octal PSRAM, so GPIO{gpio} is taken by PSRAM (it is on the header but unusable).', { board, gpio: u.gpio }), at(u)));
    if (c.info.psram === null) return hit.map((u) => f('warn', t('{board} PSRAM type is unverified: on the R8 (octal PSRAM) version GPIO{gpio} is unusable.', { board, gpio: u.gpio }), at(u)));
    return t('This board does not have octal PSRAM');
  },
  R04: (c) => {
    if (!c.wiring) return noWiring();
    const out: Partial<Finding>[] = [];
    for (const u of c.uses) {
      if (!c.chip.gpios.includes(u.gpio)) {
        const s3gap = c.info.chip === 'esp32s3' && u.gpio >= 22 && u.gpio <= 25;
        out.push(f('block', s3gap ? t('{chip} has no GPIO{gpio} (GPIO22–25 do not exist on the S3).', { chip: c.chip.name, gpio: u.gpio }) : t('{chip} has no GPIO{gpio}.', { chip: c.chip.name, gpio: u.gpio }), at(u)));
      } else if (c.board.pins && !c.board.pins.some((p) => p.gpio === u.gpio)) out.push(f('block', t('{board} does not break GPIO{gpio} out to the header.', { board: nm(c.board), gpio: u.gpio }), at(u)));
    }
    return out;
  },
  R05: (c) => {
    if (!c.wiring) return noWiring();
    const g = c.chip.bootPin;
    return usesOn(c, [g])
      .filter((u) => isLow(u.pin))
      .map((u) => f('warn', t('GPIO{gpio} is the BOOT pin; {pin} on {part} pulls it low at power-up, so the chip enters download mode and your program does not run. Use another pin.', { gpio: g, pin: u.pin.label, part: nm(u.inst.part) }), at(u)));
  },
  R06: (c) => {
    if (c.info.chip !== 'esp32c3') return onlyC3();
    if (!c.wiring) return noWiring();
    return usesOn(c, [8, 2])
      .filter((u) => isLow(u.pin))
      .map((u) => f('warn', t('GPIO{gpio} is a strapping pin and must be high at power-up; {pin} pulls it low, so the chip may enter download mode or fail to boot.', { gpio: u.gpio, pin: u.pin.label }), at(u)));
  },
  R07: (c) => {
    if (c.info.chip !== 'esp32s3') return onlyS3();
    if (!c.wiring) return noWiring();
    return usesOn(c, [45])
      .filter((u) => isHigh(u.pin))
      .map((u) => f('block', t('GPIO45 high at power-up switches flash power to 1.8 V, so modules with 3.3 V flash (WROOM-1 etc.) will not boot. Use another pin.'), at(u)));
  },
  R08: (c) => {
    if (c.info.chip !== 'esp32s3') return onlyS3();
    if (!c.wiring) return noWiring();
    return usesOn(c, [46])
      .filter((u) => isHigh(u.pin))
      .map((u) => f('warn', t('GPIO46 high at power-up together with GPIO0 pressed (low) is an illegal boot mode, so flashing with BOOT fails.'), at(u)));
  },
  R09: (c) => {
    if (!c.wiring) return noWiring();
    return usesOn(c, c.chip.usb).map((u) => f('warn', t('GPIO{gpio} is the chip native USB D−/D+; with a peripheral on it the USB serial and flashing port stop working and you can only flash via BOOT.', { gpio: u.gpio }), at(u)));
  },
  R10: (c) => {
    if (!c.wiring) return noWiring();
    return usesOn(c, c.chip.uart0).map((u) => f('warn', t('GPIO{gpio} is UART0 (log serial); the boot log at power-up goes out to {part}.', { gpio: u.gpio, part: nm(u.inst.part) }), at(u)));
  },
  R11: (c) => {
    if (c.info.chip !== 'esp32c3') return onlyC3();
    if (!c.wiring) return noWiring();
    return c.uses
      .filter((u) => u.pin.type === 'analog' && !c.chip.adc1.includes(u.gpio))
      .map((u) =>
        u.gpio === 5
          ? f('block', t('GPIO5 is ADC2: C3 ADC2 has a hardware erratum and ESP-IDF no longer supports it, regardless of Wi-Fi. Use GPIO0–4.'), at(u))
          : f('block', t('GPIO{gpio} is not an analog input; C3 ADC1 is GPIO0–4.', { gpio: u.gpio }), at(u)),
      );
  },
  R12: (c) => {
    if (c.info.chip !== 'esp32s3') return onlyS3();
    if (!c.wiring) return noWiring();
    const out: Partial<Finding>[] = [];
    for (const u of c.uses.filter((u) => u.pin.type === 'analog')) {
      if (c.chip.adc1.includes(u.gpio)) continue;
      if (c.chip.adc2.includes(u.gpio)) {
        if (c.input.firmware?.wifi) out.push(f('warn', t('GPIO{gpio} is ADC2; with Wi-Fi on, S3 reads may time out (ESP_ERR_TIMEOUT). Prefer ADC1 (GPIO1–10).', { gpio: u.gpio }), at(u)));
      } else out.push(f('block', t('GPIO{gpio} is not an analog input; S3 ADC1 is GPIO1–10 and ADC2 is GPIO11–20.', { gpio: u.gpio }), at(u)));
    }
    return out;
  },
  R13: (c) => {
    if (c.info.chip !== 'esp32c3') return onlyC3();
    if (!c.wiring) return noWiring();
    return usesOn(c, [11]).map((u) => f('warn', t('GPIO11 is VDD_SPI (flash power) by default; using it as a GPIO needs the eFuse VDD_SPI_AS_GPIO burned, which cannot be undone.'), at(u)));
  },
  R14: (c) => {
    const out: Partial<Finding>[] = [];
    const countBy = (type: Pin['type']) => {
      if (c.wiring) return new Set(c.uses.filter((u) => u.pin.type === type).map((u) => u.gpio));
      const s = new Set<string>();
      for (const i of c.insts) if (i.part.pins?.some((p) => p.type === type)) for (let k = 0; k < i.qty; k++) s.add(`${i.key}#${k}`);
      return s;
    };
    const rmt = countBy('ws2812-din');
    const fwRgb = c.input.firmware?.rgbGpio;
    const nRmt = rmt.size + (fwRgb !== undefined && !(rmt as Set<number | string>).has(fwRgb) ? 1 : 0);
    const chip = c.chip.name;
    if (nRmt > c.chip.rmtTx) out.push(f('block', t('{n} WS2812 data lines (including the on-board RGB LED), but {chip} has only {max} RMT TX channels; chain the LEDs into one strip.', { n: nRmt, chip, max: c.chip.rmtTx }), 'RMT'));
    const nPwm = countBy('pwm').size;
    if (nPwm > c.chip.ledc) out.push(f('block', t('{n} PWM outputs, but {chip} LEDC has only {max} channels; use a PCA9685 for many servos.', { n: nPwm, chip, max: c.chip.ledc }), 'LEDC'));
    if (c.wiring) {
      const buses = new Set(c.uses.filter((u) => u.pin.type === 'i2c-sda').map((u) => u.gpio));
      if (buses.size > c.chip.i2c) out.push(f('block', t('{n} I2C buses used, but {chip} has only {max} I2C controllers; put the modules on the same SDA / SCL.', { n: buses.size, chip, max: c.chip.i2c }), 'I2C'));
    }
    return out;
  },
  R15: (c) => {
    const out: Partial<Finding>[] = [];
    for (const i of c.insts) {
      if (i.addr === undefined || !i.part.i2cAddr) continue;
      const ok = [i.part.i2cAddr.default, ...i.part.i2cAddr.alt];
      if (!ok.includes(i.addr)) out.push(f('block', t('{part} does not support address 0x{addr} (options: {alt}).', { part: nm(i.part), addr: hex(i.addr), alt: ok.map((a) => '0x' + hex(a)).join(' / ') }), i.key));
    }
    for (const [bus, list] of i2cBuses(c)) {
      const byAddr = new Map<number, string[]>();
      for (const i of list) {
        const a = i.addr ?? i.part.i2cAddr!.default;
        for (let k = 0; k < i.qty; k++) byAddr.set(a, [...(byAddr.get(a) ?? []), i.qty > 1 ? `${i.key}#${k + 1}` : i.key]);
      }
      for (const [a, who] of byAddr) {
        if (who.length < 2) continue;
        const how = list.map((i) => i.part.i2cAddr?.how).filter(Boolean)[0];
        out.push(
          f(
            'block',
            t('{who} all use 0x{addr}{bus}: address conflict. {how}{second}.', {
              who: who.join(' / '),
              addr: hex(a),
              bus: bus === '' ? '' : t(' (bus {bus})', { bus }),
              how: how ? t(how) : t('Change the address jumper'),
              second: c.chip.i2c > 1 ? t(', or move one to the second I2C bus (S3 has two)') : '',
            }),
            who.join(','),
          ),
        );
      }
    }
    return out;
  },
  R16: (c) => {
    const out: Partial<Finding>[] = [];
    for (const [bus, list] of i2cBuses(c)) {
      let g = 0;
      let n = 0;
      for (const i of list) {
        const k = i.part.i2cPullupK ?? 4.7;
        if (k > 0) {
          g += i.qty / k;
          n += i.qty;
        }
      }
      if (!g) continue;
      const r = 1 / g;
      const sink = 3.3 / r;
      if (sink > I2C_SINK_MA)
        out.push(f('warn', t("{n} modules each have pull-ups, about {r} kΩ in parallel, sinking {ma} mA when low (estimate) against a 3 mA spec limit. Remove the extra modules' pull-up resistors.", { n, r: r.toFixed(2), ma: sink.toFixed(1) }), bus || 'I2C'));
    }
    return out;
  },
  R17: (c) => {
    const out: Partial<Finding>[] = [];
    const mitigation = c.has('level-bss138') || c.has('resistor-kit');
    const fix: Fix | undefined = mitigation ? undefined : { action: 'add', partId: 'resistor-kit' };
    for (const u of c.uses) {
      if (u.pin.dir !== 'out' && u.pin.dir !== 'bi') continue;
      const v = c.pinVolt(u.inst, u.pin);
      if (v === null || v <= 3.6) continue;
      if (u.wire.via === 'divider' || u.wire.via === 'level-shifter') continue;
      const i2c = u.pin.type === 'i2c-sda' || u.pin.type === 'i2c-scl';
      const how = i2c ? t('Power the module from 3V3 or add a bidirectional level shifter.') : t('Add a 1 kΩ / 2 kΩ divider or a level shifter.');
      out.push(f('block', t('{pin} on {part} is {v} V and ESP32 pins are not 5 V tolerant. {fix}', { pin: u.pin.label, part: nm(u.inst.part), v, fix: how }), at(u), i2c && !c.has('level-bss138') ? { action: 'add', partId: 'level-bss138' } : fix));
    }
    // Unwired parts: judge by their default supply
    for (const i of c.insts) {
      // A level shifter's or passive's 5 V side never touches a GPIO
      if (c.wired(i) || !i.part.pins || i.part.kind === 'passive') continue;
      const hot = i.part.pins.find((p) => (p.dir === 'out' || p.dir === 'bi') && (c.pinVolt(i, p) ?? 0) > 3.6);
      if (hot && !mitigation) out.push(f('block', t('{pin} on {part} outputs {v} V and ESP32 pins are not 5 V tolerant; add a divider or level shifter.', { pin: hot.label, part: nm(i.part), v: c.pinVolt(i, hot) ?? '' }), i.key, fix));
    }
    return out;
  },
  R18: (c) => {
    const out: Partial<Finding>[] = [];
    const fix: Fix | undefined = c.has('level-ahct125') ? undefined : { action: 'add', partId: 'level-ahct125' };
    for (const i of c.insts) {
      const din = i.part.pins?.find((p) => p.type === 'ws2812-din');
      if (!din) continue;
      const vdd = netVolt(c.supplyNet(i));
      if (vdd === null || vdd < 4.5) continue;
      const msg = t('{part} runs on {vdd} V, so its data high threshold is about {th} V and 3.3 V is marginal: short wires often work, long wires or some batches flicker. Add a 74AHCT125 level shifter.', { part: nm(i.part), vdd, th: (0.7 * vdd).toFixed(1) });
      if (c.wired(i)) {
        for (const u of c.uses.filter((u) => u.inst === i && u.pin === din && u.wire.via !== 'level-shifter')) out.push(f('warn', msg, at(u), fix));
      } else if (!c.has('level-ahct125')) out.push(f('warn', msg, i.key, fix));
    }
    return out;
  },
  R19: (c) => {
    const out: Partial<Finding>[] = [];
    for (const i of c.insts) {
      const range = i.part.voltage.supply;
      const net = c.supplyNet(i);
      const v = netVolt(net);
      if (!range || v === null || net === 'GND') continue;
      const vars = { part: nm(i.part), lo: range[0], hi: range[1], net: net ?? '', v };
      if (v < range[0] - 0.05)
        out.push(f('block', range[0] >= 4.5 ? t('{part} needs {lo}–{hi} V but is on {net} ({v} V). Power it from 5V or an external 5 V supply.', vars) : t('{part} needs {lo}–{hi} V but is on {net} ({v} V).', vars), i.key));
      else if (v > range[1] + 0.05) out.push(f('block', t('{part} takes at most {hi} V; on {net} ({v} V) it will be damaged. Move it to 3V3.', vars), i.key));
    }
    return out;
  },
  R20: (c) => {
    const out: Partial<Finding>[] = [];
    let usb = c.chipLoadMa;
    let ext = 0;
    const heavy: string[] = [];
    for (const i of c.insts) {
      const peak = (i.part.currentMa.peak ?? 0) * i.qty;
      if (!peak) continue;
      const net = c.supplyNet(i);
      if (net === '3V3' || net === '5V') {
        usb += peak;
        if (peak >= 100) heavy.push(`${nm(i.part)} ${peak} mA`);
      } else if (net === 'EXT5V') ext += peak;
    }
    if (usb > USB_LIMIT_MA)
      out.push(
        f(
          'warn',
          t('USB only: estimated peak {ma} mA (board {board} mA{heavy}), above the 500 mA of USB 2.0, so the board may keep rebooting. Add a 5 V 2 A supply, or keep heavy parts from running at once.', {
            ma: Math.round(usb),
            board: c.chipLoadMa,
            heavy: heavy.length ? ', ' + heavy.join(', ') : '',
          }),
          'USB',
          c.hasExt5V ? undefined : { action: 'add', partId: 'psu-5v2a' },
        ),
      );
    const cap = c.insts.filter((i) => i.part.provides?.net === 'EXT5V').reduce((s, i) => s + i.part.provides!.maxMa * i.qty, 0);
    if (c.hasExt5V && ext > cap) out.push(f('warn', t('Estimated peak on the external 5 V rail is {ma} mA, above the supply {cap} mA; limit strip brightness in firmware or use a bigger supply.', { ma: Math.round(ext), cap }), 'EXT5V'));
    return out;
  },
  R21: (c) => {
    let load = c.chipLoadMa;
    for (const i of c.insts) if (c.supplyNet(i) === '3V3') load += (i.part.currentMa.peak ?? 0) * i.qty;
    const known = c.info.ldo.maxMa;
    const limit = known ?? LDO_DEFAULT_MA;
    const ma = Math.round(load);
    if (load <= limit) return known ? t('3.3 V peak load about {ma} mA, within {limit} mA', { ma, limit }) : t('3.3 V peak load about {ma} mA, within {limit} mA (LDO rating not entered, assuming 500 mA)', { ma, limit });
    return [
      f(
        'warn',
        t('3.3 V rail peak about {ma} mA (estimate), chip {chip} mA{wifi}, above the on-board regulator {limit} mA{unknown}: the regulator will heat up and sag. Move heavy parts to 5 V or add an AMS1117.', {
          ma,
          chip: c.chipLoadMa,
          wifi: c.input.firmware?.wifi ? t(' including Wi-Fi TX') : '',
          limit,
          unknown: known ? '' : t(' (rating not entered, assuming 500 mA)'),
        }),
        '3V3',
      ),
    ];
  },
  R22: (c) => {
    const out: Partial<Finding>[] = [];
    const fix: Fix | undefined = c.has('npn-s8050') ? undefined : { action: 'add', partId: 'npn-s8050' };
    for (const u of c.uses) {
      if ((u.pin.loadMa ?? 0) > GPIO_LOAD_MA && u.wire.via !== 'transistor')
        out.push(f('warn', t('{part} draws about {ma} mA, above the {max} mA suggested for direct GPIO drive; use a transistor or MOSFET, plus a flyback diode for inductive loads.', { part: nm(u.inst.part), ma: u.pin.loadMa ?? 0, max: GPIO_LOAD_MA }), at(u), fix));
    }
    for (const i of c.insts) {
      if (c.wired(i) || c.has('npn-s8050')) continue;
      const p = i.part.pins?.find((p) => (p.loadMa ?? 0) > GPIO_LOAD_MA);
      if (p) out.push(f('warn', t('{part} draws about {ma} mA and cannot connect straight to a GPIO; add a transistor.', { part: nm(i.part), ma: p.loadMa ?? 0 }), i.key, fix));
    }
    return out;
  },
  R23: (c) => {
    const want = c.input.firmware?.rgbGpio;
    if (want === undefined) return t('Firmware does not use the on-board RGB LED');
    const have = c.info.rgbGpio;
    if (have === want) return t('On-board RGB LED is on GPIO{gpio}, matching the firmware', { gpio: have });
    if (have === null) return [f('warn', t('Firmware treats GPIO{gpio} as the on-board RGB LED, but {board} has no on-board WS2812.', { gpio: want, board: nm(c.board) }), `GPIO${want}`)];
    const sibling = BOARDS.find((b) => b.board!.family === c.info.family && b.board!.rgbGpio === want && b.id !== c.board.id);
    return [
      f(
        'warn',
        t('Firmware drives the on-board RGB LED on GPIO{want}, but {board} has it on GPIO{have}{family}. Change the pin in firmware{sibling}.', {
          want,
          board: nm(c.board),
          have,
          family: c.info.family === 'devkitc1' ? t(' (DevKitC-1 v1.0 uses GPIO48, v1.1 uses GPIO38; check the silkscreen on the back)') : '',
          sibling: sibling ? t(', or switch to {board}', { board: nm(sibling) }) : '',
        }),
        `GPIO${want}`,
        sibling ? { action: 'swap', partId: sibling.id, replaces: c.board.id } : undefined,
      ),
    ];
  },
  R24: (c) => {
    if (!c.wiring) return noWiring();
    const out: Partial<Finding>[] = [];
    for (const u of c.uses) {
      const o = c.info.onboard.find((o) => o.gpio === u.gpio && o.kind !== 'boot');
      if (!o) continue;
      const vars = { board: nm(c.board), gpio: u.gpio, what: t(o.what), pin: u.pin.label, part: nm(u.inst.part) };
      if (o.share) {
        // A bus can carry several devices: same-role pins only warn; using a bus pin as plain IO garbles the on-board device
        if (o.share === u.pin.type) {
          const why = o.share.startsWith('spi') ? t('it needs its own CS, and the firmware shares one SPI host between both devices') : t('its I2C address must not clash with the on-board device');
          out.push(f('warn', t('GPIO{gpio} on {board} is {what} (bus); {pin} on {part} can share it, but {why}.', { ...vars, why }), at(u)));
        } else out.push(f('block', t('GPIO{gpio} on {board} is {what}; connecting {pin} on {part} disrupts the on-board device. Use a free pin.', vars), at(u)));
      } else if (EXCLUSIVE.includes(o.kind)) out.push(f('block', t('GPIO{gpio} on {board} is already wired to {what} (a control line owned by the on-board device); adding {part} conflicts. Use a free pin.', vars), at(u)));
      else out.push(f('warn', t('GPIO{gpio} on {board} is already wired to {what}; adding {part} will interfere.', vars), at(u)));
    }
    return out;
  },
  R25: (c) => {
    const needs = c.input.needs ?? [];
    if (!needs.length) return t('No special capability needed');
    const out: Partial<Finding>[] = [];
    const NAME = { usb_otg: t('USB OTG (acting as a keyboard or USB drive)'), camera: t('a camera interface'), bt_classic: t('Classic Bluetooth') } as const;
    for (const n of needs) {
      if (c.chip.caps.has(n)) {
        // Board notes are English data now, so the camera connector is detected by the English word
        if (n === 'camera' && !/camera/i.test(c.board.note)) out.push(f('warn', t('{chip} supports a camera, but {board} has no camera connector; pick a board with one (e.g. XIAO ESP32S3 Sense, not in the part library).', { chip: c.chip.name, board: nm(c.board) }), c.board.id));
        continue;
      }
      const fix: Fix | undefined = n === 'usb_otg' ? { action: 'swap', partId: 's3-devkitc1-v11', replaces: c.board.id } : undefined;
      const how = n === 'bt_classic' ? t('Classic Bluetooth needs the original ESP32 (not in the part library).') : t('Switch to ESP32-S3.');
      out.push(f('block', t('{chip} has no {cap}. {fix}', { chip: c.chip.name, cap: NAME[n], fix: how }), c.board.id, fix));
    }
    return out;
  },
  R26: (c) => {
    const a = c.input.assembly;
    if (!a) return t('No assembly info');
    const out: Partial<Finding>[] = [];
    if (a.metalCase) out.push(f('warn', t('A metal case blocks Wi-Fi and Bluetooth and signals get much worse; keep the antenna outside the case or use a plastic one (confirm on real hardware).'), 'enclosure'));
    for (const key of a.nearAntenna ?? []) {
      const i = c.insts.find((i) => i.key === key);
      if (i && (i.part.rfBlocker || i.part.kind === 'display')) out.push(f('warn', t('{part} sits in the antenna keep-out area; Wi-Fi may lose 3–10 dB (directional hint, needs real hardware).', { part: nm(i.part) }), key));
    }
    return out;
  },
  R27: (c) => {
    const out: Partial<Finding>[] = [];
    const added = new Set<string>();
    const need = (partId: string, detail: string, where: string) => {
      if (c.has(partId) || added.has(partId)) return;
      added.add(partId);
      out.push(f('block', detail, where, { action: 'add', partId }));
    };
    if (c.input.template) {
      const tpl = TEMPLATE_BY_ID[c.input.template];
      for (const r of tpl?.required ?? []) {
        if (getPart(r.partId).kind === 'board') continue;
        // Already soldered on the board (GC9A01 on the Waveshare round display): no purchase needed, R29 explains
        if (c.info.builtin?.some((b) => b.partId === r.partId)) continue;
        need(r.partId, t('"{template}" requires {part} ({why}).', { template: t(tpl.title), part: nm(getPart(r.partId)), why: t(r.why) }), r.partId);
      }
    }
    for (const i of c.insts) {
      if (i.part.supplyNet === 'EXT5V' && i.part.kind === 'actuator' && !c.hasExt5V) need('psu-5v2a', t('{part} needs its own 5 V supply: on computer USB alone, the start-up sag resets the board.', { part: nm(i.part) }), i.key);
    }
    for (const i of c.insts) {
      for (const r of i.part.requires ?? []) {
        if (r.partId === 'tp4056' && c.info.charger) continue;
        need(r.partId, t('{part} needs {need}: {why}.', { part: nm(i.part), need: nm(getPart(r.partId)), why: t(r.why) }), i.key);
      }
    }
    need('usb-c-cable', t('Every project needs a USB-C cable that carries data; many charging cables only charge.'), 'usb-c-cable');
    return out;
  },
  R28: (c) => {
    if (!c.wiring) return noWiring();
    return (
      c.uses
        // Known power-up levels belong to R05–R08; I2C lines are pulled up, which satisfies the strapping need
        .filter((u) => c.chip.straps.includes(u.gpio) && u.pin.boot === undefined && (u.pin.dir === 'out' || u.pin.dir === 'bi') && !u.pin.type.startsWith('i2c-'))
        .map((u) => {
          const silk = c.board.pins?.find((p) => p.gpio === u.gpio)?.label;
          const why =
            c.info.chip === 'esp32c3'
              ? u.gpio === 9
                ? t('low at power-up enters download mode and your program does not run')
                : t('low at power-up may enter download mode or fail to boot')
              : u.gpio === 0
                ? t('low at power-up enters download mode')
                : t('the power-up level changes the flash voltage or boot mode');
          const vars = { silk: silk ?? '', gpio: u.gpio, pin: u.pin.label, part: nm(u.inst.part), why };
          const detail =
            silk && silk !== `GPIO${u.gpio}`
              ? t('{silk} looks like a normal pin but is a strapping pin: {pin} on {part} drives a level onto it, and {why}. Make sure it is high or high-impedance at power-up, or use another pin.', vars)
              : t('GPIO{gpio} is a strapping pin: {pin} on {part} drives a level onto it, and {why}. Make sure it is high or high-impedance at power-up, or use another pin.', vars);
          return f('warn', detail, at(u));
        })
    );
  },
  R29: (c) => {
    const builtin = c.info.builtin ?? [];
    if (!builtin.length) return t('{board} has no on-board parts that duplicate the part library', { board: nm(c.board) });
    const lcd = c.info.lcd;
    const pins = lcd ? `SCLK ${lcd.sclk} / MOSI ${lcd.mosi} / CS ${lcd.cs} / DC ${lcd.dc} / RST ${lcd.rst} / ${t('backlight')} ${lcd.bl}` : '';
    return c.insts
      .filter((i) => builtin.some((b) => b.partId === i.part.id))
      .map((i) => {
        const b = builtin.find((b) => b.partId === i.part.id)!;
        return f(
          'warn',
          t('{board} already has {what}, yet the list also buys {part}: extra cost, and the external wires compete for the on-board pins. Remove the external one{pins}.', {
            board: nm(c.board),
            what: t(b.what),
            part: nm(i.part),
            pins: pins ? t(', and point the firmware at the on-board display pins ({pins})', { pins }) : '',
          }),
          i.key,
          { action: 'remove', partId: i.part.id },
        );
      });
  },
  R30: (c) => {
    if (!c.input.firmware?.psram) return t('Firmware does not need PSRAM');
    const fix: Fix = { action: 'swap', partId: 's3-devkitc1-v10', replaces: c.board.id };
    const board = nm(c.board);
    if (c.info.psram === 'none' || c.info.psramMB === 0) {
      const why = c.info.chip === 'esp32c3' ? t('ESP32-C3 has no PSRAM interface') : t('the chip or module part number has no R');
      return [f('block', t('Firmware needs PSRAM, but {board} has none ({why}). Switch to a board with PSRAM, such as XIAO ESP32S3 or DevKitC-1 N16R8.', { board, why }), c.board.id, fix)];
    }
    if (c.info.psram === null || c.info.psramMB === null) return [f('warn', t('Firmware needs PSRAM, but {board} PSRAM config is unverified: check for R2 / R8 in the part number before buying.', { board }), c.board.id)];
    return t('{board} has {mb} MB PSRAM', { board, mb: c.info.psramMB });
  },
  R31: (c) => {
    if (!c.board.pins) return t('{board} has no header table, so free pins cannot be counted', { board: nm(c.board) });
    // Free = header GPIOs minus those owned by on-board devices (bus pins and the BOOT key stay usable)
    const taken = new Set(c.info.onboard.filter((o) => o.kind !== 'boot' && !o.share).map((o) => o.gpio));
    const free = [...new Set(c.board.pins.map((p) => p.gpio).filter((g): g is number => g !== undefined && !taken.has(g)))];
    let need: number;
    if (c.wiring) need = new Set(c.uses.map((u) => u.gpio)).size;
    else {
      // No wiring: count signal pins per part, with every I2C part sharing one SDA / SCL pair
      need = 0;
      let i2c = false;
      for (const i of c.insts) {
        if (!i.part.pins) continue;
        if (i.part.i2cAddr) {
          i2c = true;
          continue;
        }
        need += i.qty * i.part.pins.filter((p) => !['power', 'gnd', 'nc', 'passive', 'addr'].includes(p.type)).length;
      }
      if (i2c) need += 2;
    }
    if (need <= free.length) return t('Needs {need} signal lines; {board} has {free} free GPIOs', { need, board: nm(c.board), free: free.length });
    const sibling = c.info.chip === 'esp32c3' ? 'c3-devkitm1' : 's3-devkitc1-v10';
    return [
      f(
        'block',
        t('The project needs {need} signal lines, but {board} has only {free} free GPIOs ({list}). Pick a board with more pins, or expand over I2C (PCF8574 / PCA9685).', { need, board: nm(c.board), free: free.length, list: free.map((g) => 'GPIO' + g).join(', ') }),
        c.board.id,
        sibling === c.board.id ? undefined : { action: 'swap', partId: sibling, replaces: c.board.id },
      ),
    ];
  },
  R32: (c) => {
    const want = c.input.firmware?.lcdPins;
    if (!want) return t('Firmware declares no on-board display pins');
    const have = c.info.lcd;
    if (!have) return t('{board} has no on-board display; external display pins are covered by the other pin checks', { board: nm(c.board) });
    const keys = (Object.keys(want) as (keyof LcdPins)[]).filter((k) => want[k] !== have[k]);
    if (!keys.length) return t('Firmware display pins match the on-board display');
    const NAME: Record<keyof LcdPins, string> = { sclk: 'SCLK', mosi: 'MOSI', cs: 'CS', dc: 'DC', rst: 'RST', bl: t('backlight') };
    const sibling = BOARDS.find((b) => b.id !== c.board.id && b.board!.family === c.info.family && b.board!.lcd && (Object.keys(want) as (keyof LcdPins)[]).every((k) => b.board!.lcd![k] === want[k]));
    const list = (p: LcdPins) => keys.map((k) => `${NAME[k]} GPIO${p[k]}`).join(', ');
    return [
      f(
        'warn',
        t('Firmware drives the on-board display with {want}, but {board} actually uses {have}{family}: the screen stays dark. Change the firmware pins{sibling}.', {
          want: list(want as LcdPins),
          board: nm(c.board),
          have: list(have),
          family: c.info.family === 'ws-lcd128' ? t(' (Waveshare round display no-touch: RST 12 / backlight 40; touch: RST 14 / backlight 2)') : '',
          sibling: sibling ? t(', or switch to {board}', { board: nm(sibling) }) : '',
        }),
        'LCD',
        sibling ? { action: 'swap', partId: sibling.id, replaces: c.board.id } : undefined,
      ),
    ];
  },
};

/** Control lines owned by on-board devices: reuse by an external part is a blocker (R24) */
const EXCLUSIVE: OnboardKind[] = ['lcd', 'imu', 'touch'];

const hex = (a: number) => a.toString(16).toUpperCase().padStart(2, '0');

/** Group I2C parts by bus: by SDA GPIO when wired, otherwise one default bus */
function i2cBuses(c: Ctx): Map<string, Inst[]> {
  const m = new Map<string, Inst[]>();
  for (const i of c.insts) {
    if (!i.part.i2cAddr) continue;
    let bus = '';
    if (c.wired(i)) {
      const u = c.uses.find((u) => u.inst === i && u.pin.type === 'i2c-sda');
      if (!u) continue;
      bus = `SDA=GPIO${u.gpio}`;
    }
    m.set(bus, [...(m.get(bus) ?? []), i]);
  }
  return m;
}

/** Run every rule (R01–R32): at least one finding each, level='ok' when not fired */
export function evaluate(input: RuleInput): Finding[] {
  const c = makeCtx(input);
  const out: Finding[] = [];
  for (const meta of RULES) {
    const r = IMPL[meta.id](c);
    const base = { id: meta.id, title: t(meta.title), source: meta.source, confidence: meta.confidence };
    if (typeof r === 'string' || r.length === 0) out.push({ ...base, level: 'ok', detail: typeof r === 'string' ? r : t('No problems found') });
    else for (const x of r) out.push({ ...base, level: x.level ?? meta.level, detail: x.detail ?? '', ...(x.where ? { where: x.where } : {}), ...(x.fix ? { fix: x.fix } : {}) });
  }
  return out;
}

/** Only fired findings (blocks first) */
export function problems(input: RuleInput): Finding[] {
  const rank = { block: 0, warn: 1, ok: 2 } as const;
  return evaluate(input)
    .filter((f) => f.level !== 'ok')
    .sort((a, b) => rank[a.level] - rank[b.level]);
}

export function summary(findings: Finding[]) {
  return { block: findings.filter((f) => f.level === 'block').length, warn: findings.filter((f) => f.level === 'warn').length, ok: findings.filter((f) => f.level === 'ok').length };
}
