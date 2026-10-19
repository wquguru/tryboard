import { t } from "../../../i18n";
import { btn, btnPri } from "./common";

// ------------------------------------------------------------ checkpoint card (bottom of left rail)
export function CheckpointCard({
  id,
  title,
  pass,
  done,
  total,
  go,
  onGo,
  onAll,
  own,
  allBusy,
  onAllRef,
  onMine,
}: {
  id: string;
  title: string;
  pass: string;
  done: number;
  total: number;
  go: string | null;
  onGo: () => void;
  onAll: () => void;
  /** How many passed with the user's own firmware (✓); the rest passed with reference firmware (◐). */
  own: number;
  /** Built-in firmware is being checked one checkpoint at a time. */
  allBusy: boolean;
  /** Run every checkpoint with built-in firmware (null when the project has no reference firmware). */
  onAllRef: (() => void) | null;
  /** Write your own: open this checkpoint (drop a .bin, copy the brief for an AI). */
  onMine: () => void;
}) {
  return (
    <div
      id="cpCard"
      className="rounded-lg border border-line bg-surface p-2.5 text-xs"
    >
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>{t("Current checkpoint")}</span>
        <span className="font-mono" title={t("Checkpoints that ran; \"mine\" passed with your own firmware")}>
          {done}/{total}
          {done > 0 && ` · ${t("mine {n}", { n: own })}`}
        </span>
      </div>
      <b className="mt-1 block text-[13px]">
        <span className="font-mono">{id}</span> {t(title)}
      </b>
      <p className="mt-1 mb-2 line-clamp-3 text-muted">{t(pass)}</p>
      {onAllRef && (
        <>
          <button
            type="button"
            id="cpAllRef"
            className={`${btnPri} w-full`}
            disabled={allBusy}
            onClick={onAllRef}
            title={t("Checks each checkpoint with the project's reference firmware; a pass counts as ◐ and still unlocks Assemble and Product")}
          >
            {allBusy ? t("Checking built-in firmware…") : t("Run all with built-in firmware")}
          </button>
          <p className="mt-1 mb-2 text-[11px] text-muted">
            {t("See Assemble and Product without a toolchain; switch to your own firmware later and passes become ✓.")}
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" id="cpMine" className={onAllRef ? btn : btnPri} onClick={onMine} title={t("Drop a .bin, or copy the brief for an AI")}>
          {t("Write my own firmware")}
        </button>
        <button
          type="button"
          id="cpGo"
          className={btn}
          onClick={onGo}
          title={go ? t("Select and focus {part}", { part: go }) : t("Open this checkpoint")}
        >
          {t("Show me")}
        </button>
        <button type="button" id="cpAll" className={btn} onClick={onAll}>
          {t("All checkpoints")}
        </button>
      </div>
    </div>
  );
}
export function AllPassedCard({
  total,
  own = total,
  retest,
  onNext,
}: {
  total: number;
  /** Passes with the user's own firmware; the rest ran on built-in firmware (◐). */
  own?: number;
  /** Power-on retest after assembly: false = failed, so the card must not still say "all passed". */
  retest?: boolean | null;
  onNext: () => void;
}) {
  if (retest === false)
    return (
      <div
        id="cpCard"
        className="rounded-lg border border-(--warn-line) bg-warn-bg p-2.5 text-xs text-warn-ink"
      >
        <b className="block text-[13px]">
          {t("Checkpoints {n}/{n} passed · power-on retest ✗", { n: total })}
        </b>
        <p className="mt-1 mb-2">{t("Fine on the bench, but the retest failed inside the enclosure: go back to Assemble and see what to change.")}</p>
        <button type="button" className={btnPri} onClick={onNext}>
          {t("Back to Assemble →")}
        </button>
      </div>
    );
  return (
    <div
      id="cpCard"
      className="rounded-lg border border-line bg-ok-bg p-2.5 text-xs text-ok-ink"
    >
      <b className="block text-[13px]">
        {own === total ? t("All {n} checkpoints passed", { n: total }) : t("All {n} checkpoints ran", { n: total })}
      </b>
      <p className="mt-1 mb-2">{t("Assemble is unlocked: put what's on the bench into an enclosure.")}</p>
      {own < total && (
        <p className="mt-0 mb-2 text-muted" data-own={own}>
          {t("My firmware {own}/{total}: the rest ran on built-in firmware (◐). Drop your own .bin on a checkpoint; a pass becomes ✓.", { own, total })}
        </p>
      )}
      <button type="button" className={btnPri} onClick={onNext}>
        {t("Next: Assemble →")}
      </button>
    </div>
  );
}
