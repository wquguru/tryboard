// R-15: link shaders in the background before the first draw, shared by every WebGLRenderer view
import * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { onFrame, PRIO } from './ui/frame';

export interface ShaderWarm {
  /** Queue programs for the scene's current materials; call after building or changing the scene. */
  warm(): void;
  /** True while queued programs are still linking: skip the draw this frame. Warms on first call if never warmed. */
  warming(): boolean;
}

// A first draw links shaders synchronously (~0.5–1 s blocked at start-up); compile() starts them under
// KHR_parallel_shader_compile and isReady() polls. Own poll: compileAsync's throws when a material is disposed.
const SETTLE_FRAMES = 6;
const SETTLE_MAX = 120;

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
  // the same program key (object traits, geometry attributes, flipped side, maps, light counts) share the cached program
  const depthSeen = new Set<string>();
  // Light counts are part of every program key: adding a part's LED light needs new depth variants
  const lightSig = () => {
    const n: Record<string, number> = {};
    scene.traverseVisible((o) => {
      const l = o as THREE.Light;
      if (l.isLight) n[l.type + (l.castShadow ? '*' : '')] = (n[l.type + (l.castShadow ? '*' : '')] ?? 0) + 1;
    });
    return Object.entries(n).sort().join();
  };
  const depthTarget = new THREE.WebGLRenderTarget(1, 1);
  const flip = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
  function depthStandIns() {
    const out: THREE.Object3D[] = [];
    const lights = lightSig();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !o.castShadow) return;
      const mats = ([] as THREE.Material[]).concat(mesh.material) as THREE.MeshStandardMaterial[];
      const displaced = (m: THREE.MeshStandardMaterial) => !!m.displacementMap && m.displacementScale !== 0;
      const im = o as THREE.InstancedMesh;
      const key = [lights, im.isInstancedMesh, !!im.instanceColor, (o as THREE.SkinnedMesh).isSkinnedMesh, Object.keys(mesh.geometry.morphAttributes).join(), Object.keys(mesh.geometry.attributes).sort().join(),
        mats.map((m) => `${m.shadowSide ?? flip[m.side]}/${!!m.map}/${!!m.alphaMap}/${m.alphaTest > 0}/${displaced(m)}`).join()].join('|');
      if (depthSeen.has(key)) return;
      const dms = mats.map((m) => {
        const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: m.shadowSide ?? flip[m.side] });
        // three hands every caster's map / alphaMap / alphaTest to its depth material, masked or not
        Object.assign(d, { alphaTest: m.alphaTest, map: m.map, alphaMap: m.alphaMap });
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
  // A texture background is drawn by three's internal plane, also unseen by compile(): same material, same key
  let bg: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  function backgroundStandIn(): THREE.Object3D[] {
    const tex = scene.background as THREE.Texture | null;
    if (!tex?.isTexture || (tex as THREE.CubeTexture).isCubeTexture || tex.mapping === THREE.CubeUVReflectionMapping) return [];
    if (!bg) {
      const lib = THREE.ShaderLib.background;
      const m = new THREE.ShaderMaterial({ name: 'BackgroundMaterial', uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, side: THREE.FrontSide, depthTest: false, depthWrite: false, fog: false });
      Object.defineProperty(m, 'map', { get: () => m.uniforms.t2D.value });
      const g = new THREE.PlaneGeometry(2, 2);
      g.deleteAttribute('normal');
      bg = new THREE.Mesh(g, m);
    }
    bg.material.uniforms.t2D.value = tex;
    bg.material.toneMapped = THREE.ColorManagement.getTransfer(tex.colorSpace) !== THREE.SRGBTransfer;
    return [bg];
  }
  let warmed = false;
  // Right after compile() a cached program can report ready while its link still blocks the first draw. The GPU process
  // can stay busy for a few hundred ms more: fences (polled, never waited on) tell when it has caught up
  const gl = renderer.getContext();
  const gl2 = 'fenceSync' in gl ? gl : null;
  let settled = true;
  let warmGen = 0;
  // warm() only marks the scene dirty: several rebuilds in one task (setBoard, then setScene) compile once, at the next frame,
  // so a light count that changes in between never links a throwaway set of programs
  let dirty = false;
  function compileNow() {
    dirty = false;
    settled = false;
    const gen = ++warmGen;
    let k = 0;
    let fence: WebGLSync | null = null;
    const step = () => {
      const done = !fence || gl2!.getSyncParameter(fence, gl2!.SYNC_STATUS) === gl2!.SIGNALED;
      if ((++k >= SETTLE_FRAMES && done) || k > SETTLE_MAX) {
        if (fence) gl2!.deleteSync(fence);
        settled ||= gen === warmGen;
        off();
        return;
      }
      if (done && gl2) {
        if (fence) gl2.deleteSync(fence);
        fence = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl2.flush();
      }
    };
    // One step per frame, after the views' render (PRIO.warm): the settle count is in frames
    const off = onFrame(step, { priority: PRIO.warm });
    // Same variants the frame will use: with a composer the scene renders into its linear target, not the canvas
    const prev = renderer.getRenderTarget();
    if (composer) renderer.setRenderTarget(composer.readBuffer);
    for (const m of renderer.compile(scene, camera)) pending.add(m);
    const back = backgroundStandIn();
    if (back.length) for (const m of renderer.compile(Object.assign(new THREE.Scene(), { children: back }), camera, scene)) pending.add(m);
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
  }
  return {
    warm() {
      warmed = true;
      dirty = true;
    },
    warming() {
      if (!warmed) this.warm();
      if (dirty) compileNow();
      for (const m of pending) {
        const p = (renderer.properties.get(m) as { currentProgram?: { isReady(): boolean } }).currentProgram;
        if (!p || p.isReady()) pending.delete(m);
      }
      return !settled || pending.size > 0;
    },
  };
}
