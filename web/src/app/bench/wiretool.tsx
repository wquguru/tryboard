// Bench section: Wire tool (U-04): rewire the dev-board end of a wire.
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { type WireMods } from "../wiring";
import { type WireFault } from "../wirecheck";
import { confLabel, confOfRule, ruleBasisLabel } from "../../ui/conf";
import { actions, bc, overlay } from "../chrome";
import { PinRings, WireBanner, WrongWireCard, type RingPin } from "./ui";
import { toPick } from "./shared";
import type { BenchCtx } from "./ctx";

export function mountWireTool(b: BenchCtx) {
  function wireUi() {
    const c = b.ctx!;
    if (!b.wiring) {
      overlay("wire", null);
      overlay("rings", null);
      return;
    }
    const w = b.wiring.wire
      ? b.benchWires().find((x) => x.id === b.wiring!.wire)
      : null;
    const pickable = b.benchWires().filter((x) => !x.missing);
    overlay(
      "wire",
      <WireBanner
        wire={w ? t("{wire} (now {pin})", { wire: w.b, pin: w.a }) : null}
        onCancel={() => setWiring(false)}
        wires={pickable.map((x) => ({ id: x.id, label: `${x.b} · ${x.a}` }))}
        onWire={(id) => {
          if (!b.wiring) return;
          b.wiring.wire = id;
          c.session.pick.highlight?.({ kind: "wire", id });
          wireUi();
        }}
        onUndo={bc.get().undo && actions.undo ? () => actions.undo?.() : null}
      />,
    );
    if (!w) return overlay("rings", null);
    const wires = b.benchWires().filter((x) => !x.missing);
    const pins: RingPin[] = (c.session.pick.listPins?.() ?? []).map((p) => ({
      ...p,
      used: wires.filter((x) => x.a === p.id && x.id !== w.id).map((x) => x.b),
    }));
    overlay(
      "rings",
      <PinRings
        pins={pins}
        cur={w.a}
        project={ringProject}
        onPin={(id) => retarget(w.id, id)}
      />,
    );
  }
  const ringProject = (id: string) =>
    b.ctx?.session.pick.project?.({ kind: "pin", id }) ?? null;
  function setWiring(on: boolean, wire: string | null = null) {
    const c = b.ctx!;
    if (on) {
      if (b.ruler) b.setRuler(false);
      if (b.meter) b.setMeter(false);
      b.closeCard();
    }
    b.wiring = on ? { wire } : null;
    c.shell.toolbar.setActive(on ? "wire" : "select");
    if (on && wire) c.session.pick.highlight?.({ kind: "wire", id: wire });
    else if (!on) c.session.pick.highlight?.(toPick(c.store.get().selection));
    wireUi();
  }
  /** Record a rewire in the timeline (no power cycle: the sim keeps scene wiring; only bench and wiring check change). */
  function applyMods(mods: WireMods, label: string) {
    const c = b.ctx!;
    c.hist?.op({ k: "wiring", mods, scene: c.session.scene, label });
    c.session.setWireMods(mods);
    b.recheckWiring();
  }
  function retarget(wireId: string, to: string) {
    const c = b.ctx!;
    const prev = c.session.wireMods;
    const w = b.benchWires().find((x) => x.id === wireId);
    if (!w) return;
    const orig = w.from ?? w.a;
    // An unplugged wire (H-05 "wire it yourself") goes back in wherever the user clicks, its own pin included
    const plug = !!w.missing && (prev.drop ?? []).includes(wireId);
    if (to === w.a && !plug) {
      c.shell.toast(t("{wire} is already on {pin}", { wire: w.b, pin: to }));
      return;
    }
    const rt = { ...prev.retarget };
    if (to === orig) delete rt[wireId];
    else rt[wireId] = to;
    if (plug) applyMods({ ...prev, retarget: rt, drop: prev.drop!.filter((x) => x !== wireId) }, t("Plug {wire} into {pin}", { wire: w.b, pin: to }));
    else applyMods({ ...prev, retarget: rt }, t("Rewire {wire} to {pin}", { wire: w.b, pin: to }));
    setWiring(false);
    b.select({ kind: "wire", id: wireId });
    const fs = b.faults.filter((f) => f.wires.includes(wireId));
    if (!fs.length) {
      c.shell.toast(
        to === orig
          ? t("{wire} back on {pin}, wiring check found no problems", { wire: w.b, pin: to })
          : t("{wire} rewired to {pin}, wiring check found no problems (the simulator still runs the original wiring)", { wire: w.b, pin: to }),
      );
      return;
    }
    showWrongWire(
      fs[0],
      wireId,
      `${w.b}: ${w.a} → ${to}`,
      () => {
        applyMods(prev, t("Undo rewire of {wire}", { wire: w.b }));
      },
      () => {
        applyMods(prev, t("Undo rewire of {wire}", { wire: w.b }));
        setWiring(true, wireId);
      },
    );
  }
  /** Wrong-wire card (U-04); redrawn with the same wire's new result when the async net estimate arrives (P2-14). */
  function showWrongWire(
    first: WireFault,
    wireId: string,
    label: string,
    undo: () => void,
    retry: () => void,
  ) {
    const close = () => {
      b.wwShow = null;
      overlay("wrongWire", null);
    };
    const show = (f: WireFault) =>
      overlay(
        "wrongWire",
        <WrongWireCard
          title={f.title}
          detail={f.detail}
          wire={label}
          estimate={f.estimate}
          sim={t("Confidence: {conf} ({basis}). The simulator still runs the original wiring; this is only a wiring check.", { conf: confLabel(confOfRule(f.confidence)), basis: ruleBasisLabel(f.confidence) })}
          onUndo={() => {
            close();
            undo();
          }}
          onRetry={() => {
            close();
            retry();
          }}
          onKeep={close}
        />,
      );
    b.wwShow = () => {
      const f = b.faults.find(
        (x) => x.wires.includes(wireId) && x.rule === first.rule,
      );
      if (f) show(f);
    };
    show(first);
  }

  b.wireUi = wireUi;
  b.ringProject = ringProject;
  b.setWiring = setWiring;
  b.applyMods = applyMods;
  b.retarget = retarget;
  b.showWrongWire = showWrongWire;
}

