// Fault checkpoint (F-05) switches: the bench starts as found; each choice maps to one CLI flag, so a check here
// runs the same args as `tools/check.py --level <id> <flags>` and gets the same verdict and run ID.
import { useState } from "react";
import { t } from "../../i18n";
import type { Level } from "../../checks";
import { faultCommand, faultLevel, foundKnobs } from "../../faults";
import { Code, Note, Sec, Seg, SegB } from "../../ui/panel";

const KEY = "tryboard-fault-knobs:";
const cur: Record<string, Record<string, string>> = {};

/** Current switches of a fault checkpoint: saved choice per knob, else the as-found value */
export function knobsOf(l: Level): Record<string, string> {
  if (!cur[l.id]) {
    let saved: Record<string, string> = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY + l.id) ?? "{}");
    } catch {
      /* private mode or bad JSON: start as found */
    }
    const found = foundKnobs(l);
    const ok = (f: string) => l.fault?.knobs?.find((k) => k.flag === f)?.options.some((o) => o.v === saved[f]);
    cur[l.id] = Object.fromEntries(Object.keys(found).map((f) => [f, ok(f) ? saved[f] : found[f]]));
  }
  return cur[l.id];
}

/** The level a check runs: fault checkpoints get the bench as found plus the current switches */
export const levelToRun = (l: Level) => (l.fault ? faultLevel(l, knobsOf(l)) : l);

export function FaultKnobs({ l, disabled }: { l: Level; disabled?: boolean }) {
  const [v, setV] = useState(() => knobsOf(l));
  const found = foundKnobs(l);
  const set = (flag: string, val: string) => {
    const next = { ...v, [flag]: val };
    cur[l.id] = next;
    try {
      localStorage.setItem(KEY + l.id, JSON.stringify(next));
    } catch {
      /* not saved: fine for this visit */
    }
    setV(next);
  };
  const knobs = l.fault?.knobs ?? [];
  const changed = knobs.some((k) => v[k.flag] !== found[k.flag]);
  return (
    <div id="faultKnobs" data-level={l.id}>
      <Sec>{t("Bench switches")}</Sec>
      {knobs.length ? (
        knobs.map((k) => (
          <div key={k.flag} className="mb-2">
            <div className="mb-1 text-xs text-muted">{t(k.name)}</div>
            <Seg aria-label={t(k.name)} className={k.options.some((o) => o.label.length > 18) ? "grid-cols-1" : undefined}>
              {k.options.map((o) => (
                <SegB key={o.v} data-flag={k.flag} data-v={o.v} on={v[k.flag] === o.v} disabled={disabled} className="max-md:min-h-11" onClick={() => set(k.flag, o.v)}>
                  {t(o.label)}
                </SegB>
              ))}
            </Seg>
          </div>
        ))
      ) : (
        <Note>{t("Nothing on the bench can fix this one: the fix is in the firmware. Drop your own .bin above.")}</Note>
      )}
      <Note>
        {changed
          ? t("Checks run with these switches. The bench firmware is the one that came with the bench, not an answer.")
          : t("The bench is as found. Change a switch or drop your own firmware, then check again.")}
      </Note>
      <Sec>{t("Check command")}</Sec>
      {/* No switches: `--ref --level <id>` alone is check.py's fault self-check, not the page's run, so only the own-firmware line */}
      {knobs.length > 0 && <Code>{faultCommand(l, v, false)}</Code>}
      <Code>{faultCommand(l, v, true)}</Code>
      <Note>
        {knobs.length
          ? t("The first line checks the bench firmware with your switches, the second your own firmware; both give the same verdict and run ID as the page.")
          : t("Checks your own firmware; gives the same verdict and run ID as the page.")}
      </Note>
    </div>
  );
}
