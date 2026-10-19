// Network conditions (D-01, designs docs/design-v2/depth/Main.dc.html, Phone.dc.html): preset segmented control, one-shot faults,
// outcome summary and the top-bar chip. Every action goes through the worker's input log, so CLI --inputs replays it.
import { useState, useSyncExternalStore } from 'react';
import { cn } from '../ui/cn';
import { t } from '../i18n';
import { actions } from './chrome';
import { netFeed, netPreset, type NetPresetName, type NetRow, type NetView } from './netfeed';

const PRESETS: NetPresetName[] = ['normal', 'weak', 'flaky', 'offline'];

export function presetName(p: string): string {
  switch (p) {
    case 'weak':
      return t('Weak signal');
    case 'flaky':
      return t('Flaky');
    case 'offline':
      return t('Offline');
    default:
      return t('Stable');
  }
}

function presetHint(p: NetPresetName): string {
  switch (p) {
    case 'weak':
      return t('Signal −82 dBm, 10% of packets lost; good for testing timeouts and retries.');
    case 'flaky':
      return t('Latency 300 ± 200 ms, 5% packet loss, a random drop every 40–90 s.');
    case 'offline':
      return t('The router vanishes: the chip finds no network. Does the firmware hang while connecting?');
    default:
      return t('Signal −42 dBm, no packet loss, replies at once.');
  }
}

const FAULTS = [
  ['reboot', () => t('Router reboot (down 8 s)')],
  ['dns', () => t('DNS failure')],
  ['silent', () => t('Server not responding')],
] as const;

export const useNetPreset = () => useSyncExternalStore(netPreset.subscribe, netPreset.get);

/** Rows that are requests (not the injected Wi-Fi / fault / preset markers) */
const isRequest = (r: NetRow) => r[1] !== 'FAULT' && r[1] !== 'NET' && r[1] !== 'Wi-Fi';
const failed = (r: NetRow) => r[4] === 'Failed' || r[4] === 'No reply' || r[4] === 'Timed out' || Number(r[4]) >= 400;

/** One-line outcome: disconnects, how long until reconnected, whether requests after it succeeded */
function summary(v: NetView): { text: string; ok: boolean } | null {
  const c = v.cond;
  if (!c) return null;
  const reqs = v.rows.filter(isRequest);
  const back = v.rows.map((r) => r[1] === 'Wi-Fi' && r[4] === 'Reconnected').lastIndexOf(true);
  const after = back < 0 ? [] : v.rows.slice(back + 1).filter(isRequest);
  if (c.disconnects > 0) {
    const parts = [t('Disconnects: {n}', { n: c.disconnects })];
    if (c.lost) return { text: [...parts, t('not reconnected yet')].join(' · '), ok: false };
    if (c.reconnect_ms !== null) parts.push(t('reconnected after {s} s', { s: (c.reconnect_ms / 1000).toFixed(1) }));
    if (after.length && !after.some(failed)) return { text: [...parts, t('requests after it all succeeded')].join(' · '), ok: true };
    if (after.some(failed)) return { text: [...parts, t('some requests after it still failed')].join(' · '), ok: false };
    return { text: [...parts, t('waiting for the next request')].join(' · '), ok: true };
  }
  const last = reqs[reqs.length - 1];
  if (c.faults > 0 && last) return { text: failed(last) ? t('Fault injected · latest request failed') : t('No drop · latest request succeeded'), ok: !failed(last) };
  return { text: c.preset === 'offline' ? t('No network: the chip cannot connect') : t('No drop so far'), ok: c.preset !== 'offline' };
}

/** Summary chip + request counts above the request table */
export function NetCondSummary({ v, mobile }: { v: NetView; mobile?: boolean }) {
  const s = summary(v);
  if (!s || !v.cond) return null;
  const c = v.cond;
  return (
    <div id="netSummary" className={cn('flex flex-none flex-wrap items-center gap-2.5 border-b border-line-soft px-3.5 py-2', mobile && 'px-3')}>
      <span data-ok={s.ok} className={cn('inline-flex min-h-[26px] items-center gap-1.5 rounded-[13px] px-2.5 py-0.5 text-xs leading-[18px] font-medium', s.ok ? 'bg-ok-bg text-ok-ink' : 'bg-warn-bg text-warn-ink')}>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="flex-none">
          {s.ok ? <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M8 3v6M8 12v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
        </svg>
        {s.text}
      </span>
      <span className="flex-1" />
      <span className="text-xs text-muted">{t('Requests {n} · failed {f}', { n: c.ok + c.failed, f: c.failed })}</span>
    </div>
  );
}

/** Left column of the Network tab (desktop) / stacked block (phone): preset, faults, seed note */
export function NetCondPanel({ mobile }: { mobile?: boolean }) {
  const preset = useNetPreset();
  const v = useSyncExternalStore(netFeed.subscribe, netFeed.get);
  const [faultsOpen, setFaultsOpen] = useState(false);
  const canFault = !!actions.netFault && preset !== 'offline';
  const faultBtns = (
    <div className={cn('flex flex-wrap gap-2', mobile && 'grid grid-cols-1')}>
      {FAULTS.map(([k, label]) => (
        <button
          key={k}
          type="button"
          data-fault={k}
          disabled={!canFault}
          onClick={() => actions.netFault?.(k)}
          className={cn('cursor-pointer rounded-md border border-line bg-surface px-3 text-[13px] text-fg hover:bg-field disabled:cursor-not-allowed disabled:text-muted', mobile ? 'min-h-11 rounded-lg text-left text-sm' : 'h-8')}
        >
          {label()}
        </button>
      ))}
    </div>
  );
  return (
    <div id="netCond" className={cn('flex flex-col gap-3 text-[13px]', mobile ? 'border-b border-line-soft px-4 py-3.5' : 'w-[380px] flex-none overflow-auto border-r border-line-soft px-4 py-3.5 max-lg:w-[300px]')}>
      <div className="flex items-baseline gap-2">
        <div className="font-semibold">{t('Network conditions')}</div>
        {!mobile && <div className="text-xs text-muted">{t('Applies to every request')}</div>}
      </div>
      <div role="radiogroup" aria-label={t('Network conditions')} className={cn(mobile ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-4 rounded-lg border border-line bg-field p-[3px]')}>
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            data-preset={p}
            aria-checked={preset === p}
            onClick={() => netPreset.set(p)}
            className={cn(
              'cursor-pointer truncate px-1',
              mobile
                ? 'h-12 rounded-lg border border-line bg-surface text-sm aria-checked:border-2 aria-checked:border-accent aria-checked:bg-accent-bg aria-checked:font-semibold aria-checked:text-accent-ink'
                : 'h-8 rounded-md border-0 bg-transparent text-[13px] text-muted aria-checked:bg-surface aria-checked:font-semibold aria-checked:text-fg aria-checked:shadow-sm',
            )}
          >
            {presetName(p)}
          </button>
        ))}
      </div>
      <div id="netHint" className={cn('text-xs leading-[18px] text-muted', !mobile && 'min-h-9')}>
        {presetHint(preset)}
      </div>
      {mobile ? (
        <>
          <button type="button" id="faultToggle" aria-expanded={faultsOpen} onClick={() => setFaultsOpen(!faultsOpen)} className="flex min-h-11 cursor-pointer items-center justify-between rounded-lg border border-line bg-surface px-3.5 text-sm text-fg">
            <span>{t('Schedule a fault')}</span>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className={cn('transition-transform', faultsOpen && 'rotate-90')}>
              <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {faultsOpen && faultBtns}
        </>
      ) : (
        <>
          <div className="mt-0.5 font-semibold">{t('Schedule a fault')}</div>
          {faultBtns}
        </>
      )}
      <div className={cn('font-mono text-[11px] text-muted', !mobile && 'mt-auto')}>{t('Seed {n} · goes into the input log; replay with --inputs on the command line', { n: v.cond?.seed ?? 7 })}</div>
    </div>
  );
}

/** Top-bar chip, only while the preset is not normal */
export function NetCondChip({ phone }: { phone?: boolean }) {
  const preset = useNetPreset();
  if (preset === 'normal') return null;
  return (
    <span id="netChip" className={cn('inline-flex flex-none items-center gap-1.5 rounded-full bg-warn-bg font-medium whitespace-nowrap text-warn-ink', phone ? 'h-[26px] max-w-[96px] px-2 text-xs' : 'h-7 px-2.5 text-xs')}>
      {!phone && (
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2.5l6 11H2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M8 6.8v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
      <span className="truncate">{t('Network: {name}', { name: presetName(preset) })}</span>
    </span>
  );
}
