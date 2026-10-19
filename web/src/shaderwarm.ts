// R-15: link shaders in the background before the first draw, shared by every WebGLRenderer view
import * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface ShaderWarm {
  /** Queue programs for the scene's current materials; call after building or changing the scene. */
  warm(): void;
  /** True while queued programs are still linking: skip the draw this frame. Warms on first call if never warmed. */
  warming(): boolean;
}

// A first draw links shaders synchronously (~0.5–1 s blocked at start-up); compile() starts them under
// KHR_parallel_shader_compile and isReady() polls. Own poll: compileAsync's throws when a material is disposed.
export function shaderWarm(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, composer?: EffectComposer): ShaderWarm {
  const pending = new Set<THREE.Material>();
  // Post-processing materials (bloom blur kernels, outline, output) on throwaway quads so compile() reaches them;
  // the screen pass draws into the canvas (sRGB) and the others into linear targets, so they are separate variants
  let fx: [THREE.Scene, THREE.Scene] | null = null;
  function passScenes(c: EffectComposer) {
    if (fx) return fx;
    fx = [new THREE.Scene(), new THREE.Scene()];
    const quad = new THREE.PlaneGeometry(1, 1);
    // renderToScreen is only assigned during the first composer.render(): the last enabled pass draws to the canvas
    const last = c.passes.reduce((n, p, i) => (p.enabled ? i : n), -1);
    for (const [i, pass] of c.passes.entries()) {
      // OutputPass picks its defines on its first render: run that with the draw stubbed out
      if (pass instanceof OutputPass) {
        const q = pass.fsQuad;
        pass.fsQuad = { render() {} } as unknown as typeof q;
        pass.render(renderer, c.writeBuffer, c.readBuffer, 0, false);
        pass.fsQuad = q;
      }
      for (const v of Object.values(pass).flat())
        if ((v as THREE.Material)?.isMaterial) fx[i === last ? 1 : 0].add(Object.assign(new THREE.Mesh(quad, v as THREE.Material), { frustumCulled: false }));
    }
    return fx;
  }
  // Shadow passes draw casters with three's internal MeshDepthMaterial, which compile() never sees: stand-ins with
  // the same program key (object traits, geometry attributes, flipped side) share the cached program
  const depthSeen = new Set<string>();
  const depthTarget = new THREE.WebGLRenderTarget(1, 1);
  const flip = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
  function depthStandIns() {
    const out: THREE.Object3D[] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !o.castShadow) return;
      const mats = ([] as THREE.Material[]).concat(mesh.material) as THREE.MeshStandardMaterial[];
      const masked = (m: THREE.MeshStandardMaterial) => m.alphaTest > 0 && !!(m.map || m.alphaMap);
      const displaced = (m: THREE.MeshStandardMaterial) => !!m.displacementMap && m.displacementScale !== 0;
      const im = o as THREE.InstancedMesh;
      const key = [im.isInstancedMesh, !!im.instanceColor, (o as THREE.SkinnedMesh).isSkinnedMesh, Object.keys(mesh.geometry.morphAttributes).join(), Object.keys(mesh.geometry.attributes).sort().join(),
        mats.map((m) => `${m.shadowSide ?? flip[m.side]}/${masked(m)}/${displaced(m)}`).join()].join('|');
      if (depthSeen.has(key)) return;
      const dms = mats.map((m) => {
        const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: m.shadowSide ?? flip[m.side] });
        if (masked(m)) Object.assign(d, { alphaTest: m.alphaTest, map: m.map, alphaMap: m.alphaMap });
        if (displaced(m)) Object.assign(d, { displacementMap: m.displacementMap, displacementScale: m.displacementScale });
        return d;
      });
      // Inherits geometry and instancing from the caster without being added to (and stealing it from) a parent
      const proxy: THREE.Object3D = Object.create(o, { material: { value: Array.isArray(mesh.material) ? dms : dms[0] }, children: { value: [] } });
      depthSeen.add(key);
      out.push(proxy);
    });
    return out;
  }
  let warmed = false;
  // Right after compile() a cached program can report ready while its link still blocks the first draw
  let settled = true;
  let warmGen = 0;
  return {
    warm() {
      warmed = true;
      settled = false;
      const gen = ++warmGen;
      requestAnimationFrame(() => (settled ||= gen === warmGen));
      // Same variants the frame will use: with a composer the scene renders into its linear target, not the canvas
      const prev = renderer.getRenderTarget();
      if (composer) renderer.setRenderTarget(composer.readBuffer);
      for (const m of renderer.compile(scene, camera)) pending.add(m);
      if (composer) {
        const [mid, screen] = passScenes(composer);
        for (const m of renderer.compile(mid, camera)) pending.add(m);
        renderer.setRenderTarget(null);
        for (const m of renderer.compile(screen, camera)) pending.add(m);
      }
      const casters = renderer.shadowMap.enabled ? depthStandIns() : [];
      if (casters.length) {
        renderer.setRenderTarget(depthTarget);
        const holder = Object.assign(new THREE.Scene(), { children: casters });
        // Lights come from the scene, but the shadow pass draws with an empty one: no fog in the key
        const fog = scene.fog;
        scene.fog = null;
        for (const m of renderer.compile(holder, camera, scene)) pending.add(m);
        scene.fog = fog;
      }
      renderer.setRenderTarget(prev);
    },
    warming() {
      if (!warmed) this.warm();
      for (const m of pending) {
        const p = (renderer.properties.get(m) as { currentProgram?: { isReady(): boolean } }).currentProgram;
        if (!p || p.isReady()) pending.delete(m);
      }
      return !settled || pending.size > 0;
    },
  };
}
