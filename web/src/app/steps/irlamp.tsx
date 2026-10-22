// G-04b IR night light in the Product step: remote keys (phone keys + desktop buttons), readings rows, serial -> timeline.
// Kept outside productStep so that function doesn't grow (tools/lint_size.py). Keys go through the ir= input like the bench remote.
import type { ReactNode } from 'react';
import type { Tool } from '../toolbar';
import type { Session } from '../types';
import { irCode } from '../irfeed';
import { IRLAMP_CMD, holdKey, irlampNow, parseIrlampLine } from '../../views/irlampproduct';
import type { LiveFrame } from '../../views/common';
import { t } from '../../i18n';

(globalThis as unknown as { __tbIrlamp: unknown }).__tbIrlamp = irlampNow;

const NAMES = () => [t('Red'), t('Green'), t('Blue'), t('Yellow'), t('Cyan'), t('Purple'), t('Pink'), t('Warm white'), t('White')];
/** Repeat codes sent by the "hold" key: four, about 0.45 s of holding (the firmware steps one level per repeat) */
const HOLD_REPEATS = 4;

/** Send one remote code (NEC 'FF00,..' or 'repeat'); exported for the 3D product's clickable remote */
export const irlampSend = (s: Session, code: string) => s.sim?.partInput({ kind: 'ir', code });

/** Press a key and keep it down for n repeat codes, then release */
export function irlampHold(s: Session, cmd: number, n = HOLD_REPEATS) {
  const release = holdKey((code) => irlampSend(s, code), cmd);
  setTimeout(release, 110 * (n + 1) - 10);
}

const KEY: Record<string, number> = { 'p-ir-power': IRLAMP_CMD.power, 'p-ir-1': IRLAMP_CMD.digits[0], 'p-ir-2': IRLAMP_CMD.digits[1], 'p-ir-3': IRLAMP_CMD.digits[2], 'p-ir-up': IRLAMP_CMD.up, 'p-ir-down': IRLAMP_CMD.down };

/** Phone product keys: power, colours 1–3, VOL+ / VOL-, hold VOL+ (repeat codes) */
export const irlampActs = (): Tool[] => [
  { id: 'p-ir-power', label: t('Power'), icon: 'power' },
  ...[1, 2, 3].map((n) => ({ id: `p-ir-${n}`, label: `${n} · ${NAMES()[n - 1]}`, icon: 'sun' })),
  { id: 'p-ir-up', label: 'VOL+', icon: 'plus' },
  { id: 'p-ir-down', label: 'VOL-', icon: 'minus' },
  { id: 'p-ir-hold', label: t('Hold VOL+'), icon: 'up' },
];

/** Toolbar / button action; ids p-ir-power | p-ir-1..3 | p-ir-up | p-ir-down | p-ir-hold */
export function irlampTool(id: string, s: Session) {
  if (id === 'p-ir-hold') irlampHold(s, IRLAMP_CMD.up);
  else if (id in KEY) irlampSend(s, irCode(KEY[id]));
}

/** Desktop buttons, same verbs as the phone keys */
export function irlampButtons(b: (id: string, label: string, f: () => void) => ReactNode, s: Session) {
  return irlampActs().map((a) => b(`pIr-${a.id.slice(5)}`, a.label, () => irlampTool(a.id, s)));
}

export const irlampRows = (row: (k: string, live: string) => ReactNode) => [row(t('Remote code'), 'irc'), row(t('Light'), 'ilight'), row(t('LED strip'), 'istrip'), row(t('Strip current (estimate)'), 'ima')];

export function irlampLive(set: (k: string, v: string, bad?: boolean) => void, waiting: string, f?: LiveFrame) {
  const s = irlampNow;
  set('irc', s.code ? (s.code === 'repeat' ? t('repeat (key held)') : s.code) + ` · ${t('{n} received', { n: s.keys })}` : t('No key yet'));
  set('ilight', !s.color ? waiting : s.on ? t('On · {color} · brightness {level}/8', { color: `${s.color} ${NAMES()[s.color - 1]}`, level: s.level }) : t('Off'));
  const c = f?.strips?.[5]?.[0];
  set('istrip', c && Math.max(...c) ? `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')} × 8` : t('Off'));
  set('ima', s.color ? `${s.mA} mA` : waiting, s.mA > 400);
}

/** Serial line -> light state + timeline event */
export function irlampSerial(l: string, event: (icon: string, text: string, tone?: 'ok' | 'bad') => void) {
  const e = parseIrlampLine(l, irlampNow);
  if (e) event(...e);
}
