// Small helpers and widgets shared by the bench sections (not a section itself).
import { t } from "../../i18n";
import { type PickTarget } from "../../scene-api";
import { type ConfLevel } from "../../ui/conf";
import { type Selection, type WorkDef } from "../types";
import { useInitText } from "../../ui/native";
import { Ph } from "../../ui/panel";
import { type Example } from "../examples";
import { HOME_WORKS } from "../works";
import { ConfBadge, PART_CONF } from "../benchv2";

/** ConfLevel ids are owned by ui/conf.tsx; Conf / ConfBadge render the label. */
export const EST: ConfLevel = "估算"; // lint: allow-cjk
export const hex = (n: number) => "0x" + n.toString(16).toUpperCase().padStart(2, "0");

export const selEq = (a: Selection | null, b: Selection | null) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;
export const toPick = (s: Selection | null): PickTarget | null =>
  s &&
  (s.kind === "part" ||
    s.kind === "pin" ||
    s.kind === "wire" ||
    s.kind === "button")
    ? { kind: s.kind, id: s.id }
    : null;

export type NEv = Event & { currentTarget: HTMLInputElement };
/** Reading next to a slider (the output inside the same label). */
export const outOf = (inp: HTMLInputElement) =>
  inp.parentElement?.querySelector("output");

/** Live OLED image (drawn every frame by updateLive). */
export const OledCanvas = () => (
  <canvas
    className="oled mb-1 block w-full rounded-md bg-(--oled-bg) [image-rendering:pixelated]"
    width={128}
    height={64}
    data-live="oledc"
  />
);

/** Copy brief: the click handler rewrites the button text imperatively. */
export function CopyBrief({ onCopy }: { onCopy: (b: HTMLButtonElement) => void }) {
  const ref = useInitText<HTMLButtonElement>(t("Copy brief"));
  return (
    <button
      ref={ref}
      type="button"
      id="copyBrief"
      className="btn hidden"
      onClick={(e) => onCopy(e.currentTarget)}
    />
  );
}

/** RGB LED swatch, built imperatively inside live fields. */
export function swatch(bg: string) {
  const i = document.createElement("i");
  i.className =
    "sw mr-1.5 inline-block size-2.5 rounded-[3px] border border-[#0002] align-[-1px]";
  i.style.background = bg;
  return i;
}

/** Note line whose text is updated imperatively (wire length conversion). */
export function NoteLive({ id, init }: { id: string; init: string }) {
  const ref = useInitText<HTMLParagraphElement>(init);
  return <p ref={ref} id={id} className="note my-2 text-xs text-muted" />;
}

/** Plain-language verdict, updated directly by events during slider drags to avoid re-rendering. */
export function SayLive({ id, init }: { id: string; init: string }) {
  const ref = useInitText<HTMLParagraphElement>(init);
  return <p ref={ref} id={id} className="mt-2 mb-0 text-[13px] font-medium text-fg" />;
}

/** Part heading in properties: name plus confidence badge (see benchv2 PART_CONF). */
export function PartHead({ name, type }: { name: string; type: string }) {
  const conf = PART_CONF[type];
  return (
    <div className="mb-2 flex items-center gap-2">
      <Ph className="mb-0 min-w-0">{name}</Ph>
      {conf && <ConfBadge c={conf} />}
    </div>
  );
}

/** A project using the same main part type (common LEDs and buttons ignored), or null. */
export function relatedWork(ex: Example, list: Example[]): WorkDef | null {
  const common = new Set(["led", "button", "key", "buzzer"]);
  const types = new Set((ex.scene?.parts ?? []).map((p) => p.type).filter((t) => !common.has(t)));
  if (!types.size) return null;
  return (
    HOME_WORKS.find((w) => {
      if (!w.checkpoints.length || !w.example) return false;
      if (w.example === ex.id) return true;
      const we = list.find((e) => e.id === w.example);
      return (we?.scene?.parts ?? []).some((p) => types.has(p.type));
    }) ?? null
  );
}
