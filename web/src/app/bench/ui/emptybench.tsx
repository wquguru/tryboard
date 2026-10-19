import { cn } from "../../../ui/cn";
import { t } from "../../../i18n";
import { btn, btnPri } from "./common";

// ------------------------------------------------------------ empty-bench guide
export function EmptyBench({
  onFirmware,
  hasFw,
}: {
  onFirmware: () => void;
  hasFw: boolean;
}) {
  return (
    <div
      id="emptyBench"
      className="absolute top-1/2 left-1/2 z-3 w-[340px] max-w-[calc(100%-24px)] -translate-x-1/2 -translate-y-1/2 rounded-(--r) border border-line bg-surface p-4 text-fg shadow-panel"
    >
      {/* Without firmware the only primary button is "Change firmware…" (design unify/Steps); with it, Shop gets primary */}
      {!hasFw && <span className="block text-[11px] font-medium text-muted">{t("No firmware")}</span>}
      <b className="block text-sm">{t("Only a dev board on the bench")}</b>
      <p className="mt-1 mb-3 text-xs text-muted">
        {hasFw
          ? t("Pick parts in Shop to put here, or drag single parts from the library and wire them.")
          : t("Drop a .bin exported from ESP-IDF / Arduino, or run an example first.")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {hasFw ? (
          <a href="#shop" className={cn(btnPri, "no-underline")}>
            {t("Pick parts in Shop")}
          </a>
        ) : (
          <button type="button" id="emptyFw" data-fw-open="" className={btnPri} onClick={onFirmware}>
            {t("Change firmware…")}
          </button>
        )}
        {hasFw ? (
          <button type="button" data-fw-open="" className={btn} onClick={onFirmware}>
            {t("Change firmware…")}
          </button>
        ) : (
          <a href="#shop" className={cn(btn, "no-underline")}>
            {t("Pick parts in Shop")}
          </a>
        )}
      </div>
    </div>
  );
}
