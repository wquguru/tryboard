// Bench section: Encoder / ultrasonic (P2-01 / P2-04).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { useState } from "react";
import { type BenchStep } from "../history";
import { Btn, Btns, Kv, KvBox, Slider } from "../../ui/panel";
import { type NEv, outOf } from "./shared";
import type { BenchCtx } from "./ctx";
import { ScenHint } from "./scenhint";

export function mountEncoder(b: BenchCtx) {
  const encRows = () => (
    <>
      <Kv k={t("Knob position")} live="encpos" />
      <Kv k={t("PCNT count (unit 0)")} live="pcnt" />
      <Kv k={t("Firmware reading")} live="encfw" />
    </>
  );
  const turn = (n: number) => {
    const c = b.ctx!;
    c.session.turnEncoder(n);
    c.session.bench.setEncoder((c.session.frame.pins?.encPos ?? 0) + n);
  };
  const encRelease = (btn: HTMLButtonElement) => {
    if (btn.getAttribute("aria-pressed") !== "true") return;
    b.ctx!.session.pressEncoder(false);
    btn.setAttribute("aria-pressed", "false");
  };
  const encButtons = () => (
    <Btns>
      <Btn data-enc="-1" onClick={() => turn(-1)}>
        {t("Counterclockwise 1 step")}
      </Btn>
      <Btn data-enc="1" onClick={() => turn(1)}>
        {t("Clockwise 1 step")}
      </Btn>
      <Btn data-enc="5" onClick={() => turn(5)}>
        {t("Clockwise 5 steps")}
      </Btn>
      <Btn
        data-encsw="hold"
        onPointerDown={(e) => {
          b.ctx!.session.pressEncoder(true);
          e.currentTarget.setAttribute("aria-pressed", "true");
        }}
        onPointerUp={(e) => encRelease(e.currentTarget)}
        onPointerLeave={(e) => encRelease(e.currentTarget)}
      >
        {t("Hold the knob")}
      </Btn>
    </Btns>
  );
  const sonarRows = () => (
    <>
      <Kv k={t("Set distance")} live="dist" />
      <Kv k={t("Last Echo")} live="echo" />
      <Kv k={t("Triggers")} live="pings" />
      <Kv k={t("Firmware reading")} live="sonfw" />
    </>
  );
  const sonarControls = () => {
    const d = b.ctx!.session.distance;
    const set = (v: number) => {
      b.ctx!.session.setDistance(v);
      b.updateLive();
    };
    return (
      <>
        <ScenHint k="dist" />
        <Slider
          min={2}
          max={400}
          step={0.5}
          defaultValue={d < 0 ? 400 : d}
          data-dist=""
          aria-label={t("Obstacle distance")}
          out={d < 0 ? t("No obstacle") : `${d.toFixed(1)} cm`}
          on={{
            input: (e) => {
              const v = Number(e.currentTarget.value);
              outOf(e.currentTarget)!.textContent = `${v.toFixed(1)} cm`;
              b.ctx!.session.setDistance(v);
            },
          }}
        />
        <Btns>
          {[10, 50, 200].map((v) => (
            <Btn key={v} data-distset={v} onClick={() => set(v)}>
              {v} cm
            </Btn>
          ))}
          <Btn data-distset="-1" onClick={() => set(-1)}>
            {t("Remove obstacle")}
          </Btn>
        </Btns>
      </>
    );
  };
  function toggleDivider() {
    const c = b.ctx!;
    const off = (c.session.wireMods.noDivider ?? []).includes("hcsr04");
    const mods = { ...c.session.wireMods, noDivider: off ? [] : ["hcsr04"] };
    c.hist?.op({
      k: "wiring",
      mods,
      scene: c.session.scene,
      label: off ? t("Refit Echo divider resistors") : t("Remove Echo divider resistors"),
    });
    c.session.setWireMods(mods);
    c.shell.toast(
      off
        ? t("Echo goes through a 1k/2k divider, about 3.3 V into the GPIO")
        : t("Echo 5 V goes straight into the GPIO; the wiring check reports \"5 V into GPIO\""),
    );
  }
  /** Latest reading line on serial (print format: firmware/s3-encoder, s3-ultrasonic). */
  const lastLine = (re: RegExp) => {
    const t = b.ctx!.session.consoleText().slice(-3000);
    let m: RegExpExecArray | null = null;
    for (const x of t.matchAll(re)) m = x;
    return m;
  };

  /** Env sliders (inspector, quick card): one gesture = one step, recorded on first input and updated until release. */
  const gestures = new WeakMap<HTMLInputElement, BenchStep>();
  const fmtEnv: Record<string, (v: number) => string> = {
    temp: (v) => `${v.toFixed(1)} °C`,
    humidity: (v) => `${v.toFixed(0)} %`,
    pressure: (v) => `${(v / 100).toFixed(1)} hPa`,
  };
  const envOn = (k: "temp" | "humidity" | "pressure") => ({
    input: (e: NEv) => {
      const c = b.ctx!;
      const inp = e.currentTarget;
      const v = Number(inp.value);
      outOf(inp)!.textContent = fmtEnv[k](v);
      const env = { ...c.store.get().env, [k]: v };
      let st = gestures.get(inp);
      if (!st && c.store.get().env[k] === v) return;
      if (!st) {
        st = c.hist?.op({ k: "env", env });
        if (st) gestures.set(inp, st);
      } else if (st.op.k === "env") st.op.env = env;
      c.session.setEnv({ [k]: v });
      c.hist?.render();
    },
    change: (e: NEv) => void gestures.delete(e.currentTarget),
  });
  const ENV_ROWS: [
    "temp" | "humidity" | "pressure",
    string,
    number,
    number,
    number,
  ][] = [
    ["temp", t("Temperature"), -10, 45, 0.5],
    ["humidity", t("Humidity"), 0, 100, 1],
    ["pressure", t("Pressure"), 90000, 110000, 50],
  ];
  const envSlider = (
    k: "temp" | "humidity" | "pressure",
    label: string,
    min: number,
    max: number,
    step: number,
  ) => {
    const v = b.ctx!.store.get().env[k];
    return (
      <>
        <ScenHint k={k === "humidity" ? "hum" : k === "pressure" ? "press" : k} />
        <Slider
          min={min}
          max={max}
          step={step}
          defaultValue={v}
          data-env={k}
          aria-label={label}
          out={fmtEnv[k](v)}
          on={envOn(k)}
        />
      </>
    );
  };

  /** Heat source + distance to chip (inspector and quick card); the distance shows only in this block. */
  function HeatActs() {
    const [mm, setMm] = useState<number | null | undefined>(undefined);
    const heat = !!b.ctx!.session.heat;
    return (
      <>
        <Btns>
          <Btn data-act="heat" aria-pressed={heat} onClick={() => b.toggleHeat()}>
            {heat ? t("Remove heat source") : t("Add heat source")}
          </Btn>
          <Btn data-act="chip" onClick={() => setMm(b.measureChip())}>
            {t("Distance to chip")}
          </Btn>
        </Btns>
        <KvBox data-live="chipmm" hidden={mm === undefined}>
          {mm !== undefined && (
            <>
              <span className="k flex-none text-muted">{t("Distance to chip")}</span>
              {mm === null ? (
                <span className="v txt text-[13px] break-all">
                  {t("Cannot see these two targets")}
                </span>
              ) : (
                <>
                  <span className="v fp font-mono text-xs font-medium break-all">
                    {mm.toFixed(1)} mm
                  </span>
                  <span className="v txt text-[13px] break-all text-muted">
                    {b.driftText(mm)}
                  </span>
                </>
              )}
            </>
          )}
        </KvBox>
      </>
    );
  }
  const levelBtn = () => (
    <Btns>
      <Btn
        data-act="level"
        onClick={() => b.ctx!.session.setPose({ pitch: 0, roll: 0, yaw: 0 })}
      >
        {t("Level it")}
      </Btn>
    </Btns>
  );

  /** Set a temperature directly (number box, presets): one timeline step each. */
  function setTempNow(v: number) {
    const c = b.ctx!;
    const t = Math.min(45, Math.max(-10, Math.round(v * 10) / 10));
    if (!Number.isFinite(t) || t === c.store.get().env.temp) return;
    c.hist?.op({ k: "env", env: { ...c.store.get().env, temp: t } });
    c.session.setEnv({ temp: t });
    c.hist?.render();
  }
  function TempExact() {
    const v = b.ctx!.store.get().env.temp;
    return (
      <div className="mt-1.5 mb-1 flex items-center gap-1.5">
        <label className="flex items-center gap-1 text-xs text-muted">
          <input
            type="number"
            data-envnum="temp"
            aria-label={t("Ambient temperature (°C)")}
            min={-10}
            max={45}
            step={0.1}
            defaultValue={v}
            onKeyDown={(e) =>
              e.key === "Enter" && setTempNow(Number(e.currentTarget.value))
            }
            onBlur={(e) => setTempNow(Number(e.currentTarget.value))}
            className="h-8 w-[72px] rounded-md border border-line bg-field px-2 font-mono text-xs text-fg outline-none focus:border-accent"
          />
          °C
        </label>
        <span className="flex-1" />
        {[18, 32, 4].map((deg) => (
          <button
            key={deg}
            type="button"
            data-preset={deg}
            onClick={() => setTempNow(deg)}
            className="h-8 cursor-pointer rounded-md border border-line bg-surface px-2 font-mono text-xs text-fg hover:bg-field"
          >
            {deg}°
          </button>
        ))}
      </div>
    );
  }

  b.encRows = encRows;
  b.encButtons = encButtons;
  b.sonarRows = sonarRows;
  b.sonarControls = sonarControls;
  b.toggleDivider = toggleDivider;
  b.lastLine = lastLine;
  b.fmtEnv = fmtEnv;
  b.ENV_ROWS = ENV_ROWS;
  b.envSlider = envSlider;
  b.HeatActs = HeatActs;
  b.levelBtn = levelBtn;
  b.TempExact = TempExact;
}

