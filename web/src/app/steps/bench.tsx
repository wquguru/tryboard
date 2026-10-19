// Step 2 Bench: build tree + inspector + checkpoints, quick cards (P0-04), pin scope (P0-11), wiring rules (P0-12), ruler/history (P0-13).
// Tree and scene picks share one selection; React redraws the panel on selection change, per-frame readings go through data-live.
import { partId } from "../wiring";
import { bit } from "../pinscope";
import { type StepImpl } from "../types";
import { loadExamples } from "../examples";
import { actions, overlay } from "../chrome";
import { bleFeed, phoneStateText } from "../blefeed";
import { setLeft } from "../leftcol";
import { pending, passedCount } from "../bench/progress";
import { toPick, relatedWork } from "../bench/shared";
import { createBenchCtx } from "../bench/ctx";
import { mountSelect } from "../bench/select";
import { mountWiringCheck } from "../bench/wiringcheck";
import { mountLeft } from "../bench/left";
import { mountWireTool } from "../bench/wiretool";
import { mountPlacing } from "../bench/placing";
import { mountTree } from "../bench/tree";
import { mountInspector } from "../bench/inspector";
import { mountPins } from "../bench/pins";
import { mountRuns } from "../bench/runs";
import { mountMeter } from "../bench/meter";
import { mountRuler } from "../bench/ruler";
import { mountEncoder } from "../bench/encoder";
import { mountPart } from "../bench/part";
import { mountOrientation } from "../bench/orient";
import { mountCheckpoint } from "../bench/checkpoint";
import { mountLive } from "../bench/live";
import { mountCustom } from "../bench/custom";
import { mountVerdict } from "../bench/verdict";
import { mountHeat } from "../bench/heat";
import { mountCards } from "../bench/cards";
import { mountDebug } from "../bench/debug";

export { ownCount, ownFirmware, passedCount, requestAllRef, restoreChecks } from "../bench/progress";

export function benchStep(): StepImpl {
  const b = createBenchCtx();
  mountSelect(b);
  mountWiringCheck(b);
  mountLeft(b);
  mountWireTool(b);
  mountPlacing(b);
  mountTree(b);
  mountInspector(b);
  mountPins(b);
  mountRuns(b);
  mountMeter(b);
  mountRuler(b);
  mountEncoder(b);
  mountPart(b);
  mountOrientation(b);
  mountCheckpoint(b);
  mountLive(b);
  mountCustom(b);
  mountVerdict(b);
  mountHeat(b);
  mountCards(b);
  mountDebug(b);

  let unsubs: (() => void)[] = [];
  let hooked = false;
  /** ?debug=1&wiring= is injected once. */
  let injected = false;
  return {
    mount(c) {
      b.ctx = c;
      b.toolbarRef = c.shell.toolbar;
      // "Change firmware → Upload" counts as your own firmware and is checked like a drop (2026-10-18 walkthrough found it skipped)
      actions.openBuy = c.custom ? b.openBuy : undefined;
      // session.levels may still be loading, so decide from the project and fetch each ref at run time
      actions.runAllRef = c.work.checkpoints.length && (!c.custom || c.custom.plan.demo) ? () => void b.runAllRef() : undefined;
      actions.checkUpload = (buf, name) => {
        const s = c.store.get();
        if (s.verifying) return null;
        if (c.custom) {
          const first = c.work.checkpoints[0];
          if (!first) return null;
          void b.verifyAll(buf, name, true);
          return c.work.checkpoints.join(", ");
        }
        const sel = s.selection?.kind === "checkpoint" ? s.selection.id : null;
        const id =
          sel ??
          c.work.checkpoints.find((x) => !(s.checks[x]?.ok && s.checks[x].own));
        const l = id && c.session.levels.find((x) => x.id === id);
        if (!l) return null;
        c.store.set({ selection: { kind: "checkpoint", id: l.id } });
        void b.verify(l, buf, name, true);
        return l.id;
      };
      if (!hooked) {
        hooked = true;
        if (c.work.id === "blank" && c.work.example)
          void loadExamples().then((list) => {
            const ex = list.find((e) => e.id === c.work.example);
            if (!ex) return;
            b.exInfo = { ex, work: relatedWork(ex, list) };
            if (b.ctx && b.ctx.store.get().step === "bench" && !b.ctx.store.get().selection) b.renderProps();
          });
        c.session.pick.onPick?.(b.onPick);
        c.shell.toolbar.onTool(b.onTool);
        c.shell.card.onHide(() => {
          cancelAnimationFrame(b.cardRaf);
          b.cardFor = null;
        });
        c.session.onTick((m) => {
          if (b.trace.pin < 0) return;
          const p = b.trace.pin;
          b.trace.push({
            t: m.simSeconds,
            duty: m.pwm[p] ?? -1,
            freq: m.pwmFreq[p] ?? 0,
            level: bit(m.gpio, m.gpioHi, p),
            out: !!bit(m.enable, m.enableHi, p),
          });
        });
        b.bindShortcuts();
        b.bindLibDrop();
        b.exposeDebugHooks();
      }
      b.setToolGroups(c);
      c.shell.toolbar.setActive(
        b.ruler ? "ruler" : b.meter ? "meter" : b.wiring ? "wire" : "select",
      );
      const pinDev = c.session.scene.parts.find(
        (p) => p.type === "encoder" || p.type === "hcsr04",
      );
      // Examples default to the "this example" card instead of firmware; encoder / sonar controls live in part properties, so select those
      if (!c.store.get().selection && !(c.work.example && !pinDev))
        c.store.set({
          selection: c.work.checkpoints.length
            ? { kind: "part", id: "bme280" }
            : pinDev
              ? { kind: "part", id: pinDev.type }
              : { kind: "firmware", id: "main" },
        });
      if (
        !c.session.scene.parts.some((p) => partId(p) === "bme280") &&
        c.store.get().selection?.id === "bme280"
      )
        c.store.set({ selection: { kind: "part", id: "board" } });
      b.recheckWiring();
      b.applyBenchHarness();
      // ?debug=1&wiring=<kind> injects one bad wiring on open and shows its card (visual acceptance, same entry as __tbApp.injectWiring)
      const q = new URLSearchParams(location.search);
      const inj = q.has("debug") ? q.get("wiring") : null;
      if (inj) {
        // Inject once; a remount (coming back from another step) only reopens the card and selection
        if (!injected) b.injectWiring(inj as Parameters<typeof b.injectWiring>[0]);
        injected = true;
        b.recheckWiring();
        const f = b.faults.find((x) => x.net) ?? b.faults[0];
        if (f) {
          c.store.set({ selection: { kind: "wire", id: f.wires[0] } });
          b.showWrongWire(
            f,
            f.wires[0],
            f.wires[0].replace(/^wire:/, ""),
            () => {},
            () => {},
          );
        }
      }
      b.meterCard();
      b.renderTree();
      b.renderProps();
      b.syncChrome();
      if (pending.allRef) {
        pending.allRef = false;
        actions.runAllRef?.();
      }
      unsubs = [
        c.store.subscribe(() => {
          b.renderTree();
          b.renderProps();
          c.session.pick.highlight?.(toPick(c.store.get().selection));
          b.syncChrome();
        }, ["selection", "checks", "verifying"]),
        // Picked-board projects open the buy card when the last checkpoint just passed (not on restore)
        c.store.subscribe(
          (s, prev) => {
            const n = c.work.checkpoints.length;
            if (!b.buyArmed) return;
            b.buyArmed = false;
            if (c.custom && n && passedCount(c, s) === n && passedCount(c, prev) < n) b.openBuy();
          },
          ["checks"],
        ),
        c.store.subscribe(
          (s, prev) => {
            b.recheckWiring();
            b.renderTree();
            // Rebuilding mid-drag would break slider drags; only edit changes (power, heat, rewire, rewind) redraw
            const h = s.hist,
              p = prev.hist;
            if (s.editRev !== prev.editRev && b.cardFor && c.shell.card.open) {
              const box = b.cardContent(b.cardFor);
              if (box)
                c.shell.card.show(
                  c.session.pick.project?.(b.cardFor) ?? { x: 0, y: 0 },
                  box,
                );
            }
            if (
              s.editRev !== prev.editRev ||
              s.sceneRev !== prev.sceneRev ||
              h.seeked !== p.seeked ||
              h.busy !== p.busy ||
              h.runs !== p.runs ||
              (h.seeked && h.cur !== p.cur) ||
              s.selection?.kind === "run"
            )
              b.renderProps();
          },
          ["editRev", "sceneRev", "hist"],
        ),
        c.store.subscribe(() => b.renderTree(), ["env", "run", "runNo"]),
        // Redraw the tree's wireless group only when BLE or phone state text changes; notifications arrive every second
        (() => {
          let label = "";
          return bleFeed.subscribe(() => {
            const bs = bleFeed.get();
            const l = `${bs.state}|${phoneStateText(bs)}`;
            if (l === label) return;
            label = l;
            b.renderTree();
            if (bs.state === 0 && c.store.get().selection?.kind === "ble") b.select(null);
          });
        })(),
        c.store.subscribe(
          () => b.updateLive(),
          [
            "simSeconds",
            "reading",
            "running",
            "run",
            "verifyProgress",
            "env",
            "pose",
            "imu",
            "touch",
          ],
        ),
      ];
      c.session.pick.highlight?.(toPick(c.store.get().selection));
    },
    unmount() {
      unsubs.forEach((u) => u());
      unsubs = [];
      b.closeCard();
      // The analyzer belongs to the bench: CSS hides it on leave (body[data-step]) and its state survives
      if (b.ruler) {
        b.ruler = null;
        b.ctx?.session.pick.measure?.(null);
      }
      b.meter = null;
      b.wiring = null;
      b.placing = null;
      for (const k of ["wire", "rings", "wrongWire", "meter", "empty", "place", "customPlaced", "buy"])
        overlay(k, null);
      setLeft({ lib: null, wires: null, wireCount: 0, card: null });
      b.ctx?.session.pick.highlight?.(null);
      actions.checkUpload = undefined;
      actions.openBuy = undefined;
      actions.runAllRef = undefined;
      b.ctx = null;
    },
  };
}
