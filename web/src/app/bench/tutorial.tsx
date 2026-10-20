// Bench section (F-04a): controls for DS18B20 / PIR / relay / photoresistor / RC522.
// PIR, light and card go through LiveSim.partInput, so they land in the input log as pir= / lux= / card=.
import { t } from "../../i18n";
import { Btn, Btns, Note, Sec, Slider } from "../../ui/panel";
import { outOf } from "./shared";
import type { BenchCtx } from "./ctx";
import { showRc522Card, type TutorialPart } from "../../bench3d/parts3d";
import { LDR_LUX_DEFAULT } from "../../partsdev.ts";

/** Sample cards: a 4-byte NUID and a 7-byte UID (same as the c3-rc522 accept script) */
export const RC522_CARDS = ["DEADBEEF", "04A1B2C3D4E5F6"];
/** PIR "wave": presence for this long, then the module's own hold time runs */
const WAVE_MS = 300;

// Last values set from the panel, so reopening the card shows them (reset when the sim reboots is not tracked)
let lux = LDR_LUX_DEFAULT;
let cardUid: string | null = null;

const big = "min-h-11 md:min-h-0";

export function tutorialControls(b: BenchCtx, p: TutorialPart) {
  const sim = () => b.ctx?.session.sim;
  if (p.type === "ds18b20") {
    return (
      <>
        <Sec>{t("Water / ambient temperature")}</Sec>
        {b.envSlider("temp", t("Ambient temperature"), -10, 45, 0.5)}
        <Note>{t("Probe i reads the ambient temperature + 0.5 ℃ × i. Conversion takes 750 ms at 12 bits, like the real chip. Confidence: simulation verified; not calibrated on real hardware.")}</Note>
      </>
    );
  }
  if (p.type === "pir") {
    const wave = () => {
      sim()?.partInput({ kind: "pir", on: true });
      setTimeout(() => sim()?.partInput({ kind: "pir", on: false }), WAVE_MS);
    };
    return (
      <>
        <Sec>{t("Motion")}</Sec>
        <Btns>
          <Btn primary className={big} data-pir="wave" onClick={wave}>
            {t("Wave")}
          </Btn>
          <Btn className={big} data-pir="1" onClick={() => sim()?.partInput({ kind: "pir", on: true })}>
            {t("Person stays")}
          </Btn>
          <Btn className={big} data-pir="0" onClick={() => sim()?.partInput({ kind: "pir", on: false })}>
            {t("Person leaves")}
          </Btn>
        </Btns>
        <Note>{t("OUT stays high for {s} s after the last motion (delay pot), retriggerable. The dome tints while OUT is high. The real module needs about a minute to settle after power-up (not simulated).", { s: p.hold ?? 5 })}</Note>
      </>
    );
  }
  if (p.type === "ldr") {
    const set = (v: number) => {
      lux = v;
      sim()?.partInput({ kind: "lux", lux: v });
      b.updateLive();
    };
    return (
      <>
        <Sec>{t("Light level")}</Sec>
        <Slider
          min={0}
          max={2000}
          step={1}
          defaultValue={lux}
          data-lux=""
          aria-label={t("Light level")}
          out={`${lux} lux`}
          on={{
            change: (e) => {
              const v = Number(e.currentTarget.value);
              outOf(e.currentTarget)!.textContent = `${v} lux`;
              set(v);
            },
          }}
        />
        <Btns>
          {[
            [2, t("Night")],
            [300, t("Room")],
            [1000, t("Daylight")],
          ].map(([v, name]) => (
            <Btn key={v} className={big} data-luxset={v} onClick={() => set(Number(v))}>
              {name} · {v}
            </Btn>
          ))}
        </Btns>
        <Note>{t("GL5528 with a 10 kΩ divider: the ADC voltage follows the light on a log curve. Rough light level only, not a calibrated lux meter.")}</Note>
      </>
    );
  }
  if (p.type === "rc522") {
    const tap = (uid: string | null) => {
      cardUid = uid;
      sim()?.partInput({ kind: "card", uid: uid ?? "none" });
      showRc522Card(uid);
      b.updateLive();
    };
    return (
      <>
        <Sec>{t("Card")}</Sec>
        <Btns>
          {RC522_CARDS.map((u) => (
            <Btn key={u} className={big} data-card={u} aria-pressed={cardUid === u} onClick={() => tap(u)}>
              {u}
            </Btn>
          ))}
          <Btn className={big} data-card="none" onClick={() => tap(null)}>
            {t("Take the card away")}
          </Btn>
        </Btns>
        <Note>{t("The reader answers REQA / anticollision / SELECT with the card UID. MIFARE authentication and block reads are not modelled. SPI pins are the firmware's; only SDA (CS) is checked.")}</Note>
      </>
    );
  }
  return (
    <Note>{t("The relay follows IN: the red LED on the module lights while the contacts are closed. Coil and contact bounce are not modelled.")}</Note>
  );
}
