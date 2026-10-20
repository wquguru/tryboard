// Bench section: Pins (P0-11).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { partId, partInfo } from "../wiring";
import { pinKind, powerVolts } from "../pinscope";
import { BOOT_GPIO } from "../../chips";
import { loadAnalyzer } from "../anaload";
import { Live } from "../../ui/native";
import { Btn, Btns, Kv, KvT, Note, Ph, Sec } from "../../ui/panel";
import { AmoledCtrls } from "./amoled";
import type { BenchCtx } from "./ctx";

export function mountPins(b: BenchCtx) {
  function renderPin(id: string) {
    const c = b.ctx!;
    const pin = c.session.pick.listPins?.().find((p) => p.id === id);
    const wires = b.benchWires().filter((w) => w.a === id && !w.missing);
    const kind = pinKind(id, wires);
    const gpio = /^GPIO(\d+)$/.exec(id);
    b.trace.watch(gpio ? Number(gpio[1]) : -1);
    const to = wires.map((w) => `${partName(w.part)} · ${w.pin}`).join("; ");
    const fs = b.faults.filter((f) =>
      f.wires.some((x) => wires.some((w) => w.id === x)),
    );
    b.show(
      <>
        <Sec>{t("Pin")}</Sec>
        <Ph mono>{id}</Ph>
        <Kv k={t("Silkscreen")} v={pin?.label ?? id} />
        <Kv k={t("Role")} v={pin?.role ?? (wires[0]?.role || t("Nothing connected"))} />
        {to && <KvT k={t("Connected to")}>{to}</KvT>}
        <Sec>{t("Live values")}</Sec>
        {kind === "gpio" ? (
          <>
            <Kv k={t("Direction")} live="pdir" />
            <Kv k={t("Level")} live="plv" />
            <Kv k={t("PWM frequency")} live="pf" />
            <Kv k={t("Pulse width")} live="pw2" />
            <Kv k={t("Duty cycle")} live="pd" />
          </>
        ) : kind === "i2c" ? (
          <>
            <Kv
              k={t("I2C role")}
              v={wires
                .map(
                  (w) =>
                    `${w.pin === "SDA" ? t("SDA data") : t("SCL clock")} → ${partName(w.part)}`,
                )
                .join("; ")}
            />
            <Kv k={t("Level")} live="plv" />
            <Kv k={t("Bus")} v={t("Open drain, pulled up to 3V3 on the module")} />
          </>
        ) : (
          <>
            <Kv
              k={t("Voltage")}
              live="pv"
              v={powerVolts(id, !!c.session.power?.ext5v, c.session.frame.elec)}
            />
            {id === "3V3" && <Kv k={t("Minimum (this power-on)")} live="emin" />}
            <Kv k={t("Confidence")} v={t("Estimate")} />
          </>
        )}
        <Sec>{t("Oscilloscope")}</Sec>
        <canvas
          className="scope block h-24 w-full rounded-md border border-line bg-(--scope-bg)"
          data-live="scope"
          width={280}
          height={96}
          aria-label={t("{pin} waveform", { pin: id })}
        />
        <Live as="p" k="scopeNote" className="note my-2 text-xs text-muted" />
        {(kind === "gpio" || kind === "i2c") && (
          <>
            <Btns>
              <Btn data-ana={id} onClick={() => void loadAnalyzer(c).then((a) => a.open(id))}>
                {t("Open in analyzer")}
              </Btn>
            </Btns>
            <Note>
              {kind === "i2c"
                ? t("The logic analyzer decodes I2C transactions (start, address, every byte and ACK) with register notes.")
                : t("The logic analyzer shows level changes and PWM duty and frequency, accurate to the clock cycle.")}
            </Note>
          </>
        )}
        {fs.length > 0 && (
          <>
            <Sec>{t("Wiring check")}</Sec>
            {fs.map(b.faultEl)}
          </>
        )}
      </>,
    );
  }
  /** GPIO behind the BOOT key: GPIO9 on C3, GPIO0 on ESP32 / S3. */
  const bootGpio = () => BOOT_GPIO[b.ctx!.session.chip];
  const partName = (pid: string) => {
    const p = b.ctx!.session.scene.parts.find((x) => partId(x) === pid);
    return p ? partInfo(p).name : pid;
  };

  /** Press / release BOOT: the buttons' pressed state is set directly (no panel redraw). */
  const pressBootBtn = (
    e: React.MouseEvent<HTMLButtonElement>,
    down: boolean,
  ) => {
    b.ctx!.session.pressBoot(down);
    e.currentTarget
      .parentElement!.querySelectorAll<HTMLButtonElement>("[data-boot]")
      .forEach((x) =>
        x.setAttribute(
          "aria-pressed",
          String((x.dataset.boot === "down") === down),
        ),
      );
    b.ctx!.shell.toast(
      down
        ? t("BOOT pressed (GPIO{n} to ground); click Release to let go", { n: bootGpio() })
        : t("BOOT released"),
    );
  };
  const bootBtns = () => (
    <Btns>
      <Btn data-boot="down" onClick={(e) => pressBootBtn(e, true)}>
        {t("Press")}
      </Btn>
      <Btn data-boot="up" onClick={(e) => pressBootBtn(e, false)}>
        {t("Release")}
      </Btn>
    </Btns>
  );

  function renderButton(id: string) {
    const c = b.ctx!;
    if (id === "PWR") {
      b.show(
        <>
          <Sec>{t("Button")}</Sec>
          <Ph mono>PWR</Ph>
          <Kv k={t("Wired to")} v={t("AXP2101 PWRON (not a GPIO); held ≥ 1 s = long press")} />
          <AmoledCtrls ses={c.session} />
        </>,
        false,
      );
      return;
    }
    b.show(
      <>
        <Sec>{t("Button")}</Sec>
        <Ph mono>{id}</Ph>
        <Kv
          k={t("Wired to")}
          v={id === "BOOT" ? t("GPIO{n}, grounded when pressed", { n: bootGpio() }) : t("EN, power cycles on release")}
        />
        {id === "BOOT" ? (
          bootBtns()
        ) : (
          <Btns>
            <Btn id="rstBtn" onClick={() => c.session.reboot()}>
              {t("Press RST")}
            </Btn>
          </Btns>
        )}
      </>,
      false,
    );
  }

  b.renderPin = renderPin;
  b.bootGpio = bootGpio;
  b.partName = partName;
  b.bootBtns = bootBtns;
  b.renderButton = renderButton;
}

