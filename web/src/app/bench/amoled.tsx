// Board controls of the AMOLED all-in-one board (E-03): AXP2101 battery, USB plug and the PWR key.
// Each control sends one input event on commit, so the input log replays the same in the CLI.
import { t } from "../../i18n";
import { useState } from "react";
import { Btn, Btns, Kv, Note, Slider } from "../../ui/panel";
import { modelBoard } from "../../bench3d/boarddevs";
import { type NEv, outOf } from "./shared";
import type { Session } from "../types";

/** The scene's all-in-one board with an AXP2101 panel (E-03), if any; M5 presets have none */
export const sceneBoard = (ses: Session) => modelBoard(ses.scene.board);

export function AmoledCtrls({ ses }: { ses: Session }) {
  const def = sceneBoard(ses)?.battery ?? { pct: 98, usb: true };
  const cur = ses.battery ?? def;
  const [usb, setUsb] = useState(cur.usb);
  const pct = () => ses.battery?.pct ?? def.pct;
  return (
    <>
      <Kv k={t("Power management")} v="AXP2101 · I2C 0x34" />
      <Slider
        min={0}
        max={100}
        step={1}
        defaultValue={cur.pct}
        data-act="battery"
        aria-label={t("Battery level")}
        out={`${cur.pct} %`}
        on={{
          input: (e: NEv) => void (outOf(e.currentTarget)!.textContent = `${e.currentTarget.value} %`),
          // Logged once per release, not per drag tick
          change: (e: NEv) => ses.setBattery(Number(e.currentTarget.value), usb),
        }}
      />
      <Btns>
        <Btn
          data-act="usb"
          aria-pressed={usb}
          onClick={() => {
            setUsb(!usb);
            ses.setBattery(pct(), !usb);
          }}
        >
          {usb ? t("Unplug USB") : t("Plug in USB")}
        </Btn>
        <Btn data-act="pwr-short" onClick={() => ses.pwrKey(false)}>
          {t("PWR short press")}
        </Btn>
        <Btn data-act="pwr-long" onClick={() => ses.pwrKey(true)}>
          {t("PWR long press")}
        </Btn>
      </Btns>
      <Note>
        {t("Touch: tap the square screen. The ES8311 / ES7210 audio codecs only answer ID reads; no sound is simulated.")}
      </Note>
    </>
  );
}
