// Bench section: heat source / measured at the chip (P0-04).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import type { BenchCtx } from "./ctx";

export function mountHeat(b: BenchCtx) {
  /** Heat source: room temperature before it was placed (restored on removal). */
  let heatRoom: number | null = null;

  function toggleHeat() {
    const c = b.ctx!;
    if (!c.session.scene.parts.some((p) => p.type === "bme280")) {
      c.shell.toast(t("No BME280 on the bench, so the heat source has no sensor to approach"));
      return;
    }
    const on = !c.session.heat;
    const room = c.store.get().env.temp;
    const temp = on ? room + 8 : (heatRoom ?? room - 8);
    heatRoom = on ? room : null;
    c.hist?.op({
      k: "heat",
      part: on ? "bme280" : null,
      env: { ...c.store.get().env, temp },
    });
    c.session.setEnv({ temp });
    c.session.setHeat(on ? "bme280" : null);
    c.shell.toast(
      on
        ? t("Heat source next to the BME280: air around the sensor goes from {from} °C to {to} °C (illustrative, a fixed +8 °C)", { from: room.toFixed(1), to: temp.toFixed(1) })
        : t("Heat source removed: back to {to} °C", { to: temp.toFixed(1) }),
    );
  }

  b.toggleHeat = toggleHeat;
}

