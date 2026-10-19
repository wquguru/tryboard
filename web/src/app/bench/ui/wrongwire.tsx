import { Icon } from "../../icons";
import { t } from "../../../i18n";
import { btn, btnPri } from "./common";
import { ConfBadge, EST } from "./conf";

// ------------------------------------------------------------ wrong-wire confirmation
export function WrongWireCard({
  title,
  detail,
  wire,
  sim,
  estimate,
  onUndo,
  onRetry,
  onKeep,
}: {
  title: string;
  detail: string;
  wire: string;
  sim: string;
  /** Current and consequence from the net solver (P2-14, estimate; hidden until computed). */
  estimate?: { mA: number; text: string; what: string };
  onUndo: () => void;
  onRetry: () => void;
  onKeep: () => void;
}) {
  return (
    <div
      id="wrongWire"
      role="alertdialog"
      aria-label={t("Wrong wire")}
      className="absolute top-14 left-1/2 z-5 w-[380px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-(--r) border border-(--bad-line) max-md:top-2 max-md:z-6 bg-surface p-3.5 text-fg shadow-panel"
    >
      <div className="flex items-start gap-2">
        <Icon n="warn" size={18} className="mt-0.5 flex-none text-bad-ink" />
        <div className="min-w-0 flex-1">
          <b className="block text-sm">{t("This wiring will cause trouble: {title}", { title })}</b>
          <span className="block font-mono text-[11px] text-muted">{wire}</span>
        </div>
      </div>
      <p className="mt-2 mb-0 text-xs">{detail}</p>
      {estimate && (
        <div
          data-ww="estimate"
          className="mt-2 rounded-(--r) border border-(--bad-line) bg-bad-bg px-2.5 py-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <b className="font-mono text-sm text-bad-ink">≈ {estimate.mA} mA</b>
            <ConfBadge c={EST} />
          </div>
          <p className="mt-1 mb-0">{estimate.text}</p>
          <p className="mt-0.5 mb-0 text-[11px] text-muted">
            {t("Worst case: {what}", { what: estimate.what })}
          </p>
        </div>
      )}
      <p className="mt-1.5 mb-0 text-[11px] text-muted">{sim}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          data-ww="undo"
          className={btnPri}
          onClick={onUndo}
        >
          {t("Undo this rewire")}
        </button>
        <button type="button" data-ww="retry" className={btn} onClick={onRetry}>
          {t("Rewire to another pin")}
        </button>
        <button type="button" data-ww="keep" className={btn} onClick={onKeep}>
          {t("I know, keep it")}
        </button>
      </div>
    </div>
  );
}
