// Core crash card (R-04): a Rust panic / wasm trap is a simulator bug, not firmware behaviour; say so and offer a re-run.
import { t } from '../i18n';
import { Icon } from './icons';

export function CrashCard({ message, onRerun, onClose }: { message: string; onRerun: () => void; onClose: () => void }) {
  return (
    <div role="alertdialog" aria-label={t('Simulator internal error')} id="simCrash" className="absolute top-14 left-1/2 z-5 w-[380px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-(--r) border border-(--bad-line) bg-surface p-3.5 text-fg shadow-panel">
      <div className="flex items-start gap-2">
        <Icon n="warn" size={18} className="mt-0.5 flex-none text-bad-ink" />
        <div className="min-w-0 flex-1">
          <b className="block text-sm">{t('Simulator internal error')}</b>
          <span className="block text-xs text-muted">{t('This is a TryBoard bug, not a problem with your firmware. The run stopped here.')}</span>
        </div>
        <button type="button" aria-label={t('Close')} onClick={onClose} className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-field">
          <Icon n="x" size={14} />
        </button>
      </div>
      <pre className="mt-2 mb-0 max-h-24 overflow-auto rounded-md bg-field p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-muted">{message}</pre>
      <button type="button" id="simCrashRerun" onClick={onRerun} className="mt-2.5 inline-flex min-h-9 w-full cursor-pointer items-center justify-center rounded-md border border-accent-strong bg-accent-strong px-3 text-sm font-medium text-on-accent">
        {t('Run again')}
      </button>
    </div>
  );
}
