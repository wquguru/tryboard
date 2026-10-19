// Bench section: Ruler (P0-13).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { type PickTarget } from "../../scene-api";
import { CHIP_HEAT_OFFSET } from "../../views/templates";
import { Btn, Btns, Kv, KvT, Note, Sec } from "../../ui/panel";
import type { BenchCtx } from "./ctx";

export function mountRuler(b: BenchCtx) {
  const pickName = (x: PickTarget) =>
    x.kind === "part"
      ? x.id === "board"
        ? t("Dev board chip")
        : b.partName(x.id)
      : x.id;
  function renderRuler() {
    const r = b.ruler;
    const drift =
      r?.mm != null &&
      r.a &&
      r.b &&
      [r.a.id, r.b.id].includes("bme280") &&
      [r.a.id, r.b.id].includes("board")
        ? driftText(r.mm)
        : "";
    b.show(
      <>
        <Sec>{t("Ruler")}</Sec>
        <Note>
          {t("Click two parts, pins or wires on the bench in turn; click again after measuring to start over. Click Select in the toolbar to exit.")}
        </Note>
        <Kv k={t("Start")} v={r?.a ? pickName(r.a) : t("Click the first target")} />
        <Kv k={t("End")} v={r?.b ? pickName(r.b) : r?.a ? t("Click the second target") : "—"} />
        <Kv
          k={t("Distance")}
          v={r?.mm != null ? `${r.mm.toFixed(1)} mm` : "—"}
          cls="fp"
        />
        {drift && <KvT k={t("Heat bias")}>{drift}</KvT>}
        <Btns>
          <Btn id="rulerChip" onClick={() => measureChip()}>
            {t("Measure BME280 to chip")}
          </Btn>
        </Btns>
      </>,
      false,
    );
  }
  /** Closer to the chip reads higher: same offset as Assemble (+2.5 ℃ touching), fading linearly to 0 at 30 mm (estimate). */
  const driftOf = (mm: number) =>
    Math.max(0, Math.min(1, (30 - mm) / 25)) * CHIP_HEAT_OFFSET;
  const driftText = (mm: number) => {
    const d = driftOf(mm);
    return d < 0.05
      ? t("{mm} mm from the chip: chip heating is negligible. Touching the chip (within 5 mm) reads about {d} ℃ high (estimate)", { mm: mm.toFixed(1), d: CHIP_HEAT_OFFSET })
      : t("{mm} mm from the chip: reads about {d} ℃ high from heat (estimate, not calibrated on real hardware)", { mm: mm.toFixed(1), d: d.toFixed(1) });
  };
  function measureChip(): number | null {
    const mm =
      b.ctx!.session.pick.measure?.(
        { kind: "part", id: "bme280" },
        { kind: "part", id: "board" },
      ) ?? null;
    if (b.ruler) {
      b.ruler = {
        a: { kind: "part", id: "bme280" },
        b: { kind: "part", id: "board" },
        mm,
      };
      b.renderProps();
    }
    return mm;
  }

  b.renderRuler = renderRuler;
  b.driftText = driftText;
  b.measureChip = measureChip;
}

