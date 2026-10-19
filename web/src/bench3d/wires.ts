// Dupont wire mesh and its record.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PickTarget } from '../scene-api';
import { MAT } from './util';

// ---------------------------------------------------------------- wires

export interface WireRec {
  id: string;
  ends: [string, string];
  grp: THREE.Group;
  tube: THREE.Mesh;
  curve: THREE.CatmullRomCurve3;
  mat: THREE.MeshStandardMaterial;
  color: number;
  thin: THREE.BufferGeometry;
  thick?: THREE.BufferGeometry;
}

export const WIRE_R = 0.6;
/** Dupont wire: tube curve + black plug housing at each end (2.54 square, 11 mm tall), housings merged into one geometry */
export function wire(points: THREE.Vector3[], color: number, id: string, ends: [string, string]): WireRec {
  // The segment inside the plug must go straight up: Catmull-Rom's tangent at the 2nd point would bulge the wire out of the plug side,
  // so add control points straight above inside and atop the plug; bending happens only above the plug
  const guide = (p: THREE.Vector3, q: THREE.Vector3) =>
    q.y > p.y + 13 ? [new THREE.Vector3(p.x, p.y + 5.5, p.z), new THREE.Vector3(p.x, p.y + 11.5, p.z)] : [];
  const n = points.length;
  const pts = [points[0], ...guide(points[0], points[1]), ...points.slice(1, n - 1), ...guide(points[n - 1], points[n - 2]).reverse(), points[n - 1]];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.3);
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.42 });
  const thin = new THREE.TubeGeometry(curve, 96, WIRE_R, 10);
  const tube = new THREE.Mesh(thin, mat);
  tube.castShadow = true;
  grp.add(tube);
  const housings = [points[0], points[points.length - 1]].map((p) => new THREE.BoxGeometry(2.4, 11, 2.4).translate(p.x, p.y + 5.5, p.z));
  const plug = new THREE.Mesh(mergeGeometries(housings), MAT.plug);
  plug.castShadow = true;
  grp.add(plug);
  grp.userData.pick = { kind: 'wire', id } satisfies PickTarget;
  return { id, ends, grp, tube, curve, mat, color, thin };
}
