// Stage overlays (DESIGN_V2 §4.3): view buttons, desk/room chip, hints, the "?" shortcut sheet, plus cards the bench
// mounts temporarily via bc.overlays (wiring banner, multimeter, miswire, brownout, firmware verify...).
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { actions, bc } from "./chrome";
import { Icon } from "./icons";
import { useStore } from "./react";
import { MobileStageBar, usePhone } from "./mobile";

const vb =
  "flex size-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-xs font-medium text-fg hover:bg-field disabled:cursor-not-allowed disabled:text-muted";

const KEYS: [string, string][] = [
  ["⌘K", t("Command box: search commands, parts, pins")],
  ["⌘Z / ⇧⌘Z", t("Undo / redo (bench timeline)")],
  ["V", t("Select")],
  ["W", t("Rewire: click a wire, then the new pin")],
  ["M", t("Multimeter: click a pin to measure voltage to ground")],
  ["R", t("Ruler")],
  ["F", t("Fit the selection")],
  ["Esc", t("Exit the current tool / close popups")],
  ["?", t("Open this sheet")],
];

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label={t("Keyboard shortcuts")}
      id="keySheet"
      className="absolute top-14 right-3 z-6 w-[280px] rounded-(--r) border border-line bg-surface p-3 text-fg shadow-panel"
    >
      <div className="mb-2 flex items-center justify-between">
        <b className="text-[13px]">{t("Keyboard shortcuts")}</b>
        <button
          type="button"
          aria-label={t("Close")}
          className={cn(vb, "size-6")}
          onClick={onClose}
        >
          <Icon n="x" size={14} />
        </button>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        {KEYS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="rounded border border-line bg-field px-1.5 font-mono text-[11px]">
                {k}
              </kbd>
            </dt>
            <dd className="m-0 text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function StageOverlays({ bench }: { bench: boolean }) {
  const c = useStore(bc);
  const phone = usePhone();
  const [keys, setKeys] = useState(false);
  useEffect(() => {
    if (!bench) return;
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input,textarea,select,[contenteditable]")) return;
      if (e.key === "?") setKeys((v) => !v);
      else if (e.key === "Escape") setKeys(false);
      else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey)
        actions.view?.("fit");
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [bench]);
  if (!bench) return null;
  const v = actions.view;
  const full = () => {
    const el = document.getElementById("stage");
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el?.requestFullscreen?.();
  };
  return (
    <>
      {/* Top-left column (the bottom edge belongs to the toolbar). */}
      <div className="pointer-events-none absolute top-3 left-3 z-2 flex flex-col items-start gap-1 max-md:hidden">
        {c.room != null && (
          <div
            id="roomChip"
            className="rounded-full border border-line bg-(--panel) px-2.5 py-1 font-mono text-[11px] text-muted shadow-panel"
          >
            {t("Desk · room {temp} °C", { temp: c.room.toFixed(1) })}
          </div>
        )}
        <span className="disclaimer pl-1 text-[11px] text-muted">
          {t("Illustrative look, not an official Espressif model")}
        </span>
        <span className="pl-1 text-[11px] text-muted max-[1280px]:hidden">
          {t("Drag to rotate · right-drag to pan · scroll to zoom · click a part for properties")}
        </span>
      </div>
      <div
        role="group"
        aria-label={t("View")}
        className="viewcube absolute top-3 right-3 z-2 flex gap-0.5 rounded-lg border border-line bg-(--panel) p-0.5 shadow-panel max-md:hidden"
      >
        <button
          type="button"
          data-view="top"
          title={t("Top view")}
          aria-label={t("Top view")}
          disabled={!v}
          onClick={() => v?.("top")}
          className={vb}
        >
          {t("Top")}
        </button>
        <button
          type="button"
          data-view="front"
          title={t("Front view")}
          aria-label={t("Front view")}
          disabled={!v}
          onClick={() => v?.("front")}
          className={vb}
        >
          {t("Front")}
        </button>
        <span className="mx-0.5 my-1 w-px bg-line" />
        <button
          type="button"
          data-view="in"
          title={t("Zoom in")}
          aria-label={t("Zoom in")}
          disabled={!v}
          onClick={() => v?.("in")}
          className={vb}
        >
          <Icon n="plus" size={15} />
        </button>
        <button
          type="button"
          data-view="out"
          title={t("Zoom out")}
          aria-label={t("Zoom out")}
          disabled={!v}
          onClick={() => v?.("out")}
          className={vb}
        >
          <Icon n="minus" size={15} />
        </button>
        <button
          type="button"
          data-view="fit"
          title={t("Fit selection (F)")}
          aria-label={t("Fit selection")}
          disabled={!v}
          onClick={() => v?.("fit")}
          className={vb}
        >
          <Icon n="target" size={15} />
        </button>
        <button
          type="button"
          data-view="full"
          title={t("Full screen")}
          aria-label={t("Full screen")}
          onClick={full}
          className={vb}
        >
          <Icon n="full" size={15} />
        </button>
        <button
          type="button"
          id="keysBtn"
          aria-label={t("Keyboard shortcuts")}
          title={t("Keyboard shortcuts (?)")}
          aria-expanded={keys}
          onClick={() => setKeys((x) => !x)}
          className={vb}
        >
          <Icon n="help" size={15} />
        </button>
      </div>
      {keys && <Shortcuts onClose={() => setKeys(false)} />}
      {phone && <MobileStageBar wiring={!!c.overlays.wire} />}
      {Object.entries(c.overlays).map(([k, n]) => (
        <div key={k} data-overlay={k} className="contents">
          {n}
        </div>
      ))}
    </>
  );
}
