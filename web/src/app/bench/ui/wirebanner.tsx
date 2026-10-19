import { Icon } from "../../icons";
import { t } from "../../../i18n";
import { setMui, usePhone } from "../../mobile";
import { tn } from "./common";

// ------------------------------------------------------------ wiring banner + pin rings
/** Thin wires are hard to tap on phones, so the banner lists rewirable wires plus undo and wiring table (DESIGN_V2 §5). */
export function WireBanner({
  wire,
  onCancel,
  wires,
  onWire,
  onUndo,
}: {
  wire: string | null;
  onCancel: () => void;
  wires?: { id: string; label: string }[];
  onWire?: (id: string) => void;
  onUndo?: (() => void) | null;
}) {
  const phone = usePhone();
  if (phone)
    return (
      <div
        id="wireBanner"
        role="status"
        className="absolute top-2 right-2 left-2 z-5 rounded-xl bg-accent-strong p-2 pl-3 text-[13px] text-on-accent shadow-panel"
      >
        <div className="flex items-center gap-2">
          <Icon n="wire" size={16} className="flex-none" />
          <span className="min-w-0 flex-1 leading-snug">
            {wire ? (
              <>
                {tn("Selected {wire}, now tap a blue pin", { wire: <b className="font-mono">{wire}</b> })}
              </>
            ) : (
              t("First tap the wire to rewire:")
            )}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 flex-none cursor-pointer rounded-lg border-0 bg-[#ffffff2e] px-3 text-[13px] text-on-accent"
          >
            {t("Cancel")}
          </button>
        </div>
        {!wire && !!wires?.length && (
          <div className="mt-1.5 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
            {wires.map((w) => (
              <button
                key={w.id}
                type="button"
                data-wpick={w.id}
                onClick={() => onWire?.(w.id)}
                className="min-h-11 flex-none cursor-pointer rounded-lg border-0 bg-surface px-3 font-mono text-xs whitespace-nowrap text-fg"
              >
                {w.label}
              </button>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex gap-1.5">
          <button
            type="button"
            data-wire-undo=""
            disabled={!onUndo}
            onClick={() => onUndo?.()}
            className="min-h-11 flex-1 cursor-pointer rounded-lg border-0 bg-[#ffffff2e] px-2 text-[13px] text-on-accent disabled:opacity-50"
          >
            {t("Undo last step")}
          </button>
          <button
            type="button"
            data-wire-table=""
            onClick={() => setMui({ lib: "wires", props: false, more: false })}
            className="min-h-11 flex-1 cursor-pointer rounded-lg border-0 bg-[#ffffff2e] px-2 text-[13px] text-on-accent"
          >
            {t("View wiring table")}
          </button>
        </div>
      </div>
    );
  return (
    <div
      id="wireBanner"
      role="status"
      className="absolute top-14 left-1/2 z-4 flex -translate-x-1/2 items-center gap-2 rounded-full bg-accent-strong py-1 pr-1 pl-3.5 text-xs text-on-accent shadow-panel"
    >
      <Icon n="wire" size={14} />
      <span>
        {wire ? (
          <>
            {tn("Rewire {wire}: click a new pin", { wire: <b className="font-mono">{wire}</b> })}
          </>
        ) : (
          t("Wiring… first click the wire to rewire")
        )}
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="h-6 cursor-pointer rounded-full border-0 bg-[#ffffff2e] px-2.5 text-xs text-on-accent hover:bg-[#ffffff47]"
      >
        {t("Esc to cancel")}
      </button>
    </div>
  );
}
