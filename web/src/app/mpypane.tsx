// main.py dock pane (F-07b): plain textarea editor (no highlighter dependency), Run / Ctrl-C / Ctrl-D, and the serial since Run.
import { useEffect, useRef } from 'react';
import { t } from '../i18n';
import { cn } from '../ui/cn';
import { actions } from './chrome';
import { Icon } from './icons';
import { useStore } from './react';
import { MPY_MAX, mpy, runMain, setText } from './mpyapp';
import type { MpyStatus } from '../mpy';

function statusText(s: MpyStatus, ready: boolean): string {
  switch (s.phase) {
    case 'wait':
      return t('Stopping the running program (Ctrl-C), waiting for >>>');
    case 'raw':
    case 'paste':
      return t('Writing main.py: {sent} / {total} bytes ({mode})', { sent: s.sent, total: s.total, mode: s.mode === 'raw' ? 'raw REPL' : 'raw-paste' });
    case 'exec':
      return t('Saving main.py on the board…');
    case 'reset':
      return t('Soft reset (Ctrl-D): main.py starts');
    case 'done':
      return t('main.py written ({total} bytes) and running after a soft reset', { total: s.total });
    case 'error':
      return s.error === 'board'
        ? t('The board refused the upload: {detail}', { detail: s.detail ?? '' })
        : t('No reply from the board for 20 s (paused, or not at the REPL). Press Ctrl-C and try again');
    default:
      return ready ? t('REPL ready: Run writes main.py over the serial port, then soft-resets') : t('Waiting for the MicroPython REPL (>>>)…');
  }
}

export function MpyPane({ phone }: { phone?: boolean }) {
  const v = useStore(mpy);
  const out = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = out.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [v.out]);
  const btn = cn(
    'inline-flex flex-none cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 font-mono text-[12px] text-fg hover:bg-field disabled:cursor-default disabled:text-muted',
    phone ? 'min-h-11 min-w-11' : 'h-7',
  );
  const ctrl = (b: string) => actions.uart?.(b);
  return (
    <div id="mpyPane" className={cn('flex min-h-0 flex-1 flex-col', phone && 'border-t border-line-soft')}>
      <div className={cn('flex flex-none flex-wrap items-center gap-2 border-b border-line-soft px-3 py-1.5', phone && 'px-2.5')}>
        <button
          type="button"
          id="mpyRun"
          disabled={!v.ready || v.busy}
          onClick={runMain}
          title={t('Ctrl-C, write main.py with raw-paste, then soft reset (Ctrl-D)')}
          className={cn(btn, 'border-0 bg-accent-strong font-sans font-medium text-on-accent hover:bg-accent-strong disabled:bg-field')}
        >
          <Icon n="play" size={14} />
          {t('Run main.py')}
        </button>
        <button type="button" id="mpyCtrlC" disabled={!actions.uart} onClick={() => ctrl('\x03')} title={t('Interrupt the running program (KeyboardInterrupt)')} className={btn}>
          Ctrl-C
        </button>
        <button type="button" id="mpyCtrlD" disabled={!actions.uart} onClick={() => ctrl('\x04')} title={t('Soft reset: main.py runs again')} className={btn}>
          Ctrl-D
        </button>
        <span id="mpyStatus" role="status" className={cn('min-w-0 flex-1 text-[12px] text-muted', v.status.phase === 'error' && 'text-warn-ink', v.status.phase === 'done' && 'text-ok-ink')}>
          {statusText(v.status, v.ready)}
        </span>
      </div>
      <div className={cn('flex min-h-0 flex-1', phone ? 'flex-col' : 'flex-row')}>
        <textarea
          id="mpyEditor"
          aria-label={t('main.py editor')}
          value={v.text}
          maxLength={MPY_MAX}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Tab indents (Python needs it); Shift-Tab and Esc then Tab still leave the field
            if (e.key !== 'Tab' || e.shiftKey) return;
            e.preventDefault();
            const el = e.currentTarget;
            const a = el.selectionStart;
            setText(el.value.slice(0, a) + '    ' + el.value.slice(el.selectionEnd));
            requestAnimationFrame(() => el.setSelectionRange(a + 4, a + 4));
          }}
          onKeyUp={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && v.ready && !v.busy) runMain();
          }}
          className={cn(
            'min-h-0 min-w-0 flex-1 resize-none border-0 bg-(--scope-bg) px-3 py-2 font-mono text-[12.5px] leading-[1.6] text-fg outline-none',
            phone && 'min-h-[40%] text-[14px]',
          )}
        />
        <div className={cn('flex min-h-0 min-w-0 flex-col border-line-soft', phone ? 'h-[35%] border-t' : 'w-[38%] border-l')}>
          <div className="flex-none px-3 pt-1.5 text-[11px] font-medium text-muted">{t('Output since Run')}</div>
          <pre id="mpyOut" ref={out} className="m-0 min-h-0 flex-1 overflow-auto px-3 py-1 font-mono text-[12px] leading-[1.6] break-all whitespace-pre-wrap text-fg">
            {v.out}
          </pre>
        </div>
      </div>
      <p className="m-0 flex-none border-t border-line-soft px-3 py-1 text-[11px] text-muted">
        {t('Saved in this browser and re-sent after every power-up (no file system image). Ctrl+Enter runs.')}
      </p>
    </div>
  );
}
