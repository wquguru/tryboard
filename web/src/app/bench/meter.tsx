// Bench section: Multimeter (P1-04).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { type PickTarget } from "../../scene-api";
import { meterVolts } from "../pinscope";
import { Live } from "../../ui/native";
import { Btn, Btns, Kv, Meter, Mono, Ph, Sec } from "../../ui/panel";
import { overlay } from "../chrome";
import { MeterCard } from "../benchv2";
import type { BenchCtx } from "./ctx";

export function mountMeter(b: BenchCtx) {
  function renderMeter() {
    const m = b.meter;
    const pickPin = (pin: string) => {
      b.meter = { target: pin };
      renderMeter();
      meterCard();
    };
    b.show(
      <>
        <Sec>{t("Multimeter · DC voltage")}</Sec>
        <Ph>
          {m?.target ? (
            <>
              <Mono>{m.target}</Mono> {t("to GND")}
            </>
          ) : (
            t("Click a pin on the bench")
          )}
        </Ph>
        <Meter />
        <Live
          as="p"
          k="mnote"
          init={t("Black probe on GND, red probe on a power or signal pin. Readings are estimates.")}
          className="note my-2 text-xs text-muted"
        />
        <Kv k={t("3V3 minimum (this power-on)")} live="emin" />
        <Kv k={t("Brownout resets")} live="ers" />
        <Btns>
          <Btn data-mpin="3V3" onClick={() => pickPin("3V3")}>
            {t("Measure 3V3")}
          </Btn>
          <Btn data-mpin="5V" onClick={() => pickPin("5V")}>
            {t("Measure 5V")}
          </Btn>
          {b.ctx!.session.scene.parts.some((p) => p.type === "servo") && (
            <Btn data-mpin="servo:VCC" onClick={() => pickPin("servo:VCC")}>
              {t("Measure servo red wire")}
            </Btn>
          )}
        </Btns>
      </>,
    );
  }
  function setMeter(on: boolean) {
    const c = b.ctx!;
    if (on && b.ruler) b.setRuler(false);
    if (on && b.wiring) b.setWiring(false);
    b.meter = on ? { target: b.meter?.target ?? null } : null;
    meterCard();
    c.shell.toolbar.setActive(on ? "meter" : "select");
    b.closeCard();
    if (on) b.select({ kind: "tool", id: "meter" });
    else if (c.store.get().selection?.kind === "tool") b.select(null);
  }
  /** Pinned multimeter card (bench bottom-right); updateLive fills the reading. */
  function meterCard() {
    overlay(
      "meter",
      b.meter ? (
        <MeterCard target={b.meter.target} onClose={() => setMeter(false)} />
      ) : null,
    );
    if (b.meter) b.updateLive();
  }
  /** Pick → probed node (a wire maps to its dev-board end; the servo red wire is its own node). */
  function meterTarget(t: PickTarget): string | null {
    if (t.kind === "pin") return t.id;
    if (t.kind === "wire") {
      if (/servo:VCC/.test(t.id)) return "servo:VCC";
      return b.benchWires().find((w) => w.id === t.id)?.a ?? null;
    }
    return null;
  }
  function meterReading() {
    const c = b.ctx!;
    const id = b.meter?.target;
    if (!id) return null;
    return meterVolts(
      id,
      c.session.frame.elec,
      c.session.frame,
      !!c.session.power?.ext5v,
    );
  }

  b.renderMeter = renderMeter;
  b.setMeter = setMeter;
  b.meterCard = meterCard;
  b.meterTarget = meterTarget;
  b.meterReading = meterReading;
}

