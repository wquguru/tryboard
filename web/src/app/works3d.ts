// ④ P2-09 三个新作品的 3D 成品（与 product3d.ts 的气象站同一套舞台：WebGL + RoomEnvironment + bloom，单位 cm）：
//   lamp  旋钮台灯：灯座 + 导光柱上的 8 颗 WS2812 + 乳白灯罩，前面一个 EC11 旋钮（拖 / 滚 = 转，点 = 按）
//   ruler 超声波尺子：蓝色手持外壳、顶面 OLED、前面两个探头；桌上一块可拖动的木挡板，桌面画着刻度
//   tilt  体感小人：圆盘外壳顶面一块圆屏，拖动圆盘让它倾斜（俯仰 / 横滚），屏上的小豆往低处滑
// 灯色、OLED、圆屏、蜂鸣器全部来自同一个实时模拟；装法影响（灯罩亮点、探头被挡、六轴装反）由调用方从组装结果传进来。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { currentTheme, onTheme, type Theme } from '../theme';
import type { Pose } from '../imupose';
import { capturableOf, type Capturable } from './capture';

export type WorkKind = 'lamp' | 'ruler' | 'tilt';

export interface WorkFrame {
  pwm: number[];
  strips?: Record<number, number[][]>;
  oled: Uint8Array | null;
  lcd: Uint8Array | null;
  running: boolean;
}

export interface WorkProductOptions {
  kind: WorkKind;
  frame(): WorkFrame;
  effects(): { glare?: boolean; sonarBlock?: number; imuFlip?: boolean };
  /** 蜂鸣器此刻在不在响（只用来画声波圈） */
  sounding(): boolean;
  /** lamp：旋钮转了几格（正 = 顺时针）、按下 / 松开 */
  onKnob?(steps: number): void;
  onKnobPress?(down: boolean): void;
  /** ruler：挡板离探头正面的距离（cm）；起始距离 */
  onDistance?(cm: number): void;
  distance?: number;
  /** tilt：圆盘姿态（度）；起始姿态 */
  onPose?(p: Pose): void;
  pose?: Pose;
}

export interface WorkProduct3D {
  start(): void;
  stop(): void;
  dispose(): void;
  azimuth(): number;
  resetView(): void;
  /** 可以拖的那样东西（旋钮 / 挡板 / 圆盘）在页面上的位置，测试用真实鼠标去拖 */
  handleScreenPos(): [number, number] | null;
  /** 当前状态（测试 / 面板用）：旋钮格数、挡板距离、圆盘姿态 */
  state(): { knob: number; cm: number; pose: Pose };
  setDistance(cm: number): void;
  setPose(p: Pose): void;
  /** 拍照 / 录像（P2-10） */
  capture(): Capturable;
}

const STRIP_PIN = 5;

/** 灯珠颜色 → 发光色（按最大通道归一化，亮度另算） */
function glow(c: number[] | undefined) {
  const m = c ? Math.max(...c) : 0;
  return { m, col: new THREE.Color(m ? c![0] / m : 0, m ? c![1] / m : 0, m ? c![2] / m : 0) };
}

function oledTexture() {
  const data = new Uint8Array(128 * 64 * 4);
  const tex = new THREE.DataTexture(data, 128, 64, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, data };
}
function lcdTexture() {
  const data = new Uint8Array(240 * 240 * 4);
  const tex = new THREE.DataTexture(data, 240, 240, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  // 数据按行从上到下：用纹理矩阵翻转 v
  tex.repeat.set(1, -1);
  tex.offset.set(0, 1);
  tex.needsUpdate = true;
  return { tex, data };
}

/** 桌面刻度尺（ruler 用）：0–80 cm，每 1 cm 一小格、每 10 cm 一个数字 */
function tapeTexture() {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = '#F2D45C';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#1E1E1E';
  g.font = '600 30px "JetBrains Mono", ui-monospace, monospace';
  g.textAlign = 'center';
  for (let cm = 0; cm <= 80; cm++) {
    const x = (cm / 80) * (c.width - 40) + 20;
    const h = cm % 10 === 0 ? 46 : cm % 5 === 0 ? 32 : 20;
    g.fillRect(x - 1.5, 0, 3, h);
    if (cm % 10 === 0) g.fillText(String(cm), x, 84);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createWork3D(container: HTMLElement, o: WorkProductOptions): WorkProduct3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';

  const scene = new THREE.Scene();
  const BG = { light: '#EEF1F5', dark: '#1D2024' }, DESK = { light: '#E4E8EE', dark: '#2A2D32' };
  const bgColor = new THREE.Color(BG[currentTheme()]);
  scene.background = bgColor;
  scene.fog = new THREE.Fog(bgColor, 160, 340);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  const sun = new THREE.DirectionalLight('#FFFFFF', 1.2);
  sun.position.set(-8, 16, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const S = o.kind === 'ruler' ? 30 : 14;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S });
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0005;
  scene.add(sun, new THREE.HemisphereLight('#FFFFFF', '#C9CED6', 0.35));
  const desk = new THREE.Mesh(new THREE.CircleGeometry(120, 64), new THREE.MeshStandardMaterial({ color: DESK[currentTheme()], roughness: 0.92 }));
  desk.rotation.x = -Math.PI / 2;
  desk.receiveShadow = true;
  scene.add(desk);
  const offTheme = onTheme((t: Theme) => {
    bgColor.set(BG[t]);
    scene.fog!.color.set(BG[t]);
    (desk.material as THREE.MeshStandardMaterial).color.set(DESK[t]);
  });

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
  const VIEW: Record<WorkKind, { home: THREE.Vector3; target: THREE.Vector3; min: number; max: number }> = {
    lamp: { home: new THREE.Vector3(17, 15, 36), target: new THREE.Vector3(0, 5.2, 0), min: 14, max: 60 },
    ruler: { home: new THREE.Vector3(8, 44, 80), target: new THREE.Vector3(17, 1.5, 0), min: 14, max: 120 },
    tilt: { home: new THREE.Vector3(0, 17, 17), target: new THREE.Vector3(0, 2.6, 0), min: 9, max: 40 },
  };
  const V = VIEW[o.kind];
  camera.position.copy(V.home);

  // 标签叠加层
  const tags = document.createElement('div');
  tags.className = 'p3-tags';
  const tag = (text: string, cls = '') => {
    const t = document.createElement('div');
    t.className = 'p3-tag ' + cls;
    t.textContent = text;
    tags.appendChild(t);
    return t;
  };
  const corner = document.createElement('div');
  corner.className = 'p3-disclaimer';
  corner.textContent = o.kind === 'tilt' ? '外观示意，非乐鑫官方模型 · 小豆为原创形象' : '外观示意，非乐鑫官方模型';
  container.append(tags, corner);

  const shellMat = (color: string) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.5 });
  const hits: THREE.Object3D[] = [];
  const occluders: THREE.Object3D[] = [];
  const tagList: { el: HTMLElement; at: () => THREE.Vector3; dx?: number; dy?: number }[] = [];
  /** 每帧的作品专属更新 */
  let tick: (f: WorkFrame, dt: number, now: number) => void = () => {};
  /** 指针：返回 true 表示这次按下归我们处理（关掉旋转） */
  let onDown: (hit: THREE.Object3D, e: PointerEvent) => boolean = () => false;
  let onMove: (e: PointerEvent) => void = () => {};
  let onUp: () => void = () => {};
  let onWheel: (hit: THREE.Object3D, dy: number) => boolean = () => false;
  let handle: THREE.Object3D | null = null;
  let knobCount = 0;
  let cm = o.distance ?? 25;
  let pose: Pose = { ...(o.pose ?? { pitch: 0, roll: 0, yaw: 0 }) };
  let setDistance = (_: number) => {};
  let setPose = (_: Pose) => {};

  // 蜂鸣器声波圈（ruler）
  const waves: THREE.Mesh[] = [];

  if (o.kind === 'lamp') {
    // 灯座 8 × 6 × 3.6 cm；导光柱在中间，8 颗灯珠竖着排在柱子前面；灯罩是旋转体
    const base = new THREE.Mesh(new RoundedBoxGeometry(8, 3.6, 6, 5, 0.6), shellMat('#3A3936'));
    base.position.y = 1.8;
    base.castShadow = base.receiveShadow = true;
    scene.add(base);
    occluders.push(base);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 5.6, 32), new THREE.MeshPhysicalMaterial({ color: '#F2F0EA', roughness: 0.25, transmission: 0.3, thickness: 0.4 }));
    pipe.position.set(0, 3.6 + 2.8, 0);
    scene.add(pipe);
    const leds: THREE.MeshStandardMaterial[] = [];
    const ledMeshes: THREE.Mesh[] = [];
    for (let i = 0; i < 8; i++) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.15), new THREE.MeshStandardMaterial({ color: '#F2F0EA', roughness: 0.6 }));
      frame.position.set(0, 4.0 + i * 0.62, 0.62);
      scene.add(frame);
      const m = new THREE.MeshStandardMaterial({ color: '#DEDBD2', emissive: '#000000', emissiveIntensity: 1, roughness: 0.3 });
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.19, 20), m);
      lens.position.set(0, 4.0 + i * 0.62, 0.7);
      scene.add(lens);
      leds.push(m);
      ledMeshes.push(lens);
    }
    // 灯罩：乳白 PLA，钟形旋转体（底 Ø7.0，高 7.6），半透明
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      prof.push(new THREE.Vector2(3.5 - 1.6 * Math.pow(t, 1.6) - (t > 0.92 ? (t - 0.92) * 18 : 0), 3.7 + t * 7.6));
    }
    const shadeMat = new THREE.MeshPhysicalMaterial({ color: '#F4F1EA', roughness: 0.65, transmission: 0.55, thickness: 0.3, transparent: true, opacity: 0.88, emissive: '#000000', emissiveIntensity: 1, side: THREE.DoubleSide });
    const shade = new THREE.Mesh(new THREE.LatheGeometry(prof, 72), shadeMat);
    shade.castShadow = true;
    scene.add(shade);
    const shadeLight = new THREE.PointLight('#FFFFFF', 0, 40, 1.6);
    shadeLight.position.set(0, 6.5, 0);
    scene.add(shadeLight);
    // 装法 B：灯条贴着灯罩内壁——罩子正面一排 8 个亮点
    const spots: THREE.Mesh[] = [];
    const spotMats: THREE.MeshBasicMaterial[] = [];
    for (let i = 0; i < 8; i++) {
      const y = 4.4 + i * 0.75;
      const t = (y - 3.7) / 7.6;
      const r = 3.5 - 1.6 * Math.pow(t, 1.6) + 0.02;
      // 亮点画在灯罩外表面、最后画、亮度超过 1 让 bloom 晕开（刺眼）
      const mat = new THREE.MeshBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
      const s = new THREE.Mesh(new THREE.CircleGeometry(0.3, 20), mat);
      s.renderOrder = 10;
      s.position.set(0, y, r + 0.03);
      scene.add(s);
      spots.push(s);
      spotMats.push(mat);
    }
    // 旋钮：灯座正面右侧，轴朝前（+z）；拖 / 滚转，点按
    const knob = new THREE.Group();
    const kmat = new THREE.MeshStandardMaterial({ color: '#1B1D21', roughness: 0.45, metalness: 0.3 });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.76, 1.1, 30), kmat);
    cap.rotation.x = Math.PI / 2;
    knob.add(cap);
    const ridges = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.06, 0.9), kmat, 30);
    const mm = new THREE.Matrix4();
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      ridges.setMatrixAt(i, new THREE.Matrix4().makeTranslation(Math.cos(a) * 0.74, Math.sin(a) * 0.74, 0).multiply(mm.makeRotationZ(a)));
    }
    knob.add(ridges);
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.4, 0.02), new THREE.MeshBasicMaterial({ color: '#F2F2F2' }));
    mark.position.set(0, 0.4, 0.56);
    knob.add(mark);
    const KNOB_Z = 3 + 0.55;
    knob.position.set(2.3, 1.8, KNOB_Z);
    knob.traverse((x) => (x.castShadow = true));
    scene.add(knob);
    const knobHit = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 1.6, 16), new THREE.MeshBasicMaterial({ visible: false }));
    knobHit.rotation.x = Math.PI / 2;
    knobHit.position.copy(knob.position);
    scene.add(knobHit);
    hits.push(knobHit);
    handle = knobHit;
    const hint = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.08, 48), new THREE.MeshBasicMaterial({ color: '#FF7A1A', transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    hint.position.set(2.3, 1.8, 3.02);
    scene.add(hint);
    // DC 线从背后出
    const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-2, 1, -3), new THREE.Vector3(-2, 0.8, -4.2), new THREE.Vector3(-1.4, 0.12, -6), new THREE.Vector3(1, 0.12, -12)]), 40, 0.14, 10), new THREE.MeshStandardMaterial({ color: '#1E1E1E', roughness: 0.6 }));
    cable.castShadow = true;
    scene.add(cable);
    tagList.push({ el: tag('EC11 旋钮 · 拖 / 滚转，点一下切换模式', 'hot'), at: () => new THREE.Vector3(2.3, 0.2, KNOB_Z + 0.4), dy: 16 });
    tagList.push({ el: tag('WS2812 × 8 · 乳白灯罩'), at: () => new THREE.Vector3(-3.6, 9.5, 0), dx: -50 });

    let angle = 0;
    let press: { x: number; y: number; acc: number; moved: boolean } | null = null;
    const turn = (steps: number) => {
      if (!steps) return;
      knobCount += steps;
      o.onKnob?.(steps);
    };
    onDown = (hit, e) => {
      if (hit !== knobHit) return false;
      press = { x: e.clientX, y: e.clientY, acc: 0, moved: false };
      return true;
    };
    onMove = (e) => {
      if (!press) return;
      // 往右 / 往上拖 = 顺时针；每 16 px 一格
      const d = e.clientX - press.x - (e.clientY - press.y);
      press.x = e.clientX;
      press.y = e.clientY;
      press.acc += d;
      if (Math.abs(press.acc) > 4) press.moved = true;
      const steps = Math.trunc(press.acc / 16);
      if (steps) {
        press.acc -= steps * 16;
        turn(steps);
      }
    };
    onUp = () => {
      if (press && !press.moved) {
        o.onKnobPress?.(true);
        setTimeout(() => o.onKnobPress?.(false), 120);
        knob.position.z = KNOB_Z - 0.15;
        setTimeout(() => (knob.position.z = KNOB_Z), 140);
      }
      press = null;
    };
    onWheel = (hit, dy) => {
      if (hit !== knobHit) return false;
      turn(dy < 0 ? 1 : -1);
      return true;
    };
    const avg = new THREE.Color();
    tick = (f, dt, now) => {
      const strip = (f.running ? f.strips?.[STRIP_PIN] : undefined) ?? [];
      const glare = !!o.effects().glare;
      let peak = 0;
      const sum = [0, 0, 0];
      leds.forEach((m, i) => {
        const c = strip[i];
        const g = glow(c);
        peak = Math.max(peak, g.m);
        if (c) c.forEach((v, k) => (sum[k] += v));
        m.emissive.copy(g.col);
        // 固件写的是 0–255 的真实亮度：按亮度给发光强度（不像板载灯那样一律放大），台灯的"调亮度"才看得出来
        m.emissiveIntensity = g.m ? 1.5 + (g.m / 255) * 8 : 0;
        spotMats[i].color.copy(g.col).lerp(new THREE.Color('#FFFFFF'), 0.5).multiplyScalar(1.6 + (g.m / 255) * 2);
        spotMats[i].opacity = glare && g.m ? 1 : 0;
      });
      const sm = Math.max(...sum);
      avg.setRGB(sm ? sum[0] / sm : 0, sm ? sum[1] / sm : 0, sm ? sum[2] / sm : 0);
      const k = peak / 255;
      // 灯罩被里面的灯照亮：自发光（漫射后的颜色）+ 点光源照亮桌面；亮点装法时灯罩本身更暗、光不匀
      shadeMat.emissive.copy(avg);
      shadeMat.emissiveIntensity = peak ? (glare ? 0.08 + k * 0.3 : 0.3 + k * 1.4) : 0;
      shadeLight.color.copy(avg);
      shadeLight.intensity = k * 110;
      angle += ((knobCount * Math.PI) / 10 - angle) * (1 - Math.exp(-dt * 18));
      knob.rotation.z = -angle;
      (hint.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.4 * (0.5 + 0.5 * Math.sin(now / 300));
      void ledMeshes;
    };
  } else if (o.kind === 'ruler') {
    // 手持外壳 9 × 3 × 4.8 cm 平放；探头朝 +x；顶面 OLED；左侧出声孔
    const W = 9, H = 3, D = 4.8;
    const body = new THREE.Mesh(new RoundedBoxGeometry(W, H, D, 5, 0.6), shellMat('#2B5FD9'));
    body.position.set(0, H / 2, 0);
    body.castShadow = body.receiveShadow = true;
    scene.add(body);
    occluders.push(body);
    const face = new THREE.Mesh(new RoundedBoxGeometry(0.3, H - 0.3, D - 0.3, 3, 0.1), shellMat('#2350C0'));
    face.position.set(W / 2 - 0.1, H / 2, 0);
    scene.add(face);
    const probes = new THREE.Group();
    const can = new THREE.MeshStandardMaterial({ color: '#B8BCC2', metalness: 0.85, roughness: 0.32 });
    const mesh = new THREE.MeshStandardMaterial({ color: '#2A2C30', roughness: 0.9 });
    for (const z of [-1.3, 1.3]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.2, 32), can);
      c.rotation.z = Math.PI / 2;
      c.position.set(0, 0, z);
      probes.add(c);
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.66, 32), mesh);
      m.rotation.y = Math.PI / 2;
      m.position.set(0.61, 0, z);
      probes.add(m);
    }
    probes.traverse((x) => (x.castShadow = true));
    scene.add(probes);
    const PROBE_OUT = W / 2 + 0.2;
    // 顶面 OLED
    const { tex: oTex, data: oData } = oledTexture();
    const bez = new THREE.Mesh(new RoundedBoxGeometry(3.5, 0.12, 1.95, 3, 0.05), new THREE.MeshStandardMaterial({ color: '#0B0C0E', roughness: 0.55 }));
    bez.position.set(-1.2, H + 0.02, 0);
    scene.add(bez);
    const scrMat = new THREE.MeshBasicMaterial({ map: oTex, toneMapped: false });
    scrMat.color.setScalar(1.15);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(3.04, 1.52), scrMat);
    scr.rotation.x = -Math.PI / 2;
    scr.position.set(-1.2, H + 0.09, 0);
    scene.add(scr);
    // 出声孔 + 声波
    const holeMat = new THREE.MeshStandardMaterial({ color: '#1A2E66', roughness: 0.9 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 6) * Math.PI * 2, r = i === 6 ? 0 : 0.3;
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 12), holeMat);
      h.position.set(2.3 + r * Math.cos(a), H + 0.005, r * Math.sin(a));
      scene.add(h);
    }
    for (let i = 0; i < 3; i++) {
      const w = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.03, 8, 48), new THREE.MeshBasicMaterial({ color: '#0D99FF', transparent: true, opacity: 0 }));
      w.rotation.x = Math.PI / 2;
      w.position.set(2.3, H + 0.3, 0);
      scene.add(w);
      waves.push(w);
    }
    // USB 线从尾部出
    const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-W / 2, 1, 0), new THREE.Vector3(-W / 2 - 1.2, 0.8, 0), new THREE.Vector3(-W / 2 - 3, 0.12, 1), new THREE.Vector3(-W / 2 - 9, 0.12, 4)]), 40, 0.13, 10), new THREE.MeshStandardMaterial({ color: '#1E1E1E', roughness: 0.6 }));
    cable.castShadow = true;
    scene.add(cable);
    // 桌上的刻度尺：0 刻度对准探头正面
    const tape = new THREE.Mesh(new THREE.PlaneGeometry(80 * (2048 / 2008), 2.4), new THREE.MeshStandardMaterial({ map: tapeTexture(), roughness: 0.6 }));
    tape.rotation.x = -Math.PI / 2;
    tape.position.set(PROBE_OUT + 40 * (2048 / 2008) - 20 * (80 / 2008), 0.02, D / 2 + 1.6);
    tape.receiveShadow = true;
    scene.add(tape);
    // 挡板：一块木板立在桌上，正面对着探头；拖它前后挪
    const board = new THREE.Group();
    const wood = new THREE.Mesh(new RoundedBoxGeometry(1.2, 9, 12, 3, 0.15), new THREE.MeshStandardMaterial({ color: '#C8A26B', roughness: 0.7 }));
    wood.position.set(0.6, 4.5, 0);
    wood.castShadow = wood.receiveShadow = true;
    board.add(wood);
    const foot = new THREE.Mesh(new RoundedBoxGeometry(4, 0.6, 6, 2, 0.1), new THREE.MeshStandardMaterial({ color: '#8A6A42', roughness: 0.8 }));
    foot.position.set(1.4, 0.3, 0);
    foot.castShadow = true;
    board.add(foot);
    scene.add(board);
    const boardHit = new THREE.Mesh(new THREE.BoxGeometry(3, 10, 13), new THREE.MeshBasicMaterial({ visible: false }));
    boardHit.position.set(0.6, 4.5, 0);
    board.add(boardHit);
    hits.push(boardHit);
    handle = boardHit;
    const tagCm = tag('', 'hot');
    tagList.push({ el: tagCm, at: () => new THREE.Vector3(board.position.x + 0.6, 9.8, 0) });
    tagList.push({ el: tag('HC-SR04 探头'), at: () => new THREE.Vector3(PROBE_OUT, 3.4, -2.6), dy: -10 });
    const place = (d: number) => {
      cm = Math.round(Math.max(2, Math.min(80, d)) * 10) / 10;
      board.position.x = PROBE_OUT + cm;
      tagCm.textContent = `挡板 · ${cm.toFixed(1)} cm · 可拖动`;
    };
    place(cm);
    setDistance = (d) => place(d);
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    let drag: { off: number } | null = null;
    onDown = (hit) => {
      if (hit !== boardHit) return false;
      drag = { off: 0 };
      if (ray.ray.intersectPlane(floor, p)) drag.off = board.position.x - p.x;
      renderer.domElement.style.cursor = 'grabbing';
      return true;
    };
    onMove = () => {
      if (!drag || !ray.ray.intersectPlane(floor, p)) return;
      place(p.x + drag.off - PROBE_OUT);
      o.onDistance?.(cm);
    };
    onUp = () => {
      drag = null;
    };
    let lastOled: Uint8Array | null = null;
    tick = (f, dt, now) => {
      if (f.oled && f.oled !== lastOled) {
        lastOled = f.oled;
        for (let y = 0; y < 64; y++)
          for (let x = 0; x < 128; x++) {
            const on = f.oled[y * 128 + x] > 0;
            const i = ((63 - y) * 128 + x) * 4;
            oData[i] = on ? 200 : 4;
            oData[i + 1] = on ? 236 : 6;
            oData[i + 2] = on ? 255 : 10;
            oData[i + 3] = 255;
          }
        oTex.needsUpdate = true;
      }
      // 装法 B：探头缩在孔后 6 mm
      const blocked = !!o.effects().sonarBlock;
      probes.position.set(blocked ? W / 2 - 0.8 : PROBE_OUT - 0.6, H / 2, 0);
      const snd = o.sounding();
      waves.forEach((w, i) => {
        const ph = (now / 500 + i / 3) % 1;
        const mat = w.material as THREE.MeshBasicMaterial;
        mat.opacity = snd ? 0.6 * (1 - ph) : Math.max(0, mat.opacity - dt * 3);
        w.scale.setScalar(0.5 + ph * 1.6);
        w.position.y = H + 0.3 + ph * 0.8;
      });
    };
  } else {
    // 圆盘外壳 Ø5.6 × 2.6 cm，顶面圆屏；放在一个小支架上，拖动让它倾斜
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.2, 0.8, 48), shellMat('#3A3936'));
    stand.position.y = 0.4;
    stand.castShadow = stand.receiveShadow = true;
    scene.add(stand);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), new THREE.MeshStandardMaterial({ color: '#BDB9B0', metalness: 0.6, roughness: 0.3 }));
    ball.position.y = 1.0;
    scene.add(ball);
    const disc = new THREE.Group();
    disc.position.y = 2.6;
    scene.add(disc);
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 2.2, 72), shellMat('#ECE9E2'));
    shell.castShadow = shell.receiveShadow = true;
    disc.add(shell);
    occluders.push(shell);
    const bezel = new THREE.Mesh(new THREE.RingGeometry(1.62, 2.55, 72), new THREE.MeshStandardMaterial({ color: '#1A1A19', roughness: 0.4 }));
    bezel.rotation.x = -Math.PI / 2;
    bezel.position.y = 1.105;
    disc.add(bezel);
    const { tex: lTex, data: lData } = lcdTexture();
    const screen = new THREE.Mesh(new THREE.CircleGeometry(1.62, 72), new THREE.MeshBasicMaterial({ map: lTex, toneMapped: false }));
    screen.rotation.x = -Math.PI / 2;
    screen.position.y = 1.11;
    disc.add(screen);
    // 前面（+z）一个小箭头：六轴的 X 轴朝前
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 16), new THREE.MeshStandardMaterial({ color: '#FF7A1A', roughness: 0.4 }));
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(0, 0, 2.9);
    disc.add(arrow);
    const discHit = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 3, 24), new THREE.MeshBasicMaterial({ visible: false }));
    disc.add(discHit);
    hits.push(discHit);
    handle = discHit;
    const tagPose = tag('', 'hot');
    tagList.push({ el: tagPose, at: () => new THREE.Vector3(0, 0.2, 3.4), dy: 22 });
    const apply = (p: Pose) => {
      pose = { pitch: Math.max(-40, Math.min(40, p.pitch)), roll: Math.max(-40, Math.min(40, p.roll)), yaw: p.yaw };
      // roll > 0：右边（+x）放低；pitch > 0：前边（+z）放低（与固件里小豆的滑动方向一致）
      disc.rotation.set((pose.pitch * Math.PI) / 180, 0, (-pose.roll * Math.PI) / 180, 'XZY');
      tagPose.textContent = `拖动倾斜 · 俯仰 ${pose.pitch.toFixed(0)}° 横滚 ${pose.roll.toFixed(0)}°`;
    };
    apply(pose);
    setPose = (p) => apply(p);
    let drag: { x: number; y: number; p0: Pose } | null = null;
    onDown = (hit, e) => {
      if (hit !== discHit) return false;
      drag = { x: e.clientX, y: e.clientY, p0: { ...pose } };
      renderer.domElement.style.cursor = 'grabbing';
      return true;
    };
    onMove = (e) => {
      if (!drag) return;
      // 往右拖 = 右边放低（横滚 +），往下拖 = 前边放低（俯仰 +）；每 4 px 1°
      apply({ pitch: drag.p0.pitch + (e.clientY - drag.y) / 4, roll: drag.p0.roll + (e.clientX - drag.x) / 4, yaw: 0 });
      o.onPose?.(pose);
    };
    onUp = () => {
      drag = null;
    };
    let lastLcd: Uint8Array | null = null;
    tick = (f) => {
      if (f.lcd && f.lcd !== lastLcd) {
        lastLcd = f.lcd;
        lData.set(f.lcd.subarray(0, lData.length));
        lTex.needsUpdate = true;
      }
    };
  }

  // ---------------------------------------------------------------- 交互：先于 OrbitControls 注册
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const el = renderer.domElement;
  let mine = false;
  const toNdc = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    toNdc(e);
    const h = ray.intersectObjects(hits, false)[0];
    if (h && onDown(h.object, e)) {
      mine = true;
      controls.enabled = false;
      el.setPointerCapture(e.pointerId);
    }
  });
  el.addEventListener('pointermove', (e) => {
    toNdc(e);
    if (mine) return onMove(e);
    el.style.cursor = ray.intersectObjects(hits, false).length ? 'pointer' : 'grab';
  });
  const up = () => {
    if (mine) onUp();
    mine = false;
    controls.enabled = true;
    el.style.cursor = 'grab';
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener(
    'wheel',
    (e) => {
      toNdc(e);
      const h = ray.intersectObjects(hits, false)[0];
      if (h && onWheel(h.object, e.deltaY)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { capture: true, passive: false },
  );

  const controls = new OrbitControls(camera, el);
  controls.target.copy(V.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.enablePan = false;
  controls.minDistance = V.min;
  controls.maxDistance = V.max;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.update();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.25, 1.2));
  composer.addPass(new OutputPass());

  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 44 : 32;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const v = new THREE.Vector3();
  const occRay = new THREE.Raycaster();
  function hidden(p: THREE.Vector3) {
    const dir = p.clone().sub(camera.position);
    const dist = dir.length();
    occRay.set(camera.position, dir.normalize());
    occRay.far = dist - 0.3;
    return occRay.intersectObjects(occluders, false).length > 0;
  }
  function screenPos(p: THREE.Vector3): [number, number] | null {
    v.copy(p).project(camera);
    if (v.z > 1) return null;
    const r = el.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }
  let raf = 0;
  let last = performance.now();
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(o.frame(), dt, now);
    controls.update();
    composer.render();
    for (const t of tagList) {
      const p = t.at();
      v.copy(p).project(camera);
      t.el.style.display = v.z < 1 && !hidden(p) ? '' : 'none';
      t.el.style.transform = `translate(${((v.x + 1) / 2) * container.clientWidth + (t.dx ?? 0)}px, ${((1 - v.y) / 2) * container.clientHeight + (t.dy ?? 0)}px) translate(-50%, -50%)`;
    }
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
    azimuth: () => (controls.getAzimuthalAngle() * 180) / Math.PI,
    resetView() {
      camera.position.copy(V.home);
      controls.target.copy(V.target);
      controls.update();
    },
    handleScreenPos() {
      if (!handle) return null;
      handle.updateWorldMatrix(true, false);
      return screenPos(new THREE.Vector3().setFromMatrixPosition(handle.matrixWorld));
    },
    state: () => ({ knob: knobCount, cm, pose: { ...pose } }),
    setDistance: (d) => setDistance(d),
    setPose: (p) => setPose(p),
    capture: () => capturableOf(renderer, scene, composer),
  };
}
