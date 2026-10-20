// Virtual PC (E-07b): the dock "Bluetooth" tab's Claude Desktop Buddy central (core: soc/src/ble/desk.rs).
// The page only shows Desk::json() + k:"pc" air-log lines and sends pc=<cmd> (logged; CLI --inputs replays it).
import { useState, type FormEvent } from 'react';
import type { BleLine } from '../ble';
import { simClock, type BleSnap } from './blefeed';
import { ConfIcon } from '../ui/conf';
import { cn } from '../ui/cn';
import { t } from '../i18n';

const btn = (primary = false) =>
  cn(
    'inline-flex h-8 flex-none cursor-pointer items-center rounded-lg px-2.5 text-xs max-md:h-11 disabled:cursor-not-allowed disabled:opacity-50',
    primary ? 'border-0 bg-accent-strong font-medium text-on-accent' : 'border border-line bg-surface text-fg',
  );
const field = 'h-8 w-full min-w-0 rounded-lg border border-line bg-surface px-2 font-mono text-xs text-fg max-md:h-11 max-md:text-base';

/** UTF-8 safe base64 for pc=json / pc=hb (the core decodes standard base64) */
export function b64(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface Beat {
  total: number;
  running: number;
  waiting: number;
  tokens: number;
  tokens_today: number;
  msg: string;
}
const NUMS = ['total', 'running', 'waiting', 'tokens', 'tokens_today'] as const;

/** Heartbeat template in the Buddy shape (same keys as Desk::heartbeat_text); {time} is filled by the core in sim time */
export function beatJson(b: Beat): string {
  const n = (v: number) => Math.max(0, Math.round(Number.isFinite(v) ? v : 0));
  return JSON.stringify({
    total: n(b.total),
    running: n(b.running),
    waiting: n(b.waiting),
    msg: b.msg,
    entries: [`{time} ${b.msg}`],
    tokens: n(b.tokens),
    tokens_today: n(b.tokens_today),
  });
}

/** Status sentence: off / scanning / connecting / connected (name, MTU) */
function status(s: BleSnap): string {
  const p = s.view?.phone;
  const pc = p?.pc;
  if (!p || !pc?.on) return p?.state === 'connected' ? t('Off · the virtual phone holds the link; disconnect it first') : t('Off · when on, it looks for a board named Claude…');
  if (p.state === 'scanning') return t('Scanning for a device named Claude…');
  if (p.state === 'connecting') return t('Connecting…');
  if (p.state !== 'connected') return t('Idle');
  const name = p.devices.find((d) => d.addr === p.target)?.name || s.view?.adv_name || p.target || '';
  return pc.active ? t('Connected · {name} · MTU {mtu}', { name, mtu: p.mtu }) : t('Connected · {name} · subscribing…', { name });
}

const lastOf = (log: BleLine[], re: RegExp) => {
  for (let i = log.length - 1; i >= 0; i--) if (log[i].k === 'pc' && re.test(log[i].s)) return log[i];
  return undefined;
};

/** Dock panel: on / off, link state, last lines both ways, heartbeat editor, one-off JSON line */
export function PcPanel({ s, send }: { s: BleSnap; send: (cmd: string) => void }) {
  const pc = s.view?.phone?.pc;
  const on = !!pc?.on;
  const [beat, setBeat] = useState<Beat>({
    total: 3,
    running: 1,
    waiting: 0,
    tokens: 184502,
    tokens_today: 31200,
    msg: 'working: npm test',
  });
  const [raw, setRaw] = useState('{"cmd":"status"}');
  const ack = lastOf(s.log, /^pc: ack /);
  const recent = s.log.filter((l) => l.k === 'pc').slice(-6);
  const label: Record<(typeof NUMS)[number], string> = {
    total: t('Sessions (total)'),
    running: t('Sessions running'),
    waiting: t('Waiting for approval'),
    tokens: t('Tokens (total)'),
    tokens_today: t('Tokens today'),
  };
  const sendBeat = (e: FormEvent) => {
    e.preventDefault();
    send(`pc=hb,${b64(beatJson(beat))}`);
  };
  const sendRaw = (e: FormEvent) => {
    e.preventDefault();
    const line = raw.trim();
    if (line) send(`pc=json,${b64(line)}`);
  };
  return (
    <div id="pcPanel" data-on={on} data-active={!!pc?.active} className="flex flex-col gap-3 px-3 py-2 text-[13px] text-fg">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-[15px]">{t('Virtual PC')}</strong>
        <span className="inline-flex items-center gap-1 text-xs" title={t('Speaks the Claude Desktop Buddy protocol over BLE; heartbeats are scripted, not your real sessions')}>
          <ConfIcon c="行为模拟" /> {/* lint: allow-cjk */}
          {t('Behaviour model')}
        </span>
        <span className="flex-1" />
        <button type="button" id="pcToggle" aria-pressed={on} className={btn(!on)} onClick={() => send(on ? 'pc=off' : 'pc=on')}>
          {on ? t('Turn off') : t('Turn on')}
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <span id="pcStatus" className={cn('font-medium', pc?.active ? 'text-ok-ink' : 'text-muted')}>
          {status(s)}
        </span>
        {pc && (pc.sent > 0 || pc.acks > 0) && (
          <span className="text-xs text-muted">
            {t('Sent {sent} lines ({hb} heartbeats) · {acks} acks', {
              sent: pc.sent,
              hb: pc.heartbeats,
              acks: pc.acks,
            })}
          </span>
        )}
        {ack && (
          <span id="pcAck" className="text-xs text-muted">
            {t('Last ack {when}: {text}', {
              when: simClock(ack.t),
              text: ack.s.replace(/^pc: ack /, ''),
            })}
          </span>
        )}
      </div>
      {s.cmdError && (
        <p id="pcErr" className="m-0 text-xs text-bad-ink">
          {t('The virtual PC refused: {reason}', { reason: s.cmdError })}
        </p>
      )}
      <form id="pcHb" onSubmit={sendBeat} className="flex flex-col gap-2 rounded-[10px] border border-line px-3 py-2.5">
        <span className="font-medium">{t('Heartbeat')}</span>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
          {NUMS.map((k) => (
            <label key={k} className="flex min-w-0 flex-col gap-0.5 text-xs text-muted">
              {label[k]}
              <input type="number" min={0} data-hb={k} value={beat[k]} onChange={(e) => setBeat({ ...beat, [k]: Number(e.target.value) })} className={field} />
            </label>
          ))}
          <label className="col-span-2 flex min-w-0 flex-col gap-0.5 text-xs text-muted">
            {t('Status message')}
            <input data-hb="msg" value={beat.msg} maxLength={60} autoComplete="off" spellCheck={false} onChange={(e) => setBeat({ ...beat, msg: e.target.value })} className={field} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" id="pcHbSend" disabled={!on} className={btn(true)}>
            {t('Send heartbeat')}
          </button>
          <span className="min-w-0 flex-1 text-xs text-muted">{on ? t('Repeated every 10 s while connected') : t('Turn the virtual PC on first')}</span>
        </div>
      </form>
      <form onSubmit={sendRaw} className="flex items-center gap-2">
        <label htmlFor="pcRaw" className="flex-none text-xs font-medium">
          {t('JSON line')}
        </label>
        <input id="pcRaw" value={raw} onChange={(e) => setRaw(e.target.value)} autoComplete="off" spellCheck={false} className={field} aria-label={t('One JSON line to send once')} />
        <button type="submit" id="pcRawSend" disabled={!on} className={btn()}>
          {t('Send once')}
        </button>
      </form>
      {pc && (pc.last_hb || pc.last_rx) && (
        <div className="flex flex-col gap-1.5 text-xs">
          {pc.last_hb && (
            <div className="min-w-0">
              <div className="text-muted">{t('Last heartbeat sent')}</div>
              <div id="pcLastHb" className="font-mono break-all">
                {pc.last_hb}
              </div>
            </div>
          )}
          {pc.last_rx && (
            <div className="min-w-0">
              <div className="text-muted">{t('Last line from the board')}</div>
              <div id="pcLastRx" className="font-mono break-all">
                {pc.last_rx}
              </div>
            </div>
          )}
        </div>
      )}
      {recent.length > 0 && (
        <div className="flex flex-col font-mono text-[11px] leading-[18px] text-muted">
          {recent.map((l) => (
            <div key={l.n} className="min-w-0 break-all">{`${simClock(l.t)}  ${l.s}`}</div>
          ))}
        </div>
      )}
    </div>
  );
}
