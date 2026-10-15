// 3D 工作台：切割垫、面包板、ESP32-C3 开发板（程序建模，非任何厂商的设计文件）、LED + 电阻 + 跳线。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// 单位：毫米
const PITCH = 2.54;

/** 开发板排针定义（左 / 右两排，自 USB 端起）。 */
export const LEFT_PINS = ['GND', '3V3', '3V3', 'IO2', 'IO3', 'GND', 'RST', 'GND', 'IO0', 'IO1', 'IO10', 'GND', '5V', '5V', 'GND'];
export const RIGHT_PINS = ['GND', 'TX', 'RX', 'GND', 'IO9', 'IO8', 'GND', 'IO7', 'IO6', 'IO5', 'IO4', 'GND', 'IO18', 'IO19', 'GND'];

export interface Bench {
  setGpio(level: number, enable: number): void;
  setPowered(on: boolean): void;
  onButton(cb: (name: 'BOOT' | 'RST', down: boolean) => void): void;
  ledPin: number;
  dispose(): void;
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, aniso = 8) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

function matTexture() {
  // 自愈切割垫：深绿底 + 10mm 网格 + 每 50mm 粗线
  return canvasTexture(1024, 1024, (g) => {
    g.fillStyle = '#1f4a3c';
    g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i <= 1024; i += 1024 / 40) {
      const major = Math.round(i / (1024 / 40)) % 5 === 0;
      g.strokeStyle = major ? 'rgba(220,240,230,0.35)' : 'rgba(220,240,230,0.14)';
      g.lineWidth = major ? 2 : 1;
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, 1024);
      g.moveTo(0, i);
      g.lineTo(1024, i);
      g.stroke();
    }
  });
}

/** 面包板：830 孔规格的一半（30 列），列沿 x，行 a–e / f–j 沿 z。 */
function breadboard(cols: number) {
  const grp = new THREE.Group();
  const w = (cols + 3) * PITCH;
  const d = 55;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, 8.5, d),
    new THREE.MeshStandardMaterial({ color: 0xf1ede4, roughness: 0.75 }),
  );
  body.position.y = 4.25;
  body.castShadow = body.receiveShadow = true;
  grp.add(body);
  // 中间凹槽
  const groove = new THREE.Mesh(new THREE.BoxGeometry(w, 0.6, 2.6), new THREE.MeshStandardMaterial({ color: 0xd9d4c8 }));
  groove.position.set(0, 8.25, 0);
  grp.add(groove);
  // 孔：实例化小方块
  const holeGeo = new THREE.BoxGeometry(1.0, 0.3, 1.0);
  const holeMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 1 });
  const rows: number[] = [];
  for (let r = 0; r < 5; r++) rows.push(-(r + 2) * PITCH - 0.3, (r + 2) * PITCH + 0.3);
  // 电源轨
  const rails = [-d / 2 + 4, -d / 2 + 4 + PITCH, d / 2 - 4, d / 2 - 4 - PITCH];
  const count = cols * rows.length + cols * rails.length;
  const holes = new THREE.InstancedMesh(holeGeo, holeMat, count);
  const m = new THREE.Matrix4();
  let i = 0;
  for (let c = 0; c < cols; c++) {
    const x = (c - (cols - 1) / 2) * PITCH;
    for (const z of rows) holes.setMatrixAt(i++, m.makeTranslation(x, 8.52, z));
    for (const z of rails) holes.setMatrixAt(i++, m.makeTranslation(x, 8.52, z));
  }
  grp.add(holes);
  // 电源轨红蓝线
  for (const [z, color] of [
    [-d / 2 + 2.2, 0x2f5fd0],
    [-d / 2 + 5.8 + PITCH, 0xd0352f],
    [d / 2 - 2.2, 0xd0352f],
    [d / 2 - 5.8 - PITCH, 0x2f5fd0],
  ] as const) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(w - 6, 0.05, 0.5), new THREE.MeshBasicMaterial({ color }));
    line.position.set(0, 8.53, z);
    grp.add(line);
  }
  return { grp, colX: (c: number) => (c - (cols - 1) / 2) * PITCH, rowZ: (r: number) => (r < 5 ? -(5 - r + 1) * PITCH - 0.3 : (r - 5 + 2) * PITCH + 0.3), railZ: rails };
}

function silkTexture() {
  // PCB 顶面丝印：引脚名、板名
  const W = 1024, H = 2048; // 对应 25.4 × 50.8mm
  return canvasTexture(W, H, (g) => {
    g.fillStyle = '#16171c';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#e8e8e8';
    g.font = 'bold 30px "JetBrains Mono", Menlo, monospace';
    g.textBaseline = 'middle';
    const sy = H / 50.8;
    for (let i = 0; i < 15; i++) {
      const y = (6.6 + i * PITCH) * sy;
      g.textAlign = 'left';
      g.fillText(LEFT_PINS[i], 120, y);
      g.textAlign = 'right';
      g.fillText(RIGHT_PINS[i], W - 120, y);
    }
    g.textAlign = 'center';
    g.font = 'bold 44px "Inter", Helvetica, sans-serif';
    g.fillText('ESP32-C3 DEV', W / 2, 46.2 * sy);
    g.font = '28px "Inter", Helvetica, sans-serif';
    g.fillText('TryBoard · simulated', W / 2, 48.4 * sy);
    // 按键标识
    g.font = 'bold 28px Menlo, monospace';
    g.fillText('BOOT', W * 0.24, 4.4 * sy);
    g.fillText('RST', W * 0.76, 4.4 * sy);
    // 安装孔丝印圈
    g.strokeStyle = '#e8e8e8';
    g.lineWidth = 3;
    for (const [x, y] of [[0.1, 0.03], [0.9, 0.03]]) {
      g.beginPath();
      g.arc(W * x, H * y, 34, 0, Math.PI * 2);
      g.stroke();
    }
  });
}

function devboard() {
  const grp = new THREE.Group();
  const W = 25.4, L = 50.8, T = 1.6;
  const pcbTop = new THREE.MeshStandardMaterial({ map: silkTexture(), roughness: 0.55, metalness: 0.05 });
  const pcbSide = new THREE.MeshStandardMaterial({ color: 0x0f1013, roughness: 0.6 });
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(W, T, L), [pcbSide, pcbSide, pcbTop, pcbSide, pcbSide, pcbSide]);
  pcb.castShadow = pcb.receiveShadow = true;
  grp.add(pcb);

  // 模组：PCB 底板 + 金属屏蔽罩 + 天线区
  const modBase = new THREE.Mesh(new THREE.BoxGeometry(13.2, 0.8, 16.6), new THREE.MeshStandardMaterial({ color: 0x1d2a20, roughness: 0.6 }));
  modBase.position.set(0, T / 2 + 0.4, L / 2 - 16.6 / 2 - 1.5);
  grp.add(modBase);
  const shieldTex = canvasTexture(512, 512, (g) => {
    const grad = g.createLinearGradient(0, 0, 512, 512);
    grad.addColorStop(0, '#c9ccd1');
    grad.addColorStop(1, '#a7abb2');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = '#3a3d42';
    g.font = 'bold 54px Helvetica, sans-serif';
    g.textAlign = 'center';
    g.fillText('ESP32-C3', 256, 210);
    g.font = '34px Menlo, monospace';
    g.fillText('RISC-V · Wi-Fi · BLE 5', 256, 280);
    g.fillText('4MB FLASH', 256, 330);
  });
  const shield = new THREE.Mesh(
    new THREE.BoxGeometry(12.2, 2.2, 11.4),
    [
      new THREE.MeshStandardMaterial({ color: 0xb4b8be, metalness: 0.9, roughness: 0.32 }),
      new THREE.MeshStandardMaterial({ color: 0xb4b8be, metalness: 0.9, roughness: 0.32 }),
      new THREE.MeshStandardMaterial({ map: shieldTex, metalness: 0.85, roughness: 0.35 }),
      new THREE.MeshStandardMaterial({ color: 0xb4b8be, metalness: 0.9, roughness: 0.32 }),
      new THREE.MeshStandardMaterial({ color: 0xb4b8be, metalness: 0.9, roughness: 0.32 }),
      new THREE.MeshStandardMaterial({ color: 0xb4b8be, metalness: 0.9, roughness: 0.32 }),
    ],
  );
  shield.position.set(0, T / 2 + 0.8 + 1.1, modBase.position.z - 2.2);
  shield.castShadow = true;
  grp.add(shield);
  // PCB 天线：蛇形铜线
  const ant = new THREE.Group();
  const cu = new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 0.8, roughness: 0.35 });
  for (let i = 0; i < 6; i++) {
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 3.2), cu);
    seg.position.set(-5 + i * 2, 0, 0);
    ant.add(seg);
    if (i < 5) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.05, 0.5), cu);
      bar.position.set(-4 + i * 2, 0, i % 2 ? -1.35 : 1.35);
      ant.add(bar);
    }
  }
  ant.position.set(0, T / 2 + 0.83, modBase.position.z + 16.6 / 2 - 2.6);
  grp.add(ant);

  // USB-C 口
  const usb = new THREE.Mesh(
    new THREE.BoxGeometry(8.9, 3.2, 7.4),
    new THREE.MeshStandardMaterial({ color: 0xd8dade, metalness: 1, roughness: 0.25 }),
  );
  usb.position.set(0, T / 2 + 1.6, -L / 2 + 3.2);
  usb.castShadow = true;
  grp.add(usb);
  const usbHole = new THREE.Mesh(new THREE.BoxGeometry(7.6, 2.2, 0.2), new THREE.MeshStandardMaterial({ color: 0x111111 }));
  usbHole.position.set(0, T / 2 + 1.6, -L / 2 - 0.45);
  grp.add(usbHole);

  // 按键 BOOT / RST
  const buttons: THREE.Mesh[] = [];
  for (const [name, x] of [['BOOT', -W * 0.26], ['RST', W * 0.26]] as const) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.4, 3.2), new THREE.MeshStandardMaterial({ color: 0xd2d4d8, metalness: 0.9, roughness: 0.3 }));
    base.position.set(x, T / 2 + 0.7, -L / 2 + 9.5);
    grp.add(base);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.8, 24), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 }));
    cap.position.set(x, T / 2 + 1.8, -L / 2 + 9.5);
    cap.name = name;
    cap.userData.baseY = cap.position.y;
    grp.add(cap);
    buttons.push(cap);
  }

  // 板载电源灯（红）
  const pwrMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2010, emissiveIntensity: 0 });
  const pwr = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.8), pwrMat);
  pwr.position.set(W * 0.3, T / 2 + 0.3, -L / 2 + 14);
  grp.add(pwr);

  // 排针：塑料座 + 镀金针
  const pinGeo = new THREE.BoxGeometry(0.64, 11.5, 0.64);
  const gold = new THREE.MeshStandardMaterial({ color: 0xe8c66a, metalness: 1, roughness: 0.25 });
  const pins = new THREE.InstancedMesh(pinGeo, gold, 30);
  const m = new THREE.Matrix4();
  const pinX = W / 2 - 1.27;
  const pinPositions: Record<string, THREE.Vector3> = {};
  for (let i = 0; i < 15; i++) {
    const z = -L / 2 + 6.6 + i * PITCH;
    pins.setMatrixAt(i, m.makeTranslation(-pinX, -T / 2 - 2.5, z));
    pins.setMatrixAt(15 + i, m.makeTranslation(pinX, -T / 2 - 2.5, z));
    pinPositions['L' + i] = new THREE.Vector3(-pinX, 0, z);
    pinPositions['R' + i] = new THREE.Vector3(pinX, 0, z);
  }
  grp.add(pins);
  const headerMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
  for (const x of [-pinX, pinX]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 15 * PITCH), headerMat);
    h.position.set(x, -T / 2 - 1.25, -L / 2 + 6.6 + 7 * PITCH);
    grp.add(h);
  }
  return { grp, buttons, pwrMat, pinPositions, L };
}

function led(color: number) {
  const grp = new THREE.Group();
  const lens = new THREE.MeshPhysicalMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0,
    roughness: 0.15,
    transmission: 0.4,
    thickness: 2,
    transparent: true,
    opacity: 0.9,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 5.5, 32), lens);
  body.position.y = 2.75;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), lens);
  dome.position.y = 5.5;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 2.9, 1, 32), lens);
  rim.position.y = 0.5;
  for (const p of [body, dome, rim]) {
    p.castShadow = true;
    grp.add(p);
  }
  const legMat = new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 1, roughness: 0.3 });
  for (const x of [-1.27, 1.27]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 4, 8), legMat);
    leg.position.set(x, -1.6, 0);
    grp.add(leg);
  }
  const light = new THREE.PointLight(color, 0, 60, 2);
  light.position.y = 6;
  grp.add(light);
  return { grp, lens, light };
}

function resistor() {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(1.1, 4.2, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0xd9c49a, roughness: 0.6 }),
  );
  body.rotation.z = Math.PI / 2;
  body.position.y = 2.2;
  grp.add(body);
  // 220Ω：红 红 棕 金
  [0xc62828, 0xc62828, 0x6d4c41, 0xc9a227].forEach((c, i) => {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1.16, 1.16, 0.45, 20), new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }));
    band.rotation.z = Math.PI / 2;
    band.position.set(-1.8 + i * 1.1 + (i === 3 ? 0.4 : 0), 2.2, 0);
    grp.add(band);
  });
  const legMat = new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 1, roughness: 0.3 });
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-5.08, -1.5, 0),
    new THREE.Vector3(-5.08, 1.6, 0),
    new THREE.Vector3(-4.2, 2.2, 0),
    new THREE.Vector3(4.2, 2.2, 0),
    new THREE.Vector3(5.08, 1.6, 0),
    new THREE.Vector3(5.08, -1.5, 0),
  ]);
  grp.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.25, 8), legMat));
  return grp;
}

function wire(points: THREE.Vector3[], color: number) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.3);
  const grp = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 80, 0.55, 12), new THREE.MeshStandardMaterial({ color, roughness: 0.45 }));
  tube.castShadow = true;
  grp.add(tube);
  // 两端的插针头
  for (const p of [points[0], points[points.length - 1]]) {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 4, 12), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }));
    tip.position.copy(p).add(new THREE.Vector3(0, 2, 0));
    grp.add(tip);
  }
  return grp;
}

export function createBench(container: HTMLElement): Bench {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1114);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(35, 1, 1, 2000);
  camera.position.set(-70, 120, 135);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(8, 4, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 40;
  controls.maxDistance = 420;

  const key = new THREE.DirectionalLight(0xfff3e0, 2.2);
  key.position.set(-80, 160, 60);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -120;
  key.shadow.camera.right = 120;
  key.shadow.camera.top = 120;
  key.shadow.camera.bottom = -120;
  key.shadow.radius = 4;
  key.shadow.bias = -0.0004;
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xbfd6ff, 0x1a120a, 0.35));

  const matTex = matTexture();
  matTex.wrapS = matTex.wrapT = THREE.RepeatWrapping;
  matTex.repeat.set(3, 3);
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ map: matTex, roughness: 0.92 }));
  mat.rotation.x = -Math.PI / 2;
  mat.receiveShadow = true;
  scene.add(mat);

  // 面包板（列沿 x）。开发板竖着跨在中缝上方：板子长边沿 z 不现实（板宽 25.4 > 中缝），
  // 这里采用常见做法：开发板旋转 90°，两排针分别插在 a 行与 j 行之外的两侧。
  const COLS = 30;
  const bb = breadboard(COLS);
  scene.add(bb.grp);
  const BB_TOP = 8.5;

  const board = devboard();
  // 板子长边沿 x：旋转 -90°，USB 朝左
  board.grp.rotation.y = -Math.PI / 2;
  board.grp.position.set(bb.colX(7), BB_TOP + 6.8, 0);
  scene.add(board.grp);
  board.grp.updateMatrixWorld();
  const pinWorld = (key: string) => board.pinPositions[key].clone().applyMatrix4(board.grp.matrixWorld);

  // LED 接 IO5：右排第 9 个
  const ledPinKey = 'R' + RIGHT_PINS.indexOf('IO5');
  const gpioPos = pinWorld(ledPinKey);
  const gndPos = pinWorld('R' + RIGHT_PINS.indexOf('GND', 10));

  const redLed = led(0xff2a1a);
  const ledCol = 24;
  redLed.grp.position.set(bb.colX(ledCol) + 1.27, BB_TOP + 2, bb.rowZ(7));
  scene.add(redLed.grp);
  const r = resistor();
  r.position.set(bb.colX(ledCol - 2) - 0.0, BB_TOP + 1.5, bb.rowZ(7) + 0.0);
  r.rotation.y = 0;
  scene.add(r);

  const lift = (v: THREE.Vector3, y: number) => new THREE.Vector3(v.x, y, v.z);
  const top = BB_TOP + 0.2;
  // IO5 → 电阻左端所在列
  const wStart = lift(gpioPos, top);
  const wEnd = new THREE.Vector3(bb.colX(ledCol - 4), top, bb.rowZ(9));
  scene.add(wire([wStart, lift(wStart, 26), new THREE.Vector3((wStart.x + wEnd.x) / 2, 30, (wStart.z + wEnd.z) / 2 + 6), lift(wEnd, 22), wEnd], 0xf2a33a));
  // LED 阴极 → GND
  const gStart = new THREE.Vector3(bb.colX(ledCol + 1), top, bb.rowZ(9));
  const gEnd = lift(gndPos, top);
  scene.add(wire([gStart, lift(gStart, 18), new THREE.Vector3((gStart.x + gEnd.x) / 2, 24, (gStart.z + gEnd.z) / 2 + 10), lift(gEnd, 18), gEnd], 0x2b2f36));

  // 标注
  const label = (text: string, pos: THREE.Vector3) => {
    const tex = canvasTexture(512, 128, (g) => {
      g.fillStyle = 'rgba(14,17,20,0.78)';
      g.beginPath();
      g.roundRect(4, 4, 504, 120, 24);
      g.fill();
      g.fillStyle = '#e9edf2';
      g.font = '600 52px Inter, Helvetica, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, 256, 66);
    });
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    s.scale.set(24, 6, 1);
    s.position.copy(pos);
    s.renderOrder = 10;
    scene.add(s);
  };
  label('GPIO5 → 220Ω → LED', new THREE.Vector3(bb.colX(ledCol - 1), 24, bb.rowZ(7) + 2));

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.9, 0.5, 0.88);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // 按键交互：按下 / 松开
  const ray = new THREE.Raycaster();
  let buttonCb: ((n: 'BOOT' | 'RST', d: boolean) => void) | null = null;
  let pressed: THREE.Mesh | null = null;
  const pick = (ev: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1), camera);
    return ray.intersectObjects(board.buttons)[0]?.object as THREE.Mesh | undefined;
  };
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    const b = pick(ev);
    if (!b) return;
    controls.enabled = false;
    pressed = b;
    b.position.y = b.userData.baseY - 0.4;
    buttonCb?.(b.name as 'BOOT' | 'RST', true);
  });
  window.addEventListener('pointerup', () => {
    if (!pressed) return;
    pressed.position.y = pressed.userData.baseY;
    buttonCb?.(pressed.name as 'BOOT' | 'RST', false);
    pressed = null;
    controls.enabled = true;
  });
  renderer.domElement.addEventListener('pointermove', (ev) => {
    renderer.domElement.style.cursor = pick(ev) ? 'pointer' : '';
  });

  let ledTarget = 0;
  let ledNow = 0;
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    // LED 亮灭有很短的过渡，像真实 LED 被眼睛看到的样子
    ledNow += (ledTarget - ledNow) * 0.55;
    redLed.lens.emissiveIntensity = ledNow * 6;
    redLed.light.intensity = ledNow * 2500;
    controls.update();
    composer.render();
  };
  tick();

  return {
    ledPin: 5,
    setGpio(level, enable) {
      const on = (enable >> 5) & 1 && (level >> 5) & 1;
      ledTarget = on ? 1 : 0;
    },
    setPowered(on) {
      board.pwrMat.emissiveIntensity = on ? 3 : 0;
    },
    onButton(cb) {
      buttonCb = cb;
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
    },
  };
}
