// Bench section: selection and bench wires (shared by every section).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { lessonWires, wiresOf } from "../wiring";
import { type Selection } from "../types";
import type { BenchCtx } from "./ctx";

export function mountSelect(b: BenchCtx) {
  function select(sel: Selection | null) {
    // Something picked on the bench expands its group in the build tree.
    if (sel && sel.kind in b.openGroups) b.openGroups[sel.kind] = true;
    // A different pick closes the card and the "distance to chip" mark (the ruler tool owns its own marks).
    if (b.cardFor && !(sel && sel.kind === b.cardFor.kind && sel.id === b.cardFor.id))
      b.closeCard();
    if (!b.ruler) b.ctx!.session.pick.measure?.(null);
    b.ctx!.store.set({ selection: sel });
  }
  const benchWires = () =>
    wiresOf(
      b.ctx!.session.scene.parts,
      !!b.ctx!.session.power?.ext5v,
      b.ctx!.session.wireMods,
    );

  b.select = select;
  b.benchWires = benchWires;
  b.shownWires = () => {
    const ses = b.ctx!.session;
    return lessonWires(ses.scene.parts, b.lessonKeep ?? null, !!ses.power?.ext5v, ses.wireMods);
  };
}

