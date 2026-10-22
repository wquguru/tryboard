// Bench section: Wiring rule check (P0-12).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { checkWiring, faultByWire } from "../wirecheck";
import { applyCached, enrichFaults } from "../faultsolve";
import { bc, setBc, type Issue } from "../chrome";
import type { BenchCtx } from "./ctx";

export function mountWiringCheck(b: BenchCtx) {
  let shownFaults = new Set<string>();
  /** Wiring check generation: the async net solve is used only if still current. */
  let faultGen = 0;
  /** Board-pin to board-pin jumpers drawn on the bench (P2-14). */
  let shownBridge = new Set<string>();
  /** Wires drawn as rewired (kept in sync with wireMods.retarget). */
  let shownRewire = new Set<string>();

  function recheckWiring() {
    const c = b.ctx!;
    const s3 = c.session.chip === "esp32s3";
    const fresh = checkWiring(c.session.scene.parts, b.benchWires(), c.session.i2cFw);
    const cached = applyCached(fresh, s3);
    b.faults = cached.faults;
    const gen = ++faultGen;
    // Fault currents come from the wasm elec solver (P2-14); first call instantiates wasm, results patch the panel and card.
    if (!cached.done)
      void enrichFaults(fresh, s3)
        .then((fs) => {
          if (gen !== faultGen || !b.ctx) return;
          b.faults = fs;
          b.renderTree();
          b.renderProps();
          const f = b.wwShow && bc.get().overlays.wrongWire ? b.wwShow : null;
          if (f) f(b.faults[0]);
        })
        .catch((e) => console.warn("wiring fault solve failed", e));
    const by = faultByWire(b.faults);
    for (const id of shownFaults)
      if (!by.has(id)) c.session.pick.setWireFault?.(id, null);
    for (const [id, f] of by) c.session.pick.setWireFault?.(id, f.short);
    shownFaults = new Set(by.keys());
    // Rewired wires move to the new pin in 3D; rewire() handles reverts and setScene rebuilds itself.
    const moved = b.benchWires().filter((w) => w.from);
    const now = new Set(moved.map((w) => w.id));
    for (const id of shownRewire)
      if (!now.has(id)) c.session.pick.rewire?.(id, null);
    for (const w of moved) c.session.pick.rewire?.(w.id, w.a);
    shownRewire = now;
    const jumps = b.benchWires().filter((w) => w.part === "jumper");
    const nowJ = new Set(jumps.map((w) => w.id));
    for (const id of shownBridge)
      if (!nowJ.has(id)) c.session.pick.bridge?.(id, "", null);
    for (const w of jumps) c.session.pick.bridge?.(w.id, w.a, w.b);
    shownBridge = nowJ;
    // Issues tab: wiring check results (prefix wire:; brownout entries are written by main.tsx).
    const issues: Issue[] = b.faults.map((f, i) => ({
      id: `wire:${f.rule}:${i}`,
      level: f.level,
      title: f.title,
      detail: f.short,
      go: () => b.select({ kind: "wire", id: f.wires[0] }),
    }));
    const keep = bc.get().issues.filter((x) => !x.id.startsWith("wire:"));
    if (
      JSON.stringify(issues.map((x) => [x.id, x.detail])) !==
      JSON.stringify(
        bc
          .get()
          .issues.filter((x) => x.id.startsWith("wire:"))
          .map((x) => [x.id, x.detail]),
      )
    )
      setBc({ issues: [...keep, ...issues] });
  }

  b.recheckWiring = recheckWiring;
}

