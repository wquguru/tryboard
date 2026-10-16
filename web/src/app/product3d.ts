// ④ 成品的 3D 场景（独立于实验台的 board3d.ts）：桌上的气象站。
// 外壳 70×50×32 mm（与装配模版一致，单位 cm），表盘指针跟 GPIO4 的 PWM（二阶缓动，像真舵机那样有惯性），
// OLED 帧缓冲作纹理，板载 RGB 透过导光柱发光（自发光 + bloom + 点光源照亮桌面），顶上的 BOOT 键能点，
// 右侧通风口旁可以放一个热源（拖动它，离通风口越近传感器越热）。数据全部来自同一个实时模拟。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { servoAngle } from '../views/common';
import { currentTheme, onTheme, type Theme } from '../theme';

export interface ProductFrame {
  pwm: number[];
  rgb: number[] | null;
  oled: Uint8Array | null;
  running: boolean;
}

export interface ProductOptions {
  frame(): ProductFrame;
  servoPin: number;
  /** 蜂鸣器此刻在不在响（只用来画声波圈，声音本身由 audio.ts 出） */
  sounding(): boolean;
  onBoot(down: boolean): void;
  /** 热源开关或移动：proximity 0..1（1 = 贴着通风口） */
  onHeat(on: boolean, proximity: number): void;
}

export interface ProductScene {
  start(): void;
  stop(): void;
  dispose(): void;
  setHeat(on: boolean): void;
  readonly heatOn: boolean;
  proximity(): number;
  /** BOOT 键在页面上的位置（clientX/Y），给测试用真实鼠标去按 */
  buttonScreenPos(): [number, number] | null;
  /** 相机方位角（度），测试用来确认拖动后角度变了 */
  azimuth(): number;
  resetView(): void;
  /** 指针当前角度（°，0 = 0 ℃ 一侧） */
  needle(): number;
}

const W = 5.0, H = 7.0, D = 3.2;
const FRONT = D / 2;
const PIVOT = new THREE.Vector3(0, 4.7, FRONT + 0.06);
const VENT = new THREE.Vector3(W / 2, 3.4, 0);
const PARK = new THREE.Vector3(8.5, 0, 3.5);
const NEAR = new THREE.Vector3(5.2, 0, 0.4);

function dialTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 560;
  const g = c.getContext('2d')!;
  const cx = 512, cy = 500, R = 480;
  g.fillStyle = '#17181A';
  // 半圆表盘下面多留一条底边，0 和 40 的刻度字落在深色底上
  g.beginPath();
  g.arc(cx, cy, R, Math.PI, 0);
  g.lineTo(cx + R, cy + 36);
  g.lineTo(cx - R, cy + 36);
  g.closePath();
  g.fill();
  // 28 ℃ 以上的红色区（彩灯变红、30 ℃ 报警）
  g.strokeStyle = '#F24822';
  g.lineWidth = 18;
  g.beginPath();
  g.arc(cx, cy, R - 40, Math.PI + (28 / 40) * Math.PI, 2 * Math.PI);
  g.stroke();
  g.strokeStyle = '#2E7BD6';
  g.beginPath();
  g.arc(cx, cy, R - 40, Math.PI, Math.PI + (18 / 40) * Math.PI);
  g.stroke();
  g.strokeStyle = '#F2EFE8';
  g.fillStyle = '#F2EFE8';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let t = 0; t <= 40; t++) {
    const a = Math.PI + (t / 40) * Math.PI;
    const major = t % 10 === 0;
    const r1 = R - 60, r2 = major ? R - 120 : t % 5 === 0 ? R - 100 : R - 84;
    g.lineWidth = major ? 7 : 3;
    g.beginPath();
    g.moveTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
    g.lineTo(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a));
    g.stroke();
    if (major) {
      g.font = '600 52px "JetBrains Mono", ui-monospace, monospace';
      g.fillText(String(t), cx + (R - 175) * Math.cos(a), cy + (R - 175) * Math.sin(a) - (t === 0 || t === 40 ? 26 : 0));
    }
  }
  g.font = '500 44px "Noto Sans SC", sans-serif';
  g.fillStyle = '#8C8C8C';
  g.fillText('℃', cx, cy - 190);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createProduct3D(container: HTMLElement, o: ProductOptions): ProductScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';

  const scene = new THREE.Scene();
  // 背景与桌面跟随页面主题（DESIGN §2 暗色）；成品本身的材质颜色不变
  const BG = { light: '#EEF1F5', dark: '#1D2024' }, DESK = { light: '#E4E8EE', dark: '#2A2D32' };
  const bgColor = new THREE.Color(BG[currentTheme()]);
  scene.background = bgColor;
  scene.fog = new THREE.Fog(bgColor, 30, 60);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  const HOME = new THREE.Vector3(13, 10.5, 24);
  const TARGET = new THREE.Vector3(2.2, 3.0, 0);
  camera.position.copy(HOME);

  // 光：一盏主光投影 + 天光
  const sun = new THREE.DirectionalLight('#FFFFFF', 1.25);
  sun.position.set(-6, 14, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0005;
  scene.add(sun, new THREE.HemisphereLight('#FFFFFF', '#C9CED6', 0.35));

  // 桌面
  const desk = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: DESK[currentTheme()], roughness: 0.92 }));
  const applyTheme = (t: Theme) => {
    bgColor.set(BG[t]);
    scene.fog!.color.set(BG[t]);
    (desk.material as THREE.MeshStandardMaterial).color.set(DESK[t]);
  };
  const offTheme = onTheme(applyTheme);
  desk.rotation.x = -Math.PI / 2;
  desk.receiveShadow = true;
  scene.add(desk);

  const station = new THREE.Group();
  scene.add(station);
  // 外壳：圆角盒，微磨砂塑料（PBR）
  const shellMat = new THREE.MeshPhysicalMaterial({ color: '#ECE9E2', roughness: 0.55, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.5 });
  const shell = new THREE.Mesh(new RoundedBoxGeometry(W, H, D, 6, 0.55), shellMat);
  shell.position.y = H / 2;
  shell.castShadow = shell.receiveShadow = true;
  station.add(shell);
  // 表盘
  const dial = new THREE.Mesh(new THREE.PlaneGeometry(4.3, 4.3 * (560 / 1024)), new THREE.MeshStandardMaterial({ map: dialTexture(), roughness: 0.4, transparent: true }));
  dial.position.set(0, PIVOT.y + 4.3 * ((500 - 280) / 1024), FRONT + 0.012);
  station.add(dial);
  const needle = new THREE.Group();
  needle.position.copy(PIVOT);
  const needleMat = new THREE.MeshStandardMaterial({ color: '#FF7A1A', roughness: 0.35, emissive: '#FF5A00', emissiveIntensity: 0.25 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.07, 0.04), needleMat);
  blade.position.x = 0.75;
  blade.castShadow = true;
  needle.add(blade);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 24), new THREE.MeshStandardMaterial({ color: '#F2EFE8', roughness: 0.3 }));
  hub.rotation.x = Math.PI / 2;
  needle.add(hub);
  station.add(needle);

  // OLED：黑色模组框 + 帧缓冲纹理（自发光，不受灯光影响）
  const bezel = new THREE.Mesh(new RoundedBoxGeometry(3.5, 1.95, 0.12, 3, 0.08), new THREE.MeshStandardMaterial({ color: '#0B0C0E', roughness: 0.55, metalness: 0.1 }));
  bezel.position.set(0, 2.7, FRONT + 0.02);
  station.add(bezel);
  const oledData = new Uint8Array(128 * 64 * 4);
  const oledTex = new THREE.DataTexture(oledData, 128, 64, THREE.RGBAFormat);
  oledTex.magFilter = THREE.NearestFilter;
  oledTex.minFilter = THREE.LinearFilter;
  oledTex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({ map: oledTex, toneMapped: false });
  screenMat.color.setScalar(1.15);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.04, 1.52), screenMat);
  screen.position.set(0, 2.7, FRONT + 0.085);
  station.add(screen);

  // 板载 RGB 透过导光柱：自发光 + bloom + 点光源照亮前面板和桌面
  const pipeMat = new THREE.MeshStandardMaterial({ color: '#F4F4F2', roughness: 0.3, emissive: '#000000', emissiveIntensity: 1 });
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 32), pipeMat);
  pipe.rotation.x = Math.PI / 2;
  pipe.position.set(0, 0.85, FRONT + 0.04);
  station.add(pipe);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.04, 12, 40), new THREE.MeshStandardMaterial({ color: '#BDB9B0', roughness: 0.4 }));
  ring.position.copy(pipe.position);
  station.add(ring);
  const ledLight = new THREE.PointLight('#00FF00', 0, 7, 1.6);
  ledLight.position.set(0, 0.6, FRONT + 0.7);
  station.add(ledLight);

  // 右侧通风口
  const slotMat = new THREE.MeshStandardMaterial({ color: '#3A3936', roughness: 0.9 });
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.16, 1.9, 2, 0.03), slotMat);
    s.position.set(W / 2 + 0.005, 2.4 + i * 0.42, 0);
    station.add(s);
  }
  // 左侧蜂鸣器出声孔
  const holeMat = new THREE.MeshStandardMaterial({ color: '#2A2A28', roughness: 0.9 });
  for (let i = 0; i < 7; i++) {
    const a = (i / 6) * Math.PI * 2;
    const r = i === 6 ? 0 : 0.32;
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 12), holeMat);
    h.rotation.z = Math.PI / 2;
    h.position.set(-W / 2 - 0.005, 2.0 + r * Math.sin(a), r * Math.cos(a));
    station.add(h);
  }
  const waves: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const w = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.03, 8, 48), new THREE.MeshBasicMaterial({ color: '#0D99FF', transparent: true, opacity: 0 }));
    w.rotation.y = Math.PI / 2;
    w.position.set(-W / 2 - 0.3, 2.0, 0);
    station.add(w);
    waves.push(w);
  }

  // 顶部 BOOT 键 + 提示圈
  const keyMat = new THREE.MeshStandardMaterial({ color: '#C9C6BF', roughness: 0.5 });
  const key = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.24, 0.6, 3, 0.1), keyMat);
  const KEY_Y = H + 0.08;
  key.position.set(1.35, KEY_Y, 0.4);
  key.castShadow = true;
  station.add(key);
  const keyHit = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 1.3), new THREE.MeshBasicMaterial({ visible: false }));
  keyHit.position.copy(key.position);
  station.add(keyHit);
  const hint = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.8, 48), new THREE.MeshBasicMaterial({ color: '#FF7A1A', transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  hint.rotation.x = -Math.PI / 2;
  hint.position.set(1.35, H + 0.02, 0.4);
  station.add(hint);

  // USB-C 线从背后出
  const cable = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.8, -FRONT), new THREE.Vector3(0, 0.7, -FRONT - 1.2), new THREE.Vector3(0.6, 0.12, -FRONT - 3), new THREE.Vector3(3, 0.12, -FRONT - 9)]), 40, 0.12, 10),
    new THREE.MeshStandardMaterial({ color: '#1E1E1E', roughness: 0.6 }),
  );
  cable.castShadow = true;
  station.add(cable);

  // 热源：小暖风机，出风口对着气象站
  const heater = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 1.9, 40), new THREE.MeshPhysicalMaterial({ color: '#C8463A', roughness: 0.45, clearcoat: 0.4 }));
  body.rotation.z = Math.PI / 2;
  body.position.y = 1.1;
  body.castShadow = true;
  heater.add(body);
  const foot = new THREE.Mesh(new RoundedBoxGeometry(1.6, 0.25, 1.4, 2, 0.08), new THREE.MeshStandardMaterial({ color: '#2A2A28', roughness: 0.7 }));
  foot.position.y = 0.12;
  foot.castShadow = true;
  heater.add(foot);
  const grilleMat = new THREE.MeshStandardMaterial({ color: '#3A2A22', emissive: '#FF6A00', emissiveIntensity: 0, roughness: 0.6 });
  const grille = new THREE.Mesh(new THREE.CircleGeometry(0.72, 40), grilleMat);
  grille.rotation.y = -Math.PI / 2;
  grille.position.set(-0.96, 1.1, 0);
  heater.add(grille);
  for (let i = -2; i <= 2; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 1.3), new THREE.MeshStandardMaterial({ color: '#1E1E1E' }));
    bar.position.set(-0.98, 1.1 + i * 0.25, 0);
    heater.add(bar);
  }
  const heatLight = new THREE.PointLight('#FF7A2A', 0, 7, 1.5);
  heatLight.position.set(-1.6, 1.2, 0);
  heater.add(heatLight);
  const heatHit = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.4, 2.2), new THREE.MeshBasicMaterial({ visible: false }));
  heatHit.position.y = 1.1;
  heater.add(heatHit);
  heater.position.copy(PARK);
  scene.add(heater);

  // 标签（HTML 叠加，跟着 3D 位置走）
  const tags = document.createElement('div');
  tags.className = 'p3-tags';
  const tag = (text: string, cls = '') => {
    const t = document.createElement('div');
    t.className = 'p3-tag ' + cls;
    t.textContent = text;
    tags.appendChild(t);
    return t;
  };
  const tagKey = tag('BOOT · 点一下换 ℃/℉', 'hot');
  const tagVent = tag('通风口');
  const tagHeat = tag('热源 · 可拖动');
  const corner = document.createElement('div');
  corner.className = 'p3-disclaimer';
  corner.textContent = '外观示意，非乐鑫官方模型';
  container.append(tags, corner);

  // 交互：我们的 pointerdown 先于 OrbitControls 注册，点到键 / 热源时先关掉旋转
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let pressing = false;
  let dragging = false;
  let heatOn = false;
  const heatTarget = PARK.clone();
  const toNdc = (e: PointerEvent) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    toNdc(e);
    if (ray.intersectObject(keyHit).length) {
      pressing = true;
      controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      o.onBoot(true);
      return;
    }
    if (ray.intersectObject(heatHit).length) {
      dragging = true;
      controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
      if (!heatOn) setHeat(true, false);
    }
  });
  el.addEventListener('pointermove', (e) => {
    toNdc(e);
    if (dragging) {
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(floorPlane, p)) {
        // 不能推进壳里：离外壳表面至少 1.2 cm
        p.x = Math.max(-14, Math.min(14, p.x));
        p.z = Math.max(-10, Math.min(10, p.z));
        const dx = Math.max(Math.abs(p.x) - (W / 2 + 1.2), 0), dz = Math.max(Math.abs(p.z) - (D / 2 + 1.2), 0);
        if (dx === 0 && dz === 0) p.x = Math.sign(p.x || 1) * (W / 2 + 1.2);
        heatTarget.set(p.x, 0, p.z);
        heater.position.copy(heatTarget);
        o.onHeat(heatOn, proximity());
      }
      return;
    }
    if (!pressing) el.style.cursor = ray.intersectObjects([keyHit, heatHit]).length ? 'pointer' : 'grab';
  });
  const up = () => {
    if (pressing) {
      pressing = false;
      o.onBoot(false);
    }
    if (dragging) {
      dragging = false;
      el.style.cursor = 'grab';
    }
    controls.enabled = true;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  const controls = new OrbitControls(camera, el);
  controls.target.copy(TARGET);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.enablePan = false;
  controls.minDistance = 9;
  controls.maxDistance = 36;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.update();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.2, 1.25);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    // 竖屏 / 窄容器时退远一点，整个成品放得下
    camera.fov = w / h < 1 ? 44 : 32;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  function proximity() {
    const d = Math.hypot(heater.position.x - VENT.x, heater.position.z - VENT.z);
    return Math.max(0, Math.min(1, 1 - (d - 2.7) / 7));
  }
  function setHeat(on: boolean, move = true) {
    heatOn = on;
    if (move) heatTarget.copy(on ? NEAR : PARK);
    o.onHeat(on, on ? (move ? 1 - (Math.hypot(NEAR.x - VENT.x, NEAR.z - VENT.z) - 2.7) / 7 : proximity()) : 0);
  }

  // 指针：二阶系统（弹簧 + 阻尼）追目标角度，再限速 600°/s（SG90 约 0.1 s / 60°）
  let theta = 0, omega = 0;
  let lastOled: Uint8Array | null = null;
  let raf = 0;
  let last = performance.now();
  const ledColor = new THREE.Color();
  const v = new THREE.Vector3();
  const occRay = new THREE.Raycaster();
  /** 标签挡在外壳 / 热源后面时藏起来，免得隔着壳子看见"通风口" */
  function hidden(p: THREE.Vector3) {
    const dir = p.clone().sub(camera.position);
    const dist = dir.length();
    occRay.set(camera.position, dir.normalize());
    occRay.far = dist - 0.4;
    return occRay.intersectObjects([shell, body], false).length > 0;
  }
  function place(t: HTMLElement, p: THREE.Vector3, dx = 0, dy = 0) {
    v.copy(p).project(camera);
    const vis = v.z < 1 && !hidden(p);
    t.style.display = vis ? '' : 'none';
    t.style.transform = `translate(${((v.x + 1) / 2) * container.clientWidth + dx}px, ${((1 - v.y) / 2) * container.clientHeight + dy}px) translate(-50%, -50%)`;
  }
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const f = o.frame();
    const a = servoAngle(f.pwm, o.servoPin);
    const target = a ?? theta;
    const k = 90, c = 2 * Math.sqrt(k) * 0.8;
    omega += (k * (target - theta) - c * omega) * dt;
    omega = Math.max(-600, Math.min(600, omega));
    theta += omega * dt;
    needle.rotation.z = Math.PI - (theta * Math.PI) / 180;

    if (f.oled && f.oled !== lastOled) {
      lastOled = f.oled;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 128; x++) {
          const on = f.oled[y * 128 + x] > 0;
          const i = ((63 - y) * 128 + x) * 4;
          oledData[i] = on ? 200 : 4;
          oledData[i + 1] = on ? 236 : 6;
          oledData[i + 2] = on ? 255 : 10;
          oledData[i + 3] = 255;
        }
      oledTex.needsUpdate = true;
    }

    const rgb = f.running ? f.rgb : null;
    const m = rgb ? Math.max(...rgb) : 0;
    if (rgb && m > 0) {
      // 固件常把亮度压很低（0x20）：按最大通道放大到可见，亮度本身不能模拟（见"不能模拟的项"）
      ledColor.setRGB(rgb[0] / m, rgb[1] / m, rgb[2] / m, THREE.SRGBColorSpace);
      pipeMat.emissive.copy(ledColor);
      pipeMat.emissiveIntensity = 4;
      ledLight.color.copy(ledColor);
      ledLight.intensity = 1.6;
    } else {
      pipeMat.emissiveIntensity = 0;
      ledLight.intensity = 0;
    }

    heater.position.lerp(heatTarget, dragging ? 1 : 1 - Math.exp(-dt * 6));
    if (!dragging && heater.position.distanceTo(heatTarget) > 0.01) o.onHeat(heatOn, proximity());
    grilleMat.emissiveIntensity += ((heatOn ? 3.5 : 0) - grilleMat.emissiveIntensity) * (1 - Math.exp(-dt * 3));
    heatLight.intensity = grilleMat.emissiveIntensity * 1.2;

    const snd = o.sounding();
    waves.forEach((w, i) => {
      const ph = ((now / 600 + i / 3) % 1);
      const mat = w.material as THREE.MeshBasicMaterial;
      mat.opacity = snd ? 0.55 * (1 - ph) : Math.max(0, mat.opacity - dt * 2);
      w.scale.setScalar(0.5 + ph * 1.4);
      w.position.x = -W / 2 - 0.3 - ph * 0.9;
    });
    key.position.y = pressing ? KEY_Y - 0.1 : KEY_Y;
    keyMat.color.set(pressing ? '#FF7A1A' : '#C9C6BF');
    (hint.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(now / 300));

    controls.update();
    composer.render();
    place(tagKey, new THREE.Vector3(1.35, H + 0.9, 0.4));
    place(tagVent, new THREE.Vector3(W / 2 + 0.2, 5.4, 0.6), 34, 0);
    place(tagHeat, new THREE.Vector3(heater.position.x, 2.6, heater.position.z));
  }

  return {
    start() {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      up();
    },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      offTheme();
      ro.disconnect();
      controls.dispose();
      composer.dispose();
      renderer.dispose();
      pmrem.dispose();
      container.replaceChildren();
    },
    setHeat: (on) => setHeat(on),
    get heatOn() {
      return heatOn;
    },
    proximity,
    buttonScreenPos() {
      v.copy(key.position).project(camera);
      if (v.z > 1) return null;
      const r = renderer.domElement.getBoundingClientRect();
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    },
    azimuth: () => (controls.getAzimuthalAngle() * 180) / Math.PI,
    resetView() {
      camera.position.copy(HOME);
      controls.target.copy(TARGET);
      controls.update();
    },
    needle: () => theta,
  };
}
