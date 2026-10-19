// Step 4 product (usbkey, P2-12): an 80×44×22 mm USB keypad (same as enclosure.ts usbkey) cabled to usb3d.ts's laptop.
// Keycaps ground GPIO4–7 (K1–K4); laptop text is decoded from real HID reports of the live sim, not an animation. Units: mm.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { currentTheme, onTheme, type Theme } from '../theme';
import { createUsbHost, type UsbView } from '../usb3d';
import { capturableOf, type Capturable } from './capture';
import { KEYPAD_CAPS, KEYPAD_PINS } from '../views/keypad';
import { t } from '../i18n';
import { shaderWarm } from '../shaderwarm';

export interface Keypad3DOptions {
  press(pin: number, down: boolean): void;
}

export interface Keypad3D {
  start(): void;
  stop(): void;
  dispose(): void;
  resetView(): void;
  azimuth(): number;
  /** Page position (clientX/Y) of keycap i, so tests can press it with a real mouse. */
  keyScreenPos(i: number): [number, number] | null;
  /** What the virtual host sees (null = no device / cable unplugged). */
  setUsb(v: UsbView | null): void;
  /** USB port mounted backwards during assembly: the cable can't go in. */
  setBlocked(b: boolean): void;
  capture(): Capturable;
}

const W = 80, D = 44, H = 22, KEYCAP = 14, PITCH = 19.05;

function capTexture(label: string, accent: boolean) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = accent ? '#0D99FF' : '#F2EFE8';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = accent ? '#FFFFFF' : '#1E1E1E';
  g.font = '700 64px "JetBrains Mono", Menlo, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createKeypad3D(container: HTMLElement, o: Keypad3DOptions): Keypad3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.setAttribute('aria-label', t('3D product: a USB keypad connected to a virtual computer; click the keycaps to type'));

  const scene = new THREE.Scene();
  const BG = { light: '#EEF1F5', dark: '#1D2024' }, DESK = { light: '#E4E8EE', dark: '#2A2D32' };
  const bg = new THREE.Color(BG[currentTheme()]);
  scene.background = bg;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  const sun = new THREE.DirectionalLight('#FFFFFF', 1.8);
  sun.position.set(-80, 220, 140);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -220, right: 160, top: 160, bottom: -160, near: 10, far: 600 });
  sun.shadow.bias = -0.0004;
  scene.add(sun, new THREE.HemisphereLight('#FFFFFF', '#C9CED6', 0.5));

  const deskMat = new THREE.MeshStandardMaterial({ color: DESK[currentTheme()], roughness: 0.9 });
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), deskMat);
  desk.rotation.x = -Math.PI / 2;
  desk.receiveShadow = true;
  scene.add(desk);
  const applyTheme = (t: Theme) => {
    bg.set(BG[t]);
    deskMat.color.set(DESK[t]);
  };
  const offTheme = onTheme(applyTheme);

  // Keypad: base shell + plate + 4 keycaps (long side along x, USB port at the left end).
  const pad = new THREE.Group();
  scene.add(pad);
  const shellMat = new THREE.MeshPhysicalMaterial({ color: '#ECE9E2', roughness: 0.55, clearcoat: 0.2 });
  const shell = new THREE.Mesh(new RoundedBoxGeometry(W, H - 2, D, 3, 4), shellMat);
  shell.position.y = (H - 2) / 2;
  shell.castShadow = shell.receiveShadow = true;
  pad.add(shell);
  const plate = new THREE.Mesh(new RoundedBoxGeometry(W - 1, 2.2, D - 1, 2, 1), new THREE.MeshPhysicalMaterial({ color: '#F2EFE8', roughness: 0.5 }));
  plate.position.y = H - 1.1;
  plate.receiveShadow = true;
  pad.add(plate);
  // USB-C cutout (left end) exposing the board's port.
  const hole = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 10), new THREE.MeshStandardMaterial({ color: '#2A2D33', roughness: 0.6 }));
  hole.position.set(-W / 2 - 0.2, 8, -8);
  pad.add(hole);
  const caps: { mesh: THREE.Mesh; pin: number; y0: number; down: boolean }[] = [];
  KEYPAD_CAPS.forEach((label, i) => {
    const accent = label === 'M';
    const side = new THREE.MeshStandardMaterial({ color: accent ? '#0D99FF' : '#F2EFE8', roughness: 0.5 });
    const top = new THREE.MeshStandardMaterial({ map: capTexture(label, accent), roughness: 0.5 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(KEYCAP, 7, KEYCAP), [side, side, top, side, side, side]);
    m.position.set((i - 1.5) * PITCH, H + 2.4, 4);
    m.castShadow = true;
    m.userData.pin = KEYPAD_PINS[i];
    pad.add(m);
    caps.push({ mesh: m, pin: KEYPAD_PINS[i], y0: m.position.y, down: false });
  });
  // Silkscreen: K1–K4 and GPIO.
  const silk = document.createElement('canvas');
  silk.width = 1024;
  silk.height = 96;
  const sg = silk.getContext('2d')!;
  sg.fillStyle = '#8C8C8C';
  sg.font = '500 40px "JetBrains Mono", Menlo, monospace';
  sg.textAlign = 'center';
  KEYPAD_PINS.forEach((p, i) => sg.fillText(`K${i + 1} · IO${p}`, 512 + (i - 1.5) * 244, 60));
  const silkTex = new THREE.CanvasTexture(silk);
  silkTex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(new THREE.PlaneGeometry(W, 7.5), new THREE.MeshBasicMaterial({ map: silkTex, transparent: true }));
  label.rotation.x = -Math.PI / 2;
  label.position.set(0, H + 0.02, -13);
  pad.add(label);

  // Virtual computer + USB cable leaving the keypad's left cutout.
  const port = new THREE.Vector3(-W / 2 - 1, 8, -8);
  let host: ReturnType<typeof createUsbHost> | null = createUsbHost(scene, port);
  let blocked = false;
  let lastView: UsbView | null = null;
  // Backwards: the plug hangs outside the cutout and the screen stays empty.
  const tag = document.createElement('div');
  tag.className = 'p3-tag bad';
  tag.textContent = t('The USB port is mounted backwards: the cable won\'t go in and the computer sees no device.');
  tag.hidden = true;
  const corner = document.createElement('div');
  corner.className = 'p3-disclaimer';
  corner.textContent = t('Illustrative look, not an official Espressif model');
  container.append(tag, corner);

  const camera = new THREE.PerspectiveCamera(32, 1, 1, 8000);
  // Camera: laptop back-left, keypad front-right, framed between the side panels (about 280 / 315 px at 1440 wide).
  const HOME = new THREE.Vector3(-62, 215, 560);
  const TARGET = new THREE.Vector3(-66, 22, -12);
  camera.position.copy(HOME);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(TARGET);
  controls.enableDamping = true;
  controls.minDistance = 80;
  controls.maxDistance = 700;
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
    camera.fov = w / h < 1 ? 46 : 32;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // Holding a keycap grounds its pin.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let held: (typeof caps)[number] | null = null;
  const el = renderer.domElement;
  const pickCap = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(caps.map((c) => c.mesh))[0];
    return hit ? caps.find((c) => c.mesh === hit.object) ?? null : null;
  };
  const up = () => {
    if (!held) return;
    held.down = false;
    o.press(held.pin, false);
    held = null;
    controls.enabled = true;
  };
  el.addEventListener('pointerdown', (ev) => {
    const c = pickCap(ev);
    if (!c) return;
    controls.enabled = false;
    held = c;
    c.down = true;
    o.press(c.pin, true);
  });
  window.addEventListener('pointerup', up);
  el.addEventListener('pointermove', (ev) => {
    if (!ev.buttons) el.style.cursor = pickCap(ev) ? 'pointer' : 'grab';
  });

  const v = new THREE.Vector3();
  let raf = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    for (const c of caps) c.mesh.position.y += ((c.down ? c.y0 - 2 : c.y0) - c.mesh.position.y) * 0.5;
    controls.update();
    if (!sw.warming()) composer.render();
    if (!tag.hidden) {
      v.copy(port).add(new THREE.Vector3(0, 26, 0)).project(camera);
      tag.style.left = `${((v.x + 1) / 2) * container.clientWidth}px`;
      tag.style.top = `${((1 - v.y) / 2) * container.clientHeight}px`;
    }
  }

  return {
    start() {
      if (!raf) raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      up();
    },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      offTheme();
      ro.disconnect();
      window.removeEventListener('pointerup', up);
      host?.dispose();
      controls.dispose();
      composer.dispose();
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
    keyScreenPos(i) {
      const c = caps[i];
      if (!c) return null;
      c.mesh.getWorldPosition(v).project(camera);
      if (v.z > 1) return null;
      const r = el.getBoundingClientRect();
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    },
    setUsb(view) {
      lastView = view;
      host?.update(blocked ? null : view);
    },
    setBlocked(b) {
      if (b === blocked) return;
      blocked = b;
      tag.hidden = !b;
      // Backwards: redraw an unplugged cable, plug 30 mm from the cutout.
      host?.dispose();
      host = createUsbHost(scene, b ? port.clone().add(new THREE.Vector3(-30, -6, 14)) : port);
      host.update(b ? null : lastView);
    },
    capture: () => capturableOf(renderer, scene, composer),
  };
}
