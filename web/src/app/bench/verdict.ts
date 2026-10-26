// Bench section: verdict, next step, toolbar.
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { type StepCtx } from "../types";
import { extModelsOn } from "../../extmodels";
import { HOME } from "../../ui/links";
import { passedCount } from "./progress";
import type { BenchCtx } from "./ctx";
import { viewTools } from "../schematic/view";

export function mountVerdict(b: BenchCtx) {
  function syncChrome() {
    const c = b.ctx!;
    const n = c.work.checkpoints.length;
    const done = passedCount(c);
    // Picked-board projects only have Shop → Bench; once all checkpoints pass, the top right opens the buy card
    if (c.custom)
      return n && done === n
        ? c.shell.setNext(t("Next: build it for real →"), "bench", "", b.openBuy, "hot")
        : c.shell.setNext(
            t("Build it for real · checkpoints left: {n}", { n: n - done }),
            null,
            t("The buy card appears once every checkpoint passes ({done}/{n}, demo firmware counts)", { done, n }),
          );
    // The blank project has no Assemble / Product steps, so the top right points to picking a project
    if (c.work.id === "blank")
      return c.shell.setNext(t("Need an enclosure? Pick a project →"), "bench", "", () =>
        location.assign(`${HOME}#works`),
      );
    // The inclinometer has no checkpoints or assembly template, so Product (the handheld box) is always open
    if (c.work.id === "imu") return c.shell.setNext(t("Next: Product →"), "product");
    if (n && done === n)
      return c.shell.setNext(t("Next: Assemble →"), "assemble", "", undefined, "hot");
    c.shell.setNext(
      t("Assemble · checkpoints left: {n}", { n: n - done }),
      null,
      t("Assemble unlocks once every checkpoint passes ({done}/{n}, built-in firmware counts)", { done, n }),
    );
  }

  /** Bench toolbar groups (labels follow the 3D-model and recording state). */
  function setToolGroups(c: StepCtx) {
    // Beginner lesson (H-01): select / orbit / reset view / BOOT, the rest folded behind "More tools"
    if (b.lessonTools() && !b.beginnerMore)
      return c.shell.toolbar.setGroups([
        { id: "run", tools: [{ id: "run", label: t("Run"), primary: true }, ...b.flowTools()] },
        {
          id: "nav",
          tools: [
            { id: "select", label: t("Select"), key: "V" },
            { id: "orbit", label: t("Orbit"), key: "H", kind: "switch" },
            { id: "fit", label: t("Reset view") },
          ],
        },
        { id: "act", tools: [{ id: "button", label: t("Press BOOT") }] },
        { id: "view", tools: viewTools() },
        { id: "more", tools: [{ id: "more", label: t("More tools (multimeter, scope…)") }] },
      ]);
    const less = b.lessonTools() ? [{ id: "more", tools: [{ id: "more", label: t("Fewer tools") }] }] : [];
    c.shell.toolbar.setGroups([
      {
        id: "nav",
        tools: [
          { id: "select", label: t("Select"), key: "V" },
          { id: "orbit", label: t("Orbit"), key: "H", kind: "switch" },
        ],
      },
      {
        id: "edit",
        tools: [
          { id: "place", label: t("Place") },
          { id: "wire", label: t("Wire"), key: "W" },
        ],
      },
      {
        id: "measure",
        tools: [
          { id: "meter", label: t("Multimeter"), key: "M" },
          { id: "ruler", label: t("Ruler"), key: "R" },
          { id: "scope", label: t("Scope") },
        ],
      },
      {
        id: "look",
        tools: [
          {
            id: "ext",
            label: extModelsOn() ? t("3D models: on") : t("3D models: off"),
            phoneLabel: t("Real 3D models"),
            kind: "switch",
            on: extModelsOn,
          },
        ],
      },
      {
        id: "media",
        tools: [
          { id: "photo", label: t("Photo") },
          { id: "rec", label: b.benchRec ? t("Stop recording") : t("Record"), on: () => !!b.benchRec },
        ],
      },
      {
        id: "act",
        tools: [
          { id: "heat", label: t("Heater"), kind: "tag", on: () => !!c.session.heat },
          { id: "button", label: t("Press BOOT") },
        ],
      },
      // Rerun lives in the top bar run group (Reset), so the toolbar does not repeat it (DESIGN_V2 §6.3)
      { id: "view", tools: viewTools() },
      ...less,
    ]);
  }

  b.syncChrome = syncChrome;
  b.setToolGroups = setToolGroups;
}

