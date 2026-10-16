// 3D 工作台：830 孔面包板、ESP32 开发板、外接模组、杜邦线。全部程序生成，按真实尺寸（毫米），
// 不用任何厂商的设计文件或 3D 模型；引脚顺序取自乐鑫公开的用户指南（事实信息）。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createUsbHost, type UsbView } from './usb3d';
import type { PickTarget, PinInfo, ScenePickApi, ScreenPoint } from './scene-api';

// 单位：毫米
const PITCH = 2.54;

export type ChipId = 'esp32c3' | 'esp32s3';

/** 开发板定义。j1 / j3 照乐鑫用户指南的排针表，从 1 号针（天线端）起，写的是丝印原文。 */
export interface BoardSpec {
  chip: ChipId;
  title: string;
  /** 丝印上的板名（描述性使用型号，见 LICENSING.md） */
  silk: string;
  /** 板宽 / 板长（mm） */
  W: number;
  L: number;
  j1: string[];
  j3: string[];
  /** 内部引脚名（'IO4'、'3V3'、'GND'…），自 USB 端起编号；left = J1，right = J3。编辑器按它列可用 GPIO */
  left: string[];
  right: string[];
  /** 排针中心相对板中心沿长边的偏移：让每根针都落在面包板孔上 */
  headerZ: number;
  module: { title: string; flash: string; W: number; L: number; shieldL: number };
  /** 两个 USB-C（UART 桥 + 芯片原生 USB）还是一个 */
  dualUsb: boolean;
  rgbPin: number;
  bootPin: number;
  /** 放在面包板哪一列（中心）、旧版半块面包板的列数（元件列号以它为基准）、外接元件整体右移几列 */
  boardCol: number;
  cols: number;
  partOffset: number;
}

/** 丝印名 → 内部名：S3 板上 GPIO 只印数字、地印 G */
const internalName = (s: string) => (/^\d+$/.test(s) ? 'IO' + s : s === 'G' ? 'GND' : s);
/** 内部名 → scene-api 的 id */
const apiId = (n: string) => (/^IO\d+$/.test(n) ? 'GPIO' + n.slice(2) : n);

function makeSpec(s: Omit<BoardSpec, 'left' | 'right'>): BoardSpec {
  return { ...s, left: [...s.j1].reverse().map(internalName), right: [...s.j3].reverse().map(internalName) };
}

/** ESP32-C3-DevKitM-1：2×15 针，ESP32-C3-MINI-1 模组，RGB 在 GPIO8 */
export const BOARD_C3: BoardSpec = makeSpec({
  chip: 'esp32c3',
  title: 'ESP32-C3 DEV',
  silk: 'ESP32-C3-DevKitM-1',
  W: 25.4,
  L: 50.8,
  j1: ['GND', '3V3', '3V3', 'IO2', 'IO3', 'GND', 'RST', 'GND', 'IO0', 'IO1', 'IO10', 'GND', '5V', '5V', 'GND'],
  j3: ['GND', 'TX', 'RX', 'GND', 'IO9', 'IO8', 'GND', 'IO7', 'IO6', 'IO5', 'IO4', 'GND', 'IO18', 'IO19', 'GND'],
  headerZ: -2.54,
  module: { title: 'ESP32-C3-MINI-1', flash: 'H4', W: 13.2, L: 16.6, shieldL: 11.4 },
  dualUsb: false,
  rgbPin: 8,
  bootPin: 9,
  boardCol: 7,
  cols: 30,
  partOffset: 0,
});

/** ESP32-S3-DevKitC-1 v1.0：2×22 针，WROOM-1（N16R8），两个 USB-C（UART / USB），RGB 在 GPIO48（v1.1 改到 GPIO38） */
export const BOARD_S3: BoardSpec = makeSpec({
  chip: 'esp32s3',
  title: 'ESP32-S3 DEV',
  silk: 'ESP32-S3-DevKitC-1',
  W: 25.4,
  L: 62.7,
  j1: ['3V3', '3V3', 'RST', '4', '5', '6', '7', '15', '16', '17', '18', '8', '3', '46', '9', '10', '11', '12', '13', '14', '5V', 'G'],
  j3: ['G', 'TX', 'RX', '1', '2', '42', '41', '40', '39', '38', '37', '36', '35', '0', '45', '48', '47', '21', '20', '19', 'G', 'G'],
  headerZ: -1.27,
  module: { title: 'ESP32-S3-WROOM-1', flash: 'N16R8', W: 18, L: 25.5, shieldL: 17.6 },
  dualUsb: true,
  rgbPin: 48,
  bootPin: 0,
  boardCol: 8,
  cols: 40,
  partOffset: 10,
});

export const BOARDS: Record<ChipId, BoardSpec> = { esp32c3: BOARD_C3, esp32s3: BOARD_S3 };

/** 圆屏 GC9A01 在各芯片上的固定接线（内核按这个接线建模，见 core 的 lcd_pin） */
export const LCD_WIRING: Record<ChipId, { sclk: number; mosi: number; cs: number; dc: number; rst: number; bl: number }> = {
  esp32s3: { sclk: 12, mosi: 11, cs: 10, dc: 14, rst: 13, bl: 15 },
  esp32c3: { sclk: 6, mosi: 7, cs: 10, dc: 5, rst: 4, bl: 3 },
};

/** 示例里声明的外接元件（examples.json 的 scene.parts）。 */
export type PartSpec =
  | { type: 'led'; pin: number; color?: number; col?: number; label?: string }
  | { type: 'oled'; addr: number; sda: number; scl: number; label?: string }
  /** 1.28″ 圆屏 GC9A01（SPI2）：引脚按芯片固定，见 LCD_WIRING（S3：SCLK=12、MOSI=11、CS=10、DC=14、RST=13、背光=15；C3：6、7、10、5、4、3） */
  | { type: 'gc9a01'; spi?: number; label?: string }
  | { type: 'bme280'; addr: number; sda: number; scl: number; label?: string }
  /** SG90 舵机：信号接 pin，舵盘角度按 PWM 脉宽（0.5–2.5ms → 0–180°） */
  | { type: 'servo'; pin: number; freq?: number; label?: string }
  /** 10kΩ 电位器：两端接 3V3 / GND，滑片接 pin（ADC），旋钮可拖动 */
  | { type: 'pot'; pin: number; label?: string }
  /** 无源蜂鸣器模块（三针）：I/O 接 pin，LEDC 方波驱动；网页声音见 audio.ts，3D 里响的时候振膜起伏、冒声波 */
  | { type: 'buzzer'; pin: number; label?: string };

export interface SceneSpec {
  parts: PartSpec[];
  /** 初始机位（毫米，世界坐标） */
  view?: { position: [number, number, number]; target: [number, number, number] };
}

const DEFAULT_VIEW: Required<SceneSpec>['view'] = { position: [-40, 95, 105], target: [0, 6, 4] };

export interface Bench extends ScenePickApi {
  /** 按示例声明重建外接元件和接线（开发板、面包板不动） */
  setScene(spec: SceneSpec): void;
  /** 引脚电平 / 输出使能：低 32 位与高位分开传（JS 位运算只有 32 位，S3 有 49 个引脚） */
  setGpio(level: number, enable: number, pwm?: number[], levelHi?: number, enableHi?: number): void;
  /** 换开发板（按固件的芯片），外接元件随之重新接线 */
  setBoard(chip: ChipId): void;
  /** OLED 画面：128×64 字节亮度 */
  setOled(pixels: Uint8Array): void;
  /** GC9A01 画面：240×240 RGBA */
  setLcd(rgba: Uint8Array): void;
  /** 电位器位置 0..1（面板滑块改了以后同步 3D 旋钮） */
  setPot(pin: number, v: number): void;
  /** 用户在 3D 里拖动电位器旋钮 */
  onPot(cb: (pin: number, v: number) => void): void;
  setPowered(on: boolean): void;
  /** 板载 WS2812（C3 GPIO8 / S3 GPIO48）颜色，0–255 */
  setRgb(rgb: number[]): void;
  onButton(cb: (name: 'BOOT' | 'RST', down: boolean) => void): void;
  /** 按键在页面上的位置（clientX/Y）：给自动化测试用真实鼠标去按 3D 里的键；看不见时 null */
  buttonScreenPos(name: 'BOOT' | 'RST'): [number, number] | null;
  /** 原生 USB：固件枚举出设备后接上虚拟电脑（null 拔掉） */
  setUsb(v: UsbView | null): void;
  /** 性能基线：上一帧的绘制调用、三角形数与平均帧间隔 */
  stats(): { calls: number; triangles: number; frameMs: number; cpuMs: number; geometries: number; textures: number };
  dispose(): void;
}

/** 杜邦线颜色惯例（DESIGN §4）：红电源、黑地、黄 SCL、绿 SDA、橙信号 */
const WIRE = { vcc: 0xd8342a, gnd: 0x26282c, scl: 0xf2c230, sda: 0x2fa84f, sig: 0xf28c28 };
const ACCENT = 0x0d99ff;
const BAD = 0xf24822;

// ---------------------------------------------------------------- 材质与贴图

/** 共享材质：重建场景时不释放（disposeTree 跳过 userData.shared） */
function shared<T extends THREE.Material>(m: T): T {
  m.userData.shared = true;
  return m;
}
const MAT = {
  gold: shared(new THREE.MeshStandardMaterial({ color: 0xe6c36a, metalness: 1, roughness: 0.22 })),
  tin: shared(new THREE.MeshStandardMaterial({ color: 0xd9dce0, metalness: 1, roughness: 0.28 })),
  steel: shared(new THREE.MeshStandardMaterial({ color: 0xcdd1d6, metalness: 1, roughness: 0.3 })),
  plastic: shared(new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.62 })),
  plug: shared(new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.5 })),
  chip: shared(new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.45 })),
  hit: shared(new THREE.MeshBasicMaterial({ visible: false })),
};

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mt of mats) {
      if (mt.userData.shared) continue;
      for (const v of Object.values(mt)) if (v instanceof THREE.Texture) v.dispose();
      mt.dispose();
    }
  });
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

/** 平铺在 y 高度的水平面，UV 由 (x, z) 算：贴图上方 = uvTop 所指方向，便于丝印按实物方向画 */
function topPlane(x0: number, x1: number, z0: number, z1: number, y: number, uvOf: (x: number, z: number) => [number, number]) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, ...uvOf(pos.getX(i), pos.getZ(i)));
  return g;
}

/** 圆角矩形（中心在原点） */
function roundRect(w: number, h: number, r: number): THREE.Shape;
function roundRect<P extends THREE.Path>(w: number, h: number, r: number, path: P): P;
function roundRect(w: number, h: number, r: number, path: THREE.Path = new THREE.Shape()): THREE.Path {
  const x = -w / 2, y = -h / 2;
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r);
  path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
  return path;
}

/** 带安装孔的模组 PCB（竖立，正面朝 +z）：ExtrudeGeometry，正面贴丝印。原点在 PCB 下沿中点。 */
function modulePcb(W: number, H: number, T: number, holes: [number, number, number][], tex: THREE.Texture, side: number) {
  const s = roundRect(W, H, 0.8);
  for (const [x, y, r] of holes) {
    const p = new THREE.Path();
    p.absarc(x, y, r, 0, Math.PI * 2, true);
    s.holes.push(p);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: T, bevelEnabled: false, curveSegments: 16 });
  g.translate(0, H / 2, -T / 2);
  // 正反面 UV 用毫米坐标，贴图 repeat / offset 映射到 0..1
  tex.repeat.set(1 / W, 1 / H);
  tex.offset.set(0.5, 0.5 - 0);
  const front = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.05 });
  const edge = new THREE.MeshStandardMaterial({ color: side, roughness: 0.6 });
  const m = new THREE.Mesh(g, [front, edge]);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** 软边接触阴影：一张模糊的黑色圆角矩形贴在桌面上，比实时 AO 便宜得多 */
function contactShadow(w: number, d: number, opacity = 0.35) {
  const pad = 14;
  const tex = canvasTexture(256, 256, (g) => {
    // alphaMap 读绿色通道：黑底白形
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    g.filter = 'blur(18px)';
    g.fillStyle = '#fff';
    const sx = 256 / (w + 2 * pad), sz = 256 / (d + 2 * pad);
    g.beginPath();
    g.roundRect(pad * sx, pad * sz, w * sx, d * sz, 12);
    g.fill();
  });
  tex.colorSpace = THREE.NoColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 2 * pad, d + 2 * pad),
    new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: tex, transparent: true, opacity, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.05;
  m.renderOrder = -1;
  return m;
}

// ---------------------------------------------------------------- 面包板

/** 830 孔面包板（63 列 × 10 行 + 4 条 50 孔电源轨），165.1 × 54.6 × 8.5 mm。列沿 x，行 a–j 沿 z。
 *  孔位按 2.54 mm 栅格，开发板两排针（相距 22.86 mm）落在 b / i 行，a / j 行留给跳线——和实物一样。 */
const BB = { cols: 63, W: 165.1, D: 54.6, H: 8.5, x: -PITCH / 2 };
const rowZ = (r: number) => (r < 5 ? -(3.81 + (4 - r) * PITCH) : 3.81 + (r - 5) * PITCH);
const RAILS = [-22.86, -20.32, 20.32, 22.86];

function breadboard() {
  const grp = new THREE.Group();
  const { W, D, H, cols } = BB;
  const S = 14; // 贴图像素 / mm
  const cw = Math.round(W * S), ch = Math.round(D * S);
  const cx = (x: number) => (x + W / 2) * S;
  const cy = (z: number) => (z + D / 2) * S;
  const holeX = (j: number) => (j - (cols - 1) / 2) * PITCH;
  const holes: [number, number][] = [];
  for (let j = 0; j < cols; j++) for (let r = 0; r < 10; r++) holes.push([holeX(j), rowZ(r)]);
  for (const z of RAILS) for (let g = 0; g < 10; g++) for (let k = 0; k < 5; k++) holes.push([holeX(2 + g * 6 + k), z]);
  const drawHoles = (g: CanvasRenderingContext2D, bump: boolean) => {
    const hs = 1.1 * S;
    for (const [x, z] of holes) {
      const px = cx(x) - hs / 2, py = cy(z) - hs / 2;
      if (bump) {
        g.fillStyle = '#000';
        g.fillRect(px, py, hs, hs);
        continue;
      }
      // 方孔：上沿暗、下沿略亮，像往里凹；孔底能看到一点金属簧片
      const grad = g.createLinearGradient(0, py, 0, py + hs);
      grad.addColorStop(0, '#2a2a2a');
      grad.addColorStop(1, '#4a4a48');
      g.fillStyle = grad;
      g.fillRect(px, py, hs, hs);
      g.fillStyle = '#8c8c86';
      g.fillRect(px + hs * 0.3, py + hs * 0.55, hs * 0.4, hs * 0.18);
    }
  };
  const tex = canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#f4f2ec';
    g.fillRect(0, 0, cw, ch);
    // 电源轨红蓝线：外侧红 +，内侧蓝 −
    for (const sgn of [-1, 1]) {
      for (const [z, color] of [[25.0, '#d6372c'], [18.2, '#2d62d0']] as const) {
        g.fillStyle = color;
        g.fillRect(cx(-74), cy(sgn * z) - 0.25 * S, 148 * S, 0.5 * S);
      }
    }
    g.fillStyle = '#d6372c';
    g.font = `bold ${2.2 * S}px Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const sgn of [-1, 1]) for (const x of [-77.5, 77.5]) {
      g.fillStyle = '#d6372c';
      g.fillText('+', cx(x), cy(sgn * 22.86));
      g.fillStyle = '#2d62d0';
      g.fillText('−', cx(x), cy(sgn * 20.32));
    }
    // 行字母 a–j、列号 1 5 10 …（压印的浅灰字）
    g.fillStyle = '#9a978f';
    g.font = `${1.5 * S}px Helvetica, sans-serif`;
    'abcdefghij'.split('').forEach((ch2, r) => {
      g.fillText(ch2, cx(-W / 2 + 1.6), cy(rowZ(r)));
      g.fillText(ch2, cx(W / 2 - 1.6), cy(rowZ(r)));
    });
    for (let j = 0; j < cols; j++) {
      if (j !== 0 && (j + 1) % 5) continue;
      g.fillText(String(j + 1), cx(holeX(j)), cy(rowZ(0) - 2.3));
      g.fillText(String(j + 1), cx(holeX(j)), cy(rowZ(9) + 2.3));
    }
    drawHoles(g, false);
  });
  const bump = canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cw, ch);
    g.filter = `blur(${0.12 * S}px)`;
    drawHoles(g, true);
  });
  bump.colorSpace = THREE.NoColorSpace;
  const topMat = new THREE.MeshStandardMaterial({ map: tex, bumpMap: bump, bumpScale: 1.2, roughness: 0.72 });
  const sideMat = new THREE.MeshStandardMaterial({ color: 0xeeebe3, roughness: 0.75 });
  const uvOf = (x: number, z: number): [number, number] => [(x + W / 2) / W, 1 - (z + D / 2) / D];
  const G = 1.3; // 中间凹槽半宽
  for (const s of [-1, 1]) {
    const z0 = s < 0 ? -D / 2 : G, z1 = s < 0 ? -G : D / 2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, z1 - z0), sideMat);
    body.position.set(0, H / 2, (z0 + z1) / 2);
    body.castShadow = body.receiveShadow = true;
    grp.add(body);
    const top = new THREE.Mesh(topPlane(-W / 2, W / 2, z0, z1, H + 0.01, uvOf), topMat);
    top.receiveShadow = true;
    grp.add(top);
  }
  const grooveFloor = new THREE.Mesh(new THREE.BoxGeometry(W, H - 2.6, 2 * G), new THREE.MeshStandardMaterial({ color: 0xdedad0, roughness: 0.8 }));
  grooveFloor.position.y = (H - 2.6) / 2;
  grooveFloor.receiveShadow = true;
  grp.add(grooveFloor);
  grp.add(contactShadow(W, D, 0.3));
  grp.position.x = BB.x;
  return grp;
}

// ---------------------------------------------------------------- 开发板

interface PinRec {
  /** scene-api id：'GPIO4' / 'GND' / 'bme280:SDA' */
  id: string;
  /** 丝印文字 */
  label: string;
  /** 高亮蓝圈、标签、尺子用的锚点（父节点局部坐标） */
  anchor: THREE.Vector3;
  parent: THREE.Object3D;
  /** 开发板针：内部名（'IO4'）与插进面包板的位置（局部） */
  name?: string;
}

/** 给一组针脚加拾取盒（不可见、比针大一圈，好点）；一组一个 InstancedMesh */
function pinHits(parent: THREE.Object3D, recs: PinRec[], centers: THREE.Vector3[], size: [number, number, number], out: PinRec[]) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(...size), MAT.hit, recs.length);
  const m = new THREE.Matrix4();
  centers.forEach((c, i) => mesh.setMatrixAt(i, m.makeTranslation(c.x, c.y, c.z)));
  mesh.userData.pinIds = recs.map((r) => r.id);
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
  parent.add(mesh);
  out.push(...recs);
}

function silkTexture(spec: BoardSpec, pinX: number, pinZ: (i: number) => number) {
  // PCB 顶面：黑色阻焊 + 白色丝印。画布按"USB 在下、J1 在左"的实物方向画（贴图 UV 已按此映射）
  const S = 40;
  const { W, L } = spec;
  const cw = Math.round(W * S), ch = Math.round(L * S);
  const cx = (x: number) => (W / 2 - x) * S;
  const cy = (z: number) => (L / 2 - z) * S;
  const n = spec.j1.length;
  return canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#121316';
    g.fillRect(0, 0, cw, ch);
    // 隐约可见的走线（阻焊下的铜）
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 0.25 * S;
    for (let i = 0; i < n; i += 2) {
      g.beginPath();
      g.moveTo(cx(pinX - 1.4), cy(pinZ(i)));
      g.lineTo(cx(3), cy(pinZ(i) + 2));
      g.moveTo(cx(-pinX + 1.4), cy(pinZ(i)));
      g.lineTo(cx(-3), cy(pinZ(i) - 2));
      g.stroke();
    }
    // 焊盘
    for (let i = 0; i < n; i++) {
      for (const x of [pinX, -pinX]) {
        g.fillStyle = '#d9b860';
        g.beginPath();
        g.arc(cx(x), cy(pinZ(i)), 0.85 * S, 0, Math.PI * 2);
        g.fill();
      }
    }
    // 引脚号：J1 在左（+x），J3 在右（−x），写在针内侧；1 号针（天线端）丝印方框
    g.fillStyle = '#f2f2f2';
    g.textBaseline = 'middle';
    g.font = `bold ${1.15 * S}px "JetBrains Mono", Menlo, monospace`;
    for (let i = 0; i < n; i++) {
      const z = pinZ(n - 1 - i); // j1[i]：i=0 是天线端
      g.textAlign = 'left';
      g.fillText(spec.j1[i], cx(pinX - 1.3), cy(z));
      g.textAlign = 'right';
      g.fillText(spec.j3[i], cx(-pinX + 1.3), cy(z));
    }
    g.strokeStyle = '#f2f2f2';
    g.lineWidth = 0.15 * S;
    for (const x of [pinX, -pinX]) g.strokeRect(cx(x) - 1.2 * S, cy(pinZ(n - 1)) - 1.2 * S, 2.4 * S, 2.4 * S);
    g.textAlign = 'center';
    g.font = `bold ${0.9 * S}px Helvetica, sans-serif`;
    g.fillText('J1', cx(pinX), cy(pinZ(n - 1) + 2.2));
    g.fillText('J3', cx(-pinX), cy(pinZ(n - 1) + 2.2));
    // 板名、按键、USB 标注
    g.font = `bold ${1.2 * S}px Helvetica, sans-serif`;
    g.fillText(spec.silk, cx(0), cy(L / 2 - spec.module.L - 2.6));
    g.font = `bold ${0.95 * S}px Helvetica, sans-serif`;
    g.fillText('BOOT', cx(W * 0.26), cy(-L / 2 + 13.6));
    g.fillText('RST', cx(-W * 0.26), cy(-L / 2 + 13.6));
    if (spec.dualUsb) {
      g.fillText('USB', cx(W * 0.21), cy(-L / 2 + 8.4));
      g.fillText('UART', cx(-W * 0.21), cy(-L / 2 + 8.4));
    }
    g.font = `${0.8 * S}px Helvetica, sans-serif`;
    g.fillText('RGB', cx(-W * 0.06), cy(-L / 2 + 20.3));
  });
}

function shieldTexture(spec: BoardSpec, w: number, l: number) {
  // 屏蔽罩顶面：拉丝金属 + 激光刻字（贴图 + bump 一起画，刻痕有一点凹感）
  const S = 48;
  const cw = Math.round(w * S), ch = Math.round(l * S);
  const text = (g: CanvasRenderingContext2D, color: string) => {
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${1.55 * S}px Helvetica, sans-serif`;
    g.fillText(spec.module.title, cw / 2, ch * 0.32);
    g.font = `${1.1 * S}px "JetBrains Mono", Menlo, monospace`;
    g.fillText(spec.module.flash, cw / 2, ch * 0.32 + 2.2 * S);
    g.strokeStyle = color;
    g.lineWidth = 0.1 * S;
    // 二维码位置的方块
    const q = 4.2 * S;
    g.strokeRect(cw / 2 - q / 2, ch * 0.62, q, q);
    for (let i = 0; i < 36; i++) if ((i * 7919) % 3 === 0) g.fillRect(cw / 2 - q / 2 + (i % 6) * (q / 6), ch * 0.62 + Math.floor(i / 6) * (q / 6), q / 6, q / 6);
  };
  const map = canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#b9bdc3';
    g.fillRect(0, 0, cw, ch);
    for (let y = 0; y < ch; y += 2) {
      g.fillStyle = `rgba(${(y * 37) % 2 ? 255 : 0},${(y * 37) % 2 ? 255 : 0},${(y * 37) % 2 ? 255 : 0},${0.03 + ((y * 7) % 5) * 0.008})`;
      g.fillRect(0, y, cw, 1);
    }
    text(g, '#5d6168');
  });
  const bump = canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cw, ch);
    text(g, '#000');
  });
  bump.colorSpace = THREE.NoColorSpace;
  return { map, bump };
}

function modulePcbTexture(spec: BoardSpec) {
  // 模组底板：深色阻焊、天线区的蛇形铜线、侧边邮票孔
  const { W, L, shieldL } = spec.module;
  const S = 40;
  const cw = Math.round(W * S), ch = Math.round(L * S);
  return canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#1b2026';
    g.fillRect(0, 0, cw, ch);
    const antL = L - shieldL - 1;
    g.strokeStyle = '#a88a4a';
    g.lineWidth = 0.45 * S;
    g.beginPath();
    const y0 = 0.8 * S, y1 = (antL - 0.8) * S;
    let x = 1.6 * S;
    g.moveTo(x, y1);
    for (let i = 0; i < 7; i++) {
      g.lineTo(x, y0);
      x += 1.1 * S;
      g.lineTo(x, y0);
      g.lineTo(x, y1 * 0.8);
      x += 1.1 * S;
      g.lineTo(x, y1 * 0.8);
    }
    g.stroke();
    g.fillStyle = '#d9b860';
    for (let z = antL + 1.2; z < L - 0.5; z += 1.27) {
      g.beginPath();
      g.arc(0, z * S, 0.35 * S, 0, Math.PI * 2);
      g.arc(cw, z * S, 0.35 * S, 0, Math.PI * 2);
      g.fill();
    }
  });
}

function devboard(spec: BoardSpec) {
  const grp = new THREE.Group();
  grp.userData.pick = { kind: 'part', id: 'board' } satisfies PickTarget;
  const { W, L } = spec;
  const T = 1.6;
  const n = spec.j1.length;
  const pinX = 11.43; // 两排针相距 0.9″（22.86 mm），正好落在面包板 b / i 行
  // 第 i 根（自 USB 端）针的 z
  const pinZ = (i: number) => spec.headerZ + (i - (n - 1) / 2) * PITCH;

  // PCB：侧面黑、顶面丝印贴图
  const pcbSide = new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.6 });
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(W, T, L), pcbSide);
  pcb.castShadow = pcb.receiveShadow = true;
  grp.add(pcb);
  const silk = silkTexture(spec, pinX, pinZ);
  const top = new THREE.Mesh(
    topPlane(-W / 2, W / 2, -L / 2, L / 2, T / 2 + 0.005, (x, z) => [(W / 2 - x) / W, (z + L / 2) / L]),
    new THREE.MeshStandardMaterial({ map: silk, roughness: 0.42, metalness: 0.05 }),
  );
  top.receiveShadow = true;
  grp.add(top);

  // 模组：PCB 底板（含天线区）+ 金属屏蔽罩（刻型号）
  const md = spec.module;
  const modZ = L / 2 - md.L / 2;
  const modBase = new THREE.Mesh(new THREE.BoxGeometry(md.W, 0.8, md.L), new THREE.MeshStandardMaterial({ color: 0x1b2026, roughness: 0.55 }));
  modBase.position.set(0, T / 2 + 0.4, modZ);
  modBase.castShadow = true;
  grp.add(modBase);
  const modTop = new THREE.Mesh(
    topPlane(-md.W / 2, md.W / 2, modZ - md.L / 2, modZ + md.L / 2, T / 2 + 0.81, (x, z) => [(md.W / 2 - x) / md.W, (z - (modZ - md.L / 2)) / md.L]),
    new THREE.MeshStandardMaterial({ map: modulePcbTexture(spec), roughness: 0.45 }),
  );
  grp.add(modTop);
  const shW = md.W - 1.4, shL = md.shieldL, shH = 2.3;
  const shZ = modZ - md.L / 2 + 0.7 + shL / 2;
  const metal = new THREE.MeshStandardMaterial({ color: 0xc3c7cc, metalness: 1, roughness: 0.3 });
  const shield = new THREE.Mesh(new THREE.BoxGeometry(shW, shH, shL), metal);
  shield.position.set(0, T / 2 + 0.8 + shH / 2, shZ);
  shield.castShadow = true;
  grp.add(shield);
  const st = shieldTexture(spec, shW, shL);
  const shieldTop = new THREE.Mesh(
    topPlane(-shW / 2, shW / 2, shZ - shL / 2, shZ + shL / 2, T / 2 + 0.8 + shH + 0.005, (x, z) => [(shW / 2 - x) / shW, (z - (shZ - shL / 2)) / shL]),
    new THREE.MeshStandardMaterial({ map: st.map, bumpMap: st.bump, bumpScale: 0.6, metalness: 0.9, roughness: 0.34 }),
  );
  grp.add(shieldTop);

  // USB-C 口：不锈钢外壳（跑道形截面）+ 黑色舌片。C3 一个，S3 两个（左 USB 原生、右 UART 桥）
  const usbX = spec.dualUsb ? [W * 0.21, -W * 0.21] : [0];
  const shellShape = roundRect(8.94, 3.26, 1.6);
  shellShape.holes.push(roundRect(8.3, 2.62, 1.3, new THREE.Path()));
  const shellGeo = new THREE.ExtrudeGeometry(shellShape, { depth: 7.35, bevelEnabled: false, curveSegments: 10 });
  for (const x of usbX) {
    const shell = new THREE.Mesh(shellGeo, MAT.steel);
    shell.position.set(x, T / 2 + 1.63, -L / 2 - 0.6);
    shell.castShadow = true;
    grp.add(shell);
    const back = new THREE.Mesh(new THREE.BoxGeometry(8.3, 2.6, 0.4), MAT.steel);
    back.position.set(x, T / 2 + 1.63, -L / 2 - 0.6 + 7.1);
    grp.add(back);
    const inner = new THREE.Mesh(new THREE.BoxGeometry(8.2, 2.5, 6.6), MAT.plastic);
    inner.position.set(x, T / 2 + 1.63, -L / 2 - 0.6 + 3.9);
    grp.add(inner);
    const tongue = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.7, 4.2), MAT.plug);
    tongue.position.set(x, T / 2 + 1.63, -L / 2 - 0.6 + 2.0);
    grp.add(tongue);
  }

  // 按键 BOOT / RST（贴片轻触开关：黑色底座 + 金属盖板 + 按柱）
  const buttons: THREE.Mesh[] = [];
  for (const [name, x] of [['BOOT', W * 0.26], ['RST', -W * 0.26]] as const) {
    const bz = -L / 2 + 10.5;
    const pick = { kind: 'button', id: name } satisfies PickTarget;
    const base = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.0, 3.2), MAT.plastic);
    base.position.set(x, T / 2 + 0.5, bz);
    base.userData.pick = pick;
    grp.add(base);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.15, 2.8), MAT.steel);
    plate.position.set(x, T / 2 + 1.08, bz);
    plate.userData.pick = pick;
    grp.add(plate);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.7, 24), MAT.plug);
    cap.position.set(x, T / 2 + 1.5, bz);
    cap.name = name;
    cap.userData.baseY = cap.position.y;
    cap.userData.pick = pick;
    grp.add(cap);
    buttons.push(cap);
  }

  // 板上其它器件：USB-UART 桥、LDO、贴片阻容（实例化，一次绘制）
  const chips: [number, number, number, number, number][] = [
    // x, z, w, l, h
    [0, -L / 2 + 28, 5.0, 3.5, 1.6], // LDO SOT-223
    ...(spec.dualUsb ? ([[W * 0.2, -L / 2 + 17, 4, 4, 0.85]] as [number, number, number, number, number][]) : []),
  ];
  const chipMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), MAT.chip, chips.length);
  const m = new THREE.Matrix4();
  chips.forEach(([x, z, w, l, h], i) => chipMesh.setMatrixAt(i, m.compose(new THREE.Vector3(x, T / 2 + h / 2, z), new THREE.Quaternion(), new THREE.Vector3(w, h, l))));
  chipMesh.castShadow = true;
  grp.add(chipMesh);
  const smd: [number, number, number][] = [];
  for (let k = 0; k < 14; k++) {
    const x = ((k % 5) - 2) * 2.2 + (k > 9 ? 1 : 0);
    const z = -L / 2 + 21.5 + Math.floor(k / 5) * 1.6 + (k % 2) * 0.3;
    smd.push([x, z, k % 3]);
  }
  for (let k = 0; k < 4; k++) smd.push([((k % 2) ? 1 : -1) * 4.6, -L / 2 + 27.2 + Math.floor(k / 2) * 1.8, (k + 1) % 3]);
  const smdMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.5, 0.8), new THREE.MeshStandardMaterial({ roughness: 0.5 }), smd.length);
  const colors = [new THREE.Color(0x1a1a1a), new THREE.Color(0xa58a62), new THREE.Color(0x8a7a66)];
  smd.forEach(([x, z, c], i) => {
    smdMesh.setMatrixAt(i, m.makeTranslation(x, T / 2 + 0.25, z));
    smdMesh.setColorAt(i, colors[c]);
  });
  grp.add(smdMesh);

  // 板载电源灯（红，0603）
  const pwrMat = new THREE.MeshStandardMaterial({ color: 0x5a1010, emissive: 0xff2010, emissiveIntensity: 0 });
  const pwr = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.8), pwrMat);
  pwr.position.set(W * 0.2, T / 2 + 0.3, -L / 2 + 20.6);
  grp.add(pwr);

  // 板载 WS2812（5050）：白色塑料框 + 半透明扩散面
  const rgbZ = -L / 2 + 17.0;
  const rgbX = -W * 0.06;
  const rgbBody = new THREE.Mesh(new THREE.BoxGeometry(5, 1.5, 5), new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.6 }));
  rgbBody.position.set(rgbX, T / 2 + 0.75, rgbZ);
  rgbBody.castShadow = true;
  grp.add(rgbBody);
  const rgbMat = new THREE.MeshStandardMaterial({ color: 0xdedbd2, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.3 });
  const rgbLens = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.1, 32), rgbMat);
  rgbLens.position.set(rgbX, T / 2 + 1.52, rgbZ);
  grp.add(rgbLens);
  const rgbLight = new THREE.PointLight(0xffffff, 0, 70, 2);
  rgbLight.position.set(rgbX, T / 2 + 5, rgbZ);
  grp.add(rgbLight);

  // 排针：每针一个黑塑料座（实例化）+ 镀金针（实例化）+ 板面焊点（实例化）
  const headerY = -T / 2 - 1.25;
  const pinTop = T / 2 + 1.0, pinBot = -T / 2 - 2.5 - 6;
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(2.5, 2.5, 2.42), MAT.plastic, 2 * n);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, pinTop - pinBot, 0.64), MAT.gold, 2 * n);
  const solderGeo = new THREE.SphereGeometry(0.85, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  solderGeo.scale(1, 0.7, 1);
  const solder = new THREE.InstancedMesh(solderGeo, MAT.tin, 2 * n);
  const recs: PinRec[] = [];
  const centers: THREE.Vector3[] = [];
  const pinPositions: Record<string, THREE.Vector3> = {};
  let k = 0;
  for (const [side, x, names, silkNames] of [['L', pinX, spec.left, [...spec.j1].reverse()], ['R', -pinX, spec.right, [...spec.j3].reverse()]] as const) {
    for (let i = 0; i < n; i++) {
      const z = pinZ(i);
      blocks.setMatrixAt(k, m.makeTranslation(x, headerY, z));
      pins.setMatrixAt(k, m.makeTranslation(x, (pinTop + pinBot) / 2, z));
      solder.setMatrixAt(k, m.makeTranslation(x, T / 2, z));
      k++;
      pinPositions[side + i] = new THREE.Vector3(x, 0, z);
      recs.push({ id: apiId(names[i]), label: silkNames[i], name: names[i], anchor: new THREE.Vector3(x, pinTop, z), parent: grp });
      centers.push(new THREE.Vector3(x, (pinTop + headerY - 1.25) / 2, z));
    }
  }
  blocks.castShadow = true;
  pins.castShadow = true;
  for (const im of [blocks, pins, solder]) grp.add(im);
  const pinRecs: PinRec[] = [];
  pinHits(grp, recs, centers, [2.3, pinTop - headerY + 1.25 + 0.6, 2.3], pinRecs);
  // 原生 USB 口口沿（setUsb 用）
  const usbPort = new THREE.Vector3(usbX[0], T / 2 + 1.6, -L / 2 - 0.6);
  return { grp, buttons, pwrMat, rgbMat, rgbLight, pinPositions, pinRecs, usbPort, L, T, spec };
}

// ---------------------------------------------------------------- 模组与元件

/** 4 / 8 针排针（黑色塑料条 + 金针），竖插：原点在面包板表面，针沿 x 排列 */
function moduleHeader(grp: THREE.Group, count: number) {
  const plastic = new THREE.Mesh(new THREE.BoxGeometry(count * PITCH, 2.5, 2.5), MAT.plastic);
  plastic.position.y = 1.25;
  grp.add(plastic);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 11, 0.64), MAT.gold, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) pins.setMatrixAt(i, m.makeTranslation((i - (count - 1) / 2) * PITCH, 1.5, 0));
  grp.add(pins);
  return Array.from({ length: count }, (_, i) => new THREE.Vector3((i - (count - 1) / 2) * PITCH, 0, 0));
}

/** 1.28″ GC9A01 圆屏模组：圆形 PCB 竖插在面包板上，8 针。原点在排针根部。 */
const LCD_PINS = ['GND', 'VCC', 'SCL', 'SDA', 'RES', 'DC', 'CS', 'BLK'];
function roundLcdModule(tex: THREE.Texture) {
  const grp = new THREE.Group();
  const R = 19, T = 1.2;
  const pcbTex = canvasTexture(512, 512, (g) => {
    g.fillStyle = '#17181b';
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = '#eef0f3';
    g.font = 'bold 15px "JetBrains Mono", Menlo, monospace';
    g.textAlign = 'center';
    // 贴图按 mm 映射：x ∈ [-R, R] → 0..512；针脚标注在底部条上
    LCD_PINS.forEach((t, i) => g.fillText(t, 256 + ((i - 3.5) * PITCH * 512) / (2 * R), 512 - (2.2 * 512) / (2 * R + 6)));
  });
  const shape = new THREE.Shape();
  shape.absarc(0, R + 3, R, 0, Math.PI * 2, false);
  const pcbGeo = mergeGeometries([
    new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 64 }),
    new THREE.ExtrudeGeometry(roundRect(22, 8, 0.6), { depth: T, bevelEnabled: false }).translate(0, 4.5, 0),
  ]);
  pcbGeo.translate(0, 0, -T / 2);
  pcbTex.repeat.set(1 / (2 * R), 1 / (2 * R + 6));
  pcbTex.offset.set(0.5, 0);
  const pcb = new THREE.Mesh(pcbGeo, new THREE.MeshStandardMaterial({ map: pcbTex, roughness: 0.55 }));
  pcb.position.y = 0.5;
  pcb.castShadow = true;
  grp.add(pcb);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(17.2, 17.2, 1.4, 64), new THREE.MeshPhysicalMaterial({ color: 0x07080a, roughness: 0.05, metalness: 0.2, clearcoat: 1 }));
  glass.rotation.x = Math.PI / 2;
  glass.position.set(0, 0.5 + R + 3, T / 2 + 0.7);
  grp.add(glass);
  const screen = new THREE.Mesh(new THREE.CircleGeometry(16.25, 64), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, glass.position.y, glass.position.z + 0.71);
  grp.add(screen);
  const pins = moduleHeader(grp, 8);
  return { grp, pins, labels: LCD_PINS };
}

/** 0.96″ SSD1306 模组：蓝色 PCB 27.3 × 27.8、4 个 Φ2 安装孔、玻璃 + 排线，竖插，屏幕朝观察者。原点在排针根部。 */
function oledModule(tex: THREE.Texture) {
  const grp = new THREE.Group();
  const W = 27.3, H = 27.8, T = 1.2;
  const labels = ['GND', 'VCC', 'SCL', 'SDA'];
  const S = 18;
  const pcbTex = canvasTexture(Math.round(W * S), Math.round(H * S), (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = '#1f55b0';
    g.fillRect(0, 0, cw, ch);
    // 贴图 y 向下 = 模组从上往下；针在下沿
    g.fillStyle = '#d9b860';
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.arc(cw / 2 + (i - 1.5) * PITCH * S, ch - 1.6 * S, 0.8 * S, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#eef3fb';
    g.font = `bold ${1.3 * S}px "JetBrains Mono", Menlo, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    labels.forEach((t, i) => g.fillText(t, cw / 2 + (i - 1.5) * PITCH * S * 1.0, ch - 3.6 * S));
    g.strokeStyle = '#eef3fb';
    g.lineWidth = 0.25 * S;
    for (const [x, y] of [[2, 2], [W - 2, 2], [2, H - 2], [W - 2, H - 2]]) {
      g.beginPath();
      g.arc(x * S, y * S, 1.6 * S, 0, Math.PI * 2);
      g.stroke();
    }
  });
  const pcb = modulePcb(W, H, T, [[-W / 2 + 2, H / 2 - 2, 1], [W / 2 - 2, H / 2 - 2, 1], [-W / 2 + 2, -H / 2 + 2, 1], [W / 2 - 2, -H / 2 + 2, 1]].map(([x, y, r]) => [x, y, r] as [number, number, number]), pcbTex, 0x18458f);
  pcb.position.y = 0.6;
  grp.add(pcb);
  // 玻璃面板（黑）+ 有效显示区 + 底部琥珀色排线
  const glassY = 0.6 + H - 19.26 / 2 - 0.5;
  const glass = new THREE.Mesh(new THREE.BoxGeometry(26.7, 19.26, 1.4), new THREE.MeshPhysicalMaterial({ color: 0x07080a, roughness: 0.06, metalness: 0.2, clearcoat: 1 }));
  glass.position.set(0, glassY, T / 2 + 0.7);
  glass.castShadow = true;
  grp.add(glass);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(21.74, 10.86), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, glassY + 1.6, glass.position.z + 0.71);
  grp.add(screen);
  const fpc = new THREE.Mesh(new THREE.BoxGeometry(12, 2.2, 0.15), new THREE.MeshStandardMaterial({ color: 0xc9821c, roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.92 }));
  fpc.position.set(0, glassY - 9.63 - 1.0, T / 2 + 0.08);
  grp.add(fpc);
  const pins = moduleHeader(grp, 4);
  return { grp, pins, labels };
}

/** BME280 小板：紫色 PCB 13 × 10.5、一个安装孔、金属壳传感器 2.5 × 2.5，竖插。原点在排针根部。 */
function bmeModule() {
  const grp = new THREE.Group();
  const W = 13, H = 10.5, T = 1.2;
  const labels = ['VIN', 'GND', 'SCL', 'SDA'];
  const S = 32;
  const tex = canvasTexture(W * S, Math.round(H * S), (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = '#5a2a8a';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#d9b860';
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.arc(cw / 2 + (i - 1.5) * PITCH * S, ch - 1.4 * S, 0.75 * S, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#f3ecfa';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${0.95 * S}px "JetBrains Mono", Menlo, monospace`;
    labels.forEach((t, i) => g.fillText(t, cw / 2 + (i - 1.5) * PITCH * S, ch - 3.0 * S));
    g.font = `bold ${1.1 * S}px Helvetica, sans-serif`;
    g.fillText('BME280', cw / 2 + 2.2 * S, 1.6 * S);
    g.strokeStyle = '#f3ecfa';
    g.lineWidth = 0.18 * S;
    g.beginPath();
    g.arc(2 * S, 2 * S, 1.6 * S, 0, Math.PI * 2);
    g.stroke();
  });
  const pcb = modulePcb(W, H, T, [[-W / 2 + 2, H / 2 - 2, 1.1]], tex, 0x45206b);
  pcb.position.y = 0.6;
  grp.add(pcb);
  const can = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 0.93), new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 1, roughness: 0.25 }));
  can.position.set(0.6, 0.6 + H / 2 + 0.6, T / 2 + 0.47);
  can.castShadow = true;
  grp.add(can);
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.1, 12), MAT.plastic);
  hole.rotation.x = Math.PI / 2;
  hole.position.set(can.position.x + 0.6, can.position.y + 0.6, can.position.z + 0.47);
  grp.add(hole);
  // 板上的稳压器与阻容
  const parts = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), MAT.chip, 4);
  const m = new THREE.Matrix4();
  [[-3.6, 6.6, 2.9, 1.6], [3.8, 4.6, 1.6, 0.8], [4.6, 7.4, 1.6, 0.8], [-3.6, 3.4, 1.6, 0.8]].forEach(([x, y, w, h], i) =>
    parts.setMatrixAt(i, m.compose(new THREE.Vector3(x, 0.6 + y, T / 2 + 0.3), new THREE.Quaternion(), new THREE.Vector3(w, h, 0.6))),
  );
  grp.add(parts);
  const pins = moduleHeader(grp, 4);
  return { grp, pins, labels };
}

/** SG90 舵机：蓝色半透明壳 22.2 × 11.8 × 22.7、带两个 Φ2 螺丝孔的固定耳、白色单臂舵盘、棕红橙三色线。原点在壳体底面中心。 */
function servoModel() {
  const grp = new THREE.Group();
  const blue = new THREE.MeshPhysicalMaterial({ color: 0x2d5bd3, roughness: 0.32, transmission: 0.12, thickness: 2 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(22.2, 22.7, 11.8), blue);
  body.position.y = 11.35;
  body.castShadow = true;
  grp.add(body);
  // 固定耳：一体的板，两端各一个螺丝孔（带孔挤出）
  const ear = roundRect(32.2, 11.8, 1.2);
  for (const x of [-13.85, 13.85]) {
    const p = new THREE.Path();
    p.absarc(x, 0, 1.0, 0, Math.PI * 2, true);
    ear.holes.push(p);
  }
  const earGeo = new THREE.ExtrudeGeometry(ear, { depth: 2.5, bevelEnabled: false, curveSegments: 16 });
  earGeo.rotateX(Math.PI / 2);
  const ears = new THREE.Mesh(earGeo, blue);
  ears.position.y = 17.2;
  ears.castShadow = true;
  grp.add(ears);
  // 标签贴纸（侧面）
  const label = canvasTexture(256, 128, (g) => {
    g.fillStyle = '#e9ecef';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#1e1e1e';
    g.font = 'bold 52px Helvetica, sans-serif';
    g.textAlign = 'center';
    g.fillText('SG90', 128, 64);
    g.font = '22px Helvetica, sans-serif';
    g.fillText('9g micro servo', 128, 100);
  });
  const sticker = new THREE.Mesh(new THREE.PlaneGeometry(16, 8), new THREE.MeshStandardMaterial({ map: label, roughness: 0.6 }));
  sticker.position.set(0, 8, 5.95);
  grp.add(sticker);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(5.9, 5.9, 4, 32), blue);
  tower.position.set(-5.4, 24.7, 0);
  grp.add(tower);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 3, 24), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }));
  shaft.position.set(-5.4, 28, 0);
  grp.add(shaft);
  const horn = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.55 });
  const hornShape = new THREE.Shape();
  hornShape.absarc(0, 0, 3.6, Math.PI / 2, (Math.PI * 3) / 2, false);
  hornShape.lineTo(16, -2.1);
  hornShape.absarc(16, 0, 2.1, -Math.PI / 2, Math.PI / 2, false);
  hornShape.lineTo(0, 3.6);
  for (let i = 0; i < 5; i++) {
    const p = new THREE.Path();
    p.absarc(6 + i * 2.2, 0, 0.45, 0, Math.PI * 2, true);
    hornShape.holes.push(p);
  }
  const hornGeo = new THREE.ExtrudeGeometry(hornShape, { depth: 1.6, bevelEnabled: false, curveSegments: 16 });
  hornGeo.rotateX(Math.PI / 2);
  const arm = new THREE.Mesh(hornGeo, white);
  arm.position.y = 0.8;
  horn.add(arm);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 1.6, 24), white);
  hub.position.y = 1.4;
  horn.add(hub);
  const screw = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.4, 16), MAT.steel);
  screw.position.y = 2.3;
  horn.add(screw);
  horn.position.set(-5.4, 29.5, 0);
  horn.traverse((o) => (o.castShadow = true));
  grp.add(horn);
  grp.add(contactShadow(32, 12, 0.35));
  return { grp, horn };
}

/** 无源蜂鸣器模块（三针，带 S8550 三极管）：蓝色 PCB 15 × 22、Φ12 × 8.5 黑色蜂鸣器、
 *  VCC I/O GND 丝印、直排针朝上（平放在桌面上，杜邦母头从上面插）。原点在 PCB 底面中心，排针在 -z 一侧（朝开发板）。 */
const BUZZER_PINS = ['VCC', 'I/O', 'GND'];
function buzzerModule() {
  const grp = new THREE.Group();
  const W = 15, H = 22, T = 1.2;
  const S = 28;
  const tex = canvasTexture(W * S, H * S, (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = '#1f55b0';
    g.fillRect(0, 0, cw, ch);
    // 贴图上沿 = 排针一侧
    g.fillStyle = '#d9b860';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(cw / 2 + (i - 1) * PITCH * S, 2 * S, 0.8 * S, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#eef3fb';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${1.05 * S}px "JetBrains Mono", Menlo, monospace`;
    BUZZER_PINS.forEach((t, i) => g.fillText(t, cw / 2 + (i - 1) * PITCH * 1.25 * S, 4.4 * S));
    g.strokeStyle = '#eef3fb';
    g.lineWidth = 0.18 * S;
    g.beginPath();
    g.arc(cw / 2, ch - 7.5 * S, 6.6 * S, 0, Math.PI * 2);
    g.stroke();
    g.font = `bold ${0.9 * S}px Helvetica, sans-serif`;
    g.fillText('Q1', cw / 2 - 4.6 * S, 7.4 * S);
    g.fillText('R1', cw / 2 + 4.6 * S, 7.4 * S);
  });
  const pcb = modulePcb(W, H, T, [], tex, 0x18458f);
  // modulePcb 是竖立的（y 向上 0..H）；平放：绕 x 转到水平，贴图上沿落在 -z
  const flat = new THREE.Group();
  flat.rotation.x = -Math.PI / 2;
  pcb.position.y = -H / 2;
  flat.add(pcb);
  flat.position.y = 1.2 + T / 2;
  grp.add(flat);
  const pcbTop = 1.2 + T;
  // 底面焊点把板子垫起来一点
  const feet = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 10), MAT.tin, 3);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 3; i++) feet.setMatrixAt(i, m.makeTranslation((i - 1) * PITCH, 0.6, -H / 2 + 2));
  grp.add(feet);
  // 蜂鸣器：黑色塑料圆柱 + 顶面声孔；振膜（声孔里的深色圆片）响的时候轻微起伏
  const body = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 8.5, 48), new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.48 }));
  const bz = H / 2 - 7.5;
  body.position.set(0, pcbTop + 4.25, bz);
  body.castShadow = true;
  grp.add(body);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.25, 8, 40).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.4 }));
  ring.position.set(0, pcbTop + 8.5, bz);
  grp.add(ring);
  const membrane = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.9 }));
  membrane.position.set(0, pcbTop + 8.52, bz);
  grp.add(membrane);
  // 三极管（TO-92 黑色半圆柱）与贴片电阻
  const q = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 4.5, 24, 1, false, 0, Math.PI), MAT.chip);
  q.position.set(-4.6, pcbTop + 2.25, -H / 2 + 7.4);
  q.castShadow = true;
  grp.add(q);
  const r = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.8), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5 }));
  r.position.set(4.6, pcbTop + 0.25, -H / 2 + 6);
  grp.add(r);
  // 排针：黑塑料座 + 金针（朝上）
  const plastic = new THREE.Mesh(new THREE.BoxGeometry(3 * PITCH, 2.5, 2.5), MAT.plastic);
  plastic.position.set(0, pcbTop + 1.25, -H / 2 + 2);
  grp.add(plastic);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 8.5, 0.64), MAT.gold, 3);
  for (let i = 0; i < 3; i++) pins.setMatrixAt(i, m.makeTranslation((i - 1) * PITCH, pcbTop + 4.25, -H / 2 + 2));
  grp.add(pins);
  // 杜邦母头插在排针上：插头底在塑料座顶面
  const plugAt = [0, 1, 2].map((i) => new THREE.Vector3((i - 1) * PITCH, pcbTop + 2.5, -H / 2 + 2));
  // 声波提示：蜂鸣器上方两道弧，响的时候出现并向外扩
  const waves = new THREE.Group();
  const waveMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.8, depthWrite: false });
  for (const k of [0, 1]) {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(4 + k * 2.6, 0.32, 6, 24, Math.PI * 0.6), waveMat);
    arc.rotation.z = Math.PI * 0.2;
    arc.raycast = () => {};
    waves.add(arc);
  }
  waves.position.set(0, pcbTop + 12, bz);
  waves.visible = false;
  grp.add(waves);
  return { grp, plugAt, labels: BUZZER_PINS, membrane, waves, waveMat, size: [W, H] as const };
}

/** 旋转电位器（R16 规格）：蓝色方壳 + 金属轴 + 黑色带指示线的旋钮。原点在引脚根部。 */
function potModel() {
  const grp = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.BoxGeometry(9.8, 9.8, 5), new THREE.MeshStandardMaterial({ color: 0x2e63b8, roughness: 0.6 }));
  shell.rotation.x = Math.PI / 2;
  shell.position.y = 3.5;
  shell.castShadow = true;
  grp.add(shell);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 4, 24), MAT.steel);
  shaft.position.y = 8;
  grp.add(shaft);
  const knob = new THREE.Group();
  const kmat = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.55 });
  const k = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 6, 7, 40), kmat);
  knob.add(k);
  const mark = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 4.6), new THREE.MeshBasicMaterial({ color: 0xf2a33a }));
  mark.position.set(0, 3.6, -2.6);
  knob.add(mark);
  knob.position.y = 13.5;
  knob.traverse((o) => (o.castShadow = true));
  grp.add(knob);
  for (const x of [-PITCH, 0, PITCH]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4, 0.6), MAT.tin);
    leg.position.set(x, -1, 0);
    grp.add(leg);
  }
  return { grp, knob, hit: k };
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
  for (const x of [-1.27, 1.27]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 4, 8), MAT.tin);
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
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.1, 4.2, 8, 16), new THREE.MeshStandardMaterial({ color: 0xd9c49a, roughness: 0.6 }));
  body.rotation.z = Math.PI / 2;
  body.position.y = 2.2;
  body.castShadow = true;
  grp.add(body);
  // 220Ω：红 红 棕 金
  [0xc62828, 0xc62828, 0x6d4c41, 0xc9a227].forEach((c, i) => {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1.16, 1.16, 0.45, 20), new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }));
    band.rotation.z = Math.PI / 2;
    band.position.set(-1.8 + i * 1.1 + (i === 3 ? 0.4 : 0), 2.2, 0);
    grp.add(band);
  });
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-5.08, -1.5, 0),
    new THREE.Vector3(-5.08, 1.6, 0),
    new THREE.Vector3(-4.2, 2.2, 0),
    new THREE.Vector3(4.2, 2.2, 0),
    new THREE.Vector3(5.08, 1.6, 0),
    new THREE.Vector3(5.08, -1.5, 0),
  ]);
  grp.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.25, 8), MAT.tin));
  return grp;
}

// ---------------------------------------------------------------- 导线

interface WireRec {
  id: string;
  ends: [string, string];
  grp: THREE.Group;
  tube: THREE.Mesh;
  curve: THREE.CatmullRomCurve3;
  mat: THREE.MeshStandardMaterial;
  color: number;
  thin: THREE.BufferGeometry;
  thick?: THREE.BufferGeometry;
}

const WIRE_R = 0.6;
/** 杜邦线：管状曲线 + 两端黑色插头（2.54 方、11 mm 高），插头合并成一个几何体 */
function wire(points: THREE.Vector3[], color: number, id: string, ends: [string, string]): WireRec {
  // 插头里那一段要笔直向上：Catmull-Rom 在第二个控制点的切线指向下一段，线会从插头侧面鼓出来。
  // 在插头内和插头顶各补一个正上方的控制点，弯曲只发生在插头之上
  const guide = (p: THREE.Vector3, q: THREE.Vector3) =>
    q.y > p.y + 13 ? [new THREE.Vector3(p.x, p.y + 5.5, p.z), new THREE.Vector3(p.x, p.y + 11.5, p.z)] : [];
  const n = points.length;
  const pts = [points[0], ...guide(points[0], points[1]), ...points.slice(1, n - 1), ...guide(points[n - 1], points[n - 2]).reverse(), points[n - 1]];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.3);
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.42 });
  const thin = new THREE.TubeGeometry(curve, 96, WIRE_R, 10);
  const tube = new THREE.Mesh(thin, mat);
  tube.castShadow = true;
  grp.add(tube);
  const housings = [points[0], points[points.length - 1]].map((p) => new THREE.BoxGeometry(2.4, 11, 2.4).translate(p.x, p.y + 5.5, p.z));
  const plug = new THREE.Mesh(mergeGeometries(housings), MAT.plug);
  plug.castShadow = true;
  grp.add(plug);
  grp.userData.pick = { kind: 'wire', id } satisfies PickTarget;
  return { id, ends, grp, tube, curve, mat, color, thin };
}

// ---------------------------------------------------------------- 场景主体

export function createBench(container: HTMLElement): Bench {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // 不做色调映射：白底极简风格要求背景和器件颜色与设计稿一致；发光体靠 bloom 表现，超出 1 的部分按色相裁掉
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.32;

  const camera = new THREE.PerspectiveCamera(35, 1, 1, 2000);
  camera.position.set(-40, 95, 105);
  const controls = new OrbitControls(camera, renderer.domElement);
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

  // 地面只接阴影（白底极简）；接触阴影另由各器件底下的软阴影片补
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.16 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // 主题：台面背景渐变（DESIGN §2）
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

  // DOM 叠加层：免责声明、针脚标签、故障标签、尺子读数
  const overlay = document.createElement('div');
  overlay.className = 'tb-overlay';
  overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;font:12px "Noto Sans SC",sans-serif';
  const note = document.createElement('div');
  note.textContent = '外观示意，非乐鑫官方模型';
  note.style.cssText = 'position:absolute;right:12px;bottom:10px;font-size:11px;color:#8C8C8C;letter-spacing:.02em';
  overlay.appendChild(note);
  const style = document.createElement('style');
  style.textContent = `.tb-tag{position:absolute;left:0;top:0;white-space:nowrap;padding:3px 8px;border-radius:8px;background:rgba(255,255,255,.95);border:1px solid #E6E6E6;box-shadow:0 2px 10px #0000000F;color:#1E1E1E;font:500 12px "JetBrains Mono",Menlo,monospace;will-change:transform}
.tb-tag.pin{border-color:#0D99FF;color:#0D99FF}.tb-tag.bad{background:#FEF2F2;border-color:#F24822;color:#F24822;font-family:"Noto Sans SC",sans-serif}
.tb-tag.ruler{background:#F24822;border-color:#F24822;color:#fff}
.tb-overlay[data-theme=dark] .tb-tag:not(.bad):not(.ruler){background:rgba(30,31,34,.95);border-color:#3a3c40;color:#E9EDF2}.tb-overlay[data-theme=dark] .tb-tag.pin{color:#5cb8ff;border-color:#0D99FF}`;
  overlay.appendChild(style);
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(overlay);
  const tags = new Map<string, { el: HTMLDivElement; at: () => THREE.Vector3 | null; dy: number }>();
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

  // 面包板与开发板随芯片切换（setBoard），外接元件按 partOffset 整体平移
  const BB_TOP = BB.H;
  scene.add(breadboard());
  let board = devboard(BOARD_C3);
  const placeBoard = () => {
    // 板子长边沿 x：旋转 -90°，USB 朝左；排针座落在面包板表面
    board.grp.rotation.y = -Math.PI / 2;
    board.grp.position.set((board.spec.boardCol - (board.spec.cols - 1) / 2) * PITCH, BB_TOP + 2.5 + board.T / 2, 0);
    scene.add(board.grp);
    board.grp.updateMatrixWorld();
  };
  placeBoard();
  /** 元件用的面包板列号（按当前开发板平移；列号基准沿用旧版半块面包板，示例机位不变） */
  const colX = (c: number) => (c + board.spec.partOffset - (board.spec.cols - 1) / 2) * PITCH;
  const pinWorld = (key: string) => board.pinPositions[key].clone().applyMatrix4(board.grp.matrixWorld);

  /** 开发板上某个引脚（'IO5'、'3V3'、'GND'…）的世界坐标；GND 取离 near 最近的那个 */
  const pinCands = (name: string) => {
    const cands: { key: string; p: THREE.Vector3 }[] = [];
    board.spec.right.forEach((n, i) => n === name && cands.push({ key: 'R' + i, p: pinWorld('R' + i) }));
    board.spec.left.forEach((n, i) => n === name && cands.push({ key: 'L' + i, p: pinWorld('L' + i) }));
    if (!cands.length) throw new Error(`开发板 ${board.spec.title} 上没有引脚 ${name}`);
    return cands;
  };
  /** 跳线插在开发板针同一列、板外那一行（a / j）；同名针（GND）优先用还空着的那根 */
  let holeUse = new Map<string, number>();
  const boardHole = (name: string, near?: THREE.Vector3) => {
    let cands = pinCands(name);
    if (near) cands = cands.sort((a, b) => a.p.distanceTo(near) - b.p.distanceTo(near));
    const c = cands.find((c) => !holeUse.get(c.key)) ?? cands[0];
    holeUse.set(c.key, (holeUse.get(c.key) ?? 0) + 1);
    const z = Math.sign(c.p.z) * -rowZ(0);
    return new THREE.Vector3(c.p.x, BB_TOP, z);
  };

  const lift = (v: THREE.Vector3, y: number) => new THREE.Vector3(v.x, y, v.z);
  const top = BB_TOP;

  // 拾取用的登记表（每次 setScene / setBoard 重建）
  const partsById = new Map<string, THREE.Object3D>();
  let modulePins: PinRec[] = [];
  let wires: WireRec[] = [];
  let roles = new Map<string, string[]>();
  const addRole = (pinId: string, role: string) => {
    const r = roles.get(pinId) ?? [];
    if (!r.includes(role)) r.push(role);
    roles.set(pinId, r);
  };
  const addWire = (grp: THREE.Group, points: THREE.Vector3[], color: number, boardPin: string, other: string) => {
    const a = apiId(boardPin);
    let id = `wire:${a}~${other}`;
    for (let k = 2; wires.some((w) => w.id === id); k++) id = `wire:${a}~${other}#${k}`;
    const w = wire(points, color, id, [a, other]);
    grp.add(w.grp);
    wires.push(w);
    return w;
  };
  /** 从开发板引脚拉一根跳线到面包板孔位，中间拱起。arc 从面包板表面量起：插头高 11 mm，
   *  拱高写成绝对值时线会贴着别的插头顶穿过去 */
  const jumper = (grp: THREE.Group, pin: string, to: THREE.Vector3, color: number, other: string, arc = 26, bow = 6) => {
    const a = boardHole(pin, to);
    const b = lift(to, top);
    const h = top + arc;
    addWire(grp, [a, lift(a, h - 4), new THREE.Vector3((a.x + b.x) / 2, h, (a.z + b.z) / 2 + bow), lift(b, h - 6), b], color, pin, other);
  };
  const registerPart = (id: string, o: THREE.Object3D) => {
    o.userData.pick = { kind: 'part', id } satisfies PickTarget;
    partsById.set(id, o);
  };
  const registerModulePins = (partId: string, root: THREE.Group, pins: THREE.Vector3[], labels: string[]) => {
    const recs = labels.map((l, i) => ({ id: `${partId}:${l}`, label: l, anchor: pins[i].clone(), parent: root }));
    // 拾取盒只罩住排针塑料座和 PCB 最底下一点：再高就盖住模块本体，点模块中间会选成针脚
    pinHits(root, recs, pins.map((p) => new THREE.Vector3(p.x, 2, p.z)), [2.3, 4, 2.8], modulePins);
  };

  // 标注（零件说明，浅色药丸）
  const label = (grp: THREE.Group, text: string, pos: THREE.Vector3) => {
    const font = '500 38px "Noto Sans SC", Helvetica, sans-serif';
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = font;
    const w = Math.ceil(probe.measureText(text).width) + 64;
    const tex = canvasTexture(w, 128, (g) => {
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.strokeStyle = '#E6E6E6';
      g.lineWidth = 3;
      g.beginPath();
      g.roundRect(4, 4, w - 8, 120, 28);
      g.fill();
      g.stroke();
      g.fillStyle = '#1E1E1E';
      g.font = font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, 66);
    });
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    s.scale.set((5 * w) / 128, 5, 1);
    s.position.copy(pos);
    s.renderOrder = 10;
    s.raycast = () => {};
    grp.add(s);
  };

  interface LedState {
    pin: number;
    lens: THREE.MeshPhysicalMaterial;
    light: THREE.PointLight;
    now: number;
    target: number;
  }
  let leds: LedState[] = [];
  let servos: { pin: number; horn: THREE.Group; freq: number; angle: number; target: number }[] = [];
  let pots: { pin: number; knob: THREE.Group; hit: THREE.Mesh; v: number }[] = [];
  let buzzers: { pin: number; membrane: THREE.Mesh; waves: THREE.Group; waveMat: THREE.MeshBasicMaterial; on: boolean }[] = [];
  let potCb: ((pin: number, v: number) => void) | null = null;
  let parts = new THREE.Group();
  scene.add(parts);
  const oledData = new Uint8Array(128 * 64 * 4);
  let oledTex: THREE.DataTexture | null = null;
  const lcdData = new Uint8Array(240 * 240 * 4);
  let lcdTex: THREE.DataTexture | null = null;

  function buildLed(grp: THREE.Group, p: Extract<PartSpec, { type: 'led' }>) {
    const root = new THREE.Group();
    const id = `led:${p.pin}`;
    registerPart(id, root);
    grp.add(root);
    const l = led(p.color ?? 0xff2a1a);
    const col = p.col ?? 24;
    l.grp.position.set(colX(col) + 1.27, BB_TOP + 2, rowZ(7));
    root.add(l.grp);
    const r = resistor();
    r.position.set(colX(col - 2), BB_TOP + 1.5, rowZ(7));
    root.add(r);
    // IO → 电阻左端所在列；LED 阴极 → GND
    jumper(grp, 'IO' + p.pin, new THREE.Vector3(colX(col - 4), top, rowZ(9)), WIRE.sig, `${id}:IN`, 30, 6);
    jumper(grp, 'GND', new THREE.Vector3(colX(col + 1), top, rowZ(9)), WIRE.gnd, `${id}:GND`, 24, 10);
    addRole(apiId('IO' + p.pin), 'LED（220Ω 限流）');
    addRole('GND', 'LED 地');
    label(grp, p.label ?? `GPIO${p.pin} → 220Ω → LED`, new THREE.Vector3(colX(col - 1), 34, rowZ(2) - 6));
    leds.push({ pin: p.pin, lens: l.lens, light: l.light, now: 0, target: 0 });
  }

  /** 竖插模组的跳线：先升起越过开发板，再在模组背后落进同一列的 a 行，不挡屏幕 */
  const moduleWire = (grp: THREE.Group, pin: string, hole: THREE.Vector3, color: number, other: string, peak: number, i: number) => {
    const a = boardHole(pin, hole);
    addWire(
      grp,
      [a, lift(a, 22 + i), new THREE.Vector3((a.x + hole.x) / 2, peak, Math.min(a.z, hole.z) - 6 - i * 1.5), new THREE.Vector3(hole.x, peak - 4, hole.z - 4), lift(hole, top + 15), hole],
      color,
      pin,
      other,
    );
  };

  /** 圆屏：8 根线（GND VCC SCL SDA RES DC CS BLK），SCL/SDA 在这里是 SPI 的 SCLK/MOSI */
  function buildSpiLcd(grp: THREE.Group, m: ReturnType<typeof roundLcdModule>, firstCol: number) {
    m.grp.position.set(colX(firstCol + 3.5), BB_TOP, rowZ(4));
    m.grp.rotation.x = -0.12;
    registerPart('gc9a01', m.grp);
    registerModulePins('gc9a01', m.grp, m.pins, m.labels);
    grp.add(m.grp);
    // 引脚与内核的接线约定一致：S3 见 esp32s3::lcd_pin，C3 见 esp32c3::lcd_pin（firmware/common/round_lcd.h 同）
    const p = LCD_WIRING[board.spec.chip];
    const order: [string, number, string][] = [
      ['GND', WIRE.gnd, 'LCD 地'],
      ['3V3', WIRE.vcc, 'LCD 供电'],
      [`IO${p.sclk}`, WIRE.scl, 'SPI SCLK'],
      [`IO${p.mosi}`, WIRE.sda, 'SPI MOSI'],
      [`IO${p.rst}`, WIRE.sig, 'LCD RST'],
      [`IO${p.dc}`, 0x8f5bd6, 'LCD DC'],
      [`IO${p.cs}`, 0x3f8fd6, 'LCD CS'],
      [`IO${p.bl}`, 0xd6d6d6, 'LCD 背光'],
    ];
    order.forEach(([pinName, color, role], i) => {
      moduleWire(grp, pinName, new THREE.Vector3(colX(firstCol + i), top, rowZ(0)), color, `gc9a01:${m.labels[i]}`, 50 + i * 1.4, i);
      addRole(apiId(pinName), role);
    });
  }

  function buildI2c(grp: THREE.Group, partId: string, name: string, m: { grp: THREE.Group; pins: THREE.Vector3[]; labels: string[] }, firstCol: number, sda: number, scl: number, height: number) {
    m.grp.position.set(colX(firstCol + 1.5), BB_TOP, rowZ(4));
    m.grp.rotation.x = -0.12; // 略向后仰，便于俯视
    registerPart(partId, m.grp);
    registerModulePins(partId, m.grp, m.pins, m.labels);
    grp.add(m.grp);
    m.labels.forEach((fn, i) => {
      const map: Record<string, [string, number, string]> = {
        GND: ['GND', WIRE.gnd, `${name} 地`],
        VCC: ['3V3', WIRE.vcc, `${name} 供电`],
        VIN: ['3V3', WIRE.vcc, `${name} 供电`],
        SDA: ['IO' + sda, WIRE.sda, 'I2C SDA'],
        SCL: ['IO' + scl, WIRE.scl, 'I2C SCL'],
      };
      const [pinName, color, role] = map[fn];
      moduleWire(grp, pinName, new THREE.Vector3(colX(firstCol + i), top, rowZ(0)), color, `${partId}:${fn}`, height + 6 + i * 1.6, i);
      addRole(apiId(pinName), role);
    });
  }

  function buildServo(grp: THREE.Group, p: Extract<PartSpec, { type: 'servo' }>) {
    // 舵机放在面包板外侧的桌面上：自带棕红橙三色排线 → 3P 母头立在桌上 → 三根杜邦线接到开发板
    const root = new THREE.Group();
    registerPart('servo', root);
    grp.add(root);
    const m = servoModel();
    // 摆在信号针和 5V 针中间的正前方：线短、不从开发板（BOOT 键）和 BME280 上方拱过去
    const sigX = pinCands('IO' + p.pin)[0].p.x;
    const v5X = pinCands('5V')[0].p.x;
    const sx = (sigX + v5X) / 2 + 8, sz = rowZ(9) + 44;
    m.grp.position.set(sx, 0, sz);
    m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    // 3P 母头：黑色塑料，开口朝上
    const plug = new THREE.Vector3(sx - 8, 0, rowZ(9) + 26);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(7.6, 12, 2.6), MAT.plug);
    housing.position.set(plug.x + PITCH, 6, plug.z);
    housing.castShadow = true;
    root.add(housing);
    // 舵机自带排线：三根并排，从壳体侧面出来，沿桌面到母头底部
    [0x6b4423, 0xd33a2c, 0xf28c28].forEach((c, i) => {
      const dz = (i - 1) * 1.0;
      const pts = [
        new THREE.Vector3(sx + 10, 4, sz + dz * 0.2),
        new THREE.Vector3(sx + 14, 1, sz - 4 + dz),
        new THREE.Vector3(plug.x + 14, 0.6, plug.z + 8 + dz),
        new THREE.Vector3(plug.x + PITCH * (2 - i) + 0.0, 0.6, plug.z + 4),
        new THREE.Vector3(plug.x + PITCH * (2 - i), 0.6, plug.z + 1.3),
      ];
      const t = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.5, 8), new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }));
      t.castShadow = true;
      root.add(t);
    });
    const pinLocal = [0, 1, 2].map((i) => new THREE.Vector3(plug.x + PITCH * (2 - i), 12, plug.z));
    // 母头三孔：GND（棕）、VCC（红）、PWM（橙）
    const labels = ['GND', 'VCC', 'PWM'];
    const recs = labels.map((l, i) => ({ id: `servo:${l}`, label: l, anchor: pinLocal[i].clone(), parent: root }));
    pinHits(root, recs, pinLocal.map((v) => v.clone().setY(9)), [2.4, 7, 3.2], modulePins);
    const cols: [string, number, string, string][] = [
      ['IO' + p.pin, WIRE.sig, 'PWM', 'SG90 信号'],
      ['5V', WIRE.vcc, 'VCC', 'SG90 供电'],
      ['GND', WIRE.gnd, 'GND', 'SG90 地'],
    ];
    cols.forEach(([pin, color, end, role], i) => {
      const b = pinLocal[labels.indexOf(end)].clone();
      const a = boardHole(pin, b);
      // 起点先升过相邻插头顶（面包板面 + 11 mm），再低低地往前拱向舵机：拱高了从默认机位看会挡住板上的 BOOT 键和 BME280
      addWire(grp, [a, lift(a, top + 13 + i), new THREE.Vector3((a.x + b.x) / 2, top + 15 + i * 2, (a.z + b.z) / 2 + 8), lift(b, 20), b], color, pin, `servo:${end}`);
      addRole(apiId(pin), role);
    });
    label(grp, p.label ?? `SG90 舵机 · 信号 IO${p.pin} · 50Hz`, new THREE.Vector3(sx, 38, sz + 12));
    servos.push({ pin: p.pin, horn: m.horn, freq: p.freq ?? 50, angle: 90, target: 90 });
  }

  function buildPot(grp: THREE.Group, p: Extract<PartSpec, { type: 'pot' }>) {
    const m = potModel();
    const col = 19;
    m.grp.position.set(colX(col), BB_TOP + 1, rowZ(8));
    registerPart('pot', m.grp);
    grp.add(m.grp);
    // 左端 → 3V3、滑片 → IO、右端 → GND（从面包板同列的 j 行引出）
    const ends: [number, string, number, string, string][] = [
      [col - 1, '3V3', WIRE.vcc, 'VCC', '电位器供电'],
      [col, 'IO' + p.pin, WIRE.sig, 'OUT', '电位器滑片（ADC）'],
      [col + 1, 'GND', WIRE.gnd, 'GND', '电位器地'],
    ];
    for (const [c, pin, color, end, role] of ends) {
      jumper(grp, pin, new THREE.Vector3(colX(c), top, rowZ(9)), color, `pot:${end}`, 20 + (c - col) * 2, 6);
      addRole(apiId(pin), role);
    }
    label(grp, p.label ?? `电位器 · 滑片 → IO${p.pin}（ADC）· 拖动旋钮`, new THREE.Vector3(colX(col), 36, rowZ(9) + 6));
    pots.push({ pin: p.pin, knob: m.knob, hit: m.hit, v: 0.36 });
    m.knob.rotation.y = -(0.36 - 0.5) * 1.5 * Math.PI;
  }

  function buildBuzzer(grp: THREE.Group, p: Extract<PartSpec, { type: 'buzzer' }>) {
    // 模块平放在面包板前面的桌上，靠近 I/O 针；三根杜邦线（母头插模块排针）接到开发板 3V3 / GPIO / GND
    const root = new THREE.Group();
    registerPart('buzzer', root);
    grp.add(root);
    const m = buzzerModule();
    const sig = pinCands('IO' + p.pin)[0].p;
    const bx = sig.x - 18, bz = Math.sign(sig.z || 1) * (BB.D / 2 + 15);
    m.grp.position.set(bx, 0, bz);
    // 排针朝开发板那一侧
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    // 接触阴影不挂在可选中的零件下面：选中描边会把阴影片的大方框也描出来
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    m.grp.updateMatrixWorld(true);
    const local = m.plugAt.map((v) => v.clone());
    // 针脚拾取盒套在杜邦母头上（模块平放，排针比竖插模组的高）
    const recs = m.labels.map((l, i) => ({ id: `buzzer:${l}`, label: l, anchor: local[i].clone(), parent: m.grp }));
    pinHits(m.grp, recs, local.map((v) => v.clone().setY(v.y + 4)), [2.4, 9, 2.8], modulePins);
    const ends: [string, number, string, string][] = [
      ['3V3', WIRE.vcc, 'VCC', '蜂鸣器模块供电'],
      ['IO' + p.pin, WIRE.sig, 'I/O', '蜂鸣器（LEDC 方波）'],
      ['GND', WIRE.gnd, 'GND', '蜂鸣器模块地'],
    ];
    ends.forEach(([pin, color, end, role], i) => {
      const b = local[m.labels.indexOf(end)].clone().applyMatrix4(m.grp.matrixWorld);
      const a = boardHole(pin, b);
      const h = top + 12 + i * 1.5;
      addWire(grp, [a, lift(a, h), new THREE.Vector3((a.x + b.x) / 2, h + 2, (a.z + b.z) / 2 + Math.sign(bz) * 4), lift(b, h - 2), b], color, pin, `buzzer:${end}`);
      addRole(apiId(pin), role);
    });
    label(grp, p.label ?? `无源蜂鸣器 · I/O → IO${p.pin}`, new THREE.Vector3(bx, 6, bz + Math.sign(bz) * 20));
    buzzers.push({ pin: p.pin, membrane: m.membrane, waves: m.waves, waveMat: m.waveMat, on: false });
  }

  let lastScene: SceneSpec = { parts: [] };

  /** 换开发板（C3 / S3）：开发板重建，外接元件按新板子的引脚重新接线 */
  function setBoard(chip: ChipId) {
    if (board.spec.chip === chip) return;
    scene.remove(board.grp);
    disposeTree(board.grp);
    board = devboard(BOARDS[chip]);
    placeBoard();
    setScene(lastScene);
  }

  // 没指定机位时按开发板 + 元件的包围盒取景：真实尺寸下 S3 板加舵机比 C3 宽一倍，固定机位会裁掉两头。
  // 导线拱起很高，只取到 40 mm 高度，免得为了线头把器件缩得太小
  function fitView(v: Required<SceneSpec>['view']) {
    const box = new THREE.Box3().setFromObject(board.grp);
    for (const c of parts.children) if (!wires.some((w) => w.grp === c)) box.expandByObject(c);
    box.max.y = Math.min(box.max.y, 40);
    const center = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(camera.aspect, 0.5));
    const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 0.82;
    const dir = new THREE.Vector3(...v.position).sub(new THREE.Vector3(...v.target)).normalize();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
  }

  function setScene(spec: SceneSpec) {
    lastScene = spec;
    scene.remove(parts);
    disposeTree(parts);
    parts = new THREE.Group();
    scene.add(parts);
    leds = [];
    servos = [];
    pots = [];
    buzzers = [];
    oledTex = null;
    lcdTex = null;
    holeUse = new Map();
    partsById.clear();
    partsById.set('board', board.grp);
    modulePins = [];
    wires = [];
    roles = new Map();
    addRole(apiId('IO' + board.spec.rgbPin), 'WS2812 板载灯');
    addRole(apiId('IO' + board.spec.bootPin), 'BOOT 键');
    // 多个同类元件依次往左排，避免叠在同一列
    let ledN = 0;
    let i2cCol = 21;
    for (const p of spec.parts) {
      if (p.type === 'led') buildLed(parts, { ...p, col: p.col ?? 24 - 4 * ledN++ });
      if (p.type === 'servo') buildServo(parts, p);
      if (p.type === 'pot') buildPot(parts, p);
      if (p.type === 'buzzer') buildBuzzer(parts, p);
      if (p.type === 'oled') {
        oledData.fill(0);
        for (let i = 3; i < oledData.length; i += 4) oledData[i] = 255;
        oledTex = new THREE.DataTexture(oledData, 128, 64, THREE.RGBAFormat);
        oledTex.magFilter = THREE.NearestFilter;
        oledTex.minFilter = THREE.LinearFilter;
        oledTex.colorSpace = THREE.SRGBColorSpace;
        oledTex.needsUpdate = true;
        buildI2c(parts, 'oled', 'OLED', oledModule(oledTex), i2cCol, p.sda, p.scl, 40);
        label(parts, p.label ?? `SSD1306 · I2C 0x${p.addr.toString(16).toUpperCase()} · SDA IO${p.sda} SCL IO${p.scl}`, new THREE.Vector3(colX(i2cCol + 1.5), 46, rowZ(0) - 10));
        i2cCol -= 9;
      }
      if (p.type === 'gc9a01') {
        lcdData.fill(0);
        for (let i = 3; i < lcdData.length; i += 4) lcdData[i] = 255;
        lcdTex = new THREE.DataTexture(lcdData, 240, 240, THREE.RGBAFormat);
        lcdTex.flipY = true;
        lcdTex.colorSpace = THREE.SRGBColorSpace;
        lcdTex.needsUpdate = true;
        buildSpiLcd(parts, roundLcdModule(lcdTex), 16);
        const w = LCD_WIRING[board.spec.chip];
        label(parts, p.label ?? `GC9A01 圆屏 · SPI2 · SCLK IO${w.sclk} MOSI IO${w.mosi} CS IO${w.cs} DC IO${w.dc}`, new THREE.Vector3(colX(19.5), 52, rowZ(0) - 10));
      }
      if (p.type === 'bme280') {
        buildI2c(parts, 'bme280', 'BME280', bmeModule(), i2cCol, p.sda, p.scl, 22);
        label(parts, p.label ?? `BME280 · I2C 0x${p.addr.toString(16)} · SDA IO${p.sda} SCL IO${p.scl}`, new THREE.Vector3(colX(i2cCol + 1.5), 34, rowZ(0) - 8));
        i2cCol -= 9;
      }
    }
    parts.updateMatrixWorld(true);
    // 示例可以指定机位（比如凑近看屏幕）；没有就回到默认机位
    // 机位按 C3 板子写的；换成更长的板子时随元件一起平移
    const v = spec.view ?? DEFAULT_VIEW;
    if (spec.view) {
      const dx = colX(0) + ((BOARD_C3.cols - 1) / 2) * PITCH;
      camera.position.set(v.position[0] + dx, v.position[1], v.position[2]);
      controls.target.set(v.target[0] + dx, v.target[1], v.target[2]);
    } else {
      fitView(v);
    }
    controls.update();
    // 重建后恢复外壳设下的标注（目标还在就保留）
    for (const [id, msg] of faults) if (wires.some((w) => w.id === id)) applyFault(id, msg);
    else setTag('fault:' + id, null, '', () => null);
    highlight(hl);
    setHeat(heatId);
    if (measured) measure(measured[0], measured[1]);
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // bloom 靠亮度阈值只挑出发光体，不另渲染一遍发光层。没有色调映射，白底和受光的白色器件
  // 线性亮度会到 1.0–1.4，阈值必须高于它；RGB（×7）、LED 透镜（×6）的 HDR 亮度远超 1.8
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.35, 1.8);
  composer.addPass(bloom);
  const outline = new OutlinePass(new THREE.Vector2(256, 256), scene, camera);
  outline.visibleEdgeColor.set(ACCENT);
  outline.hiddenEdgeColor.set(0x0a5fa8);
  outline.edgeStrength = 5;
  outline.edgeThickness = 1.2;
  outline.edgeGlow = 0;
  outline.enabled = false;
  composer.addPass(outline);
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

  // ---------------------------------------------------------------- 拾取

  const ray = new THREE.Raycaster();
  const toNdc = (ev: { clientX: number; clientY: number }) => {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  };
  const resolveHit = (h: THREE.Intersection): PickTarget | null => {
    const ids = h.object.userData.pinIds as string[] | undefined;
    if (ids && h.instanceId !== undefined) return { kind: 'pin', id: ids[h.instanceId] };
    for (let o: THREE.Object3D | null = h.object; o; o = o.parent) if (o.userData.pick) return o.userData.pick as PickTarget;
    return null;
  };
  const pickAt = (ev: { clientX: number; clientY: number }): PickTarget | null => {
    ray.setFromCamera(toNdc(ev), camera);
    // 杜邦插头正好立在所接针脚旁边，大多数角度下会挡住针脚：先打到导线、紧后面（15 mm 内）
    // 又有针脚或按键时，按用户想点的针脚算
    let first: { t: PickTarget; d: number } | null = null;
    for (const h of ray.intersectObjects([board.grp, parts], true)) {
      const t = resolveHit(h);
      if (!t) continue;
      if (!first) {
        if (t.kind !== 'wire') return t;
        first = { t, d: h.distance };
        continue;
      }
      if (h.distance - first.d > 15) break;
      if (t.kind === 'pin' || t.kind === 'button') return t;
    }
    return first?.t ?? null;
  };

  // 按键交互：按下 / 松开
  let buttonCb: ((n: 'BOOT' | 'RST', d: boolean) => void) | null = null;
  let pickCb: ((t: PickTarget | null, s: ScreenPoint) => void) | null = null;
  let pressed: THREE.Mesh | null = null;
  const pick = (ev: PointerEvent) => {
    ray.setFromCamera(toNdc(ev), camera);
    const hit = ray.intersectObject(board.grp, true)[0];
    const t = hit && resolveHit(hit);
    return t && t.kind === 'button' ? board.buttons.find((b) => b.name === t.id) : undefined;
  };
  // 电位器：按住旋钮左右拖动转动（270° 行程）
  let dragging: { pot: (typeof pots)[number]; x0: number; v0: number } | null = null;
  const pickPot = (ev: PointerEvent) => {
    ray.setFromCamera(toNdc(ev), camera);
    const hit = ray.intersectObjects(pots.map((p) => p.hit))[0];
    return hit ? pots.find((p) => p.hit === hit.object) : undefined;
  };
  const turnPot = (pot: (typeof pots)[number], v: number) => {
    pot.v = Math.min(1, Math.max(0, v));
    pot.knob.rotation.y = -(pot.v - 0.5) * 1.5 * Math.PI;
  };
  let downAt: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    downAt = { x: ev.clientX, y: ev.clientY };
    const pot = pickPot(ev);
    if (pot) {
      controls.enabled = false;
      dragging = { pot, x0: ev.clientX, v0: pot.v };
      return;
    }
  });
  window.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    turnPot(dragging.pot, dragging.v0 + (ev.clientX - dragging.x0) / 240);
    potCb?.(dragging.pot.pin, dragging.pot.v);
  });
  window.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = null;
      controls.enabled = true;
    }
  });
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
  // 点击（按下到松开移动不到 5px，不是拖动转视角）→ onPick
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!pickCb || !downAt || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pickCb(pickAt(ev), { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
  });
  let hoverT = 0;
  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (ev.buttons) return;
    // 悬停检测节流：每 50ms 最多一次射线
    const now = performance.now();
    if (now - hoverT < 50) return;
    hoverT = now;
    const c = pick(ev) ? 'pointer' : pickPot(ev) || dragging ? 'ew-resize' : pickCb && pickAt(ev) ? 'pointer' : '';
    renderer.domElement.style.cursor = c;
  });

  // ---------------------------------------------------------------- 高亮 / 故障 / 热晕 / 尺子

  const allPins = () => [...board.pinRecs, ...modulePins];
  const pinsById = (id: string) => allPins().filter((p) => p.id === id);
  const pinWorldPos = (p: PinRec) => p.anchor.clone().applyMatrix4(p.parent.matrixWorld);

  const targetPos = (t: PickTarget): THREE.Vector3 | null => {
    if (t.kind === 'pin') {
      const p = pinsById(t.id)[0];
      return p ? pinWorldPos(p) : null;
    }
    if (t.kind === 'wire') {
      const w = wires.find((w) => w.id === t.id);
      return w ? w.curve.getPoint(0.5) : null;
    }
    if (t.kind === 'button') {
      const b = board.buttons.find((b) => b.name === t.id);
      return b ? b.getWorldPosition(new THREE.Vector3()) : null;
    }
    const o = partsById.get(t.id);
    if (!o) return null;
    // 开发板量到芯片（屏蔽罩中心），其它零件取包围盒中心
    if (t.id === 'board') return new THREE.Vector3(0, board.T / 2 + 3, board.L / 2 - board.spec.module.L / 2).applyMatrix4(board.grp.matrixWorld);
    // 其它零件取看得见的本体的包围盒中心：不算拾取盒、金针和接触阴影，免得"中心"落到插进面包板的排针上（点中心选中的是针脚而不是模块）
    const box = new THREE.Box3();
    o.updateMatrixWorld(true);
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh || m.material === MAT.hit || m.material === MAT.gold || m.renderOrder < 0) return;
      box.union(new THREE.Box3().setFromObject(m));
    });
    return (box.isEmpty() ? new THREE.Box3().setFromObject(o) : box).getCenter(new THREE.Vector3());
  };

  const project = (t: PickTarget): ScreenPoint | null => {
    const p = targetPos(t);
    if (!p) return null;
    const v = p.project(camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    return { x: ((v.x + 1) / 2) * container.clientWidth, y: ((1 - v.y) / 2) * container.clientHeight };
  };

  const hlGroup = new THREE.Group();
  scene.add(hlGroup);
  const ringGeo = new THREE.TorusGeometry(1.7, 0.22, 8, 40).rotateX(Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, transparent: true });
  let hl: PickTarget | null = null;
  const thicken = (w: WireRec, on: boolean) => {
    if (on) w.thick ??= new THREE.TubeGeometry(w.curve, 96, WIRE_R * 1.7, 10);
    w.tube.geometry = on ? w.thick! : w.thin;
  };
  function highlight(t: PickTarget | null) {
    for (const w of wires) thicken(w, false);
    hlGroup.clear();
    outline.selectedObjects = [];
    outline.enabled = false;
    setTag('hl', null, '', () => null);
    hl = t;
    if (!t) return;
    if (t.kind === 'part' || t.kind === 'button') {
      const o = t.kind === 'part' ? partsById.get(t.id) : board.buttons.find((b) => b.name === t.id);
      if (!o) return;
      outline.selectedObjects = [o];
      outline.enabled = true;
      return;
    }
    if (t.kind === 'pin') {
      const recs = pinsById(t.id);
      for (const r of recs) {
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pinWorldPos(r));
        ring.renderOrder = 20;
        hlGroup.add(ring);
      }
      for (const w of wires) if (w.ends.includes(t.id)) thicken(w, true);
      if (recs.length) {
        const role = roles.get(t.id)?.join(' · ');
        setTag('hl', `${t.id}${recs[0].label !== t.id ? `（丝印 ${recs[0].label}）` : ''}${role ? ' · ' + role : ''}`, 'pin', () => pinWorldPos(recs[0]), -18);
      }
      return;
    }
    const w = wires.find((w) => w.id === t.id);
    if (!w) return;
    thicken(w, true);
    setTag('hl', `${w.ends[0]} → ${w.ends[1]}`, 'pin', () => w.curve.getPoint(0.5), -16);
  }

  const faults = new Map<string, string>();
  const applyFault = (id: string, msg: string) => {
    const w = wires.find((w) => w.id === id);
    if (!w) return;
    w.mat.color.set(BAD);
    w.mat.emissive.set(BAD);
    w.mat.emissiveIntensity = 0.25;
    setTag('fault:' + id, '✗ ' + msg, 'bad', () => w.curve.getPoint(0.5), -20);
  };
  function setWireFault(id: string, msg: string | null) {
    if (msg) {
      faults.set(id, msg);
      applyFault(id, msg);
      return;
    }
    faults.delete(id);
    const w = wires.find((w) => w.id === id);
    if (w) {
      w.mat.color.set(w.color);
      w.mat.emissive.set(0);
      w.mat.emissiveIntensity = 0;
    }
    setTag('fault:' + id, null, '', () => null);
  }

  const heatTex = canvasTexture(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(242,72,34,0.7)');
    r.addColorStop(0.45, 'rgba(242,72,34,0.38)');
    r.addColorStop(1, 'rgba(242,72,34,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
  });
  // 热晕中心在零件包围盒中心，一半埋在面包板里；不做深度测试，让它像一层热成像叠在零件上
  const heat = new THREE.Sprite(new THREE.SpriteMaterial({ map: heatTex, depthWrite: false, depthTest: false, transparent: true }));
  heat.raycast = () => {};
  heat.visible = false;
  heat.renderOrder = 5;
  scene.add(heat);
  let heatId: string | null = null;
  let heatBase = 1;
  function setHeat(partId: string | null) {
    heatId = partId;
    const o = partId ? partsById.get(partId) : undefined;
    heat.visible = !!o;
    if (!o) return;
    const box = new THREE.Box3().setFromObject(o);
    const size = box.getSize(new THREE.Vector3());
    heatBase = Math.max(size.x, size.y, size.z) * 2.2 + 10;
    heat.position.copy(box.getCenter(new THREE.Vector3()));
  }

  const rulerGroup = new THREE.Group();
  scene.add(rulerGroup);
  const rulerMat = new THREE.LineBasicMaterial({ color: BAD, depthTest: false, transparent: true });
  const dotMat = new THREE.MeshBasicMaterial({ color: BAD, depthTest: false, transparent: true });
  const dotGeo = new THREE.SphereGeometry(0.8, 16, 8);
  let measured: [PickTarget, PickTarget] | null = null;
  function measure(a: PickTarget | null, b?: PickTarget): number | null {
    rulerGroup.children.forEach((c) => (c as THREE.Line).geometry !== dotGeo && (c as THREE.Line).geometry.dispose());
    rulerGroup.clear();
    setTag('ruler', null, '', () => null);
    measured = null;
    if (!a || !b) return null;
    const pa = targetPos(a), pb = targetPos(b);
    if (!pa || !pb) return null;
    measured = [a, b];
    const d = pa.distanceTo(pb);
    // 尺子：主线 + 每 10mm 一个刻度
    const pts: THREE.Vector3[] = [pa, pb];
    const dir = pb.clone().sub(pa).normalize();
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize().multiplyScalar(1.2);
    for (let s = 0; s <= d; s += 10) {
      const p = pa.clone().addScaledVector(dir, s);
      pts.push(p.clone().sub(side), p.clone().add(side));
    }
    const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), rulerMat);
    line.renderOrder = 21;
    rulerGroup.add(line);
    // WebGL 线宽恒为 1px，远看几乎看不见；主线另用细圆柱画
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, d, 8), dotMat);
    bar.position.copy(pa).lerp(pb, 0.5);
    bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    bar.renderOrder = 21;
    rulerGroup.add(bar);
    for (const p of [pa, pb]) {
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.copy(p);
      dot.renderOrder = 21;
      rulerGroup.add(dot);
    }
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    const mm = Math.round(d * 10) / 10;
    setTag('ruler', `${mm.toFixed(1)} mm`, 'ruler', () => mid, -12);
    return mm;
  }

  applyTheme('light');
  partsById.set('board', board.grp);
  addRole(apiId('IO' + board.spec.rgbPin), 'WS2812 板载灯');
  addRole(apiId('IO' + board.spec.bootPin), 'BOOT 键');

  // ---------------------------------------------------------------- 渲染循环

  let usbHost: ReturnType<typeof createUsbHost> | null = null;
  let raf = 0;
  let rgbPeak = 0;
  let frameMs = 16.7, cpuMs = 0, lastT = performance.now();
  const lastInfo = { calls: 0, triangles: 0 };
  const tmp = new THREE.Vector3();
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const t0 = performance.now();
    frameMs = frameMs * 0.9 + (t0 - lastT) * 0.1;
    lastT = t0;
    // LED 亮灭有很短的过渡，像真实 LED 被眼睛看到的样子
    let glow = rgbPeak > 0;
    for (const l of leds) {
      l.now += (l.target - l.now) * 0.55;
      l.lens.emissiveIntensity = l.now * 6;
      l.light.intensity = l.now * 60;
      if (l.now > 0.02) glow = true;
    }
    // 舵机有转速上限（SG90 约 0.1s / 60°），舵盘追目标角度
    for (const sv of servos) {
      const step = 600 / 60;
      sv.angle += Math.max(-step, Math.min(step, sv.target - sv.angle));
      sv.horn.rotation.y = ((sv.angle - 90) * Math.PI) / 180;
    }
    // 蜂鸣器响：振膜轻微起伏 + 声波弧向外扩（示意，真实振动是 kHz 级，看不见）
    for (const bz of buzzers) {
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
    if (heat.visible) {
      const k = 1 + 0.06 * Math.sin(t0 / 260);
      heat.scale.set(heatBase * k, heatBase * k, 1);
    }
    controls.update();
    // 没有发光体时跳过 bloom（省掉 5 级模糊）
    bloom.enabled = glow;
    renderer.info.reset();
    composer.render();
    lastInfo.calls = renderer.info.render.calls;
    lastInfo.triangles = renderer.info.render.triangles;
    // DOM 标签跟着 3D 位置走
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
    cpuMs = cpuMs * 0.9 + (performance.now() - t0) * 0.1;
  };
  tick();

  const bench: Bench & { _debug: unknown } = {
    setScene,
    setBoard,
    setGpio(level, enable, pwm, levelHi = 0, enableHi = 0) {
      const bit = (lo: number, hi: number, pin: number) => (pin < 32 ? (lo >>> pin) & 1 : (hi >>> (pin - 32)) & 1);
      // PWM 驱动时 LED 亮度 ≈ 占空比（人眼对 5kHz 闪烁无感，看到的是平均亮度）
      for (const l of leds) {
        const d = pwm?.[l.pin] ?? -1;
        l.target = d >= 0 ? d : bit(enable, enableHi, l.pin) && bit(level, levelHi, l.pin) ? 1 : 0;
      }
      // 无源蜂鸣器只在有方波时响（占空比在 0..1 之间；常高 / 常低都不响）
      for (const bz of buzzers) {
        const d = pwm?.[bz.pin] ?? -1;
        bz.on = d > 0 && d < 1;
      }
      for (const sv of servos) {
        const d = pwm?.[sv.pin] ?? -1;
        if (d <= 0) continue;
        const us = (d * 1e6) / sv.freq;
        sv.target = Math.max(0, Math.min(180, ((us - 500) / 2000) * 180));
      }
    },
    setPot(pin, v) {
      const pot = pots.find((p) => p.pin === pin);
      if (pot) turnPot(pot, v);
    },
    onPot(cb) {
      potCb = cb;
    },
    setRgb(rgb) {
      const [r, g, b] = rgb.map((v) => v / 255);
      const peak = Math.max(r, g, b);
      rgbPeak = peak;
      // 发光强度跟亮度走；颜色用归一化后的色相，避免暗色时泛光发灰
      // 真 LED 的蓝光在眼里也很亮，但按亮度公式只有绿的 1/10：按色相补偿，蓝灯才不至于发不出光
      const lum = peak ? (0.2126 * r + 0.7152 * g + 0.0722 * b) / peak : 1;
      const k = Math.min(4, Math.max(1, 0.25 / lum));
      board.rgbMat.emissive.setRGB(r, g, b);
      board.rgbMat.emissiveIntensity = 7 * k;
      board.rgbMat.color.setRGB(0.87 + r * 0.13, 0.86 + g * 0.14, 0.82 + b * 0.18);
      board.rgbLight.color.setRGB(peak ? r / peak : 0, peak ? g / peak : 0, peak ? b / peak : 0);
      board.rgbLight.intensity = peak * 80 * k;
    },
    setLcd(px) {
      if (!lcdTex) return;
      lcdData.set(px.subarray(0, lcdData.length));
      lcdTex.needsUpdate = true;
    },
    setOled(px) {
      if (!oledTex) return;
      // 显示第 0 行在上：纹理 v=1 在上，所以倒着写；亮像素是 OLED 常见的冷白偏蓝
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 128; x++) {
          const v = px[y * 128 + x] / 255;
          const o = ((63 - y) * 128 + x) * 4;
          oledData[o] = 10 + v * 150;
          oledData[o + 1] = 12 + v * 215;
          oledData[o + 2] = 16 + v * 239;
        }
      }
      oledTex.needsUpdate = true;
    },
    setPowered(on) {
      board.pwrMat.emissiveIntensity = on ? 3 : 0;
    },
    onButton(cb) {
      buttonCb = cb;
    },
    buttonScreenPos(name) {
      const b = board.buttons.find((m) => m.name === name);
      if (!b) return null;
      const v = b.getWorldPosition(new THREE.Vector3()).project(camera);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
      const r = renderer.domElement.getBoundingClientRect();
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    },
    setUsb(v) {
      if (!v) {
        usbHost?.dispose();
        usbHost = null;
        return;
      }
      if (!usbHost) {
        board.grp.updateMatrixWorld();
        // 开发板原生 USB 口口沿（板子局部坐标）→ 世界坐标
        usbHost = createUsbHost(scene, board.grp.localToWorld(board.usbPort.clone()));
      }
      usbHost.update(v);
    },
    // ---- ScenePickApi
    onPick(cb) {
      pickCb = cb;
    },
    highlight,
    project,
    listPins(): PinInfo[] {
      // 同名针（GND、3V3、5V）是同一个网络，按 id 去重；顺序：J1 自 1 号针、再 J3
      const out: PinInfo[] = [];
      const seen = new Set<string>();
      const n = board.spec.j1.length;
      const recs = [...board.pinRecs.slice(0, n).reverse(), ...board.pinRecs.slice(n).reverse()];
      for (const r of recs) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const role = roles.get(r.id)?.join(' · ');
        out.push(role ? { id: r.id, label: r.label, role } : { id: r.id, label: r.label });
      }
      return out;
    },
    setWireFault,
    setHeat,
    measure,
    setTheme: applyTheme,
    stats() {
      return { ...lastInfo, frameMs: Math.round(frameMs * 10) / 10, cpuMs: Math.round(cpuMs * 100) / 100, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      overlay.remove();
      renderer.dispose();
    },
    // 调试用（截图时调机位）：不属于接口
    _debug: { camera, controls, renderer, scene, pos: targetPos, wires: () => wires.map((w) => w.id) },
  };
  return bench;
}
