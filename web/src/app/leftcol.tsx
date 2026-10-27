// Lab v2 left column (DESIGN_V2 §4.2): build tree / parts library / wiring tabs, "Add part", checkpoint card at the bottom.
// The tree is the shell's panel (each step draws it); only the bench fills the `left` store, other steps show just the tree.
import { useState, type ReactNode } from "react";
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { commit, useStore } from "./react";
import { createStore } from "./store";
import { Icon } from "./icons";
import { mui, setMui, SheetHead, usePhone } from "./mobile";

export interface LeftData {
  lib: ReactNode;
  wires: ReactNode;
  wireCount: number;
  card: ReactNode;
}
const left = createStore<LeftData>({
  lib: null,
  wires: null,
  wireCount: 0,
  card: null,
});
export const setLeft = (p: Partial<LeftData>) => commit(() => left.set(p));

type Tab = "tree" | "lib" | "wires";
const tabCls =
  "h-8 min-w-0 flex-1 cursor-pointer truncate whitespace-nowrap rounded-md border-0 bg-transparent px-1 text-xs text-muted hover:text-fg aria-selected:bg-(--seg-on) aria-selected:font-medium aria-selected:text-fg aria-selected:shadow-[0_1px_2px_#0000001a]";

export function LeftColumn({ step, tree }: { step: string; tree: ReactNode }) {
  const d = useStore(left);
  const [tab, setTab] = useState<Tab>("tree");
  const bench = step === "bench";
  // Only the bench has the library and wiring tabs; elsewhere fall back to the tree.
  const cur: Tab = bench ? tab : "tree";
  const m = useStore(mui);
  const phone = usePhone();
  if (phone && bench) {
    // Phone: full page (DESIGN_V2 §5). Tab lives in mui.lib so toolbar "Add part" / banner "wiring" jump straight to it.
    const pc: Tab = m.lib ?? "lib";
    return (
      <>
        <div className="flex-none px-4 pt-[env(safe-area-inset-top)]">
          <SheetHead
            title={
              pc === "lib" ? t("Add part") : pc === "wires" ? t("Wiring") : t("Build tree")
            }
            id="libClose"
            onClose={() => setMui({ lib: null })}
          />
          <div
            role="tablist"
            aria-label={t("Parts pages")}
            className="mt-1 mb-2 flex gap-0.5 rounded-xl bg-field p-0.5"
          >
            {(
              [
                ["lib", t("Parts library")],
                ["tree", t("Build tree")],
                ["wires", `${t("Wiring")}${d.wireCount ? ` ${d.wireCount}` : ""}`],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                data-left={id}
                aria-selected={pc === id}
                onClick={() => setMui({ lib: id })}
                className={cn(tabCls, "h-11 text-[13px]")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col px-2",
            pc !== "tree" && "hidden",
          )}
        >
          {tree}
        </div>
        {pc === "lib" && (
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-[calc(16px+env(safe-area-inset-bottom))]">
            {d.lib}
          </div>
        )}
        {pc === "wires" && (
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 text-[13px]">
            {d.wires}
          </div>
        )}
      </>
    );
  }
  return (
    <>
      {bench && (
        <div
          role="tablist"
          aria-label={t("Left column")}
          className="mx-2 mt-2 flex flex-none gap-0.5 rounded-lg bg-field p-0.5"
        >
          {(
            [
              ["tree", t("Build tree")],
              ["lib", t("Parts library")],
              ["wires", `${t("Wiring")}${d.wireCount ? ` ${d.wireCount}` : ""}`],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              data-left={id}
              aria-selected={cur === id}
              onClick={() => setTab(id)}
              className={tabCls}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {/* Content-sized but capped at half the column: lesson parts and wires show without scrolling, the card keeps the rest (H-22) */}
      <div
        className={cn(
          "flex min-h-[132px] flex-auto flex-col overflow-auto",
          d.card && "max-h-[50%] shrink-0",
          cur !== "tree" && "hidden",
        )}
      >
        {tree}
      </div>
      {bench && cur === "lib" && (
        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">{d.lib}</div>
      )}
      {bench && cur === "wires" && (
        <div className={cn("min-h-[132px] flex-auto overflow-auto px-2 py-2", d.card && "max-h-[50%] shrink-0")}>{d.wires}</div>
      )}
      {bench && (
        // Fixed footer: the top border marks where the list is cut, so the tree's last row (firmware) isn't hidden by the button.
        <div className="flex-none border-t border-line-soft px-2 pt-2 pb-2">
          <a
            id="addPart"
            href="#shop"
            title={t("Full part sets come from the shopping list: tick them in Shop, then \"Next: Lab\". Single parts can be dragged from the library above onto the bench (or click \"Place\") and wired one by one.")}
            className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-dashed border-hover-line text-xs text-muted no-underline hover:border-accent hover:text-accent-ink"
          >
            <Icon n="plus" size={14} />
            {t("Add part")}
          </a>
        </div>
      )}
      {bench && d.card && (
        // Gets what the tree / wiring list leave (content height, at most half the column), then scrolls
        <div className="min-h-0 shrink overflow-auto border-t border-line-soft p-2">{d.card}</div>
      )}
    </>
  );
}
