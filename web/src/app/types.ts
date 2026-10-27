// Shared types for the workbench shell: all four steps (shop / bench / assemble / product) share one selection and one store.
import { t } from '../i18n/index.ts';
import type { CustomPlan } from './custom';
import type { Bench, SceneSpec } from '../board3d';
import type { ScenePickApi, ScreenPoint } from '../scene-api';
import type { LiveSim } from '../live';
import type { BuzzerAudio } from '../audio';
import type { Effects } from '../views/templates';
import type { Level } from '../checks';
import type { ConfLevel } from '../ui/conf';
import type { Store } from './store';
import type { Timeline } from './timeline';
import type { Toolbar } from './toolbar';
import type { Card } from './card';
import type { BomHistory } from './bom';
import type { SeekJob } from '../live';
import type { ElecFrame, FromWorker, Harness, PinDevFrame, Snapshot, TimingReport, VcdState } from '../simmsg';
import type { UsbView } from '../usb3d';
import type { WireMods } from './wiring';
import type { BenchHistory } from './benchhist';
import type { IoStore } from './iotrace';
import type { TaskStore } from './tasktrace';
import type { CaseParams } from './enclosure';
import type { ReactNode } from 'react';

export type StepId = 'shop' | 'bench' | 'assemble' | 'product';
export type NextState = 'go' | 'hot' | 'lock' | 'end';

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'shop', label: t('Shop') },
  { id: 'bench', label: t('Bench') },
  { id: 'assemble', label: t('Assemble') },
  { id: 'product', label: t('Product') },
];

export type WorkId = 'weather' | 'spin' | 'lens' | 'usbkey' | 'lamp' | 'ruler' | 'tilt' | 'door' | 'irlamp' | 'dialtimer' | 'cloud' | 'amoclock' | 'knob' | 'sonar' | 'blank' | 'imu' | 'touch' | 'custom' | 'faults' | 'basics' | 'adc';

/** kind maps 1:1 to build-tree groups; pin / wire / button come from bench picking */
export type SelKind = 'part' | 'wire' | 'power' | 'env' | 'firmware' | 'checkpoint' | 'pin' | 'button' | 'run' | 'tool' | 'ble';
export interface Selection {
  kind: SelKind;
  id: string;
}

export interface Env {
  temp: number;
  humidity: number;
  pressure: number;
}

/** One verification result (shared by checkpoint props, verdict button, timeline) */
export interface CheckOutcome {
  ok: boolean;
  who: string;
  /** User's own firmware? Only an own-firmware pass counts as progress */
  own: boolean;
  /** text matches the CLI byte for byte; say / tag are the plain-language layer (DESIGN_V2 §9) */
  rows: { ok: boolean | null; text: string; say?: string; tag?: string; dev?: string; conf?: ConfLevel; note?: string }[];
  fingerprint: string;
  sim: number;
  /** Ran with the real network on (C-03): verdict depends on the internet, fingerprint empty (no run ID) */
  realnet?: boolean;
}

export interface AppState {
  work: WorkId;
  step: StepId;
  selection: Selection | null;
  env: Env;
  /** Live sim: run count (+1 per power-on), sim time, running */
  run: number;
  simSeconds: number;
  running: boolean;
  /** Latest serial reading (the BME280 line T= H= P=) */
  reading: { t: number; h: number; p: number } | null;
  /** Bench pose in degrees (P2-03: tilt slider / IMU drag / product rotation) */
  pose: { pitch: number; roll: number; yaw: number };
  /** Latest IMU serial line (s3-imu / s3-qmi8658 `IMU pitch= roll= … gyro=(…)`) */
  imu: { pitch: number; roll: number; gyro: [number, number, number] | null } | null;
  /** Touch (P2-02): last finger position; down = still pressed */
  touch: { x: number; y: number; down: boolean } | null;
  /** Checkpoint results keyed by level id */
  checks: Record<string, CheckOutcome>;
  /** Checkpoint being verified (only one at a time) */
  verifying: string | null;
  verifyProgress: number;
  /** Shopping-list op log (the list is replayed from it, see bom.ts); stored in localStorage 'tryboard-app-shop:<work>' */
  bom: BomHistory;
  /** Bench scene revision (+1 per "put on bench"; the timeline records a step on it) */
  sceneRev: number;
  /** +1 when bench edit state changes (power, heat, rewiring, restored scene) so panels redraw */
  editRev: number;
  /** Timeline run number (reused after a rewind; run is the page-wide power-on count, never decreases) */
  runNo: number;
  /** Timeline: step count, current step, parked at a rewind point, rewinding */
  hist: { n: number; cur: number; seeked: boolean; busy: boolean; runs: number };
  /** Assembly result (read by the product step); null = not started */
  assembly: AssemblyState | null;
  /** Parametric case (P1-08): edited in the shop case details, used by assembly. Stored in localStorage 'tryboard-app-case:<work>' */
  caseParams: CaseParams;
}

export interface AssemblyState {
  placed: string[];
  choice: Record<string, string>;
  total: number;
  /** Fully assembled with no warnings */
  clean: boolean;
  effects: Effects;
  /** Latest power-on retest; null = not run yet */
  retest: boolean | null;
}

export interface WorkDef {
  id: WorkId;
  title: string;
  /** Example id (firmware/examples.json); null for blank */
  example: string | null;
  /** Checkpoints: levels.json ids (including sub-levels like 07-spin) */
  checkpoints: string[];
  /** Home-page card; absent = not on the home page (e.g. blank bench) */
  card?: { chip: string; blurb: string; /** Copy ready, web flow not yet: kept off the home page */ draft?: boolean };
  /** Local save key (default = id); blank:<example> when opened from blank so examples don't overwrite each other */
  key?: string;
  /** Only reached from the basics course (H-15): kept off the home page and the work menu. */
  courseOnly?: boolean;
  /** Bench parts instead of the example's (H-16: basics adds a buzzer to the s3-blink bench without changing that example). */
  scene?: SceneSpec;
}

/** Live sim + 3D bench: one per page, not rebuilt on step change */
export interface Session {
  bench: Bench;
  pick: Partial<ScenePickApi>;
  sim: LiveSim | null;
  scene: SceneSpec;
  /** Power: null = project default bench (USB 5 V only); set from the list with or without external 5 V */
  power: { ext5v: boolean } | null;
  /** Rebuild the bench from the list (P0-09); re-powers with current firmware if I2C / round LCD changed */
  applyScene(scene: SceneSpec, power: { ext5v: boolean }, label?: string): void;
  /** Timeline label from the last applyScene (e.g. "Place LED on GPIO5"; empty when applied from the list) */
  sceneLabel?: string;
  fwName: string;
  fwSize: number;
  chip: 'esp32' | 'esp32c3' | 'esp32s3';
  levels: Level[];
  /** Latest frame: PWM duty, RGB LED, OLED */
  frame: { pwm: number[]; pwmFreq: number[]; gpio: number; enable: number; gpioHi: number; enableHi: number; rgb: number[] | null; strips: Record<number, number[][]>; oled: Uint8Array | null; lcd: Uint8Array | null; lcdW?: number; lcdH?: number; elec: ElecFrame | null; pins: PinDevFrame | null };
  /** Part near the heat source (display only; readings follow ambient temperature) */
  heat: string | null;
  setHeat(part: string | null): void;
  /** USB vs external 5 V: updates list and power display, switches the supply live (logged as input) */
  setPower(ext5v: boolean): void;
  /** Brownout reset (sim time, seconds) */
  onBrownout(cb: (tSec: number) => void): () => void;
  /** Core crash (simulator bug, R-04): message from the panic hook */
  onCrash(cb: (message: string) => void): () => void;
  /** Rewiring (to create faulty wiring for the wiring rules) */
  wireMods: WireMods;
  setWireMods(m: WireMods): void;
  /** For rewind: swap the scene display without re-powering (seek restores sim state) */
  restoreScene(scene: SceneSpec, power: { ext5v: boolean } | null): void;
  /** H-09: draw only these part ids on the bench (null = all); `scene` and the sim's devices stay complete. Rebuilds only on change */
  setBenchParts(keep: readonly string[] | null): void;
  onTick(cb: (m: Extract<FromWorker, { type: 'tick' }>) => void): () => void;
  onBoot(cb: () => void): () => void;
  onRunEnd(cb: (snap: Snapshot) => void): () => void;
  /** Page-wide power-on count */
  bootCount: number;
  snapshot(): Promise<Snapshot | null>;
  mark(): Promise<number>;
  seek(job: SeekJob): Promise<Snapshot>;
  continueRun(): void;
  /** Firmware image running on the bench (reference or user-dropped) */
  fwBuf: ArrayBuffer | null;
  /** Buzzer sound (muted by default), driven by live PWM events */
  audio: BuzzerAudio;
  /** Sensor offset (°C) caused by mounting; only applied in the product step */
  sensorOffset: number;
  setSensorOffset(d: number): void;
  /** Subscribe to new serial text; returns an unsubscribe function */
  onConsole(cb: (text: string) => void): () => void;
  /** Re-power (the toolbar Restart button) */
  reboot(): void;
  /** Run another firmware on the bench (user-dropped .bin) */
  loadFirmware(buf: ArrayBuffer, name: string): void;
  /** H-19: the open lesson runs no code, so the work's firmware stays off (true stops a running one, false powers it up) */
  held: boolean;
  hold(on: boolean): void;
  pressBoot(down: boolean): void;
  /** External key (breadboard key, product keypad): pressed = tied to ground */
  pressPin(pin: number, down: boolean): void;
  /** Encoder (P2-01): turn by steps (positive = clockwise) and press; both logged as input */
  turnEncoder(steps: number): void;
  pressEncoder(down: boolean): void;
  /** Ultrasonic (P2-04): sensor-to-obstacle distance in cm (negative = no obstacle); the bench obstacle follows */
  setDistance(cm: number): void;
  /** Current distance (cm) */
  distance: number;
  setEnv(e: Partial<Env>): void;
  /** Mic (INMP441) source: test WAV name / 'silence' / 'live' (browser mic); returns a hint (on failure, what it fell back to) */
  micSource: string;
  setMicSource(src: string): Promise<string>;
  /** Potentiometers (analog input sliders): pin → mV, re-applied after each power-on */
  analog: Map<number, number>;
  setAnalog(pin: number, mv: number): void;
  /** ADC model (D-02): true = ideal (linear, exact), false = real (default); re-applied after each power-on */
  adcIdeal: boolean;
  setAdcIdeal(ideal: boolean): void;
  /** Whether the bench has an IMU (gates the tilt slider and dragging) */
  hasImu(): boolean;
  /** Set pose (P2-03): sent to the sim with angular rate while dragging, rate 0 150 ms after stopping; the bench tilts too */
  setPose(p: { pitch: number; roll: number; yaw: number }): void;
  /** Touch the screen (P2-02): x, y in screen pixels */
  touch(x: number, y: number, down: boolean): void;
  /** AXP2101 battery set from the board panel (E-03); null = board default. Kept across reboots */
  battery: { pct: number; usb: boolean } | null;
  setBattery(pct: number, usb: boolean): void;
  /** PWR key on the AXP2101 PWRON pin (E-03): short or long press */
  pwrKey(long: boolean): void;
  /** Virtual PC (E-07b) wanted on: pc=on is sent after every boot. From the example's `pc`, then the panel toggle */
  deskPc: boolean;
  /** Voice server script wanted after every boot (F-09b-2); null = server off. From the example's `xz`, then the voice panel */
  xzScript: string | null;
  consoleText(): string;
  /** Logic analyzer events since this power-on / rewind replay (P1-05) */
  io: IoStore;
  /** FreeRTOS task timeline since this power-on / rewind replay (C-04) */
  tasks: TaskStore;
  /** Fires on new events or a store reset */
  onIo(cb: () => void): () => void;
  /** Watched GPIOs (PWM / WS2812 / I2C are recorded regardless) */
  ioPins(): number[];
  /** Change watched GPIOs: effective now (newly watched pins record from this moment) and kept across power-ons */
  watchIo(pins: number[]): void;
  /** Harness (P2-11, estimate): I2C cable length, antenna blockage; applied live, logged, kept across power-ons */
  harness: Harness;
  setHarness(h: Harness): void;
  /** Harness verdict text from the sim (rise time / RSSI); empty when unset */
  harnessText: string;
  onHarness(cb: (text: string) => void): () => void;
  /** Pads the firmware drove its I2C controllers on (P2-16 wiring hint); empty until the first access */
  i2cFw: { sda: number; scl: number }[];
  onI2cFw(cb: () => void): () => void;
  /** Timing-sensitive code found by the core (D-03); null = none. Reset on each power-on */
  timing: TimingReport | null;
  onTiming(cb: (r: TimingReport | null) => void): () => void;
  /** Fine capture (D-04): state (null = none), start (absolute window or armed on the next burst start), VCD text */
  vcd: VcdState | null;
  onVcd(cb: (s: VcdState | null) => void): () => void;
  vcdStart(pins: number[], from: number, len: number, trigger: boolean): void;
  vcdText(): Promise<{ text: string; state: VcdState | null }>;
  /** What the virtual USB host sees (P2-12); null = no USB device */
  usb: UsbView | null;
  onUsb(cb: (v: UsbView | null) => void): () => void;
}

/** A shell region whose content a step replaces wholesale (tree, props, layer); render rebuilds every time.
 *  el is the container, for imperative querySelector / scrolling */
export interface Panel {
  render(node: ReactNode): void;
  readonly el: HTMLElement;
}

export interface Shell {
  tree: Panel;
  props: Panel;
  /** Step layer over the bench (placeholder card, shop grid, assembly / product views) */
  layer: Panel;
  toolbar: Toolbar;
  timeline: Timeline;
  card: Card;
  /** Text and state of the top-right verdict button */
  setVerdict(text: string, state: 'ok' | 'bad' | 'warn' | 'idle'): void;
  /** Verdict button action (each step sets it on mount) */
  onVerdict(fn: (() => void) | null): void;
  /** Top-right Next button: to = null disables it; onGo, if given, handles navigation. state: go = outlined,
   *  hot = just unlocked (filled), lock = grey + lock (label says what's missing), end = last step; default go / lock by to */
  setNext(label: string, to: StepId | null, why?: string, onGo?: () => void, state?: NextState): void;
  /** Show only the centre card (side panels and run group hidden); reset on step change */
  setBare(on: boolean): void;
  /** One-line bottom hint that fades after a few seconds */
  toast(text: string): void;
  /** Bench container (quick-card coordinates are relative to it) */
  stage: HTMLElement;
}

export interface StepCtx {
  work: WorkDef;
  store: Store<AppState>;
  session: Session;
  shell: Shell;
  /** Bench timeline (P0-03); bench only */
  hist?: BenchHistory;
  /** work=custom: chosen board and per-part checkpoints (including manual entries, U-17) */
  custom?: { plan: CustomPlan; levels: Level[] };
}

export interface StepImpl {
  /** Tree, props and layer are all reached via ctx.shell */
  mount(ctx: StepCtx): void;
  unmount(): void;
}

export type { ScreenPoint };
