// 外壳网格的浏览器入口：懒加载 Manifold（wasm 约 0.47 MB，只在组装 / 采购页外壳详情用到时才下载），
// 参数与清单不变就复用上次的结果；导出时顺手用 three.js 的 STLLoader / 3MFLoader 读回一遍做自检。
import type { ManifoldToplevel } from 'manifold-3d';
import { Box3, Vector3, type Mesh } from 'three';
import { DEFAULT_PARAMS, buildCaseMeshes, caseLayout, caseSel, printLayout, type CaseLayout, type CaseMeshes, type CaseParams } from './enclosure';
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

const KEY = (work: string) => `tryboard-app-case:${work}`;
export function loadCaseParams(work: string): CaseParams {
  const d = DEFAULT_PARAMS[work] ?? DEFAULT_PARAMS.weather;
  try {
    const v = JSON.parse(localStorage.getItem(KEY(work)) ?? 'null');
    if (v && typeof v.height === 'number' && typeof v.wall === 'number' && typeof v.radius === 'number') return { height: v.height, wall: v.wall, radius: v.radius };
  } catch {
    /* 读不到就用默认 */
  }
  return { ...d };
}
export function saveCaseParams(work: string, p: CaseParams) {
  try {
    localStorage.setItem(KEY(work), JSON.stringify(p));
    // 顶栏「已存在本机」：这个文件也给 node 测试用，不直接引外壳，发个事件
    globalThis.dispatchEvent?.(new Event('tb-saved'));
  } catch {
    /* 隐私模式：只在本页有效 */
  }
}

/** 清单 → 外壳要的零件（开发板、舵机、屏、传感器） */
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
  /** 用 three.js 加载器读回：三角形数、包围盒（mm） */
  check: { ok: boolean; tris: number; size: [number, number, number]; text: string };
}

/** 生成 STL / 3MF 并读回校验（加载器同样懒加载） */
export async function exportCase(template: string, bom: BomHistory, p: CaseParams, fmt: 'stl' | '3mf'): Promise<ExportResult> {
  const { layout, meshes } = await caseFor(template, bom, p);
  const objs = printLayout(layout, meshes);
  const tris = objs.reduce((a, o) => a + o.mesh.idx.length / 3, 0);
  const title = `TryBoard ${template} 外壳 H${p.height} 壁厚${p.wall}`;
  const bytes = fmt === 'stl' ? toStl(objs, `TryBoard ${template} H${p.height} W${p.wall} R${p.radius}`) : to3mf(objs, title);
  // three 用静态具名导入：动态 import('three') 会让打包器把整个 three 塞进共享块
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
    // 3MFLoader 会把 z 朝上的模型转成 y 朝上：包围盒按转过的算，取三边长度
    box.setFromObject(grp);
  }
  const s = box.getSize(new Vector3());
  const size: [number, number, number] = [s.x, s.y, s.z].map((v) => Math.round(v * 10) / 10) as [number, number, number];
  const ok = got === tris;
  return {
    name: `tryboard-${template}-case-h${p.height}.${fmt}`,
    bytes,
    check: { ok, tris: got, size, text: ok ? `外壳 ${fmt.toUpperCase()} 已生成（${got} 个三角形，${size[0]} × ${size[1]} × ${size[2]} mm）` : `${fmt.toUpperCase()} 生成出错，请重试` },
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
