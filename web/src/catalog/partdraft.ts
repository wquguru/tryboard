// Part catalog helpers: draft -> Part with defaults, pin shorthands (split out of parts.ts for the size guardrail).
import { NPINS } from '../chipid.ts';
import type { ChipId, Draft, Part, Pin, PinType } from './parts.ts';

export const CHECKED_AT = '2026-10';
const PRICE_SRC = 'Estimated from typical Taobao prices, not individually verified, shipping excluded';

export const searchUrls = (kw: string) => ({
  taobao: 'https://s.taobao.com/search?q=' + encodeURIComponent(kw),
  szlcsc: 'https://so.szlcsc.com/global.html?k=' + encodeURIComponent(kw),
});

// External modules only care about levels and buses, so the classic ESP32 works too (added in C-05)
const BOTH = Object.keys(NPINS) as ChipId[];

export function P(d: Draft): Part {
  return {
    ...d,
    chips: d.chips ?? BOTH,
    i2cAddr: d.i2cAddr ?? null,
    sizeMm: d.sizeMm ?? null,
    sim: d.sim ?? { level: 'none', model: null },
    price: { lo: d.price[0], hi: d.price[1], currency: 'CNY', checkedAt: CHECKED_AT, source: PRICE_SRC, verified: false },
    searchUrl: searchUrls(d.keywords),
    sources: d.sources ?? [],
    todo: d.todo ?? [],
  };
}

export const pin = (label: string, type: PinType, v: Pin['v'], extra: Partial<Pin> = {}): Pin => ({ label, type, v, ...extra });
export const VCC = (label = 'VCC') => pin(label, 'power', 'vcc');
export const GND = (label = 'GND') => pin(label, 'gnd', 0);
