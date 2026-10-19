// Bench inspection overlays: highlight, faults, heat glow, ruler.

import * as THREE from 'three';
import type { PickTarget } from '../scene-api';
import { t } from '../i18n';
import { ACCENT, BAD, canvasTexture } from './util';
import { type WireRec, WIRE_R, wire } from './wires';
import type { BenchCtx } from './ctx';

/** Highlight, wiring faults, heat glow and the ruler. */
export function mountInspect(ctx: BenchCtx): void {
  const { scene, setTag, boardHole, lift, top, partsById, outline, pinsById, pinWorldPos, targetPos } = ctx;
  ctx.highlight = highlight;
  ctx.rewire = rewire;
  ctx.bridge = bridge;
  ctx.setWireFault = setWireFault;
  ctx.setHeat = setHeat;
  ctx.measure = measure;
  const hlGroup = new THREE.Group();
  scene.add(hlGroup);
  const ringGeo = new THREE.TorusGeometry(1.7, 0.22, 8, 40).rotateX(Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, transparent: true });
  ctx.hl = null;
  const thicken = (w: WireRec, on: boolean) => {
    if (on) w.thick ??= new THREE.TubeGeometry(w.curve, 96, WIRE_R * 1.7, 10);
    w.tube.geometry = on ? w.thick! : w.thin;
  };
  function highlight(tgt: PickTarget | null) {
    for (const w of ctx.wires) thicken(w, false);
    hlGroup.clear();
    outline.selectedObjects = [];
    outline.enabled = false;
    setTag('hl', null, '', () => null);
    ctx.hl = tgt;
    if (!tgt) return;
    if (tgt.kind === 'part' || tgt.kind === 'button') {
      const o = tgt.kind === 'part' ? partsById.get(tgt.id) : ctx.board.buttons.find((b) => b.name === tgt.id);
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
      for (const w of ctx.wires) if (w.ends.includes(tgt.id)) thicken(w, true);
      if (recs.length) {
        const role = ctx.roles.get(tgt.id)?.join(' · ');
        const pinName = recs[0].label !== tgt.id ? t('{id} (silkscreen {label})', { id: tgt.id, label: recs[0].label }) : tgt.id;
        setTag('hl', `${pinName}${role ? ' · ' + role : ''}`, 'pin', () => pinWorldPos(recs[0]), -18);
      }
      return;
    }
    const w = ctx.wires.find((w) => w.id === tgt.id);
    if (!w) return;
    thicken(w, true);
    setTag('hl', `${w.ends[0]} → ${w.ends[1]}`, 'pin', () => w.curve.getPoint(0.5), -16);
  }

  const faults = new Map<string, string>();
  ctx.faults = faults;
  const applyFault = (id: string, msg: string) => {
    const w = ctx.wires.find((w) => w.id === id);
    if (!w) return;
    w.mat.color.set(BAD);
    w.mat.emissive.set(BAD);
    w.mat.emissiveIntensity = 0.25;
    setTag('fault:' + id, '✗ ' + msg, 'bad', () => w.curve.getPoint(0.5), -20);
  };
  ctx.applyFault = applyFault;
  /** Rewire (U-04 wire tool): move a wire's board end to another pin. The original is kept to swap back; cleared on setScene rebuild */
  function rewire(id: string, to: string | null) {
    const cur = ctx.wires.find((w) => w.id === id);
    if (!cur) return;
    const orig = ctx.rewired.get(id) ?? cur;
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
    if (next === orig) ctx.rewired.delete(id);
    else ctx.rewired.set(id, orig);
    ctx.wires[ctx.wires.indexOf(cur)] = next;
    const f = faults.get(id);
    if (f) applyFault(id, f);
    else {
      next.mat.color.set(next.color);
      next.mat.emissive.set(0);
    }
    if (ctx.hl) highlight(ctx.hl);
  }
  /** Board-to-board jumper (for P2-14 shorts): b null unplugs; cleared with parts on setScene, re-added on wiring recheck */
  function bridge(id: string, a: string, b: string | null) {
    const cur = ctx.wires.find((w) => w.id === id);
    if (!b) {
      if (!cur) return;
      cur.grp.parent?.remove(cur.grp);
      cur.thin.dispose();
      cur.thick?.dispose();
      cur.mat.dispose();
      ctx.wires.splice(ctx.wires.indexOf(cur), 1);
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
    ctx.parts.add(w.grp);
    ctx.wires.push(w);
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
    const w = ctx.wires.find((w) => w.id === id);
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
  ctx.heat = heat;
  heat.raycast = () => {};
  heat.visible = false;
  heat.renderOrder = 5;
  scene.add(heat);
  ctx.heatId = null;
  ctx.heatBase = 1;
  function setHeat(partId: string | null) {
    ctx.heatId = partId;
    const o = partId ? partsById.get(partId) : undefined;
    heat.visible = !!o;
    if (!o) return;
    const box = new THREE.Box3().setFromObject(o);
    const size = box.getSize(new THREE.Vector3());
    ctx.heatBase = Math.max(size.x, size.y, size.z) * 2.2 + 10;
    heat.position.copy(box.getCenter(new THREE.Vector3()));
  }

  const rulerGroup = new THREE.Group();
  scene.add(rulerGroup);
  const rulerMat = new THREE.LineBasicMaterial({ color: BAD, depthTest: false, transparent: true });
  const dotMat = new THREE.MeshBasicMaterial({ color: BAD, depthTest: false, transparent: true });
  const dotGeo = new THREE.SphereGeometry(0.8, 16, 8);
  ctx.measured = null;
  function measure(a: PickTarget | null, b?: PickTarget): number | null {
    rulerGroup.children.forEach((c) => (c as THREE.Line).geometry !== dotGeo && (c as THREE.Line).geometry.dispose());
    rulerGroup.clear();
    setTag('ruler', null, '', () => null);
    ctx.measured = null;
    if (!a || !b) return null;
    const pa = targetPos(a), pb = targetPos(b);
    if (!pa || !pb) return null;
    ctx.measured = [a, b];
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
}
