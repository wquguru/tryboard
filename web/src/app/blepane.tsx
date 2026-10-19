// BLE (C-01): dock air log + inspector "Virtual phone" (Main.dc.html). The core simulates both sides; this only shows them and
// sends ble=<cmd> (input log, replayable via --inputs). Throttled to <= 10 Hz: one slice can carry several events.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { lineDir, lineText, uuidLabel, type BleChar } from '../ble';
import { bleFeed, simClock, useBle } from './blefeed';
import { ConfIcon } from '../ui/conf';
import { cn } from '../ui/cn';
import { t } from '../i18n';

// ------------------------------------------------------------ Dock: air log

/** Dock "Bluetooth" tab: adverts, connections, ATT reads / writes / notifications, one per line in sim time */
export function BlePane() {
  const s = useBle();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const b = box.current;
    if (b && stick.current) b.scrollTop = b.scrollHeight;
  }, [s.log]);
  if (s.state === 2) return <ElfCard reason={s.error} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 px-3 pt-1.5 pb-1 text-xs text-muted">
        <span id="bleAir">{s.view?.connected ? t('Connected') : s.view?.advertising ? t('Advertising · {name}', { name: s.view.adv_name || s.view.addr }) : t('Not advertising')}</span>
        <span className="flex-1" />
        <span>{t('In simulated time; export to replay')}</span>
      </div>
      <div
        ref={box}
        id="bleLog"
        role="log"
        aria-label={t('Bluetooth air log')}
        onScroll={(e) => {
          const b = e.currentTarget;
          stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto px-3 pb-2 font-mono text-xs leading-[22px]"
      >
        {s.log.length === 0 && <div className="text-muted">{t('No air activity yet')}</div>}
        {s.log.map((l, i) => (
          <div
            key={l.n}
            data-k={l.k}
            className={cn(
              'grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 md:grid-cols-[90px_140px_minmax(0,1fr)]',
              i === s.log.length - 1 && 'bg-accent-bg',
            )}
          >
            <span className="text-muted">{simClock(l.t)}</span>
            <span className="max-md:text-muted">{lineDir(l)}</span>
            <span className="min-w-0 break-words max-md:col-span-2">{lineText(l)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Route a' found no VHCI boundary: explain and point to route c (drop app.elf) */
function ElfCard({ reason }: { reason: string }) {
  return (
    <div id="bleElf" className="m-3 flex flex-col gap-1.5 rounded-lg border border-line bg-warn-bg px-3 py-2.5 text-[13px] text-fg">
      <b className="font-medium">{t('BLE needs an app.elf as well')}</b>
      <span className="text-xs text-muted">
        {t('The firmware uses Bluetooth, but the Espressif BLE library interface was not found in the .bin ({reason}). Drop in build/<project>.elf from the same build to attach the virtual controller by symbol.', { reason: reason || t('signature mismatch') })}
      </span>
      <span className="text-xs text-muted">{t('This step is still in progress: for now only this card shows and Bluetooth stays inactive.')}</span>
    </div>
  );
}

// ------------------------------------------------------------ Inspector: virtual phone

const pill = (on: boolean) =>
  cn(
    'inline-flex h-8 items-center rounded-2xl px-3 text-[13px] max-md:h-11',
    on ? 'bg-fg text-surface' : 'border border-line bg-surface text-fg',
  );
const smallBtn = (primary = false) =>
  cn(
    'inline-flex h-8 flex-none cursor-pointer items-center rounded-lg px-2.5 text-xs max-md:h-11 disabled:cursor-not-allowed disabled:opacity-50',
    primary ? 'border-0 bg-accent-strong font-medium text-on-accent' : 'border border-line bg-surface text-fg',
  );

const BtIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="m7 7 10 10-5 5V2l5 5L7 17" />
  </svg>
);

const hhex = (h: number) => `0x${h.toString(16).padStart(4, '0')}`;

/** Notification value sparkline (last 30 points), y axis fitted to the data */
function Spark({ hist, label }: { hist: [number, number][]; label: string }) {
  const pts = hist.slice(-30);
  if (pts.length < 2) return null;
  const vs = pts.map((p) => p[1]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const span = hi - lo || 1;
  const t0 = pts[0][0];
  const tw = pts[pts.length - 1][0] - t0 || 1;
  const poly = pts.map(([t, v]) => `${(((t - t0) / tw) * 300).toFixed(1)},${(34 - ((v - lo) / span) * 28).toFixed(1)}`).join(' ');
  return (
    <svg data-spark width="100%" height="40" viewBox="0 0 300 40" preserveAspectRatio="none" role="img" aria-label={t('{label}: last {n} notifications, between {lo} and {hi}', { label, n: pts.length, lo, hi })}>
      <polyline points={poly} fill="none" stroke="var(--color-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Characteristic card: name + UUID, current value (decoded when known), read / subscribe / write */
function CharCard({ c, send }: { c: BleChar; send: (cmd: string) => void }) {
  const [hex, setHex] = useState('01');
  const canRead = c.props.includes('read');
  const canSub = (c.props.includes('notify') || c.props.includes('indicate')) && c.cccd !== null;
  const canWrite = c.props.includes('write') || c.props.includes('write-nr');
  const shown = c.text || c.value;
  const big = c.hist.length > 0 || /^\d/.test(c.text);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(`write ${hhex(c.handle)} ${hex}`);
  };
  return (
    <div data-char={c.uuid} className="flex flex-col gap-2 rounded-[10px] border border-line px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium">{c.name || t('Characteristic')}</span>
        <span className="flex-none font-mono text-[11px] text-muted">{uuidLabel(c.uuid)}</span>
        <span className="flex-1" />
        {c.notify && <span className="flex-none text-xs text-ok-ink">{t('Subscribed')}</span>}
        {canRead && !canSub && (
          <button type="button" data-act="read" className={smallBtn()} onClick={() => send(`read ${hhex(c.handle)}`)}>
            {t('Read')}
          </button>
        )}
      </div>
      {shown && (
        <div className="flex min-w-0 items-baseline gap-1.5" data-val>
          <span className={cn('font-mono break-all', big ? 'text-[28px] leading-9 font-bold' : 'text-[13px]')}>{c.text ? c.text.replace(/\s*bpm$/, '').replace(/%$/, ' %') : c.value}</span>
          {/\bbpm$/.test(c.text) && <span className="text-muted">{t('bpm')}</span>}
          {c.text && c.value && !/bpm$|%$/.test(c.text) && <span className="font-mono text-[11px] text-muted">{c.value}</span>}
        </div>
      )}
      <Spark hist={c.hist} label={c.name || c.uuid} />
      {canSub && (
        <div className="flex flex-wrap gap-1.5">
          {canSub && (
            <button type="button" data-act={c.notify ? 'unsub' : 'sub'} className={smallBtn(!c.notify)} onClick={() => send(`${c.notify ? 'unsub' : 'sub'} ${hhex(c.handle)}`)}>
              {c.notify ? t('Unsubscribe') : t('Subscribe')}
            </button>
          )}
          {canRead && (
            <button type="button" data-act="read" className={smallBtn()} onClick={() => send(`read ${hhex(c.handle)}`)}>
              {t('Read')}
            </button>
          )}
          {c.notes > 0 && <span className="self-center text-xs text-muted">{t('Received: {n}', { n: c.notes })}</span>}
        </div>
      )}
      {canWrite && (
        <form onSubmit={submit} className="flex items-center gap-2">
          <label htmlFor={`bleW${c.handle}`} className="flex-none font-medium">
            {t('Write')}
          </label>
          <input
            id={`bleW${c.handle}`}
            data-write={c.uuid}
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('Hex bytes to write to {name}', { name: c.name || c.uuid })}
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 font-mono text-xs text-fg max-md:h-11 max-md:text-base"
          />
          <button type="submit" data-act="write" className={smallBtn(true)}>
            {t('Send')}
          </button>
        </form>
      )}
    </div>
  );
}

/** Inspector "Virtual phone": Nearby / Connected tabs; services and characteristic cards inside a phone frame */
export function PhonePanel({ send }: { send: (cmd: string) => void }) {
  const s = useBle();
  const p = s.view?.phone;
  const connected = p?.state === 'connected';
  const [tab, setTab] = useState<'near' | 'conn' | null>(null);
  const cur = tab ?? (connected ? 'conn' : 'near');
  const go = (cmd: string) => {
    bleFeed.clearError();
    send(cmd);
  };
  // Follow connect / disconnect with the tab; a manual pick wins until the connection state changes again
  const lastConn = useRef(connected);
  useEffect(() => {
    if (lastConn.current !== connected) setTab(null);
    lastConn.current = connected;
  }, [connected]);
  const dev = p?.devices.find((d) => d.addr === p.target) ?? p?.devices[0];
  const head = (
    <div className="mt-2 flex items-center gap-2">
      <strong className="text-[15px]">{t('Virtual phone')}</strong>
      <span className="inline-flex items-center gap-1 text-xs text-fg" title={t('The protocol is simulated packet by packet per spec; radio, distance and phone OS are not simulated')}>
        <ConfIcon c="行为模拟" /> {/* lint: allow-cjk */}
        {t('Behaviour model')}
      </span>
    </div>
  );
  const foot = (
    <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
      <ConfIcon c="必须上真机" /> {/* lint: allow-cjk */}
      {t('Range, walls, phone OS differences: needs real hardware')}
    </div>
  );
  if (s.state !== 1 || !p)
    return (
      <div id="blePhone" data-state={s.state}>
        {head}
        {s.state === 2 ? <ElfCard reason={s.error} /> : <p className="my-2 text-xs text-muted">{t('The firmware on the bench does not use Bluetooth. Load a NimBLE firmware (e.g. c3-ble-hr) and try again.')}</p>}
        {foot}
      </div>
    );
  return (
    <div id="blePhone" data-state={s.state} data-phone={p.state} className="flex flex-col">
      {head}
      <div className="mt-3 flex flex-col overflow-hidden rounded-[36px] border-8 border-[#1e1e1e] bg-surface text-[13px] text-fg">
        <div className="flex gap-1.5 px-4 pt-5 pb-2" role="tablist" aria-label={t('Virtual phone')}>
          <button type="button" role="tab" id="blePillNear" aria-selected={cur === 'near'} className={pill(cur === 'near')} onClick={() => setTab('near')}>
            {t('Nearby')}
          </button>
          <button type="button" role="tab" id="blePillConn" aria-selected={cur === 'conn'} className={pill(cur === 'conn')} onClick={() => setTab('conn')}>
            {t('Connected')}
          </button>
        </div>
        {cur === 'near' ? (
          <div className="flex flex-col gap-2 px-4 pt-1 pb-4">
            <div className="flex flex-wrap items-center gap-1.5">
              {p.state === 'scanning' ? (
                <button type="button" id="bleScanOff" className={smallBtn()} onClick={() => go('scan off')}>
                  {t('Stop scan')}
                </button>
              ) : (
                <button type="button" id="bleScan" className={smallBtn(true)} disabled={connected} onClick={() => go('scan')}>
                  {t('Scan')}
                </button>
              )}
              <button type="button" id="bleAuto" className={smallBtn()} disabled={connected} title={t('Scan → connect the first device → read all readable characteristics → subscribe to all notifications')} onClick={() => go('auto')}>
                {t('Auto connect')}
              </button>
              <span className="text-xs text-muted">{p.state === 'scanning' ? t('Scanning…') : p.state === 'connecting' ? t('Connecting…') : ''}</span>
            </div>
            {p.devices.length === 0 && <p className="my-1 text-xs text-muted">{p.state === 'scanning' ? t('No adverts heard yet') : t('Tap Scan to listen for the board')}</p>}
            {p.devices.map((d) => (
              <div key={d.addr} data-dev={d.addr} className="flex items-center gap-2.5 border-b border-line-soft py-2 last:border-0">
                <div className="grid size-9 flex-none place-items-center rounded-[10px] bg-accent-bg text-accent-ink">
                  <BtIcon />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">{d.name || t('(no name)')}</div>
                  <div className="truncate font-mono text-[11px] text-muted">{`${d.addr} · ${d.rssi} dBm${d.uuids.length ? ' · ' + d.uuids.map((u) => '0x' + u).join(' ') : ''}`}</div>
                </div>
                {connected && p.target === d.addr ? (
                  <span className="text-xs text-ok-ink">{t('Connected')}</span>
                ) : (
                  <button type="button" data-act="connect" className={smallBtn()} disabled={!d.connectable || connected || p.state === 'connecting'} onClick={() => go(`connect ${d.addr}`)}>
                    {t('Connect')}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : !connected ? (
          <div className="px-4 pt-2 pb-5 text-xs text-muted">
            {p.state === 'connecting' ? t('Connecting…') : t('Not connected yet. Scan and connect under "Nearby".')}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 border-b border-line-soft px-4 pt-2 pb-3">
              <div className="grid size-9 flex-none place-items-center rounded-[10px] bg-accent-bg text-accent-ink">
                <BtIcon />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold" id="bleConnName">
                  {dev?.name || s.view?.adv_name || t('Device')}
                </div>
                <div className="truncate font-mono text-[11px] text-muted">{`${p.target ?? s.view?.addr} · ${p.rssi} dBm · MTU ${p.mtu}`}</div>
              </div>
              <button type="button" id="bleDisc" className={smallBtn()} onClick={() => go('disconnect')}>
                {t('Disconnect')}
              </button>
            </div>
            <div className="flex flex-col gap-3 px-4 pt-3 pb-4">
              {!p.ready && <p className="my-0 text-xs text-muted">{t('Discovering services…')}</p>}
              {p.services
                .filter((sv) => sv.chars.length && sv.uuid !== '1800' && sv.uuid !== '1801')
                .map((sv) => (
                  <div key={sv.start} data-svc={sv.uuid} className="flex flex-col gap-2">
                    <div className="text-xs text-muted">{`${sv.name ? t('{name} service', { name: sv.name }) : t('Custom service')} · ${uuidLabel(sv.uuid)}`}</div>
                    {sv.chars.map((c) => (
                      <CharCard key={c.handle} c={c} send={go} />
                    ))}
                  </div>
                ))}
              {p.ready && p.services.some((sv) => sv.uuid === '1800' || sv.uuid === '1801') && (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer">{t('Generic services (device name, appearance, service changed)')}</summary>
                  <div className="mt-2 flex flex-col gap-2">
                    {p.services
                      .filter((sv) => sv.uuid === '1800' || sv.uuid === '1801')
                      .flatMap((sv) => sv.chars)
                      .map((c) => (
                        <CharCard key={c.handle} c={c} send={go} />
                      ))}
                  </div>
                </details>
              )}
            </div>
          </>
        )}
      </div>
      {s.cmdError && (
        <p id="bleCmdErr" className="my-2 text-xs text-bad-ink">
          {t('The phone refused: {reason}', { reason: s.cmdError })}
        </p>
      )}
      {foot}
    </div>
  );
}
