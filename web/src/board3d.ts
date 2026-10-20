// 3D bench: 830-hole breadboard, ESP32 devboards, add-on modules, Dupont wires; all procedurally generated at real size (mm).
// No vendor design files or 3D models; pin order comes from Espressif's public user guides (facts).

import * as THREE from 'three';
import { createUsbHost, type UsbView } from './usb3d';
import type { PinInfo, ScenePickApi } from './scene-api';
import { capturableOf, type Capturable } from './app/capture';
import type { Pose } from './imupose';
import { t } from './i18n';
import { type ChipId, apiId } from './bench3d/boards';
import type { SceneSpec } from './bench3d/spec';
import type { BenchCtx } from './bench3d/ctx';
import { mountStage, mountPost, mountLoop } from './bench3d/stage';
import { mountState, mountScene } from './bench3d/scene';
import { mountBuildersA, mountBuildersB } from './bench3d/build';
import { paintPartLamps } from './bench3d/parts3d';
import { mountPointer, mountTargets } from './bench3d/pick';
import { mountInspect } from './bench3d/inspect';
export { BOARD_C3, BOARD_S3, BOARD_E32, BOARDS, LCD_WIRING } from './bench3d/boards';
export type { ChipId, BoardSpec } from './bench3d/boards';
export { imuPart } from './bench3d/spec';
export type { PartSpec, SceneSpec } from './bench3d/spec';
export { I2S_WIRING } from './i2spins.ts';

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
  /** Screen frame w×h RGBA; ignored unless it matches the bench screen's size */
  setLcd(rgba: Uint8Array, w?: number, h?: number): void;
  /** Bench pose (P2-03): breadboard, board and modules tilt together; null = level */
  setPose(p: Pose | null): void;
  /** Show a board button / breadboard key held or released with no pointer (F-03b paced replay); BOOT goes by bootPin */
  showPress(pin: number, down: boolean, bootPin: number): void;
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
  onButton(cb: (name: 'BOOT' | 'RST' | 'PWR', down: boolean) => void): void;
  /** M5 shell key pressed / released (M5-09c): GPIO of the preset button */
  onBoardButton(cb: (pin: number, down: boolean) => void): void;
  /** Breadboard tactile key (PartSpec 'key') pressed / released */
  onKey(cb: (pin: number, down: boolean) => void): void;
  /** Key page position (clientX/Y) for tests; null if not visible */
  keyScreenPos(pin: number): [number, number] | null;
  /** Button page position (clientX/Y) so automated tests can press the 3D button with a real mouse; null if not visible */
  buttonScreenPos(name: string): [number, number] | null;
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

// Yield to the event loop; scheduler.yield keeps the task's priority where it exists
const nextTask = () => {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return s?.yield ? s.yield() : new Promise<void>((r) => setTimeout(r, 0));
};

/** Build the bench in slices (R-16). GL setup runs synchronously first: once the page has painted, the GPU process is busy
 *  for a few hundred ms and any blocking GL call waits. Board and parts (CPU only) follow per step, below the long-task line. */
export async function createBench(container: HTMLElement, init: Promise<{ chip: ChipId; scene: SceneSpec }>): Promise<Bench> {
  const ctx = { container } as BenchCtx;
  mountStage(ctx);
  mountPost(ctx);
  const first = await init;
  ctx.chip0 = first.chip;
  let last = performance.now();
  // Fast machines merge steps (10 ms budget); slow ones yield after each
  const pace = async () => {
    if (performance.now() - last < 10) return;
    await nextTask();
    last = performance.now();
  };
  await pace();
  for (const _ of mountState(ctx)) await pace();
  mountBuildersA(ctx);
  mountBuildersB(ctx);
  mountScene(ctx);
  await pace();
  mountPointer(ctx);
  mountTargets(ctx);
  mountInspect(ctx);
  const {
    applyTheme, partsById, addRole, renderer, scene, camera, controls, overlay, extList, setExt, offExt, offReport, stripLast, paintStrip, oledData,
    placeObstacle, rayDistance, applyPose, setBoard, fitView, setScene, composer, ro, turnPot, showKnob, imuRoot, pinsById, pinWorldPos,
    targetPos, project, highlight, rewire, bridge, setWireFault, setHeat, measure,
  } = ctx;
  applyTheme('light');
  partsById.set('board', ctx.board.grp);
  if (ctx.board.spec.rgbPin >= 0) addRole(apiId('IO' + ctx.board.spec.rgbPin), t('Onboard WS2812 LED'));
  addRole(apiId('IO' + ctx.board.spec.bootPin), t('BOOT button'));
  await pace();
  // warm() only flags the scene dirty; programs compile once, on the first frame after the build
  for (const _ of ctx.buildScene(first.scene)) {
    ctx.sw.warm();
    await pace();
  }
  mountLoop(ctx);
  const { lastInfo } = ctx;

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
      paintPartLamps((pin) => bit(level, levelHi, pin));
      for (const l of ctx.leds) {
        const d = pwm?.[l.pin] ?? -1;
        l.target = d >= 0 ? d : bit(enable, enableHi, l.pin) && bit(level, levelHi, l.pin) ? 1 : 0;
      }
      // Passive buzzer only sounds on a square wave (duty strictly between 0 and 1; constant high / low is silent)
      for (const bz of ctx.buzzers) {
        const d = pwm?.[bz.pin] ?? -1;
        bz.on = d > 0 && d < 1;
      }
      for (const sv of ctx.servos) {
        const d = pwm?.[sv.pin] ?? -1;
        if (d <= 0 || sv.phys) continue;
        const us = (d * 1e6) / sv.freq;
        sv.target = Math.max(0, Math.min(180, ((us - 500) / 2000) * 180));
      }
    },
    setAudio(spk: number, mic: number) {
      ctx.spkLevel = spk;
      ctx.micLevel = mic;
    },
    /** Servo output-shaft angle (degrees, tryboard-elec second-order dynamics; overshoot / stall can exceed 0–180 slightly) */
    setServoAngle(pin: number, deg: number) {
      for (const sv of ctx.servos)
        if (sv.pin === pin) {
          sv.phys = true;
          sv.target = deg;
        }
    },
    showPress(pin, down, bootPin) {
      for (const b of ctx.board.buttons) if (b.userData.gpio === pin || (b.name === 'BOOT' && pin === bootPin && typeof b.userData.gpio !== 'number')) b.position.y = b.userData.baseY - (down ? 0.4 : 0);
      for (const k of ctx.keys) if (k.pin === pin) k.key.position.y = k.key.userData.baseY - (down ? 1.2 : 0);
    },
    setPose(p) {
      ctx.pose = p ? { pitch: p.pitch, roll: p.roll, yaw: p.yaw } : { pitch: 0, roll: 0, yaw: 0 };
      if (!ctx.rotating) applyPose();
    },
    onPose(cb) {
      ctx.poseCb = cb;
    },
    onTouch(cb) {
      ctx.touchCb = cb;
    },
    lcdPoint(x, y) {
      if (!ctx.touchScreen) return null;
      // Screen pixel → touch mesh local coords (half extents touchHalf mm, y up) → page coords
      const [hx, hy] = ctx.touchHalf;
      const v = new THREE.Vector3(((x + 0.5) / ctx.lcdW - 0.5) * 2 * hx, (0.5 - (y + 0.5) / ctx.lcdH) * 2 * hy, 0).applyMatrix4(ctx.touchScreen.matrixWorld).project(camera);
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
      const pot = ctx.pots.find((p) => p.pin === pin);
      if (pot) turnPot(pot, v);
    },
    onPot(cb) {
      ctx.potCb = cb;
    },
    onEncoder(cb) {
      ctx.encCb = cb;
    },
    onEncoderPress(cb) {
      ctx.encSwCb = cb;
    },
    setEncoder(pos) {
      // While dragging the hand wins; the core position catches up after release
      if (!ctx.encoder || ctx.encDrag) return;
      ctx.encoder.pos = pos;
      showKnob();
    },
    onDistance(cb) {
      ctx.distCb = cb;
    },
    setDistance(cm) {
      placeObstacle(cm);
      return rayDistance();
    },
    pingSonar() {
      if (ctx.sonar) ctx.sonar.pingT = performance.now();
    },
    encoderScreenPos() {
      if (!ctx.encoder) return null;
      return screenOf(ctx.encoder.knob.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 8, 0)));
    },
    obstacleScreenPos() {
      if (!ctx.sonar || !ctx.sonar.obstacle.visible) return null;
      return screenOf(ctx.sonar.panel.getWorldPosition(new THREE.Vector3()));
    },
    setRgb(rgb) {
      const [r, g, b] = rgb.map((v) => v / 255);
      const peak = Math.max(r, g, b);
      ctx.rgbPeak = peak;
      // Emission follows brightness; colour uses the normalised hue so dim colours don't bloom grey.
      // Real blue LEDs look bright but luma gives them 1/10 of green: compensate by hue so blue still glows
      const lum = peak ? (0.2126 * r + 0.7152 * g + 0.0722 * b) / peak : 1;
      const k = Math.min(4, Math.max(1, 0.25 / lum));
      ctx.board.rgbMat.emissive.setRGB(r, g, b);
      ctx.board.rgbMat.emissiveIntensity = 7 * k;
      ctx.board.rgbMat.color.setRGB(0.87 + r * 0.13, 0.86 + g * 0.14, 0.82 + b * 0.18);
      ctx.board.rgbLight.color.setRGB(peak ? r / peak : 0, peak ? g / peak : 0, peak ? b / peak : 0);
      ctx.board.rgbLight.intensity = peak * 80 * k;
    },
    setStrip(pin, leds) {
      stripLast.set(pin, leds);
      // M5 Atom family: the on-board WS2812 is not the chip's default RGB pin, so it arrives as a strip
      if ('ledPin' in ctx.board && ctx.board.ledPin === pin) this.setRgb(leds[0] ?? [0, 0, 0]);
      for (const st of ctx.strips) if (st.pin === pin) paintStrip(st, leds);
    },
    setLcd(px, w = 240, h = 240) {
      if (!ctx.lcdTex || w !== ctx.lcdW || h !== ctx.lcdH || px.length < ctx.lcdData.length) return;
      ctx.lcdData.set(px.subarray(0, ctx.lcdData.length));
      ctx.lcdTex.needsUpdate = true;
    },
    setOled(px) {
      if (!ctx.oledTex) return;
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
      ctx.oledTex.needsUpdate = true;
    },
    setPowered(on) {
      ctx.board.pwrMat.emissiveIntensity = on ? 3 : 0;
    },
    onButton(cb) {
      ctx.buttonCb = cb;
    },
    onBoardButton(cb) {
      ctx.boardBtnCb = cb;
    },
    onKey(cb) {
      ctx.keyCb = cb;
    },
    capture: () => capturableOf(renderer, scene, composer),
    keyScreenPos(pin) {
      const k = ctx.keys.find((x) => x.pin === pin);
      if (!k) return null;
      const v = k.key.getWorldPosition(new THREE.Vector3()).project(camera);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
      const r = renderer.domElement.getBoundingClientRect();
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    },
    buttonScreenPos(name) {
      const b = ctx.board.buttons.find((m) => m.name === name);
      if (!b) return null;
      return screenOf(b.getWorldPosition(new THREE.Vector3()));
    },
    setUsb(v) {
      if (!v) {
        ctx.usbHost?.dispose();
        ctx.usbHost = null;
        return;
      }
      if (!ctx.usbHost) {
        ctx.board.grp.updateMatrixWorld();
        // Board's native USB port mouth (board-local coords) → world coords
        ctx.usbHost = createUsbHost(scene, ctx.board.grp.localToWorld(ctx.board.usbPort.clone()));
      }
      ctx.usbHost.update(v);
    },
    // ---- ScenePickApi
    onPick(cb) {
      ctx.pickCb = cb;
    },
    highlight,
    project,
    listPins(): PinInfo[] {
      // Same-named pins (GND, 3V3, 5V) are one net, dedupe by id; order: J1 from pin 1, then J3
      const out: PinInfo[] = [];
      const seen = new Set<string>();
      const n = ctx.board.spec.j1.length;
      const recs = [...ctx.board.pinRecs.slice(0, n).reverse(), ...ctx.board.pinRecs.slice(n).reverse()];
      for (const r of recs) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const role = ctx.roles.get(r.id)?.join(' · ');
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
          const o = sel.id === 'board' ? ctx.board.grp : partsById.get(sel.id);
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
          const w = ctx.wires.find((x) => x.id === sel.id);
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
    ledLevels: () => ctx.leds.map((l) => ({ pin: l.pin, target: l.target })),
    stats() {
      return { ...lastInfo, frameMs: Math.round(ctx.frameMs * 10) / 10, cpuMs: Math.round(ctx.cpuMs * 100) / 100, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
    },
    dispose() {
      ctx.raf?.();
      offExt();
      offReport();
      ro.disconnect();
      overlay.remove();
      renderer.dispose();
    },
    // Debug only (camera tuning for screenshots): not part of the interface
    _debug: { camera, controls, renderer, scene, pos: targetPos, wires: () => ctx.wires.map((w) => w.id) },
  };
  return bench;
}
