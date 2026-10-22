// (4) P2-09 3D products for lamp (knob lamp), ruler (ultrasonic ruler), tilt (motion figure) (G-03) door and (G-04) irlamp; same stage as product3d.ts, units cm.
// LEDs, OLED, round screen and buzzer come from the live sim; assembly effects (hot spots, blocked probe, flipped IMU) come from the caller.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { currentTheme, onTheme, type Theme } from '../theme';
import type { Pose } from '../imupose';
import { capturableOf, type Capturable } from './capture';
import { t } from '../i18n';
import { shaderWarm } from '../shaderwarm';
import { onFrame, PRIO } from '../ui/frame';
import { buildDoor } from './works3d-door';
import { buildIrlamp, buildLampShell } from './works3d-irlamp';

export type WorkKind = 'lamp' | 'ruler' | 'tilt' | 'door' | 'irlamp';

export interface WorkFrame {
  pwm: number[];
  strips?: Record<number, number[][]>;
  oled: Uint8Array | null;
  lcd: Uint8Array | null;
  /** GPIO output levels, bit n = GPIOn (door: relay and red LED) */
  gpio?: number;
  running: boolean;
}

export interface WorkProductOptions {
  kind: WorkKind;
  frame(): WorkFrame;
  effects(): { glare?: boolean; sonarBlock?: number; imuFlip?: boolean; cardBlock?: boolean; irBlock?: boolean };
  /** Whether the buzzer is sounding now (only for the sound-wave rings) */
  sounding(): boolean;
  /** lamp: knob detents turned (positive = clockwise), pressed / released */
  onKnob?(steps: number): void;
  onKnobPress?(down: boolean): void;
  /** ruler: baffle distance from the probe face (cm); initial distance */
  onDistance?(cm: number): void;
  distance?: number;
  /** tilt: disc pose (degrees); initial pose */
  onPose?(p: Pose): void;
  pose?: Pose;
  /** door: a card tapped on the reader (UID hex) or taken away (''); without it the cards are only scenery */
  onCard?(uid: string): void;
  /** door: UID currently on the reader ('' = none) */
  card?(): string;
  /** irlamp: a remote key clicked (NEC script code such as FF00,BA45) */
  onKey?(code: string): void;
}

export interface WorkProduct3D {
  start(): void;
  stop(): void;
  dispose(): void;
  azimuth(): number;
  resetView(): void;
  /** Page position of the draggable thing (knob / baffle / disc) so tests can drag with a real mouse */
  handleScreenPos(): [number, number] | null;
  /** Current state (tests / panel): knob detents, baffle distance, disc pose */
  state(): { knob: number; cm: number; pose: Pose; open: boolean; key: string };
  setDistance(cm: number): void;
  setPose(p: Pose): void;
  /** Photo / video capture (P2-10) */
  capture(): Capturable;
}

function oledTexture() {
  const data = new Uint8Array(128 * 64 * 4);
  const tex = new THREE.DataTexture(data, 128, 64, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, data };
}
/** 1-bit OLED frame -> cyan-on-black texture rows (flipped for DataTexture) */
function paintOled(px: Uint8Array, data: Uint8Array) {
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 128; x++) {
      const on = px[y * 128 + x] > 0;
      const i = ((63 - y) * 128 + x) * 4;
      data[i] = on ? 200 : 4;
      data[i + 1] = on ? 236 : 6;
      data[i + 2] = on ? 255 : 10;
      data[i + 3] = 255;
    }
}
function lcdTexture() {
  const data = new Uint8Array(240 * 240 * 4);
  const tex = new THREE.DataTexture(data, 240, 240, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  // Rows run top to bottom: flip v via the texture matrix
  tex.repeat.set(1, -1);
  tex.offset.set(0, 1);
  tex.needsUpdate = true;
  return { tex, data };
}

/** Desk ruler (ruler work): 0–80 cm, tick every 1 cm, number every 10 cm */
function tapeTexture() {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = '#F2D45C';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#1E1E1E';
  g.font = '600 30px "JetBrains Mono", ui-monospace, monospace';
  g.textAlign = 'center';
  for (let cm = 0; cm <= 80; cm++) {
    const x = (cm / 80) * (c.width - 40) + 20;
    const h = cm % 10 === 0 ? 46 : cm % 5 === 0 ? 32 : 20;
    g.fillRect(x - 1.5, 0, 3, h);
    if (cm % 10 === 0) g.fillText(String(cm), x, 84);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createWork3D(container: HTMLElement, o: WorkProductOptions): WorkProduct3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';

  const scene = new THREE.Scene();
  const BG = { light: '#EEF1F5', dark: '#1D2024' }, DESK = { light: '#E4E8EE', dark: '#2A2D32' };
  const bgColor = new THREE.Color(BG[currentTheme()]);
  scene.background = bgColor;
  scene.fog = new THREE.Fog(bgColor, 160, 340);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  const sun = new THREE.DirectionalLight('#FFFFFF', 1.2);
  sun.position.set(-8, 16, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const S = o.kind === 'ruler' ? 30 : o.kind === 'door' ? 40 : 14;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S });
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0005;
  scene.add(sun, new THREE.HemisphereLight('#FFFFFF', '#C9CED6', 0.35));
  const desk = new THREE.Mesh(new THREE.CircleGeometry(120, 64), new THREE.MeshStandardMaterial({ color: DESK[currentTheme()], roughness: 0.92 }));
  desk.rotation.x = -Math.PI / 2;
  desk.receiveShadow = true;
  scene.add(desk);
  const offTheme = onTheme((t: Theme) => {
    bgColor.set(BG[t]);
    scene.fog!.color.set(BG[t]);
    (desk.material as THREE.MeshStandardMaterial).color.set(DESK[t]);
  });

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
  const VIEW: Record<WorkKind, { home: THREE.Vector3; target: THREE.Vector3; min: number; max: number }> = {
    lamp: { home: new THREE.Vector3(17, 15, 36), target: new THREE.Vector3(0, 5.2, 0), min: 14, max: 60 },
    ruler: { home: new THREE.Vector3(8, 44, 80), target: new THREE.Vector3(17, 1.5, 0), min: 14, max: 120 },
    tilt: { home: new THREE.Vector3(0, 17, 17), target: new THREE.Vector3(0, 2.6, 0), min: 9, max: 40 },
    door: { home: new THREE.Vector3(-12, 30, 62), target: new THREE.Vector3(2, 22, 0), min: 16, max: 130 },
    irlamp: { home: new THREE.Vector3(20, 17, 40), target: new THREE.Vector3(3, 4, 3), min: 14, max: 70 },
  };
  const V = VIEW[o.kind];
  camera.position.copy(V.home);

  // Label overlay
  const tags = document.createElement('div');
  tags.className = 'p3-tags';
  const tag = (text: string, cls = '') => {
    const t = document.createElement('div');
    t.className = 'p3-tag ' + cls;
    t.textContent = text;
    tags.appendChild(t);
    return t;
  };
  const corner = document.createElement('div');
  corner.className = 'p3-disclaimer';
  corner.textContent = o.kind === 'tilt' ? t('Illustrative look, not an official Espressif model · the bean is an original character') : t('Illustrative look, not an official Espressif model');
  container.append(tags, corner);

  const shellMat = (color: string) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.5 });
  const hits: THREE.Object3D[] = [];
  const occluders: THREE.Object3D[] = [];
  const tagList: { el: HTMLElement; at: () => THREE.Vector3; dx?: number; dy?: number }[] = [];
  /** Per-frame work-specific update */
  let tick: (f: WorkFrame, dt: number, now: number) => void = () => {};
  /** Pointer: return true when this press is ours (disables orbiting) */
  let onDown: (hit: THREE.Object3D, e: PointerEvent) => boolean = () => false;
  let onMove: (e: PointerEvent) => void = () => {};
  let onUp: () => void = () => {};
  let onWheel: (hit: THREE.Object3D, dy: number) => boolean = () => false;
  let handle: THREE.Object3D | null = null;
  let knobCount = 0;
  let cm = o.distance ?? 25;
  let pose: Pose = { ...(o.pose ?? { pitch: 0, roll: 0, yaw: 0 }) };
  let setDistance = (_: number) => {};
  let setPose = (_: Pose) => {};
  let doorOpen = () => false;
  let irKey = () => '';

  // Buzzer sound-wave rings (ruler)
  const waves: THREE.Mesh[] = [];

  if (o.kind === 'lamp') {
    const paint = buildLampShell({ scene, shellMat, occluders, tag, tagList, effects: o.effects });
    // Knob: front right of the base, shaft forward (+z); drag / wheel to turn, click to press
    const knob = new THREE.Group();
    const kmat = new THREE.MeshStandardMaterial({ color: '#1B1D21', roughness: 0.45, metalness: 0.3 });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.76, 1.1, 30), kmat);
    cap.rotation.x = Math.PI / 2;
    knob.add(cap);
    const ridges = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.06, 0.9), kmat, 30);
    const mm = new THREE.Matrix4();
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      ridges.setMatrixAt(i, new THREE.Matrix4().makeTranslation(Math.cos(a) * 0.74, Math.sin(a) * 0.74, 0).multiply(mm.makeRotationZ(a)));
    }
    knob.add(ridges);
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.4, 0.02), new THREE.MeshBasicMaterial({ color: '#F2F2F2' }));
    mark.position.set(0, 0.4, 0.56);
    knob.add(mark);
    const KNOB_Z = 3 + 0.55;
    knob.position.set(2.3, 1.8, KNOB_Z);
    knob.traverse((x) => (x.castShadow = true));
    scene.add(knob);
    const knobHit = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 1.6, 16), new THREE.MeshBasicMaterial({ visible: false }));
    knobHit.rotation.x = Math.PI / 2;
    knobHit.position.copy(knob.position);
    scene.add(knobHit);
    hits.push(knobHit);
    handle = knobHit;
    const hint = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.08, 48), new THREE.MeshBasicMaterial({ color: '#FF7A1A', transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    hint.position.set(2.3, 1.8, 3.02);
    scene.add(hint);
    // DC lead out the back
    const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-2, 1, -3), new THREE.Vector3(-2, 0.8, -4.2), new THREE.Vector3(-1.4, 0.12, -6), new THREE.Vector3(1, 0.12, -12)]), 40, 0.14, 10), new THREE.MeshStandardMaterial({ color: '#1E1E1E', roughness: 0.6 }));
    cable.castShadow = true;
    scene.add(cable);
    tagList.push({ el: tag(t('EC11 knob · drag or scroll to turn, click to switch mode'), 'hot'), at: () => new THREE.Vector3(2.3, 0.2, KNOB_Z + 0.4), dy: 16 });

    let angle = 0;
    let press: { x: number; y: number; acc: number; moved: boolean } | null = null;
    const turn = (steps: number) => {
      if (!steps) return;
      knobCount += steps;
      o.onKnob?.(steps);
    };
    onDown = (hit, e) => {
      if (hit !== knobHit) return false;
      press = { x: e.clientX, y: e.clientY, acc: 0, moved: false };
      return true;
    };
    onMove = (e) => {
      if (!press) return;
      // Drag right / up = clockwise; one detent per 16 px
      const d = e.clientX - press.x - (e.clientY - press.y);
      press.x = e.clientX;
      press.y = e.clientY;
      press.acc += d;
      if (Math.abs(press.acc) > 4) press.moved = true;
      const steps = Math.trunc(press.acc / 16);
      if (steps) {
        press.acc -= steps * 16;
        turn(steps);
      }
    };
    onUp = () => {
      if (press && !press.moved) {
        o.onKnobPress?.(true);
        setTimeout(() => o.onKnobPress?.(false), 120);
        knob.position.z = KNOB_Z - 0.15;
        setTimeout(() => (knob.position.z = KNOB_Z), 140);
      }
      press = null;
    };
    onWheel = (hit, dy) => {
      if (hit !== knobHit) return false;
      turn(dy < 0 ? 1 : -1);
      return true;
    };
    tick = (f, dt, now) => {
      paint(f);
      angle += ((knobCount * Math.PI) / 10 - angle) * (1 - Math.exp(-dt * 18));
      knob.rotation.z = -angle;
      (hint.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.4 * (0.5 + 0.5 * Math.sin(now / 300));
    };
  } else if (o.kind === 'ruler') {
    // Handheld case 9 x 3 x 4.8 cm lying flat; probes toward +x; OLED on top; sound hole on the left
    const W = 9, H = 3, D = 4.8;
    const body = new THREE.Mesh(new RoundedBoxGeometry(W, H, D, 5, 0.6), shellMat('#2B5FD9'));
    body.position.set(0, H / 2, 0);
    body.castShadow = body.receiveShadow = true;
    scene.add(body);
    occluders.push(body);
    const face = new THREE.Mesh(new RoundedBoxGeometry(0.3, H - 0.3, D - 0.3, 3, 0.1), shellMat('#2350C0'));
    face.position.set(W / 2 - 0.1, H / 2, 0);
    scene.add(face);
    const probes = new THREE.Group();
    const can = new THREE.MeshStandardMaterial({ color: '#B8BCC2', metalness: 0.85, roughness: 0.32 });
    const mesh = new THREE.MeshStandardMaterial({ color: '#2A2C30', roughness: 0.9 });
    for (const z of [-1.3, 1.3]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.2, 32), can);
      c.rotation.z = Math.PI / 2;
      c.position.set(0, 0, z);
      probes.add(c);
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.66, 32), mesh);
      m.rotation.y = Math.PI / 2;
      m.position.set(0.61, 0, z);
      probes.add(m);
    }
    probes.traverse((x) => (x.castShadow = true));
    scene.add(probes);
    const PROBE_OUT = W / 2 + 0.2;
    // OLED on top
    const { tex: oTex, data: oData } = oledTexture();
    const bez = new THREE.Mesh(new RoundedBoxGeometry(3.5, 0.12, 1.95, 3, 0.05), new THREE.MeshStandardMaterial({ color: '#0B0C0E', roughness: 0.55 }));
    bez.position.set(-1.2, H + 0.02, 0);
    scene.add(bez);
    const scrMat = new THREE.MeshBasicMaterial({ map: oTex, toneMapped: false });
    scrMat.color.setScalar(1.15);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(3.04, 1.52), scrMat);
    scr.rotation.x = -Math.PI / 2;
    scr.position.set(-1.2, H + 0.09, 0);
    scene.add(scr);
    // Sound hole + waves
    const holeMat = new THREE.MeshStandardMaterial({ color: '#1A2E66', roughness: 0.9 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 6) * Math.PI * 2, r = i === 6 ? 0 : 0.3;
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 12), holeMat);
      h.position.set(2.3 + r * Math.cos(a), H + 0.005, r * Math.sin(a));
      scene.add(h);
    }
    for (let i = 0; i < 3; i++) {
      const w = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.03, 8, 48), new THREE.MeshBasicMaterial({ color: '#0D99FF', transparent: true, opacity: 0 }));
      w.rotation.x = Math.PI / 2;
      w.position.set(2.3, H + 0.3, 0);
      scene.add(w);
      waves.push(w);
    }
    // USB lead out the tail
    const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-W / 2, 1, 0), new THREE.Vector3(-W / 2 - 1.2, 0.8, 0), new THREE.Vector3(-W / 2 - 3, 0.12, 1), new THREE.Vector3(-W / 2 - 9, 0.12, 4)]), 40, 0.13, 10), new THREE.MeshStandardMaterial({ color: '#1E1E1E', roughness: 0.6 }));
    cable.castShadow = true;
    scene.add(cable);
    // Desk ruler: 0 aligned with the probe face
    const tape = new THREE.Mesh(new THREE.PlaneGeometry(80 * (2048 / 2008), 2.4), new THREE.MeshStandardMaterial({ map: tapeTexture(), roughness: 0.6 }));
    tape.rotation.x = -Math.PI / 2;
    tape.position.set(PROBE_OUT + 40 * (2048 / 2008) - 20 * (80 / 2008), 0.02, D / 2 + 1.6);
    tape.receiveShadow = true;
    scene.add(tape);
    // Baffle: a wooden board standing on the desk facing the probes; drag it back and forth
    const board = new THREE.Group();
    const wood = new THREE.Mesh(new RoundedBoxGeometry(1.2, 9, 12, 3, 0.15), new THREE.MeshStandardMaterial({ color: '#C8A26B', roughness: 0.7 }));
    wood.position.set(0.6, 4.5, 0);
    wood.castShadow = wood.receiveShadow = true;
    board.add(wood);
    const foot = new THREE.Mesh(new RoundedBoxGeometry(4, 0.6, 6, 2, 0.1), new THREE.MeshStandardMaterial({ color: '#8A6A42', roughness: 0.8 }));
    foot.position.set(1.4, 0.3, 0);
    foot.castShadow = true;
    board.add(foot);
    scene.add(board);
    const boardHit = new THREE.Mesh(new THREE.BoxGeometry(3, 10, 13), new THREE.MeshBasicMaterial({ visible: false }));
    boardHit.position.set(0.6, 4.5, 0);
    board.add(boardHit);
    hits.push(boardHit);
    handle = boardHit;
    const tagCm = tag('', 'hot');
    tagList.push({ el: tagCm, at: () => new THREE.Vector3(board.position.x + 0.6, 9.8, 0) });
    tagList.push({ el: tag(t('HC-SR04 probe')), at: () => new THREE.Vector3(PROBE_OUT, 3.4, -2.6), dy: -10 });
    const place = (d: number) => {
      cm = Math.round(Math.max(2, Math.min(80, d)) * 10) / 10;
      board.position.x = PROBE_OUT + cm;
      tagCm.textContent = t('Baffle · {cm} cm · draggable', { cm: cm.toFixed(1) });
    };
    place(cm);
    setDistance = (d) => place(d);
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    let drag: { off: number } | null = null;
    onDown = (hit) => {
      if (hit !== boardHit) return false;
      drag = { off: 0 };
      if (ray.ray.intersectPlane(floor, p)) drag.off = board.position.x - p.x;
      renderer.domElement.style.cursor = 'grabbing';
      return true;
    };
    onMove = () => {
      if (!drag || !ray.ray.intersectPlane(floor, p)) return;
      place(p.x + drag.off - PROBE_OUT);
      o.onDistance?.(cm);
    };
    onUp = () => {
      drag = null;
    };
    let lastOled: Uint8Array | null = null;
    tick = (f, dt, now) => {
      if (f.oled && f.oled !== lastOled) {
        lastOled = f.oled;
        paintOled(f.oled, oData);
        oTex.needsUpdate = true;
      }
      // Assembly B: probes recessed 6 mm behind the holes
      const blocked = !!o.effects().sonarBlock;
      probes.position.set(blocked ? W / 2 - 0.8 : PROBE_OUT - 0.6, H / 2, 0);
      const snd = o.sounding();
      waves.forEach((w, i) => {
        const ph = (now / 500 + i / 3) % 1;
        const mat = w.material as THREE.MeshBasicMaterial;
        mat.opacity = snd ? 0.6 * (1 - ph) : Math.max(0, mat.opacity - dt * 3);
        w.scale.setScalar(0.5 + ph * 1.6);
        w.position.y = H + 0.3 + ph * 0.8;
      });
    };
  } else if (o.kind === 'irlamp') {
    const d = buildIrlamp({ scene, shellMat, occluders, tag, tagList, hits, onKey: o.onKey, effects: o.effects });
    tick = (f, dt) => d.tick(f, dt);
    onDown = (hit) => d.onDown(hit);
    handle = d.handle;
    irKey = d.key;
  } else if (o.kind === 'door') {
    const d = buildDoor({ scene, shellMat, tag, tagList, hits, occluders, oled: oledTexture(), paintOled, onCard: o.onCard, card: o.card, effects: o.effects });
    tick = (f, dt) => d.tick(f, dt);
    onDown = (hit) => d.onDown(hit);
    handle = d.handle;
    doorOpen = d.open;
  } else {
    // Disc case Ø5.6 x 2.6 cm, round screen on top; on a small stand, drag to tilt
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.2, 0.8, 48), shellMat('#3A3936'));
    stand.position.y = 0.4;
    stand.castShadow = stand.receiveShadow = true;
    scene.add(stand);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), new THREE.MeshStandardMaterial({ color: '#BDB9B0', metalness: 0.6, roughness: 0.3 }));
    ball.position.y = 1.0;
    scene.add(ball);
    const disc = new THREE.Group();
    disc.position.y = 2.6;
    scene.add(disc);
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 2.2, 72), shellMat('#ECE9E2'));
    shell.castShadow = shell.receiveShadow = true;
    disc.add(shell);
    occluders.push(shell);
    const bezel = new THREE.Mesh(new THREE.RingGeometry(1.62, 2.55, 72), new THREE.MeshStandardMaterial({ color: '#1A1A19', roughness: 0.4 }));
    bezel.rotation.x = -Math.PI / 2;
    bezel.position.y = 1.105;
    disc.add(bezel);
    const { tex: lTex, data: lData } = lcdTexture();
    const screen = new THREE.Mesh(new THREE.CircleGeometry(1.62, 72), new THREE.MeshBasicMaterial({ map: lTex, toneMapped: false }));
    screen.rotation.x = -Math.PI / 2;
    screen.position.y = 1.11;
    disc.add(screen);
    // Small arrow at the front (+z): the IMU X axis points forward
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 16), new THREE.MeshStandardMaterial({ color: '#FF7A1A', roughness: 0.4 }));
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(0, 0, 2.9);
    disc.add(arrow);
    const discHit = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 3, 24), new THREE.MeshBasicMaterial({ visible: false }));
    disc.add(discHit);
    hits.push(discHit);
    handle = discHit;
    const tagPose = tag('', 'hot');
    tagList.push({ el: tagPose, at: () => new THREE.Vector3(0, 0.2, 3.4), dy: 22 });
    const apply = (p: Pose) => {
      pose = { pitch: Math.max(-40, Math.min(40, p.pitch)), roll: Math.max(-40, Math.min(40, p.roll)), yaw: p.yaw };
      // roll > 0: right (+x) side down; pitch > 0: front (+z) down (matches the bean's slide direction in firmware)
      disc.rotation.set((pose.pitch * Math.PI) / 180, 0, (-pose.roll * Math.PI) / 180, 'XZY');
      tagPose.textContent = t('Drag to tilt · pitch {pitch}° roll {roll}°', { pitch: pose.pitch.toFixed(0), roll: pose.roll.toFixed(0) });
    };
    apply(pose);
    setPose = (p) => apply(p);
    let drag: { x: number; y: number; p0: Pose } | null = null;
    onDown = (hit, e) => {
      if (hit !== discHit) return false;
      drag = { x: e.clientX, y: e.clientY, p0: { ...pose } };
      renderer.domElement.style.cursor = 'grabbing';
      return true;
    };
    onMove = (e) => {
      if (!drag) return;
      // Drag right = right side down (roll +), drag down = front down (pitch +); 1° per 4 px
      apply({ pitch: drag.p0.pitch + (e.clientY - drag.y) / 4, roll: drag.p0.roll + (e.clientX - drag.x) / 4, yaw: 0 });
      o.onPose?.(pose);
    };
    onUp = () => {
      drag = null;
    };
    let lastLcd: Uint8Array | null = null;
    tick = (f) => {
      if (f.lcd && f.lcd !== lastLcd && f.lcd.length === lData.length) {
        lastLcd = f.lcd;
        lData.set(f.lcd);
        lTex.needsUpdate = true;
      }
    };
  }

  // ---------------------------------------------------------------- Interaction: registered before OrbitControls
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const el = renderer.domElement;
  let mine = false;
  const toNdc = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    toNdc(e);
    const h = ray.intersectObjects(hits, false)[0];
    if (h && onDown(h.object, e)) {
      mine = true;
      controls.enabled = false;
      el.setPointerCapture(e.pointerId);
    }
  });
  el.addEventListener('pointermove', (e) => {
    toNdc(e);
    if (mine) return onMove(e);
    el.style.cursor = ray.intersectObjects(hits, false).length ? 'pointer' : 'grab';
  });
  const up = () => {
    if (mine) onUp();
    mine = false;
    controls.enabled = true;
    el.style.cursor = 'grab';
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener(
    'wheel',
    (e) => {
      toNdc(e);
      const h = ray.intersectObjects(hits, false)[0];
      if (h && onWheel(h.object, e.deltaY)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { capture: true, passive: false },
  );

  const controls = new OrbitControls(camera, el);
  controls.target.copy(V.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.enablePan = false;
  controls.minDistance = V.min;
  controls.maxDistance = V.max;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.update();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.25, 1.2));
  composer.addPass(new OutputPass());
  const sw = shaderWarm(renderer, scene, camera, composer);

  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 44 : 32;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const v = new THREE.Vector3();
  const occRay = new THREE.Raycaster();
  function hidden(p: THREE.Vector3) {
    const dir = p.clone().sub(camera.position);
    const dist = dir.length();
    occRay.set(camera.position, dir.normalize());
    occRay.far = dist - 0.3;
    return occRay.intersectObjects(occluders, false).length > 0;
  }
  function screenPos(p: THREE.Vector3): [number, number] | null {
    v.copy(p).project(camera);
    if (v.z > 1) return null;
    const r = el.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }
  let raf: (() => void) | null = null;
  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(o.frame(), dt, now);
    controls.update();
    if (!sw.warming()) composer.render();
    for (const t of tagList) {
      const p = t.at();
      v.copy(p).project(camera);
      t.el.style.display = v.z < 1 && !hidden(p) ? '' : 'none';
      t.el.style.transform = `translate(${((v.x + 1) / 2) * container.clientWidth + (t.dx ?? 0)}px, ${((1 - v.y) / 2) * container.clientHeight + (t.dy ?? 0)}px) translate(-50%, -50%)`;
    }
  }

  return {
    start() {
      if (raf) return;
      last = performance.now();
      raf = onFrame(frame, { priority: PRIO.render, el: container });
    },
    stop() {
      raf?.();
      raf = null;
      up();
    },
    dispose() {
      raf?.();
      raf = null;
      offTheme();
      ro.disconnect();
      controls.dispose();
      composer.dispose();
      renderer.dispose();
      pmrem.dispose();
      container.replaceChildren();
    },
    azimuth: () => (controls.getAzimuthalAngle() * 180) / Math.PI,
    resetView() {
      camera.position.copy(V.home);
      controls.target.copy(V.target);
      controls.update();
    },
    handleScreenPos() {
      if (!handle) return null;
      handle.updateWorldMatrix(true, false);
      return screenPos(new THREE.Vector3().setFromMatrixPosition(handle.matrixWorld));
    },
    state: () => ({ knob: knobCount, cm, pose: { ...pose }, open: doorOpen(), key: irKey() }),
    setDistance: (d) => setDistance(d),
    setPose: (p) => setPose(p),
    capture: () => capturableOf(renderer, scene, composer),
  };
}
