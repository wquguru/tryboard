// G-17b AMOLED desk clock in the Product step: swipe / PWR / phone time-sync keys, readings rows, serial -> timeline.
// Kept outside productStep (tools/lint_size.py). Every key goes through logged inputs (touch= / release / pwrkey= / ble=), so --inputs replays it.
import type { ReactNode } from 'react';
import type { Tool } from '../toolbar';
import type { Session } from '../types';
import { bleFeed } from '../blefeed';
import { amoclockNow, parseAmoclockLine, swipePath, syncBytes } from '../../views/amoclockproduct';
import { t } from '../../i18n';

(globalThis as unknown as { __tbAmoclock: unknown }).__tbAmoclock = amoclockNow;

/** Wall-clock gap between swipe points (amoclock-2 uses 50 ms of sim time) */
const STEP_MS = 50;

/** One horizontal swipe along y = 240 through the session (logged touch= then release) */
export function amoSwipe(s: Session, dir: 'left' | 'right') {
  swipePath(dir).forEach((x, i) => setTimeout(() => s.touch(x, 240, true), i * STEP_MS));
  setTimeout(() => s.touch(swipePath(dir)[4], 240, false), 5 * STEP_MS + 100);
}

/** Virtual phone sets the clock: scan, connect once the board shows up, write FF11 once the GATT table is read */
export function amoSync(s: Session) {
  const phone = () => bleFeed.get().view?.phone;
  const write = () => s.sim?.ble(`write ff11 ${syncBytes()}`);
  const wait = (ok: () => boolean, then: () => void, n = 0) => {
    if (ok()) then();
    else if (n < 60) setTimeout(() => wait(ok, then, n + 1), 150);
  };
  if (phone()?.state === 'connected') return write();
  s.sim?.ble('scan');
  wait(
    () => !!phone()?.devices.some((d) => d.name === 'TryBoard-Clock'),
    () => {
      s.sim?.ble('connect');
      wait(() => phone()?.state === 'connected' && !!phone()?.ready && !phone()?.busy, write);
    },
  );
}

/** Phone product keys: swipe left / right, PWR, set the time from the phone */
export const amoclockActs = (): Tool[] => [
  { id: 'p-amo-left', label: t('Swipe left'), icon: 'left' },
  { id: 'p-amo-right', label: t('Swipe right'), icon: 'right' },
  { id: 'p-amo-pwr', label: t('PWR key'), icon: 'power' },
  { id: 'p-amo-sync', label: t('Set time from phone'), icon: 'restart' },
];

/** Toolbar / button action; ids p-amo-left | p-amo-right | p-amo-pwr | p-amo-sync */
export function amoclockTool(id: string, s: Session) {
  if (id === 'p-amo-left' || id === 'p-amo-right') amoSwipe(s, id === 'p-amo-left' ? 'left' : 'right');
  else if (id === 'p-amo-pwr') s.pwrKey(false);
  else if (id === 'p-amo-sync') amoSync(s);
}

/** Desktop buttons, same verbs as the phone keys */
export function amoclockButtons(b: (id: string, label: string, f: () => void) => ReactNode, s: Session) {
  return amoclockActs().map((a) => b(`pAmo-${a.id.slice(6)}`, a.label, () => amoclockTool(a.id, s)));
}

export const amoclockRows = (row: (k: string, live: string) => ReactNode) => [row(t('Clock face'), 'aface'), row(t('Screen'), 'ascr'), row(t('Battery'), 'abat'), row(t('Phone (BLE)'), 'able')];

const PAGE = () => [t('Time'), t('Temperature'), t('Battery')];
export function amoclockLive(set: (k: string, v: string, bad?: boolean) => void, waiting: string) {
  const s = amoclockNow;
  set('aface', s.time ? `${s.date} ${s.time}` : waiting);
  set('ascr', s.on ? t('On · page {n}/3 · {name}', { n: s.page, name: PAGE()[s.page - 1] }) : t('Off (brightness 0x51 = 0)'), !s.on);
  set('abat', s.bat || waiting);
  set('able', s.sync ? t('Time set {time}', { time: s.sync }) : s.ble === 'conn' ? t('Connected') : s.ble === 'adv' ? t('Advertising TryBoard-Clock') : waiting);
}

/** Serial line -> clock state + timeline event */
export function amoclockSerial(l: string, event: (icon: string, text: string, tone?: 'ok' | 'bad') => void) {
  const e = parseAmoclockLine(l, amoclockNow);
  if (e) event(...e);
}
