// 3D bench: 830-hole breadboard, ESP32 devboards, add-on modules, Dupont wires; all procedurally generated at real size (mm).
// No vendor design files or 3D models; pin order comes from Espressif's public user guides (facts).

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { createUsbHost, type UsbView } from './usb3d';
import { extModelsOn, loadExt, onExtModels, reportExt } from './extmodels';
import { SANS, type PickTarget, type PinInfo, type ScenePickApi, type ScreenPoint } from './scene-api';
import { capturableOf, type Capturable } from './app/capture';
import { poseToThree, threeToPose, type Pose } from './imupose';
import { t } from './i18n';
import { shaderWarm } from './shaderwarm';
import { PITCH, type ExtSlot, WIRE, ACCENT, BAD, MAT, disposeTree, canvasTexture, contactShadow, type PinRec, pinHits } from './bench3d/util';
import { type ChipId, apiId, BOARD_C3, BOARDS, LCD_WIRING, BB, rowZ, breadboard, devboard } from './bench3d/boards';
import { TP_PINS, roundLcdModule, imuModule, oledModule, bmeModule, servoModel, buzzerModule, encoderModule, stickModule, ledGlow, dht11Module, sonarModule, obstacleModel, ampModule, speakerModel, micModule, keySwitch, potModel, led, resistor } from './bench3d/modules';
import { type WireRec, WIRE_R, wire } from './bench3d/wires';
export { BOARD_C3, BOARD_S3, BOARD_E32, BOARDS, LCD_WIRING } from './bench3d/boards';
export type { ChipId, BoardSpec } from './bench3d/boards';

export { I2S_WIRING } from './i2spins.ts';
import { I2S_WIRING } from './i2spins.ts';

/** Add-on parts declared by an example (scene.parts in examples.json). */
export type PartSpec =
  | { type: 'led'; pin: number; color?: number; col?: number; label?: string }
  | { type: 'oled'; addr: number; sda: number; scl: number; label?: string }
  /** 1.28″ GC9A01 round LCD (SPI2): pins fixed per chip, see LCD_WIRING (S3: SCLK=12, MOSI=11, CS=10, DC=14, RST=13, BL=15; C3: 6, 7, 10, 5, 4, 3) */
  | { type: 'gc9a01'; spi?: number; label?: string }
  | { type: 'bme280'; addr: number; sda: number; scl: number; label?: string }
  /** SG90 servo: signal on pin; horn angle follows PWM pulse width (0.5–2.5 ms → 0–180°) */
  | { type: 'servo'; pin: number; freq?: number; label?: string }
  /** 10 kΩ potentiometer: ends on 3V3 / GND, wiper on pin (ADC); the knob is draggable */
  | { type: 'pot'; pin: number; label?: string }
  /** Passive 3-pin buzzer module: I/O on pin, LEDC square wave; sound in audio.ts, in 3D the diaphragm moves and emits waves */
  | { type: 'buzzer'; pin: number; label?: string }
  /** 6×6 mm tactile key across the centre groove: pin to GND, firmware enables pull-up; holding the cap pulls the pin low. cap = keycap text */
  | { type: 'key'; pin: number; cap?: string; label?: string }
  /** EC11 rotary encoder module (KY-040 style, P2-01): CLK = a, DT = b, push switch sw; 3V3 powered. Drag / wheel / click the knob */
  | { type: 'encoder'; a: number; b: number; sw?: number; label?: string }
  /** HC-SR04 ultrasonic (P2-04): 5 V supply; Echo enters GPIO via a 1 kΩ / 2 kΩ divider (divider: false = direct, wiring check flags 5 V on GPIO).
   *  cm = initial distance to a draggable obstacle in front; distance is measured by a raycast */
  | { type: 'hcsr04'; trig: number; echo: number; divider?: boolean; cm?: number; label?: string }
  /** MPU6050 6-axis module (GY-521, 8 pins, laid flat): I2C; INT optional (P2-03) */
  | { type: 'mpu6050'; addr: number; sda: number; scl: number; int?: number; label?: string }
  /** QMI8658 6-axis module (6 pins, laid flat): I2C (P2-03) */
  | { type: 'qmi8658'; addr: number; sda: number; scl: number; label?: string }
  /** CST816S touch layer on the round LCD (P2-02): with gc9a01 the LCD becomes the 12-pin touch version; clicking the screen = touch */
  | { type: 'cst816s'; addr: number; sda: number; scl: number; int: number; rst?: number; label?: string }
  /** MAX98357A I2S amp module + 4 Ω speaker: pins fixed per chip (I2S_WIRING); sound in pcm.ts, the 3D cone follows the volume */
  | { type: 'max98357a'; label?: string }
  /** INMP441 I2S digital mic module (L/R to GND = left channel): pins fixed per chip, see I2S_WIRING */
  | { type: 'inmp441'; label?: string }
  /** 8-LED WS2812 stick (P2-09 knob lamp): DIN on pin (via 74AHCT125 to 5 V, illustrative), 5V supply; lies on the desk in front, colours from core-decoded frames */
  | { type: 'ws2812'; pin: number; n?: number; label?: string }
  /** DHT11 temperature / humidity module (D-03): 3 pins (VCC 3V3, DATA open drain with 10 kΩ pull-up on the module, GND); single-wire protocol */
  | { type: 'dht11'; pin: number; label?: string };


/** The scene's IMU (bench tilt / drag only works when there is one) */
export const imuPart = (s: SceneSpec) => s.parts.find((p): p is Extract<PartSpec, { type: 'mpu6050' | 'qmi8658' }> => p.type === 'mpu6050' || p.type === 'qmi8658');

export interface SceneSpec {
  parts: PartSpec[];
  /** Initial camera (mm, world coordinates) */
  view?: { position: [number, number, number]; target: [number, number, number] };
}

const DEFAULT_VIEW: Required<SceneSpec>['view'] = { position: [-40, 95, 105], target: [0, 6, 4] };

export interface Bench extends ScenePickApi {
  /** Rebuild add-on parts and wiring from the example (board and breadboard stay) */
  setScene(spec: SceneSpec): void;
  /** Pin level / output enable: low 32 bits passed apart from the high bits (JS bit ops are 32-bit, S3 has 49 pins) */
  setGpio(level: number, enable: number, pwm?: number[], levelHi?: number, enableHi?: number): void;
  /** Servo output shaft angle (deg) from the core's servo dynamics; once set, this servo stops chasing the PWM target itself */
  setServoAngle(pin: number, deg: number): void;
  /** I2S audio: current speaker volume (RMS, full scale = 1) and mic input level; drive cone motion and the mic ring */
  setAudio(spk: number, mic: number): void;
  /** Switch devboard (by the firmware's chip); add-on parts are rewired */
  setBoard(chip: ChipId): void;
  /** OLED frame: 128×64 brightness bytes */
  setOled(pixels: Uint8Array): void;
  /** GC9A01 frame: 240×240 RGBA */
  setLcd(rgba: Uint8Array): void;
  /** Bench pose (P2-03): breadboard, board and modules tilt together; null = level */
  setPose(p: Pose | null): void;
  /** User drags the IMU module to rotate the bench: move = dragging (≈30 Hz), end = release */
  onPose(cb: (p: Pose, phase: 'move' | 'end') => void): void;
  /** User taps / drags the touch LCD (P2-02): x, y in screen pixels 0..239 */
  onTouch(cb: (x: number, y: number, down: boolean) => void): void;
  /** Page position (clientX/Y) of LCD pixel (x, y) so tests can click with a real mouse; null if no LCD or not visible */
  lcdPoint(x: number, y: number): [number, number] | null;
  /** Page position (clientX/Y) of the IMU module so tests can drag with a real mouse */
  imuScreenPos(): [number, number] | null;
  /** Potentiometer position 0..1 (syncs the 3D knob after the panel slider changes) */
  setPot(pin: number, v: number): void;
  /** User drags the potentiometer knob in 3D */
  onPot(cb: (pin: number, v: number) => void): void;
  /** Encoder: user dragged / scrolled the knob by steps detents (positive = clockwise); knob pressed / released */
  onEncoder(cb: (steps: number) => void): void;
  onEncoderPress(cb: (down: boolean) => void): void;
  /** Encoder knob position shown (detents; from the core, resynced after rewind) */
  setEncoder(pos: number): void;
  /** Ultrasonic: raycast distance after the obstacle is dragged (cm; -1 = nothing in front) */
  onDistance(cb: (cm: number) => void): void;
  /** Put the obstacle at cm (panel / card changed it; negative = remove); returns the distance the ray actually measured */
  setDistance(cm: number): number;
  /** Ultrasonic fired one measurement (sound-wave animation) */
  pingSonar(): void;
  /** Page position (clientX/Y) of encoder knob / obstacle for automated real-mouse drags; null if not visible */
  encoderScreenPos(): [number, number] | null;
  obstacleScreenPos(): [number, number] | null;
  setPowered(on: boolean): void;
  /** Onboard WS2812 (C3 GPIO8 / S3 GPIO48) colour, 0–255 */
  setRgb(rgb: number[]): void;
  /** External WS2812 strip (on pin) per-LED colours, 0–255 */
  setStrip(pin: number, leds: number[][]): void;
  onButton(cb: (name: 'BOOT' | 'RST', down: boolean) => void): void;
  /** Breadboard tactile key (PartSpec 'key') pressed / released */
  onKey(cb: (pin: number, down: boolean) => void): void;
  /** Key page position (clientX/Y) for tests; null if not visible */
  keyScreenPos(pin: number): [number, number] | null;
  /** Button page position (clientX/Y) so automated tests can press the 3D button with a real mouse; null if not visible */
  buttonScreenPos(name: 'BOOT' | 'RST'): [number, number] | null;
  /** Native USB: plug in the virtual PC once firmware enumerates a device (null = unplug) */
  setUsb(v: UsbView | null): void;
  /** Photo / video capture (P2-10) */
  capture(): Capturable;
  /** External model replacement toggle (P1-09); extModels() lists the external models shown right now */
  setExtModels(on: boolean): void;
  extModels(): string[];
  /** Brightness each external LED should have now (0–1, from GPIO / PWM frames): lets tests check bench LEDs really follow their pins */
  ledLevels(): { pin: number; target: number }[];
  /** Perf baseline: last frame's draw calls, triangles and mean frame interval */
  stats(): { calls: number; triangles: number; frameMs: number; cpuMs: number; geometries: number; textures: number };
  /** View buttons (U-04): top / front / zoom in / zoom out / fit selection (whole scene if nothing is selected) */
  view(k: 'top' | 'front' | 'in' | 'out' | 'fit', sel?: { kind: string; id: string } | null): void;
  dispose(): void;
}

// ---------------------------------------------------------------- scene

export function createBench(container: HTMLElement): Bench {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // No tone mapping: the white minimal style needs background and part colours to match the design; emitters rely on bloom, >1 clips by hue
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.32;

  const camera = new THREE.PerspectiveCamera(35, 1, 1, 2000);
  camera.position.set(-40, 95, 105);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 6, 4);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 14;
  controls.maxDistance = 420;

  const key = new THREE.DirectionalLight(0xfffaf2, 1.9);
  key.position.set(-70, 170, 80);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -130;
  key.shadow.camera.right = 130;
  key.shadow.camera.top = 110;
  key.shadow.camera.bottom = -110;
  key.shadow.radius = 5;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xdfe3e8, 1.35);
  scene.add(hemi);

  // The ground only receives shadows (white minimal look); contact shadows come from the soft shadow cards under each part
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.16 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Theme: bench background gradient (DESIGN §2)
  const gradient = (inner: string, outer: string) => {
    const t = canvasTexture(512, 512, (g) => {
      g.fillStyle = outer;
      g.fillRect(0, 0, 512, 512);
      g.save();
      g.translate(256, 205);
      g.scale(1.2, 0.9);
      const r = g.createRadialGradient(0, 0, 0, 0, 0, 512);
      r.addColorStop(0, inner);
      r.addColorStop(1, outer);
      g.fillStyle = r;
      g.fillRect(-512, -512, 1024, 1024);
      g.restore();
    });
    return t;
  };
  const themes = {
    light: { bg: gradient('#FFFFFF', '#ECEFF3'), shadow: 0.16, hemi: 1.35, key: 1.9 },
    dark: { bg: gradient('#2C2E33', '#141518'), shadow: 0.45, hemi: 0.75, key: 1.6 },
  };
  const applyTheme = (t: 'light' | 'dark') => {
    const th = themes[t];
    scene.background = th.bg;
    groundMat.opacity = th.shadow;
    hemi.intensity = th.hemi;
    hemi.groundColor.set(t === 'light' ? 0xdfe3e8 : 0x303238);
    key.intensity = th.key;
    overlay.dataset.theme = t;
  };

  // DOM overlay: disclaimer, pin tags, fault tags, ruler readout
  const overlay = document.createElement('div');
  overlay.className = 'tb-overlay';
  overlay.style.cssText = `position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;font:12px ${SANS}`;
  const note = document.createElement('div');
  note.className = 'tb-note';
  note.textContent = t('Illustration only, not an official Espressif model');
  note.style.cssText = 'position:absolute;right:12px;bottom:10px;font-size:11px;color:var(--muted, #6f6f6f);letter-spacing:.02em';
  overlay.appendChild(note);
  const style = document.createElement('style');
  style.textContent = `.tb-tag{position:absolute;left:0;top:0;white-space:nowrap;padding:3px 8px;border-radius:8px;background:rgba(255,255,255,.95);border:1px solid #E6E6E6;box-shadow:0 2px 10px #0000000F;color:#1E1E1E;font:500 12px "JetBrains Mono",Menlo,monospace;will-change:transform}
.tb-tag.pin{border-color:#0D99FF;color:#0D99FF}.tb-tag.bad{background:#FEF2F2;border-color:#F24822;color:#F24822;font-family:${SANS}}
.tb-tag.ruler{background:#F24822;border-color:#F24822;color:#fff}
.tb-overlay[data-theme=dark] .tb-tag:not(.bad):not(.ruler){background:rgba(30,31,34,.95);border-color:#3a3c40;color:#E9EDF2}.tb-overlay[data-theme=dark] .tb-tag.pin{color:#5cb8ff;border-color:#0D99FF}`;
  overlay.appendChild(style);
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(overlay);
  const tags = new Map<string, { el: HTMLDivElement; at: () => THREE.Vector3 | null; dy: number }>();
  const setTag = (key: string, text: string | null, cls: string, at: () => THREE.Vector3 | null, dy = -14) => {
    const old = tags.get(key);
    if (!text) {
      old?.el.remove();
      tags.delete(key);
      return;
    }
    const el = old?.el ?? document.createElement('div');
    el.className = 'tb-tag ' + cls;
    el.textContent = text;
    if (!old) overlay.appendChild(el);
    tags.set(key, { el, at, dy });
  };

  // Breadboard and devboard follow the chip (setBoard); add-on parts shift as a whole by partOffset
  const BB_TOP = BB.H;
  // The whole bench (breadboard + board + add-ons) hangs under rig so it tilts together when there is an IMU (P2-03).
  // rig must be identity while building: part positions are computed in world coordinates before being attached
  const rig = new THREE.Group();
  scene.add(rig);
  rig.add(breadboard());
  // External models (P1-09): procedural by default; when on, lazy-load glb to replace slot parts, and swap back when off
  let extOn = extModelsOn();
  let slots: ExtSlot[] = [];
  const attached = (o: THREE.Object3D) => {
    while (o.parent) o = o.parent;
    return o === scene;
  };
  const loading = new Set<ExtSlot>();
  function applySlot(sl: ExtSlot) {
    if (!extOn || !sl.model) {
      sl.proc.forEach((p) => (p.visible = true));
      if (sl.model) sl.model.visible = false;
      sl.fit(null);
      if (extOn && sl.model === undefined && !loading.has(sl)) {
        loading.add(sl);
        void loadExt(sl.name).then((m) => {
          loading.delete(sl);
          sl.model = m;
          if (m) sl.root.add(m);
          if (attached(sl.root)) applySlot(sl);
        });
      }
      return;
    }
    sl.proc.forEach((p) => (p.visible = false));
    sl.model.visible = true;
    sl.fit(sl.model);
  }
  const useSlot = (sl: ExtSlot) => {
    slots = slots.filter((x) => attached(x.root));
    slots.push(sl);
    applySlot(sl);
  };
  const extList = () => slots.filter((x) => attached(x.root) && extOn && x.model && x.model.visible).map((x) => x.name);
  const setExt = (on: boolean) => {
    extOn = on;
    slots = slots.filter((x) => attached(x.root));
    slots.forEach(applySlot);
  };
  const offExt = onExtModels(setExt);
  const offReport = reportExt(extList);
  let board = devboard(BOARD_C3);
  const placeBoard = () => {
    // Board long side along x: rotate -90°, USB to the left; header blocks sit on the breadboard surface
    board.grp.rotation.y = -Math.PI / 2;
    board.grp.position.set((board.spec.boardCol - (board.spec.cols - 1) / 2) * PITCH, BB_TOP + 2.5 + board.T / 2, board.spec.rowSpan === 25.4 ? PITCH / 2 : 0);
    rig.add(board.grp);
    board.grp.updateMatrixWorld();
    board.extSlots.forEach(useSlot);
  };
  placeBoard();
  /** Breadboard column for parts (shifted per board; numbering keeps the old half-breadboard base so example cameras stay put) */
  const colX = (c: number) => (c + board.spec.partOffset - (board.spec.cols - 1) / 2) * PITCH;
  const pinWorld = (key: string) => board.pinPositions[key].clone().applyMatrix4(board.grp.matrixWorld);

  /** World position of a board pin ('IO5', '3V3', 'GND'…); all candidates, callers pick the one nearest */
  const pinCands = (name: string) => {
    const cands: { key: string; p: THREE.Vector3 }[] = [];
    board.spec.right.forEach((n, i) => n === name && cands.push({ key: 'R' + i, p: pinWorld('R' + i) }));
    board.spec.left.forEach((n, i) => n === name && cands.push({ key: 'L' + i, p: pinWorld('L' + i) }));
    if (!cands.length) throw new Error(`Board ${board.spec.title} has no pin ${name}`);
    return cands;
  };
  /** Jumpers plug into the same column as the board pin, in the outer row (a / j); for duplicate names (GND) prefer a free one */
  let holeUse = new Map<string, number>();
  const boardHole = (name: string, near?: THREE.Vector3) => {
    let cands = pinCands(name);
    if (near) cands = cands.sort((a, b) => a.p.distanceTo(near) - b.p.distanceTo(near));
    const c = cands.find((c) => !holeUse.get(c.key)) ?? cands[0];
    holeUse.set(c.key, (holeUse.get(c.key) ?? 0) + 1);
    // If the pin is already in the outermost row (DevKitC V4 J1 lands on row j) there is no free hole outside: use the pin's own hole
    const z = Math.abs(c.p.z) > -rowZ(0) - 0.5 ? c.p.z : Math.sign(c.p.z) * -rowZ(0);
    return new THREE.Vector3(c.p.x, BB_TOP, z);
  };

  const lift = (v: THREE.Vector3, y: number) => new THREE.Vector3(v.x, y, v.z);
  const top = BB_TOP;

  // Pick registries (rebuilt on every setScene / setBoard)
  const partsById = new Map<string, THREE.Object3D>();
  let modulePins: PinRec[] = [];
  let wires: WireRec[] = [];
  /** Rewired wires: id → the original wire (swapped back when rewire reverts) */
  let rewired = new Map<string, WireRec>();
  let roles = new Map<string, string[]>();
  const addRole = (pinId: string, role: string) => {
    const r = roles.get(pinId) ?? [];
    if (!r.includes(role)) r.push(role);
    roles.set(pinId, r);
  };
  const addWire = (grp: THREE.Group, points: THREE.Vector3[], color: number, boardPin: string, other: string) => {
    const a = apiId(boardPin);
    let id = `wire:${a}~${other}`;
    for (let k = 2; wires.some((w) => w.id === id); k++) id = `wire:${a}~${other}#${k}`;
    const w = wire(points, color, id, [a, other]);
    grp.add(w.grp);
    wires.push(w);
    return w;
  };
  /** Jumper from a board pin to a breadboard hole, arched in the middle. arc is measured from the breadboard surface: plugs are 11 mm tall,
   *  and an absolute arch height would graze the tops of other plugs */
  const jumper = (grp: THREE.Group, pin: string, to: THREE.Vector3, color: number, other: string, arc = 26, bow = 6) => {
    const a = boardHole(pin, to);
    const b = lift(to, top);
    const h = top + arc;
    addWire(grp, [a, lift(a, h - 4), new THREE.Vector3((a.x + b.x) / 2, h, (a.z + b.z) / 2 + bow), lift(b, h - 6), b], color, pin, other);
  };
  const registerPart = (id: string, o: THREE.Object3D) => {
    o.userData.pick = { kind: 'part', id } satisfies PickTarget;
    partsById.set(id, o);
  };
  const registerModulePins = (partId: string, root: THREE.Group, pins: THREE.Vector3[], labels: string[]) => {
    const recs = labels.map((l, i) => ({ id: `${partId}:${l}`, label: l, anchor: pins[i].clone(), parent: root }));
    // Pick boxes cover only the header plastic and the very bottom of the PCB; taller ones would cover the module and steal clicks
    pinHits(root, recs, pins.map((p) => new THREE.Vector3(p.x, 2, p.z)), [2.3, 4, 2.8], modulePins);
  };

  // Callouts (part notes, light pills)
  const tl = (s?: string) => (s === undefined ? undefined : t(s));
  const label = (grp: THREE.Group, text: string, pos: THREE.Vector3) => {
    const font = `500 38px ${SANS}`;
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = font;
    const w = Math.ceil(probe.measureText(text).width) + 64;
    const tex = canvasTexture(w, 128, (g) => {
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.strokeStyle = '#E6E6E6';
      g.lineWidth = 3;
      g.beginPath();
      g.roundRect(4, 4, w - 8, 120, 28);
      g.fill();
      g.stroke();
      g.fillStyle = '#1E1E1E';
      g.font = font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, 66);
    });
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    s.scale.set((5 * w) / 128, 5, 1);
    s.position.copy(pos);
    s.renderOrder = 10;
    s.raycast = () => {};
    grp.add(s);
  };

  interface LedState {
    pin: number;
    lens: THREE.MeshPhysicalMaterial;
    light: THREE.PointLight;
    now: number;
    target: number;
  }
  let leds: LedState[] = [];
  let servos: { pin: number; horn: THREE.Group; freq: number; angle: number; target: number; phys?: boolean }[] = [];
  let pots: { pin: number; knob: THREE.Group; hit: THREE.Mesh; v: number }[] = [];
  let buzzers: { pin: number; membrane: THREE.Mesh; waves: THREE.Group; waveMat: THREE.MeshBasicMaterial; on: boolean }[] = [];
  let keys: { pin: number; key: THREE.Mesh }[] = [];
  let speakers: { cone: THREE.Group; waves: THREE.Group; waveMat: THREE.MeshBasicMaterial }[] = [];
  let mics: { ring: THREE.Mesh; ringMat: THREE.MeshBasicMaterial }[] = [];
  /** Current speaker volume (RMS, full scale = 1) and mic input level: cone motion, sound waves / pickup ring */
  let spkLevel = 0;
  let micLevel = 0;
  let potCb: ((pin: number, v: number) => void) | null = null;
  // Encoder knob (shown position = core position + detents dragged but not yet applied), ultrasonic transducer + obstacle
  let encoder: { knob: THREE.Group; hit: THREE.Mesh; pos: number; pushed: boolean; y0: number } | null = null;
  let strips: { pin: number; lenses: THREE.MeshStandardMaterial[]; light: THREE.PointLight }[] = [];
  /** Last strip frame (only sent when new, so a rebuilt scene relights from it) */
  const stripLast = new Map<number, number[][]>();
  function paintStrip(st: (typeof strips)[number], leds: number[][]) {
    let sum = [0, 0, 0];
    let peak = 0;
    st.lenses.forEach((mat, i) => {
      const c = leds[i] ?? [0, 0, 0];
      peak = Math.max(peak, ledGlow(mat, c).peak);
      sum = sum.map((v, k) => v + c[k]);
    });
    const m = Math.max(...sum);
    st.light.color.setRGB(m ? sum[0] / m : 0, m ? sum[1] / m : 0, m ? sum[2] / m : 0);
    st.light.intensity = peak * 120;
  }
  let encCb: ((steps: number) => void) | null = null;
  let encSwCb: ((down: boolean) => void) | null = null;
  let sonar: { origin: THREE.Vector3; dir: THREE.Vector3; face: number; obstacle: THREE.Group; panel: THREE.Mesh; waves: THREE.Group; waveMat: THREE.MeshBasicMaterial; pingT: number; cm: number } | null = null;
  let distCb: ((cm: number) => void) | null = null;
  let parts = new THREE.Group();
  rig.add(parts);
  /** Touch LCD screen mesh (a ray hitting it = finger on the screen) */
  let touchScreen: THREE.Mesh | null = null;
  const oledData = new Uint8Array(128 * 64 * 4);
  let oledTex: THREE.DataTexture | null = null;
  const lcdData = new Uint8Array(240 * 240 * 4);
  let lcdTex: THREE.DataTexture | null = null;

  function buildLed(grp: THREE.Group, p: Extract<PartSpec, { type: 'led' }>) {
    const root = new THREE.Group();
    const id = `led:${p.pin}`;
    registerPart(id, root);
    grp.add(root);
    const l = led(p.color ?? 0xff2a1a);
    const col = p.col ?? 24;
    l.grp.position.set(colX(col) + 1.27, BB_TOP + 2, rowZ(7));
    root.add(l.grp);
    const r = resistor();
    r.position.set(colX(col - 2), BB_TOP + 1.5, rowZ(7));
    root.add(r);
    // IO → column of the resistor's left end; LED cathode → GND
    jumper(grp, 'IO' + p.pin, new THREE.Vector3(colX(col - 4), top, rowZ(9)), WIRE.sig, `${id}:IN`, 30, 6);
    jumper(grp, 'GND', new THREE.Vector3(colX(col + 1), top, rowZ(9)), WIRE.gnd, `${id}:GND`, 24, 10);
    addRole(apiId('IO' + p.pin), t('LED (220 Ω current limit)'));
    addRole('GND', t('{name} GND', { name: 'LED' }));
    label(grp, tl(p.label) ?? `GPIO${p.pin} → 220Ω → LED`, new THREE.Vector3(colX(col - 1), 34, rowZ(2) - 6));
    leds.push({ pin: p.pin, lens: l.lens, light: l.light, now: 0, target: 0 });
  }

  /** Jumper to an upright module: rise over the board, then drop into row a of the same column behind the module so the screen stays clear */
  const moduleWire = (grp: THREE.Group, pin: string, hole: THREE.Vector3, color: number, other: string, peak: number, i: number) => {
    const a = boardHole(pin, hole);
    addWire(
      grp,
      [a, lift(a, 22 + i), new THREE.Vector3((a.x + hole.x) / 2, peak, Math.min(a.z, hole.z) - 6 - i * 1.5), new THREE.Vector3(hole.x, peak - 4, hole.z - 4), lift(hole, top + 15), hole],
      color,
      pin,
      other,
    );
  };

  /** Round LCD: 8 wires (GND VCC SCL SDA RES DC CS BLK); SCL/SDA here are SPI SCLK/MOSI */
  function buildSpiLcd(grp: THREE.Group, m: ReturnType<typeof roundLcdModule>, firstCol: number, tp?: Extract<PartSpec, { type: 'cst816s' }>) {
    m.grp.position.set(colX(firstCol + (m.labels.length - 1) / 2), BB_TOP, rowZ(4));
    m.grp.rotation.x = -0.12;
    registerPart('gc9a01', m.grp);
    registerModulePins('gc9a01', m.grp, m.pins.slice(0, 8), m.labels.slice(0, 8));
    grp.add(m.grp);
    // Pins match the core's wiring: S3 esp32s3::lcd_pin, C3 esp32c3::lcd_pin (same as firmware/common/round_lcd.h)
    const p = LCD_WIRING[board.spec.chip];
    const order: [string, number, string][] = [
      ['GND', WIRE.gnd, t('{name} GND', { name: 'LCD' })],
      ['3V3', WIRE.vcc, t('{name} power', { name: 'LCD' })],
      [`IO${p.sclk}`, WIRE.scl, 'SPI SCLK'],
      [`IO${p.mosi}`, WIRE.sda, 'SPI MOSI'],
      [`IO${p.rst}`, WIRE.sig, 'LCD RST'],
      [`IO${p.dc}`, 0x8f5bd6, 'LCD DC'],
      [`IO${p.cs}`, 0x3f8fd6, 'LCD CS'],
      [`IO${p.bl}`, 0xd6d6d6, t('LCD backlight')],
    ];
    order.forEach(([pinName, color, role], i) => {
      moduleWire(grp, pinName, new THREE.Vector3(colX(firstCol + i), top, rowZ(0)), color, `gc9a01:${m.labels[i]}`, 50 + i * 1.4, i);
      addRole(apiId(pinName), role);
    });
    if (!tp || !m.tp) return;
    // Touch layer's 4 pins: CST816S on I2C, INT pulled low while touched, RST driven by firmware
    registerPart('cst816s', m.tp);
    registerModulePins('cst816s', m.grp, m.pins.slice(8), TP_PINS);
    const tpw: [string, number, string][] = [
      [`IO${tp.sda}`, WIRE.sda, t('Touch I2C SDA')],
      [`IO${tp.scl}`, WIRE.scl, t('Touch I2C SCL')],
      [`IO${tp.int}`, 0x2fb8a8, t('Touch INT')],
      [tp.rst !== undefined ? `IO${tp.rst}` : '3V3', tp.rst !== undefined ? 0xa0a4aa : WIRE.vcc, tp.rst !== undefined ? t('Touch RST') : t('Touch RST (tied to 3V3)')],
    ];
    tpw.forEach(([pinName, color, role], k) => {
      const i = 8 + k;
      moduleWire(grp, pinName, new THREE.Vector3(colX(firstCol + i), top, rowZ(0)), color, `cst816s:${TP_PINS[k]}`, 50 + i * 1.4, i);
      addRole(apiId(pinName), role);
    });
  }

  /** Flat IMU: pins in row f (outer half), jumpers arch over from the board pins and land in row j of the same column */
  function buildImu(grp: THREE.Group, p: Extract<PartSpec, { type: 'mpu6050' | 'qmi8658' }>, firstCol: number) {
    const m = imuModule(p.type);
    const n = m.labels.length;
    m.grp.position.set(colX(firstCol + (n - 1) / 2), BB_TOP, rowZ(5));
    registerPart(p.type, m.grp);
    registerModulePins(p.type, m.grp, m.pins, m.labels);
    grp.add(m.grp);
    const name = p.type === 'mpu6050' ? 'MPU6050' : 'QMI8658';
    const int = 'int' in p ? p.int : undefined;
    const map: Record<string, [string, number, string] | undefined> = {
      VCC: ['3V3', WIRE.vcc, t('{name} power', { name })],
      VIN: ['3V3', WIRE.vcc, t('{name} power', { name })],
      GND: ['GND', WIRE.gnd, t('{name} GND', { name })],
      SCL: ['IO' + p.scl, WIRE.scl, 'I2C SCL'],
      SDA: ['IO' + p.sda, WIRE.sda, 'I2C SDA'],
      INT: int !== undefined ? ['IO' + int, 0x2fb8a8, `${name} INT`] : undefined,
    };
    m.labels.forEach((fn, i) => {
      const w = map[fn];
      if (!w) return;
      jumper(grp, w[0], new THREE.Vector3(colX(firstCol + i), top, rowZ(9)), w[1], `${p.type}:${fn}`, 20 + i * 1.5, 4 + i);
      addRole(apiId(w[0]), w[2]);
    });
  }

  function buildI2c(grp: THREE.Group, partId: string, name: string, m: { grp: THREE.Group; pins: THREE.Vector3[]; labels: string[] }, firstCol: number, sda: number, scl: number, height: number) {
    m.grp.position.set(colX(firstCol + 1.5), BB_TOP, rowZ(4));
    m.grp.rotation.x = -0.12; // tilted back slightly for a top-down view
    registerPart(partId, m.grp);
    registerModulePins(partId, m.grp, m.pins, m.labels);
    grp.add(m.grp);
    m.labels.forEach((fn, i) => {
      const map: Record<string, [string, number, string]> = {
        GND: ['GND', WIRE.gnd, t('{name} GND', { name })],
        VCC: ['3V3', WIRE.vcc, t('{name} power', { name })],
        VIN: ['3V3', WIRE.vcc, t('{name} power', { name })],
        SDA: ['IO' + sda, WIRE.sda, 'I2C SDA'],
        SCL: ['IO' + scl, WIRE.scl, 'I2C SCL'],
      };
      const [pinName, color, role] = map[fn];
      moduleWire(grp, pinName, new THREE.Vector3(colX(firstCol + i), top, rowZ(0)), color, `${partId}:${fn}`, height + 6 + i * 1.6, i);
      addRole(apiId(pinName), role);
    });
  }

  function buildServo(grp: THREE.Group, p: Extract<PartSpec, { type: 'servo' }>) {
    // Servo sits on the desk outside the breadboard: its own brown/red/orange lead → 3P female header on the desk → three Dupont wires to the board
    const root = new THREE.Group();
    registerPart('servo', root);
    grp.add(root);
    const m = servoModel();
    root.add(m.grp);
    useSlot(m.ext);
    // Placed straight in front, between the signal pin and 5V: short wires that don't arch over the board (BOOT key) or the BME280
    const sigX = pinCands('IO' + p.pin)[0].p.x;
    const v5X = pinCands('5V')[0].p.x;
    const sx = (sigX + v5X) / 2 + 8, sz = rowZ(9) + 44;
    m.grp.position.set(sx, 0, sz);
    m.grp.rotation.y = Math.PI;
    // 3P female header: black plastic, opening up
    const plug = new THREE.Vector3(sx - 8, 0, rowZ(9) + 26);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(7.6, 12, 2.6), MAT.plug);
    housing.position.set(plug.x + PITCH, 6, plug.z);
    housing.castShadow = true;
    root.add(housing);
    // Servo lead: three wires side by side, out of the case side, along the desk to the header bottom
    [0x6b4423, 0xd33a2c, 0xf28c28].forEach((c, i) => {
      const dz = (i - 1) * 1.0;
      const pts = [
        new THREE.Vector3(sx + 10, 4, sz + dz * 0.2),
        new THREE.Vector3(sx + 14, 1, sz - 4 + dz),
        new THREE.Vector3(plug.x + 14, 0.6, plug.z + 8 + dz),
        new THREE.Vector3(plug.x + PITCH * (2 - i) + 0.0, 0.6, plug.z + 4),
        new THREE.Vector3(plug.x + PITCH * (2 - i), 0.6, plug.z + 1.3),
      ];
      const t = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.5, 8), new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }));
      t.castShadow = true;
      root.add(t);
    });
    const pinLocal = [0, 1, 2].map((i) => new THREE.Vector3(plug.x + PITCH * (2 - i), 12, plug.z));
    // Header holes: GND (brown), VCC (red), PWM (orange)
    const labels = ['GND', 'VCC', 'PWM'];
    const recs = labels.map((l, i) => ({ id: `servo:${l}`, label: l, anchor: pinLocal[i].clone(), parent: root }));
    pinHits(root, recs, pinLocal.map((v) => v.clone().setY(9)), [2.4, 7, 3.2], modulePins);
    const cols: [string, number, string, string][] = [
      ['IO' + p.pin, WIRE.sig, 'PWM', t('SG90 signal')],
      ['5V', WIRE.vcc, 'VCC', t('{name} power', { name: 'SG90' })],
      ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'SG90' })],
    ];
    cols.forEach(([pin, color, end, role], i) => {
      const b = pinLocal[labels.indexOf(end)].clone();
      const a = boardHole(pin, b);
      // Rise just above neighbouring plugs (breadboard + 11 mm), then arch low toward the servo: a high arch hides BOOT and BME280 from the default camera
      addWire(grp, [a, lift(a, top + 13 + i), new THREE.Vector3((a.x + b.x) / 2, top + 15 + i * 2, (a.z + b.z) / 2 + 8), lift(b, 20), b], color, pin, `servo:${end}`);
      addRole(apiId(pin), role);
    });
    label(grp, tl(p.label) ?? t('SG90 servo · signal IO{pin} · 50 Hz', { pin: p.pin }), new THREE.Vector3(sx, 38, sz + 12));
    servos.push({ pin: p.pin, horn: m.horn, freq: p.freq ?? 50, angle: 90, target: 90 });
  }

  function buildPot(grp: THREE.Group, p: Extract<PartSpec, { type: 'pot' }>) {
    const m = potModel();
    const col = 19;
    m.grp.position.set(colX(col), BB_TOP + 1, rowZ(8));
    registerPart('pot', m.grp);
    grp.add(m.grp);
    // Left end → 3V3, wiper → IO, right end → GND (taken from row j of the same column)
    const ends: [number, string, number, string, string][] = [
      [col - 1, '3V3', WIRE.vcc, 'VCC', t('Potentiometer power')],
      [col, 'IO' + p.pin, WIRE.sig, 'OUT', t('Potentiometer wiper (ADC)')],
      [col + 1, 'GND', WIRE.gnd, 'GND', t('Potentiometer GND')],
    ];
    for (const [c, pin, color, end, role] of ends) {
      jumper(grp, pin, new THREE.Vector3(colX(c), top, rowZ(9)), color, `pot:${end}`, 20 + (c - col) * 2, 6);
      addRole(apiId(pin), role);
    }
    label(grp, tl(p.label) ?? t('Potentiometer · wiper on IO{pin} (ADC) · drag the knob', { pin: p.pin }), new THREE.Vector3(colX(col), 36, rowZ(9) + 6));
    pots.push({ pin: p.pin, knob: m.knob, hit: m.hit, v: 0.36 });
    m.knob.rotation.y = -(0.36 - 0.5) * 1.5 * Math.PI;
  }

  function buildKey(grp: THREE.Group, p: Extract<PartSpec, { type: 'key' }>, col: number) {
    const id = `key:${p.pin}`;
    const m = keySwitch(p.cap ?? String(keys.length + 1));
    // Spans the centre groove: four legs in rows e / f
    m.grp.position.set(colX(col) + 1.27, BB_TOP, 0);
    registerPart(id, m.grp);
    grp.add(m.grp);
    // Both wires enter from the back rows (a / b) so they don't block the keycap
    jumper(grp, 'IO' + p.pin, new THREE.Vector3(colX(col), top, rowZ(1)), WIRE.sig, `${id}:IN`, 24, -4);
    jumper(grp, 'GND', new THREE.Vector3(colX(col + 1), top, rowZ(0)), WIRE.gnd, `${id}:GND`, 16, -8);
    addRole(apiId('IO' + p.pin), t('Key {cap} (press = GND, internal pull-up)', { cap: p.cap ?? '' }));
    addRole('GND', t('Key GND'));
    if (p.label) label(grp, t(p.label), new THREE.Vector3(colX(col) + 1.27, 9, rowZ(9) + 13));
    m.key.userData.keyPin = p.pin;
    keys.push({ pin: p.pin, key: m.key });
  }

  function buildBuzzer(grp: THREE.Group, p: Extract<PartSpec, { type: 'buzzer' }>) {
    // Module lies on the desk in front of the breadboard near the I/O pin; three Dupont wires (female on the module header) to board 3V3 / GPIO / GND
    const root = new THREE.Group();
    registerPart('buzzer', root);
    grp.add(root);
    const m = buzzerModule();
    const sig = pinCands('IO' + p.pin)[0].p;
    const bx = sig.x - 18, bz = Math.sign(sig.z || 1) * (BB.D / 2 + 15);
    m.grp.position.set(bx, 0, bz);
    // Header faces the board
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    useSlot(m.ext);
    // Contact shadow is not parented to the pickable part: the selection outline would trace the shadow card's big box too
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    m.grp.updateMatrixWorld(true);
    const local = m.plugAt.map((v) => v.clone());
    // Pin pick boxes wrap the Dupont plugs (flat module, so the header sits higher than on upright modules)
    const recs = m.labels.map((l, i) => ({ id: `buzzer:${l}`, label: l, anchor: local[i].clone(), parent: m.grp }));
    pinHits(m.grp, recs, local.map((v) => v.clone().setY(v.y + 4)), [2.4, 9, 2.8], modulePins);
    const ends: [string, number, string, string][] = [
      ['3V3', WIRE.vcc, 'VCC', t('Buzzer module power')],
      ['IO' + p.pin, WIRE.sig, 'I/O', t('Buzzer (LEDC square wave)')],
      ['GND', WIRE.gnd, 'GND', t('Buzzer module GND')],
    ];
    ends.forEach(([pin, color, end, role], i) => {
      const b = local[m.labels.indexOf(end)].clone().applyMatrix4(m.grp.matrixWorld);
      const a = boardHole(pin, b);
      const h = top + 12 + i * 1.5;
      addWire(grp, [a, lift(a, h), new THREE.Vector3((a.x + b.x) / 2, h + 2, (a.z + b.z) / 2 + Math.sign(bz) * 4), lift(b, h - 2), b], color, pin, `buzzer:${end}`);
      addRole(apiId(pin), role);
    });
    label(grp, tl(p.label) ?? t('Passive buzzer · I/O on IO{pin}', { pin: p.pin }), new THREE.Vector3(bx, 6, bz + Math.sign(bz) * 20));
    buzzers.push({ pin: p.pin, membrane: m.membrane, waves: m.waves, waveMat: m.waveMat, on: false });
  }

  /** Modules lying on the desk in front of the breadboard (buzzer / encoder): Dupont wires from board pins to female plugs on the module header */
  function tableWires(grp: THREE.Group, mgrp: THREE.Group, plugAt: THREE.Vector3[], labels: string[], partId: string, ends: [string, number, string, string][], bz: number) {
    mgrp.updateMatrixWorld(true);
    const local = plugAt.map((v) => v.clone());
    const recs = labels.map((l, i) => ({ id: `${partId}:${l}`, label: l, anchor: local[i].clone(), parent: mgrp }));
    pinHits(mgrp, recs, local.map((v) => v.clone().setY(v.y + 4)), [2.4, 9, 2.8], modulePins);
    ends.forEach(([pin, color, end, role], i) => {
      const b = local[labels.indexOf(end)].clone().applyMatrix4(mgrp.matrixWorld);
      const a = boardHole(pin, b);
      const h = top + 12 + i * 1.5;
      addWire(grp, [a, lift(a, h), new THREE.Vector3((a.x + b.x) / 2, h + 2, (a.z + b.z) / 2 + Math.sign(bz) * 4), lift(b, h - 2), b], color, pin, `${partId}:${end}`);
      addRole(apiId(pin), role);
    });
  }

  /** Modules lying on the desk: three or more Dupont wires (female on the module header) to the board. ends = [board pin, colour, module pin, role] */
  function flatWires(grp: THREE.Group, partId: string, m: { grp: THREE.Group; plugAt: THREE.Vector3[]; labels: string[] }, ends: [string, number, string, string][], side: number) {
    m.grp.updateMatrixWorld(true);
    const recs = m.labels.map((l, i) => ({ id: `${partId}:${l}`, label: l, anchor: m.plugAt[i].clone(), parent: m.grp }));
    pinHits(m.grp, recs, m.plugAt.map((v) => v.clone().setY(v.y + 4)), [2.4, 9, 2.8], modulePins);
    ends.forEach(([pin, color, end, role], i) => {
      const b = m.plugAt[m.labels.indexOf(end)].clone().applyMatrix4(m.grp.matrixWorld);
      const a = boardHole(pin, b);
      const h = top + 12 + i * 1.5;
      addWire(grp, [a, lift(a, h), new THREE.Vector3((a.x + b.x) / 2, h + 2, (a.z + b.z) / 2 + side * 4), lift(b, h - 2), b], color, pin, `${partId}:${end}`);
      addRole(apiId(pin), role);
    });
  }

  function buildEncoder(grp: THREE.Group, p: Extract<PartSpec, { type: 'encoder' }>) {
    const root = new THREE.Group();
    registerPart('encoder', root);
    grp.add(root);
    const m = encoderModule();
    // On the desk in front of the phase-A pin (a bit away from the board's BOOT key)
    const sig = pinCands('IO' + p.a)[0].p;
    const bx = sig.x + 6, bz = Math.sign(sig.z || 1) * (BB.D / 2 + 22);
    m.grp.position.set(bx, 0, bz);
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    const ends: [string, number, string, string][] = [
      ['GND', WIRE.gnd, 'GND', t('Encoder GND')],
      ['3V3', WIRE.vcc, '+', t('Encoder power (pull-ups to 3V3)')],
      ...(p.sw !== undefined ? [['IO' + p.sw, 0x8a5cf6, 'SW', t('Encoder switch (press = GND)')] as [string, number, string, string]] : []),
      ['IO' + p.b, WIRE.sda, 'DT', t('Encoder phase B (DT)')],
      ['IO' + p.a, WIRE.scl, 'CLK', t('Encoder phase A (CLK)')],
    ];
    tableWires(grp, m.grp, m.plugAt, m.labels, 'encoder', ends, bz);
    // Callout outside the module and low, so it doesn't cover the knob
    label(grp, tl(p.label) ?? t('EC11 encoder · CLK IO{a} DT IO{b}{sw} · drag or scroll the knob', { a: p.a, b: p.b, sw: p.sw !== undefined ? ` SW IO${p.sw}` : '' }), new THREE.Vector3(bx + 46, 4, bz + Math.sign(bz) * 6));
    encoder = { knob: m.knob, hit: m.hit, pos: 0, pushed: false, y0: m.knobY };
  }

  function buildStrip(grp: THREE.Group, p: Extract<PartSpec, { type: 'ws2812' }>) {
    const root = new THREE.Group();
    registerPart('ws2812', root);
    grp.add(root);
    const n = p.n ?? 8;
    const m = stickModule(n);
    // On the desk in front of the DIN pin, one row further out than the encoder (no overlap when on the same side)
    const sig = pinCands('IO' + p.pin)[0].p;
    const side = Math.sign(sig.z || 1);
    const bx = sig.x + 6, bz = side * (BB.D / 2 + 56);
    m.grp.position.set(bx, 0, bz);
    if (side < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    flatWires(grp, 'ws2812', m, [
      ['5V', WIRE.vcc, '5V', t('Strip power (5 V)')],
      ['IO' + p.pin, WIRE.sig, 'DIN', t('Strip data (shifted to 5 V via 74AHCT125)')],
      ['GND', WIRE.gnd, 'GND', t('Strip GND')],
    ], side);
    label(grp, tl(p.label) ?? t('WS2812 × {n} · DIN IO{pin} (RMT)', { n, pin: p.pin }), new THREE.Vector3(bx, 4, bz + side * 12));
    const st = { pin: p.pin, lenses: m.lenses, light: m.light };
    strips.push(st);
    const had = stripLast.get(p.pin);
    if (had) paintStrip(st, had);
  }

  function buildDht(grp: THREE.Group, p: Extract<PartSpec, { type: 'dht11' }>) {
    const root = new THREE.Group();
    registerPart('dht11', root);
    grp.add(root);
    const m = dht11Module();
    const sig = pinCands('IO' + p.pin)[0].p;
    const bx = sig.x - 6, bz = Math.sign(sig.z || 1) * (BB.D / 2 + 17);
    m.grp.position.set(bx, 0, bz);
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    const ends: [string, number, string, string][] = [
      ['3V3', WIRE.vcc, 'VCC', t('DHT11 power (3.3 V)')],
      ['IO' + p.pin, WIRE.sig, 'DATA', t('DHT11 data (open drain, single wire)')],
      ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'DHT11' })],
    ];
    tableWires(grp, m.grp, m.plugAt, m.labels, 'dht11', ends, bz);
    label(grp, tl(p.label) ?? t('DHT11 · DATA IO{pin} · temperature / humidity from the sliders', { pin: p.pin }), new THREE.Vector3(bx, 6, bz + Math.sign(bz) * 22));
  }

  function buildSonar(grp: THREE.Group, p: Extract<PartSpec, { type: 'hcsr04' }>) {
    const root = new THREE.Group();
    registerPart('hcsr04', root);
    grp.add(root);
    const m = sonarModule();
    // Stands on the desk front-right of the breadboard, transducers toward +x: obstacle to its right, all visible from the default camera
    const sx = 40, sz = BB.D / 2 + 34;
    m.grp.position.set(sx, 0, sz);
    m.grp.rotation.y = Math.PI / 2;
    root.add(m.grp);
    const shadow = contactShadow(18, 48, 0.3);
    shadow.position.set(sx - 3, shadow.position.y, sz);
    grp.add(shadow);
    m.grp.updateMatrixWorld(true);
    const local = m.plugAt.map((v) => v.clone());
    const recs = m.labels.map((l, i) => ({ id: `hcsr04:${l}`, label: l, anchor: local[i].clone(), parent: m.grp }));
    pinHits(m.grp, recs, local.map((v) => v.clone()), [2.4, 3, 6], modulePins);
    const div = p.divider !== false;
    const ends: [string, number, string, string][] = [
      ['5V', WIRE.vcc, 'VCC', t('HC-SR04 power (5 V)')],
      ['IO' + p.trig, WIRE.sig, 'Trig', t('HC-SR04 Trig (≥10 µs high pulse)')],
      ['IO' + p.echo, 0x2f8fd8, 'Echo', div ? t('HC-SR04 Echo (via 1k/2k divider)') : t('HC-SR04 Echo (5 V direct, can damage GPIO)')],
      ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'HC-SR04' })],
    ];
    ends.forEach(([pin, color, end, role], i) => {
      const b = local[m.labels.indexOf(end)].clone().applyMatrix4(m.grp.matrixWorld);
      const a = boardHole(pin, b);
      const h = top + 14 + i * 1.8;
      addWire(grp, [a, lift(a, h), new THREE.Vector3((a.x + b.x) / 2, h + 3, (a.z + b.z) / 2 + 6), lift(b, h - 4), b], color, pin, `hcsr04:${end}`);
      addRole(apiId(pin), role);
    });
    // Echo divider: two small resistors drawn beside where the Echo wire lands (illustrative)
    if (div) {
      const e = local[m.labels.indexOf('Echo')].clone().applyMatrix4(m.grp.matrixWorld);
      for (const k of [0, 1]) {
        const r = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 3.4, 12).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: k ? 0xd8b26a : 0x6fa8dc, roughness: 0.5 }));
        r.position.set(e.x - 12 - k * 5, 1, e.z + 4);
        r.raycast = () => {};
        root.add(r);
      }
    }
    const sonarVars = { trig: p.trig, echo: p.echo };
    const sonarText = div
      ? t('HC-SR04 · Trig IO{trig} · Echo IO{echo} (1k/2k divider) · drag the obstacle', sonarVars)
      : t('HC-SR04 · Trig IO{trig} · Echo IO{echo} (5 V direct, can damage GPIO) · drag the obstacle', sonarVars);
    label(grp, tl(p.label) ?? sonarText, new THREE.Vector3(sx, 4, sz + 34));
    const ob = obstacleModel();
    registerPart('obstacle', ob.grp);
    grp.add(ob.grp);
    const origin = new THREE.Vector3(sx + m.face, m.y, sz);
    sonar = { origin, dir: new THREE.Vector3(1, 0, 0), face: m.face, obstacle: ob.grp, panel: ob.panel, waves: m.waves, waveMat: m.waveMat, pingT: -1e9, cm: p.cm ?? 25 };
    placeObstacle(p.cm ?? 25);
  }

  /** Put the obstacle cm in front of the transducers (3D placement caps at 100 cm, farther only in the reading); negative = remove */
  function placeObstacle(cm: number) {
    if (!sonar) return;
    sonar.cm = cm;
    const vis = cm >= 0;
    sonar.obstacle.visible = vis;
    const mm = Math.min(Math.max(cm, 2), 100) * 10;
    sonar.obstacle.position.set(sonar.origin.x + mm + 2, 0, sonar.origin.z);
    sonar.obstacle.updateMatrixWorld(true);
  }
  /** Raycast from the transmitter along the sensor's facing to the obstacle (cm, -1 on miss) */
  function rayDistance(): number {
    if (!sonar || !sonar.obstacle.visible) return -1;
    const rc = new THREE.Raycaster(sonar.origin, sonar.dir, 0, 4000);
    const hit = rc.intersectObject(sonar.panel)[0];
    return hit ? Math.round(hit.distance) / 10 : -1;
  }

  function buildAmp(grp: THREE.Group, p: Extract<PartSpec, { type: 'max98357a' }>) {
    // Amp module lies on the desk outside the breadboard near the three I2S pins; the speaker sits further out, red/black wires to the terminal
    const w = I2S_WIRING[board.spec.chip].spk;
    const root = new THREE.Group();
    registerPart('max98357a', root);
    grp.add(root);
    const m = ampModule();
    const sig = pinCands('IO' + w.din)[0].p;
    const side = Math.sign(sig.z || 1);
    const bx = sig.x - 6, bz = side * (BB.D / 2 + 16);
    m.grp.position.set(bx, 0, bz);
    // Header faces the board (the module header is at -z)
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    flatWires(grp, 'max98357a', m, [
      ['5V', WIRE.vcc, 'Vin', t('Amp power (5 V)')],
      ['GND', WIRE.gnd, 'GND', t('Amp GND')],
      ['IO' + w.bclk, WIRE.scl, 'BCLK', t('I2S BCLK (bit clock)')],
      ['IO' + w.lrc, WIRE.sda, 'LRC', t('I2S WS (word select)')],
      ['IO' + w.din, WIRE.sig, 'DIN', t('I2S data (to speaker)')],
    ], side);
    // Speaker: further out, solder tabs facing the amp
    const sp = speakerModel();
    const sx = bx, sz = bz + side * 38;
    sp.grp.position.set(sx, 0, sz);
    if (side < 0) sp.grp.rotation.y = Math.PI;
    root.add(sp.grp);
    const sh2 = contactShadow(40, 40, 0.35);
    sh2.position.set(sx, sh2.position.y, sz);
    grp.add(sh2);
    root.updateMatrixWorld(true);
    [WIRE.vcc, WIRE.gnd].forEach((c, i) => {
      const a = m.screwAt[i].clone().applyMatrix4(m.grp.matrixWorld);
      const b = sp.tabAt[i].clone().applyMatrix4(sp.grp.matrixWorld);
      const mid = new THREE.Vector3((a.x + b.x) / 2, 7, (a.z + b.z) / 2);
      const w2 = wire([a, a.clone().add(new THREE.Vector3(0, 1, side * 3)), mid, b.clone().add(new THREE.Vector3(0, 1.5, -side * 3)), b], c, `wire:max98357a:${i ? '-' : '+'}~speaker`, [`max98357a:${i ? '-' : '+'}`, 'speaker']);
      root.add(w2.grp);
    });
    label(grp, tl(p.label) ?? t('MAX98357A amp and 4 Ω speaker · BCLK IO{bclk} LRC IO{lrc} DIN IO{din}', { bclk: w.bclk, lrc: w.lrc, din: w.din }), new THREE.Vector3(sx + 62, 8, sz));
    speakers.push({ cone: sp.cone, waves: sp.waves, waveMat: sp.waveMat });
  }

  function buildMic(grp: THREE.Group, p: Extract<PartSpec, { type: 'inmp441' }>) {
    const w = I2S_WIRING[board.spec.chip].mic;
    const root = new THREE.Group();
    registerPart('inmp441', root);
    grp.add(root);
    const m = micModule();
    const sig = pinCands('IO' + w.sd)[0].p;
    const side = Math.sign(sig.z || 1);
    // Offset when on the same side as the speaker so they don't overlap
    const shareSide = lastScene.parts.some((q) => q.type === 'max98357a') && Math.sign(pinCands('IO' + I2S_WIRING[board.spec.chip].spk.din)[0].p.z || 1) === side;
    const bx = sig.x + (shareSide ? 30 : -4), bz = side * (BB.D / 2 + 14);
    m.grp.position.set(bx, 0, bz);
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    flatWires(grp, 'inmp441', m, [
      ['3V3', WIRE.vcc, 'VDD', t('Mic power')],
      ['GND', WIRE.gnd, 'GND', t('Mic GND')],
      ['GND', WIRE.gnd, 'L/R', t('L/R to GND = left channel')],
      ['IO' + w.sck, WIRE.scl, 'SCK', t('I2S SCK (bit clock)')],
      ['IO' + w.ws, WIRE.sda, 'WS', t('I2S WS (word select)')],
      ['IO' + w.sd, WIRE.sig, 'SD', t('I2S data (from mic)')],
    ], side);
    label(grp, tl(p.label) ?? t('INMP441 mic · SCK IO{sck} WS IO{ws} SD IO{sd} · L/R to GND', { sck: w.sck, ws: w.ws, sd: w.sd }), new THREE.Vector3(bx, 22, bz + side * 16));
    mics.push({ ring: m.ring, ringMat: m.ringMat });
  }

  let lastScene: SceneSpec = { parts: [] };

  // ---------------------------------------------------------------- bench pose (P2-03)
  let pose: Pose = { pitch: 0, roll: 0, yaw: 0 };
  /** Rotation centre: the IMU module (so it stays put while dragged); breadboard centre without an IMU */
  const pivot = new THREE.Vector3(0, BB_TOP, 0);
  /** Level the bench before building (part positions are computed in world coordinates) */
  function levelRig() {
    rig.position.set(0, 0, 0);
    rig.quaternion.identity();
    rig.updateMatrixWorld(true);
  }
  const m4 = new THREE.Matrix4();
  /** Rotate the bench by pose about pivot (the IMU module), like tilting the breadboard in your hands */
  function applyPose() {
    levelRig();
    const imu = partsById.get('mpu6050') ?? partsById.get('qmi8658');
    if (imu) imu.getWorldPosition(pivot);
    else pivot.set(0, BB_TOP, 0);
    const flat = !pose.pitch && !pose.roll && !pose.yaw;
    if (!flat) {
      const r = poseToThree(pose);
      m4.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
      rig.quaternion.setFromRotationMatrix(m4);
      // No lift: the ground is only a transparent shadow catcher, so a corner sinking below it stays visible; the IMU stays in view while dragged
      rig.position.copy(pivot).sub(pivot.clone().applyQuaternion(rig.quaternion));
      rig.updateMatrixWorld(true);
    }
    highlight(hl);
    setHeat(heatId);
    if (measured) measure(measured[0], measured[1]);
  }

  /** Switch board (ESP32 / C3 / S3): rebuild the board and rewire add-on parts to the new board's pins */
  function setBoard(chip: ChipId) {
    if (board.spec.chip === chip) return;
    levelRig();
    rig.remove(board.grp);
    disposeTree(board.grp);
    board = devboard(BOARDS[chip]);
    placeBoard();
    setScene(lastScene);
  }

  // Without a set camera, frame the board + parts bounding box: at real size S3 plus a servo is twice as wide as C3, a fixed camera would crop.
  // Wires arch high, so cap the box at 40 mm to avoid shrinking parts just to fit wire tops
  function fitView(v: Required<SceneSpec>['view']) {
    const box = new THREE.Box3().setFromObject(board.grp);
    for (const c of parts.children) if (!wires.some((w) => w.grp === c)) box.expandByObject(c);
    box.max.y = Math.min(box.max.y, 40);
    const center = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(camera.aspect, 0.5));
    const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 0.82;
    const dir = new THREE.Vector3(...v.position).sub(new THREE.Vector3(...v.target)).normalize();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
  }

  function setScene(spec: SceneSpec) {
    lastScene = spec;
    levelRig();
    rig.remove(parts);
    disposeTree(parts);
    parts = new THREE.Group();
    rig.add(parts);
    touchScreen = null;
    leds = [];
    servos = [];
    pots = [];
    buzzers = [];
    keys = [];
    encoder = null;
    strips = [];
    sonar = null;
    speakers = [];
    mics = [];
    oledTex = null;
    lcdTex = null;
    holeUse = new Map();
    partsById.clear();
    partsById.set('board', board.grp);
    modulePins = [];
    wires = [];
    rewired = new Map();
    roles = new Map();
    if (board.spec.rgbPin >= 0) addRole(apiId('IO' + board.spec.rgbPin), t('Onboard WS2812 LED'));
    addRole(apiId('IO' + board.spec.bootPin), t('BOOT button'));
    // Several parts of one kind line up leftward so they don't stack in one column
    let ledN = 0;
    let keyN = 0;
    let i2cCol = 21;
    for (const p of spec.parts) {
      if (p.type === 'led') buildLed(parts, { ...p, col: p.col ?? 24 - 4 * ledN++ });
      if (p.type === 'servo') buildServo(parts, p);
      if (p.type === 'pot') buildPot(parts, p);
      if (p.type === 'buzzer') buildBuzzer(parts, p);
      // Keys go right of the board (it reaches about column 22), one per 5 columns so 9 mm caps don't crowd
      if (p.type === 'key') buildKey(parts, p, 26 + 5 * keyN++);
      if (p.type === 'encoder') buildEncoder(parts, p);
      if (p.type === 'ws2812') buildStrip(parts, p);
      if (p.type === 'hcsr04') buildSonar(parts, p);
      if (p.type === 'dht11') buildDht(parts, p);
      if (p.type === 'max98357a') buildAmp(parts, p);
      if (p.type === 'inmp441') buildMic(parts, p);
      if (p.type === 'oled') {
        oledData.fill(0);
        for (let i = 3; i < oledData.length; i += 4) oledData[i] = 255;
        oledTex = new THREE.DataTexture(oledData, 128, 64, THREE.RGBAFormat);
        oledTex.magFilter = THREE.NearestFilter;
        oledTex.minFilter = THREE.LinearFilter;
        oledTex.colorSpace = THREE.SRGBColorSpace;
        oledTex.needsUpdate = true;
        buildI2c(parts, 'oled', 'OLED', oledModule(oledTex), i2cCol, p.sda, p.scl, 40);
        label(parts, tl(p.label) ?? `SSD1306 · I2C 0x${p.addr.toString(16).toUpperCase()} · SDA IO${p.sda} SCL IO${p.scl}`, new THREE.Vector3(colX(i2cCol + 1.5), 46, rowZ(0) - 10));
        i2cCol -= 9;
      }
      if (p.type === 'gc9a01') {
        lcdData.fill(0);
        for (let i = 3; i < lcdData.length; i += 4) lcdData[i] = 255;
        lcdTex = new THREE.DataTexture(lcdData, 240, 240, THREE.RGBAFormat);
        lcdTex.flipY = true;
        lcdTex.colorSpace = THREE.SRGBColorSpace;
        lcdTex.needsUpdate = true;
        const tp = spec.parts.find((x): x is Extract<PartSpec, { type: 'cst816s' }> => x.type === 'cst816s');
        const lm = roundLcdModule(lcdTex, !!tp);
        if (tp) touchScreen = lm.screen;
        buildSpiLcd(parts, lm, 16, tp);
        const w = LCD_WIRING[board.spec.chip];
        label(parts, tl(p.label) ?? t('GC9A01 round LCD · SPI2 · SCLK IO{sclk} MOSI IO{mosi} CS IO{cs} DC IO{dc}', { sclk: w.sclk, mosi: w.mosi, cs: w.cs, dc: w.dc }), new THREE.Vector3(colX(19.5), 52, rowZ(0) - 10));
      }
      if (p.type === 'mpu6050' || p.type === 'qmi8658') {
        // Sharing the bench with the round LCD (motion figure): the LCD takes column 16 onward, so the IMU moves right of it or it's hidden and undraggable
        const col = spec.parts.some((x) => x.type === 'gc9a01') ? 27 : i2cCol - 4;
        buildImu(parts, p, col);
        const imuText = t('{part} · I2C 0x{addr} · SDA IO{sda} SCL IO{scl} · drag to tilt the bench', { part: p.type === 'mpu6050' ? 'MPU6050' : 'QMI8658', addr: p.addr.toString(16), sda: p.sda, scl: p.scl });
        label(parts, tl(p.label) ?? imuText, new THREE.Vector3(colX(col + 3.5), 30, rowZ(0) - 10));
        i2cCol -= 10;
      }
      if (p.type === 'bme280') {
        buildI2c(parts, 'bme280', 'BME280', bmeModule(), i2cCol, p.sda, p.scl, 22);
        label(parts, tl(p.label) ?? `BME280 · I2C 0x${p.addr.toString(16)} · SDA IO${p.sda} SCL IO${p.scl}`, new THREE.Vector3(colX(i2cCol + 1.5), 34, rowZ(0) - 8));
        i2cCol -= 9;
      }
    }
    parts.updateMatrixWorld(true);
    // An example may set the camera (e.g. close up on a screen), otherwise use the default. Cameras are written for the C3 board
    // and shift with the parts on longer boards
    const v = spec.view ?? DEFAULT_VIEW;
    if (spec.view) {
      const dx = colX(0) + ((BOARD_C3.cols - 1) / 2) * PITCH;
      camera.position.set(v.position[0] + dx, v.position[1], v.position[2]);
      controls.target.set(v.target[0] + dx, v.target[1], v.target[2]);
    } else {
      fitView(v);
    }
    controls.update();
    // After rebuild, restore fault tags set by the shell (kept while their target still exists)
    for (const [id, msg] of faults) if (wires.some((w) => w.id === id)) applyFault(id, msg);
    else setTag('fault:' + id, null, '', () => null);
    applyPose();
    sw.warm();
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // Bloom picks emitters by a brightness threshold, no separate glow pass. Without tone mapping, white background and lit white parts
  // reach linear 1.0–1.4, so the threshold must be above that; RGB (×7) and LED lens (×6) HDR brightness is far over 1.8
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.35, 1.8);
  composer.addPass(bloom);
  const outline = new OutlinePass(new THREE.Vector2(256, 256), scene, camera);
  outline.visibleEdgeColor.set(ACCENT);
  outline.hiddenEdgeColor.set(0x0a5fa8);
  outline.edgeStrength = 5;
  outline.edgeThickness = 1.2;
  outline.edgeGlow = 0;
  outline.enabled = false;
  composer.addPass(outline);
  composer.addPass(new OutputPass());
  const sw = shaderWarm(renderer, scene, camera, composer);
  sw.warm();

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // ---------------------------------------------------------------- picking

  const ray = new THREE.Raycaster();
  const toNdc = (ev: { clientX: number; clientY: number }) => {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  };
  const resolveHit = (h: THREE.Intersection): PickTarget | null => {
    const ids = h.object.userData.pinIds as string[] | undefined;
    if (ids && h.instanceId !== undefined) return { kind: 'pin', id: ids[h.instanceId] };
    for (let o: THREE.Object3D | null = h.object; o; o = o.parent) if (o.userData.pick) return o.userData.pick as PickTarget;
    return null;
  };
  const pickAt = (ev: { clientX: number; clientY: number }): PickTarget | null => {
    ray.setFromCamera(toNdc(ev), camera);
    // A Dupont plug stands right beside its pin and hides it from most angles: if the first hit is a wire and a pin
    // or button lies just behind it (within 15 mm), take the pin the user meant
    let first: { t: PickTarget; d: number } | null = null;
    for (const h of ray.intersectObjects([board.grp, parts], true)) {
      const t = resolveHit(h);
      if (!t) continue;
      if (!first) {
        if (t.kind !== 'wire') return t;
        first = { t, d: h.distance };
        continue;
      }
      if (h.distance - first.d > 15) break;
      if (t.kind === 'pin' || t.kind === 'button') return t;
    }
    return first?.t ?? null;
  };

  // Board buttons: press / release
  let buttonCb: ((n: 'BOOT' | 'RST', d: boolean) => void) | null = null;
  let pickCb: ((t: PickTarget | null, s: ScreenPoint) => void) | null = null;
  let pressed: THREE.Mesh | null = null;
  const pick = (ev: PointerEvent) => {
    ray.setFromCamera(toNdc(ev), camera);
    const hit = ray.intersectObject(board.grp, true)[0];
    const t = hit && resolveHit(hit);
    return t && t.kind === 'button' ? board.buttons.find((b) => b.name === t.id) : undefined;
  };
  // Breadboard tactile keys: holding the cap = pin to GND
  let keyCb: ((pin: number, down: boolean) => void) | null = null;
  let keyDown: { pin: number; key: THREE.Mesh } | null = null;
  const pickKey = (ev: PointerEvent) => {
    if (!keys.length) return undefined;
    ray.setFromCamera(toNdc(ev), camera);
    const hit = ray.intersectObjects(keys.map((k) => k.key))[0];
    return hit ? keys.find((k) => k.key === hit.object) : undefined;
  };
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    const k = pickKey(ev);
    if (!k) return;
    controls.enabled = false;
    keyDown = k;
    k.key.position.y = k.key.userData.baseY - 1.2;
    keyCb?.(k.pin, true);
  });
  window.addEventListener('pointerup', () => {
    if (!keyDown) return;
    keyDown.key.position.y = keyDown.key.userData.baseY;
    keyCb?.(keyDown.pin, false);
    keyDown = null;
    controls.enabled = true;
  });
  // Potentiometer: hold the knob and drag sideways to turn (270° travel)
  let dragging: { pot: (typeof pots)[number]; x0: number; v0: number } | null = null;
  const pickPot = (ev: PointerEvent) => {
    ray.setFromCamera(toNdc(ev), camera);
    const hit = ray.intersectObjects(pots.map((p) => p.hit))[0];
    return hit ? pots.find((p) => p.hit === hit.object) : undefined;
  };
  const turnPot = (pot: (typeof pots)[number], v: number) => {
    pot.v = Math.min(1, Math.max(0, v));
    pot.knob.rotation.y = -(pot.v - 0.5) * 1.5 * Math.PI;
  };
  let downAt: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    downAt = { x: ev.clientX, y: ev.clientY };
    const pot = pickPot(ev);
    if (pot) {
      controls.enabled = false;
      dragging = { pot, x0: ev.clientX, v0: pot.v };
      return;
    }
  });
  window.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    turnPot(dragging.pot, dragging.v0 + (ev.clientX - dragging.x0) / 240);
    potCb?.(dragging.pot.pin, dragging.pot.v);
  });
  window.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = null;
      controls.enabled = true;
    }
  });
  // Encoder knob: drag sideways (14 px per detent, EC11 has 20 per turn), one wheel notch per detent; hold still 150 ms = press, quick tap = click
  const ENC_PX = 14;
  let encDrag: { x0: number; sent: number; moved: boolean; timer: number; held: boolean } | null = null;
  const hitEncoder = (ev: { clientX: number; clientY: number }) => {
    if (!encoder) return false;
    ray.setFromCamera(toNdc(ev), camera);
    return ray.intersectObject(encoder.hit).length > 0;
  };
  const showKnob = () => {
    if (!encoder) return;
    encoder.knob.rotation.y = -(encoder.pos * Math.PI) / 10;
    encoder.knob.position.y = encoder.y0 - (encoder.pushed ? 1.2 : 0);
  };
  const turnEncoder = (steps: number) => {
    if (!encoder || !steps) return;
    encoder.pos += steps;
    showKnob();
    encCb?.(steps);
  };
  const pushEncoder = (down: boolean) => {
    if (!encoder) return;
    encoder.pushed = down;
    showKnob();
    encSwCb?.(down);
  };
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    if (!hitEncoder(ev)) return;
    controls.enabled = false;
    const d = { x0: ev.clientX, sent: 0, moved: false, held: false, timer: 0 };
    d.timer = window.setTimeout(() => {
      if (encDrag === d && !d.moved) {
        d.held = true;
        pushEncoder(true);
      }
    }, 150);
    encDrag = d;
  });
  window.addEventListener('pointermove', (ev) => {
    if (!encDrag) return;
    const dx = ev.clientX - encDrag.x0;
    if (Math.abs(dx) > 4) encDrag.moved = true;
    const want = Math.trunc(dx / ENC_PX);
    if (want !== encDrag.sent) {
      turnEncoder(want - encDrag.sent);
      encDrag.sent = want;
    }
  });
  window.addEventListener('pointerup', () => {
    const d = encDrag;
    if (!d) return;
    encDrag = null;
    clearTimeout(d.timer);
    controls.enabled = true;
    if (d.held) pushEncoder(false);
    else if (!d.moved) {
      pushEncoder(true);
      setTimeout(() => pushEncoder(false), 120);
    }
  });
  // Wheel over the knob turns the encoder instead of zooming (capture phase runs before OrbitControls)
  renderer.domElement.addEventListener(
    'wheel',
    (ev) => {
      if (!hitEncoder(ev)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      turnEncoder(ev.deltaY < 0 ? 1 : -1);
    },
    { capture: true, passive: false },
  );
  // Obstacle: hold and drag along the sensor's facing (projected onto the sensor's horizontal line)
  let obDrag: { last: number } | null = null;
  const hitObstacle = (ev: { clientX: number; clientY: number }) => {
    if (!sonar || !sonar.obstacle.visible) return false;
    ray.setFromCamera(toNdc(ev), camera);
    return ray.intersectObject(sonar.obstacle, true).length > 0;
  };
  const groundAt = (ev: { clientX: number; clientY: number }, y: number) => {
    ray.setFromCamera(toNdc(ev), camera);
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
  };
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    if (encDrag || !hitObstacle(ev)) return;
    controls.enabled = false;
    obDrag = { last: performance.now() };
  });
  window.addEventListener('pointermove', (ev) => {
    if (!obDrag || !sonar) return;
    const p = groundAt(ev, sonar.origin.y);
    if (!p) return;
    const cm = Math.round(Math.min(100, Math.max(2, (p.x - sonar.origin.x) / 10)) * 10) / 10;
    placeObstacle(cm);
    const now = performance.now();
    // Report at most every 60 ms while dragging (keeps the input log small), and the final value on release
    if (now - obDrag.last > 60) {
      obDrag.last = now;
      distCb?.(rayDistance());
    }
  });
  window.addEventListener('pointerup', () => {
    if (!obDrag) return;
    obDrag = null;
    controls.enabled = true;
    distCb?.(rayDistance());
  });
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    const b = pick(ev);
    if (!b) return;
    controls.enabled = false;
    pressed = b;
    b.position.y = b.userData.baseY - 0.4;
    buttonCb?.(b.name as 'BOOT' | 'RST', true);
  });
  window.addEventListener('pointerup', () => {
    if (!pressed) return;
    pressed.position.y = pressed.userData.baseY;
    buttonCb?.(pressed.name as 'BOOT' | 'RST', false);
    pressed = null;
    controls.enabled = true;
  });
  // Click (under 5 px between down and up, not an orbit drag) → onPick
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!pickCb || !downAt || consumed || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pickCb(pickAt(ev), { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
  });
  let hoverT = 0;
  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (ev.buttons) return;
    // Throttle hover: at most one raycast per 50 ms
    const now = performance.now();
    if (now - hoverT < 50) return;
    hoverT = now;
    const imu = imuRoot();
    const overImu = () => {
      if (!imu) return false;
      ray.setFromCamera(toNdc(ev), camera);
      return ray.intersectObject(imu, true).length > 0;
    };
    const c = pick(ev) ? 'pointer' : pickPot(ev) || dragging || hitEncoder(ev) ? 'ew-resize' : hitObstacle(ev) ? 'grab' : touchScreen && touchAt(ev) ? 'crosshair' : overImu() ? 'grab' : pickCb && pickAt(ev) ? 'pointer' : '';
    renderer.domElement.style.cursor = c;
  });

  // ---------------------------------------------------------------- touch round LCD (P2-02) and drag IMU to tilt the bench (P2-03)
  let touchCb: ((x: number, y: number, down: boolean) => void) | null = null;
  let poseCb: ((p: Pose, phase: 'move' | 'end') => void) | null = null;
  /** This press was used by a key / touch / IMU drag: don't treat the release as a pick */
  let consumed = false;
  let touching: { x: number; y: number; t: number } | null = null;
  const finger = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.4, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false }));
  finger.renderOrder = 22;
  finger.visible = false;
  finger.raycast = () => {};
  scene.add(finger);
  const touchAt = (ev: { clientX: number; clientY: number }) => {
    if (!touchScreen) return null;
    ray.setFromCamera(toNdc(ev), camera);
    const h = ray.intersectObject(touchScreen, false)[0];
    if (!h?.uv) return null;
    finger.position.copy(h.point);
    finger.quaternion.copy(touchScreen.getWorldQuaternion(new THREE.Quaternion()));
    // CircleGeometry UV: u = 0.5 + x/2r, v = 0.5 + y/2r; texture is flipY, row 0 at the top
    return { x: Math.min(239, Math.max(0, h.uv.x * 240)), y: Math.min(239, Math.max(0, (1 - h.uv.y) * 240)) };
  };
  let rotating: { x: number; y: number; moved: boolean; t: number } | null = null;
  const imuRoot = () => partsById.get('mpu6050') ?? partsById.get('qmi8658');
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    // BOOT / RST presses are actions, not picks: keep the selection (example card, env sliders stay); pressed was set by the earlier listener
    consumed = !!pressed;
    const tp = touchAt(ev);
    if (tp) {
      controls.enabled = false;
      consumed = true;
      touching = { ...tp, t: performance.now() };
      finger.visible = true;
      touchCb?.(tp.x, tp.y, true);
      return;
    }
    const imu = imuRoot();
    if (imu && !pickPot(ev) && !pick(ev)) {
      ray.setFromCamera(toNdc(ev), camera);
      if (ray.intersectObject(imu, true).length) {
        controls.enabled = false;
        rotating = { x: ev.clientX, y: ev.clientY, moved: false, t: 0 };
      }
    }
  });
  const qd = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  window.addEventListener('pointermove', (ev) => {
    if (touching) {
      const tp = touchAt(ev);
      const now = performance.now();
      // Report moves at ~30 Hz (real chips scan ~100 Hz; denser web events would only bloat the input log)
      if (tp && now - touching.t > 33 && (Math.abs(tp.x - touching.x) >= 1 || Math.abs(tp.y - touching.y) >= 1)) {
        touching = { ...tp, t: now };
        touchCb?.(tp.x, tp.y, true);
      }
      return;
    }
    if (!rotating) return;
    const dx = ev.clientX - rotating.x, dy = ev.clientY - rotating.y;
    if (!rotating.moved && Math.hypot(dx, dy) < 4) return;
    rotating.moved = true;
    consumed = true;
    rotating.x = ev.clientX;
    rotating.y = ev.clientY;
    // Trackball: horizontal drag = about the camera's vertical axis, vertical drag = about its horizontal axis (0.5°/px)
    const q = rig.quaternion.clone();
    axis.set(0, 1, 0).applyQuaternion(camera.quaternion);
    q.premultiply(qd.setFromAxisAngle(axis, dx * 0.5 * (Math.PI / 180)));
    axis.set(1, 0, 0).applyQuaternion(camera.quaternion);
    q.premultiply(qd.setFromAxisAngle(axis, dy * 0.5 * (Math.PI / 180)));
    const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
    pose = threeToPose([e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]);
    applyPose();
    const now = performance.now();
    if (now - rotating.t > 33) {
      rotating.t = now;
      poseCb?.({ ...pose }, 'move');
    }
  });
  window.addEventListener('pointerup', () => {
    if (touching) {
      touchCb?.(touching.x, touching.y, false);
      touching = null;
      finger.visible = false;
      controls.enabled = true;
    }
    if (rotating) {
      if (rotating.moved) poseCb?.({ ...pose }, 'end');
      rotating = null;
      controls.enabled = true;
    }
  });

  // ---------------------------------------------------------------- highlight / faults / heat glow / ruler

  const allPins = () => [...board.pinRecs, ...modulePins];
  const pinsById = (id: string) => allPins().filter((p) => p.id === id);
  const pinWorldPos = (p: PinRec) => p.anchor.clone().applyMatrix4(p.parent.matrixWorld);

  const targetPos = (t: PickTarget): THREE.Vector3 | null => {
    if (t.kind === 'pin') {
      const p = pinsById(t.id)[0];
      return p ? pinWorldPos(p) : null;
    }
    if (t.kind === 'wire') {
      const w = wires.find((w) => w.id === t.id);
      return w ? w.curve.getPoint(0.5) : null;
    }
    if (t.kind === 'button') {
      const b = board.buttons.find((b) => b.name === t.id);
      return b ? b.getWorldPosition(new THREE.Vector3()) : null;
    }
    const o = partsById.get(t.id);
    if (!o) return null;
    // The board measures to the chip (shield can centre)
    if (t.id === 'board') return new THREE.Vector3(0, board.T / 2 + 3, board.L / 2 - board.spec.module.L / 2).applyMatrix4(board.grp.matrixWorld);
    // Other parts use the box of the visible body, excluding pick boxes, gold pins and contact shadows, so the centre isn't on the header pins
    const box = new THREE.Box3();
    o.updateMatrixWorld(true);
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh || m.material === MAT.hit || m.material === MAT.gold || m.renderOrder < 0) return;
      box.union(new THREE.Box3().setFromObject(m));
    });
    return (box.isEmpty() ? new THREE.Box3().setFromObject(o) : box).getCenter(new THREE.Vector3());
  };

  const project = (t: PickTarget): ScreenPoint | null => {
    const p = targetPos(t);
    if (!p) return null;
    const v = p.project(camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    return { x: ((v.x + 1) / 2) * container.clientWidth, y: ((1 - v.y) / 2) * container.clientHeight };
  };

  const hlGroup = new THREE.Group();
  scene.add(hlGroup);
  const ringGeo = new THREE.TorusGeometry(1.7, 0.22, 8, 40).rotateX(Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, transparent: true });
  let hl: PickTarget | null = null;
  const thicken = (w: WireRec, on: boolean) => {
    if (on) w.thick ??= new THREE.TubeGeometry(w.curve, 96, WIRE_R * 1.7, 10);
    w.tube.geometry = on ? w.thick! : w.thin;
  };
  function highlight(tgt: PickTarget | null) {
    for (const w of wires) thicken(w, false);
    hlGroup.clear();
    outline.selectedObjects = [];
    outline.enabled = false;
    setTag('hl', null, '', () => null);
    hl = tgt;
    if (!tgt) return;
    if (tgt.kind === 'part' || tgt.kind === 'button') {
      const o = tgt.kind === 'part' ? partsById.get(tgt.id) : board.buttons.find((b) => b.name === tgt.id);
      if (!o) return;
      outline.selectedObjects = [o];
      outline.enabled = true;
      return;
    }
    if (tgt.kind === 'pin') {
      const recs = pinsById(tgt.id);
      for (const r of recs) {
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pinWorldPos(r));
        ring.renderOrder = 20;
        hlGroup.add(ring);
      }
      for (const w of wires) if (w.ends.includes(tgt.id)) thicken(w, true);
      if (recs.length) {
        const role = roles.get(tgt.id)?.join(' · ');
        const pinName = recs[0].label !== tgt.id ? t('{id} (silkscreen {label})', { id: tgt.id, label: recs[0].label }) : tgt.id;
        setTag('hl', `${pinName}${role ? ' · ' + role : ''}`, 'pin', () => pinWorldPos(recs[0]), -18);
      }
      return;
    }
    const w = wires.find((w) => w.id === tgt.id);
    if (!w) return;
    thicken(w, true);
    setTag('hl', `${w.ends[0]} → ${w.ends[1]}`, 'pin', () => w.curve.getPoint(0.5), -16);
  }

  const faults = new Map<string, string>();
  const applyFault = (id: string, msg: string) => {
    const w = wires.find((w) => w.id === id);
    if (!w) return;
    w.mat.color.set(BAD);
    w.mat.emissive.set(BAD);
    w.mat.emissiveIntensity = 0.25;
    setTag('fault:' + id, '✗ ' + msg, 'bad', () => w.curve.getPoint(0.5), -20);
  };
  /** Rewire (U-04 wire tool): move a wire's board end to another pin. The original is kept to swap back; cleared on setScene rebuild */
  function rewire(id: string, to: string | null) {
    const cur = wires.find((w) => w.id === id);
    if (!cur) return;
    const orig = rewired.get(id) ?? cur;
    // Every wiring recheck syncs this: skip rebuilding the tube if the target is unchanged
    const want = to && to !== orig.ends[0] ? to : null;
    if (want ? cur !== orig && cur.ends[0] === want : cur === orig) return;
    let next = orig;
    if (to && to !== orig.ends[0]) {
      const pts = orig.curve.points;
      const b = pts[pts.length - 1];
      let a: THREE.Vector3;
      try {
        a = boardHole(to.replace(/^GPIO/, 'IO'), b);
      } catch {
        return;
      }
      const h = top + 30;
      next = wire([a, lift(a, h - 4), new THREE.Vector3((a.x + b.x) / 2, h, (a.z + b.z) / 2 + 6), lift(b, h - 6), b], orig.color, id, [to, orig.ends[1]]);
    }
    if (next === cur) return;
    const parent = cur.grp.parent;
    parent?.remove(cur.grp);
    parent?.add(next.grp);
    if (cur !== orig) {
      cur.thin.dispose();
      cur.thick?.dispose();
      cur.mat.dispose();
    }
    if (next === orig) rewired.delete(id);
    else rewired.set(id, orig);
    wires[wires.indexOf(cur)] = next;
    const f = faults.get(id);
    if (f) applyFault(id, f);
    else {
      next.mat.color.set(next.color);
      next.mat.emissive.set(0);
    }
    if (hl) highlight(hl);
  }
  /** Board-to-board jumper (for P2-14 shorts): b null unplugs; cleared with parts on setScene, re-added on wiring recheck */
  function bridge(id: string, a: string, b: string | null) {
    const cur = wires.find((w) => w.id === id);
    if (!b) {
      if (!cur) return;
      cur.grp.parent?.remove(cur.grp);
      cur.thin.dispose();
      cur.thick?.dispose();
      cur.mat.dispose();
      wires.splice(wires.indexOf(cur), 1);
      return;
    }
    if (cur) return;
    let p: THREE.Vector3, q: THREE.Vector3;
    try {
      p = boardHole(a.replace(/^GPIO/, 'IO'));
      q = boardHole(b.replace(/^GPIO/, 'IO'), p);
    } catch {
      return;
    }
    const h = top + 34;
    const w = wire([p, lift(p, h - 4), new THREE.Vector3((p.x + q.x) / 2, h, (p.z + q.z) / 2 + 8), lift(q, h - 4), q], 0xd23b2e, id, [a, b]);
    parts.add(w.grp);
    wires.push(w);
    const f = faults.get(id);
    if (f) applyFault(id, f);
  }
  function setWireFault(id: string, msg: string | null) {
    if (msg) {
      faults.set(id, msg);
      applyFault(id, msg);
      return;
    }
    faults.delete(id);
    const w = wires.find((w) => w.id === id);
    if (w) {
      w.mat.color.set(w.color);
      w.mat.emissive.set(0);
      w.mat.emissiveIntensity = 0;
    }
    setTag('fault:' + id, null, '', () => null);
  }

  const heatTex = canvasTexture(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(242,72,34,0.7)');
    r.addColorStop(0.45, 'rgba(242,72,34,0.38)');
    r.addColorStop(1, 'rgba(242,72,34,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
  });
  // Heat glow centred on the part's bounding box, half buried in the breadboard; no depth test so it overlays the part like a thermal image
  const heat = new THREE.Sprite(new THREE.SpriteMaterial({ map: heatTex, depthWrite: false, depthTest: false, transparent: true }));
  heat.raycast = () => {};
  heat.visible = false;
  heat.renderOrder = 5;
  scene.add(heat);
  let heatId: string | null = null;
  let heatBase = 1;
  function setHeat(partId: string | null) {
    heatId = partId;
    const o = partId ? partsById.get(partId) : undefined;
    heat.visible = !!o;
    if (!o) return;
    const box = new THREE.Box3().setFromObject(o);
    const size = box.getSize(new THREE.Vector3());
    heatBase = Math.max(size.x, size.y, size.z) * 2.2 + 10;
    heat.position.copy(box.getCenter(new THREE.Vector3()));
  }

  const rulerGroup = new THREE.Group();
  scene.add(rulerGroup);
  const rulerMat = new THREE.LineBasicMaterial({ color: BAD, depthTest: false, transparent: true });
  const dotMat = new THREE.MeshBasicMaterial({ color: BAD, depthTest: false, transparent: true });
  const dotGeo = new THREE.SphereGeometry(0.8, 16, 8);
  let measured: [PickTarget, PickTarget] | null = null;
  function measure(a: PickTarget | null, b?: PickTarget): number | null {
    rulerGroup.children.forEach((c) => (c as THREE.Line).geometry !== dotGeo && (c as THREE.Line).geometry.dispose());
    rulerGroup.clear();
    setTag('ruler', null, '', () => null);
    measured = null;
    if (!a || !b) return null;
    const pa = targetPos(a), pb = targetPos(b);
    if (!pa || !pb) return null;
    measured = [a, b];
    const d = pa.distanceTo(pb);
    // Ruler: main line + a tick every 10 mm
    const pts: THREE.Vector3[] = [pa, pb];
    const dir = pb.clone().sub(pa).normalize();
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize().multiplyScalar(1.2);
    for (let s = 0; s <= d; s += 10) {
      const p = pa.clone().addScaledVector(dir, s);
      pts.push(p.clone().sub(side), p.clone().add(side));
    }
    const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), rulerMat);
    line.renderOrder = 21;
    rulerGroup.add(line);
    // WebGL line width is always 1 px, nearly invisible from afar; draw the main line as a thin cylinder
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, d, 8), dotMat);
    bar.position.copy(pa).lerp(pb, 0.5);
    bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    bar.renderOrder = 21;
    rulerGroup.add(bar);
    for (const p of [pa, pb]) {
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.copy(p);
      dot.renderOrder = 21;
      rulerGroup.add(dot);
    }
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    const mm = Math.round(d * 10) / 10;
    setTag('ruler', `${mm.toFixed(1)} mm`, 'ruler', () => mid, -12);
    return mm;
  }

  applyTheme('light');
  partsById.set('board', board.grp);
  if (board.spec.rgbPin >= 0) addRole(apiId('IO' + board.spec.rgbPin), t('Onboard WS2812 LED'));
  addRole(apiId('IO' + board.spec.bootPin), t('BOOT button'));

  // ---------------------------------------------------------------- render loop

  let usbHost: ReturnType<typeof createUsbHost> | null = null;
  let raf = 0;
  let rgbPeak = 0;
  let frameMs = 16.7, cpuMs = 0, lastT = performance.now();
  const lastInfo = { calls: 0, triangles: 0 };
  const tmp = new THREE.Vector3();
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const t0 = performance.now();
    frameMs = frameMs * 0.9 + (t0 - lastT) * 0.1;
    lastT = t0;
    // Short on/off transition, like a real LED as seen by the eye
    let glow = rgbPeak > 0;
    for (const l of leds) {
      l.now += (l.target - l.now) * 0.55;
      l.lens.emissiveIntensity = l.now * 6;
      l.light.intensity = l.now * 60;
      if (l.now > 0.02) glow = true;
    }
    // Servo speed is limited (SG90 ≈ 0.1 s / 60°): the horn chases the target angle
    for (const sv of servos) {
      // Use the dynamics angle (setServoAngle) when present; otherwise chase the PWM target at the speed limit
      const step = sv.phys ? 360 : 600 / 60;
      sv.angle += Math.max(-step, Math.min(step, sv.target - sv.angle));
      sv.horn.rotation.y = ((sv.angle - 90) * Math.PI) / 180;
    }
    // Buzzer sounding: diaphragm bobs + waves expand (illustrative; real vibration is kHz and invisible)
    for (const bz of buzzers) {
      bz.waves.visible = bz.on;
      if (!bz.on) {
        bz.membrane.position.y = bz.membrane.userData.y0 ??= bz.membrane.position.y;
        continue;
      }
      const ph = (t0 / 600) % 1;
      bz.waves.scale.setScalar(0.85 + ph * 0.4);
      bz.waveMat.opacity = 0.85 * (1 - ph);
      bz.membrane.userData.y0 ??= bz.membrane.position.y;
      bz.membrane.position.y = bz.membrane.userData.y0 + 0.12 * Math.sin(t0 / 25);
    }
    // Ultrasonic: three arcs expand from the transmitter on each measurement, fading over 0.4 s (illustrative)
    if (sonar) {
      const ph = (t0 - sonar.pingT) / 400;
      sonar.waves.visible = ph >= 0 && ph < 1;
      if (sonar.waves.visible) {
        sonar.waves.scale.setScalar(0.6 + ph * 1.2);
        sonar.waveMat.opacity = 0.8 * (1 - ph);
      }
    }
    // Speaker: cone moves with volume (illustrative, real excursion is invisible at audio rates), waves while sounding; mic input lights a ring over the hole
    for (const sp of speakers) {
      const on = spkLevel > 0.005;
      sp.waves.visible = on;
      sp.cone.position.y = on ? Math.min(1.2, spkLevel * 2.5) * Math.sin(t0 / 22) : 0;
      if (on) {
        const ph = (t0 / 700) % 1;
        sp.waves.scale.setScalar(0.85 + ph * 0.45);
        sp.waveMat.opacity = Math.min(1, 0.4 + spkLevel * 2) * (1 - ph);
      }
    }
    for (const mc of mics) {
      mc.ring.visible = micLevel > 0.005;
      mc.ringMat.opacity = Math.min(0.95, 0.3 + micLevel * 2) * (0.6 + 0.4 * Math.sin(t0 / 120));
    }
    if (heat.visible) {
      const k = 1 + 0.06 * Math.sin(t0 / 260);
      heat.scale.set(heatBase * k, heatBase * k, 1);
    }
    controls.update();
    // Skip bloom when nothing glows (saves 5 blur levels)
    bloom.enabled = glow;
    renderer.info.reset();
    if (!sw.warming()) composer.render();
    lastInfo.calls = renderer.info.render.calls;
    lastInfo.triangles = renderer.info.render.triangles;
    // DOM tags follow their 3D positions
    if (tags.size) {
      const w = container.clientWidth, h = container.clientHeight;
      for (const { el, at, dy } of tags.values()) {
        const p = at();
        if (!p) {
          el.style.display = 'none';
          continue;
        }
        tmp.copy(p).project(camera);
        const vis = tmp.z > -1 && tmp.z < 1;
        el.style.display = vis ? '' : 'none';
        el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h + dy}px) translate(-50%, -100%)`;
      }
    }
    cpuMs = cpuMs * 0.9 + (performance.now() - t0) * 0.1;
  };
  tick();

  /** World → page coordinates (clientX/Y); null when off screen */
  const screenOf = (p: THREE.Vector3): [number, number] | null => {
    const v = p.clone().project(camera);
    if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    const r = renderer.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  };
  const bench: Bench & { _debug: unknown } = {
    setScene,
    setBoard,
    setGpio(level, enable, pwm, levelHi = 0, enableHi = 0) {
      const bit = (lo: number, hi: number, pin: number) => (pin < 32 ? (lo >>> pin) & 1 : (hi >>> (pin - 32)) & 1);
      // Under PWM, LED brightness ≈ duty (the eye can't see 5 kHz flicker, only the average)
      for (const l of leds) {
        const d = pwm?.[l.pin] ?? -1;
        l.target = d >= 0 ? d : bit(enable, enableHi, l.pin) && bit(level, levelHi, l.pin) ? 1 : 0;
      }
      // Passive buzzer only sounds on a square wave (duty strictly between 0 and 1; constant high / low is silent)
      for (const bz of buzzers) {
        const d = pwm?.[bz.pin] ?? -1;
        bz.on = d > 0 && d < 1;
      }
      for (const sv of servos) {
        const d = pwm?.[sv.pin] ?? -1;
        if (d <= 0 || sv.phys) continue;
        const us = (d * 1e6) / sv.freq;
        sv.target = Math.max(0, Math.min(180, ((us - 500) / 2000) * 180));
      }
    },
    setAudio(spk: number, mic: number) {
      spkLevel = spk;
      micLevel = mic;
    },
    /** Servo output-shaft angle (degrees, tryboard-elec second-order dynamics; overshoot / stall can exceed 0–180 slightly) */
    setServoAngle(pin: number, deg: number) {
      for (const sv of servos)
        if (sv.pin === pin) {
          sv.phys = true;
          sv.target = deg;
        }
    },
    setPose(p) {
      pose = p ? { pitch: p.pitch, roll: p.roll, yaw: p.yaw } : { pitch: 0, roll: 0, yaw: 0 };
      if (!rotating) applyPose();
    },
    onPose(cb) {
      poseCb = cb;
    },
    onTouch(cb) {
      touchCb = cb;
    },
    lcdPoint(x, y) {
      if (!touchScreen) return null;
      // Screen pixel → round LCD mesh local coords (radius 16.25 mm, y up) → page coords
      const r = 16.25;
      const v = new THREE.Vector3(((x + 0.5) / 240 - 0.5) * 2 * r, (0.5 - (y + 0.5) / 240) * 2 * r, 0).applyMatrix4(touchScreen.matrixWorld).project(camera);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
      const rc = renderer.domElement.getBoundingClientRect();
      return [rc.left + ((v.x + 1) / 2) * rc.width, rc.top + ((1 - v.y) / 2) * rc.height];
    },
    imuScreenPos() {
      const o = imuRoot();
      if (!o) return null;
      const p = targetPos({ kind: 'part', id: o.userData.pick.id });
      if (!p) return null;
      const v = p.project(camera);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
      const rc = renderer.domElement.getBoundingClientRect();
      return [rc.left + ((v.x + 1) / 2) * rc.width, rc.top + ((1 - v.y) / 2) * rc.height];
    },
    setPot(pin, v) {
      const pot = pots.find((p) => p.pin === pin);
      if (pot) turnPot(pot, v);
    },
    onPot(cb) {
      potCb = cb;
    },
    onEncoder(cb) {
      encCb = cb;
    },
    onEncoderPress(cb) {
      encSwCb = cb;
    },
    setEncoder(pos) {
      // While dragging the hand wins; the core position catches up after release
      if (!encoder || encDrag) return;
      encoder.pos = pos;
      showKnob();
    },
    onDistance(cb) {
      distCb = cb;
    },
    setDistance(cm) {
      placeObstacle(cm);
      return rayDistance();
    },
    pingSonar() {
      if (sonar) sonar.pingT = performance.now();
    },
    encoderScreenPos() {
      if (!encoder) return null;
      return screenOf(encoder.knob.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 8, 0)));
    },
    obstacleScreenPos() {
      if (!sonar || !sonar.obstacle.visible) return null;
      return screenOf(sonar.panel.getWorldPosition(new THREE.Vector3()));
    },
    setRgb(rgb) {
      const [r, g, b] = rgb.map((v) => v / 255);
      const peak = Math.max(r, g, b);
      rgbPeak = peak;
      // Emission follows brightness; colour uses the normalised hue so dim colours don't bloom grey.
      // Real blue LEDs look bright but luma gives them 1/10 of green: compensate by hue so blue still glows
      const lum = peak ? (0.2126 * r + 0.7152 * g + 0.0722 * b) / peak : 1;
      const k = Math.min(4, Math.max(1, 0.25 / lum));
      board.rgbMat.emissive.setRGB(r, g, b);
      board.rgbMat.emissiveIntensity = 7 * k;
      board.rgbMat.color.setRGB(0.87 + r * 0.13, 0.86 + g * 0.14, 0.82 + b * 0.18);
      board.rgbLight.color.setRGB(peak ? r / peak : 0, peak ? g / peak : 0, peak ? b / peak : 0);
      board.rgbLight.intensity = peak * 80 * k;
    },
    setStrip(pin, leds) {
      stripLast.set(pin, leds);
      for (const st of strips) if (st.pin === pin) paintStrip(st, leds);
    },
    setLcd(px) {
      if (!lcdTex) return;
      lcdData.set(px.subarray(0, lcdData.length));
      lcdTex.needsUpdate = true;
    },
    setOled(px) {
      if (!oledTex) return;
      // Display row 0 is at the top but texture v=1 is the top, so write rows reversed; lit pixels are the usual cool bluish OLED white
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 128; x++) {
          const v = px[y * 128 + x] / 255;
          const o = ((63 - y) * 128 + x) * 4;
          oledData[o] = 10 + v * 150;
          oledData[o + 1] = 12 + v * 215;
          oledData[o + 2] = 16 + v * 239;
        }
      }
      oledTex.needsUpdate = true;
    },
    setPowered(on) {
      board.pwrMat.emissiveIntensity = on ? 3 : 0;
    },
    onButton(cb) {
      buttonCb = cb;
    },
    onKey(cb) {
      keyCb = cb;
    },
    capture: () => capturableOf(renderer, scene, composer),
    keyScreenPos(pin) {
      const k = keys.find((x) => x.pin === pin);
      if (!k) return null;
      const v = k.key.getWorldPosition(new THREE.Vector3()).project(camera);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
      const r = renderer.domElement.getBoundingClientRect();
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    },
    buttonScreenPos(name) {
      const b = board.buttons.find((m) => m.name === name);
      if (!b) return null;
      return screenOf(b.getWorldPosition(new THREE.Vector3()));
    },
    setUsb(v) {
      if (!v) {
        usbHost?.dispose();
        usbHost = null;
        return;
      }
      if (!usbHost) {
        board.grp.updateMatrixWorld();
        // Board's native USB port mouth (board-local coords) → world coords
        usbHost = createUsbHost(scene, board.grp.localToWorld(board.usbPort.clone()));
      }
      usbHost.update(v);
    },
    // ---- ScenePickApi
    onPick(cb) {
      pickCb = cb;
    },
    highlight,
    project,
    listPins(): PinInfo[] {
      // Same-named pins (GND, 3V3, 5V) are one net, dedupe by id; order: J1 from pin 1, then J3
      const out: PinInfo[] = [];
      const seen = new Set<string>();
      const n = board.spec.j1.length;
      const recs = [...board.pinRecs.slice(0, n).reverse(), ...board.pinRecs.slice(n).reverse()];
      for (const r of recs) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const role = roles.get(r.id)?.join(' · ');
        out.push(role ? { id: r.id, label: r.label, role } : { id: r.id, label: r.label });
      }
      return out;
    },
    setWireFault,
    rewire,
    bridge,
    setHeat,
    measure,
    setTheme: applyTheme,
    setExtModels: setExt,
    extModels: extList,
    view(k, sel) {
      const off = camera.position.clone().sub(controls.target);
      const dist = off.length();
      const clampD = (d: number) => Math.min(controls.maxDistance, Math.max(controls.minDistance, d));
      if (k === 'in' || k === 'out') {
        camera.position.copy(controls.target).addScaledVector(off.normalize(), clampD(dist * (k === 'in' ? 0.8 : 1.25)));
      } else if (k === 'top' || k === 'front') {
        // Straight down hits OrbitControls' pole singularity: keep a slight tilt; front view can't go below maxPolarAngle
        const dir = k === 'top' ? new THREE.Vector3(0, 1, 0.02) : new THREE.Vector3(0, Math.cos(controls.maxPolarAngle - 0.02), Math.sin(controls.maxPolarAngle - 0.02));
        camera.position.copy(controls.target).addScaledVector(dir.normalize(), dist);
      } else {
        let at: THREE.Vector3 | null = null;
        let r = 0;
        if (sel?.kind === 'part') {
          const o = sel.id === 'board' ? board.grp : partsById.get(sel.id);
          if (o) {
            const b = new THREE.Box3().setFromObject(o);
            at = b.getCenter(new THREE.Vector3());
            r = b.getSize(new THREE.Vector3()).length() / 2;
          }
        } else if (sel?.kind === 'pin') {
          const rec = pinsById(sel.id)[0];
          if (rec) at = pinWorldPos(rec);
          r = 12;
        } else if (sel?.kind === 'wire') {
          const w = wires.find((x) => x.id === sel.id);
          if (w) at = w.curve.getPoint(0.5);
          r = 20;
        }
        if (!at) fitView({ position: camera.position.toArray() as [number, number, number], target: controls.target.toArray() as [number, number, number] });
        else {
          const d = clampD(Math.max(r, 8) / Math.sin((camera.fov * Math.PI) / 360) * 0.9);
          controls.target.copy(at);
          camera.position.copy(at).addScaledVector(off.normalize(), d);
        }
      }
      controls.update();
    },
    ledLevels: () => leds.map((l) => ({ pin: l.pin, target: l.target })),
    stats() {
      return { ...lastInfo, frameMs: Math.round(frameMs * 10) / 10, cpuMs: Math.round(cpuMs * 100) / 100, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
    },
    dispose() {
      cancelAnimationFrame(raf);
      offExt();
      offReport();
      ro.disconnect();
      overlay.remove();
      renderer.dispose();
    },
    // Debug only (camera tuning for screenshots): not part of the interface
    _debug: { camera, controls, renderer, scene, pos: targetPos, wires: () => wires.map((w) => w.id) },
  };
  return bench;
}

