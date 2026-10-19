// Step 2 Bench: build tree + inspector + checkpoints, quick cards (P0-04), pin scope (P0-11), wiring rules (P0-12), ruler/history (P0-13).
// Tree and scene picks share one selection; React redraws the panel on selection change, per-frame readings go through data-live.
import { t } from "../../i18n";
import { openFwMenu } from "../fwmenu";
import { useState, type ReactNode } from "react";
import type { PickTarget, ScreenPoint } from "../../scene-api";
import { CHIP_HEAT_OFFSET } from "../../views/templates";
import {
  benchI2cWire,
  i2cBuses,
  partId,
  partInfo,
  usedPins,
  wiresOf,
  type WireMods,
} from "../wiring";
import { i2cLoad, i2cSay, i2cText } from "../harness";
import { checkWiring, faultByWire, type WireFault } from "../wirecheck";
import { applyCached, enrichFaults } from "../faultsolve";
import {
  PinTrace,
  bit,
  drawScope,
  meterVolts,
  pinKind,
  powerVolts,
  pwmText,
} from "../pinscope";
import { diffRuns, summarize, type BenchStep } from "../history";
import { checkCommand, type Level } from "../../checks";
import { Conf, confOfRule, type ConfLevel } from "../../ui/conf";
import { ResultCard, RunningCard, actCls } from "../../ui/result";
import { headline } from "../../ui/say";
import { VerifyStalled, verifyLevel } from "../../verify";
import { fetchBuf } from "../../assets";
import { BOARD_NAME, BOOT_GPIO, CHIP_DESC, CHIP_LABEL, CHIP_SHORT, RGB_GPIO } from "../../chips";
import { servoAngle, ledCss } from "../../views/common";
import type {
  AppState,
  CheckOutcome,
  Selection,
  StepCtx,
  StepImpl,
  WorkDef,
} from "../types";
import { getAnalyzer } from "../analyzer";
import { extModelsOn, setExtModels } from "../../extmodels";
import {
  RECORD_SECONDS,
  recordCanvas,
  takePhoto,
  type Recording,
} from "../capture";
import { angDiff, gravity } from "../../imupose";
import { cn } from "../../ui/cn";
import { Live, useInitText } from "../../ui/native";
import {
  Bad,
  Brief,
  Btn,
  Btns,
  Code,
  Drop,
  Field,
  Kv,
  KvBox,
  KvT,
  Meter,
  Mono,
  LinkBtn,
  Muted,
  Note,
  Ok,
  Ph,
  Res,
  Sec,
  Seg,
  SegB,
  Slider,
  TnSt,
  TreeEmpty,
  TreeGroup,
  TreeNode,
} from "../../ui/panel";
import { noteSaved } from "../saved";
import { CHIP_NAME, chipOf, loadExamples, type AnalogControl, type Example } from "../examples";
import { HOME_WORKS, wkey } from "../works";
import { CustomCheckCard, CustomPlacedCard } from "../customui";
import { BuyCard, BuyDialog } from "../buycard";
import { actions, bc, overlay, setBc, setDock, type Issue } from "../chrome";
import { replay } from "../bom";
import { isPhone, phoneProps, setMui } from "../mobile";
import { bleFeed, phoneStateText, PhonePanel } from "../blepane";
import { setLeft } from "../leftcol";
import {
  buildPlaced,
  mergeMods,
  pinOk,
  placeConflict,
  placeDef,
  type PlaceDef,
} from "../place";
import {
  AllPassedCard,
  CheckpointCard,
  ConfBadge,
  EmptyBench,
  LIB_DRAG,
  MeterCard,
  PART_CONF,
  PartLib,
  PinRings,
  PlaceBanner,
  WireBanner,
  WireTable,
  WrongWireCard,
  tn,
  type RingPin,
} from "../benchv2";
import { HOME, lab } from "../../ui/links";

/** ConfLevel ids are owned by ui/conf.tsx; Conf / ConfBadge render the label. */
const EST: ConfLevel = "估算"; // lint: allow-cjk
const hex = (n: number) => "0x" + n.toString(16).toUpperCase().padStart(2, "0");

/** Checks that never finished (worker error / stall): not a fail, keep the firmware for Retry. */
const stalled: Record<
  string,
  { why: string; buf: ArrayBuffer; who: string; own: boolean }
> = {};

/** Another step (Assemble lock card) asks to run the built-in firmware through: switch to Bench, run after mount. */
let pendingAllRef = false;
export function requestAllRef() {
  if (actions.runAllRef) return actions.runAllRef();
  pendingAllRef = true;
  location.hash = "bench";
}

/** Firmware the user verified on this page (Assemble's power-on retest reuses it; lost on reload, falls back to bench firmware). */
export const ownFirmware: Record<string, { buf: ArrayBuffer; name: string }> =
  {};

const PROGRESS_KEY = (work: string) => `tryboard-app-checks:${work}`;
function loadProgress(
  work: string,
): Record<string, { fp: string; at: string; own?: boolean }> {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY(work)) ?? "{}");
  } catch {
    return {};
  }
}
function saveProgress(work: string, id: string, fp: string, own: boolean) {
  try {
    const p = loadProgress(work);
    // A reference pass never overwrites the user's own pass (old records lack `own`: treat as own).
    if (!own && p[id] && p[id].own !== false) return;
    p[id] = {
      fp,
      at: new Date().toLocaleString("zh-CN", { hour12: false }),
      own,
    };
    localStorage.setItem(PROGRESS_KEY(work), JSON.stringify(p));
    noteSaved();
  } catch {
    /* Private mode cannot store: progress lives only on this page */
  }
}

/** On boot, load saved progress into the store (only pass + fingerprint were saved, no per-row results). */
export function restoreChecks(ctx: StepCtx) {
  const p = loadProgress(wkey(ctx.work));
  const checks: Record<string, CheckOutcome> = {};
  for (const [id, v] of Object.entries(p))
    if (ctx.work.checkpoints.includes(id))
      checks[id] = {
        ok: true,
        own: v.own !== false,
        who:
          v.own !== false
            ? t("Your firmware (passed {at})", { at: v.at })
            : t("Reference firmware (ran through {at})", { at: v.at }),
        rows: [],
        fingerprint: v.fp,
        sim: 0,
      };
  ctx.store.set({ checks });
}

/** Unlocking Assemble / Product only needs a pass: a reference run (◐) and an own pass (✓) both count. */
export function passedCount(ctx: StepCtx, s: AppState = ctx.store.get()) {
  return ctx.work.checkpoints.filter((id) => s.checks[id]?.ok).length;
}

/** Checkpoints passed with the user's own firmware (shown separately as "My firmware n/N"). */
export function ownCount(ctx: StepCtx, s: AppState = ctx.store.get()) {
  return ctx.work.checkpoints.filter(
    (id) => s.checks[id]?.ok && s.checks[id].own,
  ).length;
}

const selEq = (a: Selection | null, b: Selection | null) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;
const toPick = (s: Selection | null): PickTarget | null =>
  s &&
  (s.kind === "part" ||
    s.kind === "pin" ||
    s.kind === "wire" ||
    s.kind === "button")
    ? { kind: s.kind, id: s.id }
    : null;

type NEv = Event & { currentTarget: HTMLInputElement };
/** Reading next to a slider (the output inside the same label). */
const outOf = (inp: HTMLInputElement) =>
  inp.parentElement?.querySelector("output");

/** Live OLED image (drawn every frame by updateLive). */
const OledCanvas = () => (
  <canvas
    className="oled mb-1 block w-full rounded-md bg-(--oled-bg) [image-rendering:pixelated]"
    width={128}
    height={64}
    data-live="oledc"
  />
);

/** Copy brief: the click handler rewrites the button text imperatively. */
function CopyBrief({ onCopy }: { onCopy: (b: HTMLButtonElement) => void }) {
  const ref = useInitText<HTMLButtonElement>(t("Copy brief"));
  return (
    <button
      ref={ref}
      type="button"
      id="copyBrief"
      className="btn hidden"
      onClick={(e) => onCopy(e.currentTarget)}
    />
  );
}

export function benchStep(): StepImpl {
  let ctx: StepCtx | null = null;
  let unsubs: (() => void)[] = [];
  let hooked = false;
  const openGroups: Record<string, boolean> = {
    part: true,
    pin: false,
    wire: false,
    power: true,
    env: true,
    firmware: true,
    run: true,
    checkpoint: true,
    ble: true,
  };
  /** Samples of the selected pin (mini scope). */
  const trace = new PinTrace();
  /** Example on an empty bench (?example=): with nothing selected the right column shows the example card (DESIGN_V2 §6.1). */
  let exInfo: { ex: Example; work: WorkDef | null } | null = null;
  /** Custom-board project: "placed and wired" card dismissed; demo firmware being verified check by check. */
  let customClosed = false;
  let demoBusy = false;
  /** Set by a fresh own pass on this page: only then does all-passed pop the buy card (not on restore or replay). */
  let buyArmed = false;
  /** Ruler: after the toolbar Ruler is on, pick two targets on the bench. */
  let ruler: {
    a: PickTarget | null;
    b: PickTarget | null;
    mm: number | null;
  } | null = null;
  /** Multimeter (P1-04): after the toolbar Multimeter is on, pick a pin to read its voltage to GND. */
  let meter: { target: string | null } | null = null;
  /** Second run picked in history (compared with the selected one). */
  let cmpRun: number | null = null;
  /** Target the quick card follows. */
  let cardFor: PickTarget | null = null;
  let cardRaf = 0;
  /** Heat source: room temperature before it was placed (restored on removal). */
  let heatRoom: number | null = null;
  let faults: WireFault[] = [];
  let shownFaults = new Set<string>();
  /** Wiring check generation: the async net solve is used only if still current. */
  let faultGen = 0;
  /** Open wrong-wire card: redrawn when the estimate arrives. */
  let wwShow: ((f: WireFault) => void) | null = null;
  /** Board-pin to board-pin jumpers drawn on the bench (P2-14). */
  let shownBridge = new Set<string>();
  /** ?debug=1&wiring= is injected once. */
  let injected = false;
  /** Wire tool (U-04): pick a wire, then a new pin on the dev board; `wire` is the picked one. */
  let wiring: { wire: string | null } | null = null;
  /** Wires drawn as rewired (kept in sync with wireMods.retarget). */
  let shownRewire = new Set<string>();
  /** Direct placement (P2-16): wire pin by pin after dropping; enters the scene/sim only once fully wired. */
  let placing: {
    def: PlaceDef;
    cur: number;
    got: Record<string, string>;
    skipped: Set<string>;
  } | null = null;

  function select(sel: Selection | null) {
    // Something picked on the bench expands its group in the build tree.
    if (sel && sel.kind in openGroups) openGroups[sel.kind] = true;
    // A different pick closes the card and the "distance to chip" mark (the ruler tool owns its own marks).
    if (cardFor && !(sel && sel.kind === cardFor.kind && sel.id === cardFor.id))
      closeCard();
    if (!ruler) ctx!.session.pick.measure?.(null);
    ctx!.store.set({ selection: sel });
  }
  const benchWires = () =>
    wiresOf(
      ctx!.session.scene.parts,
      !!ctx!.session.power?.ext5v,
      ctx!.session.wireMods,
    );

  // ------------------------------------------------------------ Wiring rule check (P0-12)
  function recheckWiring() {
    const c = ctx!;
    const s3 = c.session.chip === "esp32s3";
    const fresh = checkWiring(c.session.scene.parts, benchWires());
    const cached = applyCached(fresh, s3);
    faults = cached.faults;
    const gen = ++faultGen;
    // Fault currents come from the wasm elec solver (P2-14); first call instantiates wasm, results patch the panel and card.
    if (!cached.done)
      void enrichFaults(fresh, s3)
        .then((fs) => {
          if (gen !== faultGen || !ctx) return;
          faults = fs;
          renderTree();
          renderProps();
          const f = wwShow && bc.get().overlays.wrongWire ? wwShow : null;
          if (f) f(faults[0]);
        })
        .catch((e) => console.warn("wiring fault solve failed", e));
    const by = faultByWire(faults);
    for (const id of shownFaults)
      if (!by.has(id)) c.session.pick.setWireFault?.(id, null);
    for (const [id, f] of by) c.session.pick.setWireFault?.(id, f.short);
    shownFaults = new Set(by.keys());
    // Rewired wires move to the new pin in 3D; rewire() handles reverts and setScene rebuilds itself.
    const moved = benchWires().filter((w) => w.from);
    const now = new Set(moved.map((w) => w.id));
    for (const id of shownRewire)
      if (!now.has(id)) c.session.pick.rewire?.(id, null);
    for (const w of moved) c.session.pick.rewire?.(w.id, w.a);
    shownRewire = now;
    const jumps = benchWires().filter((w) => w.part === "jumper");
    const nowJ = new Set(jumps.map((w) => w.id));
    for (const id of shownBridge)
      if (!nowJ.has(id)) c.session.pick.bridge?.(id, "", null);
    for (const w of jumps) c.session.pick.bridge?.(w.id, w.a, w.b);
    shownBridge = nowJ;
    // Issues tab: wiring check results (prefix wire:; brownout entries are written by main.tsx).
    const issues: Issue[] = faults.map((f, i) => ({
      id: `wire:${f.rule}:${i}`,
      level: f.level,
      title: f.title,
      detail: f.short,
      go: () => select({ kind: "wire", id: f.wires[0] }),
    }));
    const keep = bc.get().issues.filter((x) => !x.id.startsWith("wire:"));
    if (
      JSON.stringify(issues.map((x) => [x.id, x.detail])) !==
      JSON.stringify(
        bc
          .get()
          .issues.filter((x) => x.id.startsWith("wire:"))
          .map((x) => [x.id, x.detail]),
      )
    )
      setBc({ issues: [...keep, ...issues] });
  }

  // ------------------------------------------------------------ Left column: Parts, Wiring table, checkpoint card (U-04)
  /** What the checkpoint "take me there" targets: the judged pin, else the I2C device. */
  function cpTarget(l: Level | undefined): Selection | null {
    if (!l) return null;
    const pin = l.pwm?.pin ?? l.gpio_toggles?.pin ?? l.ws2812?.pin;
    if (pin !== undefined) return { kind: "pin", id: `GPIO${pin}` };
    const parts = ctx!.session.scene.parts;
    if (
      (l.oled_min_pixels || l.expect?.length) &&
      parts.some((p) => p.type === "oled")
    )
      return { kind: "part", id: "oled" };
    if (l.numeric?.length && parts.some((p) => p.type === "bme280"))
      return { kind: "part", id: "bme280" };
    return null;
  }
  function renderLeft() {
    const c = ctx!;
    const s = c.store.get();
    const wires = benchWires();
    const bad = new Map<string, string>();
    for (const f of faults)
      for (const w of f.wires) if (!bad.has(w)) bad.set(w, f.short);
    const n = c.work.checkpoints.length;
    const d = passedCount(c, s);
    let card: ReactNode = null;
    if (c.custom)
      card = (
        <CustomCheckCard
          levels={c.custom.levels}
          done={d}
          total={n}
          state={(id) => {
            const r = s.checks[id];
            return s.verifying === id ? "run" : r?.ok ? (r.own ? "ok" : "ref") : r && !r.ok ? "bad" : "todo";
          }}
          onPick={(id) => select({ kind: "checkpoint", id })}
          onExport={exportCheckpoints}
          onBuy={n && d === n ? openBuy : null}
        />
      );
    else if (n && d === n)
      card = (
        <AllPassedCard total={n} own={ownCount(c, s)} retest={s.assembly?.retest} onNext={() => (location.hash = "assemble")} />
      );
    else if (n) {
      const id =
        c.work.checkpoints.find((x) => !s.checks[x]?.ok) ??
        c.work.checkpoints[0];
      const l = c.session.levels.find((x) => x.id === id);
      const tg = cpTarget(l);
      card = (
        <CheckpointCard
          id={id}
          title={l?.title ? t(l.title) : ""}
          pass={l?.pass ? t(l.pass) : ""}
          done={d}
          total={n}
          go={tg ? (tg.kind === "pin" ? tg.id : partName(tg.id)) : null}
          onGo={() => {
            select(tg ?? { kind: "checkpoint", id });
            if (tg)
              requestAnimationFrame(() => ctx?.session.bench.view?.("fit", tg));
          }}
          onAll={() => setDock({ tab: "checks", collapsed: false })}
          own={ownCount(c, s)}
          allBusy={demoBusy || !!s.verifying}
          onAllRef={actions.runAllRef ?? null}
          onMine={() => select({ kind: "checkpoint", id })}
        />
      );
    }
    const sel = s.selection?.kind === "wire" ? s.selection.id : null;
    setLeft({
      lib: (
        <PartLib
          chip={c.session.chip}
          inBom={new Set(replay(s.bom).picks.map((p) => p.partId))}
          onPlace={startPlace}
        />
      ),
      wires: (
        <WireTable
          wires={wires}
          bad={bad}
          sel={sel}
          onSel={(id) => select({ kind: "wire", id })}
        />
      ),
      wireCount: wires.length,
      card,
    });
  }

  // ------------------------------------------------------------ Wire tool (U-04): rewire the dev-board end of a wire
  function wireUi() {
    const c = ctx!;
    if (!wiring) {
      overlay("wire", null);
      overlay("rings", null);
      return;
    }
    const w = wiring.wire
      ? benchWires().find((x) => x.id === wiring!.wire)
      : null;
    const pickable = benchWires().filter((x) => !x.missing);
    overlay(
      "wire",
      <WireBanner
        wire={w ? t("{wire} (now {pin})", { wire: w.b, pin: w.a }) : null}
        onCancel={() => setWiring(false)}
        wires={pickable.map((x) => ({ id: x.id, label: `${x.b} · ${x.a}` }))}
        onWire={(id) => {
          if (!wiring) return;
          wiring.wire = id;
          c.session.pick.highlight?.({ kind: "wire", id });
          wireUi();
        }}
        onUndo={bc.get().undo && actions.undo ? () => actions.undo?.() : null}
      />,
    );
    if (!w) return overlay("rings", null);
    const wires = benchWires().filter((x) => !x.missing);
    const pins: RingPin[] = (c.session.pick.listPins?.() ?? []).map((p) => ({
      ...p,
      used: wires.filter((x) => x.a === p.id && x.id !== w.id).map((x) => x.b),
    }));
    overlay(
      "rings",
      <PinRings
        pins={pins}
        cur={w.a}
        project={ringProject}
        onPin={(id) => retarget(w.id, id)}
      />,
    );
  }
  const ringProject = (id: string) =>
    ctx?.session.pick.project?.({ kind: "pin", id }) ?? null;
  function setWiring(on: boolean, wire: string | null = null) {
    const c = ctx!;
    if (on) {
      if (ruler) setRuler(false);
      if (meter) setMeter(false);
      closeCard();
    }
    wiring = on ? { wire } : null;
    c.shell.toolbar.setActive(on ? "wire" : "select");
    if (on && wire) c.session.pick.highlight?.({ kind: "wire", id: wire });
    else if (!on) c.session.pick.highlight?.(toPick(c.store.get().selection));
    wireUi();
  }
  /** Record a rewire in the timeline (no power cycle: the sim keeps scene wiring; only bench and wiring check change). */
  function applyMods(mods: WireMods, label: string) {
    const c = ctx!;
    c.hist?.op({ k: "wiring", mods, scene: c.session.scene, label });
    c.session.setWireMods(mods);
    recheckWiring();
  }
  function retarget(wireId: string, to: string) {
    const c = ctx!;
    const prev = c.session.wireMods;
    const w = benchWires().find((x) => x.id === wireId);
    if (!w) return;
    const orig = w.from ?? w.a;
    if (to === w.a) {
      c.shell.toast(t("{wire} is already on {pin}", { wire: w.b, pin: to }));
      return;
    }
    const rt = { ...prev.retarget };
    if (to === orig) delete rt[wireId];
    else rt[wireId] = to;
    applyMods({ ...prev, retarget: rt }, t("Rewire {wire} to {pin}", { wire: w.b, pin: to }));
    setWiring(false);
    select({ kind: "wire", id: wireId });
    const fs = faults.filter((f) => f.wires.includes(wireId));
    if (!fs.length) {
      c.shell.toast(
        to === orig
          ? t("{wire} back on {pin}, wiring check found no problems", { wire: w.b, pin: to })
          : t("{wire} rewired to {pin}, wiring check found no problems (the simulator still runs the original wiring)", { wire: w.b, pin: to }),
      );
      return;
    }
    showWrongWire(
      fs[0],
      wireId,
      `${w.b}: ${w.a} → ${to}`,
      () => {
        applyMods(prev, t("Undo rewire of {wire}", { wire: w.b }));
      },
      () => {
        applyMods(prev, t("Undo rewire of {wire}", { wire: w.b }));
        setWiring(true, wireId);
      },
    );
  }
  /** Wrong-wire card (U-04); redrawn with the same wire's new result when the async net estimate arrives (P2-14). */
  function showWrongWire(
    first: WireFault,
    wireId: string,
    label: string,
    undo: () => void,
    retry: () => void,
  ) {
    const close = () => {
      wwShow = null;
      overlay("wrongWire", null);
    };
    const show = (f: WireFault) =>
      overlay(
        "wrongWire",
        <WrongWireCard
          title={f.title}
          detail={f.detail}
          wire={label}
          estimate={f.estimate}
          sim={t("Confidence: {conf} ({basis}). The simulator still runs the original wiring; this is only a wiring check.", { conf: confOfRule(f.confidence), basis: f.confidence })}
          onUndo={() => {
            close();
            undo();
          }}
          onRetry={() => {
            close();
            retry();
          }}
          onKeep={close}
        />,
      );
    wwShow = () => {
      const f = faults.find(
        (x) => x.wires.includes(wireId) && x.rule === first.rule,
      );
      if (f) show(f);
    };
    show(first);
  }

  // ------------------------------------------------------------ Direct placement on the bench (P2-16)
  function startPlace(id: string) {
    const c = ctx;
    if (!c || c.store.get().step !== "bench") return;
    const d = placeDef(id);
    if ("why" in d) return c.shell.toast(d.why);
    const clash = placeConflict(d, c.session.scene);
    if (clash) return c.shell.toast(clash);
    if (wiring) setWiring(false);
    if (ruler) setRuler(false);
    if (meter) setMeter(false);
    closeCard();
    overlay("wrongWire", null);
    placing = { def: d, cur: 0, got: {}, skipped: new Set() };
    overlay("empty", null);
    c.shell.toolbar.setActive("place");
    placeUi();
  }
  function endPlace() {
    placing = null;
    overlay("place", null);
    overlay("rings", null);
    if (ctx) renderTree();
    ctx?.shell.toolbar.setActive("select");
  }
  function placeUi() {
    const c = ctx!;
    const p = placing;
    if (!p) return endPlace();
    const step = p.def.steps[p.cur];
    overlay(
      "place",
      <PlaceBanner
        name={p.def.name}
        steps={p.def.steps}
        cur={p.cur}
        got={p.got}
        onStep={(i) => {
          if (!placing) return;
          placing.cur = i;
          placing.skipped.delete(placing.def.steps[i].pin);
          placeUi();
        }}
        onSkip={
          step.optional
            ? () => {
                if (!placing) return;
                placing.skipped.add(step.pin);
                delete placing.got[step.pin];
                placeNext();
              }
            : null
        }
        onBack={
          p.cur > 0
            ? () => {
                if (!placing) return;
                placing.cur--;
                placeUi();
              }
            : null
        }
        onCancel={() => {
          endPlace();
          c.shell.toast(t("{part} not placed", { part: p.def.name }));
        }}
      />,
    );
    const wires = benchWires().filter((x) => !x.missing);
    const pins: RingPin[] = (c.session.pick.listPins?.() ?? [])
      .filter((x) => pinOk(step.want, x.id))
      .map((x) => ({
        ...x,
        used: [
          ...wires.filter((w) => w.a === x.id).map((w) => w.b),
          ...Object.entries(p.got)
            .filter(([k, v]) => v === x.id && k !== step.pin)
            .map(([k]) => `${p.def.name} ${k}`),
        ],
      }));
    overlay(
      "rings",
      <PinRings
        pins={pins}
        cur={p.got[step.pin] ?? null}
        project={ringProject}
        onPin={placePin}
      />,
    );
  }
  function placePin(id: string) {
    const c = ctx!;
    const p = placing;
    if (!p) return;
    const step = p.def.steps[p.cur];
    if (!pinOk(step.want, id))
      return c.shell.toast(
        step.want === "gnd"
          ? t("{pin} must go to GND", { pin: step.label })
          : step.want === "power"
            ? t("{pin} must go to 3V3 or 5V", { pin: step.label })
            : t("{pin} must go to a GPIO", { pin: step.label }),
      );
    // Two signal lines of one part on the same GPIO (SDA tied to SCL) is meaningless: block it.
    const dup = Object.entries(p.got).find(([k, v]) => v === id && k !== step.pin);
    if (step.want === "gpio" && dup)
      return c.shell.toast(t("{gpio} is already wired to {pin} of {part}", { gpio: id, pin: dup[0], part: p.def.name }));
    p.got[step.pin] = id;
    placeNext();
  }
  function placeNext() {
    const p = placing;
    if (!p) return;
    const next = p.def.steps.findIndex(
      (s) => !p.got[s.pin] && !p.skipped.has(s.pin),
    );
    if (next >= 0) {
      p.cur = next;
      return placeUi();
    }
    finishPlace();
  }
  function finishPlace() {
    const c = ctx!;
    const p = placing!;
    const ext5v = !!c.session.power?.ext5v;
    const { spec, retarget } = buildPlaced(p.def, p.got, ext5v);
    const pid = partId(spec);
    if (c.session.scene.parts.some((x) => partId(x) === pid)) {
      // LEDs / buttons are keyed by pin: this GPIO already has one.
      const i = p.def.steps.findIndex((s) => s.want === "gpio");
      c.shell.toast(t("{gpio} already has a {part}: pick another GPIO", { gpio: p.got[p.def.steps[i].pin], part: p.def.name }));
      delete p.got[p.def.steps[i].pin];
      p.cur = i;
      return placeUi();
    }
    const sum = p.def.steps
      .filter((s) => p.got[s.pin] && s.want === "gpio")
      .map((s) => `${s.pin}→${p.got[s.pin]}`)
      .join(" ");
    endPlace();
    c.session.applyScene(
      { ...c.session.scene, parts: [...c.session.scene.parts, spec] },
      c.session.power ?? { ext5v: false },
      sum ? t("Place {part} ({pins})", { part: p.def.name, pins: sum }) : t("Place {part}", { part: p.def.name }),
    );
    const rt = Object.entries(retarget);
    if (rt.length)
      applyMods(
        mergeMods(c.session.wireMods, retarget),
        t("{part} power on {pins}", { part: p.def.name, pins: rt.map(([, v]) => v).join(", ") }),
      );
    recheckWiring();
    renderLeft();
    select({ kind: "part", id: pid });
    const fs = faults.filter((f) => f.wires.some((w) => w.includes(`~${pid}:`)));
    c.shell.toast(
      fs.length
        ? t("Placed {part}: wiring check found \"{issue}\", see the Issues tab", { part: p.def.name, issue: fs[0].title })
        : t("Placed {part}, wiring check found no problems", { part: p.def.name }),
    );
  }

  // ------------------------------------------------------------ Build tree
  function renderTree() {
    const c = ctx!;
    const s = c.store.get();
    const ses = c.session;
    const parts = ses.scene.parts;
    const wires = benchWires();
    const byWire = faultByWire(faults);
    const item = (
      sel: Selection,
      label: ReactNode,
      meta: ReactNode = "",
      status: ReactNode = null,
    ) => (
      <TreeNode
        key={`${sel.kind}:${sel.id}`}
        on={selEq(s.selection, sel)}
        data-kind={sel.kind}
        data-id={sel.id}
        label={label}
        meta={meta}
        st={status}
        onClick={() => {
          select(sel);
          phoneProps();
        }}
      />
    );
    const group = (
      key: string,
      title: string,
      count: ReactNode,
      body: ReactNode,
    ) => (
      <TreeGroup
        g={key}
        title={title}
        count={count}
        open={!!openGroups[key]}
        onToggle={(o) => (openGroups[key] = o)}
      >
        {body}
      </TreeGroup>
    );
    const board = BOARD_NAME[ses.chip];
    const partItems = [
      item(
        { kind: "part", id: "board" },
        board,
        CHIP_SHORT[ses.chip],
      ),
      ...parts.map((p) =>
        item(
          { kind: "part", id: partId(p) },
          partInfo(p).name,
          p.type === "bme280" || p.type === "oled"
            ? hex(p.addr)
            : "pin" in p
              ? `GPIO${p.pin}`
              : p.type === "encoder"
                ? `GPIO${p.a}/${p.b}`
                : p.type === "hcsr04"
                  ? `GPIO${p.trig}/${p.echo}`
                  : "",
        ),
      ),
    ];
    // Pins: only used ones (wired, or with an on-board role such as BOOT or the RGB LED).
    const pinInfo = ses.pick.listPins?.() ?? [];
    const used = new Set(usedPins(wires));
    const pins = pinInfo.filter((p) => used.has(p.id) || p.role);
    const pinItems = pins.length ? (
      pins.map((p) =>
        item(
          { kind: "pin", id: p.id },
          <Mono>{p.id}</Mono>,
          p.role ?? wires.find((w) => w.a === p.id)?.role ?? "",
        ),
      )
    ) : (
      <TreeEmpty>{t("No pins in use")}</TreeEmpty>
    );
    const wireItems = wires.length ? (
      wires.map((w) =>
        item(
          { kind: "wire", id: w.id },
          `${w.a} → ${w.b}`,
          w.color,
          byWire.has(w.id) ? <TnSt kind="bad">✗</TnSt> : null,
        ),
      )
    ) : (
      <TreeEmpty>{t("No external wires")}</TreeEmpty>
    );
    const nBad = new Set(faults.flatMap((f) => f.wires)).size;
    const wireCount = nBad ? (
      <Bad>{t("{n} · issues: {m}", { n: wires.length, m: faults.length })}</Bad>
    ) : (
      `${wires.length} · ✓`
    );
    const env = s.env;
    const cps = c.work.checkpoints.map((id) => {
      const l = ses.levels.find((x) => x.id === id);
      const r = s.checks[id];
      const st =
        s.verifying === id ? (
          <TnSt kind="run">…</TnSt>
        ) : r ? (
          r.ok ? (
            <TnSt kind="ok">{r.own ? "✓" : "◐"}</TnSt>
          ) : (
            <TnSt kind="bad">✗</TnSt>
          )
        ) : null;
      return item(
        { kind: "checkpoint", id },
        <>
          <Mono>{id}</Mono> {l?.title ? t(l.title) : ""}
        </>,
        "",
        st,
      );
    });
    const runs = c.hist?.runs() ?? [];
    const runItems = runs.length ? (
      runs.map((r) =>
        item(
          { kind: "run", id: String(r.n) },
          t("Run #{n}", { n: r.n }),
          r.snap ? `${r.snap.simSeconds.toFixed(1)} s` : t("Running"),
          r.n === s.runNo && s.hist.seeked ? <TnSt kind="run">◂</TnSt> : null,
        ),
      )
    ) : (
      <TreeEmpty>{t("Not run yet")}</TreeEmpty>
    );
    const ext = !!ses.power?.ext5v;
    const hasServo = parts.some((p) => p.type === "servo");
    c.shell.tree.render(
      <div role="group" aria-label={t("Build tree")}>
        {group("part", t("Parts"), String(parts.length + 1), partItems)}
        {group("pin", t("Pins"), String(pins.length), pinItems)}
        {group("wire", t("Wires"), wireCount, wireItems)}
        {group(
          "power",
          t("Power supply"),
          ext ? t("USB and external") : "USB",
          <>
            {item({ kind: "power", id: "usb" }, t("USB 5 V (computer)"), "5V")}
            {ext
              ? item(
                  { kind: "power", id: "ext5v" },
                  t("External 5 V 2 A (servo)"),
                  "EXT5V",
                )
              : hasServo
                ? item(
                    { kind: "power", id: "ext5v" },
                    <Muted>{t("External 5 V (not connected)")}</Muted>,
                    "",
                  )
                : null}
          </>,
        )}
        {group(
          "env",
          t("Environment"),
          "",
          item(
            { kind: "env", id: "room" },
            t("Indoors"),
            <Mono>{`${env.temp.toFixed(1)} °C`}</Mono>,
            ses.heat ? <TnSt kind="bad">{t("Hot")}</TnSt> : null,
          ),
        )}
        {bleFeed.get().state !== 0 &&
          group(
            "ble",
            t("Wireless"),
            "",
            item(
              { kind: "ble", id: "phone" },
              t("Virtual phone"),
              phoneStateText(bleFeed.get()),
              bleFeed.get().state === 2 ? <TnSt kind="warn">!</TnSt> : null,
            ),
          )}
        {group(
          "firmware",
          t("Firmware"),
          "",
          ses.fwName
            ? item(
                { kind: "firmware", id: "main" },
                ses.fwName,
                ses.fwSize ? `${(ses.fwSize / 1024).toFixed(0)} KB` : "",
              )
            : item(
                { kind: "firmware", id: "main" },
                t("No firmware yet"),
                t("Drop a .bin here"),
              ),
        )}
        {group("run", t("Run history"), String(runs.length), runItems)}
        {c.work.checkpoints.length
          ? group(
              "checkpoint",
              t("Checkpoints"),
              `${passedCount(c, s)}/${c.work.checkpoints.length}`,
              cps,
            )
          : null}
      </div>,
    );
    renderLeft();
    // Empty-bench guide: only the dev board, no parts yet (fresh blank bench).
    overlay(
      "empty",
      // Hidden while placing: the guide card would cover the board pins.
      parts.length || placing ? null : (
        <EmptyBench
          hasFw={!!ses.fwName}
          onFirmware={openFwMenu}
        />
      ),
    );
    // Custom-board project: after auto-placing, explain what was placed and ask for firmware (hidden once firmware is in, closed, or placing).
    if (c.custom)
      overlay(
        "customPlaced",
        parts.length && !placing && !customClosed && !ses.fwBuf ? (
          <CustomPlacedCard
            n={parts.length}
            sub={c.custom.plan.sub}
            demo={c.custom.plan.demo}
            busy={demoBusy}
            onFirmware={openFwMenu}
            onBrief={() => void actions.brief?.()}
            onDemo={() => void runDemo()}
            onClose={() => {
              customClosed = true;
              renderTree();
            }}
          />
        ) : null,
      );
  }

  // ------------------------------------------------------------ Inspector
  /** Banner atop the inspector at a seek point: where we are, whether the fingerprint matches, resume from here. */
  function seekBanner(): ReactNode {
    const c = ctx!;
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
    ctx!.shell.props.render(
      <>
        {seekBanner()}
        {body}
      </>,
    );
    if (live) updateLive();
  }

  function renderProps() {
    const c = ctx!;
    const s = c.store.get();
    const sel = s.selection;
    if (!sel && exInfo) renderExample();
    else if (!sel)
      show(
        <>
          <Sec>{t("Properties")}</Sec>
          <TreeEmpty>{t("Click the build tree on the left or a part on the bench")}</TreeEmpty>
        </>,
        false,
      );
    else if (sel.kind === "checkpoint") renderCheckpoint(sel.id);
    else if (sel.kind === "env") renderEnv();
    else if (sel.kind === "firmware") renderFirmware();
    else if (sel.kind === "power") renderPower(sel.id);
    else if (sel.kind === "wire") renderWire(sel.id);
    else if (sel.kind === "pin") renderPin(sel.id);
    else if (sel.kind === "button") renderButton(sel.id);
    else if (sel.kind === "run") renderRuns(Number(sel.id));
    else if (sel.kind === "tool")
      sel.id === "meter" ? renderMeter() : renderRuler();
    // The virtual phone subscribes to bleFeed itself; the inspector mounts it once on select.
    else if (sel.kind === "ble")
      show(<PhonePanel send={(cmd) => actions.ble?.(cmd)} />, false);
    else renderPart(sel.id);
  }

  /** Live power-net readings (tryboard-elec node voltages/currents; min / peak / resets since power-on). */
  const elecRows = (
    ext: boolean,
    hasServo: boolean,
    hasAmp = ctx!.session.scene.parts.some((p) => p.type === "max98357a"),
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
    const c = ctx!;
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
    const c = ctx!;
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
    const c = ctx!;
    const w = benchWires().find((x) => x.id === id);
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
    const fs = faults.filter((f) => f.wires.includes(id));
    const power = w.part === "servo" && w.pinRole === "power";
    // I2C wires can be lengthened (P2-11): bus capacitance sums the SDA wires of every module on the bus.
    const bus =
      w.pinRole === "bus"
        ? i2cBuses(c.session.scene.parts, benchWires()).find((b) =>
            b.parts.includes(w.part),
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
    const c = ctx!;
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
    const ses = ctx!.session;
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
      {powerSeg(!!ctx!.session.power?.ext5v)}
    </>
  );

  // ------------------------------------------------------------ Pins (P0-11)
  function renderPin(id: string) {
    const c = ctx!;
    const pin = c.session.pick.listPins?.().find((p) => p.id === id);
    const wires = benchWires().filter((w) => w.a === id && !w.missing);
    const kind = pinKind(id, wires);
    const gpio = /^GPIO(\d+)$/.exec(id);
    trace.watch(gpio ? Number(gpio[1]) : -1);
    const to = wires.map((w) => `${partName(w.part)} · ${w.pin}`).join("; ");
    const fs = faults.filter((f) =>
      f.wires.some((x) => wires.some((w) => w.id === x)),
    );
    show(
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
              <Btn data-ana={id} onClick={() => getAnalyzer(c).open(id)}>
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
            {fs.map(faultEl)}
          </>
        )}
      </>,
    );
  }
  /** GPIO behind the BOOT key: GPIO9 on C3, GPIO0 on ESP32 / S3. */
  const bootGpio = () => BOOT_GPIO[ctx!.session.chip];
  const partName = (pid: string) => {
    const p = ctx!.session.scene.parts.find((x) => partId(x) === pid);
    return p ? partInfo(p).name : pid;
  };

  /** Press / release BOOT: the buttons' pressed state is set directly (no panel redraw). */
  const pressBootBtn = (
    e: React.MouseEvent<HTMLButtonElement>,
    down: boolean,
  ) => {
    ctx!.session.pressBoot(down);
    e.currentTarget
      .parentElement!.querySelectorAll<HTMLButtonElement>("[data-boot]")
      .forEach((x) =>
        x.setAttribute(
          "aria-pressed",
          String((x.dataset.boot === "down") === down),
        ),
      );
    ctx!.shell.toast(
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
    const c = ctx!;
    show(
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

  // ------------------------------------------------------------ Run history (P0-13)
  function renderRuns(n: number) {
    const c = ctx!;
    const runs = c.hist?.runs() ?? [];
    const a = runs.find((r) => r.n === n);
    if (!a) {
      show(
        <>
          <Sec>{t("Run history")}</Sec>
          <TreeEmpty>{t("No run #{n}", { n })}</TreeEmpty>
        </>,
        false,
      );
      return;
    }
    const sa = summarize(a);
    const b =
      cmpRun !== null && cmpRun !== n
        ? runs.find((r) => r.n === cmpRun)
        : undefined;
    const list = runs.map((r) => {
      const x = summarize(r);
      const tag = r.n === n ? "A" : r.n === cmpRun ? "B" : "";
      return (
        <button
          key={r.n}
          type="button"
          className={cn(
            "runrow flex cursor-pointer items-start gap-2 rounded-md border border-line-soft bg-field px-2 py-1.5 text-left text-xs text-fg hover:border-hover-line",
            tag && "on border-accent-line bg-accent-bg",
          )}
          data-run={r.n}
          onClick={() => {
            if (r.n === n) return;
            cmpRun = r.n;
            renderProps();
          }}
        >
          <span className="rk w-3 flex-none font-mono font-medium text-accent-ink">
            {tag || "·"}
          </span>
          <span className="rt min-w-0 break-all">
            <b className="font-medium">{t("Run #{n}", { n: r.n })}</b> <Muted>{x.fw}</Muted>
            <br />
            <Mono>{x.env0}</Mono> · {x.power}
            <br />
            <span className="fp font-mono text-[11px] text-muted">
              {x.fingerprint}
            </span>
          </span>
        </button>
      );
    });
    let cmp: ReactNode = null;
    if (b) {
      const d = diffRuns(sa, summarize(b));
      const nCh = d.filter((x) => x.changed).length;
      const drow =
        "drow grid grid-cols-[72px_1fr_1fr] gap-1.5 rounded-md bg-field px-2 py-1 [&>span]:min-w-0 [&>span]:[overflow-wrap:anywhere]";
      cmp = (
        <>
          <Sec>{t("Differences: {n} (marked ≠)", { n: nCh })}</Sec>
          <div className="diff flex flex-col gap-0.5 text-xs">
            <div
              className={cn(
                drow,
                "hd bg-transparent py-0 text-[11px] text-muted",
              )}
            >
              <span className="k" />
              <span>A #{a.n}</span>
              <span>B #{b.n}</span>
            </div>
            {d.map((x) => {
              const mono =
                x.key === "fingerprint" || x.key === "result"
                  ? "font-mono text-[11px]"
                  : "";
              return (
                <div
                  key={x.key}
                  className={cn(drow, x.changed && "ch bg-(--ch-bg)")}
                >
                  <span
                    className={cn(
                      "k text-muted",
                      x.changed && "font-medium text-warn-ink",
                    )}
                  >
                    {x.changed ? "≠ " : ""}
                    {x.label}
                  </span>
                  <span className={mono}>{x.a}</span>
                  <span className={mono}>{x.b}</span>
                </div>
              );
            })}
          </div>
        </>
      );
    }
    const step = (c.hist?.steps() ?? []).findIndex(
      (s: BenchStep) => s.op.k === "run" && s.op.n === n,
    );
    // With a comparison, differences come first; single-run details stay in the list below.
    const detail = b ? null : (
      <>
        <Kv k={t("Firmware")} v={sa.fw} />
        <Kv k={t("Environment at power-on")} v={sa.env0} />
        <Kv k={t("Environment changes while running")} v={`${sa.envChanges}×`} />
        <Kv k={t("Power supply")} v={sa.power} />
        <Kv k={t("Heat source")} v={sa.heat} />
        <Kv k={t("Simulated time")} v={sa.seconds} />
        <KvT k={t("Last line")}>
          <Mono>{sa.result}</Mono>
        </KvT>
        <Kv k={t("Run ID")} v={sa.fingerprint} cls="fp" />
      </>
    );
    show(
      <>
        <Sec>{t("Run history")}</Sec>
        <Ph>
          {b ? t("Run #{a} ↔ run #{b}", { a: a.n, b: b.n }) : t("Run #{n}", { n: a.n })}
        </Ph>
        {detail}
        {cmp}
        <Btns>
          <Btn
            id="gotoRun"
            disabled={step < 0}
            onClick={() => step >= 0 && c.hist?.seek(step)}
          >
            {t("Back to run #{n}", { n: a.n })}
          </Btn>
          {b && (
            <Btn
              id="cmpOff"
              onClick={() => {
                cmpRun = null;
                renderProps();
              }}
            >
              {t("Stop comparing")}
            </Btn>
          )}
        </Btns>
        <Sec>{t("All runs · click one to compare with A")}</Sec>
        <div className="runs flex flex-col gap-1">{list}</div>
      </>,
      false,
    );
  }

  // ------------------------------------------------------------ Multimeter (P1-04)
  function renderMeter() {
    const m = meter;
    const pickPin = (pin: string) => {
      meter = { target: pin };
      renderMeter();
      meterCard();
    };
    show(
      <>
        <Sec>{t("Multimeter · DC voltage")}</Sec>
        <Ph>
          {m?.target ? (
            <>
              <Mono>{m.target}</Mono> {t("to GND")}
            </>
          ) : (
            t("Click a pin on the bench")
          )}
        </Ph>
        <Meter />
        <Live
          as="p"
          k="mnote"
          init={t("Black probe on GND, red probe on a power or signal pin. Readings are estimates.")}
          className="note my-2 text-xs text-muted"
        />
        <Kv k={t("3V3 minimum (this power-on)")} live="emin" />
        <Kv k={t("Brownout resets")} live="ers" />
        <Btns>
          <Btn data-mpin="3V3" onClick={() => pickPin("3V3")}>
            {t("Measure 3V3")}
          </Btn>
          <Btn data-mpin="5V" onClick={() => pickPin("5V")}>
            {t("Measure 5V")}
          </Btn>
          {ctx!.session.scene.parts.some((p) => p.type === "servo") && (
            <Btn data-mpin="servo:VCC" onClick={() => pickPin("servo:VCC")}>
              {t("Measure servo red wire")}
            </Btn>
          )}
        </Btns>
      </>,
    );
  }
  function setMeter(on: boolean) {
    const c = ctx!;
    if (on && ruler) setRuler(false);
    if (on && wiring) setWiring(false);
    meter = on ? { target: meter?.target ?? null } : null;
    meterCard();
    c.shell.toolbar.setActive(on ? "meter" : "select");
    closeCard();
    if (on) select({ kind: "tool", id: "meter" });
    else if (c.store.get().selection?.kind === "tool") select(null);
  }
  /** Pinned multimeter card (bench bottom-right); updateLive fills the reading. */
  function meterCard() {
    overlay(
      "meter",
      meter ? (
        <MeterCard target={meter.target} onClose={() => setMeter(false)} />
      ) : null,
    );
    if (meter) updateLive();
  }
  /** Pick → probed node (a wire maps to its dev-board end; the servo red wire is its own node). */
  function meterTarget(t: PickTarget): string | null {
    if (t.kind === "pin") return t.id;
    if (t.kind === "wire") {
      if (/servo:VCC/.test(t.id)) return "servo:VCC";
      return benchWires().find((w) => w.id === t.id)?.a ?? null;
    }
    return null;
  }
  function meterReading() {
    const c = ctx!;
    const id = meter?.target;
    if (!id) return null;
    return meterVolts(
      id,
      c.session.frame.elec,
      c.session.frame,
      !!c.session.power?.ext5v,
    );
  }

  // ------------------------------------------------------------ Ruler (P0-13)
  const pickName = (x: PickTarget) =>
    x.kind === "part"
      ? x.id === "board"
        ? t("Dev board chip")
        : partName(x.id)
      : x.id;
  function renderRuler() {
    const r = ruler;
    const drift =
      r?.mm != null &&
      r.a &&
      r.b &&
      [r.a.id, r.b.id].includes("bme280") &&
      [r.a.id, r.b.id].includes("board")
        ? driftText(r.mm)
        : "";
    show(
      <>
        <Sec>{t("Ruler")}</Sec>
        <Note>
          {t("Click two parts, pins or wires on the bench in turn; click again after measuring to start over. Click Select in the toolbar to exit.")}
        </Note>
        <Kv k={t("Start")} v={r?.a ? pickName(r.a) : t("Click the first target")} />
        <Kv k={t("End")} v={r?.b ? pickName(r.b) : r?.a ? t("Click the second target") : "—"} />
        <Kv
          k={t("Distance")}
          v={r?.mm != null ? `${r.mm.toFixed(1)} mm` : "—"}
          cls="fp"
        />
        {drift && <KvT k={t("Heat bias")}>{drift}</KvT>}
        <Btns>
          <Btn id="rulerChip" onClick={() => measureChip()}>
            {t("Measure BME280 to chip")}
          </Btn>
        </Btns>
      </>,
      false,
    );
  }
  /** Closer to the chip reads higher: same offset as Assemble (+2.5 ℃ touching), fading linearly to 0 at 30 mm (estimate). */
  const driftOf = (mm: number) =>
    Math.max(0, Math.min(1, (30 - mm) / 25)) * CHIP_HEAT_OFFSET;
  const driftText = (mm: number) => {
    const d = driftOf(mm);
    return d < 0.05
      ? t("{mm} mm from the chip: chip heating is negligible. Touching the chip (within 5 mm) reads about {d} ℃ high (estimate)", { mm: mm.toFixed(1), d: CHIP_HEAT_OFFSET })
      : t("{mm} mm from the chip: reads about {d} ℃ high from heat (estimate, not calibrated on real hardware)", { mm: mm.toFixed(1), d: d.toFixed(1) });
  };
  function measureChip(): number | null {
    const mm =
      ctx!.session.pick.measure?.(
        { kind: "part", id: "bme280" },
        { kind: "part", id: "board" },
      ) ?? null;
    if (ruler) {
      ruler = {
        a: { kind: "part", id: "bme280" },
        b: { kind: "part", id: "board" },
        mm,
      };
      renderProps();
    }
    return mm;
  }

  // ------------------------------------------------------------ Encoder / ultrasonic (P2-01 / P2-04)
  const encRows = () => (
    <>
      <Kv k={t("Knob position")} live="encpos" />
      <Kv k={t("PCNT count (unit 0)")} live="pcnt" />
      <Kv k={t("Firmware reading")} live="encfw" />
    </>
  );
  const turn = (n: number) => {
    const c = ctx!;
    c.session.turnEncoder(n);
    c.session.bench.setEncoder((c.session.frame.pins?.encPos ?? 0) + n);
  };
  const encRelease = (b: HTMLButtonElement) => {
    if (b.getAttribute("aria-pressed") !== "true") return;
    ctx!.session.pressEncoder(false);
    b.setAttribute("aria-pressed", "false");
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
          ctx!.session.pressEncoder(true);
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
    const d = ctx!.session.distance;
    const set = (v: number) => {
      ctx!.session.setDistance(v);
      updateLive();
    };
    return (
      <>
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
              ctx!.session.setDistance(v);
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
    const c = ctx!;
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
    const t = ctx!.session.consoleText().slice(-3000);
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
      const c = ctx!;
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
    const v = ctx!.store.get().env[k];
    return (
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
    );
  };

  /** Heat source + distance to chip (inspector and quick card); the distance shows only in this block. */
  function HeatActs() {
    const [mm, setMm] = useState<number | null | undefined>(undefined);
    const heat = !!ctx!.session.heat;
    return (
      <>
        <Btns>
          <Btn data-act="heat" aria-pressed={heat} onClick={() => toggleHeat()}>
            {heat ? t("Remove heat source") : t("Add heat source")}
          </Btn>
          <Btn data-act="chip" onClick={() => setMm(measureChip())}>
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
                    {driftText(mm)}
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
        onClick={() => ctx!.session.setPose({ pitch: 0, roll: 0, yaw: 0 })}
      >
        {t("Level it")}
      </Btn>
    </Btns>
  );

  /** Set a temperature directly (number box, presets): one timeline step each. */
  function setTempNow(v: number) {
    const c = ctx!;
    const t = Math.min(45, Math.max(-10, Math.round(v * 10) / 10));
    if (!Number.isFinite(t) || t === c.store.get().env.temp) return;
    c.hist?.op({ k: "env", env: { ...c.store.get().env, temp: t } });
    c.session.setEnv({ temp: t });
    c.hist?.render();
  }
  function TempExact() {
    const v = ctx!.store.get().env.temp;
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

  function renderPart(id: string) {
    const c = ctx!;
    const ses = c.session;
    if (id === "board") {
      const rgb = RGB_GPIO[ses.chip];
      show(
        <>
          <Sec>{t("Dev board")}</Sec>
          <PartHead
            name={BOARD_NAME[ses.chip]}
            type="board"
          />
          <Kv
            k={t("Chip")}
            v={CHIP_DESC[ses.chip]}
          />
          <Kv k={t("Power supply")} v={t("USB 5 V stepped down to 3V3 by the LDO")} />
          <Kv k="3V3" live="e33" />
          <Kv k={t("3V3 total current (estimate)")} live="eic" />
          <Kv k={t("Brownout resets")} live="ers" />
          <Sec>{t("Live")}</Sec>
          <Kv k={t("Run")} live="run" />
          <Kv k={t("Simulated time")} live="sim" />
          {rgb !== null && <Kv k={t("On-board RGB (GPIO{n})", { n: rgb })} live="rgb" />}
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
      show(
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
          {envSlider("temp", t("Ambient temperature"), -10, 45, 0.5)}
          <TempExact />
          <HeatActs />
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
          {encRows()}
          <Sec>{t("Turn it")}</Sec>
          {encButtons()}
          <Note>
            {t("On the bench, drag the knob left/right or scroll to turn one step; hold to press. Confidence: simulation verified; contact bounce is not modeled.")}
          </Note>
        </>
      );
    } else if (p.type === "hcsr04") {
      live = (
        <>
          <Sec>{t("Live")}</Sec>
          {sonarRows()}
          <Sec>{t("Obstacle distance")}</Sec>
          {sonarControls()}
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
            <Btn data-div="" aria-pressed={!noDiv} onClick={toggleDivider}>
              {noDiv ? t("Refit divider resistors") : t("Remove divider resistors (see the wiring check alarm)")}
            </Btn>
          </Btns>
        </>
      );
    } else if (p.type === "mpu6050" || p.type === "qmi8658") {
      live = (
        <>
          <Sec>{t("Orientation · lift the breadboard")}</Sec>
          {poseSliders()}
          {levelBtn()}
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
    show(
      <>
        <Sec>{t("Part")}</Sec>
        <PartHead name={info.name} type={p.type} />
        <KvT k={t("Model")}>{info.model}</KvT>
        <KvT k={t("Interface")}>{info.iface}</KvT>
        <Kv k={t("Power supply")} v={info.power} />
        {live}
        {p.type === "servo" && powerInline()}
      </>,
    );
  }

  // ------------------------------------------------------------ Orientation (P2-03)
  const POSE_AXES: ["pitch" | "roll" | "yaw", string, number][] = [
    ["pitch", t("Pitch"), 90],
    ["roll", t("Roll"), 180],
    ["yaw", t("Yaw"), 180],
  ];
  function poseSliders(axes = POSE_AXES) {
    const pz = ctx!.store.get().pose;
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
              const c = ctx!;
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
    show(
      <>
        <Sec>{t("Environment")}</Sec>
        <Ph>{t("Indoors")}</Ph>
        <Note>{t("Change these and the sensor readings, serial output and OLED all follow.")}</Note>
        {ENV_ROWS.map(([k, n, min, max, step]) => (
          <KvBox key={k}>
            <span className="k">{n}</span>
            {envSlider(k, n, min, max, step)}
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

  /** "This example": about, tags, analog sliders (the .env ones are what regression scripts drag), plus a project using similar parts. */
  function renderExample() {
    const c = ctx!;
    const { ex, work } = exInfo!;
    const ctl = ex.controls ?? [];
    const analogs = ctl.filter((k): k is AnalogControl => typeof k === "object" && k.type === "analog");
    show(
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
                {ENV_ROWS.map(([k, n, min, max, step]) => (
                  <KvBox key={k}>
                    <span className="k">{n}</span>
                    {envSlider(k, n, min, max, step)}
                  </KvBox>
                ))}
                <Kv k={t("Firmware reading")} live="rt" />
              </>
            )}
            {analogs.map((a) => {
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
                </KvBox>
              );
            })}
            {ctl.includes("imu") && c.session.hasImu() && (
              <>
                <Sec>{t("Tilt the bench")}</Sec>
                {poseSliders()}
                <Kv k={t("Firmware reading")} live="ipr" />
              </>
            )}
          </div>
        )}
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
      ctx?.shell.toast(
        t("Cannot read {file}: {err}", { file: f.name, err: e instanceof Error ? e.message : String(e) }),
      ),
    );

  function renderFirmware() {
    const c = ctx!;
    const ses = c.session;
    show(
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
            renderTree();
            renderFirmware();
          })}
        />
      </>,
    );
  }

  function renderCheckpoint(id: string) {
    const c = ctx!;
    const s = c.store.get();
    const l = c.session.levels.find((x) => x.id === id);
    if (!l) {
      show(
        <>
          <Sec>{t("Checkpoint")}</Sec>
          <TreeEmpty>{t("No such checkpoint: {id}", { id })}</TreeEmpty>
        </>,
        false,
      );
      return;
    }
    const r = s.checks[id];
    const busy = s.verifying === id;
    const other = !!s.verifying && !busy;
    const st = busy ? undefined : stalled[id];
    // One primary action per card (DESIGN_V2 §9.5): failed → copy for AI to fix; own pass → next checkpoint.
    const idx = c.session.levels.findIndex((x) => x.id === id);
    const nextLv = c.session.levels
      .slice(idx + 1)
      .find((x) => !s.checks[x.id]?.ok || (r?.own && !s.checks[x.id]?.own));
    const runRef = async () => verify(l, await fetchBuf(`./fw/${l.ref}/flash.bin`), t("Reference firmware {name}", { name: l.ref ?? "" }), false);
    const stall = st ? (
      <>
        <Sec>{t("Check result")}</Sec>
        <ResultCard
          verdict="stall"
          title={t("This run did not finish")}
          why={
            r
              ? t("The simulation stalled and was stopped. This is not a fail; your code may be fine. The previous result is kept below.")
              : t("The simulation stalled and was stopped. This is not a fail; your code may be fine.")
          }
          extra={
            <p className="mt-1 mb-0 text-xs text-muted">
              {tn("Reason: {why} · firmware {fw} kept", { why: st.why, fw: <Mono>{st.who}</Mono> })}
            </p>
          }
          rows={[]}
        >
          <Btn id="retryCheck" primary className={actCls} disabled={other} onClick={() => verify(l, st.buf, st.who, st.own)}>
            {t("Run again")}
          </Btn>
        </ResultCard>
      </>
    ) : null;
    const result = busy ? (
      <>
        <Sec>{t("Check result")}</Sec>
        <RunningCard title={t(l.title)} progress={tn("Simulated {t}", { t: <Live k="vp" className="font-mono" /> })} />
      </>
    ) : r ? (
      <>
        <Sec>{t("Check result")}</Sec>
        <ResultCard
          verdict={r.ok ? "ok" : "bad"}
          meta={r.sim ? t("{who}, simulated {s} s", { who: r.who, s: r.sim.toFixed(1) }) : r.who}
          title={headline(r.rows)}
          why={
            r.ok && !r.own
              ? t("Reference firmware ran through (◐): it also unlocks Assemble and Product; passing with your own firmware turns it into ✓.")
              : undefined
          }
          rows={r.rows}
          runId={r.fingerprint}
          rawNote={
            <Note>
              {tn("Same firmware and same inputs give the same run ID on the web and in the CLI {cmd}.", { cmd: <Mono>npx tryboard check</Mono> })}
            </Note>
          }
        >
          {!r.ok && (
            <Btn primary data-act="fix" className={actCls} onClick={(e) => void copyFix(e.currentTarget, r.rows)}>
              {t("Copy for AI to fix")}
            </Btn>
          )}
          {!r.ok && r.own && l.ref && (
            <Btn data-act="compare" className={actCls} disabled={!!s.verifying} onClick={() => void runRef()}>
              {t("Compare with reference firmware")}
            </Btn>
          )}
          {r.ok && nextLv && (
            <Btn primary data-act="nextcp" className={actCls} onClick={() => select({ kind: "checkpoint", id: nextLv.id })}>
              {t("Next checkpoint: {title}", { title: t(nextLv.title) })}
            </Btn>
          )}
        </ResultCard>
      </>
    ) : null;
    /** Brief + raw failing lines (same as the CLI) so an AI can fix it directly. */
    const briefText = () =>
      t("{brief}\n\nPass condition: {pass}\nCheck: {cmd} (exit code 0 means pass)", { brief: t(l.brief), pass: t(l.pass), cmd: checkCommand(l) });
    const copyFix = async (b: HTMLButtonElement, rows: { ok: boolean | null; text: string }[]) => {
      const bad = rows.filter((x) => x.ok === false).map((x) => `- ${x.text}`).join("\n");
      const text = t("{brief}\n\nFailed in the last check:\n{bad}", { brief: briefText(), bad });
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = t("Copied, paste it to the AI");
      } catch {
        b.textContent = t("Cannot copy; copy the brief below by hand");
      }
    };
    const copy = async (b: HTMLButtonElement) => {
      const text = briefText();
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = t("Copied");
      } catch {
        const range = document.createRange();
        range.selectNodeContents(c.shell.props.el.querySelector(".brief")!);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        b.textContent = t("Selected, press ⌘C / Ctrl+C to copy");
      }
    };
    show(
      <>
        <Sec>{t("Checkpoint {id}", { id: l.id })}</Sec>
        <Ph>{t(l.title)}</Ph>
        <p className="goal mt-0 mb-1 text-muted">{t(l.goal)}</p>
        <Sec>{t("Pass condition")}</Sec>
        <Field>{t(l.pass)}</Field>
        <Sec className="edit-only">{t("Check")}</Sec>
        <Drop
          kind="check"
          busy={busy || other}
          disabled={busy || other}
          title={
            busy ? (
              tn("Simulating {t}", { t: <Live k="vp" className="font-mono" /> })
            ) : (
              t("Drop a .bin here")
            )
          }
          sub={
            busy
              ? t("Judged once it finishes")
              : other
                ? t("Another checkpoint is being checked, please wait")
                : t("Or click here to choose a file")
          }
          onFile={
            busy || other
              ? undefined
              : safeFile(async (f) =>
                  verify(l, await f.arrayBuffer(), f.name, true),
                )
          }
        />
        <Btns>
          {l.ref && (
            <Btn
              id="runRef"
              disabled={!!s.verifying}
              onClick={() => void runRef()}
            >
              {t("Try reference firmware")}
            </Btn>
          )}
          {l.ref && (
            <LinkBtn id="dlBin" href={`./fw/${l.ref}/flash.bin`} download={`${l.ref}.bin`} title={t("Flash to a real board: esptool.py write_flash 0x0")}>
              {t("Download reference .bin")}
            </LinkBtn>
          )}
          {l.ref && (
            <LinkBtn id="dlSrc" href={`./fw/${l.ref}/src.zip`} download={`${l.ref}-src.zip`} title={t("ESP-IDF 5.5 project; unzip and run idf.py build")}>
              {t("Download source zip")}
            </LinkBtn>
          )}
        </Btns>
        {stall}
        {result}
        <Sec>{t("Brief for the AI")}</Sec>
        <Brief>{t(l.brief)}</Brief>
        <Btns>
          <CopyBrief onCopy={(b) => void copy(b)} />
        </Btns>
        <Sec>{t("Check command")}</Sec>
        <Code>{checkCommand(l)}</Code>
        <Note>
          {t(
            "The command line gives the same verdict and run ID as the page; exit code 0 means pass. The tryboard CLI package is not on npm yet, so install it locally from packages/tryboard in the repository.",
          )}
        </Note>
      </>,
    );
  }

  async function verify(l: Level, buf: ArrayBuffer, who: string, own: boolean) {
    const c = ctx!;
    if (c.store.get().verifying) return;
    if (own) ownFirmware[l.id] = { buf: buf.slice(0), name: who };
    delete stalled[l.id];
    // -1 means the simulator (wasm / ROM) is still loading and the Worker has not started
    c.store.set({ verifying: l.id, verifyProgress: -1 });
    let out: CheckOutcome;
    try {
      const v = await verifyLevel(l, buf, (t) => {
        if (t - c.store.get().verifyProgress >= 0.1)
          c.store.set({ verifyProgress: t });
      });
      const rows: CheckOutcome["rows"] = v.results.map((x) => ({
        ok: x.ok,
        text: x.text,
        say: x.say,
        tag: x.tag,
        dev: x.dev,
      }));
      // Assembly checks are geometric estimates the CLI cannot judge, so the Assemble step owns them
      if (l.assembly)
        rows.push({
          ok: null,
          text: t("Assembly check (estimate) is judged in the Assemble step and not counted here"),
          say: t("Assembly is checked in the Assemble step, not here"),
          dev: t("Assembly"),
        });
      out = {
        ok: v.ok,
        who,
        own,
        rows,
        fingerprint: v.fingerprint,
        sim: v.sim,
      };
    } catch (e) {
      if (e instanceof VerifyStalled) {
        stalled[l.id] = { why: e.message, buf: buf.slice(0), who, own };
        c.store.set({ verifying: null });
        c.shell.toast(
          t("Checkpoint {id} did not finish this time; that is not a fail, run it again", { id: l.id }),
        );
        return;
      }
      out = {
        ok: false,
        who,
        own,
        rows: [
          {
            ok: false,
            text: t("Run failed: {err}", { err: String(e) }),
            say: t("The simulator hit an error and could not run this time"),
          },
        ],
        fingerprint: "—",
        sim: 0,
      };
    }
    // A reference pass still records progress (◐, unlocks Assemble / Product); saveProgress never overwrites your own pass
    if (out.ok) {
      saveProgress(wkey(c.work), l.id, out.fingerprint, own);
      buyArmed = true;
    }
    // A reference result must not replace a pass you earned yourself
    const prev = c.store.get().checks[l.id];
    const keep = prev?.own && prev.ok && !own;
    if (!keep) c.hist?.op({ k: "check", id: l.id, outcome: out });
    c.store.set((s) => ({
      verifying: null,
      checks: keep ? s.checks : { ...s.checks, [l.id]: out },
    }));
    if (keep)
      c.shell.toast(
        out.ok
          ? t("Reference firmware passed (run ID {fp}; your record is kept)", { fp: out.fingerprint })
          : t("Reference firmware did not pass (run ID {fp}; your record is kept)", { fp: out.fingerprint }),
      );
  }

  // ------------------------------------------------------------ live fields (no panel rebuild, so slider drags are not interrupted)
  function updateLive() {
    const c = ctx!;
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
    set("rp", rd ? `${rd.p.toFixed(2)} hPa` : "—");
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
    const em = lastLine(/ENC count=(-?\d+) detents=(-?\d+)/g);
    set(
      "encfw",
      em ? t("count={count} (detents: {n})", { count: em[1], n: em[2] }) : WAIT_FW,
    );
    const sm = lastLine(/DIST (?:([\d.]+) cm|out of range|no echo)/g);
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
    const mr = meterReading();
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
          if (o) o.textContent = fmtEnv[k](s.env[k]);
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
        const wires = benchWires().filter((w) => w.a === sel.id && !w.missing);
        const kind = pinKind(sel.id, wires);
        const v =
          sel.id === "3V3"
            ? 3.3
            : sel.id === "5V" || sel.id === "EXT5V"
              ? 5
              : 0;
        set(
          "scopeNote",
          drawScope(cv, kind, trace, trace.latest()?.t ?? s.simSeconds, v),
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

  // ------------------------------------------------------------ picked-board projects (U-17): per-checkpoint checks, demo firmware, export, buy card
  /** Generated checkpoints share parameters, so one dropped firmware is checked against all of them. */
  async function verifyAll(buf: ArrayBuffer, who: string, own: boolean) {
    const c = ctx;
    if (!c) return;
    for (const id of c.work.checkpoints) {
      const l = c.session.levels.find((x) => x.id === id);
      if (!l || !ctx) continue;
      await verify(l, buf, who, own);
    }
  }
  async function runDemo() {
    const c = ctx!;
    const demo = c.custom?.plan.demo;
    if (!demo || demoBusy) return;
    demoBusy = true;
    renderTree();
    try {
      const buf = await fetchBuf(`./fw/${demo}/flash.bin`);
      c.session.loadFirmware(buf, `${demo}/flash.bin`);
      c.shell.toast(t("Demo firmware {name} powered on; checking each checkpoint", { name: demo }));
      // Demo firmware counts as a ◐ reference pass (DECISIONS U-22 replaces U-17): unlocks the buy card, not "my firmware"
      await verifyAll(buf, t("Demo firmware {name}", { name: demo }), false);
    } finally {
      demoBusy = false;
      if (ctx) renderTree();
    }
  }
  /** Run the whole path on built-in firmware (U-22): each open checkpoint uses its own reference, and the last one stays on the bench. */
  async function runAllRef() {
    const c = ctx!;
    if (c.custom) return void runDemo();
    if (demoBusy || c.store.get().verifying) return;
    demoBusy = true;
    renderTree();
    let last: { ref: string; buf: ArrayBuffer } | null = null;
    try {
      for (const id of c.work.checkpoints) {
        const l = c.session.levels.find((x) => x.id === id);
        if (!l?.ref || !ctx) continue;
        if (c.store.get().checks[id]?.ok) continue;
        c.store.set({ selection: { kind: "checkpoint", id } });
        const buf = await fetchBuf(`./fw/${l.ref}/flash.bin`);
        await verify(l, buf, t("Reference firmware {name}", { name: l.ref }), false);
        last = { ref: l.ref, buf };
        // Stop at the first failure (or stall): later checkpoints usually depend on earlier wiring
        if (!c.store.get().checks[id]?.ok) break;
      }
    } catch (e) {
      c.shell.toast(t("Could not fetch built-in firmware: {err}", { err: String(e) }));
    } finally {
      demoBusy = false;
      if (ctx) {
        const n = c.work.checkpoints.length;
        const d = passedCount(c);
        if (last) c.session.loadFirmware(last.buf, `${last.ref}/flash.bin`);
        c.shell.toast(
          d === n
            ? t("Built-in firmware passed {n}/{n} (◐): Assemble is unlocked; to use your own firmware, drop a .bin on a checkpoint", { n })
            : t("Built-in firmware stopped at {d}/{n}: look at the checkpoint that failed", { d, n }),
        );
        renderTree();
      }
    }
  }
  function exportCheckpoints() {
    const c = ctx!;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(c.custom?.levels ?? [], null, 1) + "\n"], { type: "application/json" }));
    a.download = "checkpoints.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    c.shell.toast(t("Exported checkpoints.json: {cmd}", { cmd: "npx tryboard check app.bin --level-json checkpoints.json" }));
  }
  const BUY_KEY = (w: string) => `tryboard-buy-manual:${w}`;
  const loadBuyChecked = (w: string): string[] => {
    try {
      const v = JSON.parse(localStorage.getItem(BUY_KEY(w)) ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  function openBuy() {
    const c = ctx;
    if (!c?.custom) return;
    const { plan, levels } = c.custom;
    const s = c.store.get();
    const have = plan.have;
    const remaining = replay(s.bom)
      .picks.filter((p) => !have.includes(p.partId))
      .map((p) => ({ partId: p.partId, qty: p.qty ?? 1, why: "" }));
    const manual = [
      ...levels.filter((l) => l.manual).map((l) => t(l.title)),
      ...plan.noModel.map((n) =>
        t("{name}: not in the simulator, try it on real hardware", { name: t(n.name) }),
      ),
      t("Pins on the real board match the page (check each wire against the Wiring table)"),
    ];
    const fp = c.work.checkpoints.map((id) => s.checks[id]?.fingerprint).find(Boolean) ?? null;
    const own = Object.entries(ownFirmware).find(([id]) => c.work.checkpoints.includes(id))?.[1];
    const bin = own?.buf ?? c.session.fwBuf;
    const key = wkey(c.work);
    const draw = () => {
      const checked = loadBuyChecked(key);
      overlay(
        "buy",
        <BuyDialog onClose={() => overlay("buy", null)}>
          <BuyCard
            title={plan.title}
            checks={c.work.checkpoints.length}
            remaining={remaining}
            extra={plan.noModel.map((n) => ({ name: n.name, price: n.price }))}
            fingerprint={fp}
            manual={manual}
            checked={checked}
            onToggleManual={(m) => {
              const cur = loadBuyChecked(key);
              const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m];
              try {
                localStorage.setItem(BUY_KEY(key), JSON.stringify(next));
                noteSaved();
              } catch {
                /* If storage fails, the ticks only last for this page */
              }
              draw();
            }}
            onDownloadBin={
              bin
                ? () => {
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(new Blob([bin], { type: "application/octet-stream" }));
                    a.download = "flash.bin";
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                  }
                : null
            }
            onClose={() => overlay("buy", null)}
          />
        </BuyDialog>,
      );
    };
    draw();
  }

  // ------------------------------------------------------------ verdict, next step, toolbar
  function syncChrome() {
    const c = ctx!;
    const n = c.work.checkpoints.length;
    const done = passedCount(c);
    // Picked-board projects only have Shop → Bench; once all checkpoints pass, the top right opens the buy card
    if (c.custom)
      return n && done === n
        ? c.shell.setNext(t("Next: build it for real →"), "bench", "", openBuy, "hot")
        : c.shell.setNext(
            t("Build it for real · checkpoints left: {n}", { n: n - done }),
            null,
            t("The buy card appears once every checkpoint passes ({done}/{n}, demo firmware counts)", { done, n }),
          );
    // The blank project has no Assemble / Product steps, so the top right points to picking a project
    if (c.work.id === "blank")
      return c.shell.setNext(t("Need an enclosure? Pick a project →"), "bench", "", () =>
        location.assign(`${HOME}#works`),
      );
    // The inclinometer has no checkpoints or assembly template, so Product (the handheld box) is always open
    if (c.work.id === "imu") return c.shell.setNext(t("Next: Product →"), "product");
    if (n && done === n)
      return c.shell.setNext(t("Next: Assemble →"), "assemble", "", undefined, "hot");
    c.shell.setNext(
      t("Assemble · checkpoints left: {n}", { n: n - done }),
      null,
      t("Assemble unlocks once every checkpoint passes ({done}/{n}, built-in firmware counts)", { done, n }),
    );
  }

  // ------------------------------------------------------------ heat source / measured at the chip (P0-04)
  function toggleHeat() {
    const c = ctx!;
    if (!c.session.scene.parts.some((p) => p.type === "bme280")) {
      c.shell.toast(t("No BME280 on the bench, so the heat source has no sensor to approach"));
      return;
    }
    const on = !c.session.heat;
    const room = c.store.get().env.temp;
    const temp = on ? room + 8 : (heatRoom ?? room - 8);
    heatRoom = on ? room : null;
    c.hist?.op({
      k: "heat",
      part: on ? "bme280" : null,
      env: { ...c.store.get().env, temp },
    });
    c.session.setEnv({ temp });
    c.session.setHeat(on ? "bme280" : null);
    c.shell.toast(
      on
        ? t("Heat source next to the BME280: air around the sensor goes from {from} °C to {to} °C (illustrative, a fixed +8 °C)", { from: room.toFixed(1), to: temp.toFixed(1) })
        : t("Heat source removed: back to {to} °C", { to: temp.toFixed(1) }),
    );
  }

  // ------------------------------------------------------------ quick cards (P0-04)
  function cardContent(tg: PickTarget): ReactNode | null {
    const c = ctx!;
    if (tg.kind === "part" && tg.id === "bme280") {
      return (
        <div>
          <Sec>{t("BME280 · temperature / humidity / pressure")}</Sec>
          <Kv k={t("Reading")} live="rt" />
          {envSlider("temp", t("Ambient temperature"), -10, 45, 0.5)}
          <HeatActs />
        </div>
      );
    }
    if (tg.kind === "part" && (tg.id === "mpu6050" || tg.id === "qmi8658")) {
      return (
        <div>
          <Sec>{t("{chip} · tilt the bench", { chip: tg.id === "mpu6050" ? "MPU6050" : "QMI8658" })}</Sec>
          {poseSliders(POSE_AXES.slice(0, 2))}
          <Kv k={t("Firmware reading")} live="ipr" />
          {levelBtn()}
          <Note>{t("You can also drag the module to rotate it.")}</Note>
        </div>
      );
    }
    if (
      tg.kind === "part" &&
      (tg.id === "cst816s" ||
        (tg.id === "gc9a01" &&
          c.session.scene.parts.some((x) => x.type === "cst816s")))
    ) {
      return (
        <div>
          <Sec>{t("Touch round display · CST816S")}</Sec>
          <Kv k={t("Finger")} live="tch" />
          <Kv k={t("INT level")} live="tint" />
          <Note>{t("Tap or drag right on the 3D screen.")}</Note>
        </div>
      );
    }
    const isServoPower =
      (tg.kind === "wire" && /servo:VCC/.test(tg.id)) ||
      (tg.kind === "pin" &&
        tg.id === "5V" &&
        c.session.scene.parts.some((p) => p.type === "servo"));
    if (isServoPower) {
      return (
        <div>
          <Sec>
            {c.session.power?.ext5v
              ? t("Servo power · now external 5 V")
              : t("Servo power · now USB 5 V")}
          </Sec>
          {powerSeg(!!c.session.power?.ext5v)}
          <Kv k={t("5V rail")} live="e5" />
          <Kv k="3V3" live="e33" />
          <Kv k={t("Brownout resets")} live="ers" />
          <Note>
            {t("On USB alone, big servo sweeps pull 3V3 below the brownout threshold and the board resets.")}
          </Note>
        </div>
      );
    }
    if (tg.kind === "part" && tg.id === "encoder") {
      return (
        <div>
          <Sec>{t("EC11 encoder · drag or scroll to turn the knob")}</Sec>
          {encRows()}
          {encButtons()}
        </div>
      );
    }
    if (tg.kind === "part" && (tg.id === "hcsr04" || tg.id === "obstacle")) {
      return (
        <div>
          <Sec>{t("HC-SR04 · drag the obstacle or the slider")}</Sec>
          {sonarRows()}
          {sonarControls()}
        </div>
      );
    }
    if (tg.kind === "button" && tg.id === "BOOT") {
      return (
        <div>
          <Sec>{t("BOOT button · GPIO{n}", { n: bootGpio() })}</Sec>
          {bootBtns()}
          <Note>{t("Weather station firmware: press once to switch between ℃ and ℉.")}</Note>
        </div>
      );
    }
    if (tg.kind === "part") {
      const p = c.session.scene.parts.find((x) => partId(x) === tg.id);
      return (
        <div>
          <Sec>{p ? partInfo(p).name : tg.id === "board" ? t("Dev board") : tg.id}</Sec>
        </div>
      );
    }
    return null;
  }
  function openCard(t: PickTarget, screen: ScreenPoint) {
    const c = ctx!;
    const box = cardContent(t);
    if (!box) {
      closeCard();
      return;
    }
    cardFor = t;
    c.shell.card.show(c.session.pick.project?.(t) ?? screen, box);
    updateLive();
    // The card follows its target as the bench rotates and closes once the target is out of view
    cancelAnimationFrame(cardRaf);
    const follow = () => {
      if (!cardFor || !c.shell.card.open) return;
      const p = c.session.pick.project?.(cardFor);
      if (!p) return closeCard();
      c.shell.card.place(p);
      cardRaf = requestAnimationFrame(follow);
    };
    cardRaf = requestAnimationFrame(follow);
  }
  function closeCard() {
    cancelAnimationFrame(cardRaf);
    cardFor = null;
    ctx?.shell.card.hide();
  }

  function onPick(tg: PickTarget | null, screen: ScreenPoint) {
    if (!ctx || ctx.store.get().step !== "bench") return;
    if (placing) {
      if (!tg) return;
      if (tg.kind === "pin") placePin(tg.id);
      else ctx.shell.toast(t("Click a blue pin on the dev board"));
      return;
    }
    if (wiring) {
      if (!tg) return;
      if (tg.kind === "wire") {
        if (!benchWires().some((w) => w.id === tg.id))
          return ctx.shell.toast(t("Both ends of this wire are on parts, so there is no dev board end to rewire"));
        wiring.wire = tg.id;
        ctx.session.pick.highlight?.(tg);
        wireUi();
      } else if (tg.kind === "pin" && wiring.wire) retarget(wiring.wire, tg.id);
      else
        ctx.shell.toast(
          wiring.wire ? t("Click a pin on the dev board (blue ring)") : t("First click the wire you want to rewire"),
        );
      return;
    }
    if (meter) {
      if (!tg) return;
      const id = meterTarget(tg);
      if (!id) {
        ctx.shell.toast(t("Multimeter: click a pin (power pin or GPIO) or a wire"));
        return;
      }
      meter = { target: id };
      if (ctx.store.get().selection?.kind !== "tool")
        select({ kind: "tool", id: "meter" });
      renderMeter();
      meterCard();
      cardFor = tg;
      ctx.shell.card.show(
        ctx.session.pick.project?.(tg) ?? screen,
        <div>
          <Sec>{tn("Multimeter · {pin}", { pin: <Mono>{id}</Mono> })}</Sec>
          <Meter sm />
          <Live as="p" k="mnote" className="note my-2 text-xs text-muted" />
        </div>,
      );
      updateLive();
      return;
    }
    if (ruler) {
      if (!tg) return;
      if (!ruler.a || ruler.b) ruler = { a: tg, b: null, mm: null };
      else {
        ruler.b = tg;
        ruler.mm = ctx.session.pick.measure?.(ruler.a, tg) ?? null;
      }
      if (!ruler.b) ctx.session.pick.measure?.(null);
      renderProps();
      return;
    }
    if (!tg) {
      closeCard();
      if (isPhone()) setMui({ props: false });
      return select(null);
    }
    select({ kind: tg.kind, id: tg.id });
    // Phones open the properties drawer instead of a card, which would cover most of the bench
    if (isPhone()) {
      closeCard();
      phoneProps();
    } else openCard(tg, screen);
  }

  function setRuler(on: boolean) {
    const c = ctx!;
    ruler = on ? { a: null, b: null, mm: null } : null;
    c.shell.toolbar.setActive(on ? "ruler" : "select");
    if (!on) c.session.pick.measure?.(null);
    closeCard();
    if (on) select({ kind: "tool", id: "ruler" });
    else if (c.store.get().selection?.kind === "tool") select(null);
  }

  function onTool(id: string) {
    if (!ctx || ctx.store.get().step !== "bench") return;
    const c = ctx;
    // On phones, wiring and measuring need the bench visible, so close the drawer first
    if ((id === "wire" || id === "meter" || id === "ruler") && isPhone())
      setMui({ props: false, more: false });
    if (placing && id !== "place" && /^(select|orbit|wire|meter|ruler)$/.test(id))
      endPlace();
    if (id === "place") {
      if (placing) {
        endPlace();
        return;
      }
      c.shell.toolbar.setActive("select");
      c.shell.toast(t("Drag a part from the Parts library onto the bench, or click its Place button"));
      (document.querySelector('[data-left="lib"]') as HTMLElement | null)?.click();
      requestAnimationFrame(() =>
        (document.querySelector("#partLib input") as HTMLInputElement | null)?.focus(),
      );
      return;
    }
    if (id === "select" || id === "orbit") {
      if (ruler) setRuler(false);
      if (meter) setMeter(false);
      if (wiring) setWiring(false);
      c.shell.toolbar.setActive(id);
    } else if (id === "wire") {
      const sel = c.store.get().selection;
      setWiring(
        !wiring,
        sel?.kind === "wire" && benchWires().some((w) => w.id === sel.id)
          ? sel.id
          : null,
      );
    } else if (id === "ruler") {
      if (meter) setMeter(false);
      if (wiring) setWiring(false);
      setRuler(!ruler);
    } else if (id === "meter") setMeter(!meter);
    else if (id === "heat") toggleHeat();
    else if (id === "scope") getAnalyzer(c).toggle();
    else if (id === "ext") {
      // External models (P1-09): KiCad / Adafruit glb for servo, USB-C and buzzer; procedural by default, credits on the licenses page
      const on = !extModelsOn();
      setExtModels(on);
      c.shell.toolbar.setLabel("ext", on ? t("External models: on") : t("External models: off"));
      c.shell.toast(
        on
          ? t("External models: servo, USB-C port and buzzer use KiCad / Adafruit 3D models (credits on the third-party licenses page)")
          : t("External models off: everything is back to procedural models"),
      );
    } else if (id === "photo") {
      // Photo (P2-10): a 2× still of the current bench view
      void takePhoto(
        c.session.bench.capture(),
        `${c.work.id}-bench`,
        t("{title} · Bench", { title: t(c.work.title) }),
      )
        .then((r) =>
          c.shell.toast(t("Downloaded {name} ({w}×{h})", { name: r.name, w: r.width, h: r.height })),
        )
        .catch((e) => c.shell.toast(t("Photo failed: {err}", { err: String(e) })));
    } else if (id === "rec") {
      if (benchRec) return benchRec.stop();
      try {
        const r = recordCanvas(
          c.session.bench.capture().renderer.domElement,
          `${c.work.id}-bench`,
          c.session.audio.recordStream(),
        );
        benchRec = r;
        setRecLabel(t("Stop {n}/{max} s", { n: 0, max: RECORD_SECONDS }));
        const tick = setInterval(
          () =>
            benchRec === r &&
            setRecLabel(
              t("Stop {n}/{max} s", { n: Math.min(RECORD_SECONDS, r.elapsed()).toFixed(0), max: RECORD_SECONDS }),
            ),
          500,
        );
        void r.done
          .then((v) =>
            ctx?.shell.toast(
              v.audio
                ? t("Downloaded {name} ({kb} KB, with sound)", { name: v.name, kb: (v.bytes / 1024).toFixed(0) })
                : t("Downloaded {name} ({kb} KB)", { name: v.name, kb: (v.bytes / 1024).toFixed(0) }),
            ),
          )
          .catch((e) => ctx?.shell.toast(t("Recording failed: {err}", { err: String(e) })))
          .finally(() => {
            clearInterval(tick);
            if (benchRec === r) benchRec = null;
            setRecLabel(t("Record"));
          });
      } catch (e) {
        c.shell.toast(t("Recording failed: {err}", { err: String(e) }));
      }
    } else if (id === "button") {
      c.session.pressBoot(true);
      setTimeout(() => c.session.pressBoot(false), 150);
      c.shell.toast(t("Pressed BOOT once (GPIO{n})", { n: bootGpio() }));
    } else c.shell.toast(t("This tool is not available yet"));
  }

  /** The 10-second bench recording in progress (P2-10). */
  let benchRec: Recording | null = null;
  let toolbarRef: StepCtx["shell"]["toolbar"] | null = null;
  const setRecLabel = (s: string) => toolbarRef?.setLabel("rec", s);

  // ------------------------------------------------------------ inject bad wiring (acceptance debug hook, exposed only with ?debug=1)
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
    const c = ctx!;
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
    return faults.flatMap((f) => f.wires);
  }

  return {
    mount(c) {
      ctx = c;
      toolbarRef = c.shell.toolbar;
      // "Change firmware → Upload" counts as your own firmware and is checked like a drop (2026-10-18 walkthrough found it skipped)
      actions.openBuy = c.custom ? openBuy : undefined;
      // session.levels may still be loading, so decide from the project and fetch each ref at run time
      actions.runAllRef = c.work.checkpoints.length && (!c.custom || c.custom.plan.demo) ? () => void runAllRef() : undefined;
      actions.checkUpload = (buf, name) => {
        const s = c.store.get();
        if (s.verifying) return null;
        if (c.custom) {
          const first = c.work.checkpoints[0];
          if (!first) return null;
          void verifyAll(buf, name, true);
          return c.work.checkpoints.join(", ");
        }
        const sel = s.selection?.kind === "checkpoint" ? s.selection.id : null;
        const id =
          sel ??
          c.work.checkpoints.find((x) => !(s.checks[x]?.ok && s.checks[x].own));
        const l = id && c.session.levels.find((x) => x.id === id);
        if (!l) return null;
        c.store.set({ selection: { kind: "checkpoint", id: l.id } });
        void verify(l, buf, name, true);
        return l.id;
      };
      if (!hooked) {
        hooked = true;
        if (c.work.id === "blank" && c.work.example)
          void loadExamples().then((list) => {
            const ex = list.find((e) => e.id === c.work.example);
            if (!ex) return;
            exInfo = { ex, work: relatedWork(ex, list) };
            if (ctx && ctx.store.get().step === "bench" && !ctx.store.get().selection) renderProps();
          });
        c.session.pick.onPick?.(onPick);
        c.shell.toolbar.onTool(onTool);
        c.shell.card.onHide(() => {
          cancelAnimationFrame(cardRaf);
          cardFor = null;
        });
        c.session.onTick((m) => {
          if (trace.pin < 0) return;
          const p = trace.pin;
          trace.push({
            t: m.simSeconds,
            duty: m.pwm[p] ?? -1,
            freq: m.pwmFreq[p] ?? 0,
            level: bit(m.gpio, m.gpioHi, p),
            out: !!bit(m.enable, m.enableHi, p),
          });
        });
        // Tool shortcuts (toolbar badges) skip text inputs; Esc leaves the current tool first
        window.addEventListener("keydown", (e) => {
          if (
            !ctx ||
            ctx.store.get().step !== "bench" ||
            e.metaKey ||
            e.ctrlKey ||
            e.altKey
          )
            return;
          if (
            (e.target as HTMLElement).closest(
              "input,textarea,select,[contenteditable]",
            )
          )
            return;
          const k = e.key.toLowerCase();
          if (k === "escape") {
            if (placing) {
              const n = placing.def.name;
              endPlace();
              ctx.shell.toast(t("Did not place {name}", { name: n }));
            } else if (bc.get().overlays.wrongWire) overlay("wrongWire", null);
            else if (wiring) setWiring(false);
            else if (ruler) setRuler(false);
            else if (meter) setMeter(false);
            return;
          }
          const tool = (
            {
              v: "select",
              h: "orbit",
              w: "wire",
              m: "meter",
              r: "ruler",
            } as Record<string, string>
          )[k];
          if (tool) onTool(tool);
        });
        // Parts library drops (P2-16) only accept the library drag type; .bin drops are handled elsewhere
        const stage = document.getElementById("stage");
        stage?.addEventListener("dragover", (e) => {
          if (!ctx || ctx.store.get().step !== "bench") return;
          if (!e.dataTransfer?.types.includes(LIB_DRAG)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        });
        stage?.addEventListener("drop", (e) => {
          const id = e.dataTransfer?.getData(LIB_DRAG);
          if (!id || !ctx || ctx.store.get().step !== "bench") return;
          e.preventDefault();
          startPlace(id);
        });
        if (new URLSearchParams(location.search).has("debug")) {
          const w = window as unknown as { __tbApp?: Record<string, unknown> };
          w.__tbApp ??= {};
          w.__tbApp.injectWiring = (k: Parameters<typeof injectWiring>[0]) =>
            ctx ? injectWiring(k) : [];
          w.__tbApp.faults = () =>
            faults.map((f) => ({
              rule: f.rule,
              wires: f.wires,
              short: f.short,
              mA: f.estimate?.mA ?? null,
              est: f.estimate?.text ?? null,
            }));
          // Open a wire's wrong-wire card for acceptance screenshots (same card a rewire shows)
          w.__tbApp.showWrongWire = (wireId: string) => {
            const f = faults.find((x) => x.wires.includes(wireId));
            if (!ctx || !f) return false;
            showWrongWire(
              f,
              wireId,
              `${wireId.replace(/^wire:/, "")}`,
              () => {},
              () => {},
            );
            return true;
          };
          w.__tbApp.setWireLen = (part: string, cm: number) =>
            ctx && setWireLen(part, cm);
        }
      }
      c.shell.toolbar.setGroups([
        {
          id: "nav",
          tools: [
            { id: "select", label: t("Select"), key: "V" },
            { id: "orbit", label: t("Orbit"), key: "H" },
          ],
        },
        {
          id: "edit",
          tools: [
            { id: "place", label: t("Place") },
            { id: "wire", label: t("Wire"), key: "W" },
          ],
        },
        {
          id: "measure",
          tools: [
            { id: "meter", label: t("Multimeter"), key: "M" },
            { id: "ruler", label: t("Ruler"), key: "R" },
            { id: "scope", label: t("Scope") },
          ],
        },
        {
          id: "look",
          tools: [
            {
              id: "ext",
              label: extModelsOn() ? t("External models: on") : t("External models: off"),
            },
          ],
        },
        {
          id: "media",
          tools: [
            { id: "photo", label: t("Photo") },
            { id: "rec", label: benchRec ? t("Stop recording") : t("Record") },
          ],
        },
        {
          id: "act",
          tools: [
            { id: "heat", label: t("Heat source") },
            { id: "button", label: t("Press BOOT") },
          ],
        },
        // Rerun lives in the top bar run group (Reset), so the toolbar does not repeat it (DESIGN_V2 §6.3)
      ]);
      c.shell.toolbar.setActive(
        ruler ? "ruler" : meter ? "meter" : wiring ? "wire" : "select",
      );
      const pinDev = c.session.scene.parts.find(
        (p) => p.type === "encoder" || p.type === "hcsr04",
      );
      // Examples default to the "this example" card instead of firmware; encoder / sonar controls live in part properties, so select those
      if (!c.store.get().selection && !(c.work.example && !pinDev))
        c.store.set({
          selection: c.work.checkpoints.length
            ? { kind: "part", id: "bme280" }
            : pinDev
              ? { kind: "part", id: pinDev.type }
              : { kind: "firmware", id: "main" },
        });
      if (
        !c.session.scene.parts.some((p) => partId(p) === "bme280") &&
        c.store.get().selection?.id === "bme280"
      )
        c.store.set({ selection: { kind: "part", id: "board" } });
      recheckWiring();
      applyBenchHarness();
      // ?debug=1&wiring=<kind> injects one bad wiring on open and shows its card (visual acceptance, same entry as __tbApp.injectWiring)
      const q = new URLSearchParams(location.search);
      const inj = q.has("debug") ? q.get("wiring") : null;
      if (inj) {
        // Inject once; a remount (coming back from another step) only reopens the card and selection
        if (!injected) injectWiring(inj as Parameters<typeof injectWiring>[0]);
        injected = true;
        recheckWiring();
        const f = faults.find((x) => x.net) ?? faults[0];
        if (f) {
          c.store.set({ selection: { kind: "wire", id: f.wires[0] } });
          showWrongWire(
            f,
            f.wires[0],
            f.wires[0].replace(/^wire:/, ""),
            () => {},
            () => {},
          );
        }
      }
      meterCard();
      renderTree();
      renderProps();
      syncChrome();
      if (pendingAllRef) {
        pendingAllRef = false;
        actions.runAllRef?.();
      }
      unsubs = [
        c.store.subscribe(() => {
          renderTree();
          renderProps();
          c.session.pick.highlight?.(toPick(c.store.get().selection));
          syncChrome();
        }, ["selection", "checks", "verifying"]),
        // Picked-board projects open the buy card when the last checkpoint just passed (not on restore)
        c.store.subscribe(
          (s, prev) => {
            const n = c.work.checkpoints.length;
            if (!buyArmed) return;
            buyArmed = false;
            if (c.custom && n && passedCount(c, s) === n && passedCount(c, prev) < n) openBuy();
          },
          ["checks"],
        ),
        c.store.subscribe(
          (s, prev) => {
            recheckWiring();
            renderTree();
            // Rebuilding mid-drag would break slider drags; only edit changes (power, heat, rewire, rewind) redraw
            const h = s.hist,
              p = prev.hist;
            if (s.editRev !== prev.editRev && cardFor && c.shell.card.open) {
              const box = cardContent(cardFor);
              if (box)
                c.shell.card.show(
                  c.session.pick.project?.(cardFor) ?? { x: 0, y: 0 },
                  box,
                );
            }
            if (
              s.editRev !== prev.editRev ||
              s.sceneRev !== prev.sceneRev ||
              h.seeked !== p.seeked ||
              h.busy !== p.busy ||
              h.runs !== p.runs ||
              (h.seeked && h.cur !== p.cur) ||
              s.selection?.kind === "run"
            )
              renderProps();
          },
          ["editRev", "sceneRev", "hist"],
        ),
        c.store.subscribe(() => renderTree(), ["env", "run", "runNo"]),
        // Redraw the tree's wireless group only when BLE or phone state text changes; notifications arrive every second
        (() => {
          let label = "";
          return bleFeed.subscribe(() => {
            const b = bleFeed.get();
            const l = `${b.state}|${phoneStateText(b)}`;
            if (l === label) return;
            label = l;
            renderTree();
            if (b.state === 0 && c.store.get().selection?.kind === "ble") select(null);
          });
        })(),
        c.store.subscribe(
          () => updateLive(),
          [
            "simSeconds",
            "reading",
            "running",
            "run",
            "verifyProgress",
            "env",
            "pose",
            "imu",
            "touch",
          ],
        ),
      ];
      c.session.pick.highlight?.(toPick(c.store.get().selection));
    },
    unmount() {
      unsubs.forEach((u) => u());
      unsubs = [];
      closeCard();
      // The analyzer belongs to the bench: CSS hides it on leave (body[data-step]) and its state survives
      if (ruler) {
        ruler = null;
        ctx?.session.pick.measure?.(null);
      }
      meter = null;
      wiring = null;
      placing = null;
      for (const k of ["wire", "rings", "wrongWire", "meter", "empty", "place", "customPlaced", "buy"])
        overlay(k, null);
      setLeft({ lib: null, wires: null, wireCount: 0, card: null });
      ctx?.session.pick.highlight?.(null);
      actions.checkUpload = undefined;
      actions.openBuy = undefined;
      actions.runAllRef = undefined;
      ctx = null;
    },
  };
}

/** RGB LED swatch, built imperatively inside live fields. */
function swatch(bg: string) {
  const i = document.createElement("i");
  i.className =
    "sw mr-1.5 inline-block size-2.5 rounded-[3px] border border-[#0002] align-[-1px]";
  i.style.background = bg;
  return i;
}

/** Note line whose text is updated imperatively (wire length conversion). */
function NoteLive({ id, init }: { id: string; init: string }) {
  const ref = useInitText<HTMLParagraphElement>(init);
  return <p ref={ref} id={id} className="note my-2 text-xs text-muted" />;
}

/** Plain-language verdict, updated directly by events during slider drags to avoid re-rendering. */
function SayLive({ id, init }: { id: string; init: string }) {
  const ref = useInitText<HTMLParagraphElement>(init);
  return <p ref={ref} id={id} className="mt-2 mb-0 text-[13px] font-medium text-fg" />;
}

/** Part heading in properties: name plus confidence badge (see benchv2 PART_CONF). */
function PartHead({ name, type }: { name: string; type: string }) {
  const conf = PART_CONF[type];
  return (
    <div className="mb-2 flex items-center gap-2">
      <Ph className="mb-0 min-w-0">{name}</Ph>
      {conf && <ConfBadge c={conf} />}
    </div>
  );
}

/** A project using the same main part type (common LEDs and buttons ignored), or null. */
function relatedWork(ex: Example, list: Example[]): WorkDef | null {
  const common = new Set(["led", "button", "key", "buzzer"]);
  const types = new Set((ex.scene?.parts ?? []).map((p) => p.type).filter((t) => !common.has(t)));
  if (!types.size) return null;
  return (
    HOME_WORKS.find((w) => {
      if (!w.checkpoints.length || !w.example) return false;
      if (w.example === ex.id) return true;
      const we = list.find((e) => e.id === w.example);
      return (we?.scene?.parts ?? []).some((p) => types.has(p.type));
    }) ?? null
  );
}
