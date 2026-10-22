// G-04 IR night light for works3d.ts, plus the lamp shell (base, light pipe, WS2812 x 8, opal shade) it shares with the knob lamp.
// The VS1838B sits behind an IR window where the lamp's knob was; a 21-key NEC remote (86 x 40 x 7 mm) lies on the desk, units cm.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { t } from '../i18n';
import type { WorkFrame } from './works3d';
import { IR_KEYS, irCode } from './irfeed';

export const STRIP_PIN = 5;

/** LED colour -> emissive colour (normalised to the max channel; brightness handled separately) */
function glow(c: number[] | undefined) {
  const m = c ? Math.max(...c) : 0;
  return { m, col: new THREE.Color(m ? c![0] / m : 0, m ? c![1] / m : 0, m ? c![2] / m : 0) };
}

export interface LampCtx {
  scene: THREE.Scene;
  shellMat(color: string): THREE.Material;
  occluders: THREE.Object3D[];
  tag(text: string, cls?: string): HTMLElement;
  tagList: { el: HTMLElement; at: () => THREE.Vector3; dx?: number; dy?: number }[];
  effects(): { glare?: boolean; irBlock?: boolean };
}

/** Base 8 x 6 x 3.6 cm, light pipe with 8 LEDs stacked in front, opal shade lathe; returns the per-frame strip painter */
export function buildLampShell(c: LampCtx) {
  const base = new THREE.Mesh(new RoundedBoxGeometry(8, 3.6, 6, 5, 0.6), c.shellMat('#3A3936'));
  base.position.y = 1.8;
  base.castShadow = base.receiveShadow = true;
  c.scene.add(base);
  c.occluders.push(base);
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 5.6, 32), new THREE.MeshPhysicalMaterial({ color: '#F2F0EA', roughness: 0.25, transmission: 0.3, thickness: 0.4 }));
  pipe.position.set(0, 3.6 + 2.8, 0);
  c.scene.add(pipe);
  const leds: THREE.MeshStandardMaterial[] = [];
  for (let i = 0; i < 8; i++) {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.15), new THREE.MeshStandardMaterial({ color: '#F2F0EA', roughness: 0.6 }));
    frame.position.set(0, 4.0 + i * 0.62, 0.62);
    c.scene.add(frame);
    const m = new THREE.MeshStandardMaterial({ color: '#DEDBD2', emissive: '#000000', emissiveIntensity: 1, roughness: 0.3 });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.19, 20), m);
    lens.position.set(0, 4.0 + i * 0.62, 0.7);
    c.scene.add(lens);
    leds.push(m);
  }
  // Shade: milky PLA bell lathe (base Ø7.0, height 7.6), translucent
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    prof.push(new THREE.Vector2(3.5 - 1.6 * Math.pow(t, 1.6) - (t > 0.92 ? (t - 0.92) * 18 : 0), 3.7 + t * 7.6));
  }
  const shadeMat = new THREE.MeshPhysicalMaterial({ color: '#F4F1EA', roughness: 0.65, transmission: 0.55, thickness: 0.3, transparent: true, opacity: 0.88, emissive: '#000000', emissiveIntensity: 1, side: THREE.DoubleSide });
  const shade = new THREE.Mesh(new THREE.LatheGeometry(prof, 72), shadeMat);
  shade.castShadow = true;
  c.scene.add(shade);
  const shadeLight = new THREE.PointLight('#FFFFFF', 0, 40, 1.6);
  shadeLight.position.set(0, 6.5, 0);
  c.scene.add(shadeLight);
  // Assembly B: strip against the shade wall gives a row of 8 hot spots on the front
  const spotMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 8; i++) {
    const y = 4.4 + i * 0.75;
    const t = (y - 3.7) / 7.6;
    const r = 3.5 - 1.6 * Math.pow(t, 1.6) + 0.02;
    // Hot spots on the outer surface, drawn last, brightness > 1 so bloom spreads them (glare)
    const mat = new THREE.MeshBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    const s = new THREE.Mesh(new THREE.CircleGeometry(0.3, 20), mat);
    s.renderOrder = 10;
    s.position.set(0, y, r + 0.03);
    c.scene.add(s);
    spotMats.push(mat);
  }
  c.tagList.push({ el: c.tag(t('WS2812 × 8 · milky shade')), at: () => new THREE.Vector3(-3.6, 9.5, 0), dx: -50 });
  const avg = new THREE.Color();
  return (f: WorkFrame) => {
    const strip = (f.running ? f.strips?.[STRIP_PIN] : undefined) ?? [];
    const glare = !!c.effects().glare;
    let peak = 0;
    const sum = [0, 0, 0];
    leds.forEach((m, i) => {
      const col = strip[i];
      const g = glow(col);
      peak = Math.max(peak, g.m);
      if (col) col.forEach((v, k) => (sum[k] += v));
      m.emissive.copy(g.col);
      // Firmware writes real 0–255 brightness: map it to emissive intensity (no blanket boost like the onboard LED) so dimming shows
      m.emissiveIntensity = g.m ? 1.5 + (g.m / 255) * 8 : 0;
      spotMats[i].color.copy(g.col).lerp(new THREE.Color('#FFFFFF'), 0.5).multiplyScalar(1.6 + (g.m / 255) * 2);
      spotMats[i].opacity = glare && g.m ? 1 : 0;
    });
    const sm = Math.max(...sum);
    avg.setRGB(sm ? sum[0] / sm : 0, sm ? sum[1] / sm : 0, sm ? sum[2] / sm : 0);
    const k = peak / 255;
    // Shade lit from inside: emissive (diffused colour) + point light on the desk; hot-spot assembly makes the shade darker and uneven
    shadeMat.emissive.copy(avg);
    shadeMat.emissiveIntensity = peak ? (glare ? 0.08 + k * 0.3 : 0.3 + k * 1.4) : 0;
    shadeLight.color.copy(avg);
    shadeLight.intensity = k * 110;
  };
}

export interface IrlampCtx extends LampCtx {
  hits: THREE.Object3D[];
  /** A remote key pressed (NEC command byte); returns the release. Not called while the receiver sits behind the opaque wall */
  onKey?(cmd: number): (() => void) | void;
}

/** Remote face texture: 400 x 860 px for 4.0 x 8.6 cm, 3 x 7 keys at 1.2 / 1.0 cm pitch below a 1.5 cm head */
const PX = 100;
const keyXY = (i: number) => [80 + (i % 3) * 120, 150 + Math.floor(i / 3) * 100 + 50] as const;

function remoteFace() {
  const cv = document.createElement('canvas');
  cv.width = 400;
  cv.height = 860;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#F2F0EA';
  g.fillRect(0, 0, 400, 860);
  g.fillStyle = '#2A2C30';
  g.fillRect(150, 40, 100, 50);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  IR_KEYS.forEach(([label], i) => {
    const [x, y] = keyXY(i);
    // Top row (power / mode) red, digits light grey, like the common "Car MP3" membrane remote
    g.fillStyle = i < 3 ? '#E5484D' : i < 9 ? '#3B82F6' : '#D9D6CE';
    g.beginPath();
    g.roundRect(x - 48, y - 40, 96, 80, 18);
    g.fill();
    g.fillStyle = i < 9 ? '#FFFFFF' : '#1B1D21';
    g.font = `700 ${label.length > 3 ? 26 : 34}px system-ui, sans-serif`;
    g.fillText(label, x, y + 2);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function buildIrlamp(c: IrlampCtx) {
  const paint = buildLampShell(c);
  // IR window 12 x 8 mm of dark IR-pass acrylic in the base front, where the knob lamp has its knob
  const WX = 2.3, WY = 1.8, FRONT = 3;
  const win = new THREE.Mesh(new RoundedBoxGeometry(1.2, 0.8, 0.06, 2, 0.02), new THREE.MeshPhysicalMaterial({ color: '#3A1418', roughness: 0.15, transparent: true, opacity: 0.55 }));
  win.position.set(WX, WY, FRONT + 0.01);
  c.scene.add(win);
  // VS1838B: 6 x 7 mm body with a 5 mm dome; A sits in the window, B is 15 mm back inside the opaque base
  const rx = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.45), new THREE.MeshStandardMaterial({ color: '#141416', roughness: 0.4 }));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.25, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#1E1E22', roughness: 0.2 }));
  dome.rotation.x = Math.PI / 2;
  dome.position.z = 0.22;
  rx.add(body, dome);
  c.scene.add(rx);
  const blockMat = new THREE.MeshStandardMaterial({ color: '#3A3936', roughness: 0.55 });
  const plug = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.6, 0.04), blockMat);
  plug.position.set(WX, WY, FRONT + 0.05);
  c.scene.add(plug);

  // Remote 4.0 x 0.7 x 8.6 cm on the desk, front right, its IR LED end pointing at the lamp
  const remote = new THREE.Group();
  remote.position.set(8.5, 0, 6.5);
  remote.rotation.y = Math.atan2(8.5 - WX, 6.5 - FRONT);
  c.scene.add(remote);
  const shell = new THREE.Mesh(new RoundedBoxGeometry(4.0, 0.7, 8.6, 3, 0.3), c.shellMat('#F2F0EA'));
  shell.position.y = 0.35;
  shell.castShadow = shell.receiveShadow = true;
  remote.add(shell);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 8.6), new THREE.MeshStandardMaterial({ map: remoteFace(), roughness: 0.5 }));
  face.rotation.x = -Math.PI / 2;
  face.position.y = 0.705;
  remote.add(face);
  const toLocal = (px: number, py: number) => new THREE.Vector3(px / PX - 2.0, 0.72, py / PX - 4.3);
  const keyHits: THREE.Mesh[] = [];
  const hitGeo = new THREE.BoxGeometry(0.96, 0.3, 0.8);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  IR_KEYS.forEach((_, i) => {
    const h = new THREE.Mesh(hitGeo, hitMat);
    h.position.copy(toLocal(...keyXY(i)));
    remote.add(h);
    c.hits.push(h);
    keyHits.push(h);
  });
  const glowMat = new THREE.MeshBasicMaterial({ color: '#FF7A1A', transparent: true, opacity: 0, depthWrite: false });
  const press = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.8), glowMat);
  press.rotation.x = -Math.PI / 2;
  remote.add(press);
  // IR flash from the remote's LED to the window (or the wall in front of a hidden receiver)
  const ledAt = toLocal(200, 20);
  const beamMat = new THREE.MeshBasicMaterial({ color: '#E5484D', transparent: true, opacity: 0, depthWrite: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.25, 1, 12, 1, true), beamMat);
  c.scene.add(beam);
  const placeBeam = () => {
    const a = remote.localToWorld(ledAt.clone());
    const b = new THREE.Vector3(WX, WY, FRONT + 0.05);
    beam.position.copy(a).lerp(b, 0.5);
    beam.scale.set(1, a.distanceTo(b), 1);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  };
  placeBeam();

  const tagRx = c.tag('', 'hot');
  c.tagList.push({ el: tagRx, at: () => new THREE.Vector3(WX, WY - 1.4, FRONT + 0.4), dy: 14 });
  c.tagList.push({ el: c.tag(t('21-key NEC remote · click a key'), 'hot'), at: () => remote.localToWorld(new THREE.Vector3(0, 0.8, 4.6)), dy: 14 });

  let lastKey = '';
  let flash = 0;
  let release: (() => void) | void;
  const onDown = (hit: THREE.Object3D) => {
    const i = keyHits.indexOf(hit as THREE.Mesh);
    if (i < 0) return false;
    lastKey = irCode(IR_KEYS[i][1]);
    press.position.copy(keyHits[i].position).setY(0.71);
    flash = 1;
    if (!c.effects().irBlock) release = c.onKey?.(IR_KEYS[i][1]);
    return true;
  };
  const onUp = () => {
    release?.();
    release = undefined;
  };
  const tick = (f: WorkFrame, dt: number) => {
    paint(f);
    const blocked = !!c.effects().irBlock;
    rx.position.set(blocked ? WX - 1.2 : WX, WY, blocked ? FRONT - 1.5 : FRONT - 0.42);
    plug.visible = blocked;
    tagRx.textContent = blocked ? t('Receiver behind the opaque wall: remote codes never reach it') : t('VS1838B behind the IR window');
    flash = Math.max(0, flash - dt * 4);
    glowMat.opacity = flash * 0.7;
    beamMat.opacity = flash * 0.45;
  };
  // Key "3" (blue) is the test handle
  return { tick, onDown, onUp, handle: keyHits[IR_KEYS.findIndex(([l]) => l === '3')], key: () => lastKey };
}
