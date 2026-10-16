// 外部 3D 模型（P1-09）：assets/models/<名字>/<名字>.glb，构建时由 vite 插件拷到 dist/models/，懒加载。
// 程序生成的器件始终是默认兜底：没开"外部模型"、加载失败、WebGL 不支持 KHR_mesh_quantization 都退回程序生成。
// 来源与署名在各素材目录的 SOURCES.md（licenses.html 自动带上），glb 单位是 mm、Y 朝上。
import type * as THREE from 'three';

export const EXT = {
  usbC: 'kicad-usb-c-gct-usb4105',
  buzzer: 'kicad-buzzer-12x9.5',
  servo: 'adafruit-1143-micro-servo',
} as const;
export type ExtName = (typeof EXT)[keyof typeof EXT];

const KEY = 'tb-ext-models';
let override: boolean | null = null;
const listeners = new Set<(on: boolean) => void>();

/** 开没开外部模型：URL `?models=ext|proc` 只管这一次打开；否则看 localStorage（默认关） */
export function extModelsOn(): boolean {
  if (override !== null) return override;
  const q = new URLSearchParams(location.search).get('models');
  if (q === 'ext' || q === 'proc') return q === 'ext';
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
export function setExtModels(on: boolean) {
  override = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式：只在本页生效 */
  }
  listeners.forEach((f) => f(on));
}
export function onExtModels(f: (on: boolean) => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** 各场景报告"此刻实际显示着哪些外部模型"（测试 / 截图核对用，`window.__tbExt.shown()`） */
const reporters = new Set<() => string[]>();
export function reportExt(f: () => string[]) {
  reporters.add(f);
  return () => reporters.delete(f);
}
export const extShown = () => [...new Set([...reporters].flatMap((f) => f()))];
if (typeof window !== 'undefined') (window as unknown as { __tbExt: unknown }).__tbExt = { on: extModelsOn, set: setExtModels, shown: extShown };

const cache = new Map<string, Promise<THREE.Group | null>>();
/** 加载（只下载一次），返回一份可以随便改的克隆（几何体、材质各自独立，场景重建时可以照常释放） */
export async function loadExt(name: ExtName): Promise<THREE.Group | null> {
  if (!cache.has(name)) {
    cache.set(
      name,
      (async () => {
        try {
          const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
          const url = new URL(`models/${name}/${name}.glb`, document.baseURI).href;
          const g = await new GLTFLoader().loadAsync(url);
          return g.scene as THREE.Group;
        } catch (e) {
          console.warn(`[models] ${name} 加载失败，用程序生成的版本`, e);
          return null;
        }
      })(),
    );
  }
  const src = await cache.get(name)!;
  if (!src) return null;
  const c = src.clone(true);
  c.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry = m.geometry.clone();
    m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
    m.castShadow = true;
    m.receiveShadow = true;
  });
  c.userData.ext = name;
  return c;
}
