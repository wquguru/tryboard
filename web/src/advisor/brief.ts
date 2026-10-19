// Advisor v3 brief: the result as Markdown to paste into an AI coding assistant (DESIGN_V2 §8.2). The bench imports it too.
// Checkpoint names match the bench genlevels keys (contract 3); no commands, only one line pointing at the local package.
import { PARTS } from './data.ts';
import { capName, type Confidence } from './engine.ts';
import type { Cap } from './data.ts';
import { PART_MAP } from './catalogmap.ts';
import { answers, labelIs, labelText, pinFull, pinKind, resolve, yuan, lasts, type Result } from './derive.ts';
import type { SelectState } from './state.ts';
import { t } from '../i18n/index.ts';

/** I2C addresses (catalog part id to 7-bit address), same as the bench `--i2c ssd1306@0x3c,bme280@0x76` */
const I2C_ADDR: Record<string, number> = { bme280: 0x76, ssd1306: 0x3c };
const CHIP_NAME: Record<string, string> = { bme280: 'BME280', ssd1306: 'OLED' };
const hex = (a: number) => '0x' + a.toString(16).padStart(2, '0');

export interface Checkpoint {
  name: string;
  conf: Confidence;
  /** Not judged, only a reminder (deep-sleep wake) */
  manual?: boolean;
}

/** Checkpoints per part (names identical to the bench genlevels) */
export function checkpointsOf(r: Result): Checkpoint[] {
  const ids = r.need.parts.map((id) => PART_MAP[id]?.partId).filter((x): x is string => !!x);
  const out: Checkpoint[] = [{ name: t('Boots without crashing, prints to serial'), conf: '仿真验证' }]; // lint: allow-cjk
  for (const id of ids) if (id in I2C_ADDR) out.push({ name: t('I2C {addr} responds ({name})', { addr: hex(I2C_ADDR[id]), name: CHIP_NAME[id] }), conf: '行为模拟' }); // lint: allow-cjk
  if (ids.includes('ssd1306')) out.push({ name: t('OLED receives a frame'), conf: '仿真验证' }); // lint: allow-cjk
  if (ids.includes('ws2812-strip')) out.push({ name: t('LED strip receives data'), conf: '仿真验证' }); // lint: allow-cjk
  if (ids.includes('sg90')) out.push({ name: t('Servo signal'), conf: '行为模拟' }); // lint: allow-cjk
  if (r.need.battery) out.push({ name: t('Wakes again after deep sleep'), conf: '必须上真机', manual: true }); // lint: allow-cjk
  return out;
}

/** Role of each bus line (the engine gives pin numbers only, in this order) */
const ROLES: Record<string, string[]> = { i2c: ['SDA', 'SCL'], spi: ['SCK', 'MOSI', 'CS'], i2s: ['BCLK', 'WS', 'DATA'], uart: ['TX', 'RX'] };

function wiring(r: Result, partId: string): string {
  const p = r.plan!;
  const part = PARTS[partId];
  const segs: string[] = [];
  for (const n of part.needs) {
    const a = p.pins.find((x) => labelIs(x.label, n.label));
    if (!a) continue;
    const kind = pinKind(a.label, r.need.parts);
    const roles = ROLES[kind];
    if (n.label.includes('DC / RST / backlight')) segs.push(['DC', 'RST', t('backlight')].map((k, i) => (a.pins[i] !== undefined ? `${k} = ${pinFull(p.board, a.pins[i])}` : '')).filter(Boolean).join(t('; ')));
    else if (roles) segs.push(`${kind.toUpperCase()}${t('; ')}` + a.pins.map((x, i) => `${roles[i] ?? t('line {n}', { n: i + 1 })} = ${pinFull(p.board, x)}`).join(t('; ')));
    else segs.push(`${kind === 'pwm' ? 'PWM' : kind === 'adc' ? 'ADC' : kind === 'rmt' ? 'RMT' : kind === 'usb' ? t('Native USB') : 'GPIO'}${t('; ')}${a.pins.map((x) => pinFull(p.board, x)).join(' / ')}`);
  }
  const cat = PART_MAP[partId]?.partId;
  if (cat && cat in I2C_ADDR) segs.push(t('address {addr}', { addr: hex(I2C_ADDR[cat]) }));
  if (PART_MAP[partId] === null) segs.push(t('TryBoard has no model for this part; try it on a real board'));
  return segs.join(t('; ')) || t('uses no pins');
}

export function briefMarkdown(s: SelectState): string {
  const r = resolve(s);
  const a = answers(r.s);
  const L: string[] = [];
  const title = t(r.tpl.title);
  L.push(`# ${title}`, '');
  if (!r.plan) {
    L.push(t('No board meets all these conditions yet. Go back to the advisor, drop a condition or raise the budget, then generate the brief again.'));
    return L.join('\n');
  }
  const p = r.plan;
  L.push(t('Build "{title}" with {board} ({chip}). Reference price for the kit {price} (estimate).', { title, board: p.board.name, chip: t(p.chip.name), price: yuan(p.total) }), '');

  L.push('## ' + t('Hardware'), '');
  const mem = [t(p.chip.name), `${p.board.flashMB}MB Flash`, ...(p.board.psramMB ? [`${p.board.psramMB}MB PSRAM`] : [])].join(t('; '));
  L.push(t('- Dev board: {board} ({spec})', { board: p.board.name, spec: mem }));
  for (const id of r.need.parts) L.push(t('- {part}: {wiring}', { part: t(PARTS[id].name), wiring: wiring(r, id) }));
  if (a.bat) L.push(t('- {part}: {wiring}', { part: t(PARTS.battery.name), wiring: p.board.battery ? t('plug into the on-board battery connector; the board charges it') : t('needs a separate charger board') }));
  L.push('');

  L.push('## ' + t('Pins'), '');
  L.push(`| ${t('Use')} | ${t('Pins')} | ${t('Notes')} |`, '|---|---|---|');
  for (const x of p.pins) L.push(`| ${labelText(x.label)} | ${x.pins.map((n) => pinFull(p.board, n)).join(' / ')} | ${x.note ?? ''} |`);
  for (const x of p.pinProblems) L.push(`| ${t('Conflict')} | — | ${x} |`);
  L.push('');

  L.push('## ' + t('Requirements'), '');
  if (a.bat && r.need.duty) {
    const d = r.need.duty;
    const every = d.wakePerHour ? Math.round(60 / d.wakePerHour) : 0;
    L.push(d.wifi ? t('- Battery powered: wake every {min} minutes, work about {sec} s (including Wi-Fi connect and report), deep sleep otherwise', { min: every, sec: d.activeSec }) : t('- Battery powered: wake every {min} minutes, work about {sec} s, deep sleep otherwise', { min: every, sec: d.activeSec }));
    if (p.power) L.push(t('- Battery life target: {span} (estimate, 1000 mAh battery)', { span: lasts(p.power.days) }));
  }
  if (a.net) L.push(t('- Network: {net}', { net: `${r.need.caps.includes('wifi') ? 'Wi-Fi' : t('Bluetooth')}${r.need.caps.includes('ble') && r.need.caps.includes('wifi') ? ' + ' + t('Bluetooth') : ''}` }));
  const names = r.need.parts.map((id) => t(PARTS[id].short));
  if (names.length) L.push(t('- Print one status line to serial every time (reading / button / output) for comparison; uses {parts}', { parts: names.join(t(', ')) }));
  if (r.need.parts.includes('oled') || r.need.parts.includes('tft')) L.push(t('- Show the current reading or state on the display'));
  for (const c of r.s.req) L.push(t('- Must support: {cap}', { cap: capName(c as Cap) }));
  for (const w of r.tpl.risks) L.push(t('- Note: {risk}', { risk: t(w) }));
  L.push(t('- Framework: ESP-IDF v5.x or Arduino-ESP32; keep the pins in the table above'));
  L.push('');

  L.push('## ' + t('Acceptance (checkpoints TryBoard generates from the parts)'), '');
  checkpointsOf(r).forEach((c, i) => L.push(`${i + 1}. ${c.name}${c.manual ? t(' (real board only, TryBoard does not judge it)') : ''}`));
  const noModel = r.need.parts.filter((id) => PART_MAP[id] === null);
  if (noModel.length) L.push('', t('TryBoard has no model for {parts}; that part needs a real board.', { parts: noModel.map((id) => t(PARTS[id].short)).join(t(', ')) }));
  L.push('', t('A failed check reads "got x; want y": fix the code from that line.'), '');
  L.push(t('To run offline, install packages/tryboard locally from the repo'));
  return L.join('\n');
}
