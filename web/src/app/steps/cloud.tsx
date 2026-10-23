// G-05b temperature / humidity to the cloud in the Product step: cloud command keys, readings rows, serial -> timeline.
// Kept outside productStep (tools/lint_size.py). Commands go through mqtt= like the network tab's MQTT panel, so they land in the input log.
import type { ReactNode } from 'react';
import type { Tool } from '../toolbar';
import type { Session } from '../types';
import { cloudCmd, cloudNow, parseCloudLine } from '../../views/cloudproduct';
import { t } from '../../i18n';

(globalThis as unknown as { __tbCloud: unknown }).__tbCloud = cloudNow;

/** Publish one command on tryboard/cloud/cmd from the virtual cloud */
export const cloudSend = (s: Session, payload: string) => s.sim?.mqttPub(cloudCmd(payload));

/** Room change per warmer / cooler press (℃) */
const STEP = 2;

/** All verbs: interval 2 / 5 / 10 s, an out-of-range command, room warmer / cooler */
const allActs = (): Tool[] => [
  { id: 'p-cloud-2', label: t('Interval 2 s'), icon: 'up' },
  { id: 'p-cloud-5', label: t('Interval 5 s'), icon: 'restart' },
  { id: 'p-cloud-10', label: t('Interval 10 s'), icon: 'down' },
  { id: 'p-cloud-0', label: t('Send interval=0 (refused)'), icon: 'warn' },
  { id: 'p-cloud-warm', label: t('Room +{n} ℃', { n: STEP }), icon: 'flame' },
  { id: 'p-cloud-cool', label: t('Room −{n} ℃', { n: STEP }), icon: 'minus' },
];
// Phone keys: one row of four (two intervals, the refused command, warmer); the dashboard buttons cover the rest
export const cloudActs = (): Tool[] => [allActs()[0], allActs()[2], allActs()[3], allActs()[4]];

/** Toolbar / button action; ids p-cloud-<seconds> | p-cloud-warm | p-cloud-cool */
export function cloudTool(id: string, s: Session) {
  const k = id.slice(8);
  if (k === 'warm' || k === 'cool') {
    if (s.sim) s.setEnv({ temp: s.sim.env.temp + (k === 'warm' ? STEP : -STEP) });
  } else if (/^\d+$/.test(k)) cloudSend(s, `interval=${k}`);
}

/** Desktop buttons, same verbs as the phone keys */
export function cloudButtons(b: (id: string, label: string, f: () => void) => ReactNode, s: Session) {
  return allActs().map((a) => b(`pCloud-${a.id.slice(8)}`, a.label, () => cloudTool(a.id, s)));
}

export const cloudRows = (row: (k: string, live: string) => ReactNode) => [row(t('Network'), 'cnet'), row(t('Last report'), 'crep'), row(t('Report interval'), 'civ'), row(t('Last ack'), 'cack')];

export function cloudLive(set: (k: string, v: string, bad?: boolean) => void, waiting: string) {
  const s = cloudNow;
  const last = s.reports[s.reports.length - 1];
  set('cnet', !s.ip && !s.sub ? waiting : s.sub ? t('Wi-Fi {ip} · MQTT subscribed', { ip: s.ip || '…' }) : t('Wi-Fi {ip} · no broker yet', { ip: s.ip }));
  set('crep', last ? `#${last.seq} · ${last.t.toFixed(1)} ℃ · ${last.h.toFixed(1)} %` : s.sensorErr ? t('AHT20 did not answer: check SDA / SCL and 3V3') : waiting, s.sensorErr);
  set('civ', last?.gap !== undefined ? t('{n} s (last gap {g} s)', { n: s.interval, g: last.gap.toFixed(2) }) : t('{n} s', { n: s.interval }));
  set('cack', s.ack || t('No command yet'), /"ok":false/.test(s.ack));
}

/** Serial line -> reporter state + timeline event */
export function cloudSerial(l: string, event: (icon: string, text: string, tone?: 'ok' | 'bad') => void) {
  const e = parseCloudLine(l, cloudNow);
  if (e) event(...e);
}
