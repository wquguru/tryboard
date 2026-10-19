// Shared state and cross-section entry points of the bench step (R-08).
// Each app/bench/<section> installs its functions here; sections never import each other.
import { type ReactNode, type JSX } from "react";
import { type PickTarget, type ScreenPoint } from "../../scene-api";
import { type WireMods, type BenchWire } from "../wiring";
import { type WireFault } from "../wirecheck";
import { PinTrace } from "../pinscope";
import { type Level } from "../../checks";
import { type Selection, type StepCtx, type WorkDef } from "../types";
import { type Recording } from "../capture";
import { type AnalogControl, type Example } from "../examples";
import { type PlaceDef } from "../place";

/** Mutable state that more than one section reads or writes. */
export interface BenchState {
  ctx: StepCtx | null;
  openGroups: Record<string, boolean>;
  /** Samples of the selected pin (mini scope). */
  trace: PinTrace;
  /** Example on an empty bench (?example=): with nothing selected the right column shows the example card (DESIGN_V2 §6.1). */
  exInfo: { ex: Example; work: WorkDef | null } | null;
  demoBusy: boolean;
  /** Set by a fresh own pass on this page: only then does all-passed pop the buy card (not on restore or replay). */
  buyArmed: boolean;
  /** Ruler: after the toolbar Ruler is on, pick two targets on the bench. */
  ruler: { a: PickTarget | null; b: PickTarget | null; mm: number | null } | null;
  /** Multimeter (P1-04): after the toolbar Multimeter is on, pick a pin to read its voltage to GND. */
  meter: { target: string | null } | null;
  /** Target the quick card follows. */
  cardFor: PickTarget | null;
  cardRaf: number;
  faults: WireFault[];
  /** Open wrong-wire card: redrawn when the estimate arrives. */
  wwShow: ((f: WireFault) => void) | null;
  /** Wire tool (U-04): pick a wire, then a new pin on the dev board; `wire` is the picked one. */
  wiring: { wire: string | null } | null;
  /** Direct placement (P2-16): wire pin by pin after dropping; enters the scene/sim only once fully wired. */
  placing: { def: PlaceDef; cur: number; got: Record<string, string>; skipped: Set<string> } | null;
  /** The 10-second bench recording in progress (P2-10). */
  benchRec: Recording | null;
  toolbarRef: StepCtx["shell"]["toolbar"] | null;
}

/** State plus the functions each section installs for the others (grouped by owning file). */
export interface BenchCtx extends BenchState {
  // select.ts(x)
  select: (sel: Selection | null) => void;
  benchWires: () => BenchWire[];
  // wiringcheck.ts(x)
  recheckWiring: () => void;
  // left.ts(x)
  renderLeft: () => void;
  // wiretool.ts(x)
  wireUi: () => void;
  ringProject: (id: string) => ScreenPoint | null;
  setWiring: (on: boolean, wire?: string | null) => void;
  applyMods: (mods: WireMods, label: string) => void;
  retarget: (wireId: string, to: string) => void;
  showWrongWire: (first: WireFault, wireId: string, label: string, undo: () => void, retry: () => void) => void;
  // placing.ts(x)
  startPlace: (id: string) => void;
  endPlace: () => void;
  placePin: (id: string) => void;
  bindLibDrop: () => void;
  // tree.ts(x)
  renderTree: () => void;
  // inspector.ts(x)
  show: (body: ReactNode, live?: boolean) => void;
  renderProps: () => void;
  powerSeg: (ext: boolean) => JSX.Element;
  setWireLen: (part: string, cm: number) => void;
  applyBenchHarness: () => void;
  faultEl: (f: WireFault, i: number) => JSX.Element;
  powerInline: () => JSX.Element;
  // pins.ts(x)
  renderPin: (id: string) => void;
  bootGpio: () => number;
  partName: (pid: string) => string;
  bootBtns: () => JSX.Element;
  renderButton: (id: string) => void;
  // runs.ts(x)
  renderRuns: (n: number) => void;
  // meter.ts(x)
  renderMeter: () => void;
  setMeter: (on: boolean) => void;
  meterCard: () => void;
  meterTarget: (t: PickTarget) => string | null;
  meterReading: () => { v: number | null; note: string } | null;
  // ruler.ts(x)
  renderRuler: () => void;
  driftText: (mm: number) => string;
  measureChip: () => number | null;
  // encoder.ts(x)
  encRows: () => JSX.Element;
  encButtons: () => JSX.Element;
  sonarRows: () => JSX.Element;
  sonarControls: () => JSX.Element;
  toggleDivider: () => void;
  lastLine: (re: RegExp) => RegExpExecArray | null;
  fmtEnv: Record<string, (v: number) => string>;
  ENV_ROWS: [ "temp" | "humidity" | "pressure", string, number, number, number, ][];
  envSlider: (k: "temp" | "humidity" | "pressure", label: string, min: number, max: number, step: number) => JSX.Element;
  HeatActs: () => JSX.Element;
  levelBtn: () => JSX.Element;
  TempExact: () => JSX.Element;
  // part.ts(x)
  renderPart: (id: string) => void;
  // orient.ts(x)
  POSE_AXES: ["pitch" | "roll" | "yaw", string, number][];
  poseSliders: (axes?: ["pitch" | "roll" | "yaw", string, number][]) => JSX.Element[];
  renderEnv: () => void;
  analogBox: (a: AnalogControl) => JSX.Element;
  renderExample: () => void;
  safeFile: (handle: (f: File) => Promise<void>) => (f: File) => undefined;
  renderFirmware: () => void;
  // checkpoint.ts(x)
  renderCheckpoint: (id: string) => void;
  verify: (l: Level, buf: ArrayBuffer, who: string, own: boolean) => Promise<void>;
  // live.ts(x)
  updateLive: () => void;
  // custom.ts(x)
  verifyAll: (buf: ArrayBuffer, who: string, own: boolean) => Promise<void>;
  runDemo: () => Promise<void>;
  runAllRef: () => Promise<undefined>;
  exportCheckpoints: () => void;
  openBuy: () => void;
  // verdict.ts(x)
  syncChrome: () => void;
  setToolGroups: (c: StepCtx) => void;
  // heat.ts(x)
  toggleHeat: () => void;
  // cards.ts(x)
  cardContent: (tg: PickTarget) => ReactNode | null;
  closeCard: () => void;
  onPick: (tg: PickTarget | null, screen: ScreenPoint) => void;
  setRuler: (on: boolean) => void;
  onTool: (id: string) => void;
  bindShortcuts: () => void;
  // debug.ts(x)
  injectWiring: (kind: "drive" | "5v" | "nores" | "nognd" | "addr" | "nodiv" | "short3v3" | "short5v" | "clamp" | "clear") => string[];
  exposeDebugHooks: () => void;
}

/** Fresh state; the function members are installed by the mount*() calls in benchStep(). */
export function createBenchCtx(): BenchCtx {
  const state: BenchState = {
    ctx: null,
    openGroups: {
      part: true,
      pin: false,
      wire: false,
      power: true,
      env: true,
      firmware: true,
      run: true,
      checkpoint: true,
      ble: true,
    },
    trace: new PinTrace(),
    exInfo: null,
    demoBusy: false,
    buyArmed: false,
    ruler: null,
    meter: null,
    cardFor: null,
    cardRaf: 0,
    faults: [],
    wwShow: null,
    wiring: null,
    placing: null,
    benchRec: null,
    toolbarRef: null,
  };
  return state as BenchCtx;
}

