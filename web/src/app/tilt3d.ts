// ④ 倾角仪成品（P2-03）：手里端着的小盒子（ESP32-S3 + GY-521 装在透明亚克力壳里）。
// 拖动 = 转动盒子（轨迹球，物体四元数），姿态换算见 imupose.ts：四元数 → 欧拉角 → 内核算重力分量与角速度。
// 盒子姿态和实验台的倾斜滑块是同一份（session.setPose），哪边改另一边都跟着变。
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { poseToThree, threeToPose, type Pose } from '../imupose';
import { currentTheme, onTheme } from '../theme';

export interface TiltOptions {
  /** 当前姿态（session / store 里那份） */
  pose(): Pose;
  /** 用户拖动转了盒子：move = 拖动中（≈30 Hz），end = 松手 */
  onPose(p: Pose, phase: 'move' | 'end'): void;
}

export interface Tilt3D {
  start(): void;
  stop(): void;
  dispose(): void;
  /** 盒子中心在页面上的位置（clientX/Y），给测试用真实鼠标去拖 */
  centerPos(): [number, number] | null;
}

function label(text: string, color: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.font = 'bold 44px Helvetica, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }));
  s.scale.set(0.9, 0.9, 1);
  s.renderOrder = 5;
  return s;
}

/** 传感器坐标轴（X 红、Y 绿、Z 蓝），和 GY-521 丝印一致：X = +x，Y = −z，Z = +y（单位 cm） */
function axes(len: number) {
  const g = new THREE.Group();
  const mk = (dir: THREE.Vector3, color: number, name: string, css: string) => {
    const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), len, color, 0.5, 0.3);
    g.add(a);
    const l = label(name, css);
    l.position.copy(dir.clone().multiplyScalar(len + 0.5));
    g.add(l);
  };
  mk(new THREE.Vector3(1, 0, 0), 0xf24822, 'X', '#F24822');
  mk(new THREE.Vector3(0, 0, -1), 0x14ae5c, 'Y', '#14AE5C');
  mk(new THREE.Vector3(0, 1, 0), 0x0d99ff, 'Z', '#0D99FF');
  return g;
}

export function createTilt3D(container: HTMLElement, o: TiltOptions): Tilt3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.style.cursor = 'grab';

  const scene = new THREE.Scene();
  const BG = { light: '#EEF1F5', dark: '#1D2024' };
  const bg = new THREE.Color(BG[currentTheme()]);
  scene.background = bg;
  const offTheme = onTheme((t) => bg.set(BG[t]));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(-6, 14, 8);
  key.castShadow = true;
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0xd0d4da, 0.9));
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.18 }));
  desk.rotation.x = -Math.PI / 2;
  desk.position.y = -4.2;
  desk.receiveShadow = true;
  scene.add(desk);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 200);
  camera.position.set(0, 9, 20);
  camera.lookAt(0, 0, 0);

  // 盒子：6 × 4 × 1.8 cm 亚克力壳，里面一块 S3 开发板（绿）和 GY-521（蓝，坐标轴丝印朝上）
  const dev = new THREE.Group();
  scene.add(dev);
  const shell = new THREE.Mesh(
    new RoundedBoxGeometry(6, 1.8, 4, 4, 0.35),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.08, transmission: 0.85, thickness: 0.3, ior: 1.49, transparent: true, opacity: 0.55 }),
  );
  shell.castShadow = true;
  dev.add(shell);
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.16, 2.6), new THREE.MeshStandardMaterial({ color: 0x1f6f43, roughness: 0.5 }));
  pcb.position.y = -0.55;
  dev.add(pcb);
  // ESP32-S3-WROOM 模组（1.8 × 2.55 cm 屏蔽罩）
  const mod = new THREE.Mesh(new THREE.BoxGeometry(2.55, 0.32, 1.8), new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.9, roughness: 0.3 }));
  mod.position.set(-1.2, -0.31, 0);
  dev.add(mod);
  const gy = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.16, 1.64), new THREE.MeshStandardMaterial({ color: 0x1d4fa8, roughness: 0.5 }));
  gy.position.set(1.4, 0.35, 0);
  dev.add(gy);
  const chip = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.09, 0.4), new THREE.MeshStandardMaterial({ color: 0x1c1c1e }));
  chip.position.set(1.3, 0.47, -0.05);
  dev.add(chip);
  const ax = axes(2.6);
  ax.position.copy(chip.position);
  dev.add(ax);
  // 世界里的重力方向（灰色箭头，始终朝下）：看传感器 Z 轴和它的夹角就是倾斜角
  const g = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(5.2, 2.6, 0), 2.6, 0x8c8c8c, 0.5, 0.3);
  scene.add(g);
  const gl = label('g', '#8C8C8C');
  gl.position.set(5.7, -0.3, 0);
  scene.add(gl);

  const resize = () => {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const m4 = new THREE.Matrix4();
  const setFromPose = (p: Pose) => {
    const r = poseToThree(p);
    m4.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
    dev.quaternion.setFromRotationMatrix(m4);
  };
  const toPose = (): Pose => {
    const e = m4.makeRotationFromQuaternion(dev.quaternion).elements;
    return threeToPose([e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]);
  };

  // 拖动：横向 = 绕相机竖直轴、纵向 = 绕相机水平轴（0.5°/像素）
  let drag: { x: number; y: number; t: number } | null = null;
  const qd = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, t: 0 };
    el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing';
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    axis.set(0, 1, 0).applyQuaternion(camera.quaternion);
    dev.quaternion.premultiply(qd.setFromAxisAngle(axis, dx * 0.5 * (Math.PI / 180)));
    axis.set(1, 0, 0).applyQuaternion(camera.quaternion);
    dev.quaternion.premultiply(qd.setFromAxisAngle(axis, dy * 0.5 * (Math.PI / 180)));
    dev.quaternion.normalize();
    const now = performance.now();
    if (now - drag.t > 33) {
      drag.t = now;
      o.onPose(toPose(), 'move');
    }
  });
  const up = () => {
    if (!drag) return;
    drag = null;
    el.style.cursor = 'grab';
    o.onPose(toPose(), 'end');
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  let raf = 0;
  let last = '';
  const tick = () => {
    raf = requestAnimationFrame(tick);
    // 别处（实验台滑块、放平按钮）改了姿态，盒子跟上；拖动时以手为准
    if (!drag) {
      const p = o.pose();
      const k = `${p.pitch},${p.roll},${p.yaw}`;
      if (k !== last) {
        last = k;
        setFromPose(p);
      }
    }
    renderer.render(scene, camera);
  };

  return {
    start() {
      if (!raf) tick();
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      offTheme();
      ro.disconnect();
      renderer.dispose();
      el.remove();
    },
    centerPos() {
      const v = new THREE.Vector3().setFromMatrixPosition(dev.matrixWorld).project(camera);
      const rc = el.getBoundingClientRect();
      return [rc.left + ((v.x + 1) / 2) * rc.width, rc.top + ((1 - v.y) / 2) * rc.height];
    },
  };
}
