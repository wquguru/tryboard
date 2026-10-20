// Bench section: Orientation (P2-03).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { CHIP_LABEL } from "../../chips";
import { AdcPanel } from "../adcpanel";
import { cn } from "../../ui/cn";
import { Drop, Kv, KvBox, Note, Ph, Sec, Slider } from "../../ui/panel";
import { CHIP_NAME, chipOf, type AnalogControl } from "../examples";
import { lab } from "../../ui/links";
import { outOf } from "./shared";
import type { BenchCtx } from "./ctx";
import { partInfo } from "../wiring";
import { isTutorialPart } from "../../bench3d/parts3d";
import { tutorialControls } from "./tutorial";

export function mountOrientation(b: BenchCtx) {
  const POSE_AXES: ["pitch" | "roll" | "yaw", string, number][] = [
    ["pitch", t("Pitch"), 90],
    ["roll", t("Roll"), 180],
    ["yaw", t("Yaw"), 180],
  ];
  function poseSliders(axes = POSE_AXES) {
    const pz = b.ctx!.store.get().pose;
    return axes.map(([k, n, lim]) => (
      <KvBox key={k}>
        <span className="k">{n}</span>
        <Slider
          min={-lim}
          max={lim}
          step={1}
          defaultValue={pz[k]}
          data-pose={k}
          aria-label={n}
          out={`${pz[k].toFixed(0)}°`}
          on={{
            input: (e) => {
              const c = b.ctx!;
              const v = Number(e.currentTarget.value);
              outOf(e.currentTarget)!.textContent = `${v.toFixed(0)}°`;
              c.session.setPose({ ...c.store.get().pose, [k]: v });
            },
          }}
        />
      </KvBox>
    ));
  }

  function renderEnv() {
    b.show(
      <>
        <Sec>{t("Environment")}</Sec>
        <Ph>{t("Indoors")}</Ph>
        <Note>{t("Change these and the sensor readings, serial output and OLED all follow.")}</Note>
        {b.ENV_ROWS.map(([k, n, min, max, step]) => (
          <KvBox key={k}>
            <span className="k">{n}</span>
            {b.envSlider(k, n, min, max, step)}
          </KvBox>
        ))}
        <Sec>{t("Sensor reads")}</Sec>
        <Kv k={t("Temperature")} live="rt" />
        <Kv k={t("Humidity")} live="rh" />
        <Kv k={t("Pressure")} live="rp" />
      </>,
    );
  }

  /** Mic sources (same set as the old bench: test WAVs count for checks, the browser mic is play only). */
  const MIC_SOURCES: [string, string][] = [
    ["sine1k.wav", t("1 kHz sine (test WAV)")],
    ["sweep.wav", t("Sweep 200→2000 Hz (test WAV)")],
    ["silence", t("Silence")],
    ["live", t("Browser microphone (needs permission, play only, not checked)")],
  ];

  /** Wiper slider plus the ADC panel (D-02); shown on the example card and when the pot part is selected. */
  function analogBox(a: AnalogControl) {
    const c = b.ctx!;
    const mv = c.session.analog.get(a.pin) ?? a.value;
    return (
      <KvBox key={a.pin}>
        <span className="k">{t(a.label)}</span>
        <Slider
          min={0}
          max={a.max_mv}
          step={10}
          defaultValue={mv}
          data-analog={a.pin}
          aria-label={t(a.label)}
          out={`${mv} mV`}
          on={{
            input: (e) => {
              const v = Number(e.currentTarget.value);
              outOf(e.currentTarget)!.textContent = `${v} mV`;
              c.session.setAnalog(a.pin, v);
            },
          }}
        />
        <AdcPanel session={c.session} chip={c.session.chip} pin={a.pin} />
      </KvBox>
    );
  }

  /** "This example": about, tags, analog sliders (the .env ones are what regression scripts drag), plus a project using similar parts. */
  function renderExample() {
    const c = b.ctx!;
    const { ex, work } = b.exInfo!;
    const ctl = ex.controls ?? [];
    const analogs = ctl.filter((k): k is AnalogControl => typeof k === "object" && k.type === "analog");
    b.show(
      <>
        <Sec>{t("This example")}</Sec>
        <Ph>{t(ex.title)}</Ph>
        <Note>{t(ex.about)}</Note>
        <div className="mb-1 flex flex-wrap gap-1.5" data-ex-tags>
          {[CHIP_NAME[chipOf(ex)], ...ex.tags].map((tag) => (
            <span
              key={tag}
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px]",
                tag.startsWith("✓") ? "bg-ok-bg text-ok-ink" : "bg-field text-muted",
              )}
            >
              {t(tag)}
            </span>
          ))}
        </div>
        {(ctl.includes("env") || analogs.length > 0 || (ctl.includes("imu") && c.session.hasImu())) && (
          <div className="env">
            {ctl.includes("env") && (
              <>
                <Sec>{t("Environment · drag and watch the reading follow")}</Sec>
                {b.ENV_ROWS.map(([k, n, min, max, step]) => (
                  <KvBox key={k}>
                    <span className="k">{n}</span>
                    {b.envSlider(k, n, min, max, step)}
                  </KvBox>
                ))}
                <Kv k={t("Firmware reading")} live="rt" />
              </>
            )}
            {analogs.map((a) => analogBox(a))}
            {ctl.includes("imu") && c.session.hasImu() && (
              <>
                <Sec>{t("Tilt the bench")}</Sec>
                {poseSliders()}
                <Kv k={t("Firmware reading")} live="ipr" />
              </>
            )}
          </div>
        )}
        {c.session.scene.parts.filter(isTutorialPart).filter((p) => !(p.type === "ds18b20" && ctl.includes("env"))).map((p, i) => (
          <div key={`tut${i}`} data-tutorial={p.type}>
            <Sec>{partInfo(p).name}</Sec>
            {tutorialControls(b, p)}
          </div>
        ))}
        {c.session.scene.parts.some((p) => p.type === "inmp441") && (
          <>
            <Sec>{t("Microphone source")}</Sec>
            <select
              id="micSource"
              aria-label={t("Microphone source")}
              defaultValue={c.session.micSource}
              className="h-9 w-full cursor-pointer rounded-md border border-line bg-surface px-2 text-[13px] text-fg max-md:h-11"
              onChange={(e) => {
                const st = document.getElementById("micStatus");
                if (st) st.textContent = "";
                void c.session.setMicSource(e.currentTarget.value).then((msg) => {
                  if (st) st.textContent = msg;
                  if (msg) e.currentTarget.value = c.session.micSource;
                });
              }}
            >
              {MIC_SOURCES.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <div id="micStatus" className="mt-1 text-xs text-muted" />
          </>
        )}
        {work && (
          <>
            <Sec>{t("Make it a product")}</Sec>
            <a
              className="text-accent-ink hover:underline"
              href={lab(work.id, 'shop')}
              data-ex-work={work.id}
            >
              {t(work.title)} · {work.card?.chip ?? ""} →
            </a>
          </>
        )}
        <Note>{t("Click the build tree on the left or a part on the bench to see its properties.")}</Note>
      </>,
    );
  }

  /** Unreadable file (moved, no permission): toast instead of throwing onto the page. */
  const safeFile = (handle: (f: File) => Promise<void>) => (f: File) =>
    void handle(f).catch((e) =>
      b.ctx?.shell.toast(
        t("Cannot read {file}: {err}", { file: f.name, err: e instanceof Error ? e.message : String(e) }),
      ),
    );

  function renderFirmware() {
    const c = b.ctx!;
    const ses = c.session;
    b.show(
      <>
        <Sec>{t("Firmware")}</Sec>
        <Ph mono>{ses.fwName || t("No firmware yet")}</Ph>
        {ses.fwName && (
          <>
            <Kv k={t("Size")} v={`${(ses.fwSize / 1024).toFixed(0)} KB`} />
            <Kv k={t("Chip")} v={CHIP_LABEL[ses.chip]} />
          </>
        )}
        <Kv k={t("Run")} live="run" />
        <Kv k={t("Simulated time")} live="sim" />
        <Drop
          kind="bench"
          title={t("Drop a .bin here")}
          sub={t("Run your own firmware on the bench; needs a full flash image exported by ESP-IDF or Arduino")}
          onFile={safeFile(async (f) => {
            ses.loadFirmware(await f.arrayBuffer(), f.name);
            b.renderTree();
            renderFirmware();
          })}
        />
      </>,
    );
  }

  b.POSE_AXES = POSE_AXES;
  b.poseSliders = poseSliders;
  b.renderEnv = renderEnv;
  b.analogBox = analogBox;
  b.renderExample = renderExample;
  b.safeFile = safeFile;
  b.renderFirmware = renderFirmware;
}

