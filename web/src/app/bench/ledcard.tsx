// Bench section: LED part card (H-13). Resistor value and lens colour live in the session scene's PartSpec,
// so changes go through applyScene (3D rebuild, H-09 filter, undo history, saved with the work).
import { t } from "../../i18n";
import { useEffect, useState, type ReactNode } from "react";
import { Kv, KvT, Muted, Note, Sec, Seg, SegB } from "../../ui/panel";
import { partId } from "../wiring";
import { ledCurrent } from "../faultsolve";
import { lessonSignal } from "../lessontasks";
import { LED_HEX, LED_OHMS, LED_OHM_DEFAULT, LED_VF, ledColor, ohmText, type LedColor } from "../../bench3d/ledparams";
import type { PartSpec } from "../../bench3d/spec";
import { ConfBadge } from "./ui";
import { EST } from "./shared";
import type { BenchCtx } from "./ctx";

type LedPart = Extract<PartSpec, { type: "led" }>;

const COLOR_NAME: Record<LedColor, () => string> = { red: () => t("Red"), green: () => t("Green"), blue: () => t("Blue") };
const segCls = "max-md:min-h-11";

/** Estimated current from the wasm elec solver (tb_fault kind 3); `data-ma` carries the raw number for tests. */
function LedMa({ ohm, vf, s3 }: { ohm: number; vf: number; s3: boolean }) {
  const [ma, setMa] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void ledCurrent(ohm, vf, s3).then((i) => live && setMa(i * 1000));
    return () => {
      live = false;
    };
  }, [ohm, vf, s3]);
  return (
    <KvT k={t("LED current")}>
      <span id="ledMa" data-ma={ma === null ? "" : ma.toFixed(3)} className="inline-flex flex-wrap items-center gap-1.5">
        <b className="font-mono">{ma === null ? "…" : `≈ ${ma.toFixed(2)} mA`}</b>
        <ConfBadge c={EST} />
      </span>
    </KvT>
  );
}

export function ledControls(b: BenchCtx, p: LedPart): ReactNode {
  const ses = b.ctx!.session;
  const id = partId(p);
  const ohm = p.ohm ?? LED_OHM_DEFAULT;
  const color = ledColor(p.color);
  const nores = (ses.wireMods.noResistor ?? []).includes(id);
  function apply(next: LedPart, label: string, sig: string, from: string) {
    const c = b.ctx!;
    const scene = c.session.scene;
    c.session.applyScene({ ...scene, parts: scene.parts.map((x) => (partId(x) === id ? next : x)) }, c.session.power ?? { ext5v: false }, label);
    b.recheckWiring();
    b.renderLeft();
    b.renderProps();
    lessonSignal(sig, from);
  }
  const setOhm = (v: number) => v !== ohm && apply({ ...p, ohm: v }, t("LED resistor {ohm} Ω", { ohm: ohmText(v) }), `prop:${id}.ohm=${v}`, String(ohm));
  const setColor = (k: LedColor) =>
    k !== color && apply({ ...p, color: LED_HEX[k] }, t("LED colour {color}", { color: COLOR_NAME[k]() }), `prop:${id}.color=${k}`, color);
  return (
    <div id="ledCard" data-ohm={ohm} data-color={color}>
      <Sec>{t("Series resistor")}</Sec>
      <Seg className="grid-cols-4" aria-label={t("Series resistor")}>
        {LED_OHMS.map((v) => (
          <SegB key={v} on={v === ohm} data-ohm={v} className={segCls} onClick={() => setOhm(v)}>
            {ohmText(v)} Ω
          </SegB>
        ))}
      </Seg>
      <Sec>{t("Color")}</Sec>
      <Seg className="grid-cols-3" aria-label={t("Color")}>
        {(Object.keys(LED_HEX) as LedColor[]).map((k) => (
          <SegB key={k} on={k === color} data-ledcolor={k} className={segCls} onClick={() => setColor(k)}>
            {COLOR_NAME[k]()}
          </SegB>
        ))}
      </Seg>
      <Sec>{t("Estimate at GPIO high")}</Sec>
      <Kv k={t("Forward voltage (knee)")} v={`${LED_VF[color].toFixed(1)} V`} />
      <LedMa ohm={nores ? 0 : ohm} vf={LED_VF[color]} s3={ses.chip === "esp32s3"} />
      {nores && <Muted>{t("The resistor is pulled out on the bench, so the LED sees the pin directly.")}</Muted>}
      <Note>
        {t("Estimate · not calibrated on real hardware. 3.3 V minus the LED drop, divided by the resistor plus the pin's output resistance; brightness on the bench follows this current. More resistance means less current and a dimmer LED; blue needs more voltage, so it gets less current from 3.3 V.")}
      </Note>
    </div>
  );
}
