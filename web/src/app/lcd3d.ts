// ④ 圆屏两件成品的 3D 场景（P1-10）：会转身的小黄、透镜里的小人。和气象站（product3d.ts）一样独立于实验台 board3d。
// 屏幕画面是模拟器里 GC9A01 的真实帧缓冲（240×240 RGBA → DataTexture），舵机角度来自 GPIO4 的 PWM，按键走同一个 LiveSim。
// 单位 cm。小黄是原创形象：黄色胶囊身体、头顶一缕卷发、正面一块深色屏幕眼罩（不绕到脑后，没有护目镜和背带）、工具腰带。
// 透镜：Ø40 mm 平凸透镜，MeshPhysicalMaterial 的 transmission / ior 做折射，是示意，不是光学仿真。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { servoAngle } from '../views/common';
import { currentTheme, onTheme, type Theme } from '../theme';
import { EXT, extModelsOn, loadExt, reportExt } from '../extmodels';
import { capturableOf, type Capturable } from './capture';

export interface LcdFrame {
  pwm: number[];
  lcd: Uint8Array | null;
  running: boolean;
}

export interface Lcd3DOptions {
  kind: 'spin' | 'lens';
  frame(): LcdFrame;
  servoPin: number;
  /** 装配带来的效果：舵盘装偏（°）、透镜放大倍数 */
  effects(): { hornOffset?: number; lensScale?: number };
  sounding(): boolean;
  onBoot(down: boolean): void;
}

export interface Lcd3D {
  start(): void;
  stop(): void;
  dispose(): void;
  buttonScreenPos(): [number, number] | null;
  azimuth(): number;
  resetView(): void;
  /** 小黄转台的当前角度（°，0 = 正面）；透镜小人恒为 0 */
  turn(): number;
  /** 用了哪些外部模型（测试 / 截图核对） */
  ext(): string[];
  /** 拍照 / 录像（P2-10） */
  capture(): Capturable;
}

/** WebGL 不可用时由调用方退回 SVG 成品 */
export function webglOk(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const YELLOW = '#FFCE3A';
const LCD_D = 3.24; // GC9A01 1.28″ 可视区直径

/** 圆屏：帧缓冲纹理。数据按行从上到下，用纹理矩阵翻转 v，不逐像素拷贝翻转 */
function lcdTexture() {
  const data = new Uint8Array(240 * 240 * 4);
  const tex = new THREE.DataTexture(data, 240, 240, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.repeat.set(1, -1);
  tex.offset.set(0, 1);
  tex.needsUpdate = true;
  return { tex, data };
}

/** 9 g 舵机（SG90 外形）程序生成版，cm：转轴在原点、竖直向上，壳体朝 -z 偏 0.54 */
function servoProc() {
  const g = new THREE.Group();
  const blue = new THREE.MeshPhysicalMaterial({ color: '#2D5BD3', roughness: 0.32, transmission: 0.1, thickness: 0.2 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.18, 2.27, 2.22), blue);
  body.position.set(0, -2.27 / 2 - 0.4, -0.54);
  const ears = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.25, 3.22), blue);
  ears.position.set(0, -0.4 - 0.55, -0.54);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.59, 0.59, 0.4, 32), blue);
  tower.position.y = -0.2;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.3, 20), new THREE.MeshStandardMaterial({ color: '#F2F2F2', roughness: 0.5 }));
  shaft.position.y = 0.15;
  for (const m of [body, ears, tower, shaft]) {
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

export function createLcd3D(container: HTMLElement, o: Lcd3DOptions): Lcd3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  // Neutral 色调映射：比 ACES 少偏色，小黄的黄不会发绿发灰
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';

  const scene = new THREE.Scene();
  const BG = { light: '#EEF1F5', dark: '#1D2024' }, DESK = { light: '#E4E8EE', dark: '#2A2D32' };
  const bgColor = new THREE.Color(BG[currentTheme()]);
  scene.background = bgColor;
  scene.fog = new THREE.Fog(bgColor, 30, 60);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;

  const spin = o.kind === 'spin';
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  const HOME = spin ? new THREE.Vector3(14, 12.5, 33) : new THREE.Vector3(9, 8, 24);
  const TARGET = spin ? new THREE.Vector3(0.6, 5.6, 0) : new THREE.Vector3(0.4, 3.0, 0);
  camera.position.copy(HOME);

  const sun = new THREE.DirectionalLight('#FFFFFF', 1.3);
  sun.position.set(-6, 14, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  for (const k of ['left', 'bottom'] as const) sun.shadow.camera[k] = -10;
  for (const k of ['right', 'top'] as const) sun.shadow.camera[k] = 10;
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0005;
  scene.add(sun, new THREE.HemisphereLight('#FFFFFF', '#C9CED6', 0.35));

  const desk = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: DESK[currentTheme()], roughness: 0.92 }));
  desk.rotation.x = -Math.PI / 2;
  desk.receiveShadow = true;
  scene.add(desk);
  const offTheme = onTheme((t: Theme) => {
    bgColor.set(BG[t]);
    scene.fog!.color.set(BG[t]);
    (desk.material as THREE.MeshStandardMaterial).color.set(DESK[t]);
  });

  const { tex: lcdTex, data: lcdData } = lcdTexture();
  const lcdMat = new THREE.MeshBasicMaterial({ map: lcdTex, toneMapped: false });
  const usedExt: string[] = [];
  const occluders: THREE.Object3D[] = [];
  const offReport = reportExt(() => [...usedExt]);

  // BOOT 键（两件都在底座正面右侧）
  const keyMat = new THREE.MeshStandardMaterial({ color: '#C9C6BF', roughness: 0.5 });
  const key = new THREE.Mesh(new RoundedBoxGeometry(0.7, 0.36, 0.3, 3, 0.08), keyMat);
  const keyHit = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 1.0), new THREE.MeshBasicMaterial({ visible: false }));
  const hint = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.56, 48), new THREE.MeshBasicMaterial({ color: '#FF7A1A', transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  let keyRest = new THREE.Vector3();

  // ------------------------------------------------------------ 小黄
  const turnGroup = new THREE.Group(); // 随舵机转：舵盘、托盘、小黄
  let lensMat: THREE.MeshPhysicalMaterial | null = null;
  let lens: THREE.Mesh | null = null;
  let lensRing: THREE.Group | null = null;
  const posts: THREE.Mesh[] = [];

  if (spin) {
    // 底座 Ø60 mm × 10 mm，深灰；上面立着 SG90（壳体一半沉在底座里），转轴对准中心
    const baseMat = new THREE.MeshPhysicalMaterial({ color: '#3A3936', roughness: 0.55, clearcoat: 0.2 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.1, 1.0, 64), baseMat);
    base.position.y = 0.5;
    base.castShadow = base.receiveShadow = true;
    scene.add(base);
    occluders.push(base);
    const well = new THREE.Mesh(new RoundedBoxGeometry(1.6, 0.06, 3.6, 2, 0.02), new THREE.MeshStandardMaterial({ color: '#1E1E1C', roughness: 0.9 }));
    well.position.set(0, 1.0, -0.54);
    scene.add(well);
    const SHAFT_TOP = 2.9;
    const servoHolder = new THREE.Group();
    servoHolder.position.y = SHAFT_TOP - 0.3;
    scene.add(servoHolder);
    const proc = servoProc();
    servoHolder.add(proc);
    // 三色线从壳体背面下来钻进底座
    const wireCols = ['#7A4A2A', '#D8342A', '#F28C28'];
    wireCols.forEach((c, i) => {
      const x = (i - 1) * 0.13;
      const w = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(x, 1.6, -1.66), new THREE.Vector3(x, 1.4, -1.9), new THREE.Vector3(x, 1.05, -1.95)]), 12, 0.055, 6),
        new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }),
      );
      scene.add(w);
    });
    if (extModelsOn()) {
      void loadExt(EXT.servo).then((m) => {
        if (!m) return;
        // glb 单位 mm、转轴在原点、壳体沿 -z：缩到 cm，转轴顶（花键顶 +11.9 mm）对齐程序版转轴顶
        m.scale.setScalar(0.1);
        m.position.y = 0.3 - 1.19;
        proc.visible = false;
        servoHolder.add(m);
        usedExt.push(EXT.servo);
      });
    }

    turnGroup.position.y = SHAFT_TOP;
    scene.add(turnGroup);
    const white = new THREE.MeshStandardMaterial({ color: '#F7F7F4', roughness: 0.55 });
    const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.18, 24), white);
    horn.position.y = 0.09;
    turnGroup.add(horn);
    const platter = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.25, 64), new THREE.MeshStandardMaterial({ color: '#EDEAE2', roughness: 0.5 }));
    platter.position.y = 0.3;
    platter.castShadow = platter.receiveShadow = true;
    turnGroup.add(platter);
    // 正面刻线：一眼看出转台转到了哪
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.5), new THREE.MeshBasicMaterial({ color: '#FF7A1A' }));
    mark.position.set(0, 0.435, 2.1);
    turnGroup.add(mark);

    // 身体：胶囊（半径 2.0，直段 4.2 → 总高 8.2）。眼罩和腰带都落在直段上，不跟着半球收口
    const R = 2.0, LEN = 4.2;
    const ch = new THREE.Group();
    ch.position.y = 0.425;
    turnGroup.add(ch);
    const bodyMat = new THREE.MeshPhysicalMaterial({ color: YELLOW, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.35 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(R, LEN, 16, 48), bodyMat);
    body.position.y = R + LEN / 2;
    body.castShadow = true;
    ch.add(body);
    occluders.push(body);
    // 底下一圈深色脚环，坐在托盘上
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.3, 48), new THREE.MeshStandardMaterial({ color: '#2A2A28', roughness: 0.6 }));
    foot.position.y = 0.15;
    ch.add(foot);

    // 屏幕眼罩：正面一块圆角方形的深色曲面面罩（只在正面，不是一圈带子，也没有护目镜），圆屏嵌在中间。
    // 网格平面按身体半径弯过去，圆角用 alpha 贴图裁（ShapeGeometry 内部没有顶点，弯不过去）
    const FACE_Y = R + 2.4;
    const VH = 3.8;
    const VR = R + 0.06;
    const bent = (w: number, h: number, r: number) => {
      const g = new THREE.PlaneGeometry(w, h, 48, 24);
      const q = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < q.count; i++) {
        const a = q.getX(i) / r;
        q.setXYZ(i, r * Math.sin(a), q.getY(i), r * Math.cos(a));
      }
      g.computeVertexNormals();
      return g;
    };
    const roundMask = (corner: number) => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const g = c.getContext('2d')!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, 256, 256);
      g.fillStyle = '#FFF';
      g.beginPath();
      g.roundRect(2, 2, 252, 252, corner * 256);
      g.fill();
      const t = new THREE.CanvasTexture(c);
      return t;
    };
    const plateMat = new THREE.MeshPhysicalMaterial({ color: '#16181C', roughness: 0.16, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06, alphaMap: roundMask(0.3), alphaTest: 0.5, side: THREE.DoubleSide });
    const plate = new THREE.Mesh(bent(VH, VH, VR), plateMat);
    plate.position.y = FACE_Y;
    ch.add(plate);
    // 面罩外沿：稍大一圈的深灰边，看起来有厚度
    const edge = new THREE.Mesh(bent(VH + 0.2, VH + 0.2, VR - 0.03), new THREE.MeshStandardMaterial({ color: '#2B2D31', roughness: 0.5, alphaMap: roundMask(0.32), alphaTest: 0.5, side: THREE.DoubleSide }));
    edge.position.y = FACE_Y;
    ch.add(edge);
    // 圆屏：环形网格保证内部有顶点，按眼罩半径弯成曲面
    const sg = new THREE.RingGeometry(0.0001, LCD_D / 2, 64, 16);
    const p = sg.attributes.position as THREE.BufferAttribute;
    const SR = VR + 0.012;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const a = x / SR;
      p.setXYZ(i, SR * Math.sin(a), p.getY(i), SR * Math.cos(a));
    }
    sg.computeVertexNormals();
    const screen = new THREE.Mesh(sg, lcdMat);
    screen.position.y = FACE_Y;
    ch.add(screen);
    // 头顶一缕卷发：从头顶冒出来、向前绕一圈半的螺旋，越往发梢越细
    const curl: THREE.Vector3[] = [new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(0.02, 0.35, 0.02)];
    for (let i = 0; i <= 36; i++) {
      const t = i / 36;
      const ang = Math.PI - t * 2.6 * Math.PI;
      const r = 0.42 * (1 - 0.55 * t);
      curl.push(new THREE.Vector3(r + r * Math.cos(ang) - 0.02, 0.8 + r * Math.sin(ang), 0.06 + 0.22 * t));
    }
    const TS = 90, RS = 12;
    const hg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(curl), TS, 0.16, RS);
    {
      // TubeGeometry 是等粗的：按沿线位置把每一圈顶点往中心线收
      const path = new THREE.CatmullRomCurve3(curl);
      const q = hg.attributes.position as THREE.BufferAttribute;
      const c = new THREE.Vector3(), pt = new THREE.Vector3();
      for (let i = 0; i <= TS; i++) {
        path.getPointAt(i / TS, c);
        const k = 1 - 0.75 * (i / TS);
        for (let j = 0; j <= RS; j++) {
          const n = i * (RS + 1) + j;
          pt.fromBufferAttribute(q, n).sub(c).multiplyScalar(k).add(c);
          q.setXYZ(n, pt.x, pt.y, pt.z);
        }
      }
      hg.computeVertexNormals();
    }
    const hair = new THREE.Mesh(hg, new THREE.MeshStandardMaterial({ color: '#3B2618', roughness: 0.45 }));
    hair.position.y = R * 2 + LEN - 0.12;
    hair.castShadow = true;
    ch.add(hair);

    // 工具腰带：棕色皮带 + 侧面搭扣 + 两个工具袋 + 一把扳手、一把起子（在腰带上，不是背带裤）
    const BELT_Y = R + 0.3;
    const leather = new THREE.MeshStandardMaterial({ color: '#7A4E2A', roughness: 0.7 });
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.06, R + 0.06, 0.5, 64, 1, true), leather);
    belt.position.y = BELT_Y;
    ch.add(belt);
    const steel = new THREE.MeshStandardMaterial({ color: '#C9CDD2', metalness: 1, roughness: 0.3 });
    const buckle = new THREE.Mesh(new RoundedBoxGeometry(0.55, 0.6, 0.12, 2, 0.05), steel);
    const ba = -Math.PI / 4.2;
    buckle.position.set(Math.sin(ba) * (R + 0.1), BELT_Y, Math.cos(ba) * (R + 0.1));
    buckle.rotation.y = ba;
    ch.add(buckle);
    for (const a of [Math.PI / 2.6, -Math.PI / 1.6]) {
      const pouch = new THREE.Mesh(new RoundedBoxGeometry(0.9, 1.0, 0.45, 3, 0.12), new THREE.MeshStandardMaterial({ color: '#5E3B1F', roughness: 0.75 }));
      pouch.position.set(Math.sin(a) * (R + 0.2), BELT_Y - 0.25, Math.cos(a) * (R + 0.2));
      pouch.rotation.y = a;
      pouch.castShadow = true;
      ch.add(pouch);
      const flap = new THREE.Mesh(new RoundedBoxGeometry(0.95, 0.3, 0.5, 2, 0.1), leather);
      flap.position.set(Math.sin(a) * (R + 0.22), BELT_Y + 0.2, Math.cos(a) * (R + 0.22));
      flap.rotation.y = a;
      ch.add(flap);
    }
    // 起子：插在右侧工具袋里（橙柄 + 钢杆）
    const sa = Math.PI / 2.6;
    const drv = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 12), new THREE.MeshStandardMaterial({ color: '#FF7A1A', roughness: 0.5 }));
    handle.position.y = 0.55;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 8), steel);
    rod.position.y = 0.0;
    drv.add(handle, rod);
    drv.position.set(Math.sin(sa) * (R + 0.25) + 0.15, BELT_Y, Math.cos(sa) * (R + 0.25));
    drv.rotation.z = -0.2;
    ch.add(drv);
    // 扳手：挂在搭扣旁的腰带环上
    const wa = -Math.PI / 9;
    const wrench = new THREE.Group();
    const shank = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.0, 0.06), steel);
    shank.position.y = -0.5;
    const head = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.06, 8, 20, Math.PI * 1.5), steel);
    head.position.y = -1.08;
    head.rotation.z = Math.PI * 0.75;
    wrench.add(shank, head);
    wrench.position.set(Math.sin(wa) * (R + 0.12), BELT_Y - 0.1, Math.cos(wa) * (R + 0.12));
    wrench.rotation.y = wa;
    wrench.rotation.z = 0.12;
    ch.add(wrench);

    // BOOT 键：底座正面右侧
    keyRest = new THREE.Vector3(1.9, 0.62, 2.3);
    key.rotation.y = 0.68;
  } else {
    // ------------------------------------------------------------ 透镜小人
    // 底座：圆角盒 56 × 14 × 40 mm，米白；后面 USB-C 口
    const shell = new THREE.MeshPhysicalMaterial({ color: '#EDEAE2', roughness: 0.5, clearcoat: 0.25 });
    const base = new THREE.Mesh(new RoundedBoxGeometry(5.6, 1.4, 4.0, 6, 0.6), shell);
    base.position.y = 0.7;
    base.castShadow = base.receiveShadow = true;
    scene.add(base);
    occluders.push(base);
    const usb = new THREE.Group();
    usb.position.set(0, 0.62, -2.0);
    scene.add(usb);
    const usbProc = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.33, 0.1, 2, 0.15), new THREE.MeshStandardMaterial({ color: '#B9BEC4', metalness: 1, roughness: 0.3 }));
    usb.add(usbProc);
    if (extModelsOn()) {
      void loadExt(EXT.usbC).then((m) => {
        if (!m) return;
        // KiCad 封装：开口朝 +z（转换后），贴片面在 y=0；缩到 cm，开口转向后方、外壳中心对齐
        m.scale.setScalar(0.1);
        m.rotation.y = Math.PI;
        m.position.set(0, -0.16, 0.32);
        usbProc.visible = false;
        usb.add(m);
        usedExt.push(EXT.usbC);
      });
    }
    // 屏幕外壳：深色圆筒，立在底座上，后仰 12°
    const head = new THREE.Group();
    head.position.set(0, 3.75, -0.3);
    head.rotation.x = -0.21;
    scene.add(head);
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(2.35, 2.35, 1.1, 64), new THREE.MeshPhysicalMaterial({ color: '#1A1A19', roughness: 0.4, clearcoat: 0.3 }));
    housing.rotation.x = Math.PI / 2;
    housing.castShadow = true;
    head.add(housing);
    occluders.push(housing);
    const neck = new THREE.Mesh(new RoundedBoxGeometry(2.0, 1.4, 0.9, 3, 0.3), shell);
    neck.position.set(0, 1.85, -0.35);
    scene.add(neck);
    const screen = new THREE.Mesh(new THREE.CircleGeometry(LCD_D / 2, 64), lcdMat);
    screen.position.z = 0.56;
    head.add(screen);
    const bezel = new THREE.Mesh(new THREE.RingGeometry(LCD_D / 2, 2.35, 64), new THREE.MeshStandardMaterial({ color: '#D6D1C6', roughness: 0.45 }));
    bezel.position.z = 0.565;
    head.add(bezel);
    // 透镜：平凸，Ø40 mm、中心厚 9 mm（曲率半径 ≈ 26.7 mm），三根细柱撑在外框上；离屏高度由装法决定
    const lensR = 2.0, sag = 0.9, Rc = (lensR * lensR + sag * sag) / (2 * sag);
    const prof: THREE.Vector2[] = [new THREE.Vector2(0, 0)];
    prof.push(new THREE.Vector2(lensR, 0));
    for (let i = 0; i <= 24; i++) {
      const r = lensR * (1 - i / 24);
      prof.push(new THREE.Vector2(r, Math.sqrt(Rc * Rc - r * r) - (Rc - sag)));
    }
    const lg = new THREE.LatheGeometry(prof, 96);
    lg.rotateX(Math.PI / 2);
    lensMat = new THREE.MeshPhysicalMaterial({ color: '#FFFFFF', metalness: 0, roughness: 0, transmission: 1, ior: 1.5, thickness: 1.0, specularIntensity: 1, clearcoat: 1, clearcoatRoughness: 0.03, attenuationColor: new THREE.Color('#E8F4FF'), attenuationDistance: 12 });
    lens = new THREE.Mesh(lg, lensMat);
    head.add(lens);
    lensRing = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: '#D6D1C6', roughness: 0.45 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(lensR + 0.04, 0.09, 10, 96), frameMat);
    lensRing.add(ring);
    head.add(lensRing);
    for (let i = 0; i < 3; i++) {
      const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 10), frameMat);
      post.rotation.x = Math.PI / 2;
      post.position.set(Math.cos(a) * (lensR + 0.04), Math.sin(a) * (lensR + 0.04), 0);
      head.add(post);
      posts.push(post);
    }
    keyRest = new THREE.Vector3(2.0, 1.4, 1.4);
  }

  key.position.copy(keyRest);
  key.castShadow = true;
  scene.add(key);
  keyHit.position.copy(keyRest);
  scene.add(keyHit);
  hint.rotation.x = -Math.PI / 2;
  hint.position.copy(keyRest).add(new THREE.Vector3(0, spin ? 0.4 : 0.02, 0));
  if (spin) {
    hint.rotation.set(0, 0.68, 0);
    hint.position.copy(keyRest).add(new THREE.Vector3(Math.sin(0.68) * 0.2, 0, Math.cos(0.68) * 0.2));
  }
  scene.add(hint);

  // 标签
  const tags = document.createElement('div');
  tags.className = 'p3-tags';
  const tag = (text: string, cls = '') => {
    const t = document.createElement('div');
    t.className = 'p3-tag ' + cls;
    t.textContent = text;
    tags.appendChild(t);
    return t;
  };
  const tagKey = tag(spin ? 'BOOT · 回正面 / 继续转' : 'BOOT · 换表情', 'hot');
  const tagInfo = tag(spin ? 'SG90 转台' : '凸透镜 Ø40 · 折射示意');
  const corner = document.createElement('div');
  corner.className = 'p3-disclaimer';
  corner.textContent = spin ? '外观示意，非乐鑫官方模型 · 小黄为原创形象' : '外观示意，非乐鑫官方模型 · 透镜折射为示意，不是光学仿真';
  container.append(tags, corner);

  // 交互
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pressing = false;
  const el = renderer.domElement;
  const toNdc = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    toNdc(e);
    if (ray.intersectObject(keyHit).length) {
      pressing = true;
      controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      o.onBoot(true);
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (pressing) return;
    toNdc(e);
    el.style.cursor = ray.intersectObject(keyHit).length ? 'pointer' : 'grab';
  });
  const up = () => {
    if (pressing) {
      pressing = false;
      o.onBoot(false);
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
  controls.minDistance = 8;
  controls.maxDistance = 40;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.update();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());

  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 42 : 30;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // 舵机：二阶弹簧阻尼追目标，限速 600°/s（SG90 约 0.1 s / 60°）；与气象站指针同一套示意参数
  let theta = 0, omega = 0;
  let lastLcd: Uint8Array | null = null;
  let raf = 0;
  let last = performance.now();
  let gap = -1;
  const v = new THREE.Vector3();
  const occRay = new THREE.Raycaster();
  function hidden(p: THREE.Vector3) {
    const dir = p.clone().sub(camera.position);
    const dist = dir.length();
    occRay.set(camera.position, dir.normalize());
    occRay.far = dist - 0.3;
    return occRay.intersectObjects(occluders, false).length > 0;
  }
  function place(t: HTMLElement, p: THREE.Vector3, dx = 0, dy = 0) {
    v.copy(p).project(camera);
    t.style.display = v.z < 1 && !hidden(p) ? '' : 'none';
    t.style.transform = `translate(${((v.x + 1) / 2) * container.clientWidth + dx}px, ${((1 - v.y) / 2) * container.clientHeight + dy}px) translate(-50%, -50%)`;
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const f = o.frame();
    const fx = o.effects();
    if (f.lcd && f.lcd !== lastLcd) {
      lastLcd = f.lcd;
      lcdData.set(f.lcd.subarray(0, lcdData.length));
      lcdTex.needsUpdate = true;
    } else if (!f.lcd && lastLcd) {
      lastLcd = null;
      lcdData.fill(0);
      lcdTex.needsUpdate = true;
    }
    if (spin) {
      const a = servoAngle(f.pwm, o.servoPin);
      // 舵机没输出时停在原地；装偏的舵盘让"正面"本身就歪着
      const target = a === null ? theta : a - 90 + (fx.hornOffset ?? 0);
      const k = 90, c = 2 * Math.sqrt(k) * 0.8;
      omega += (k * (target - theta) - c * omega) * dt;
      omega = Math.max(-600, Math.min(600, omega));
      theta += omega * dt;
      turnGroup.rotation.y = (theta * Math.PI) / 180;
    } else if (lens && lensMat && lensRing) {
      // 离屏高度：高档 8 mm（≈1.35×）、低档 1 mm（≈1.08×）。thickness 越大折射偏移越大，跟着放大倍数走（示意）
      const k = fx.lensScale ?? 1.35;
      const g = k > 1.2 ? 0.8 : 0.1;
      if (g !== gap) {
        gap = g;
        lens.position.z = 0.56 + g + 0.02;
        lensRing.position.z = lens.position.z + 0.05;
        lensMat.thickness = (k - 1) * 3;
        for (const p of posts) {
          p.scale.y = g + 0.1;
          p.position.z = 0.56 + (g + 0.1) / 2;
        }
      }
    }
    key.position.copy(keyRest);
    if (pressing) key.position.y -= 0.08;
    keyMat.color.set(pressing ? '#FF7A1A' : '#C9C6BF');
    (hint.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(now / 300));

    controls.update();
    composer.render();
    place(tagKey, keyRest.clone().add(new THREE.Vector3(0, 0.9, 0)));
    place(tagInfo, spin ? new THREE.Vector3(-2.4, 2.1, 0.6) : new THREE.Vector3(-2.3, 5.9, 0.4), spin ? -40 : 0, 0);
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
      offReport();
      ro.disconnect();
      controls.dispose();
      composer.dispose();
      renderer.dispose();
      pmrem.dispose();
      lcdTex.dispose();
      container.replaceChildren();
    },
    buttonScreenPos() {
      v.copy(keyRest).project(camera);
      if (v.z > 1) return null;
      const r = el.getBoundingClientRect();
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    },
    azimuth: () => (controls.getAzimuthalAngle() * 180) / Math.PI,
    resetView() {
      camera.position.copy(HOME);
      controls.target.copy(TARGET);
      controls.update();
    },
    turn: () => theta,
    ext: () => [...usedExt],
    capture: () => capturableOf(renderer, scene, composer),
  };
}
