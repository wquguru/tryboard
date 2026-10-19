import { type ReactNode } from "react";
import { Icon } from "../../icons";
import { t } from "../../../i18n";
import { btn, btnPri } from "./common";

// ------------------------------------------------------------ brownout reset explanation
export function BrownoutBanner({
  t: at,
  v,
  servo,
  onPower,
  onClose,
}: {
  t: number;
  v: number | null;
  servo: boolean;
  onPower: (() => void) | null;
  onClose: () => void;
}): ReactNode {
  return (
    <div
      id="brownBanner"
      role="alert"
      className="absolute top-14 left-1/2 z-4 w-[420px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-(--r) border border-(--bad-line) bg-bad-bg p-3 text-xs text-bad-ink shadow-panel"
    >
      <div className="flex items-start gap-2">
        <Icon n="warn" size={16} className="mt-px flex-none" />
        <div className="min-w-0 flex-1">
          <b className="block text-[13px]">
            {t("Voltage too low, the chip restarted")}
          </b>
          <p className="mt-1 mb-0 text-[13px]">
            {servo
              ? t("The servo shares USB power with the chip; when it moves it drags the voltage down.")
              : t("The peripherals draw more than USB can supply.")}
          </p>
          <p className="mt-1 mb-0 opacity-75">
            {v != null
              ? t("At {t} s, 3V3 dropped to {v} V, below the brownout threshold (brownout reset). Serial prints the boot log again.", { t: at.toFixed(2), v: v.toFixed(2) })
              : t("At {t} s, 3V3 fell below the brownout threshold (brownout reset). Serial prints the boot log again.", { t: at.toFixed(2) })}
          </p>
          <div className="mt-2 flex gap-1.5">
            {onPower && (
              <button type="button" className={btnPri} onClick={onPower}>
                {t("Check power")}
              </button>
            )}
            <button type="button" className={btn} onClick={onClose}>
              {t("Got it")}

            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
