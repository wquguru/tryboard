// Bench stage: renderer, camera, lights, overlay, post-processing and the render loop.
// Each mount* runs once from createBench in source order; cross-section state lives on ctx.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SANS } from '../scene-api';
import { t } from '../i18n';
import { shaderWarm } from '../shaderwarm';
import { ACCENT, canvasTexture } from './util';
import type { BenchCtx } from './ctx';

/** Renderer, environment, camera, controls, lights, ground, theme and the DOM overlay with pin tags. */
export function mountStage(ctx: BenchCtx): void {
  const { container } = ctx;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  ctx.renderer = renderer;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // No tone mapping: the white minimal style needs background and part colours to match the design; emitters rely on bloom, >1 clips by hue
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  ctx.scene = scene;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.32;

  const camera = new THREE.PerspectiveCamera(35, 1, 1, 2000);
  ctx.camera = camera;
  camera.position.set(-40, 95, 105);
  const controls = new OrbitControls(camera, renderer.domElement);
  ctx.controls = controls;
  controls.target.set(0, 6, 4);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 14;
  controls.maxDistance = 420;

  const key = new THREE.DirectionalLight(0xfffaf2, 1.9);
  key.position.set(-70, 170, 80);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -130;
  key.shadow.camera.right = 130;
  key.shadow.camera.top = 110;
  key.shadow.camera.bottom = -110;
  key.shadow.radius = 5;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xdfe3e8, 1.35);
  scene.add(hemi);

  // The ground only receives shadows (white minimal look); contact shadows come from the soft shadow cards under each part
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.16 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Theme: bench background gradient (DESIGN §2)
  const gradient = (inner: string, outer: string) => {
    const t = canvasTexture(512, 512, (g) => {
      g.fillStyle = outer;
      g.fillRect(0, 0, 512, 512);
      g.save();
      g.translate(256, 205);
      g.scale(1.2, 0.9);
      const r = g.createRadialGradient(0, 0, 0, 0, 0, 512);
      r.addColorStop(0, inner);
      r.addColorStop(1, outer);
      g.fillStyle = r;
      g.fillRect(-512, -512, 1024, 1024);
      g.restore();
    });
    return t;
  };
  const themes = {
    light: { bg: gradient('#FFFFFF', '#ECEFF3'), shadow: 0.16, hemi: 1.35, key: 1.9 },
    dark: { bg: gradient('#2C2E33', '#141518'), shadow: 0.45, hemi: 0.75, key: 1.6 },
  };
  const applyTheme = (t: 'light' | 'dark') => {
    const th = themes[t];
    scene.background = th.bg;
    groundMat.opacity = th.shadow;
    hemi.intensity = th.hemi;
    hemi.groundColor.set(t === 'light' ? 0xdfe3e8 : 0x303238);
    key.intensity = th.key;
    overlay.dataset.theme = t;
  };
  ctx.applyTheme = applyTheme;

  // DOM overlay: disclaimer, pin tags, fault tags, ruler readout
  const overlay = document.createElement('div');
  ctx.overlay = overlay;
  overlay.className = 'tb-overlay';
  overlay.style.cssText = `position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;font:12px ${SANS}`;
  const note = document.createElement('div');
  note.className = 'tb-note';
  note.textContent = t('Illustration only, not an official Espressif model');
  note.style.cssText = 'position:absolute;right:12px;bottom:10px;font-size:11px;color:var(--muted, #6f6f6f);letter-spacing:.02em';
  overlay.appendChild(note);
  const style = document.createElement('style');
  style.textContent = `.tb-tag{position:absolute;left:0;top:0;white-space:nowrap;padding:3px 8px;border-radius:8px;background:rgba(255,255,255,.95);border:1px solid #E6E6E6;box-shadow:0 2px 10px #0000000F;color:#1E1E1E;font:500 12px "JetBrains Mono",Menlo,monospace;will-change:transform}
.tb-tag.pin{border-color:#0D99FF;color:#0D99FF}.tb-tag.bad{background:#FEF2F2;border-color:#F24822;color:#F24822;font-family:${SANS}}
.tb-tag.ruler{background:#F24822;border-color:#F24822;color:#fff}
.tb-overlay[data-theme=dark] .tb-tag:not(.bad):not(.ruler){background:rgba(30,31,34,.95);border-color:#3a3c40;color:#E9EDF2}.tb-overlay[data-theme=dark] .tb-tag.pin{color:#5cb8ff;border-color:#0D99FF}`;
  overlay.appendChild(style);
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(overlay);
  const tags = new Map<string, { el: HTMLDivElement; at: () => THREE.Vector3 | null; dy: number }>();
  ctx.tags = tags;
  const setTag = (key: string, text: string | null, cls: string, at: () => THREE.Vector3 | null, dy = -14) => {
    const old = tags.get(key);
    if (!text) {
      old?.el.remove();
      tags.delete(key);
      return;
    }
    const el = old?.el ?? document.createElement('div');
    el.className = 'tb-tag ' + cls;
    el.textContent = text;
    if (!old) overlay.appendChild(el);
    tags.set(key, { el, at, dy });
  };
  ctx.setTag = setTag;
}

/** Post-processing (bloom, outline), shader pre-link and resize. */
export function mountPost(ctx: BenchCtx): void {
  const { container, renderer, scene, camera } = ctx;
  const composer = new EffectComposer(renderer);
  ctx.composer = composer;
  composer.addPass(new RenderPass(scene, camera));
  // Bloom picks emitters by a brightness threshold, no separate glow pass. Without tone mapping, white background and lit white parts
  // reach linear 1.0–1.4, so the threshold must be above that; RGB (×7) and LED lens (×6) HDR brightness is far over 1.8
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.35, 1.8);
  ctx.bloom = bloom;
  composer.addPass(bloom);
  const outline = new OutlinePass(new THREE.Vector2(256, 256), scene, camera);
  ctx.outline = outline;
  outline.visibleEdgeColor.set(ACCENT);
  outline.hiddenEdgeColor.set(0x0a5fa8);
  outline.edgeStrength = 5;
  outline.edgeThickness = 1.2;
  outline.edgeGlow = 0;
  outline.enabled = false;
  composer.addPass(outline);
  composer.addPass(new OutputPass());
  const sw = shaderWarm(renderer, scene, camera, composer);
  ctx.sw = sw;
  sw.warm();

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ctx.ro = ro;
  ro.observe(container);
  resize();
}

/** Render loop: part animation, LEDs, waves and frame timing. */
export function mountLoop(ctx: BenchCtx): void {
  const { container, renderer, camera, controls, tags, composer, bloom, sw, heat } = ctx;
  // ---------------------------------------------------------------- render loop

  ctx.usbHost = null;
  ctx.raf = 0;
  ctx.rgbPeak = 0;
  ctx.frameMs = 16.7;
  ctx.cpuMs = 0;
  let lastT = performance.now();
  const lastInfo = { calls: 0, triangles: 0 };
  ctx.lastInfo = lastInfo;
  const tmp = new THREE.Vector3();
  const tick = () => {
    ctx.raf = requestAnimationFrame(tick);
    const t0 = performance.now();
    ctx.frameMs = ctx.frameMs * 0.9 + (t0 - lastT) * 0.1;
    lastT = t0;
    // Short on/off transition, like a real LED as seen by the eye
    let glow = ctx.rgbPeak > 0;
    for (const l of ctx.leds) {
      l.now += (l.target - l.now) * 0.55;
      l.lens.emissiveIntensity = l.now * 6;
      l.light.intensity = l.now * 60;
      if (l.now > 0.02) glow = true;
    }
    // Servo speed is limited (SG90 ≈ 0.1 s / 60°): the horn chases the target angle
    for (const sv of ctx.servos) {
      // Use the dynamics angle (setServoAngle) when present; otherwise chase the PWM target at the speed limit
      const step = sv.phys ? 360 : 600 / 60;
      sv.angle += Math.max(-step, Math.min(step, sv.target - sv.angle));
      sv.horn.rotation.y = ((sv.angle - 90) * Math.PI) / 180;
    }
    // Buzzer sounding: diaphragm bobs + waves expand (illustrative; real vibration is kHz and invisible)
    for (const bz of ctx.buzzers) {
      bz.waves.visible = bz.on;
      if (!bz.on) {
        bz.membrane.position.y = bz.membrane.userData.y0 ??= bz.membrane.position.y;
        continue;
      }
      const ph = (t0 / 600) % 1;
      bz.waves.scale.setScalar(0.85 + ph * 0.4);
      bz.waveMat.opacity = 0.85 * (1 - ph);
      bz.membrane.userData.y0 ??= bz.membrane.position.y;
      bz.membrane.position.y = bz.membrane.userData.y0 + 0.12 * Math.sin(t0 / 25);
    }
    // Ultrasonic: three arcs expand from the transmitter on each measurement, fading over 0.4 s (illustrative)
    if (ctx.sonar) {
      const ph = (t0 - ctx.sonar.pingT) / 400;
      ctx.sonar.waves.visible = ph >= 0 && ph < 1;
      if (ctx.sonar.waves.visible) {
        ctx.sonar.waves.scale.setScalar(0.6 + ph * 1.2);
        ctx.sonar.waveMat.opacity = 0.8 * (1 - ph);
      }
    }
    // Speaker: cone moves with volume (illustrative, real excursion is invisible at audio rates), waves while sounding; mic input lights a ring over the hole
    for (const sp of ctx.speakers) {
      const on = ctx.spkLevel > 0.005;
      sp.waves.visible = on;
      sp.cone.position.y = on ? Math.min(1.2, ctx.spkLevel * 2.5) * Math.sin(t0 / 22) : 0;
      if (on) {
        const ph = (t0 / 700) % 1;
        sp.waves.scale.setScalar(0.85 + ph * 0.45);
        sp.waveMat.opacity = Math.min(1, 0.4 + ctx.spkLevel * 2) * (1 - ph);
      }
    }
    for (const mc of ctx.mics) {
      mc.ring.visible = ctx.micLevel > 0.005;
      mc.ringMat.opacity = Math.min(0.95, 0.3 + ctx.micLevel * 2) * (0.6 + 0.4 * Math.sin(t0 / 120));
    }
    if (heat.visible) {
      const k = 1 + 0.06 * Math.sin(t0 / 260);
      heat.scale.set(ctx.heatBase * k, ctx.heatBase * k, 1);
    }
    controls.update();
    // Skip bloom when nothing glows (saves 5 blur levels)
    bloom.enabled = glow;
    renderer.info.reset();
    if (!sw.warming()) composer.render();
    lastInfo.calls = renderer.info.render.calls;
    lastInfo.triangles = renderer.info.render.triangles;
    // DOM tags follow their 3D positions
    if (tags.size) {
      const w = container.clientWidth, h = container.clientHeight;
      for (const { el, at, dy } of tags.values()) {
        const p = at();
        if (!p) {
          el.style.display = 'none';
          continue;
        }
        tmp.copy(p).project(camera);
        const vis = tmp.z > -1 && tmp.z < 1;
        el.style.display = vis ? '' : 'none';
        el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h + dy}px) translate(-50%, -100%)`;
      }
    }
    ctx.cpuMs = ctx.cpuMs * 0.9 + (performance.now() - t0) * 0.1;
  };
  tick();
}
