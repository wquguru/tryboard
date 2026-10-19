// 元件库 schema 校验与核价提醒（P0-06）。
// 校验在单测（web/test/catalog.test.ts）和 tools/accept.sh 里跑：数据录错直接让验收失败，
// 而不是等页面上显示出错的价格或引脚。
import { PARTS, type Kind, type OnboardKind, type Part } from './parts.ts';

const KINDS: Kind[] = ['board', 'sensor', 'display', 'actuator', 'input', 'audio', 'power', 'cable', 'passive', 'module', 'proto', 'enclosure'];
const CHIPS = ['esp32', 'esp32c3', 'esp32s3'];
const ONBOARD_KINDS: OnboardKind[] = ['rgb', 'led', 'boot', 'button', 'lcd', 'imu', 'touch', 'ir', 'adc', 'other'];
/** 核价日期：YYYY-MM（只记年月）或 YYYY-MM-DD */
export const CHECKED_AT_RE = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/;

/** 待核 / 不适用条目的字段名：取 "：" 或 "（" 之前的部分，如 'board.ldo：…' → 'board.ldo' */
const keyOf = (s: string) => s.split(/[：（(]/)[0].trim();

/** 字段 field 是否被 todo / na 里的某条覆盖（'board.ldo' 覆盖 'board.ldo.maxMa'，'currentMa' 覆盖 'currentMa.typ'） */
function covered(field: string, list: string[]): boolean {
  return list.some((t) => {
    const k = keyOf(t);
    return k === field || field.startsWith(k + '.') || field.startsWith(k + '[');
  });
}

/** 值为 null 的字段路径（只看有语义的字段；Pin.v = null 表示"由外部决定"，不算缺数据） */
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

/** 校验一个件，返回问题列表（空 = 通过） */
export function validatePart(p: Part, all: Part[] = PARTS): string[] {
  const e: string[] = [];
  const req = (ok: unknown, msg: string) => {
    if (!ok) e.push(msg);
  };
  req(/^[a-z0-9][a-z0-9-]*$/.test(p.id), 'id 只能是小写字母、数字、连字符');
  for (const k of ['name', 'model', 'keywords', 'note'] as const) req(typeof p[k] === 'string' && p[k].trim().length > 0, `${k} 必填`);
  req(KINDS.includes(p.kind), `kind 未知：${p.kind}`);
  req(Array.isArray(p.chips) && p.chips.length > 0 && p.chips.every((c) => CHIPS.includes(c)), 'chips 至少一颗且只能是 esp32 / esp32c3 / esp32s3');
  req(Array.isArray(p.sources), 'sources 必须是数组');
  req(Array.isArray(p.todo), 'todo 必须是数组');
  const na = p.na ?? [];

  // 电压
  const s = p.voltage.supply;
  if (s) req(s[0] <= s[1], `voltage.supply 下限 ${s[0]} 大于上限 ${s[1]}`);
  // 电流：数值必须有来源说明；非估算的非零值必须有数据手册来源或在 todo 里
  req(p.currentMa.source.trim().length > 0, 'currentMa.source 必填（数据手册出处或"估算：依据"）');
  const nonzero = (p.currentMa.typ ?? 0) > 0 || (p.currentMa.peak ?? 0) > 0;
  if (!p.currentMa.est && nonzero) req(p.sources.length > 0 || covered('currentMa', p.todo), 'currentMa 标为非估算，但 sources 为空');
  if (p.currentMa.est && nonzero) req(/估算/.test(p.currentMa.source), 'currentMa.est = true 时 source 要写"估算"及依据');
  if (p.currentMa.typ !== null && p.currentMa.peak !== null) req(p.currentMa.typ <= p.currentMa.peak, 'currentMa.typ 大于 peak');
  // 没有任何来源的件：供电范围要么不适用，要么列为待核（不许凭空写数）
  if (p.sources.length === 0 && s) req(covered('voltage.supply', p.todo) || covered('voltage.supply', na), 'sources 为空却给了 voltage.supply，要写来源或列入 todo');

  // I2C
  if (p.i2cAddr) {
    for (const a of [p.i2cAddr.default, ...p.i2cAddr.alt]) req(a >= 0x08 && a <= 0x77, `I2C 地址 0x${a.toString(16)} 超出 7 位可用范围`);
    req(!p.i2cAddr.alt.includes(p.i2cAddr.default), 'i2cAddr.alt 不应包含 default');
  }
  if (p.sizeMm) req(p.sizeMm.every((x) => x === null || x > 0), 'sizeMm 必须为正');

  // 价格
  const pr = p.price;
  req(Number.isFinite(pr.lo) && Number.isFinite(pr.hi) && pr.lo >= 0, 'price.lo / hi 必须是非负数');
  req(pr.lo <= pr.hi, `price.lo ${pr.lo} 大于 price.hi ${pr.hi}`);
  req(pr.currency === 'CNY', 'price.currency 只支持 CNY');
  req(CHECKED_AT_RE.test(pr.checkedAt), `price.checkedAt 格式应为 YYYY-MM 或 YYYY-MM-DD：${pr.checkedAt}`);
  req(pr.source.trim().length > 0, 'price.source 必填');
  if (!pr.verified) req(/估|未.*核/.test(pr.source), '未核价（verified = false）的 price.source 要写明是估计');
  // 外链：只用搜索页，不放店铺 / 联盟参数（docs/LICENSING.md）
  req(p.searchUrl.taobao.startsWith('https://s.taobao.com/search?q='), 'searchUrl.taobao 只能是淘宝搜索页');
  req(p.searchUrl.szlcsc.startsWith('https://so.szlcsc.com/global.html?k='), 'searchUrl.szlcsc 只能是立创商城搜索页');
  for (const u of Object.values(p.searchUrl)) req(!/[?&](pid|unid|tk|aff|ref)=/i.test(u), `外链带推广参数：${u}`);

  // null 必须有交代
  for (const f of nullFields(p)) req(covered(f, p.todo) || covered(f, na), `${f} 为 null，但 todo / na 里没有说明`);

  // 关联
  const ids = new Set(all.map((x) => x.id));
  for (const r of p.requires ?? []) {
    req(ids.has(r.partId), `requires 指向不存在的件 ${r.partId}`);
    req(r.why.trim().length > 0, `requires ${r.partId} 缺 why`);
  }
  if (p.kind === 'board') {
    req(!!p.board, 'kind = board 必须有 board 信息');
    if (p.board) {
      req(p.chips.length === 1 && p.chips[0] === p.board.chip, 'board.chip 与 chips 不一致');
      const gp = (p.pins ?? []).map((x) => x.gpio).filter((g) => g !== undefined);
      if (p.board.rgbGpio !== null && p.pins) req(gp.includes(p.board.rgbGpio) || p.board.onboard.some((o) => o.gpio === p.board!.rgbGpio), 'rgbGpio 不在板上');
      // P1-12：每块板都要有可点开的来源；板载占用、内置件、屏引脚互相对得上
      const b = p.board;
      req(Array.isArray(b.urls) && b.urls.length > 0, 'board.urls 至少一个来源 URL');
      for (const u of b.urls ?? []) req(/^https:\/\/[^\s]+$/.test(u), `board.urls 只能是 https 链接：${u}`);
      for (const o of b.onboard) {
        req(ONBOARD_KINDS.includes(o.kind), `board.onboard kind 未知：${o.kind}`);
        req(Number.isInteger(o.gpio) && o.gpio >= 0 && o.gpio <= 48, `board.onboard GPIO${o.gpio} 超出范围`);
        req(o.what.trim().length > 0, `board.onboard GPIO${o.gpio} 缺 what`);
      }
      const dup = b.onboard.map((o) => o.gpio).filter((g, i, a) => a.indexOf(g) !== i);
      req(dup.length === 0, `board.onboard 同一个 GPIO 写了两次：${dup.join(', ')}`);
      for (const x of b.builtin ?? []) req(ids.has(x.partId), `board.builtin 指向不存在的件 ${x.partId}`);
      if (b.lcd) for (const [k, g] of Object.entries(b.lcd)) req(b.onboard.some((o) => o.gpio === g && o.kind === 'lcd'), `board.lcd.${k} = GPIO${g} 不在 onboard 的屏占用里`);
      if (b.version !== undefined) req(!!b.family, '有 version 就要有 family（R23 / R32 按 family 找同款另一版）');
    }
  } else req(!p.board, '只有 kind = board 能带 board 信息');
  if (p.provides) req(p.provides.maxMa > 0, 'provides.maxMa 必须为正');
  return e;
}

/** 校验整个库：返回 "id: 问题" 列表 */
export function validateCatalog(all: Part[] = PARTS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of all) {
    if (seen.has(p.id)) out.push(`${p.id}: id 重复`);
    seen.add(p.id);
    for (const e of validatePart(p, all)) out.push(`${p.id}: ${e}`);
  }
  return out;
}

/** 核价日期 → UTC 毫秒。只有年月时取当月 1 日（偏保守：宁可早提醒） */
function checkedMs(s: string): number | null {
  const m = CHECKED_AT_RE.exec(s);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1);
}

export interface StalePrice {
  id: string;
  name: string;
  checkedAt: string;
  /** 距今天数；日期格式坏掉时为 null（同样要提醒） */
  ageDays: number | null;
}

/** 超过 days 天没核价的件（today：'YYYY-MM-DD' 或 Date） */
export function stalePrices(today: string | Date, days = 120, all: Part[] = PARTS): StalePrice[] {
  const t = typeof today === 'string' ? checkedMs(today) : Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (t === null) throw new Error(`today 格式应为 YYYY-MM-DD：${today}`);
  const out: StalePrice[] = [];
  for (const p of all) {
    const c = checkedMs(p.price.checkedAt);
    const age = c === null ? null : Math.floor((t - c) / 86400000);
    if (age === null || age > days) out.push({ id: p.id, name: p.name, checkedAt: p.price.checkedAt, ageDays: age });
  }
  return out;
}

/** 所有待核字段：给 Reviews 报告与人工核对用 */
export function todoList(all: Part[] = PARTS): { id: string; todo: string[] }[] {
  return all.filter((p) => p.todo.length).map((p) => ({ id: p.id, todo: p.todo }));
}
