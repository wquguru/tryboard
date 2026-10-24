// Beginner "Show current" (PLAN H-04): a dashed blue tube along a lesson's loop (wire ids, part ids, pin ids)
// whose dashes scroll each frame. Built lazily on the first setFlow, so the scene is untouched while it is never used.
import * as THREE from 'three';
import { MAT } from './util';
import type { BenchCtx } from './ctx';

/** Figma blue from the beginner design (DESIGN_V2 §11). */
const FLOW = 0x0d99ff;
/** Dash period in mm (60% dash) and scroll speed in mm/s. */
const PERIOD = 5;
const SPEED = 12;
const RADIUS = 0.8;

export function mountFlow(ctx: BenchCtx): void {
  let path: string[] | null = null;
  let mesh: THREE.Mesh | null = null;
  let tex: THREE.DataTexture | null = null;
  let mat: THREE.MeshBasicMaterial | null = null;
  let segs = 0;
  let shown = false;
  // What the current geometry was resolved against: rebuild when the scene swaps wires
  let seen: { wires: unknown; n: number; refs: unknown[] } | null = null;
  let lastT = 0;

  /** World points along one part: centres of its direct children (resistor, LED body...), nearest first from `from`. */
  function partPoints(id: string, from: THREE.Vector3 | null): THREE.Vector3[] {
    const o = ctx.partsById.get(id);
    if (!o) return [];
    o.updateMatrixWorld(true);
    const cs: THREE.Vector3[] = [];
    for (const ch of o.children) {
      const box = new THREE.Box3();
      ch.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh || m.material === MAT.hit || m.material === MAT.gold || m.renderOrder < 0) return;
        box.union(new THREE.Box3().setFromObject(m));
      });
      if (!box.isEmpty()) cs.push(box.getCenter(new THREE.Vector3()));
    }
    if (!cs.length) {
      const p = ctx.targetPos({ kind: 'part', id });
      return p ? [p] : [];
    }
    const out: THREE.Vector3[] = [];
    let at = from ?? cs[0];
    while (cs.length) {
      let k = 0;
      for (let i = 1; i < cs.length; i++) if (cs[i].distanceTo(at) < cs[k].distanceTo(at)) k = i;
      at = cs.splice(k, 1)[0];
      out.push(at);
    }
    return out;
  }

  /** Resolve the path to one polyline; a missing wire breaks the loop (no current). */
  function resolve(p: string[]): { pts: THREE.Vector3[]; n: number; refs: unknown[] } {
    const pts: THREE.Vector3[] = [];
    const refs: unknown[] = [];
    let n = 0;
    const last = () => pts[pts.length - 1] ?? null;
    for (const id of p) {
      if (id.startsWith('wire:')) {
        const w = ctx.wires.find((x) => x.id === id);
        refs.push(w);
        // Moved to another pin (wire mode) also opens the loop
        const moved = !!w && ctx.rewired.has(id) && ctx.rewired.get(id) !== w;
        if (!w || moved) return { pts: [], n: 0, refs };
        const ws = w.curve.getPoints(48);
        const from = last();
        if (from && from.distanceTo(ws[ws.length - 1]) < from.distanceTo(ws[0])) ws.reverse();
        pts.push(...ws);
      } else if (ctx.partsById.has(id)) {
        const ps = partPoints(id, last());
        if (!ps.length) continue;
        pts.push(...ps);
      } else {
        // Same-named pins (GND) are one net: take the rec nearest to where the loop already is
        const recs = ctx.pinsById(id);
        if (!recs.length) continue;
        const from = last();
        const ps = recs.map((r) => ctx.pinWorldPos(r));
        pts.push(from ? ps.reduce((a, b) => (b.distanceTo(from) < a.distanceTo(from) ? b : a)) : ps[0]);
      }
      n++;
    }
    const clean = pts.filter((q, i) => i === 0 || q.distanceTo(pts[i - 1]) > 0.05);
    return { pts: clean, n: clean.length > 1 ? n : 0, refs };
  }

  function ensure() {
    if (mesh) return;
    // 1 x 8 alpha strip: 5 opaque texels (dash) + 3 clear (gap), repeated along the tube
    const data = new Uint8Array(8 * 4);
    for (let i = 0; i < 8; i++) data.set([255, 255, 255, i < 5 ? 255 : 0], i * 4);
    tex = new THREE.DataTexture(data, 8, 1);
    tex.wrapS = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    mat = new THREE.MeshBasicMaterial({ color: FLOW, map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.renderOrder = 999;
    mesh.visible = false;
    ctx.scene.add(mesh);
  }

  function rebuild() {
    seen = null;
    segs = 0;
    if (!mesh || !path) return;
    const r = resolve(path);
    seen = { wires: ctx.wires, n: ctx.wires.length, refs: r.refs };
    mesh.geometry.dispose();
    if (!r.n) {
      mesh.geometry = new THREE.BufferGeometry();
      mesh.visible = false;
      return;
    }
    const curve = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < r.pts.length; i++) curve.add(new THREE.LineCurve3(r.pts[i - 1], r.pts[i]));
    const len = curve.getLength();
    mesh.geometry = new THREE.TubeGeometry(curve, Math.max(32, Math.ceil(len * 2)), RADIUS, 8, false);
    tex!.repeat.x = len / PERIOD;
    segs = r.n;
    mesh.visible = shown;
  }

  ctx.setFlow = (p) => {
    path = p && p.length ? p : null;
    if (!path) {
      shown = false;
      segs = 0;
      if (mesh) mesh.visible = false;
      return 0;
    }
    ensure();
    shown = true;
    rebuild();
    return segs;
  };
  ctx.flowSegs = () => (shown ? segs : 0);
  /** Called from the render tick: scroll the dashes, re-resolve if the wires changed under us. */
  ctx.flowTick = (now) => {
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
    lastT = now;
    if (!mesh || !shown || !path) return;
    const ids = path.filter((s) => s.startsWith('wire:'));
    if (!seen || seen.wires !== ctx.wires || seen.n !== ctx.wires.length || seen.refs.some((w, i) => w !== ctx.wires.find((x) => x.id === ids[i])))
      rebuild();
    // Offset falls so the dashes travel toward the end of the path (GPIO → ... → GND)
    tex!.offset.x = (tex!.offset.x - (dt * SPEED) / PERIOD) % 1;
  };
}
