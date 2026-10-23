// Step 4 product (amoclock, G-17c): the Waveshare 2.16" AMOLED board tilted 15° on a desk stand, a phone beside it. Units: mm.
// Screen tap / drag = CST9220 touch, PWR cap = AXP2101 power key, phone tap = BLE time sync; the steel weight sits where the assembly put it.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { currentTheme, onTheme, type Theme } from '../theme';
import { capturableOf, type Capturable } from './capture';
import { amoledBoard, AMOLED } from '../bench3d/amoled';
import { canvasTexture } from '../bench3d/util';
import type { LiveFrame } from '../views/common';
import { amoclockNow } from '../views/amoclockproduct';
import { amoPhone } from './steps/amoclock';
import { t } from '../i18n';
import { shaderWarm } from '../shaderwarm';
import { onFrame, PRIO } from '../ui/frame';

export interface Amoclock3DOptions {
  frame(): LiveFrame;
  touch(x: number, y: number, down: boolean): void;
  pwrkey(): void;
  sync(): void;
  /** Steel weight glued over the antenna (assembly choice B): antenna loss in dB, 0 = weight in the foot */
  antennaDb(): number;
}

export interface Amoclock3D {
  start(): void;
  stop(): void;
  dispose(): void;
  resetView(): void;
  azimuth(): number;
  /** Page positions for tests: screen point at panel pixel (x, y), PWR cap, phone screen */
  screenPos(x?: number, y?: number): [number, number] | null;
  pwrPos(): [number, number] | null;
  phonePos(): [number, number] | null;
  /** Where the weight is drawn now */
  weight(): 'foot' | 'back';
  capture(): Capturable;
}

const PX = 480;
const TILT = (75 * Math.PI) / 180;
/** Minimum gap between logged touch= moves while dragging (the levels use 50 ms steps) */
const MOVE_MS = 30;

export function createAmoclock3D(container: HTMLElement, o: Amoclock3DOptions): Amoclock3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  el.setAttribute('aria-label', t('3D product: AMOLED desk clock on a stand; tap or swipe the screen to change pages, click PWR to turn the screen off, tap the phone to set the time over Bluetooth'));

  const scene = new THREE.Scene();
  const BG = { light: '#EEF1F5', dark: '#1D2024' }, DESK = { light: '#E4E8EE', dark: '#2A2D32' };
  const bg = new THREE.Color(BG[currentTheme()]);
  scene.background = bg;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  const sun = new THREE.DirectionalLight('#FFFFFF', 1.8);
  sun.position.set(-80, 220, 160);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -140, right: 140, top: 140, bottom: -140, near: 10, far: 600 });
  sun.shadow.bias = -0.0004;
  scene.add(sun, new THREE.HemisphereLight('#FFFFFF', '#C9CED6', 0.5));
  const deskMat = new THREE.MeshStandardMaterial({ color: DESK[currentTheme()], roughness: 0.9 });
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), deskMat);
  desk.rotation.x = -Math.PI / 2;
  desk.receiveShadow = true;
  scene.add(desk);
  const offTheme = onTheme((th: Theme) => {
    bg.set(BG[th]);
    deskMat.color.set(DESK[th]);
  });

  // Stand: 70×12×60 foot, the board in a cradle tilted 15° back (estimate)
  const standMat = new THREE.MeshStandardMaterial({ color: 0x3a3936, roughness: 0.6 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.9, roughness: 0.35 });
  const foot = new THREE.Mesh(new THREE.BoxGeometry(70, 12, 60), standMat);
  foot.position.set(0, 6, -6);
  const cradle = new THREE.Group();
  cradle.position.set(0, 37, 0);
  cradle.rotation.x = TILT;
  const board = amoledBoard('ws-amoled216');
  cradle.add(board.grp);
  const { W, L, T } = AMOLED;
  const plate = new THREE.Mesh(new THREE.BoxGeometry(W + 6, 3, L + 4), standMat);
  plate.position.set(0, -T / 2 - 6.3, -1);
  cradle.add(plate);
  // Counterweight 30×4×20: in the foot pocket, or glued to the board back right over the S3 antenna
  const weightFoot = new THREE.Mesh(new THREE.BoxGeometry(30, 5, 20), steelMat);
  weightFoot.position.set(0, 11, -14);
  const weightBack = new THREE.Mesh(new THREE.BoxGeometry(30, 4, 20), steelMat);
  weightBack.position.set(0, -T / 2 - 2.8, -L / 4);
  cradle.add(weightBack);
  scene.add(foot, cradle, weightFoot);
  for (const m of [foot, plate, weightFoot, weightBack]) m.castShadow = true;
  board.grp.traverse((m) => (m.castShadow = true));

  const lcdData = new Uint8Array(PX * PX * 4);
  for (let i = 3; i < lcdData.length; i += 4) lcdData[i] = 255;
  const lcdTex = new THREE.DataTexture(lcdData, PX, PX, THREE.RGBAFormat);
  lcdTex.flipY = true;
  lcdTex.colorSpace = THREE.SRGBColorSpace;
  lcdTex.needsUpdate = true;
  const screen = board.screen!;
  const screenMat = new THREE.MeshBasicMaterial({ map: lcdTex, toneMapped: false });
  screen.material = screenMat;
  const pwrCap = board.buttons.find((b) => b.name === 'PWR')!;

  // Phone on the desk to the right: its screen shows the sync state (tap it to set the time)
  const phone = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(72, 8, 147), new THREE.MeshStandardMaterial({ color: 0x2e3036, roughness: 0.5 }));
  body.position.y = 4;
  body.castShadow = true;
  let phoneText = '';
  const phoneTex = canvasTexture(256, 512, () => {});
  const drawPhone = (s: string) => {
    const g = (phoneTex.image as HTMLCanvasElement).getContext('2d')!;
    g.fillStyle = '#16181C';
    g.fillRect(0, 0, 256, 512);
    g.fillStyle = '#9AD0FF';
    g.font = 'bold 48px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillText('BLE', 128, 200);
    g.fillStyle = '#F2F2F2';
    g.font = 'bold 22px system-ui, sans-serif';
    s.split('\n').forEach((line, i) => g.fillText(line, 128, 270 + i * 32));
    phoneTex.needsUpdate = true;
  };
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(64, 132), new THREE.MeshBasicMaterial({ map: phoneTex, toneMapped: false }));
  glass.rotation.x = -Math.PI / 2;
  glass.position.y = 8.05;
  phone.add(body, glass);
  phone.position.set(100, 0, -20);
  phone.rotation.y = 0.3;
  scene.add(phone);

  const corner = document.createElement('div');
  corner.className = 'p3-disclaimer';
  corner.textContent = t('Illustrative look, not an official Waveshare model');
  container.append(corner);

  const camera = new THREE.PerspectiveCamera(32, 1, 1, 4000);
  const HOME = new THREE.Vector3(45, 110, 250);
  const TARGET = new THREE.Vector3(45, 25, -5);
  camera.position.copy(HOME);
  const controls = new OrbitControls(camera, el);
  controls.target.copy(TARGET);
  controls.enableDamping = true;
  controls.minDistance = 80;
  controls.maxDistance = 600;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.update();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  const sw = shaderWarm(renderer, scene, camera, composer);
  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 52 : 32;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // Nearest surface under the pointer: the AMOLED (panel pixel), PWR cap or the phone
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const targets = [board.grp, phone, foot, plate, weightFoot];
  const hitAt = (ev: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const h = ray.intersectObjects(targets, true)[0];
    if (!h) return null;
    if (h.object === screen && h.uv) return { kind: 'screen' as const, x: Math.round(Math.min(PX - 1, Math.max(0, h.uv.x * PX))), y: Math.round(Math.min(PX - 1, Math.max(0, (1 - h.uv.y) * PX))) };
    if (h.object === pwrCap || h.object.userData.pick?.id === 'PWR') return { kind: 'pwr' as const, x: 0, y: 0 };
    if (h.object === body || h.object === glass) return { kind: 'phone' as const, x: 0, y: 0 };
    return null;
  };
  let finger: { x: number; y: number; at: number } | null = null;
  let pressAt = 0;
  el.addEventListener('pointerdown', (ev) => {
    const h = hitAt(ev);
    if (!h) return;
    controls.enabled = false;
    if (h.kind === 'screen') {
      finger = { x: h.x, y: h.y, at: performance.now() };
      o.touch(h.x, h.y, true);
    } else if (h.kind === 'pwr') {
      pressAt = performance.now();
      o.pwrkey();
    } else o.sync();
  });
  const move = (ev: PointerEvent) => {
    if (finger) {
      const now = performance.now();
      const h = hitAt(ev);
      if (h?.kind === 'screen' && now - finger.at >= MOVE_MS && (h.x !== finger.x || h.y !== finger.y)) {
        finger = { x: h.x, y: h.y, at: now };
        o.touch(h.x, h.y, true);
      }
    } else if (!ev.buttons) el.style.cursor = hitAt(ev) ? (hitAt(ev)!.kind === 'screen' ? 'crosshair' : 'pointer') : 'grab';
  };
  const up = () => {
    if (finger) o.touch(finger.x, finger.y, false);
    finger = null;
    controls.enabled = true;
  };
  el.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);

  const v = new THREE.Vector3();
  const toPage = (p: THREE.Vector3): [number, number] | null => {
    v.copy(p).project(camera);
    if (v.z > 1) return null;
    const r = el.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  };
  const phoneLine = () => {
    const s = amoclockNow;
    if (amoPhone.status === 'notfound') return t('Clock not found\n(antenna blocked?)');
    if (amoPhone.status === 'search') return t('Searching…');
    if (s.sync) return t('Time set\n{time}', { time: s.sync });
    return s.ble === 'conn' ? t('Connected') : t('Tap to set\nthe time');
  };
  let lastLcd: Uint8Array | null = null;
  let raf: (() => void) | null = null;
  function frame() {
    const f = o.frame();
    if (f.lcd && f.lcd !== lastLcd && f.lcd.length === lcdData.length) {
      lastLcd = f.lcd;
      lcdData.set(f.lcd);
      lcdTex.needsUpdate = true;
    }
    screenMat.color.set(amoclockNow.on ? 0xffffff : 0x000000);
    const back = o.antennaDb() > 0;
    weightBack.visible = back;
    weightFoot.visible = !back;
    const by = pwrCap.userData.baseY as number;
    pwrCap.position.y = by - (performance.now() - pressAt < 150 ? 0.5 : 0);
    const pl = phoneLine();
    if (pl !== phoneText) drawPhone((phoneText = pl));
    controls.update();
    if (!sw.warming()) composer.render();
  }

  return {
    start() {
      raf ??= onFrame(frame, { priority: PRIO.render, el: container });
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
      window.removeEventListener('pointerup', up);
      controls.dispose();
      composer.dispose();
      lcdTex.dispose();
      phoneTex.dispose();
      renderer.dispose();
      pmrem.dispose();
      container.replaceChildren();
    },
    resetView() {
      camera.position.copy(HOME);
      controls.target.copy(TARGET);
      controls.update();
    },
    azimuth: () => (controls.getAzimuthalAngle() * 180) / Math.PI,
    screenPos(x = PX / 2, y = PX / 2) {
      // Panel pixel -> screen-plane local point (plane is S×S, rotated flat; row 0 at the far edge)
      const S = AMOLED.screen;
      const p = new THREE.Vector3((x / PX - 0.5) * S, (0.5 - y / PX) * S, 0);
      return toPage(screen.localToWorld(p));
    },
    pwrPos: () => toPage(pwrCap.getWorldPosition(new THREE.Vector3())),
    phonePos: () => toPage(glass.getWorldPosition(new THREE.Vector3())),
    weight: () => (weightBack.visible ? 'back' : 'foot'),
    capture: () => capturableOf(renderer, scene, composer),
  };
}
