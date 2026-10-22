// G-03b door lock in the Product step: card actions (phone keys + desktop buttons), readings rows, serial -> timeline.
// Kept outside productStep so that function doesn't grow (tools/lint_size.py).
import type { ReactNode } from 'react';
import type { Tool } from '../toolbar';
import type { Session } from '../types';
import { DOOR_CARDS, doorNow, parseDoorLine } from '../../views/doorproduct';
import { t } from '../../i18n';

/** UID currently laid on the reader by these buttons (the firmware only reacts to a new card, so a re-tap lifts first) */
let onReader = '';
const LIFT_MS = 400;

(globalThis as unknown as { __tbDoor: unknown }).__tbDoor = doorNow;

/** Lay a card on the reader ('' = take it away); exported for the 3D product's clickable cards */
export function doorTap(s: Session, uid: string) {
  const put = (u: string) => {
    onReader = u;
    s.sim?.partInput({ kind: 'card', uid: u || 'none' });
  };
  if (uid && onReader) {
    put('');
    setTimeout(() => put(uid), LIFT_MS);
  } else put(uid);
}

/** UID on the reader right now ('' = none) */
export const doorOnReader = () => onReader;

const ACT: Record<string, string> = { 'p-card-ok': DOOR_CARDS.ok, 'p-card-bad': DOOR_CARDS.bad, 'p-card-off': '' };

/** Phone product keys */
export const doorActs = (): Tool[] => [
  { id: 'p-card-ok', label: t('Tap whitelisted card'), icon: 'check' },
  { id: 'p-card-bad', label: t('Tap unknown card'), icon: 'warn' },
  { id: 'p-card-off', label: t('Take card away'), icon: 'x' },
];

/** Toolbar / button action; ids p-card-ok | p-card-bad | p-card-off */
export function doorTool(id: string, s: Session) {
  if (id in ACT) doorTap(s, ACT[id]);
}

/** Desktop buttons, same verbs as the phone keys */
export function doorButtons(b: (id: string, label: string, f: () => void) => ReactNode, s: Session) {
  return [b('pCardOk', t('Tap whitelisted card'), () => doorTap(s, DOOR_CARDS.ok)), b('pCardBad', t('Tap unknown card'), () => doorTap(s, DOOR_CARDS.bad)), b('pCardOff', t('Take card away'), () => doorTap(s, ''))];
}

export const doorRows = (row: (k: string, live: string) => ReactNode) => [row(t('Card reader'), 'dver'), row(t('Card on the reader'), 'dcard'), row(t('Door strike (relay GPIO10)'), 'dlock'), row(t('Refusals in a row'), 'dfail')];

export function doorLive(set: (k: string, v: string, bad?: boolean) => void, waiting: string) {
  const s = doorNow;
  set('dver', s.ver ? t('RC522 version 0x{v}', { v: s.ver }) : waiting, !!s.ver && s.ver !== '92');
  set('dcard', s.card || t('None'));
  set('dlock', s.left ? t('Locked out · {n} s left', { n: s.left }) : s.open ? t('Strike open (relay on)') : t('Locked (relay off)'), !!s.left);
  set('dfail', `${s.fails} / 3`, s.fails > 0);
}

/** Serial line -> door state + timeline event */
export function doorSerial(l: string, event: (icon: string, text: string, tone?: 'ok' | 'bad') => void) {
  // The version line is the first thing every boot prints: a fresh power-up, so nothing is on the reader any more
  if (l.startsWith('RC522 ')) onReader = '';
  const e = parseDoorLine(l, doorNow);
  if (e) event(...e);
}
