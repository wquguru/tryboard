// Part library schema validation and price-check reminders (P0-06). Runs in the unit test and
// tools/accept.sh so bad data fails acceptance instead of showing a wrong price or pin on the page.
import { PARTS, type Kind, type OnboardKind, type Part } from './parts.ts';

const KINDS: Kind[] = ['board', 'sensor', 'display', 'actuator', 'input', 'audio', 'power', 'cable', 'passive', 'module', 'proto', 'enclosure'];
const CHIPS = ['esp32', 'esp32c3', 'esp32s3'];
const ONBOARD_KINDS: OnboardKind[] = ['rgb', 'led', 'boot', 'button', 'lcd', 'imu', 'touch', 'ir', 'adc', 'other'];
/** Price check date: YYYY-MM (month only) or YYYY-MM-DD */
export const CHECKED_AT_RE = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/;

/** Field name of a todo / na entry: the part before ":" or "(", e.g. 'board.ldo: ...' -> 'board.ldo' */
const keyOf = (s: string) => s.split(/[:：（(]/)[0].trim(); // lint: allow-cjk

/** Whether a todo / na entry covers field ('board.ldo' covers 'board.ldo.maxMa', 'currentMa' covers 'currentMa.typ') */
function covered(field: string, list: string[]): boolean {
  return list.some((t) => {
    const k = keyOf(t);
    return k === field || field.startsWith(k + '.') || field.startsWith(k + '[');
  });
}

/** Paths of null fields (meaningful ones only; Pin.v = null means "set externally", not missing data) */
export function nullFields(p: Part): string[] {
  const out: string[] = [];
  if (p.pins === null) out.push('pins');
  if (p.voltage.supply === null) out.push('voltage.supply');
  if (p.voltage.logic === null) out.push('voltage.logic');
  if (p.currentMa.typ === null) out.push('currentMa.typ');
  if (p.currentMa.peak === null) out.push('currentMa.peak');
  if (p.i2cPullupK === null) out.push('i2cPullupK');
  if (p.sizeMm === null) out.push('sizeMm');
  else if (p.sizeMm[2] === null) out.push('sizeMm[2]');
  if (p.sim.level !== 'none' && p.sim.model === null) out.push('sim.model');
  const b = p.board;
  if (b) {
    if (b.flashMB === null) out.push('board.flashMB');
    if (b.psramMB === null) out.push('board.psramMB');
    if (b.psram === null) out.push('board.psram');
    if (b.ldo.model === null) out.push('board.ldo.model');
    if (b.ldo.maxMa === null) out.push('board.ldo.maxMa');
    if (b.usb === null) out.push('board.usb');
  }
  return out;
}

/** Validate one part and return its problems (empty = pass) */
export function validatePart(p: Part, all: Part[] = PARTS): string[] {
  const e: string[] = [];
  const req = (ok: unknown, msg: string) => {
    if (!ok) e.push(msg);
  };
  req(/^[a-z0-9][a-z0-9-]*$/.test(p.id), 'id may only contain lowercase letters, digits and hyphens');
  for (const k of ['name', 'model', 'keywords', 'note'] as const) req(typeof p[k] === 'string' && p[k].trim().length > 0, `${k} is required`);
  req(KINDS.includes(p.kind), `unknown kind: ${p.kind}`);
  req(Array.isArray(p.chips) && p.chips.length > 0 && p.chips.every((c) => CHIPS.includes(c)), 'chips needs at least one of esp32 / esp32c3 / esp32s3 and nothing else');
  req(Array.isArray(p.sources), 'sources must be an array');
  req(Array.isArray(p.todo), 'todo must be an array');
  const na = p.na ?? [];

  // Voltage
  const s = p.voltage.supply;
  if (s) req(s[0] <= s[1], `voltage.supply lower bound ${s[0]} is above upper bound ${s[1]}`);
  // Current: every value needs a source; a non-estimated nonzero value needs a datasheet source or a todo
  req(p.currentMa.source.trim().length > 0, 'currentMa.source is required (datasheet reference or "Estimate: basis")');
  const nonzero = (p.currentMa.typ ?? 0) > 0 || (p.currentMa.peak ?? 0) > 0;
  if (!p.currentMa.est && nonzero) req(p.sources.length > 0 || covered('currentMa', p.todo), 'currentMa is not an estimate but sources is empty');
  if (p.currentMa.est && nonzero) req(/estimat/i.test(p.currentMa.source), 'with currentMa.est = true the source must say "Estimate" and give the basis');
  if (p.currentMa.typ !== null && p.currentMa.peak !== null) req(p.currentMa.typ <= p.currentMa.peak, 'currentMa.typ is above peak');
  // A part with no sources: its supply range is either n/a or listed as todo (no numbers out of thin air)
  if (p.sources.length === 0 && s) req(covered('voltage.supply', p.todo) || covered('voltage.supply', na), 'sources is empty but voltage.supply is given; add a source or a todo');

  // I2C
  if (p.i2cAddr) {
    for (const a of [p.i2cAddr.default, ...p.i2cAddr.alt]) req(a >= 0x08 && a <= 0x77, `I2C address 0x${a.toString(16)} is outside the usable 7-bit range`);
    req(!p.i2cAddr.alt.includes(p.i2cAddr.default), 'i2cAddr.alt must not contain default');
  }
  if (p.sizeMm) req(p.sizeMm.every((x) => x === null || x > 0), 'sizeMm must be positive');

  // Price
  const pr = p.price;
  req(Number.isFinite(pr.lo) && Number.isFinite(pr.hi) && pr.lo >= 0, 'price.lo / hi must be non-negative numbers');
  req(pr.lo <= pr.hi, `price.lo ${pr.lo} is above price.hi ${pr.hi}`);
  req(pr.currency === 'CNY', 'price.currency only supports CNY');
  req(CHECKED_AT_RE.test(pr.checkedAt), `price.checkedAt must be YYYY-MM or YYYY-MM-DD: ${pr.checkedAt}`);
  req(pr.source.trim().length > 0, 'price.source is required');
  if (!pr.verified) req(/estimat|not verified/i.test(pr.source), 'an unverified price (verified = false) must say it is an estimate in price.source');
  // External links: search pages only, no shop / affiliate parameters (docs/LICENSING.md)
  req(p.searchUrl.taobao.startsWith('https://s.taobao.com/search?q='), 'searchUrl.taobao must be a Taobao search page');
  req(p.searchUrl.szlcsc.startsWith('https://so.szlcsc.com/global.html?k='), 'searchUrl.szlcsc must be an LCSC search page');
  for (const u of Object.values(p.searchUrl)) req(!/[?&](pid|unid|tk|aff|ref)=/i.test(u), `external link carries an affiliate parameter: ${u}`);

  // Every null must be explained
  for (const f of nullFields(p)) req(covered(f, p.todo) || covered(f, na), `${f} is null but todo / na does not explain it`);

  // References
  const ids = new Set(all.map((x) => x.id));
  for (const r of p.requires ?? []) {
    req(ids.has(r.partId), `requires points to a missing part ${r.partId}`);
    req(r.why.trim().length > 0, `requires ${r.partId} has no why`);
  }
  if (p.kind === 'board') {
    req(!!p.board, 'kind = board needs board info');
    if (p.board) {
      req(p.chips.length === 1 && p.chips[0] === p.board.chip, 'board.chip does not match chips');
      const gp = (p.pins ?? []).map((x) => x.gpio).filter((g) => g !== undefined);
      if (p.board.rgbGpio !== null && p.pins) req(gp.includes(p.board.rgbGpio) || p.board.onboard.some((o) => o.gpio === p.board!.rgbGpio), 'rgbGpio is not on the board');
      // P1-12: every board needs a clickable source, and onboard use, built-ins and display pins must agree
      const b = p.board;
      req(Array.isArray(b.urls) && b.urls.length > 0, 'board.urls needs at least one source URL');
      for (const u of b.urls ?? []) req(/^https:\/\/[^\s]+$/.test(u), `board.urls must be https links: ${u}`);
      for (const o of b.onboard) {
        req(ONBOARD_KINDS.includes(o.kind), `unknown board.onboard kind: ${o.kind}`);
        req(Number.isInteger(o.gpio) && o.gpio >= 0 && o.gpio <= 48, `board.onboard GPIO${o.gpio} is out of range`);
        req(o.what.trim().length > 0, `board.onboard GPIO${o.gpio} has no what`);
      }
      const dup = b.onboard.map((o) => o.gpio).filter((g, i, a) => a.indexOf(g) !== i);
      req(dup.length === 0, `board.onboard lists the same GPIO twice: ${dup.join(', ')}`);
      for (const x of b.builtin ?? []) req(ids.has(x.partId), `board.builtin points to a missing part ${x.partId}`);
      if (b.lcd) for (const [k, g] of Object.entries(b.lcd)) req(b.onboard.some((o) => o.gpio === g && o.kind === 'lcd'), `board.lcd.${k} = GPIO${g} is not among the onboard display pins`);
      if (b.version !== undefined) req(!!b.family, 'version needs family (R23 / R32 find the sibling version by family)');
    }
  } else req(!p.board, 'only kind = board may carry board info');
  if (p.provides) req(p.provides.maxMa > 0, 'provides.maxMa must be positive');
  return e;
}

/** Validate the whole library: returns a list of "id: problem" */
export function validateCatalog(all: Part[] = PARTS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of all) {
    if (seen.has(p.id)) out.push(`${p.id}: duplicate id`);
    seen.add(p.id);
    for (const e of validatePart(p, all)) out.push(`${p.id}: ${e}`);
  }
  return out;
}

/** Price check date -> UTC ms. Month-only dates use the 1st (conservative: remind early rather than late) */
function checkedMs(s: string): number | null {
  const m = CHECKED_AT_RE.exec(s);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1);
}

export interface StalePrice {
  id: string;
  name: string;
  checkedAt: string;
  /** Days since the check; null when the date is malformed (also reminded) */
  ageDays: number | null;
}

/** Parts whose price has not been checked for more than days (today: 'YYYY-MM-DD' or Date) */
export function stalePrices(today: string | Date, days = 120, all: Part[] = PARTS): StalePrice[] {
  const t = typeof today === 'string' ? checkedMs(today) : Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (t === null) throw new Error(`today must be YYYY-MM-DD: ${today}`);
  const out: StalePrice[] = [];
  for (const p of all) {
    const c = checkedMs(p.price.checkedAt);
    const age = c === null ? null : Math.floor((t - c) / 86400000);
    if (age === null || age > days) out.push({ id: p.id, name: p.name, checkedAt: p.price.checkedAt, ageDays: age });
  }
  return out;
}

/** All todo fields, for the Reviews report and manual checking */
export function todoList(all: Part[] = PARTS): { id: string; todo: string[] }[] {
  return all.filter((p) => p.todo.length).map((p) => ({ id: p.id, todo: p.todo }));
}
