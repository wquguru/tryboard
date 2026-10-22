// Network tab, MQTT view (F-08g): publish "from the cloud" to the virtual broker and watch its log.
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { cn } from '../ui/cn';
import { t } from '../i18n';
import { actions } from './chrome';
import { netFeed, type MqttLine } from './netfeed';
import { clock } from './netpane';

type Mode = 'pub' | 'pub1' | 'retain';
const MODES: [Mode, () => string][] = [
  ['pub', () => t('QoS 0')],
  ['pub1', () => t('QoS 1')],
  ['retain', () => t('Retain')],
];

/** Topic the firmware subscribed to last: a plain filter as is, prefix/# -> prefix/in, otherwise tryboard/in */
export function defaultTopic(log: MqttLine[]): string {
  for (let i = log.length - 1; i >= 0; i--) {
    const m = /^SUBSCRIBE .+ (\S+) QoS \d$/.exec(log[i][1]);
    if (!m) continue;
    const f = m[1];
    if (!/[+#,]/.test(f)) return f;
    if (/^[^+#,]+\/#$/.test(f)) return `${f.slice(0, -1)}in`;
    break;
  }
  return 'tryboard/in';
}

/** Same rules as the core's mqtt=: no wildcards; a comma would split the script action */
const badTopic = (s: string) => !s || /[+#,]/.test(s);

export function MqttView({ mobile }: { mobile?: boolean }) {
  const v = useSyncExternalStore(netFeed.subscribe, netFeed.get);
  const [topic, setTopic] = useState<string | null>(null);
  const [msg, setMsg] = useState('hello from cloud');
  const [mode, setMode] = useState<Mode>('pub');
  const [sent, setSent] = useState(0);
  const cur = topic ?? defaultTopic(v.mqtt);
  const bad = badTopic(cur.trim());
  const can = !!actions.mqttPub && !bad;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!can) return;
    // The input log is one action per line: newlines in the message become spaces
    actions.mqttPub?.(`${mode},${cur.trim()},${msg.replace(/[\r\n]+/g, ' ')}`);
    setSent(sent + 1);
  };
  const field = cn('w-full min-w-0 rounded-md border border-line bg-surface px-2.5 text-fg', mobile ? 'h-11 rounded-lg text-sm' : 'h-8 text-[13px]');
  const form = (
    <form id="mqttPub" onSubmit={submit} className={cn('flex flex-col gap-2.5 text-[13px]', mobile ? 'border-b border-line-soft px-4 py-3.5' : 'w-[380px] flex-none overflow-auto border-r border-line-soft px-4 py-3.5 max-lg:w-[300px]')}>
      <div className="flex items-baseline gap-2">
        <div className="font-semibold">{t('Publish from the cloud')}</div>
        {!mobile && <div className="text-xs text-muted">{t('Virtual broker · port 1883')}</div>}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t('Topic')}</span>
        <input id="mqttTopic" value={cur} onChange={(e) => setTopic(e.target.value)} spellCheck={false} aria-invalid={bad} className={cn(field, 'font-mono aria-invalid:border-bad-ink')} />
      </label>
      {bad && <div className="text-xs text-bad-ink">{t('A topic cannot be empty or contain + # or a comma')}</div>}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t('Message')}</span>
        <input id="mqttMsg" value={msg} onChange={(e) => setMsg(e.target.value)} spellCheck={false} className={cn(field, 'font-mono')} />
      </label>
      <div role="radiogroup" aria-label={t('Delivery')} className={cn('grid grid-cols-3', mobile ? 'gap-2' : 'rounded-lg border border-line bg-field p-[3px]')}>
        {MODES.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="radio"
            data-mode={k}
            aria-checked={mode === k}
            onClick={() => setMode(k)}
            className={cn(
              'cursor-pointer truncate px-1',
              mobile
                ? 'h-11 rounded-lg border border-line bg-surface text-sm aria-checked:border-2 aria-checked:border-accent aria-checked:bg-accent-bg aria-checked:font-semibold aria-checked:text-accent-ink'
                : 'h-8 rounded-md border-0 bg-transparent text-[13px] text-muted aria-checked:bg-surface aria-checked:font-semibold aria-checked:text-fg aria-checked:shadow-sm',
            )}
          >
            {label()}
          </button>
        ))}
      </div>
      <div className="text-xs leading-[18px] text-muted">{mode === 'retain' ? t('Kept by the broker and sent to every later subscriber; an empty message clears it.') : mode === 'pub1' ? t('The board acknowledges with PUBACK.') : t('Sent once, no acknowledgement.')}</div>
      <button type="submit" id="mqttSend" disabled={!can} className={cn('cursor-pointer rounded-md border-0 bg-accent px-4 font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-50', mobile ? 'min-h-11 rounded-lg' : 'h-8 self-start')}>
        {t('Send')}
      </button>
      <div className={cn('font-mono text-[11px] text-muted', !mobile && 'mt-auto')}>{sent > 0 ? t('Sent {n} · in the input log; replay with --inputs on the command line', { n: sent }) : t('Goes into the input log; replay with --inputs on the command line')}</div>
    </form>
  );
  const log = (
    <div id="mqttLog" className={cn('min-w-0 flex-1 overflow-auto', mobile ? 'px-4 py-3' : 'px-3 py-2')}>
      <div className="mb-1.5 text-xs text-muted">{t('Broker log (latest {n})', { n: 50 })}</div>
      {v.mqtt.length === 0 ? (
        <div className="text-xs text-muted">{t('No MQTT traffic yet: the firmware has not connected to port 1883.')}</div>
      ) : (
        <ol className="m-0 list-none p-0 font-mono text-xs">
          {[...v.mqtt].reverse().map(([ms, line], i) => (
            <li key={v.mqtt.length - i} className="flex gap-2 border-b border-line-soft py-1 last:border-0">
              {!mobile && <span className="flex-none text-muted">{clock(ms)}</span>}
              <span className="min-w-0 break-all">{line}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
  return mobile ? (
    <div className="min-h-0 flex-1 overflow-auto">
      {form}
      {log}
    </div>
  ) : (
    <div className="flex min-h-0 flex-1">
      {form}
      {log}
    </div>
  );
}
