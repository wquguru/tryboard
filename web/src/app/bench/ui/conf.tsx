import { t } from "../../../i18n";
import { ConfIcon, confLabel, type ConfLevel } from "../../../ui/conf";
import { BEHV, EST, PART_CONF, REAL, SIMV } from "../../../trust";

// ------------------------------------------------------------ confidence
// ConfLevel values are machine identifiers shared with ui/conf.tsx and data files; only labels are translated.
export type Conf = ConfLevel;
export { SIMV, BEHV, EST, REAL };
/** Display label per confidence level (the stored value stays the identifier). */
export const CONF_LABEL: Record<Conf, string> = { [SIMV]: confLabel(SIMV), [BEHV]: confLabel(BEHV), [EST]: confLabel(EST), [REAL]: confLabel(REAL) };
const CONF_TIP: Record<Conf, string> = {
  [SIMV]: t("An acceptance firmware ran in the simulator; readings follow the datasheet registers and formulas"),
  [BEHV]: t("Register interface follows the datasheet, physics is approximated; noise and timing details are not modeled"),
  [EST]: t("No model; estimated from the datasheet only"),
  [REAL]: t("This can't be simulated; only real hardware gives a verdict"),
};
/** Per-part confidence on the bench: trust.ts (G-08 checks it against what the web runs). */
export { PART_CONF };
/** Ink icon + level name (U-14: colour is reserved for result status, not confidence). */
export function ConfBadge({ c }: { c: Conf }) {
  return (
    <span
      data-conf={c}
      title={CONF_TIP[c]}
      className="inline-flex h-5 flex-none items-center gap-1 text-[11px] whitespace-nowrap text-fg"
    >
      <ConfIcon c={c} size={12} />
      {CONF_LABEL[c]}
    </span>
  );
}
