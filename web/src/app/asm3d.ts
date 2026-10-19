// (3) 3D assembly (P1-07): parametric case (enclosure.ts), parts snap to the next slot; wrong spots allowed (effects per templates.ts),
// wrong order blocked; rules shared with views/asmcore.ts. Tools: explode, section, ruler; a BVH makes drops / picks hit the mesh.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { createAsmCore } from '../views/asmcore';
import type { Template } from '../views/templates';
import type { CaseLayout, CaseMeshes, MeshData, Pose, Prim, V3 } from './enclosure';
import { currentTheme, onTheme, type Theme } from '../theme';
import { btnClass } from '../ui/panel';
import { t } from '../i18n';
import { shaderWarm } from '../shaderwarm';
import { onFrame, PRIO } from '../ui/frame';

export interface Asm3DOptions {
  template: Template;
  layout: CaseLayout;
  meshes: CaseMeshes;
  /** Placed / rejected / choosing: the shell redraws its panel and logs the timeline */
  onStep(): void;
}

const BG = { light: '#EEF1F5', dark: '#1D2024' };
const DESK = { light: '#E4E8EE', dark: '#2A2D32' };
const ORANGE = '#FF7A1A';
/** Horizontal distance (mm) from a slot centre within which a part snaps */
const SNAP = 16;
const EXPLODE = 16;

export function createAssembly3D(container: HTMLElement, o: Asm3DOptions) {
  const T = o.template;
  const L = o.layout;
  const P = T.parts;
  const core = createAsmCore(T);
  const st = core.st;
  const layerOf = (id: string) => P.findIndex((p) => p.id === id);
  const positional = (id: string) => !!core.byId[id].spots?.every((s) => s.at);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.setAttribute('aria-label', t('3D assembly: drag parts into the case'));

  const scene = new THREE.Scene();
  const bg = new THREE.Color(BG[currentTheme()]);
  scene.background = bg;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  const sun = new THREE.DirectionalLight('#FFFFFF', 1.6);
  sun.position.set(-60, 160, 90);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 10, far: 400 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, new THREE.HemisphereLight('#FFFFFF', '#C9CED6', 0.45));
  const desk = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.MeshStandardMaterial({ color: DESK[currentTheme()], roughness: 0.92 }));
  desk.rotation.x = -Math.PI / 2;
  desk.position.y = -0.05;
  desk.receiveShadow = true;
  scene.add(desk);
  const grid = new THREE.GridHelper(300, 30, '#C9CED6', '#D6DAE0');
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.5;
  scene.add(grid);
  const applyTheme = (t: Theme) => {
    bg.set(BG[t]);
    (desk.material as THREE.MeshStandardMaterial).color.set(DESK[t]);
  };
  const offTheme = onTheme(applyTheme);

  // Case coords are z up, y toward the product's top: rotate -90° about x so the top faces away from the camera
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  scene.add(world);
  world.updateMatrixWorld();
  const toWorld = (v: V3) => new THREE.Vector3(...v).applyMatrix4(world.matrixWorld);

  const [OW, OD, OH] = L.outer;
  const topZ = Math.max(OH, ...Object.values(L.slots).flatMap((s) => Object.values(s).map((p) => p.max[2])));
  const size = Math.max(OW, OD, topZ);
  /** Tray: parts laid out by scaled width (longest side 26 mm), 7 mm apart, centred */
  const TRAY_MAX = 26, TRAY_GAP = 7;
  const tray = (() => {
    const ids = T.tray.filter((id) => L.slots[id]);
    const items = ids.map((id) => {
      const ps = Object.values(L.slots[id])[0];
      const ext = [ps.max[0] - ps.min[0], ps.max[1] - ps.min[1], ps.max[2] - ps.min[2]];
      const scale = Math.min(1, TRAY_MAX / Math.max(...ext));
      return { id, scale, w: ext[0] * scale };
    });
    const total = items.reduce((a, x) => a + x.w, 0) + TRAY_GAP * (items.length - 1);
    let x = -total / 2;
    const at: Record<string, { x: number; scale: number }> = {};
    for (const it of items) {
      at[it.id] = { x: x + it.w / 2, scale: it.scale };
      x += it.w + TRAY_GAP;
    }
    return { ids, at, total };
  })();
  function trayWidth() {
    return Math.max(OW * 1.4, tray.total);
  }

  const camera = new THREE.PerspectiveCamera(34, 1, 1, 3000);
  const sw = shaderWarm(renderer, scene, camera);
  const target = toWorld([0, OD * 0.18, topZ * 0.4]);
  // Tray + case must fit between the side panels: back the camera off by size
  const home = target.clone().add(new THREE.Vector3(0.32, 0.78, 1).normalize().multiplyScalar(Math.max(size, trayWidth() * 0.62) * 3.9));
  camera.position.copy(home);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.enablePan = false;
  controls.minDistance = size * 1.2;
  controls.maxDistance = size * 12;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.update();

  // ---------------------------------------------------------------- Section: clip case y below half the cut plane (near the camera)
  const cutY = 0;
  const clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), toWorld([0, cutY, 0]).z);
  let sectionOn = false;
  const clipList: THREE.Plane[] = [];

  function caseGeometry(d: MeshData) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
    g.setIndex(new THREE.BufferAttribute(d.idx, 1));
    const flat = g.toNonIndexed();
    flat.computeVertexNormals();
    flat.boundsTree = new MeshBVH(flat);
    g.dispose();
    return flat;
  }
  function caseObject(d: MeshData, color: string, opacity = 1) {
    const geo = caseGeometry(d);
    const mat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.55, clearcoat: 0.2, clippingPlanes: clipList, transparent: opacity < 1, opacity, side: THREE.FrontSide });
    // Cut face: back faces only, orange. Looking into a cut wall you see back faces, so it reads as a solid section
    const cap = new THREE.MeshBasicMaterial({ color: ORANGE, side: THREE.BackSide, clippingPlanes: clipList });
    const g = new THREE.Group();
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = m.receiveShadow = true;
    m.raycast = acceleratedRaycast;
    g.add(m, new THREE.Mesh(geo, cap));
    return { group: g, mesh: m };
  }
  const caseColor = T.id === 'spin' ? '#3A3936' : '#ECE9E2';
  const lidColor = T.id === 'spin' ? '#FFC933' : T.id === 'lens' ? '#D6D1C6' : '#F2EFE8';
  const bottomObj = caseObject(o.meshes.bottom, caseColor);
  const lidObj = caseObject(o.meshes.lid, lidColor);

  // ---------------------------------------------------------------- Parts
  const mats = new Map<string, THREE.Material>();
  const matOf = (p: Prim) => {
    const key = p.color + (p.emissive ? '!' : '') + p.shape;
    let m = mats.get(key);
    if (!m) {
      m = p.shape === 'cap' || (T.id === 'lens' && p.color === '#BFD3E6')
        ? new THREE.MeshPhysicalMaterial({ color: p.color, roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.55, thickness: 2 })
        : new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.55, metalness: p.color === '#BDB9B0' ? 0.6 : 0.05, emissive: p.emissive ? p.color : '#000000', emissiveIntensity: p.emissive ? 1.2 : 0 });
      mats.set(key, m);
    }
    return m;
  };
  function primMesh(p: Prim) {
    let g: THREE.BufferGeometry;
    const m = new THREE.Mesh();
    if (p.shape === 'box') g = new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]);
    else if (p.shape === 'cyl') {
      g = new THREE.CylinderGeometry(p.size[0] / 2, p.size[0] / 2, p.size[2], 40);
      if (p.axis !== 'y') m.rotation.x = Math.PI / 2;
    } else if (p.shape === 'torus') g = new THREE.TorusGeometry(p.size[0] / 2, p.size[1] / 2, 12, 40, Math.PI * 1.6);
    else {
      // Spherical cap: base diameter size[0], height size[2]
      const r = p.size[0] / 2, h = p.size[2];
      const R = (r * r + h * h) / (2 * h);
      g = new THREE.SphereGeometry(R, 48, 12, 0, Math.PI * 2, 0, Math.acos((R - h) / R));
      g.translate(0, -(R - h), 0);
      g.translate(0, -h / 2, 0);
      m.rotation.x = Math.PI / 2;
    }
    m.geometry = g;
    m.material = matOf(p);
    m.position.set(...p.at);
    if (p.rotZ) m.rotation.z = (p.rotZ * Math.PI) / 180;
    m.castShadow = true;
    return m;
  }

  interface PartObj {
    id: string;
    /** Slot currently drawn (position depends on the assembly choice) */
    key: string;
    root: THREE.Group;
    body: THREE.Group;
    hit: THREE.Mesh;
    /** Scale and position in the tray (case coords) */
    trayAt: THREE.Vector3;
    trayScale: number;
    cur: { pos: THREE.Vector3; scale: number };
  }
  const slotKeys = (id: string) => Object.keys(L.slots[id] ?? { '': null });
  const poseOf = (id: string, key?: string): Pose => {
    const s = L.slots[id];
    return s[key ?? ''] ?? s[slotKeys(id)[0]];
  };
  const objs: Record<string, PartObj> = {};
  const unplacedTray = tray.ids;
  function buildPart(id: string, key: string) {
    const pose = poseOf(id, key);
    const body = new THREE.Group();
    if (pose.mesh === 'bottom') body.add(bottomObj.group);
    else if (pose.mesh === 'lid') body.add(lidObj.group);
    else for (const p of pose.prims) body.add(primMesh(p));
    // Parts are centred on their slot: root = slot centre (placed) or tray position (loose)
    body.position.set(-pose.center[0], -pose.center[1], -pose.center[2]);
    const ext = new THREE.Vector3(pose.max[0] - pose.min[0], pose.max[1] - pose.min[1], pose.max[2] - pose.min[2]);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(Math.max(ext.x, 8) + 4, Math.max(ext.y, 8) + 4, Math.max(ext.z, 6) + 4), new THREE.MeshBasicMaterial({ visible: false }));
    hit.userData.part = id;
    const root = new THREE.Group();
    root.add(body, hit);
    world.add(root);
    return { body, hit, root, ext };
  }
  unplacedTray.forEach((id) => {
    const key = slotKeys(id)[0];
    const b = buildPart(id, key);
    // Tray is a row behind and above the case (above it on screen) so the side panels don't hide it
    const trayAt = new THREE.Vector3(tray.at[id].x, OD / 2 + 30, topZ * 0.5 + 16);
    const trayScale = tray.at[id].scale;
    objs[id] = { id, key, root: b.root, body: b.body, hit: b.hit, trayAt, trayScale, cur: { pos: trayAt.clone(), scale: trayScale } };
  });

  // ---------------------------------------------------------------- Slots (next one glows)
  const ghostMat = new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.16, depthWrite: false });
  const ghostLine = new THREE.LineBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.95 });
  const ghosts: { id: string; key: string; g: THREE.Group; center: V3 }[] = [];
  for (const id of P.map((p) => p.id)) {
    if (!L.slots[id]) continue;
    const keys = positional(id) ? slotKeys(id) : [slotKeys(id)[0]];
    for (const key of keys) {
      const ps = poseOf(id, key);
      const ext: V3 = [ps.max[0] - ps.min[0] + 1, ps.max[1] - ps.min[1] + 1, ps.max[2] - ps.min[2] + 1];
      // Round cases use a cylindrical ghost for base / rim
      const box = ps.mesh && L.shape === 'round' ? new THREE.CylinderGeometry(ext[0] / 2, ext[0] / 2, ext[2], 48, 1).rotateX(Math.PI / 2) : new THREE.BoxGeometry(...ext);
      const g = new THREE.Group();
      g.add(new THREE.Mesh(box, ghostMat), new THREE.LineSegments(new THREE.EdgesGeometry(box), ghostLine));
      g.position.set(...ps.center);
      g.visible = false;
      world.add(g);
      ghosts.push({ id, key, g, center: ps.center });
    }
  }

  // ---------------------------------------------------------------- HTML overlay: slot labels, chooser buttons, ruler readouts
  const overlay = document.createElement('div');
  overlay.className = 'a3-tags';
  const corner = document.createElement('div');
  corner.className = 'p3-disclaimer a3-disc';
  corner.textContent = t('Illustrative look, estimated sizes · case {w}×{d}×{h} mm', { w: OW, d: OD, h: OH });
  container.append(overlay, corner);
  const tags = new Map<string, HTMLElement>();
  const tag = (k: string, text: string, cls = '') => {
    let t = tags.get(k);
    if (!t) {
      t = document.createElement('div');
      overlay.appendChild(t);
      tags.set(k, t);
    }
    t.className = 'p3-tag a3-tag ' + cls;
    if (t.textContent !== text) t.textContent = text;
    t.hidden = false;
    return t;
  };
  const chooser = document.createElement('div');
  chooser.className = 'a3-choose';
  chooser.hidden = true;
  container.appendChild(chooser);

  // ---------------------------------------------------------------- Ruler
  let rulerOn = false;
  const rulerG = new THREE.Group();
  scene.add(rulerG);
  const rulerMat = new THREE.LineDashedMaterial({ color: '#F24822', dashSize: 2.5, gapSize: 1.5, depthTest: false });
  const dotMat = new THREE.MeshBasicMaterial({ color: '#F24822', depthTest: false });
  const picks: THREE.Vector3[] = [];
  function rulerLine(a: THREE.Vector3, b: THREE.Vector3) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, rulerMat);
    line.computeLineDistances();
    line.renderOrder = 10;
    rulerG.add(line);
    for (const p of [a, b]) {
      const d = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8), dotMat);
      d.position.copy(p);
      d.renderOrder = 10;
      rulerG.add(d);
    }
  }

  // ---------------------------------------------------------------- State -> view
  let explodeOn = false;
  let explodeT = 0;
  const placedOffset = (id: string) => {
    const L0 = layerOf(id);
    return L0 * EXPLODE * explodeT;
  };
  const drag: { id: string | null; pos: THREE.Vector3; snap: string | null; moved: boolean; start: [number, number] } = { id: null, pos: new THREE.Vector3(), snap: null, moved: false, start: [0, 0] };

  function sync() {
    const next = core.next();
    for (const id of Object.keys(objs)) {
      const ob = objs[id];
      const placed = st.placed.includes(id);
      const key = placed ? st.choice[id] ?? slotKeys(id)[0] : ob.key;
      if (key !== ob.key && L.slots[id][key]) {
        // Assembly choice moved the slot: rebuild the part at the new slot
        world.remove(ob.root);
        const b = buildPart(id, key);
        Object.assign(ob, { key, root: b.root, body: b.body, hit: b.hit });
      }
    }
    for (const g of ghosts) g.g.visible = g.id === next;
    chooser.hidden = !st.choosing;
    if (st.choosing) {
      const p = core.byId[st.choosing];
      const title = document.createElement('b');
      title.textContent = t('How should {part} go in?', { part: t(p.short) });
      const at = st.choosing;
      chooser.replaceChildren(
        title,
        ...p.spots!.map((s) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = btnClass(false, s.ok ? '' : 'warnb');
          b.dataset.k = `pick${s.key}`;
          b.textContent = t(s.label);
          b.onclick = () => place(at, s.key);
          return b;
        }),
      );
    }
  }

  function place(id: string, spot?: string) {
    core.place(id, spot);
    sync();
    o.onStep();
  }

  // ---------------------------------------------------------------- Drag
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const el = renderer.domElement;
  const setRay = (cx: number, cy: number) => {
    const r = el.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  const hits = () => Object.values(objs).filter((x) => !st.placed.includes(x.id)).map((x) => x.hit);
  /** Drag plane: horizontal, 8 mm above the case top */
  const dragPlane = () => new THREE.Plane(new THREE.Vector3(0, 1, 0), -toWorld([0, 0, topZ + 8]).y);
  const toLocal = (v: THREE.Vector3) => world.worldToLocal(v.clone());
  const overCase = (p: THREE.Vector3) => Math.abs(p.x) < OW / 2 + 14 && Math.abs(p.y) < OD / 2 + 14;
  const marker = new THREE.Mesh(new THREE.RingGeometry(2.4, 3.4, 32), new THREE.MeshBasicMaterial({ color: ORANGE, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  marker.renderOrder = 11;
  marker.visible = false;
  scene.add(marker);

  function nearestSlot(id: string, p: THREE.Vector3): { key: string; d: number } | null {
    if (!L.slots[id]) return null;
    let best: { key: string; d: number } | null = null;
    const keys = positional(id) ? slotKeys(id) : [slotKeys(id)[0]];
    for (const k of keys) {
      const c = poseOf(id, k).center;
      const d = Math.hypot(p.x - c[0], p.y - c[1]);
      if (!best || d < best.d) best = { key: k, d };
    }
    return best;
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    setRay(e.clientX, e.clientY);
    if (rulerOn) {
      // Ruler: pick points on the case surface (BVH-accelerated ray)
      const h = ray.intersectObjects([bottomObj.mesh, ...(lidObj.group.parent && isPlacedLid() ? [lidObj.mesh] : [])], false).find((x) => !sectionOn || clip.distanceToPoint(x.point) >= 0);
      if (h) {
        if (picks.length >= 2) picks.length = 0;
        picks.push(h.point.clone());
        drawRuler();
      }
      return;
    }
    const h = ray.intersectObjects(hits(), false)[0];
    if (!h) return;
    const id = h.object.userData.part as string;
    drag.id = id;
    drag.moved = false;
    drag.snap = null;
    drag.start = [e.clientX, e.clientY];
    drag.pos.copy(objs[id].cur.pos);
    controls.enabled = false;
    el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing';
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    setRay(e.clientX, e.clientY);
    if (!drag.id) {
      if (!rulerOn) el.style.cursor = ray.intersectObjects(hits(), false).length ? 'grab' : '';
      return;
    }
    if (Math.hypot(e.clientX - drag.start[0], e.clientY - drag.start[1]) > 6) drag.moved = true;
    if (!drag.moved) return;
    const w = new THREE.Vector3();
    if (!ray.ray.intersectPlane(dragPlane(), w)) return;
    const p = toLocal(w);
    drag.pos.copy(p);
    drag.snap = null;
    marker.visible = false;
    const id = drag.id;
    if (id === core.next()) {
      const n = nearestSlot(id, p);
      if (n && n.d < SNAP) drag.snap = n.key;
    }
    // Drop point: ray against the case mesh (BVH)
    const hit = st.placed.length ? ray.intersectObject(bottomObj.mesh, false)[0] : undefined;
    if (hit && overCase(p)) {
      marker.position.copy(hit.point).add(new THREE.Vector3(0, 0.3, 0));
      marker.lookAt(hit.point.clone().add(hit.face!.normal.clone().transformDirection(bottomObj.mesh.matrixWorld)));
      marker.visible = true;
    }
  });
  const up = () => {
    if (!drag.id) return;
    const id = drag.id;
    const { moved, snap } = drag;
    const p = drag.pos.clone();
    drag.id = null;
    marker.visible = false;
    controls.enabled = true;
    el.style.cursor = '';
    if (!moved) return place(id);
    if (snap !== null) return place(id, positional(id) ? snap : undefined);
    if (!overCase(p)) return sync(); // Back to the tray
    if (positional(id) && id === core.next()) return place(id, nearestSlot(id, p)!.key);
    place(id);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  const isPlacedLid = () => {
    const lidId = Object.keys(L.slots).find((k) => L.slots[k][''] && L.slots[k][''].mesh === 'lid');
    return !!lidId && st.placed.includes(lidId);
  };

  function drawRuler() {
    rulerG.clear();
    for (const k of ['r-bme', 'r-pick', 'r-dim']) tags.get(k)?.setAttribute('hidden', '');
    if (!rulerOn) return;
    if (L.chip && L.slots.bme) {
      const chipW = toWorld(L.chip).add(new THREE.Vector3(0, placedOffset('board'), 0));
      if (st.placed.includes('bme')) {
        const c = poseOf('bme', st.choice.bme).center;
        const b = toWorld(c).add(new THREE.Vector3(0, placedOffset('bme'), 0));
        rulerLine(chipW, b);
        const mm = Math.hypot(c[0] - L.chip[0], c[1] - L.chip[1], c[2] - L.chip[2]);
        tagAt.set('r-bme', [chipW.clone().lerp(b, 0.5), t('BME280 to chip ≈ {mm} mm (estimate)', { mm: mm.toFixed(0) }), 'ruler']);
      } else tagAt.set('r-bme', [chipW, t('BME280 is not placed yet; once placed, this measures its distance to the chip'), 'ruler']);
    }
    if (picks.length === 2) {
      rulerLine(picks[0], picks[1]);
      tagAt.set('r-pick', [picks[0].clone().lerp(picks[1], 0.5), `${picks[0].distanceTo(picks[1]).toFixed(1)} mm`, 'ruler']);
    } else if (picks.length === 1) {
      const d = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8), dotMat);
      d.position.copy(picks[0]);
      rulerG.add(d);
      tagAt.set('r-pick', [picks[0], t('Click once more to measure'), 'ruler']);
    } else tagAt.delete('r-pick');
    tagAt.set('r-dim', [toWorld([OW / 2, -OD / 2, 0]), t('Outline {w} × {d} × {h} mm', { w: OW, d: OD, h: OH }), '']);
  }
  const tagAt = new Map<string, [THREE.Vector3, string, string]>();

  // ---------------------------------------------------------------- Per frame
  const v = new THREE.Vector3();
  function project(p: THREE.Vector3): [number, number] | null {
    v.copy(p).project(camera);
    if (v.z > 1) return null;
    const r = el.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }
  const place2 = (t: HTMLElement, p: THREE.Vector3) => {
    const s = project(p);
    const r = container.getBoundingClientRect();
    if (!s) return (t.hidden = true);
    t.style.transform = `translate(${(s[0] - r.left).toFixed(1)}px, ${(s[1] - r.top).toFixed(1)}px) translate(-50%, -50%)`;
  };
  let raf: (() => void) | null = null;
  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    explodeT += ((explodeOn ? 1 : 0) - explodeT) * Math.min(1, dt * 8);
    const next = core.next();
    const bob = Math.sin(now / 600) * 1.2;
    for (const ob of Object.values(objs)) {
      const placed = st.placed.includes(ob.id);
      let pos: THREE.Vector3, scale: number;
      if (placed) {
        const c = poseOf(ob.id, ob.key).center;
        pos = new THREE.Vector3(c[0], c[1], c[2] + placedOffset(ob.id));
        scale = 1;
      } else if (drag.id === ob.id && drag.moved) {
        if (drag.snap !== null) {
          const c = poseOf(ob.id, drag.snap).center;
          pos = new THREE.Vector3(c[0], c[1], c[2] + 3 + placedOffset(ob.id));
          scale = 1;
        } else {
          pos = drag.pos.clone();
          scale = overCase(drag.pos) ? 1 : ob.trayScale;
        }
      } else {
        pos = ob.trayAt.clone().add(new THREE.Vector3(0, 0, ob.id === next ? bob : 0));
        scale = ob.trayScale;
      }
      const k = Math.min(1, dt * 14);
      ob.cur.pos.lerp(pos, k);
      ob.cur.scale += (scale - ob.cur.scale) * k;
      ob.root.position.copy(ob.cur.pos);
      ob.root.scale.setScalar(ob.cur.scale);
    }
    // Slots: next one breathes, the one being dragged near is brighter
    const pulse = 0.12 + 0.08 * (0.5 + 0.5 * Math.sin(now / 260));
    for (const g of ghosts) {
      if (!g.g.visible) continue;
      const hot = drag.snap === g.key && drag.id === g.id;
      const m = g.g.children[0] as THREE.Mesh;
      (m.material as THREE.MeshBasicMaterial).opacity = hot ? 0.38 : pulse;
      g.g.position.set(g.center[0], g.center[1], g.center[2] + placedOffset(g.id));
    }
    // Labels
    for (const t of tags.values()) t.hidden = true;
    if (next && L.slots[next]) {
      const keys = positional(next) ? slotKeys(next) : [slotKeys(next)[0]];
      for (const k of keys) {
        const c = poseOf(next, k).center;
        const s = core.byId[next].spots?.find((x) => x.key === k);
        const text = positional(next) && s ? (s.where ?? s.label) : t('Place here · {part}', { part: t(core.byId[next].short) });
        place2(tag(`slot-${k}`, text, drag.snap === k ? 'hot' : 'slot'), toWorld([c[0], c[1], poseOf(next, k).max[2] + 3 + placedOffset(next)]));
      }
    }
    if (st.choosing) {
      const c = poseOf(st.choosing).center;
      const s = project(toWorld([c[0], c[1], poseOf(st.choosing).max[2] + 6]));
      if (s) {
        const r = container.getBoundingClientRect();
        chooser.style.transform = `translate(${(s[0] - r.left).toFixed(1)}px, ${(s[1] - r.top).toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
    if (rulerOn) {
      if (Math.abs(explodeT - (explodeOn ? 1 : 0)) > 0.002) drawRuler();
      for (const [k, [p, text, cls]] of tagAt) place2(tag(k, text, cls), p);
    }
    clipList.length = 0;
    if (sectionOn) clipList.push(clip);
    controls.update();
    if (!sw.warming()) renderer.render(scene, camera);
  }

  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 46 : 34;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  sync();

  return {
    kind: '3d' as const,
    template: T.id,
    start() {
      if (!raf) {
        last = performance.now();
        raf = onFrame(frame, { priority: PRIO.render, el: container });
      }
    },
    stop() {
      raf?.();
      raf = null;
    },
    state: () => ({ placed: [...st.placed], choice: { ...st.choice }, mode: 'build' as const, total: P.length }),
    effects: core.effects,
    clean: core.clean,
    place,
    reset() {
      core.reset();
      sync();
      o.onStep();
    },
    message: () => ({ title: st.msg[0], text: st.msg[1], bad: st.bad }),
    choosing: () => st.choosing,
    setExplode(on: boolean) {
      explodeOn = on;
    },
    exploded: () => explodeOn,
    setSection(on: boolean) {
      sectionOn = on;
    },
    section: () => sectionOn,
    setRuler(on: boolean) {
      rulerOn = on;
      picks.length = 0;
      if (!on) tagAt.clear();
      drawRuler();
      el.style.cursor = on ? 'crosshair' : '';
    },
    ruler: () => rulerOn,
    /** Test hook: page positions of parts (tray / placed) and slots */
    partScreen(id: string): [number, number] | null {
      const ob = objs[id];
      if (!ob) return null;
      return project(ob.root.getWorldPosition(new THREE.Vector3()));
    },
    slotScreen(id: string, key?: string): [number, number] | null {
      if (!L.slots[id]) return null;
      const c = poseOf(id, key).center;
      return project(toWorld([c[0], c[1], topZ + 8]));
    },
    rulerText: () => [...tagAt.values()].map((x) => x[1]),
    resetView() {
      camera.position.copy(home);
      controls.target.copy(target);
    },
    dispose() {
      raf?.();
      raf = null;
      ro.disconnect();
      offTheme();
      controls.dispose();
      scene.traverse((x) => {
        const m = x as THREE.Mesh;
        m.geometry?.dispose();
      });
      for (const m of mats.values()) m.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      container.replaceChildren();
    },
  };
}
export type Assembly3D = ReturnType<typeof createAssembly3D>;
