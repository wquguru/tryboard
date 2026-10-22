// Bench section: inject bad wiring (acceptance debug hook, exposed only with ?debug=1).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { type WireMods } from "../wiring";
import type { BenchCtx } from "./ctx";

export function mountDebug(b: BenchCtx) {
  function injectWiring(
    kind:
      | "drive"
      | "5v"
      | "nores"
      | "nognd"
      | "addr"
      | "nodiv"
      | "short3v3"
      | "short5v"
      | "clamp"
      | "clear",
  ): string[] {
    const c = b.ctx!;
    const ses = c.session;
    let scene = ses.scene;
    let mods: WireMods = {};
    let label = "";
    const servo = scene.parts.find((p) => p.type === "servo");
    if (kind === "drive") {
      // Pot wiper on the servo signal pin: the wiper drives a level while the GPIO outputs PWM
      const pin = servo && "pin" in servo ? servo.pin : 4;
      scene = {
        ...scene,
        parts: [
          ...scene.parts.filter((p) => p.type !== "pot"),
          { type: "pot", pin },
        ],
      };
      label = t("Potentiometer on GPIO{n}", { n: pin });
    } else if (kind === "5v") {
      mods = { retarget: { "wire:3V3~bme280:VIN": "5V" } };
      label = t("BME280 power moved to 5V");
    } else if (kind === "nores") {
      scene = {
        ...scene,
        parts: [
          ...scene.parts.filter((p) => !(p.type === "led" && p.pin === 6)),
          { type: "led", pin: 6 },
        ],
      };
      mods = { noResistor: ["led:6"] };
      label = t("LED without series resistor");
    } else if (kind === "nognd") {
      mods = { drop: ["wire:GND~bme280:GND"] };
      label = t("BME280 ground wire removed");
    } else if (kind === "nodiv") {
      mods = { noDivider: ["hcsr04"] };
      label = t("Echo divider resistor removed");
    } else if (kind === "clamp") {
      // Add an HC-SR04 (Trig GPIO2, Echo GPIO3) without the Echo divider: 5 V goes straight into GPIO3's clamp diode
      scene = {
        ...scene,
        parts: [
          ...scene.parts.filter((p) => !(p.type === "hcsr04" && p.trig === 2)),
          { type: "hcsr04", trig: 2, echo: 3 },
        ],
      };
      mods = { noDivider: ["hcsr04"] };
      label = t("Ultrasonic Echo wired directly without a divider");
    } else if (kind === "short3v3" || kind === "short5v") {
      const r = kind === "short3v3" ? "3V3" : "5V";
      mods = { jumpers: [[r, "GND"]] };
      label = t("Jumper wire from {rail} to GND", { rail: r });
    } else if (kind === "addr") {
      scene = {
        ...scene,
        parts: scene.parts.map((p) =>
          p.type === "oled" ? { ...p, addr: 0x76 } : p,
        ),
      };
      label = t("OLED address changed to 0x76");
    } else {
      label = t("Wiring restored");
    }
    if (kind === "clear")
      scene = {
        ...scene,
        parts: scene.parts
          .filter(
            (p) =>
              p.type !== "pot" &&
              !(p.type === "led" && p.pin === 6) &&
              !(p.type === "hcsr04" && p.trig === 2),
          )
          .map((p) => (p.type === "oled" ? { ...p, addr: 0x3c } : p)),
      };
    c.hist?.op({ k: "wiring", mods, scene, label });
    // Only the bench and rule checks change, no power cycle: this hook tests the wiring check
    ses.restoreScene(scene, ses.power);
    ses.setWireMods(mods);
    return b.faults.flatMap((f) => f.wires);
  }

  /** window.__tbApp hooks for acceptance scripts (?debug=1 only). */
  function exposeDebugHooks() {
    if (new URLSearchParams(location.search).has("debug")) {
      const w = window as unknown as { __tbApp?: Record<string, unknown> };
      w.__tbApp ??= {};
      w.__tbApp.injectWiring = (k: Parameters<typeof injectWiring>[0]) =>
        b.ctx ? injectWiring(k) : [];
      w.__tbApp.faults = () =>
        b.faults.map((f) => ({
          rule: f.rule,
          wires: f.wires,
          short: f.short,
          detail: f.detail,
          mA: f.estimate?.mA ?? null,
          est: f.estimate?.text ?? null,
        }));
      // Open a wire's wrong-wire card for acceptance screenshots (same card a rewire shows)
      w.__tbApp.showWrongWire = (wireId: string) => {
        const f = b.faults.find((x) => x.wires.includes(wireId));
        if (!b.ctx || !f) return false;
        b.showWrongWire(
          f,
          wireId,
          `${wireId.replace(/^wire:/, "")}`,
          () => {},
          () => {},
        );
        return true;
      };
      w.__tbApp.setWireLen = (part: string, cm: number) =>
        b.ctx && b.setWireLen(part, cm);
    }
  }

  b.injectWiring = injectWiring;
  b.exposeDebugHooks = exposeDebugHooks;
}

