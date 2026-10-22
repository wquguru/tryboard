import { useState } from "react";
import { PARTS, type Kind } from "../../../catalog/parts";
import { cn } from "../../../ui/cn";
import { placeDef } from "../../place";
import { t } from "../../../i18n";
import { usePhone } from "../../mobile";
import { ConfIcon } from "../../../ui/conf";
import { CONF_LABEL, SIMV, EST, REAL } from "./conf";

// ------------------------------------------------------------ parts library
const KIND_NAMES: Partial<Record<Kind, string>> = {
  sensor: t("Sensors"),
  display: t("Displays"),
  actuator: t("Actuators"),
  input: t("Inputs"),
  audio: t("Audio"),
  module: t("Modules"),
  power: t("Power"),
  passive: t("Discrete parts"),
};
/** dataTransfer type for library drags; the bench drop accepts only this, so it never mixes with .bin drops. */
export const LIB_DRAG = "application/x-tryboard-part";
const SIM_NAMES = {
  verified: CONF_LABEL[SIMV],
  estimated: CONF_LABEL[EST],
  none: t("No model"),
} as const;
const SIM_CONF = {
  verified: SIMV,
  estimated: EST,
  none: REAL,
} as const;
/** inBom: part ids already in the shopping list (the phone library marks them "In list"). */
export function PartLib({
  chip,
  inBom,
  onPlace,
}: {
  chip: "esp32" | "esp32c3" | "esp32s3";
  inBom?: ReadonlySet<string>;
  /** Click / tap "Place" or drag onto the bench (P2-16); without it parts can only be added via Shop. */
  onPlace?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind | null>(null);
  const phone = usePhone();
  const all = PARTS.filter(
    (p) =>
      KIND_NAMES[p.kind] &&
      p.chips.includes(chip) &&
      (!q ||
        (p.name + p.model + p.keywords)
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
  const list = phone && kind ? all.filter((p) => p.kind === kind) : all;
  const kinds = [...new Set(list.map((p) => p.kind))];
  if (phone)
    return (
      <div id="partLib" className="text-[14px]">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder={t("Find a part: BME280, servo…")}
          aria-label={t("Find a part")}
          className="h-11 w-full rounded-xl border border-line bg-field px-3 text-[16px] text-fg outline-none focus:border-accent"
        />
        <div
          role="group"
          aria-label={t("Category")}
          className="-mx-4 mt-2 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]"
        >
          {([null, ...new Set(all.map((p) => p.kind))] as (Kind | null)[]).map(
            (k) => (
              <button
                key={k ?? "all"}
                type="button"
                data-kind={k ?? "all"}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className="h-11 flex-none cursor-pointer rounded-full border border-line bg-surface px-3.5 text-[13px] whitespace-nowrap text-fg aria-pressed:border-accent aria-pressed:bg-accent-bg aria-pressed:font-medium aria-pressed:text-accent-ink"
              >
                {k ? KIND_NAMES[k] : t("All")}
              </button>
            ),
          )}
        </div>
        <p className="mt-1 mb-2 text-xs text-muted">
          {t(
            "Parts reach the bench from the shopping list: tap one to tick it in Shop. Prices are hand-picked reference ranges.",
          )}
        </p>
        {list.map((p) => {
          const has = inBom?.has(p.id);
          // Phone placing (P2-16): a 44px "Place" next to the row; the row itself still ticks the part in Shop
          const d = onPlace ? placeDef(p.id) : null;
          const canPlace = !!d && !("why" in d);
          return (
            <div
              key={p.id}
              className="flex items-center gap-2 border-b border-line-soft"
            >
              <a
                href="#shop"
                data-lib={p.id}
                data-placeable={d ? String(canPlace) : undefined}
                className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-1.5 text-fg no-underline"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {t(p.name)}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {KIND_NAMES[p.kind]} · ¥{p.price.lo}–{p.price.hi} ·{" "}
                    <span className="inline-flex items-center gap-1 align-[-2px]">
                      <ConfIcon c={SIM_CONF[p.sim.level]} size={11} />
                      {SIM_NAMES[p.sim.level]}
                    </span>
                  </span>
                </span>
                <span
                  className={cn(
                    "flex-none rounded-full px-3 py-1.5 text-xs",
                    has
                      ? "bg-ok-bg text-ok-ink"
                      : "bg-accent-strong text-on-accent",
                  )}
                >
                  {has ? t("In list") : t("Add")}
                </span>
              </a>
              {canPlace && (
                <button
                  type="button"
                  data-place={p.id}
                  aria-label={t("Place {part} on the bench", {
                    part: t(p.name),
                  })}
                  onClick={() => onPlace?.(p.id)}
                  className="h-11 flex-none cursor-pointer rounded-full border border-accent bg-surface px-3.5 text-[13px] font-medium text-accent-ink"
                >
                  {t("Place")}
                </button>
              )}
            </div>
          );
        })}
        {!list.length && <p className="text-muted">{t("No matching parts")}</p>}
      </div>
    );
  return (
    <div id="partLib" className="text-xs">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        placeholder={t("Find a part: BME280, servo…")}
        aria-label={t("Find a part")}
        className="mb-2 h-8 w-full rounded-md border border-line bg-field px-2 text-xs text-fg outline-none focus:border-accent"
      />
      <p className="mt-0 mb-2 text-[11px] text-muted">
        {onPlace
          ? t(
              'Drag onto the bench or click "Place", then wire it to the board pin by pin; greyed parts can\'t be placed (hover for why). Whole kits still come from the shopping list.',
            )
          : t(
              "Parts reach the bench from the shopping list: click one to tick it in Shop.",
            )}
      </p>
      {kinds.map((k) => (
        <section key={k} className="mb-2">
          <h4 className="m-0 mb-1 text-[11px] font-medium text-muted">
            {KIND_NAMES[k]}
          </h4>
          {list
            .filter((p) => p.kind === k)
            .map((p) => {
              const d = onPlace ? placeDef(p.id) : null;
              const why = d && "why" in d ? d.why : null;
              return (
                <div
                  key={p.id}
                  data-lib={p.id}
                  data-placeable={d ? String(!why) : undefined}
                  draggable={!!d && !why}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(LIB_DRAG, p.id);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title={
                    why ??
                    (d ? t('Drag onto the bench, or click "Place"') : undefined)
                  }
                  className={cn(
                    "flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-field",
                    d && !why && "cursor-grab",
                  )}
                >
                  <a
                    href="#shop"
                    title={t("See it in Shop")}
                    className={cn(
                      "min-w-0 flex-1 truncate no-underline",
                      why ? "text-muted" : "text-fg",
                    )}
                  >
                    {t(p.name)}
                  </a>
                  <span className="inline-flex flex-none items-center gap-1 text-[10px] text-muted">
                    <ConfIcon c={SIM_CONF[p.sim.level]} size={10} />
                    {SIM_NAMES[p.sim.level]}
                  </span>
                  {d && (
                    <button
                      type="button"
                      data-place={p.id}
                      disabled={!!why}
                      aria-label={
                        why
                          ? t("{part} can't be placed: {why}", {
                              part: t(p.name),
                              why,
                            })
                          : t("Place {part} on the bench", { part: t(p.name) })
                      }
                      onClick={() => onPlace?.(p.id)}
                      className="h-6 flex-none cursor-pointer rounded-md border border-line bg-surface px-2 text-[11px] text-fg max-md:h-11 max-md:px-3 max-md:text-[13px] hover:border-accent hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg"
                    >
                      {t("Place")}
                    </button>
                  )}
                </div>
              );
            })}
        </section>
      ))}
      {!list.length && <p className="text-muted">{t("No matching parts")}</p>}
    </div>
  );
}
