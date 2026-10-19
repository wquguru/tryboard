import { cn } from "../../../ui/cn";
import { Icon } from "../../icons";
import { t } from "../../../i18n";
import { usePhone } from "../../mobile";
import { tn } from "./common";

/** Pin-by-pin wiring guide after placing a part (P2-16): current pin highlighted, click a blue ring on the board. */
export function PlaceBanner({
  name,
  steps,
  cur,
  got,
  onStep,
  onSkip,
  onBack,
  onCancel,
}: {
  name: string;
  steps: { pin: string; label: string; want: string; optional?: boolean }[];
  cur: number;
  got: Record<string, string>;
  onStep: (i: number) => void;
  onSkip: (() => void) | null;
  onBack: (() => void) | null;
  onCancel: () => void;
}) {
  const phone = usePhone();
  const s = steps[cur];
  const what =
    s.want === "gnd" ? "GND" : s.want === "power" ? t("3V3 or 5V") : t("a GPIO");
  return (
    <div
      id="placeBanner"
      role="status"
      data-step={s.pin}
      className={cn(
        "absolute z-5 rounded-xl bg-accent-strong text-on-accent shadow-panel",
        phone
          ? "top-2 right-2 left-2 p-2 pl-3 text-[13px]"
          : "top-14 left-1/2 w-[min(560px,calc(100%-24px))] -translate-x-1/2 px-3.5 py-2 text-xs",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon n="wire" size={14} className="flex-none" />
        <span className="min-w-0 flex-1 leading-snug">
          {tn(
            s.optional
              ? "Wire {pin} of {part} (optional): click {what} on the board (blue ring)"
              : "Wire {pin} of {part}: click {what} on the board (blue ring)",
            { part: <b>{name}</b>, pin: <b className="font-mono">{s.label}</b>, what },
          )}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "flex-none cursor-pointer rounded-full border-0 bg-[#ffffff2e] px-2.5 text-on-accent hover:bg-[#ffffff47]",
            phone ? "min-h-11 text-[13px]" : "h-6 text-xs",
          )}
        >
          {phone ? t("Don't place") : t("Esc: don't place")}
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {steps.map((x, i) => (
          <button
            key={x.pin}
            type="button"
            data-pstep={x.pin}
            aria-current={i === cur ? "step" : undefined}
            onClick={() => onStep(i)}
            className={cn(
              "cursor-pointer rounded-md border-0 px-2 font-mono text-[11px] whitespace-nowrap",
              phone ? "min-h-11" : "h-6",
              i === cur
                ? "bg-surface text-fg"
                : got[x.pin]
                  ? "bg-[#ffffff2e] text-on-accent"
                  : "bg-transparent text-on-accent opacity-75 outline outline-1 outline-[#ffffff47]",
            )}
          >
            {x.label}
            {got[x.pin] ? ` → ${got[x.pin]}` : ""}
          </button>
        ))}
        <span className="flex-1" />
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className={cn(
              "cursor-pointer rounded-md border-0 bg-[#ffffff2e] px-2 text-on-accent",
              phone ? "min-h-11 text-[13px]" : "h-6 text-[11px]",
            )}
          >
            {t("Previous pin")}
          </button>
        )}
        {onSkip && (
          <button
            type="button"
            data-pskip=""
            onClick={onSkip}
            className={cn(
              "cursor-pointer rounded-md border-0 bg-[#ffffff2e] px-2 text-on-accent",
              phone ? "min-h-11 text-[13px]" : "h-6 text-[11px]",
            )}
          >
            {t("Skip this pin")}
          </button>
        )}
      </div>
    </div>
  );
}
