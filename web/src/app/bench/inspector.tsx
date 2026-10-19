// Bench section: Inspector.
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { type ReactNode } from "react";
import { benchI2cWire, i2cBuses, partId, partInfo, type WireMods } from "../wiring";
import { i2cLoad, i2cSay, i2cText } from "../harness";
import { type WireFault } from "../wirecheck";
import { Conf, confOfRule } from "../../ui/conf";
import { Live } from "../../ui/native";
import { Bad, Btn, Btns, Kv, KvT, Mono, Muted, Note, Ok, Ph, Res, Sec, Seg, SegB, Slider, TreeEmpty } from "../../ui/panel";
import { actions } from "../chrome";
import { PhonePanel } from "../blepane";
import { ConfBadge } from "../benchv2";
import { EST, NoteLive, SayLive } from "./shared";
import type { BenchCtx } from "./ctx";

export function mountInspector(b: BenchCtx) {
  /** Banner atop the inspector at a seek point: where we are, whether the fingerprint matches, resume from here. */
  function seekBanner(): ReactNode {
    const c = b.ctx!;
    const h = c.store.get().hist;
    const cls =
      "seekbar mt-2.5 mb-1 flex flex-col gap-[3px] rounded-lg border border-accent-line bg-accent-bg px-2.5 py-2 text-xs [&_.btns]:mt-1 [&>b]:text-[13px] [&>b]:font-medium [&>b]:text-fg";
    if (h.busy)
      return (
        <div className={cls}>
          <b>{t("Rewinding…")}</b>
          <Live k="sim" className="font-mono" />
          <Muted>{t("Replaying the recording")}</Muted>
        </div>
      );
    const r = c.hist?.lastSeek();
    if (!h.seeked || !r) return null;
    const same =
      r.same === null ? (
        <Muted>
          {t("More actions follow in this run: stopped before the next one, so it is not compared with the whole run")}
        </Muted>
      ) : r.same ? (
        <Ok>{t("✓ Identical to the original")}</Ok>
      ) : (
        <Bad>{t("✗ Differs from the original")}</Bad>
      );
    return (
      <div className={cls} data-seek={r.run}>
        <b>{t("Back at {s} s of run #{n} · paused", { n: r.run, s: (r.untilMs / 1000).toFixed(2) })}</b>
        <Mono>{t("Run ID {id}", { id: r.fingerprint })}</Mono>
        {same}
        <Btns>
          <Btn primary id="resume" onClick={() => c.hist?.resume()}>
            {t("Resume from here")}
          </Btn>
          <Btn id="seekRerun" onClick={() => c.session.reboot()}>
            {t("Power cycle")}
          </Btn>
        </Btns>
        <Muted>{t("Keep editing and running; later steps will be discarded")}</Muted>
      </div>
    );
  }

  /** Replace the whole inspector (with the seek banner on top), then fill live fields once. */
  function show(body: ReactNode, live = true) {
    b.ctx!.shell.props.render(
      <>
        {seekBanner()}
        {body}
      </>,
    );
    if (live) b.updateLive();
  }

  function renderProps() {
    const c = b.ctx!;
    const s = c.store.get();
    const sel = s.selection;
    if (!sel && b.exInfo) b.renderExample();
    else if (!sel)
      show(
        <>
          <Sec>{t("Properties")}</Sec>
          <TreeEmpty>{t("Click the build tree on the left or a part on the bench")}</TreeEmpty>
        </>,
        false,
      );
    else if (sel.kind === "checkpoint") b.renderCheckpoint(sel.id);
    else if (sel.kind === "env") b.renderEnv();
    else if (sel.kind === "firmware") b.renderFirmware();
    else if (sel.kind === "power") renderPower(sel.id);
    else if (sel.kind === "wire") renderWire(sel.id);
    else if (sel.kind === "pin") b.renderPin(sel.id);
    else if (sel.kind === "button") b.renderButton(sel.id);
    else if (sel.kind === "run") b.renderRuns(Number(sel.id));
    else if (sel.kind === "tool")
      sel.id === "meter" ? b.renderMeter() : b.renderRuler();
    // The virtual phone subscribes to bleFeed itself; the inspector mounts it once on select.
    else if (sel.kind === "ble")
      show(<PhonePanel send={(cmd) => actions.ble?.(cmd)} />, false);
    else b.renderPart(sel.id);
  }

  /** Live power-net readings (tryboard-elec node voltages/currents; min / peak / resets since power-on). */
  const elecRows = (
    ext: boolean,
    hasServo: boolean,
    hasAmp = b.ctx!.session.scene.parts.some((p) => p.type === "max98357a"),
  ) => (
    <>
      <Sec>{t("Power supply · live")}</Sec>
      <Kv k={t("5V rail")} live="e5" />
      <Kv k="3V3" live="e33" />
      <Kv k={t("3V3 minimum (this power-on)")} live="emin" />
      <Kv k={t("USB current")} live="eiu" />
      <Kv k={t("USB peak current")} live="epu" />
      {ext && <Kv k={t("External 5 V")} live="eext" />}
      {hasServo && (
        <>
          <Kv k={t("Servo current")} live="eis" />
          <Kv k={t("Servo peak current")} live="eps" />
        </>
      )}
      {hasAmp && <Kv k={t("Amplifier current (5 V, follows volume)")} live="eia" />}
      <Kv k={t("Brownout resets")} live="ers" />
      <Kv k={t("Confidence")} v={t("Estimate")} />
    </>
  );
  /** Servo power choice (shared by inspector and quick card). */
  const powerSeg = (ext: boolean) => (
    <Seg aria-label={t("Servo power")}>
      <SegB data-power="usb" on={!ext} onClick={() => setPower(false)}>
        USB 5 V
      </SegB>
      <SegB data-power="ext" on={ext} onClick={() => setPower(true)}>
        {t("External 5 V 2 A")}
      </SegB>
    </Seg>
  );
  function renderPower(id: string) {
    const c = b.ctx!;
    const ext = !!c.session.power?.ext5v;
    const hasServo = c.session.scene.parts.some((p) => p.type === "servo");
    const toggle = hasServo ? (
      <>
        <Sec>{t("Where the servo gets power")}</Sec>
        {powerSeg(ext)}
        <Note>
          {t("Switchable while running. Choosing external adds a 5 V 2 A supply and a DC jack to the shopping list.")}
        </Note>
      </>
    ) : null;
    show(
      id === "ext5v" ? (
        <>
          <Sec>{t("Power supply")}</Sec>
          <Ph>{t("External 5 V 2 A")}</Ph>
          {ext ? (
            <>
              <KvT k={t("Source")}>
                {t("5 V 2 A adapter through a DC jack to the breadboard power rail, internal resistance about 0.15 Ω (estimate)")}
              </KvT>
              <KvT k={t("Feeds")}>{t("Servo; its ground is tied to the dev board GND")}</KvT>
            </>
          ) : (
            <Note>{t("No external supply connected; the servo takes power from USB 5V.")}</Note>
          )}
          {ext ? <Kv k={t("Voltage")} live="eext" /> : <Kv k={t("Voltage")} v="—" />}
          {elecRows(ext, hasServo)}
          {toggle}
        </>
      ) : (
        <>
          <Sec>{t("Power supply")}</Sec>
          <Ph>{t("USB 5 V (computer)")}</Ph>
          <KvT k={t("Source")}>
            {t("USB-C to the computer, 5 V, limited to about 0.5 A (USB 2.0 spec); connector plus 1 m cable about 0.5 Ω (estimate)")}
          </KvT>
          <KvT k="3V3">
            {t("On-board LDO SGM2212, 420 mV dropout at 800 mA, feeds the chip, BME280 and OLED; brownout reset below 2.44 V (IDF default level)")}
          </KvT>
          <KvT k={t("5V rail")}>
            {ext
              ? t("Dev board only; the servo uses external 5 V")
              : hasServo
                ? t("Straight from USB; the servo is powered from here too")
                : t("Straight from USB")}
          </KvT>
          {elecRows(ext, hasServo)}
          {!ext && hasServo && (
            <Note bad>
              {t("On USB alone the servo draws about 0.7 A at start, over the 0.5 A limit, and the 5V rail drops to about 3.5 V (estimate). Wide sweeps that reverse before reaching position drag the 5V rail down; once 3V3 falls below 2.44 V a brownout reset happens and serial prints rst:0xf.")}
            </Note>
          )}
          {toggle}
        </>
      ),
    );
  }
  function setPower(ext: boolean) {
    const c = b.ctx!;
    if (!!c.session.power?.ext5v === ext) return;
    c.hist?.op({ k: "power", ext5v: ext });
    c.session.setPower(ext);
    c.shell.toast(
      ext
        ? t("Servo now powered by external 5 V 2 A; the shopping list gained a power adapter and a DC jack")
        : t("Servo back on USB 5 V; the external supply was removed from the shopping list"),
    );
  }

  function renderWire(id: string) {
    const c = b.ctx!;
    const w = b.benchWires().find((x) => x.id === id);
    if (!w) {
      show(
        <>
          <Sec>{t("Wire")}</Sec>
          <Ph mono>{id}</Ph>
        </>,
        false,
      );
      return;
    }
    const fs = b.faults.filter((f) => f.wires.includes(id));
    const power = w.part === "servo" && w.pinRole === "power";
    // I2C wires can be lengthened (P2-11): bus capacitance sums the SDA wires of every module on the bus.
    const bus =
      w.pinRole === "bus"
        ? i2cBuses(c.session.scene.parts, b.benchWires()).find((bus) =>
            bus.parts.includes(w.part),
          )
        : undefined;
    const others = bus ? bus.wireCm - w.lenCm : 0;
    const lenEl = bus ? (
      <>
        <Sec>{t("Wire length · estimate, needs real hardware")}</Sec>
        <Slider
          id="wireLen"
          outId="wireLenV"
          min={5}
          max={150}
          step={1}
          defaultValue={w.lenCm}
          aria-label={t("Wire length of {part}", { part: partInfo(c.session.scene.parts.find((p) => partId(p) === w.part)!).name })}
          out={`${w.lenCm} cm`}
          on={{
            input: (e) => {
              const v = Number(e.currentTarget.value);
              const props = c.shell.props.el;
              props.querySelector("#wireLenV")!.textContent = `${v} cm`;
              const l = i2cLoad(others + v, bus.parts.length);
              props.querySelector("#wireLenSay")!.textContent = i2cSay(l);
              props.querySelector("#wireLenNote")!.textContent = i2cText(l);
            },
            change: (e) => setWireLen(w.part, Number(e.currentTarget.value)),
          }}
        />
        <Kv
          k={t("This bus")}
          v={t("Modules: {n} · SDA total {cm} cm", { n: bus.parts.length, cm: bus.wireCm.toFixed(0) })}
        />
        <SayLive
          id="wireLenSay"
          init={i2cSay(i2cLoad(bus.wireCm, bus.parts.length))}
        />
        <NoteLive
          id="wireLenNote"
          init={i2cText(i2cLoad(bus.wireCm, bus.parts.length))}
        />
      </>
    ) : null;
    show(
      <>
        <Sec>{t("Wire")}</Sec>
        <Ph>{`${w.a} → ${w.b}`}</Ph>
        <Kv k={t("Purpose")} v={w.role} />
        <Kv k={t("Color")} v={t("{color} jumper wire", { color: w.color })} />
        <Kv k={t("Dev board end")} v={w.a} cls={w.from ? "bad" : ""} />
        {w.from && <Kv k={t("Originally on")} v={w.from} />}
        <Kv k={t("Part end")} v={w.b} />
        {w.ohm !== undefined && (
          <Kv
            k={t("Current-limiting resistor")}
            v={w.ohm ? `${w.ohm} Ω` : t("None")}
            cls={w.ohm ? "" : "bad"}
          />
        )}
        {w.missing && <Kv k={t("Status")} v={t("Not plugged in")} cls="bad" />}
        <Sec>{fs.length ? t("Wiring check · issues: {n}", { n: fs.length }) : t("Wiring check")}</Sec>
        {fs.length ? fs.map(faultEl) : <Res kind="ok">{t("No problems found on this wire")}</Res>}
        {lenEl}
        {power && powerInline()}
      </>,
      false,
    );
  }

  /** Lengthen / shorten a module's wire (timeline op; bus load changes live, so the next firmware read sees it). */
  function setWireLen(part: string, cm: number) {
    const c = b.ctx!;
    const ses = c.session;
    const mods: WireMods = {
      ...ses.wireMods,
      lenCm: { ...ses.wireMods.lenCm, [part]: cm },
    };
    const name = partInfo(
      ses.scene.parts.find((p) => partId(p) === part)!,
    ).name;
    c.hist?.op({
      k: "wiring",
      mods,
      scene: ses.scene,
      label: t("{part} wire length {cm} cm", { part: name, cm }),
    });
    ses.setWireMods(mods);
    applyBenchHarness();
  }

  /** Hand the bench harness to the sim: bus load only once a length changed; no antenna blockage on a breadboard. */
  function applyBenchHarness() {
    const ses = b.ctx!.session;
    const cm = benchI2cWire(ses.scene.parts, ses.wireMods);
    const h: { i2cWire?: number; antenna?: number } = {};
    if ((ses.harness.i2cWire ?? -1) !== cm) h.i2cWire = cm;
    if ((ses.harness.antenna ?? 0) !== 0) h.antenna = 0;
    if (Object.keys(h).length) ses.setHarness(h);
  }
  const faultEl = (f: WireFault, i: number) => (
    <Res key={i} kind="bad">
      <b>{f.title}</b> · {f.detail}
      {f.estimate && (
        <span
          data-est={f.rule}
          className="mt-1 flex flex-wrap items-center gap-1.5"
        >
          <b className="font-mono">≈ {f.estimate.mA} mA</b>
          <ConfBadge c={EST} />
          <span>{f.estimate.text}</span>
        </span>
      )}
      <br />
      <Muted className="inline-flex flex-wrap items-center gap-1">
        <Conf c={confOfRule(f.confidence)} /> · {f.source}
      </Muted>
    </Res>
  );
  const powerInline = () => (
    <>
      <Sec>{t("Where the servo gets power")}</Sec>
      {powerSeg(!!b.ctx!.session.power?.ext5v)}
    </>
  );

  b.show = show;
  b.renderProps = renderProps;
  b.powerSeg = powerSeg;
  b.setWireLen = setWireLen;
  b.applyBenchHarness = applyBenchHarness;
  b.faultEl = faultEl;
  b.powerInline = powerInline;
}

