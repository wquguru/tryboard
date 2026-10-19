// Browser entry for enclosure meshes: Manifold (~0.47 MB wasm) loads lazily, only when an enclosure view needs it.
// Results are reused while params and BOM are unchanged; exports are read back with three.js loaders as a self-check.
import type { ManifoldToplevel } from 'manifold-3d';
import { Box3, Vector3, type Mesh } from 'three';
import { t } from '../i18n';
import { buildCaseMeshes, caseLayout, caseSel, printLayout, type CaseLayout, type CaseMeshes, type CaseParams } from './enclosure';
import { to3mf, toStl } from './meshio';
import { replay, type BomHistory } from './bom';

let wasm: Promise<ManifoldToplevel> | null = null;
export function loadManifold(): Promise<ManifoldToplevel> {
  if (!wasm)
    wasm = (async () => {
      const [{ default: Module }, { default: url }] = await Promise.all([import('manifold-3d'), import('manifold-3d/manifold.wasm?url')]);
      const m = await Module({ locateFile: () => url });
      m.setup();
      return m;
    })().catch((e) => {
      wasm = null;
      throw e;
    });
  return wasm;
}

export { loadCaseParams, saveCaseParams } from './caseparams';

/** BOM -> parts the enclosure must fit (board, servo, screen, sensors). */
export function layoutFor(template: string, bom: BomHistory, p: CaseParams): CaseLayout {
  const b = replay(bom);
  return caseLayout(template, p, caseSel(b.board, b.picks.map((x) => x.partId)));
}

let cache: { key: string; out: { layout: CaseLayout; meshes: CaseMeshes } } | null = null;
export async function caseFor(template: string, bom: BomHistory, p: CaseParams) {
  const layout = layoutFor(template, bom, p);
  const key = JSON.stringify([template, layout.params, layout.sizes.map((s) => s.part)]);
  if (cache?.key === key) return cache.out;
  const M = await loadManifold();
  const out = { layout, meshes: buildCaseMeshes(M, layout) };
  cache = { key, out };
  return out;
}
export const layoutKey = (L: CaseLayout) => JSON.stringify([L.template, L.params, L.sizes.map((s) => s.part)]);

export interface ExportResult {
  name: string;
  bytes: Uint8Array;
  /** Read back with three.js loaders: triangle count, bounding box (mm). */
  check: { ok: boolean; tris: number; size: [number, number, number]; text: string };
}

/** Build STL / 3MF and verify by reading it back (loaders are lazy too). */
export async function exportCase(template: string, bom: BomHistory, p: CaseParams, fmt: 'stl' | '3mf'): Promise<ExportResult> {
  const { layout, meshes } = await caseFor(template, bom, p);
  const objs = printLayout(layout, meshes);
  const tris = objs.reduce((a, o) => a + o.mesh.idx.length / 3, 0);
  const title = t('TryBoard {template} enclosure H{h} wall {w}', { template, h: p.height, w: p.wall });
  const bytes = fmt === 'stl' ? toStl(objs, `TryBoard ${template} H${p.height} W${p.wall} R${p.radius}`) : to3mf(objs, title);
  // Static named three imports: a dynamic import('three') would pull all of three into a shared chunk.
  let got = 0;
  const box = new Box3();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (fmt === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    const g = new STLLoader().parse(buf);
    got = g.getAttribute('position').count / 3;
    g.computeBoundingBox();
    box.copy(g.boundingBox!);
  } else {
    const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
    const grp = new ThreeMFLoader().parse(buf);
    grp.updateMatrixWorld(true);
    grp.traverse((x) => {
      const m = x as Mesh;
      if (m.isMesh) {
        const idx = m.geometry.getIndex();
        got += (idx ? idx.count : m.geometry.getAttribute('position').count) / 3;
      }
    });
    // 3MFLoader rotates z-up to y-up; we only need the three side lengths, so the rotated box is fine.
    box.setFromObject(grp);
  }
  const s = box.getSize(new Vector3());
  const size: [number, number, number] = [s.x, s.y, s.z].map((v) => Math.round(v * 10) / 10) as [number, number, number];
  const ok = got === tris;
  return {
    name: `tryboard-${template}-case-h${p.height}.${fmt}`,
    bytes,
    check: { ok, tris: got, size, text: ok ? t('Enclosure {fmt} generated ({n} triangles, {x} × {y} × {z} mm)', { fmt: fmt.toUpperCase(), n: got, x: size[0], y: size[1], z: size[2] }) : t('{fmt} generation failed, please try again', { fmt: fmt.toUpperCase() }) },
  };
}

export function download(name: string, bytes: Uint8Array, type: string) {
  const blob = new Blob([bytes as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
