// BLE data feed (C-01) without the dock UI: session pushes, the build tree / inspector / lazy Bluetooth tab read (R-12).
import { useSyncExternalStore } from 'react';
import type { BleLine, BleUpdate, BleView } from '../ble';
import { t } from '../i18n';

const LOG_CAP = 1000;

export interface BleSnap {
  /** 0 = firmware doesn't use BLE, 1 = running, 2 = VHCI boundary not recognised */
  state: number;
  view: BleView | null;
  error: string;
  log: BleLine[];
  /** Why the last phone command was rejected (cleared when the next one is accepted) */
  cmdError: string;
}

function createBleFeed() {
  let snap: BleSnap = { state: 0, view: null, error: '', log: [], cmdError: '' };
  let log: BleLine[] = [];
  let timer = 0;
  let last = 0;
  const subs = new Set<() => void>();
  let pending: Partial<BleSnap> = {};
  const notify = () => {
    timer = 0;
    last = performance.now();
    snap = { ...snap, ...pending, log };
    pending = {};
    for (const f of subs) f();
  };
  const schedule = (now = false) => {
    if (now) {
      clearTimeout(timer);
      notify();
      return;
    }
    if (timer) return;
    const wait = 100 - (performance.now() - last);
    if (wait <= 0) notify();
    else timer = window.setTimeout(notify, wait);
  };
  return {
    get: () => snap,
    update(u: BleUpdate) {
      if (u.cmdError !== undefined) {
        pending.cmdError = u.cmdError;
        schedule(true);
        return;
      }
      if (u.reset) {
        log = [];
        pending = { view: null, error: '', cmdError: '' };
      }
      if (u.log.length) {
        log = log.concat(u.log);
        if (log.length > LOG_CAP) log = log.slice(log.length - LOG_CAP);
      }
      const stateChanged = u.state !== (pending.state ?? snap.state);
      pending.state = u.state;
      if (u.view) pending.view = u.view;
      if (u.error !== undefined) pending.error = u.error;
      // Notify state changes (appeared / unrecognised) at once: the dock tab and build tree must appear immediately
      schedule(stateChanged || !!u.reset);
    },
    /** The user sent a command: clear the previous error first */
    clearError() {
      if (snap.cmdError) {
        pending.cmdError = '';
        schedule(true);
      }
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
/** One per page: session pushes; dock tab, inspector and build tree read */
export const bleFeed = createBleFeed();
export const useBle = () => useSyncExternalStore(bleFeed.subscribe, bleFeed.get);

/** Status word after "Virtual phone" in the build tree */
export function phoneStateText(s: BleSnap): string {
  if (s.state === 2) return t('Not recognised');
  const p = s.view?.phone;
  if (!p) return '';
  return { idle: s.view?.advertising ? t('Board advertising') : t('Idle'), scanning: t('Scanning'), connecting: t('Connecting'), connected: t('Connected') }[p.state];
}

const two = (n: number) => String(n).padStart(2, '0');
/** Simulated microseconds -> 00:01.204 */
export function simClock(us: number) {
  const ms = Math.floor(us / 1000);
  return `${two(Math.floor(ms / 60000))}:${two(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, '0')}`;
}
