// External 3D models (P1-09): assets/models/<name>/<name>.glb, copied to dist/models/ by a vite plugin and lazy-loaded.
// Procedural parts stay the fallback (option off, load error, no KHR_mesh_quantization); credits in each SOURCES.md; glb is mm, Y up.
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

/** External models on? `?models=ext|proc` applies to this visit only; otherwise localStorage (default off). */
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
    /* Private mode: this page only. */
  }
  listeners.forEach((f) => f(on));
}
export function onExtModels(f: (on: boolean) => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Scenes report which external models are shown right now (for tests / screenshots, `window.__tbExt.shown()`). */
const reporters = new Set<() => string[]>();
export function reportExt(f: () => string[]) {
  reporters.add(f);
  return () => reporters.delete(f);
}
export const extShown = () => [...new Set([...reporters].flatMap((f) => f()))];
if (typeof window !== 'undefined') (window as unknown as { __tbExt: unknown }).__tbExt = { on: extModelsOn, set: setExtModels, shown: extShown };

const cache = new Map<string, Promise<THREE.Group | null>>();
/** Load once and return a deep clone (own geometry and materials, so scene rebuilds can dispose them). */
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
          console.warn(`[models] ${name} failed to load, using the procedural version`, e);
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
