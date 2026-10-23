// Step 4 product (dialtimer, G-16b): the M5Stack Dial on a desk, same procedural shell as the bench (bench3d/m5shell.ts). Units: mm.
// Ring drag / wheel = encoder detents, ring tap = BtnA (G42), glass tap = FT3267 touch; the screen is the live GC9A01 frame.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { currentTheme, onTheme, type Theme } from '../theme';
import { capturableOf, type Capturable } from './capture';
import { m5Shell } from '../bench3d/m5shell';
import type { LiveFrame } from '../views/common';
import { t } from '../i18n';
import { shaderWarm } from '../shaderwarm';
import { onFrame, PRIO } from '../ui/frame';

export interface Dial3DOptions {
  frame(): LiveFrame;
  enc(steps: number): void;
  btn(down: boolean): void;
  touch(x: number, y: number, down: boolean): void;
  /** Buzzer currently audible (Web Audio): the speaker grille glows */
  sounding(): boolean;
  /** Assembled stand (G-16c): A = Dial seated on the 6 mm collar, B = pressed in so the collar pins the ring; absent = bare on the desk */
  stand?: 'A' | 'B';
}

export interface Dial3D {
  start(): void;
  stop(): void;
  dispose(): void;
  resetView(): void;
  azimuth(): number;
  /** Page position of the ring's front edge / the screen centre, so tests can drag / tap with a real mouse */
  ringPos(): [number, number] | null;
  screenPos(): [number, number] | null;
  /** Ring turns that don't come from the 3D view (phone keys, desktop buttons) */
  turned(n: number): void;
  /** Detents turned in this view so far */
  detents(): number;
  capture(): Capturable;
  /** Stand this view was built with (Product rebuilds when the assembly changes it) */
  stand?: 'A' | 'B';
}

/** Sideways drag per detent, same as the bench encoder */
const ENC_PX = 14;

export function createDial3D(container: HTMLElement, o: Dial3DOptions): Dial3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  el.setAttribute('aria-label', t('3D product: M5Stack Dial timer; drag or scroll the orange ring to set minutes, tap the ring to start or pause, tap the screen to cancel'));

  const scene = new THREE.Scene();
  const BG = { light: '#EEF1F5', dark: '#1D2024' }, DESK = { light: '#E4E8EE', dark: '#2A2D32' };
  const bg = new THREE.Color(BG[currentTheme()]);
  scene.background = bg;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  const sun = new THREE.DirectionalLight('#FFFFFF', 1.8);
  sun.position.set(-60, 180, 110);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 10, far: 400 });
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

  // The bench's Dial shell, standing on the desk; its screen mesh gets the live framebuffer
  const board = m5Shell('m5dial');
  board.grp.position.y = board.T / 2;
  board.grp.traverse((m) => (m.castShadow = true));
  const pinned = o.stand === 'B';
  if (o.stand) scene.add(dialStand(board.grp, pinned));
  else scene.add(board.grp);
  const lcdData = new Uint8Array(240 * 240 * 4);
  for (let i = 3; i < lcdData.length; i += 4) lcdData[i] = 255;
  const lcdTex = new THREE.DataTexture(lcdData, 240, 240, THREE.RGBAFormat);
  lcdTex.flipY = true;
  lcdTex.colorSpace = THREE.SRGBColorSpace;
  lcdTex.needsUpdate = true;
  const screen = board.screen!;
  screen.material = new THREE.MeshBasicMaterial({ map: lcdTex, toneMapped: false });
  const enc = board.encoder!;
  // Buzzer glow: a faint warm light over the ring while the buzzer is audible
  const buzz = new THREE.PointLight(0xffa040, 0, 60, 2);
  buzz.position.set(0, board.T + 14, 0);
  scene.add(buzz);
  const corner = document.createElement('div');
  corner.className = 'p3-disclaimer';
  corner.textContent = t('Illustrative look, not an official M5Stack model');
  container.append(corner);
  if (pinned) {
    const warn = document.createElement('div');
    warn.className = 'p3-disclaimer p3-warn';
    warn.style.top = '36px';
    warn.textContent = t('The stand collar pins the ring: turning it does nothing (as assembled)');
    container.append(warn);
  }

  const camera = new THREE.PerspectiveCamera(32, 1, 1, 4000);
  // In the stand the Dial sits ~25 mm up and tilts towards the viewer: back off and look from the front-right so the wedge shows
  const HOME = o.stand ? new THREE.Vector3(70, 120, 190) : new THREE.Vector3(0, 120, 112);
  const TARGET = o.stand ? new THREE.Vector3(0, 22, 0) : new THREE.Vector3(0, 6, 2);
  camera.position.copy(HOME);
  const controls = new OrbitControls(camera, el);
  controls.target.copy(TARGET);
  controls.enableDamping = true;
  controls.minDistance = 60;
  controls.maxDistance = 420;
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
    camera.fov = w / h < 1 ? 50 : 32;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  let pos = 0, pushed = false;
  const showKnob = () => {
    enc.knob.rotation.y = -(pos * Math.PI) / 10;
    enc.knob.position.y = enc.y0 - (pushed ? 0.4 : 0);
  };
  const turn = (n: number) => {
    if (!n || pinned) return;
    pos += n;
    showKnob();
    o.enc(n);
  };
  const press = () => {
    pushed = true;
    showKnob();
    o.btn(true);
    setTimeout(() => {
      pushed = false;
      showKnob();
      o.btn(false);
    }, 100);
  };

  // Nearest surface of the Dial under the pointer: ring, glass rim (also BtnA) or the screen
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hitAt = (ev: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const h = ray.intersectObject(board.grp, true)[0];
    if (!h) return null;
    if (h.object === screen && h.uv) return { kind: 'screen' as const, x: Math.min(239, Math.max(0, h.uv.x * 240)), y: Math.min(239, Math.max(0, (1 - h.uv.y) * 240)) };
    if (h.object === enc.hit || board.buttons.includes(h.object as THREE.Mesh)) return { kind: 'ring' as const, x: 0, y: 0 };
    return null;
  };
  let drag: { x0: number; done: number; t0: number } | null = null;
  let finger: { x: number; y: number } | null = null;
  el.addEventListener('pointerdown', (ev) => {
    const h = hitAt(ev);
    if (!h) return;
    controls.enabled = false;
    if (h.kind === 'ring') drag = { x0: ev.clientX, done: 0, t0: performance.now() };
    else {
      finger = { x: h.x, y: h.y };
      o.touch(h.x, h.y, true);
    }
  });
  const move = (ev: PointerEvent) => {
    if (drag) {
      const n = Math.trunc((ev.clientX - drag.x0) / ENC_PX) - drag.done;
      if (n) {
        drag.done += n;
        turn(n);
      }
    } else if (!ev.buttons) el.style.cursor = hitAt(ev) ? (hitAt(ev)!.kind === 'ring' ? 'ew-resize' : 'pointer') : 'grab';
  };
  const up = () => {
    if (drag && !drag.done && performance.now() - drag.t0 < 600) press();
    if (finger) o.touch(finger.x, finger.y, false);
    if (drag || finger) controls.enabled = true;
    drag = null;
    finger = null;
  };
  el.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  // Wheel over the ring turns it instead of zooming (capture runs before OrbitControls)
  el.addEventListener('wheel', (ev) => {
    if (hitAt(ev)?.kind !== 'ring') return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    turn(ev.deltaY < 0 ? 1 : -1);
  }, { capture: true, passive: false });

  const v = new THREE.Vector3();
  const toPage = (p: THREE.Vector3): [number, number] | null => {
    v.copy(p).project(camera);
    if (v.z > 1) return null;
    const r = el.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
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
    buzz.intensity += ((o.sounding() ? 900 : 0) - buzz.intensity) * 0.3;
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
    // Front edge of the ring, 2 mm in from its rim (the panel covers the rest)
    ringPos: () => toPage(board.grp.localToWorld(new THREE.Vector3(0, enc.y0 + 5, 20))),
    screenPos: () => toPage(screen.getWorldPosition(new THREE.Vector3())),
    turned(n) {
      if (pinned) return;
      pos += n;
      showKnob();
    },
    detents: () => pos,
    capture: () => capturableOf(renderer, scene, composer),
    stand: o.stand,
  };
}

/** 3D-printed wedge stand: 56 x 60 mm footprint, top face tilted 30° towards the viewer, rounded-square collar around the Dial.
 *  The collar is 6 mm tall (clear of the ring) or 13 mm when the Dial is pressed in (it reaches the ring). */
function dialStand(dial: THREE.Object3D, pinned: boolean) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#D6D1C6', roughness: 0.75 });
  const TILT = Math.PI / 6, D = 60, W = 56, FRONT = 4, BACK = FRONT + D * Math.tan(TILT);
  const side = new THREE.Shape([new THREE.Vector2(D / 2, 0), new THREE.Vector2(D / 2, FRONT), new THREE.Vector2(-D / 2, BACK), new THREE.Vector2(-D / 2, 0)]);
  const wedgeGeo = new THREE.ExtrudeGeometry(side, { depth: W, bevelEnabled: false });
  wedgeGeo.rotateY(-Math.PI / 2);
  wedgeGeo.translate(W / 2, 0, 0);
  const wedge = new THREE.Mesh(wedgeGeo, mat);
  const mount = new THREE.Group();
  mount.position.set(0, (FRONT + BACK) / 2, 0);
  mount.rotation.x = TILT;
  const rr = (w: number, r: number) => {
    const sh = new THREE.Shape();
    const h = w / 2;
    sh.moveTo(-h + r, -h);
    sh.lineTo(h - r, -h);
    sh.quadraticCurveTo(h, -h, h, -h + r);
    sh.lineTo(h, h - r);
    sh.quadraticCurveTo(h, h, h - r, h);
    sh.lineTo(-h + r, h);
    sh.quadraticCurveTo(-h, h, -h, h - r);
    sh.lineTo(-h, -h + r);
    sh.quadraticCurveTo(-h, -h, -h + r, -h);
    return sh;
  };
  const ring = rr(51, 10);
  ring.holes.push(rr(46, 8.5));
  const collarGeo = new THREE.ExtrudeGeometry(ring, { depth: pinned ? 13 : 6, bevelEnabled: false });
  collarGeo.rotateX(-Math.PI / 2);
  const collar = new THREE.Mesh(collarGeo, mat);
  mount.add(collar, dial);
  g.add(wedge, mount);
  g.traverse((m) => {
    m.castShadow = true;
    m.receiveShadow = true;
  });
  return g;
}
