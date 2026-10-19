// Shared helpers for the 3D bench: units, materials, textures, shapes, pin pick boxes.

import * as THREE from 'three';
import type { ExtName } from '../extmodels';

// Units: millimetres
export const PITCH = 2.54;

/** External model slot (P1-09): procedural proc parts are the default; with external models on they hide, the glb mounts and fit places it.
 *  fit(null) restores the procedural version (e.g. moves back a diaphragm shifted for the external model). */
export interface ExtSlot {
  root: THREE.Object3D;
  name: ExtName;
  proc: THREE.Object3D[];
  fit(m: THREE.Group | null): void;
  model?: THREE.Group | null;
}

/** Dupont wire colour convention (DESIGN §4): red power, black ground, yellow SCL, green SDA, orange signal */
export const WIRE = { vcc: 0xd8342a, gnd: 0x26282c, scl: 0xf2c230, sda: 0x2fa84f, sig: 0xf28c28 };
export const ACCENT = 0x0d99ff;
export const BAD = 0xf24822;

// ---------------------------------------------------------------- materials and textures

/** Shared materials: not freed on scene rebuild (disposeTree skips userData.shared) */
export function shared<T extends THREE.Material>(m: T): T {
  m.userData.shared = true;
  return m;
}
export const MAT = {
  gold: shared(new THREE.MeshStandardMaterial({ color: 0xe6c36a, metalness: 1, roughness: 0.22 })),
  tin: shared(new THREE.MeshStandardMaterial({ color: 0xd9dce0, metalness: 1, roughness: 0.28 })),
  steel: shared(new THREE.MeshStandardMaterial({ color: 0xcdd1d6, metalness: 1, roughness: 0.3 })),
  plastic: shared(new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.62 })),
  plug: shared(new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.5 })),
  chip: shared(new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.45 })),
  hit: shared(new THREE.MeshBasicMaterial({ visible: false })),
};

export function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mt of mats) {
      if (mt.userData.shared) continue;
      for (const v of Object.values(mt)) if (v instanceof THREE.Texture) v.dispose();
      mt.dispose();
    }
  });
}

export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, aniso = 8) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

/** Horizontal plane at height y with UVs from (x, z): texture top points along uvTop, so silkscreen can be drawn in real orientation */
export function topPlane(x0: number, x1: number, z0: number, z1: number, y: number, uvOf: (x: number, z: number) => [number, number]) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, ...uvOf(pos.getX(i), pos.getZ(i)));
  return g;
}

/** Rounded rectangle (centred at origin) */
export function roundRect(w: number, h: number, r: number): THREE.Shape;
export function roundRect<P extends THREE.Path>(w: number, h: number, r: number, path: P): P;
export function roundRect(w: number, h: number, r: number, path: THREE.Path = new THREE.Shape()): THREE.Path {
  const x = -w / 2, y = -h / 2;
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r);
  path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
  return path;
}

/** Module PCB with mounting holes (upright, front faces +z): ExtrudeGeometry with silkscreen on the front. Origin at the bottom-edge centre. */
export function modulePcb(W: number, H: number, T: number, holes: [number, number, number][], tex: THREE.Texture, side: number) {
  const s = roundRect(W, H, 0.8);
  for (const [x, y, r] of holes) {
    const p = new THREE.Path();
    p.absarc(x, y, r, 0, Math.PI * 2, true);
    s.holes.push(p);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: T, bevelEnabled: false, curveSegments: 16 });
  g.translate(0, H / 2, -T / 2);
  // Face UVs are in mm; texture repeat / offset maps them to 0..1
  tex.repeat.set(1 / W, 1 / H);
  tex.offset.set(0.5, 0.5 - 0);
  const front = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.05 });
  const edge = new THREE.MeshStandardMaterial({ color: side, roughness: 0.6 });
  const m = new THREE.Mesh(g, [front, edge]);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Soft contact shadow: a blurred black rounded rectangle on the desk, far cheaper than realtime AO */
export function contactShadow(w: number, d: number, opacity = 0.35) {
  const pad = 14;
  const tex = canvasTexture(256, 256, (g) => {
    // alphaMap reads the green channel: white shape on black
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    g.filter = 'blur(18px)';
    g.fillStyle = '#fff';
    const sx = 256 / (w + 2 * pad), sz = 256 / (d + 2 * pad);
    g.beginPath();
    g.roundRect(pad * sx, pad * sz, w * sx, d * sz, 12);
    g.fill();
  });
  tex.colorSpace = THREE.NoColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 2 * pad, d + 2 * pad),
    new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: tex, transparent: true, opacity, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.05;
  m.renderOrder = -1;
  return m;
}

// ---------------------------------------------------------------- devboard

export interface PinRec {
  /** scene-api id: 'GPIO4' / 'GND' / 'bme280:SDA' */
  id: string;
  /** Silkscreen text */
  label: string;
  /** Anchor for highlight ring, tag and ruler (parent-local coordinates) */
  anchor: THREE.Vector3;
  parent: THREE.Object3D;
  /** Devboard pins only: internal name ('IO4'), used to find where the pin enters the breadboard */
  name?: string;
}

/** Pick boxes for a group of pins (invisible, a bit larger than the pin for easy clicking); one InstancedMesh per group */
export function pinHits(parent: THREE.Object3D, recs: PinRec[], centers: THREE.Vector3[], size: [number, number, number], out: PinRec[]) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(...size), MAT.hit, recs.length);
  const m = new THREE.Matrix4();
  centers.forEach((c, i) => mesh.setMatrixAt(i, m.makeTranslation(c.x, c.y, c.z)));
  mesh.userData.pinIds = recs.map((r) => r.id);
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
  parent.add(mesh);
  out.push(...recs);
}
