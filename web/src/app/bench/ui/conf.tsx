import { t } from "../../../i18n";
import { ConfIcon, confLabel, type ConfLevel } from "../../../ui/conf";

// ------------------------------------------------------------ confidence
// ConfLevel values are machine identifiers shared with ui/conf.tsx and data files; only labels are translated.
export type Conf = ConfLevel;
export const [SIMV, BEHV, EST, REAL] = ["仿真验证", "行为模拟", "估算", "必须上真机"] as const satisfies readonly Conf[]; // lint: allow-cjk
/** Display label per confidence level (the stored value stays the identifier). */
export const CONF_LABEL: Record<Conf, string> = { [SIMV]: confLabel(SIMV), [BEHV]: confLabel(BEHV), [EST]: confLabel(EST), [REAL]: confLabel(REAL) };
const CONF_TIP: Record<Conf, string> = {
  [SIMV]: t("An acceptance firmware ran in the simulator; readings follow the datasheet registers and formulas"),
  [BEHV]: t("Register interface follows the datasheet, physics is approximated; noise and timing details are not modeled"),
  [EST]: t("No model; estimated from the datasheet only"),
  [REAL]: t("This can't be simulated; only real hardware gives a verdict"),
};
/** Per-part confidence on the bench; rationale per peripheral in docs/STATUS.md (firmware acceptance = simulated). */
export const PART_CONF: Record<string, Conf> = {
  board: SIMV,
  bme280: SIMV,
  oled: SIMV,
  gc9a01: SIMV,
  tft: SIMV,
  pot: SIMV,
  led: SIMV,
  key: SIMV,
  encoder: SIMV,
  servo: BEHV,
  buzzer: BEHV,
  hcsr04: BEHV,
  mpu6050: BEHV,
  qmi8658: BEHV,
  cst816s: BEHV,
  max98357a: BEHV,
  inmp441: BEHV,
  aht20: SIMV,
  ds3231: SIMV,
  // Current comes from the electrical model's estimate of the board draw
  ina219: BEHV,
};
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
