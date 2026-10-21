// Bench section: Direct placement on the bench (P2-16).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { partId } from "../wiring";
import { overlay } from "../chrome";
import { buildPlaced, fixedPin, mergeMods, pinOk, placeConflict, placeDef, stepOk } from "../place";
import { LIB_DRAG, PinRings, PlaceBanner, type RingPin } from "./ui";
import type { BenchCtx } from "./ctx";

export function mountPlacing(b: BenchCtx) {
  function startPlace(id: string) {
    const c = b.ctx;
    if (!c || c.store.get().step !== "bench") return;
    const d = placeDef(id);
    if ("why" in d) return c.shell.toast(d.why);
    const clash = placeConflict(d, c.session.scene);
    if (clash) return c.shell.toast(clash);
    if (b.wiring) b.setWiring(false);
    if (b.ruler) b.setRuler(false);
    if (b.meter) b.setMeter(false);
    b.closeCard();
    overlay("wrongWire", null);
    b.placing = { def: d, cur: 0, got: {}, skipped: new Set() };
    overlay("empty", null);
    c.shell.toolbar.setActive("place");
    placeUi();
  }
  function endPlace() {
    b.placing = null;
    overlay("place", null);
    overlay("rings", null);
    if (b.ctx) b.renderTree();
    b.ctx?.shell.toolbar.setActive("select");
  }
  function placeUi() {
    const c = b.ctx!;
    const p = b.placing;
    if (!p) return endPlace();
    const step = p.def.steps[p.cur];
    overlay(
      "place",
      <PlaceBanner
        name={p.def.name}
        steps={p.def.steps}
        cur={p.cur}
        got={p.got}
        onStep={(i) => {
          if (!b.placing) return;
          b.placing.cur = i;
          b.placing.skipped.delete(b.placing.def.steps[i].pin);
          placeUi();
        }}
        onSkip={
          step.optional
            ? () => {
                if (!b.placing) return;
                b.placing.skipped.add(step.pin);
                delete b.placing.got[step.pin];
                placeNext();
              }
            : null
        }
        onBack={
          p.cur > 0
            ? () => {
                if (!b.placing) return;
                b.placing.cur--;
                placeUi();
              }
            : null
        }
        onCancel={() => {
          endPlace();
          c.shell.toast(t("{part} not placed", { part: p.def.name }));
        }}
      />,
    );
    const wires = b.benchWires().filter((x) => !x.missing);
    const pins: RingPin[] = (c.session.pick.listPins?.() ?? [])
      .filter((x) => stepOk(step, x.id, c.session.chip))
      .map((x) => ({
        ...x,
        used: [
          ...wires.filter((w) => w.a === x.id).map((w) => w.b),
          ...Object.entries(p.got)
            .filter(([k, v]) => v === x.id && k !== step.pin)
            .map(([k]) => `${p.def.name} ${k}`),
        ],
      }));
    overlay(
      "rings",
      <PinRings
        pins={pins}
        cur={p.got[step.pin] ?? null}
        project={b.ringProject}
        onPin={placePin}
      />,
    );
  }
  function placePin(id: string) {
    const c = b.ctx!;
    const p = b.placing;
    if (!p) return;
    const step = p.def.steps[p.cur];
    const fixed = fixedPin(step, c.session.chip);
    if (pinOk(step.want, id) && fixed && id !== fixed)
      return c.shell.toast(t("{pin} must go to {gpio}: the firmware drives this screen on fixed SPI2 pins", { pin: step.label, gpio: fixed }));
    if (!pinOk(step.want, id))
      return c.shell.toast(
        step.want === "gnd"
          ? t("{pin} must go to GND", { pin: step.label })
          : step.want === "power"
            ? t("{pin} must go to 3V3 or 5V", { pin: step.label })
            : t("{pin} must go to a GPIO", { pin: step.label }),
      );
    // Two signal lines of one part on the same GPIO (SDA tied to SCL) is meaningless: block it.
    const dup = Object.entries(p.got).find(([k, v]) => v === id && k !== step.pin);
    if (step.want === "gpio" && dup)
      return c.shell.toast(t("{gpio} is already wired to {pin} of {part}", { gpio: id, pin: dup[0], part: p.def.name }));
    p.got[step.pin] = id;
    placeNext();
  }
  function placeNext() {
    const p = b.placing;
    if (!p) return;
    const next = p.def.steps.findIndex(
      (s) => !p.got[s.pin] && !p.skipped.has(s.pin),
    );
    if (next >= 0) {
      p.cur = next;
      return placeUi();
    }
    finishPlace();
  }
  function finishPlace() {
    const c = b.ctx!;
    const p = b.placing!;
    const ext5v = !!c.session.power?.ext5v;
    const { spec, retarget } = buildPlaced(p.def, p.got, ext5v);
    const pid = partId(spec);
    if (c.session.scene.parts.some((x) => partId(x) === pid)) {
      // LEDs / buttons are keyed by pin: this GPIO already has one.
      const i = p.def.steps.findIndex((s) => s.want === "gpio");
      c.shell.toast(t("{gpio} already has a {part}: pick another GPIO", { gpio: p.got[p.def.steps[i].pin], part: p.def.name }));
      delete p.got[p.def.steps[i].pin];
      p.cur = i;
      return placeUi();
    }
    const sum = p.def.steps
      .filter((s) => p.got[s.pin] && s.want === "gpio")
      .map((s) => `${s.pin}→${p.got[s.pin]}`)
      .join(" ");
    endPlace();
    c.session.applyScene(
      { ...c.session.scene, parts: [...c.session.scene.parts, spec] },
      c.session.power ?? { ext5v: false },
      sum ? t("Place {part} ({pins})", { part: p.def.name, pins: sum }) : t("Place {part}", { part: p.def.name }),
    );
    const rt = Object.entries(retarget);
    if (rt.length)
      b.applyMods(
        mergeMods(c.session.wireMods, retarget),
        t("{part} power on {pins}", { part: p.def.name, pins: rt.map(([, v]) => v).join(", ") }),
      );
    b.recheckWiring();
    b.renderLeft();
    b.select({ kind: "part", id: pid });
    const fs = b.faults.filter((f) => f.wires.some((w) => w.includes(`~${pid}:`)));
    c.shell.toast(
      fs.length
        ? t("Placed {part}: wiring check found \"{issue}\", see the Issues tab", { part: p.def.name, issue: fs[0].title })
        : t("Placed {part}, wiring check found no problems", { part: p.def.name }),
    );
  }

  /** Stage drop target for the parts library (bound once). */
  function bindLibDrop() {
    // Parts library drops (P2-16) only accept the library drag type; .bin drops are handled elsewhere
    const stage = document.getElementById("stage");
    stage?.addEventListener("dragover", (e) => {
      if (!b.ctx || b.ctx.store.get().step !== "bench") return;
      if (!e.dataTransfer?.types.includes(LIB_DRAG)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    stage?.addEventListener("drop", (e) => {
      const id = e.dataTransfer?.getData(LIB_DRAG);
      if (!id || !b.ctx || b.ctx.store.get().step !== "bench") return;
      e.preventDefault();
      startPlace(id);
    });
  }

  b.startPlace = startPlace;
  b.endPlace = endPlace;
  b.placePin = placePin;
  b.bindLibDrop = bindLibDrop;
}

