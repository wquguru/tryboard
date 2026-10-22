// "Controlled by the scenario · Open" above a right-column slider (F-11 §3.1). Dragging still works (§9 Q5 a):
// the manual value is logged and the next scripted value overrides it.
import { useSyncExternalStore } from "react";
import { t } from "../../i18n";
import { setDock } from "../chrome";
import { isPhone, setMui } from "../mobile";
import { trackKey } from "../scenario";
import { scenFeed } from "../scenariofeed";

/** Track key the slider drives: temp / hum / press / dist / mv:<pin> */
const scripted = (key: string) => !!scenFeed.get().sc?.tracks.some((tr) => tr.on !== false && trackKey(tr) === key);

let rev = 0;
export function openScenarioTrack(key: string) {
  scenFeed.set({ focus: { key, rev: ++rev } });
  setDock({ tab: "scenario", collapsed: false });
  if (isPhone()) setMui({ props: false, sheet: "half" });
}

export function ScenHint({ k }: { k: string }) {
  const on = useSyncExternalStore((cb) => scenFeed.subscribe(cb), () => scripted(k), () => false);
  if (!on) return null;
  return (
    <button
      type="button"
      data-scenhint={k}
      onClick={() => openScenarioTrack(k)}
      className="flex min-h-7 w-full cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-left text-xs text-accent-ink max-md:min-h-11"
    >
      <span className="text-muted">{t("Controlled by the scenario")}</span>
      <span aria-hidden="true">·</span>
      <span className="underline">{t("Open the track")}</span>
    </button>
  );
}
