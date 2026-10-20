// Bench section: Part properties.
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { type ReactNode } from "react";
import { partId, partInfo } from "../wiring";
import { BOARD_NAME, BOOT_GPIO, CHIP_DESC, RGB_GPIO } from "../../chips";
import { Bad, Btn, Btns, Kv, KvT, Note, Ph, Sec, TreeEmpty } from "../../ui/panel";
import { type AnalogControl } from "../examples";
import { OledCanvas, PartHead } from "./shared";
import type { BenchCtx } from "./ctx";
import { AmoledCtrls, sceneBoard } from "./amoled";

export function mountPart(b: BenchCtx) {
  function renderPart(id: string) {
    const c = b.ctx!;
    const ses = c.session;
    if (id === "board") {
      const rgb = RGB_GPIO[ses.chip];
      const aio = !!sceneBoard(ses);
      b.show(
        <>
          <Sec>{t("Dev board")}</Sec>
          <PartHead
            name={aio ? sceneBoard(ses)!.name : BOARD_NAME[ses.chip]}
            type="board"
          />
          <Kv
            k={t("Chip")}
            v={CHIP_DESC[ses.chip]}
          />
          <Kv k={t("Power supply")} v={aio ? t("USB 5 V or the Li-ion battery, through the AXP2101 PMU") : t("USB 5 V stepped down to 3V3 by the LDO")} />
          <Kv k="3V3" live="e33" />
          <Kv k={t("3V3 total current (estimate)")} live="eic" />
          <Kv k={t("Brownout resets")} live="ers" />
          <Sec>{t("Live")}</Sec>
          <Kv k={t("Run")} live="run" />
          <Kv k={t("Simulated time")} live="sim" />
          {rgb !== null && !aio && <Kv k={t("On-board RGB (GPIO{n})", { n: rgb })} live="rgb" />}
          {aio && <AmoledCtrls ses={ses} />}
          <Btns>
            <Btn
              id="bootBtn"
              onPointerDown={() => ses.pressBoot(true)}
              onPointerUp={() => ses.pressBoot(false)}
              onPointerLeave={() => ses.pressBoot(false)}
            >
              {t("Press BOOT (GPIO{n})", { n: BOOT_GPIO[ses.chip] })}
            </Btn>
            <Btn id="rstBtn" onClick={() => ses.reboot()}>
              {t("RST power cycle")}
            </Btn>
          </Btns>
        </>,
      );
      return;
    }
    const p = ses.scene.parts.find(
      (x) => partId(x) === (id === "obstacle" ? "hcsr04" : id),
    );
    if (!p) {
      b.show(
        <>
          <Sec>{t("Part")}</Sec>
          <Ph mono>{id}</Ph>
          <TreeEmpty>{t("This part is not on the current bench")}</TreeEmpty>
        </>,
        false,
      );
      return;
    }
    // Echo divider removed (rewired): the interface text follows.
    const noDiv = (ses.wireMods.noDivider ?? []).includes("hcsr04");
    const info = partInfo(
      p.type === "hcsr04" && noDiv ? { ...p, divider: false } : p,
      !!ses.power?.ext5v,
    );
    let live: ReactNode = null;
    if (p.type === "bme280") {
      live = (
        <>
          <Sec>{t("Live reading · latest firmware serial line")}</Sec>
          <Kv k={t("Temperature")} live="rt" />
          <Kv k={t("Humidity")} live="rh" />
          <Kv k={t("Pressure")} live="rp" />
          <Sec>{t("Ambient temperature")}</Sec>
          {b.envSlider("temp", t("Ambient temperature"), -10, 45, 0.5)}
          <b.TempExact />
          <b.HeatActs />
          <Note>{t("Humidity and pressure are set under Environment in the build tree. Confidence: simulation verified.")}</Note>
        </>
      );
    } else if (p.type === "oled") {
      live = (
        <>
          <Sec>{t("Live image")}</Sec>
          <OledCanvas />
          <Kv k={t("Lit pixels")} live="oledn" />
        </>
      );
    } else if (p.type === "servo") {
      live = (
        <>
          <Sec>{t("Live")}</Sec>
          <Kv k={t("Pulse width")} live="pw" />
          <Kv k={t("Angle")} live="ang" />
        </>
      );
    } else if (p.type === "encoder") {
      live = (
        <>
          <Sec>{t("Live")}</Sec>
          {b.encRows()}
          <Sec>{t("Turn it")}</Sec>
          {b.encButtons()}
          <Note>
            {t("On the bench, drag the knob left/right or scroll to turn one step; hold to press. Confidence: simulation verified; contact bounce is not modeled.")}
          </Note>
        </>
      );
    } else if (p.type === "hcsr04") {
      live = (
        <>
          <Sec>{t("Live")}</Sec>
          {b.sonarRows()}
          <Sec>{t("Obstacle distance")}</Sec>
          {b.sonarControls()}
          <Note>
            {t("On the bench: hold the obstacle and drag it along the sensor axis (up to 100 cm in 3D, use the slider beyond). After a high pulse of 10 µs or more on Trig, Echo goes high 250 µs later; the high time is the round-trip distance divided by the 343 m/s speed of sound, measured in a straight line from sensor to obstacle. Speed of sound is fixed at 20 ℃, not calibrated on real hardware.")}
          </Note>
          <Sec>{t("Level")}</Sec>
          <KvT k="Echo">
            {p.divider === false || noDiv ? (
              <Bad>{t("5 V straight into the GPIO: S3 GPIOs are not 5 V tolerant and the pin can be damaged")}</Bad>
            ) : (
              t("Echo outputs 5 V, divided by 1 kΩ / 2 kΩ to about 3.3 V before the GPIO")
            )}
          </KvT>
          <Btns>
            <Btn data-div="" aria-pressed={!noDiv} onClick={b.toggleDivider}>
              {noDiv ? t("Refit divider resistors") : t("Remove divider resistors (see the wiring check alarm)")}
            </Btn>
          </Btns>
        </>
      );
    } else if (p.type === "mpu6050" || p.type === "qmi8658") {
      live = (
        <>
          <Sec>{t("Orientation · lift the breadboard")}</Sec>
          {b.poseSliders()}
          {b.levelBtn()}
          <Sec>{t("Sensor should read · gravity components")}</Sec>
          <Kv k="ax / ay / az" live="gacc" />
          <Sec>{t("Live reading · latest firmware serial line")}</Sec>
          <Kv k={t("Pitch")} live="ipitch" />
          <Kv k={t("Roll")} live="iroll" />
          <Kv k={t("Gyro")} live="igyro" />
          <Note>
            {t("You can also hold and drag this module in 3D and the whole bench turns; while dragging the gyro reads angular rate, returning to zero 150 ms after release. The accelerometer alone cannot give heading (yaw); yaw only affects the gyro. Confidence: behavioral model, registers per datasheet and readings computed from orientation; noise and bias must be confirmed on real hardware.")}
          </Note>
        </>
      );
    } else if (p.type === "pot") {
      const a = b.exInfo?.ex.controls?.find((k): k is AnalogControl => typeof k === "object" && k.type === "analog" && k.pin === p.pin);
      live = b.analogBox(a ?? { type: "analog", pin: p.pin, label: t("Potentiometer (GPIO{pin})", { pin: p.pin }), max_mv: 3300, value: 0 });
    } else if (
      p.type === "cst816s" ||
      (p.type === "gc9a01" && ses.scene.parts.some((x) => x.type === "cst816s"))
    ) {
      live = (
        <>
          <Sec>{t("Touch · tap or drag the round display in 3D")}</Sec>
          <Kv k={t("Finger")} live="tch" />
          <Kv k={t("INT level")} live="tint" />
          <Note>
            {t("Tap the screen to press, drag to move, release to lift; the chip detects gestures itself: tap, swipe, 1 s long press. Auto-sleep and scan noise of the real chip are not modeled; confirm on real hardware.")}
          </Note>
        </>
      );
    }
    b.show(
      <>
        <Sec>{t("Part")}</Sec>
        <PartHead name={info.name} type={p.type} />
        <KvT k={t("Model")}>{info.model}</KvT>
        <KvT k={t("Interface")}>{info.iface}</KvT>
        <Kv k={t("Power supply")} v={info.power} />
        {live}
        {p.type === "servo" && b.powerInline()}
      </>,
    );
  }

  b.renderPart = renderPart;
}

