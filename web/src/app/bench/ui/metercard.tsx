import { Live } from "../../../ui/native";
import { Icon } from "../../icons";
import { t } from "../../../i18n";
import { tn } from "./common";

// ------------------------------------------------------------ multimeter card
/** Readings are filled by the bench's updateLive via data-live (data-live-root lets it find this card). */
export function MeterCard({
  target,
  onClose,
}: {
  target: string | null;
  onClose: () => void;
}) {
  return (
    <div
      id="meterCard"
      data-live-root=""
      role="region"
      aria-label={t("Multimeter")}
      className="absolute right-3 bottom-[calc(var(--tb-h,52px)+12px)] z-3 w-[220px] rounded-(--r) border border-line bg-surface p-3 text-fg shadow-panel max-md:right-2 max-md:bottom-2 max-md:w-[200px]"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted">{t("Multimeter · DC voltage")}</span>
        <button
          type="button"
          aria-label={t("Close multimeter")}
          onClick={onClose}
          className="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-field max-md:-my-2 max-md:-mr-2 max-md:size-11"
        >
          <Icon n="x" size={13} />
        </button>
      </div>
      <Live
        k="mv"
        init="—"
        className="mt-1 block font-mono text-2xl font-semibold tabular-nums"
      />
      <span className="block text-xs text-muted">
        {target ? (
          <>
            {tn("{target} to GND", { target: <span className="font-mono">{target}</span> })}
          </>
        ) : (
          t("Click a pin or a wire on the bench")
        )}
      </span>
      <Live as="p" k="mnote" className="mt-1.5 mb-0 text-[11px] text-muted" />
    </div>
  );
}
