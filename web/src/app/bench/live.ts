// Bench section: live fields (no panel rebuild, so slider drags are not interrupted).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { bit, drawScope, pinKind, powerVolts, pwmText } from "../pinscope";
import { servoAngle, ledCss } from "../../views/common";
import { angDiff, gravity } from "../../imupose";
import { outOf, swatch } from "./shared";
import type { BenchCtx } from "./ctx";

export function mountLive(b: BenchCtx) {
  function updateLive() {
    const c = b.ctx!;
    const WAIT_FW = t("Waiting for firmware output…");
    const s = c.store.get();
    const el = c.shell.props.el;
    // Quick cards and the properties panel share the same data-live fields
    const card = c.shell.stage.querySelector<HTMLElement>(
      ".qcard:not([hidden])",
    );
    // Pinned cards over the bench (Multimeter) are filled through data-live too
    const extra = [
      ...c.shell.stage.querySelectorAll<HTMLElement>("[data-live-root]"),
    ];
    const set = (k: string, v: string, bad = false) => {
      for (const root of card ? [el, card, ...extra] : [el, ...extra]) {
        // One field can appear in several places (drop box and running card both show simulated time), so fill all
        for (const n of root.querySelectorAll<HTMLElement>(`[data-live="${k}"]`)) {
          n.textContent = v;
          n.classList.toggle("bad", bad);
        }
      }
    };
    set(
      "run",
      s.run
        ? s.hist.seeked
          ? t("#{n} · rewind point (paused)", { n: s.runNo || s.run })
          : s.running
            ? t("#{n} · running", { n: s.runNo || s.run })
            : t("#{n} · stopped", { n: s.runNo || s.run })
        : t("Not powered"),
    );
    set("sim", `${s.simSeconds.toFixed(2)} s`);
    const rd = s.reading;
    // Red when the reading drifts past level 06's tolerance: usually a firmware conversion bug
    set(
      "rt",
      rd ? `${rd.t.toFixed(2)} °C` : WAIT_FW,
      !!rd && Math.abs(rd.t - s.env.temp) > 0.5,
    );
    set("rh", rd ? `${rd.h.toFixed(1)} %` : "—");
    set("rp", rd && !Number.isNaN(rd.p) ? `${rd.p.toFixed(2)} hPa` : "—");
    set(
      "vp",
      s.verifyProgress < 0 ? t("· loading simulator…") : `${s.verifyProgress.toFixed(1)} s`,
    );
    const e = c.session.frame.elec;
    if (e) {
      const V = (x: number) => (Number.isFinite(x) ? `${x.toFixed(3)} V` : "—");
      const A = (x: number) => `${(x * 1000).toFixed(0)} mA`;
      set("e5", V(e.v5), e.v5 < 4.0);
      set(
        "e33",
        e.held ? t("{v} · in brownout reset", { v: V(e.v3v3) }) : V(e.v3v3),
        e.v3v3 < 3.0,
      );
      set("emin", V(e.min3v3), e.min3v3 < 2.44);
      set("eiu", A(e.iUsb), e.iUsb > 0.5);
      set("epu", A(e.peakUsb), e.peakUsb > 0.5);
      set("eext", V(e.vExt));
      set("eis", A(e.iServo));
      set("eps", A(e.peakServo));
      set("eia", A(e.iAmp ?? 0));
      set("ers", `${e.resets}×`, e.resets > 0);
      set("eic", A(e.i3v3));
      set(
        "pv",
        s.selection?.kind === "pin"
          ? powerVolts(s.selection.id, !!c.session.power?.ext5v, e)
          : "",
      );
    }
    const pd = c.session.frame.pins;
    if (pd) {
      set(
        "encpos",
        pd.encPos === null ? "—" : t("Detents: {n} (clockwise is positive)", { n: pd.encPos }),
      );
      set("pcnt", pd.pcnt === null ? "—" : String(pd.pcnt));
      set("pings", pd.pings === null ? "—" : `${pd.pings}×`);
      set(
        "echo",
        pd.echoUs === null || !pd.pings ? "—" : `${pd.echoUs.toFixed(1)} µs`,
      );
    }
    const em = b.lastLine(/ENC count=(-?\d+) detents=(-?\d+)/g);
    set(
      "encfw",
      em ? t("count={count} (detents: {n})", { count: em[1], n: em[2] }) : WAIT_FW,
    );
    const sm = b.lastLine(/DIST (?:([\d.]+) cm|out of range|no echo)/g);
    set("sonfw", sm ? (sm[1] ? `${sm[1]} cm` : sm[0].slice(5)) : WAIT_FW);
    const dist = c.session.distance;
    set("dist", dist < 0 ? t("No obstacle (out of range)") : `${dist.toFixed(1)} cm`);
    for (const root of card ? [el, card] : [el])
      root
        .querySelectorAll<HTMLInputElement>("input[data-dist]")
        .forEach((inp) => {
          if (
            inp === document.activeElement ||
            dist < 0 ||
            Number(inp.value) === dist
          )
            return;
          inp.value = String(dist);
          const o = outOf(inp);
          if (o) o.textContent = `${dist.toFixed(1)} cm`;
        });
    // Pose and IMU readings (P2-03)
    const pz = s.pose;
    const [gx, gy, gz] = gravity(pz);
    set("gacc", `${gx.toFixed(3)} / ${gy.toFixed(3)} / ${gz.toFixed(3)} g`);
    const im = s.imu;
    set(
      "ipitch",
      im ? `${im.pitch.toFixed(1)}°` : WAIT_FW,
      !!im && Math.abs(im.pitch - pz.pitch) > 1.5 && Math.abs(pz.pitch) < 85,
    );
    set(
      "iroll",
      im ? `${im.roll.toFixed(1)}°` : "—",
      !!im &&
        Math.abs(angDiff(im.roll, pz.roll)) > 1.5 &&
        Math.abs(pz.pitch) < 85,
    );
    set(
      "igyro",
      im?.gyro ? `${im.gyro.map((v) => v.toFixed(1)).join(" / ")} °/s` : "—",
    );
    set(
      "ipr",
      im
        ? t("Pitch {p}° · roll {r}°", { p: im.pitch.toFixed(1), r: im.roll.toFixed(1) })
        : WAIT_FW,
    );
    for (const root of card ? [el, card] : [el])
      root
        .querySelectorAll<HTMLInputElement>("input[data-pose]")
        .forEach((inp) => {
          if (inp === document.activeElement) return;
          const k = inp.dataset.pose as "pitch" | "roll" | "yaw";
          const v = Math.round(pz[k]);
          if (Number(inp.value) === v) return;
          inp.value = String(v);
          const o = outOf(inp);
          if (o) o.textContent = `${v}°`;
        });
    const tpart = c.session.scene.parts.find((x) => x.type === "cst816s");
    if (tpart && tpart.type === "cst816s") {
      set(
        "tch",
        s.touch
          ? s.touch.down
            ? t("Pressed · x {x} y {y}", { x: s.touch.x, y: s.touch.y })
            : t("Released · x {x} y {y}", { x: s.touch.x, y: s.touch.y })
          : t("Not touched yet"),
      );
      const fr = c.session.frame;
      const lv =
        tpart.int < 32
          ? (fr.gpio >>> tpart.int) & 1
          : (fr.gpioHi >>> (tpart.int - 32)) & 1;
      set(
        "tint",
        lv
          ? t("GPIO{n} high (not pressed)", { n: tpart.int })
          : t("GPIO{n} low (pressed)", { n: tpart.int }),
      );
    }
    const mr = b.meterReading();
    if (mr) {
      set("mv", mr.v === null ? "—" : `${mr.v.toFixed(3)} V`);
      set("mnote", mr.note);
    }
    for (const root of [el, ...(card ? [card] : [])])
      root
        .querySelectorAll<HTMLInputElement>("input[data-envnum]")
        .forEach((inp) => {
          if (
            inp !== document.activeElement &&
            Number(inp.value) !== s.env.temp
          )
            inp.value = String(s.env.temp);
        });
    // The env may change elsewhere (card / heat source / rewind); sliders not being dragged follow it
    for (const root of card ? [el, card] : [el])
      root
        .querySelectorAll<HTMLInputElement>("input[data-env]")
        .forEach((inp) => {
          if (inp === document.activeElement) return;
          const k = inp.dataset.env as "temp" | "humidity" | "pressure";
          if (Number(inp.value) === s.env[k]) return;
          inp.value = String(s.env[k]);
          const o = outOf(inp);
          if (o) o.textContent = b.fmtEnv[k](s.env[k]);
        });
    const f = c.session.frame;
    const rgbN = el.querySelector<HTMLElement>('[data-live="rgb"]');
    if (rgbN) {
      const css = ledCss(f.rgb);
      if (f.rgb)
        rgbN.replaceChildren(
          swatch(css ?? "#000"),
          `#${f.rgb.map((x) => x.toString(16).padStart(2, "0")).join("")}`,
        );
      else rgbN.textContent = t("Off");
    }
    const servo = c.session.scene.parts.find((p) => p.type === "servo");
    if (servo && "pin" in servo) {
      const d = f.pwm[servo.pin];
      set(
        "pw",
        d !== undefined && d >= 0 ? `${(d * 20).toFixed(3)} ms` : t("No PWM"),
      );
      const a = servoAngle(f.pwm, servo.pin);
      // The horn angle comes from the core's second-order dynamics (with overshoot); the bracket shows the PWM target
      const phys = f.elec?.servoAngle;
      set(
        "ang",
        phys != null
          ? a === null
            ? `${phys.toFixed(1)}°`
            : t("{deg}° (target {target}°)", { deg: phys.toFixed(1), target: a.toFixed(1) })
          : a === null
            ? "—"
            : `${a.toFixed(1)}°`,
      );
    }
    // Live pin values and the scope
    const sel = s.selection;
    if (sel?.kind === "pin") {
      const g = /^GPIO(\d+)$/.exec(sel.id);
      const pin = g ? Number(g[1]) : -1;
      if (pin >= 0) {
        const duty = f.pwm[pin] ?? -1;
        const freq = f.pwmFreq[pin] ?? 0;
        const out = !!bit(f.enable, f.enableHi, pin);
        const lv = bit(f.gpio, f.gpioHi, pin);
        set(
          "pdir",
          duty >= 0 ? t("Output (LEDC PWM)") : out ? t("Output") : t("Input or undriven"),
        );
        set("plv", duty >= 0 ? t("Square wave") : lv ? t("High (3.3 V)") : t("Low (0 V)"));
        if (duty >= 0 && freq > 0) {
          const pt = pwmText(duty, freq);
          set("pf", pt.freq);
          set("pw2", pt.width);
          set("pd", pt.duty);
        } else {
          set("pf", t("No PWM"));
          set("pw2", "—");
          set("pd", "—");
        }
      }
      const cv = el.querySelector<HTMLCanvasElement>("canvas.scope");
      if (cv) {
        const wires = b.benchWires().filter((w) => w.a === sel.id && !w.missing);
        const kind = pinKind(sel.id, wires);
        const v =
          sel.id === "3V3"
            ? 3.3
            : sel.id === "5V" || sel.id === "EXT5V"
              ? 5
              : 0;
        set(
          "scopeNote",
          drawScope(cv, kind, b.trace, b.trace.latest()?.t ?? s.simSeconds, v),
        );
      }
    }
    const cv = el.querySelector<HTMLCanvasElement>("canvas.oled");
    if (cv && f.oled) {
      const g = cv.getContext("2d")!;
      const img = g.createImageData(128, 64);
      let lit = 0;
      for (let i = 0; i < 128 * 64; i++) {
        const on = f.oled[i] > 0;
        lit += on ? 1 : 0;
        img.data.set(on ? [120, 200, 255, 255] : [8, 14, 24, 255], i * 4);
      }
      g.putImageData(img, 0, 0);
      set("oledn", String(lit));
    }
  }

  b.updateLive = updateLive;
}

