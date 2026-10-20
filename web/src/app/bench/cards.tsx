// Bench section: quick cards (P0-04).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { afterFrame, onFrame, PRIO } from "../../ui/frame";
import { type ReactNode } from "react";
import { type PickTarget, type ScreenPoint } from "../../scene-api";
import { partId, partInfo } from "../wiring";
import { loadAnalyzer } from "../anaload";
import { extModelsOn, setExtModels } from "../../extmodels";
import { RECORD_SECONDS, recordCanvas, takePhoto } from "../capture";
import { Live } from "../../ui/native";
import { Kv, Meter, Mono, Note, Sec } from "../../ui/panel";
import { bc, overlay } from "../chrome";
import { isPhone, phoneProps, setMui } from "../mobile";
import { tn } from "./ui";
import { AmoledCtrls, sceneBoard } from "./amoled";
import type { BenchCtx } from "./ctx";
import { isTutorialPart } from "../../bench3d/parts3d";
import { tutorialControls } from "./tutorial";

export function mountCards(b: BenchCtx) {
  function cardContent(tg: PickTarget): ReactNode | null {
    const c = b.ctx!;
    if (tg.kind === "part" && tg.id === "bme280") {
      return (
        <div>
          <Sec>{t("BME280 · temperature / humidity / pressure")}</Sec>
          <Kv k={t("Reading")} live="rt" />
          {b.envSlider("temp", t("Ambient temperature"), -10, 45, 0.5)}
          <b.HeatActs />
        </div>
      );
    }
    if (tg.kind === "part" && (tg.id === "mpu6050" || tg.id === "qmi8658")) {
      return (
        <div>
          <Sec>{t("{chip} · tilt the bench", { chip: tg.id === "mpu6050" ? "MPU6050" : "QMI8658" })}</Sec>
          {b.poseSliders(b.POSE_AXES.slice(0, 2))}
          <Kv k={t("Firmware reading")} live="ipr" />
          {b.levelBtn()}
          <Note>{t("You can also drag the module to rotate it.")}</Note>
        </div>
      );
    }
    if (
      tg.kind === "part" &&
      (tg.id === "cst816s" ||
        (tg.id === "gc9a01" &&
          c.session.scene.parts.some((x) => x.type === "cst816s")))
    ) {
      return (
        <div>
          <Sec>{t("Touch round display · CST816S")}</Sec>
          <Kv k={t("Finger")} live="tch" />
          <Kv k={t("INT level")} live="tint" />
          <Note>{t("Tap or drag right on the 3D screen.")}</Note>
        </div>
      );
    }
    const isServoPower =
      (tg.kind === "wire" && /servo:VCC/.test(tg.id)) ||
      (tg.kind === "pin" &&
        tg.id === "5V" &&
        c.session.scene.parts.some((p) => p.type === "servo"));
    if (isServoPower) {
      return (
        <div>
          <Sec>
            {c.session.power?.ext5v
              ? t("Servo power · now external 5 V")
              : t("Servo power · now USB 5 V")}
          </Sec>
          {b.powerSeg(!!c.session.power?.ext5v)}
          <Kv k={t("5V rail")} live="e5" />
          <Kv k="3V3" live="e33" />
          <Kv k={t("Brownout resets")} live="ers" />
          <Note>
            {t("On USB alone, big servo sweeps pull 3V3 below the brownout threshold and the board resets.")}
          </Note>
        </div>
      );
    }
    if (tg.kind === "part" && tg.id === "encoder") {
      return (
        <div>
          <Sec>{t("EC11 encoder · drag or scroll to turn the knob")}</Sec>
          {b.encRows()}
          {b.encButtons()}
        </div>
      );
    }
    const tut = tg.kind === "part" ? c.session.scene.parts.find((p) => p.type === tg.id) : undefined;
    if (tut && isTutorialPart(tut)) {
      return (
        <div>
          <Sec>{partInfo(tut).name}</Sec>
          {tutorialControls(b, tut)}
        </div>
      );
    }
    if (tg.kind === "part" && (tg.id === "hcsr04" || tg.id === "obstacle")) {
      return (
        <div>
          <Sec>{t("HC-SR04 · drag the obstacle or the slider")}</Sec>
          {b.sonarRows()}
          {b.sonarControls()}
        </div>
      );
    }
    if (tg.kind === "button" && tg.id === "BOOT") {
      return (
        <div>
          <Sec>{t("BOOT button · GPIO{n}", { n: b.bootGpio() })}</Sec>
          {b.bootBtns()}
          <Note>{t("Weather station firmware: press once to switch between ℃ and ℉.")}</Note>
        </div>
      );
    }
    if (sceneBoard(c.session) && ((tg.kind === "part" && tg.id === "board") || (tg.kind === "button" && tg.id === "PWR"))) {
      return (
        <div>
          <Sec>{t("AMOLED board · battery, USB, PWR key")}</Sec>
          <AmoledCtrls ses={c.session} />
        </div>
      );
    }
    if (tg.kind === "part") {
      const p = c.session.scene.parts.find((x) => partId(x) === tg.id);
      return (
        <div>
          <Sec>{p ? partInfo(p).name : tg.id === "board" ? t("Dev board") : tg.id}</Sec>
        </div>
      );
    }
    return null;
  }
  function openCard(t: PickTarget, screen: ScreenPoint) {
    const c = b.ctx!;
    const box = cardContent(t);
    if (!box) {
      closeCard();
      return;
    }
    b.cardFor = t;
    c.shell.card.show(c.session.pick.project?.(t) ?? screen, box);
    b.updateLive();
    // The card follows its target as the bench rotates and closes once the target is out of view
    b.cardRaf?.();
    const follow = () => {
      if (!b.cardFor || !c.shell.card.open) return stopFollow();
      const p = c.session.pick.project?.(b.cardFor);
      if (!p) return closeCard();
      c.shell.card.place(p);
    };
    b.cardRaf = onFrame(follow, { priority: PRIO.ui });
  }
  function stopFollow() {
    b.cardRaf?.();
    b.cardRaf = null;
  }
  function closeCard() {
    stopFollow();
    b.cardFor = null;
    b.ctx?.shell.card.hide();
  }

  function onPick(tg: PickTarget | null, screen: ScreenPoint) {
    if (!b.ctx || b.ctx.store.get().step !== "bench") return;
    if (b.placing) {
      if (!tg) return;
      if (tg.kind === "pin") b.placePin(tg.id);
      else b.ctx.shell.toast(t("Click a blue pin on the dev board"));
      return;
    }
    if (b.wiring) {
      if (!tg) return;
      if (tg.kind === "wire") {
        if (!b.benchWires().some((w) => w.id === tg.id))
          return b.ctx.shell.toast(t("Both ends of this wire are on parts, so there is no dev board end to rewire"));
        b.wiring.wire = tg.id;
        b.ctx.session.pick.highlight?.(tg);
        b.wireUi();
      } else if (tg.kind === "pin" && b.wiring.wire) b.retarget(b.wiring.wire, tg.id);
      else
        b.ctx.shell.toast(
          b.wiring.wire ? t("Click a pin on the dev board (blue ring)") : t("First click the wire you want to rewire"),
        );
      return;
    }
    if (b.meter) {
      if (!tg) return;
      const id = b.meterTarget(tg);
      if (!id) {
        b.ctx.shell.toast(t("Multimeter: click a pin (power pin or GPIO) or a wire"));
        return;
      }
      b.meter = { target: id };
      if (b.ctx.store.get().selection?.kind !== "tool")
        b.select({ kind: "tool", id: "meter" });
      b.renderMeter();
      b.meterCard();
      b.cardFor = tg;
      b.ctx.shell.card.show(
        b.ctx.session.pick.project?.(tg) ?? screen,
        <div>
          <Sec>{tn("Multimeter · {pin}", { pin: <Mono>{id}</Mono> })}</Sec>
          <Meter sm />
          <Live as="p" k="mnote" className="note my-2 text-xs text-muted" />
        </div>,
      );
      b.updateLive();
      return;
    }
    if (b.ruler) {
      if (!tg) return;
      if (!b.ruler.a || b.ruler.b) b.ruler = { a: tg, b: null, mm: null };
      else {
        b.ruler.b = tg;
        b.ruler.mm = b.ctx.session.pick.measure?.(b.ruler.a, tg) ?? null;
      }
      if (!b.ruler.b) b.ctx.session.pick.measure?.(null);
      b.renderProps();
      return;
    }
    if (!tg) {
      closeCard();
      if (isPhone()) setMui({ props: false });
      return b.select(null);
    }
    b.select({ kind: tg.kind, id: tg.id });
    // Phones open the properties drawer instead of a card, which would cover most of the bench
    if (isPhone()) {
      closeCard();
      phoneProps();
    } else openCard(tg, screen);
  }

  function setRuler(on: boolean) {
    const c = b.ctx!;
    b.ruler = on ? { a: null, b: null, mm: null } : null;
    c.shell.toolbar.setActive(on ? "ruler" : "select");
    if (!on) c.session.pick.measure?.(null);
    closeCard();
    if (on) b.select({ kind: "tool", id: "ruler" });
    else if (c.store.get().selection?.kind === "tool") b.select(null);
  }

  function onTool(id: string) {
    if (!b.ctx || b.ctx.store.get().step !== "bench") return;
    const c = b.ctx;
    // On phones, wiring and measuring need the bench visible, so close the drawer first
    if ((id === "wire" || id === "meter" || id === "ruler") && isPhone())
      setMui({ props: false, more: false });
    if (b.placing && id !== "place" && /^(select|orbit|wire|meter|ruler)$/.test(id))
      b.endPlace();
    if (id === "place") {
      if (b.placing) {
        b.endPlace();
        return;
      }
      c.shell.toolbar.setActive("select");
      c.shell.toast(t("Drag a part from the Parts library onto the bench, or click its Place button"));
      (document.querySelector('[data-left="lib"]') as HTMLElement | null)?.click();
      afterFrame(() =>
        (document.querySelector("#partLib input") as HTMLInputElement | null)?.focus(),
      );
      return;
    }
    if (id === "select" || id === "orbit") {
      if (b.ruler) setRuler(false);
      if (b.meter) b.setMeter(false);
      if (b.wiring) b.setWiring(false);
      c.shell.toolbar.setActive(id);
    } else if (id === "wire") {
      const sel = c.store.get().selection;
      b.setWiring(
        !b.wiring,
        sel?.kind === "wire" && b.benchWires().some((w) => w.id === sel.id)
          ? sel.id
          : null,
      );
    } else if (id === "ruler") {
      if (b.meter) b.setMeter(false);
      if (b.wiring) b.setWiring(false);
      setRuler(!b.ruler);
    } else if (id === "meter") b.setMeter(!b.meter);
    else if (id === "heat") b.toggleHeat();
    else if (id === "scope") void loadAnalyzer(c).then((a) => a.toggle());
    else if (id === "ext") {
      // External models (P1-09): KiCad / Adafruit glb for servo, USB-C and buzzer; procedural by default, credits on the licenses page
      const on = !extModelsOn();
      setExtModels(on);
      c.shell.toolbar.setLabel("ext", on ? t("3D models: on") : t("3D models: off"));
      c.shell.toast(
        on
          ? t("External models: servo, USB-C port and buzzer use KiCad / Adafruit 3D models (credits on the third-party licenses page)")
          : t("External models off: everything is back to procedural models"),
      );
    } else if (id === "photo") {
      // Photo (P2-10): a 2× still of the current bench view
      void takePhoto(
        c.session.bench.capture(),
        `${c.work.id}-bench`,
        t("{title} · Bench", { title: t(c.work.title) }),
      )
        .then((r) =>
          c.shell.toast(t("Downloaded {name} ({w}×{h})", { name: r.name, w: r.width, h: r.height })),
        )
        .catch((e) => c.shell.toast(t("Photo failed: {err}", { err: String(e) })));
    } else if (id === "rec") {
      if (b.benchRec) return b.benchRec.stop();
      try {
        const r = recordCanvas(
          c.session.bench.capture().renderer.domElement,
          `${c.work.id}-bench`,
          c.session.audio.recordStream(),
        );
        b.benchRec = r;
        setRecLabel(t("Stop {n}/{max} s", { n: 0, max: RECORD_SECONDS }));
        const tick = setInterval(
          () =>
            b.benchRec === r &&
            setRecLabel(
              t("Stop {n}/{max} s", { n: Math.min(RECORD_SECONDS, r.elapsed()).toFixed(0), max: RECORD_SECONDS }),
            ),
          500,
        );
        void r.done
          .then((v) =>
            b.ctx?.shell.toast(
              v.audio
                ? t("Downloaded {name} ({kb} KB, with sound)", { name: v.name, kb: (v.bytes / 1024).toFixed(0) })
                : t("Downloaded {name} ({kb} KB)", { name: v.name, kb: (v.bytes / 1024).toFixed(0) }),
            ),
          )
          .catch((e) => b.ctx?.shell.toast(t("Recording failed: {err}", { err: String(e) })))
          .finally(() => {
            clearInterval(tick);
            if (b.benchRec === r) b.benchRec = null;
            setRecLabel(t("Record"));
          });
      } catch (e) {
        c.shell.toast(t("Recording failed: {err}", { err: String(e) }));
      }
    } else if (id === "button") {
      c.session.pressBoot(true);
      setTimeout(() => c.session.pressBoot(false), 150);
      c.shell.toast(t("Pressed BOOT once (GPIO{n})", { n: b.bootGpio() }));
    } else c.shell.toast(t("This tool is not available yet"));
  }

  /** Window keydown for tool shortcuts (bound once). */
  function bindShortcuts() {
    // Tool shortcuts (toolbar badges) skip text inputs; Esc leaves the current tool first
    window.addEventListener("keydown", (e) => {
      if (
        !b.ctx ||
        b.ctx.store.get().step !== "bench" ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      if (
        (e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]",
        )
      )
        return;
      const k = e.key.toLowerCase();
      if (k === "escape") {
        if (b.placing) {
          const n = b.placing.def.name;
          b.endPlace();
          b.ctx.shell.toast(t("Did not place {name}", { name: n }));
        } else if (bc.get().overlays.wrongWire) overlay("wrongWire", null);
        else if (b.wiring) b.setWiring(false);
        else if (b.ruler) setRuler(false);
        else if (b.meter) b.setMeter(false);
        return;
      }
      const tool = (
        {
          v: "select",
          h: "orbit",
          w: "wire",
          m: "meter",
          r: "ruler",
        } as Record<string, string>
      )[k];
      if (tool) onTool(tool);
    });
  }
  const setRecLabel = (s: string) => b.toolbarRef?.setLabel("rec", s);

  b.cardContent = cardContent;
  b.closeCard = closeCard;
  b.onPick = onPick;
  b.setRuler = setRuler;
  b.onTool = onTool;
  b.bindShortcuts = bindShortcuts;
}

