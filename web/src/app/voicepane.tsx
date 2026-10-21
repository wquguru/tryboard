// Dock "Voice" tab (F-09b-2): the virtual xiaozhi-protocol-compatible server. Everything goes out as xz= / gpio0= inputs,
// so the input log replays the same conversation with CLI --inputs; the server is a behavioural model, not xiaozhi.me.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cn } from '../ui/cn';
import { Conf } from '../ui/conf';
import { t } from '../i18n';
import { actions } from './chrome';
import { simClock } from './blefeed';
import { bubbles, sayText, useXz, XZ_SCRIPTS, type XzSnap } from './xzfeed';

/** The board is mid-answer (tts start seen, no stop / abort / close after it): the talk key then interrupts */
function speaking(log: XzSnap['log']): boolean {
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i][1];
    if (l === 'tts start') return true;
    if (l === 'tts stop' || l === 'abort' || l.startsWith('closed')) return false;
  }
  return false;
}

function scriptLabel(n: string): string {
  switch (n) {
    case 'hello':
      return t('Greeting');
    case 'weather':
      return t('Weather');
    case 'silent':
      return t('Silent (no hello reply)');
    default:
      return n;
  }
}

export function VoicePane() {
  const s = useXz();
  const [say, setSay] = useState('');
  const [held, setHeld] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const b = box.current;
    if (b && stick.current) b.scrollTop = b.scrollHeight;
  }, [s.log]);
  const talking = speaking(s.log);
  const chat = bubbles(s.log);
  const talk = (down: boolean) => {
    if (down === held) return;
    setHeld(down);
    actions.talk?.(down);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = sayText(say);
    if (!v) return;
    actions.xz?.(`say,${v}`);
    setSay('');
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <section aria-label={t('Voice server')} className="flex min-w-0 flex-none flex-col gap-2 overflow-auto px-3 py-2 md:w-[340px] md:border-r md:border-line-soft">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <Conf c="行为模拟" size={13} />{/* lint: allow-cjk */}
          <span id="xzStatus">
            {t('Sessions {s} · turns {n} · frames up {u} / down {d}', { s: s.sessions, n: s.turns, u: s.up, d: s.down })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="xzScript" className="flex-none text-xs text-muted">
            {t('Server script')}
          </label>
          <select
            id="xzScript"
            value={s.script}
            onChange={(e) => actions.xz?.(`script,${e.target.value}`)}
            className="h-11 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm md:h-8"
          >
            {XZ_SCRIPTS.map((n) => (
              <option key={n} value={n}>
                {scriptLabel(n)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          id="xzTalk"
          aria-pressed={held}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            talk(true);
          }}
          onPointerUp={() => talk(false)}
          onPointerCancel={() => talk(false)}
          onKeyDown={(e) => {
            if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
              e.preventDefault();
              talk(true);
            }
          }}
          onKeyUp={(e) => {
            if (e.key === ' ' || e.key === 'Enter') talk(false);
          }}
          className={cn(
            'h-12 w-full touch-none select-none rounded-md border text-sm font-medium',
            held ? 'border-accent bg-accent text-white' : 'border-line bg-surface hover:bg-accent-bg',
          )}
        >
          {held ? t('Listening… release to send') : talking ? t('Interrupt (tap BOOT)') : t('Hold to talk (BOOT)')}
        </button>
        <form onSubmit={submit} className="flex gap-2">
          <input
            id="xzSay"
            value={say}
            onChange={(e) => setSay(e.target.value)}
            maxLength={200}
            placeholder={t('Make the server say…')}
            aria-label={t('Make the server say…')}
            className="h-11 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm md:h-8"
          />
          <button type="submit" className="h-11 flex-none rounded-md border border-line bg-surface px-3 text-sm hover:bg-accent-bg md:h-8">
            {t('Say')}
          </button>
        </form>
        <p className="text-xs text-muted">{t('The mic hears a recorded clip; wake word, echo cancellation and real speech recognition need real hardware.')}</p>
        <div id="xzChat" aria-label={t('Conversation')} className="flex flex-col gap-1.5">
          {chat.length === 0 && <div className="text-xs text-muted">{t('No conversation yet')}</div>}
          {chat.map((b, i) => (
            <div
              key={i}
              data-who={b.who}
              className={cn(
                'max-w-[85%] break-words rounded-lg px-2.5 py-1.5 text-sm',
                b.who === 'user' ? 'self-end bg-accent-bg' : 'self-start border border-line-soft bg-surface',
              )}
            >
              {b.text}
            </div>
          ))}
        </div>
      </section>
      <div
        ref={box}
        id="xzLog"
        role="log"
        aria-label={t('Voice server log')}
        onScroll={(e) => {
          const b = e.currentTarget;
          stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
        }}
        className="min-h-[120px] min-w-0 flex-1 overflow-auto border-line-soft px-3 py-2 font-mono text-xs leading-[22px] max-md:border-t"
      >
        {s.log.length === 0 && <div className="text-muted">{t('Waiting for the board to connect')}</div>}
        {s.log.map(([us, l], i) => (
          <div key={i} className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 md:grid-cols-[90px_minmax(0,1fr)]">
            <span className="text-muted">{simClock(us)}</span>
            <span className="min-w-0 break-words">{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
