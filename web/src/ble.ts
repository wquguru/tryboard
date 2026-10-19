// BLE (C-01): shape of the core's tb_ble_json (core soc/src/ble Ble::json / Phone::json / log_json) and parsing.
// Controller and phone run in the core on sim time; the page only displays and sends ble=<cmd> (same text as CLI scripts).
import { t } from './i18n';

export interface BleDevice {
  addr: string;
  name: string;
  rssi: number;
  connectable: boolean;
  uuids: string[];
}
export interface BleChar {
  uuid: string;
  name: string;
  handle: number;
  props: ('read' | 'write-nr' | 'write' | 'notify' | 'indicate')[];
  cccd: number | null;
  /** Last read / notified value (hex, space separated). */
  value: string;
  /** Plain-language value for known characteristics ("87%", "72 bpm"). */
  text: string;
  notify: boolean;
  notes: number;
  /** Notification history: [sim ms, value]. */
  hist: [number, number][];
}
export interface BleService {
  uuid: string;
  name: string;
  start: number;
  end: number;
  chars: BleChar[];
}
export interface PhoneView {
  state: 'idle' | 'scanning' | 'connecting' | 'connected';
  ready: boolean;
  busy: boolean;
  mtu: number;
  rssi: number;
  auto: boolean;
  target: string | null;
  devices: BleDevice[];
  services: BleService[];
}
export interface BleView {
  active: boolean;
  advertising: boolean;
  adv_name: string;
  connected: boolean;
  addr: string;
  log_seq: number;
  phone: PhoneView;
}
/** One air-log line: n sequence, t sim µs, k kind (adv / conn / att / phone / hci), s text. */
export interface BleLine {
  n: number;
  t: number;
  k: string;
  s: string;
}

/** One parsed BLE update from the worker. */
export interface BleUpdate {
  /** 0 = firmware does not use BLE, 1 = running, 2 = VHCI boundary not recognised. */
  state: number;
  view?: BleView;
  log: BleLine[];
  error?: string;
  reset?: boolean;
  cmdError?: string;
}

export function parseBle(state: number, json: string, reset?: boolean, cmdError?: string): BleUpdate {
  const u: BleUpdate = { state, log: [], reset, cmdError };
  if (!json) return u;
  const j = JSON.parse(json) as { view?: BleView; log?: BleLine[]; error?: string };
  u.view = j.view;
  u.log = j.log ?? [];
  u.error = j.error;
  return u;
}

// Core log prefixes: English ('phone → ', 'fw → ', 'phone: ') plus the older Chinese ones, so either core build parses.
const PHONE_TO = /^(phone|手机) → /; // lint: allow-cjk
const FW_TO = /^(fw|firmware|固件) → /; // lint: allow-cjk
const PHONE_SAYS = /^(phone|手机)[:：] ?/; // lint: allow-cjk

/** Direction of a log line (the design's three: board → air / phone → board / board → phone, plus the phone's own actions). */
export function lineDir(l: BleLine): string {
  if (l.k === 'adv') return t('Board → advertising');
  if (PHONE_TO.test(l.s)) return t('Phone → board');
  if (FW_TO.test(l.s)) return t('Board → phone');
  if (l.k === 'conn') return l.s.startsWith('CONNECT_IND') ? t('Phone → board') : t('Connection');
  if (l.k === 'hci') return t('Firmware ↔ controller');
  return t('Phone');
}

/** Strip the direction prefix, leaving what happened. */
export function lineText(l: BleLine): string {
  return l.s.replace(PHONE_TO, '').replace(FW_TO, '').replace(PHONE_SAYS, '');
}

/** 16-bit UUIDs as 0x180D; 128-bit as is. */
export const uuidLabel = (u: string) => (u.length === 4 ? `0x${u}` : u);
