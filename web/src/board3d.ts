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

export type ChipId = 'esp32c3' | 'esp32s3';

/** 开发板定义（程序建模，参考常见开发板的引脚排布，非任何厂商的设计文件）。排针自 USB 端起编号。 */
export interface BoardSpec {
  chip: ChipId;
  title: string;
  /** 板宽 / 板长（mm） */
  W: number;
  L: number;
  left: string[];
  right: string[];
  module: { title: string; sub: string; flash: string };
  /** 两个 USB-C（UART 桥 + 芯片原生 USB）还是一个 */
  dualUsb: boolean;
  rgbPin: number;
  /** 放在面包板哪一列（中心）、面包板多少列、外接元件整体右移几列 */
  boardCol: number;
  cols: number;
  partOffset: number;
}

export const BOARD_C3: BoardSpec = {
  chip: 'esp32c3',
  title: 'ESP32-C3 DEV',
  W: 25.4,
  L: 50.8,
  left: ['GND', '3V3', '3V3', 'IO2', 'IO3', 'GND', 'RST', 'GND', 'IO0', 'IO1', 'IO10', 'GND', '5V', '5V', 'GND'],
  right: ['GND', 'TX', 'RX', 'GND', 'IO9', 'IO8', 'GND', 'IO7', 'IO6', 'IO5', 'IO4', 'GND', 'IO18', 'IO19', 'GND'],
  module: { title: 'ESP32-C3', sub: 'RISC-V · Wi-Fi · BLE 5', flash: '4MB FLASH' },
  dualUsb: false,
  rgbPin: 8,
  boardCol: 7,
  cols: 30,
  partOffset: 0,
};

/** S3 开发板：2×22 针，两个 USB-C（UART / USB），RGB 灯在 GPIO48，N16R8（16MB flash + 8MB PSRAM） */
export const BOARD_S3: BoardSpec = {
  chip: 'esp32s3',
  title: 'ESP32-S3 DEV',
  W: 25.4,
  L: 63,
  left: ['GND', '5V', 'IO14', 'IO13', 'IO12', 'IO11', 'IO10', 'IO9', 'IO46', 'IO3', 'IO8', 'IO18', 'IO17', 'IO16', 'IO15', 'IO7', 'IO6', 'IO5', 'IO4', 'RST', '3V3', '3V3'],
  right: ['GND', 'GND', 'IO19', 'IO20', 'IO21', 'IO47', 'IO48', 'IO45', 'IO0', 'IO35', 'IO36', 'IO37', 'IO38', 'IO39', 'IO40', 'IO41', 'IO42', 'IO2', 'IO1', 'RX', 'TX', 'GND'],
  module: { title: 'ESP32-S3', sub: 'Xtensa LX7 ×2 · Wi-Fi · BLE 5', flash: 'N16R8' },
  dualUsb: true,
  rgbPin: 48,
  boardCol: 11,
  cols: 40,
  partOffset: 8,
};

export const BOARDS: Record<ChipId, BoardSpec> = { esp32c3: BOARD_C3, esp32s3: BOARD_S3 };

/** 示例里声明的外接元件（examples.json 的 scene.parts）。 */
export type PartSpec =
  | { type: 'led'; pin: number; color?: number; col?: number; label?: string }
  | { type: 'oled'; addr: number; sda: number; scl: number; label?: string }
  | { type: 'bme280'; addr: number; sda: number; scl: number; label?: string }
  /** SG90 舵机：信号接 pin，舵盘角度按 PWM 脉宽（0.5–2.5ms → 0–180°） */
  | { type: 'servo'; pin: number; freq?: number; label?: string }
  /** 10kΩ 电位器：两端接 3V3 / GND，滑片接 pin（ADC），旋钮可拖动 */
  | { type: 'pot'; pin: number; label?: string };

export interface SceneSpec {
  parts: PartSpec[];
  /** 初始机位（毫米，世界坐标） */
  view?: { position: [number, number, number]; target: [number, number, number] };
}

const DEFAULT_VIEW: Required<SceneSpec>['view'] = { position: [-40, 95, 105], target: [0, 6, 4] };

export interface Bench {
  /** 按示例声明重建外接元件和接线（开发板、面包板不动） */
  setScene(spec: SceneSpec): void;
  /** 引脚电平 / 输出使能：低 32 位与高位分开传（JS 位运算只有 32 位，S3 有 49 个引脚） */
  setGpio(level: number, enable: number, pwm?: number[], levelHi?: number, enableHi?: number): void;
  /** 换开发板（按固件的芯片），外接元件随之重新接线 */
  setBoard(chip: ChipId): void;
  /** OLED 画面：128×64 字节亮度 */
  setOled(pixels: Uint8Array): void;
  /** 电位器位置 0..1（面板滑块改了以后同步 3D 旋钮） */
  setPot(pin: number, v: number): void;
  /** 用户在 3D 里拖动电位器旋钮 */
  onPot(cb: (pin: number, v: number) => void): void;
  setPowered(on: boolean): void;
  /** 板载 WS2812（C3 GPIO8 / S3 GPIO48）颜色，0–255 */
  setRgb(rgb: number[]): void;
  onButton(cb: (name: 'BOOT' | 'RST', down: boolean) => void): void;
  dispose(): void;
}

const WIRE = { sda: 0x2f7fd6, scl: 0xf2c53a, vcc: 0xd33a2c, gnd: 0x2b2f36, sig: 0xf2a33a };

/** 0.96" SSD1306 模组：竖插在面包板上，屏幕朝观察者。原点在排针根部。 */
function oledModule(tex: THREE.Texture) {
  const grp = new THREE.Group();
  const W = 27, H = 27.5, T = 1.2;
  const pcbTex = canvasTexture(512, 512, (g) => {
    g.fillStyle = '#1d4c9c';
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = '#e8eef8';
    g.font = 'bold 30px Menlo, monospace';
    g.textAlign = 'center';
    ['GND', 'VCC', 'SCL', 'SDA'].forEach((t, i) => g.fillText(t, 256 + (i - 1.5) * 48 * 512 / W / 9.5, 488));
    g.strokeStyle = '#e8eef8';
    g.lineWidth = 4;
    for (const [x, y] of [[30, 30], [482, 30], [30, 482], [482, 482]]) {
      g.beginPath();
      g.arc(x, y, 16, 0, Math.PI * 2);
      g.stroke();
    }
  });
  const side = new THREE.MeshStandardMaterial({ color: 0x173d80, roughness: 0.6 });
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(W, H, T), [side, side, side, side, new THREE.MeshStandardMaterial({ map: pcbTex, roughness: 0.55 }), side]);
  pcb.position.y = 2.5 + H / 2;
  pcb.castShadow = true;
  grp.add(pcb);
  // 玻璃面板（黑）+ 发光的有效显示区
  const glass = new THREE.Mesh(new THREE.BoxGeometry(26, 19.5, 1.4), new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 0.08, metalness: 0.3 }));
  glass.position.set(0, pcb.position.y + 1.5, T / 2 + 0.7);
  grp.add(glass);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(21.74, 10.86), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, glass.position.y + 1.2, glass.position.z + 0.71);
  grp.add(screen);
  // 排针：塑料座 + 4 根针插进面包板
  const header = new THREE.Mesh(new THREE.BoxGeometry(4 * PITCH, 2.5, 2.5), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
  header.position.set(0, 1.25, 0);
  grp.add(header);
  const gold = new THREE.MeshStandardMaterial({ color: 0xe8c66a, metalness: 1, roughness: 0.25 });
  for (let i = 0; i < 4; i++) {
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.64, 8, 0.64), gold);
    pin.position.set((i - 1.5) * PITCH, 0, 0);
    grp.add(pin);
  }
  return grp;
}

/** BME280 小板：紫色 PCB、金属壳传感器，竖插。原点在排针根部。 */
function bmeModule() {
  const grp = new THREE.Group();
  const W = 13, H = 10.5, T = 1.2;
  const tex = canvasTexture(256, 256, (g) => {
    g.fillStyle = '#5b2a86';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#f1e9f7';
    g.font = 'bold 26px Menlo, monospace';
    g.textAlign = 'center';
    g.fillText('BME280', 128, 40);
    g.font = 'bold 19px Menlo, monospace';
    ['VIN', 'GND', 'SCL', 'SDA'].forEach((t, i) => g.fillText(t, 128 + (i - 1.5) * 50, 238));
  });
  const side = new THREE.MeshStandardMaterial({ color: 0x48206b, roughness: 0.6 });
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(W, H, T), [side, side, side, side, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }), side]);
  pcb.position.y = 2.5 + H / 2;
  pcb.castShadow = true;
  grp.add(pcb);
  const can = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 0.95), new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.9, roughness: 0.3 }));
  can.position.set(0, pcb.position.y + 0.2, T / 2 + 0.47);
  grp.add(can);
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12), new THREE.MeshStandardMaterial({ color: 0x111111 }));
  hole.rotation.x = Math.PI / 2;
  hole.position.set(0.6, can.position.y + 0.6, can.position.z + 0.48);
  grp.add(hole);
  const header = new THREE.Mesh(new THREE.BoxGeometry(4 * PITCH, 2.5, 2.5), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
  header.position.set(0, 1.25, 0);
  grp.add(header);
  const gold = new THREE.MeshStandardMaterial({ color: 0xe8c66a, metalness: 1, roughness: 0.25 });
  for (let i = 0; i < 4; i++) {
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.64, 8, 0.64), gold);
    pin.position.set((i - 1.5) * PITCH, 0, 0);
    grp.add(pin);
  }
  return grp;
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mt of mats) {
      (mt as THREE.MeshStandardMaterial).map?.dispose();
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
    new THREE.MeshStandardMaterial({ color: 0xd8d3c8, roughness: 0.8 }),
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

function silkTexture(spec: BoardSpec) {
  // PCB 顶面丝印：引脚名、板名。画布按板子长宽比取
  const W = 1024, H = Math.round((1024 * spec.L) / spec.W);
  return canvasTexture(W, H, (g) => {
    g.fillStyle = '#16171c';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#e8e8e8';
    g.font = 'bold 30px "JetBrains Mono", Menlo, monospace';
    g.textBaseline = 'middle';
    const sy = H / spec.L;
    for (let i = 0; i < spec.left.length; i++) {
      const y = (6.6 + i * PITCH) * sy;
      g.textAlign = 'left';
      g.fillText(spec.left[i], 120, y);
      g.textAlign = 'right';
      g.fillText(spec.right[i], W - 120, y);
    }
    g.textAlign = 'center';
    g.font = 'bold 44px "Inter", Helvetica, sans-serif';
    g.fillText(spec.title, W / 2, (spec.L - 4.6) * sy);
    g.font = '28px "Inter", Helvetica, sans-serif';
    g.fillText('TryBoard · simulated', W / 2, (spec.L - 2.4) * sy);
    if (spec.dualUsb) {
      g.font = 'bold 26px Menlo, monospace';
      g.fillText('UART', W * 0.29, 1.6 * sy);
      g.fillText('USB', W * 0.71, 1.6 * sy);
    }
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

function devboard(spec: BoardSpec) {
  const grp = new THREE.Group();
  const { W, L } = spec;
  const T = 1.6;
  const pcbTop = new THREE.MeshStandardMaterial({ map: silkTexture(spec), roughness: 0.55, metalness: 0.05 });
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
    g.fillText(spec.module.title, 256, 210);
    g.font = '30px Menlo, monospace';
    g.fillText(spec.module.sub, 256, 280);
    g.fillText(spec.module.flash, 256, 330);
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

  // USB-C 口：一个（C3），或 UART 桥 + 原生 USB 两个（S3）
  for (const x of spec.dualUsb ? [-W * 0.21, W * 0.21] : [0]) {
    const usb = new THREE.Mesh(
      new THREE.BoxGeometry(8.9, 3.2, 7.4),
      new THREE.MeshStandardMaterial({ color: 0xd8dade, metalness: 1, roughness: 0.25 }),
    );
    usb.position.set(x, T / 2 + 1.6, -L / 2 + 3.2);
    usb.castShadow = true;
    grp.add(usb);
    const usbHole = new THREE.Mesh(new THREE.BoxGeometry(7.6, 2.2, 0.2), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    usbHole.position.set(x, T / 2 + 1.6, -L / 2 - 0.45);
    grp.add(usbHole);
  }

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

  // 板载 WS2812（5050 封装，C3 GPIO8 / S3 GPIO48）：白色塑料框 + 半透明扩散面
  const rgbBody = new THREE.Mesh(new THREE.BoxGeometry(5, 1.5, 5), new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.6 }));
  rgbBody.position.set(-W * 0.26, T / 2 + 0.75, -L / 2 + 15);
  rgbBody.castShadow = true;
  grp.add(rgbBody);
  const rgbMat = new THREE.MeshStandardMaterial({ color: 0xdedbd2, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.3 });
  const rgbLens = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.1, 32), rgbMat);
  rgbLens.position.set(rgbBody.position.x, T / 2 + 1.52, rgbBody.position.z);
  grp.add(rgbLens);
  const rgbLight = new THREE.PointLight(0xffffff, 0, 70, 2);
  rgbLight.position.set(rgbBody.position.x, T / 2 + 5, rgbBody.position.z);
  grp.add(rgbLight);

  // 排针：塑料座 + 镀金针
  const pinGeo = new THREE.BoxGeometry(0.64, 11.5, 0.64);
  const gold = new THREE.MeshStandardMaterial({ color: 0xe8c66a, metalness: 1, roughness: 0.25 });
  const n = spec.left.length;
  const pins = new THREE.InstancedMesh(pinGeo, gold, 2 * n);
  const m = new THREE.Matrix4();
  const pinX = W / 2 - 1.27;
  const pinPositions: Record<string, THREE.Vector3> = {};
  for (let i = 0; i < n; i++) {
    const z = -L / 2 + 6.6 + i * PITCH;
    pins.setMatrixAt(i, m.makeTranslation(-pinX, -T / 2 - 2.5, z));
    pins.setMatrixAt(n + i, m.makeTranslation(pinX, -T / 2 - 2.5, z));
    pinPositions['L' + i] = new THREE.Vector3(-pinX, 0, z);
    pinPositions['R' + i] = new THREE.Vector3(pinX, 0, z);
  }
  grp.add(pins);
  const headerMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
  for (const x of [-pinX, pinX]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, n * PITCH), headerMat);
    h.position.set(x, -T / 2 - 1.25, -L / 2 + 6.6 + ((n - 1) / 2) * PITCH);
    grp.add(h);
  }
  return { grp, buttons, pwrMat, rgbMat, rgbLight, pinPositions, L, spec };
}

/** SG90 舵机：蓝色壳体 + 安装耳 + 白色单臂舵盘。原点在壳体底面中心。 */
function servoModel() {
  const grp = new THREE.Group();
  const blue = new THREE.MeshPhysicalMaterial({ color: 0x2d5bd3, roughness: 0.35, transmission: 0.15, thickness: 2 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(22.5, 22.7, 11.8), blue);
  body.position.y = 11.35;
  body.castShadow = true;
  grp.add(body);
  const ears = new THREE.Mesh(new THREE.BoxGeometry(32.2, 2.5, 11.8), blue);
  ears.position.y = 15.9;
  grp.add(ears);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(5.9, 5.9, 4, 32), blue);
  top.position.set(-5.4, 24.7, 0);
  grp.add(top);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 3, 24), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }));
  shaft.position.set(-5.4, 28, 0);
  grp.add(shaft);
  const horn = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.55 });
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 2, 24), white);
  horn.add(hub);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(16, 1.6, 4.6), white);
  arm.position.x = 8;
  horn.add(arm);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 1.6, 20), white);
  tip.position.x = 16;
  horn.add(tip);
  horn.position.set(-5.4, 30, 0);
  horn.traverse((o) => (o.castShadow = true));
  grp.add(horn);
  return { grp, horn };
}

/** 旋转电位器（R16 规格）：蓝色方壳 + 金属轴 + 黑色带指示线的旋钮。原点在引脚根部。 */
function potModel() {
  const grp = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.BoxGeometry(9.8, 9.8, 5), new THREE.MeshStandardMaterial({ color: 0x2e63b8, roughness: 0.6 }));
  shell.position.set(0, 4.9 + 1, 0);
  shell.rotation.x = Math.PI / 2;
  shell.position.y = 3.5;
  grp.add(shell);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 4, 24), new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.9, roughness: 0.3 }));
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
  const legMat = new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 1, roughness: 0.3 });
  for (const x of [-PITCH, 0, PITCH]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4, 0.6), legMat);
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
  scene.environmentIntensity = 0.4;

  const camera = new THREE.PerspectiveCamera(35, 1, 1, 2000);
  camera.position.set(-40, 95, 105);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 6, 4);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 40;
  controls.maxDistance = 420;

  const key = new THREE.DirectionalLight(0xfff3e0, 1.25);
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
  const BB_TOP = 8.5;
  // 面包板与开发板随芯片切换（setBoard），外接元件按 partOffset 整体平移
  let bb = breadboard(BOARD_C3.cols);
  scene.add(bb.grp);
  let board = devboard(BOARD_C3);
  const placeBoard = () => {
    // 板子长边沿 x：旋转 -90°，USB 朝左
    board.grp.rotation.y = -Math.PI / 2;
    board.grp.position.set(bb.colX(board.spec.boardCol), BB_TOP + 6.8, 0);
    scene.add(board.grp);
    board.grp.updateMatrixWorld();
  };
  placeBoard();
  /** 元件用的面包板列号（按当前开发板平移） */
  const colX = (c: number) => bb.colX(c + board.spec.partOffset);
  const pinWorld = (key: string) => board.pinPositions[key].clone().applyMatrix4(board.grp.matrixWorld);

  /** 开发板上某个引脚（'IO5'、'3V3'、'GND'…）的世界坐标；GND 取离 near 最近的那个 */
  const pinByName = (name: string, near?: THREE.Vector3) => {
    const cands: THREE.Vector3[] = [];
    board.spec.right.forEach((n, i) => n === name && cands.push(pinWorld('R' + i)));
    board.spec.left.forEach((n, i) => n === name && cands.push(pinWorld('L' + i)));
    if (!cands.length) throw new Error(`开发板 ${board.spec.title} 上没有引脚 ${name}`);
    if (!near) return cands[0];
    return cands.sort((a, b) => a.distanceTo(near) - b.distanceTo(near))[0];
  };

  const lift = (v: THREE.Vector3, y: number) => new THREE.Vector3(v.x, y, v.z);
  const top = BB_TOP + 0.2;
  /** 从开发板引脚拉一根跳线到面包板孔位，中间拱起 */
  const jumper = (grp: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, color: number, arc = 26, bow = 6) => {
    const a = lift(from, top);
    const b = lift(to, top);
    grp.add(wire([a, lift(a, arc - 4), new THREE.Vector3((a.x + b.x) / 2, arc, (a.z + b.z) / 2 + bow), lift(b, arc - 6), b], color));
  };

  // 标注
  const label = (grp: THREE.Group, text: string, pos: THREE.Vector3) => {
    // 画布宽度按文字量取，标签不被裁切
    const font = '600 38px Inter, Helvetica, sans-serif';
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = font;
    const w = Math.ceil(probe.measureText(text).width) + 64;
    const tex = canvasTexture(w, 128, (g) => {
      g.fillStyle = 'rgba(14,17,20,0.78)';
      g.beginPath();
      g.roundRect(4, 4, w - 8, 120, 24);
      g.fill();
      g.fillStyle = '#e9edf2';
      g.font = font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, 66);
    });
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    s.scale.set((5 * w) / 128, 5, 1);
    s.position.copy(pos);
    s.renderOrder = 10;
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
  let potCb: ((pin: number, v: number) => void) | null = null;
  let parts = new THREE.Group();
  scene.add(parts);
  const oledData = new Uint8Array(128 * 64 * 4);
  let oledTex: THREE.DataTexture | null = null;

  function buildLed(grp: THREE.Group, p: Extract<PartSpec, { type: 'led' }>) {
    const l = led(p.color ?? 0xff2a1a);
    const col = p.col ?? 24;
    l.grp.position.set(colX(col) + 1.27, BB_TOP + 2, bb.rowZ(7));
    grp.add(l.grp);
    const r = resistor();
    r.position.set(colX(col - 2), BB_TOP + 1.5, bb.rowZ(7));
    grp.add(r);
    // IO → 电阻左端所在列；LED 阴极 → GND
    const gpio = pinByName('IO' + p.pin);
    const wEnd = new THREE.Vector3(colX(col - 4), top, bb.rowZ(9));
    jumper(grp, gpio, wEnd, WIRE.sig, 30, 6);
    const gStart = new THREE.Vector3(colX(col + 1), top, bb.rowZ(9));
    jumper(grp, gStart, pinByName('GND', gStart), WIRE.gnd, 24, 10);
    label(grp, p.label ?? `GPIO${p.pin} → 220Ω → LED`, new THREE.Vector3(colX(col - 1), 34, bb.rowZ(2) - 6));
    leds.push({ pin: p.pin, lens: l.lens, light: l.light, now: 0, target: 0 });
  }

  /**
   * 4 针 I2C 模组：竖插在 e 行（靠中缝），跳线从模组背后插进同一列的 a 行，
   * 这样线不会挡住屏幕。order 是模组从左到右的引脚功能。
   */
  function buildI2c(grp: THREE.Group, module: THREE.Group, firstCol: number, order: string[], sda: number, scl: number, height: number) {
    module.position.set(colX(firstCol + 1.5), BB_TOP, bb.rowZ(4));
    module.rotation.x = -0.12; // 略向后仰，便于俯视
    grp.add(module);
    order.forEach((fn, i) => {
      const hole = new THREE.Vector3(colX(firstCol + i), top, bb.rowZ(0));
      const map: Record<string, [string, number]> = {
        GND: ['GND', WIRE.gnd],
        VCC: ['3V3', WIRE.vcc],
        VIN: ['3V3', WIRE.vcc],
        SDA: ['IO' + sda, WIRE.sda],
        SCL: ['IO' + scl, WIRE.scl],
      };
      const [pinName, color] = map[fn];
      const a = lift(pinByName(pinName, hole), top);
      const peak = height + 6 + i * 1.6;
      // 先升起越过开发板，再在模组背后落下
      grp.add(
        wire(
          [a, lift(a, 22 + i), new THREE.Vector3((a.x + hole.x) / 2, peak, Math.min(a.z, hole.z) - 6 - i * 1.5), new THREE.Vector3(hole.x, peak - 4, hole.z - 4), lift(hole, 14), hole],
          color,
        ),
      );
    });
  }

  function buildServo(grp: THREE.Group, p: Extract<PartSpec, { type: 'servo' }>) {
    // 舵机放在面包板外侧的垫子上，三根线：信号 → IO、红 → 5V、棕 → GND
    const m = servoModel();
    m.grp.position.set(colX(24), 0, bb.rowZ(9) + 42);
    m.grp.rotation.y = Math.PI;
    grp.add(m.grp);
    const plug = new THREE.Vector3(colX(24) - 6, 4, bb.rowZ(9) + 30);
    const cols: [string, number][] = [['IO' + p.pin, 0xf28c28], ['5V', 0xd33a2c], ['GND', 0x6b4a2b]];
    cols.forEach(([pin, color], i) => {
      const a = lift(pinByName(pin, plug), top);
      const b = new THREE.Vector3(plug.x + i * 1.2, 4, plug.z);
      grp.add(wire([a, lift(a, 18 + i), new THREE.Vector3((a.x + b.x) / 2, 26 + i, (a.z + b.z) / 2 + 8), lift(b, 10), b], color));
    });
    label(grp, p.label ?? `SG90 舵机 · 信号 IO${p.pin} · 50Hz`, new THREE.Vector3(colX(24), 44, bb.rowZ(9) + 42));
    servos.push({ pin: p.pin, horn: m.horn, freq: p.freq ?? 50, angle: 90, target: 90 });
  }

  function buildPot(grp: THREE.Group, p: Extract<PartSpec, { type: 'pot' }>) {
    const m = potModel();
    const col = 19;
    m.grp.position.set(colX(col), BB_TOP + 1, bb.rowZ(8));
    grp.add(m.grp);
    // 左端 → 3V3、滑片 → IO、右端 → GND（从面包板同列的 j 行引出）
    const ends: [number, string, number][] = [[col - 1, '3V3', WIRE.vcc], [col, 'IO' + p.pin, WIRE.sig], [col + 1, 'GND', WIRE.gnd]];
    for (const [c, pin, color] of ends) {
      const hole = new THREE.Vector3(colX(c), top, bb.rowZ(9));
      jumper(grp, pinByName(pin, hole), hole, color, 20 + (c - col) * 2, 6);
    }
    label(grp, p.label ?? `电位器 · 滑片 → IO${p.pin}（ADC）· 拖动旋钮`, new THREE.Vector3(colX(col), 36, bb.rowZ(9) + 6));
    pots.push({ pin: p.pin, knob: m.knob, hit: m.hit, v: 0.36 });
    m.knob.rotation.y = -(0.36 - 0.5) * 1.5 * Math.PI;
  }

  let lastScene: SceneSpec = { parts: [] };

  /** 换开发板（C3 / S3）：面包板、开发板重建，外接元件按新板子的引脚重新接线 */
  function setBoard(chip: ChipId) {
    if (board.spec.chip === chip) return;
    const spec = BOARDS[chip];
    scene.remove(board.grp);
    disposeTree(board.grp);
    scene.remove(bb.grp);
    disposeTree(bb.grp);
    bb = breadboard(spec.cols);
    scene.add(bb.grp);
    board = devboard(spec);
    placeBoard();
    setScene(lastScene);
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
    oledTex = null;
    for (const p of spec.parts) {
      if (p.type === 'led') buildLed(parts, p);
      if (p.type === 'servo') buildServo(parts, p);
      if (p.type === 'pot') buildPot(parts, p);
      if (p.type === 'oled') {
        oledData.fill(0);
        for (let i = 3; i < oledData.length; i += 4) oledData[i] = 255;
        oledTex = new THREE.DataTexture(oledData, 128, 64, THREE.RGBAFormat);
        oledTex.magFilter = THREE.NearestFilter;
        oledTex.minFilter = THREE.LinearFilter;
        oledTex.colorSpace = THREE.SRGBColorSpace;
        oledTex.needsUpdate = true;
        buildI2c(parts, oledModule(oledTex), 21, ['GND', 'VCC', 'SCL', 'SDA'], p.sda, p.scl, 40);
        label(parts, p.label ?? `SSD1306 · I2C 0x${p.addr.toString(16).toUpperCase()} · SDA IO${p.sda} SCL IO${p.scl}`, new THREE.Vector3(colX(22.5), 46, bb.rowZ(0) - 10));
      }
      if (p.type === 'bme280') {
        buildI2c(parts, bmeModule(), 21, ['VIN', 'GND', 'SCL', 'SDA'], p.sda, p.scl, 22);
        label(parts, p.label ?? `BME280 · I2C 0x${p.addr.toString(16)} · SDA IO${p.sda} SCL IO${p.scl}`, new THREE.Vector3(colX(22.5), 34, bb.rowZ(0) - 8));
      }
    }
    // 示例可以指定机位（比如凑近看屏幕）；没有就回到默认机位
    // 机位按 C3 板子写的；换成更长的板子时随元件一起平移
    const v = spec.view ?? DEFAULT_VIEW;
    if (spec.view || board.spec.chip === BOARD_C3.chip) {
      const dx = colX(0) + ((BOARD_C3.cols - 1) / 2) * PITCH;
      camera.position.set(v.position[0] + dx, v.position[1], v.position[2]);
      controls.target.set(v.target[0] + dx, v.target[1], v.target[2]);
    } else {
      // 更长的面包板：对准面包板中心，按宽度拉远
      const k = 1 + (board.spec.cols / BOARD_C3.cols - 1) * 0.6;
      camera.position.set(v.position[0] * k, v.position[1] * k, v.position[2] * k);
      controls.target.set(v.target[0], v.target[1], v.target[2]);
    }
    controls.update();
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.8, 0.3, 1.6);
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
  // 电位器：按住旋钮左右拖动转动（270° 行程）
  let dragging: { pot: (typeof pots)[number]; x0: number; v0: number } | null = null;
  const pickPot = (ev: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(pots.map((p) => p.hit))[0];
    return hit ? pots.find((p) => p.hit === hit.object) : undefined;
  };
  const turnPot = (pot: (typeof pots)[number], v: number) => {
    pot.v = Math.min(1, Math.max(0, v));
    pot.knob.rotation.y = -(pot.v - 0.5) * 1.5 * Math.PI;
  };
  renderer.domElement.addEventListener('pointerdown', (ev) => {
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
  renderer.domElement.addEventListener('pointermove', (ev) => {
    renderer.domElement.style.cursor = pick(ev) ? 'pointer' : pickPot(ev) || dragging ? 'ew-resize' : '';
  });

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    // LED 亮灭有很短的过渡，像真实 LED 被眼睛看到的样子
    for (const l of leds) {
      l.now += (l.target - l.now) * 0.55;
      l.lens.emissiveIntensity = l.now * 6;
      l.light.intensity = l.now * 60;
    }
    // 舵机有转速上限（SG90 约 0.1s / 60°），舵盘追目标角度
    for (const sv of servos) {
      const step = 600 / 60;
      sv.angle += Math.max(-step, Math.min(step, sv.target - sv.angle));
      sv.horn.rotation.y = ((sv.angle - 90) * Math.PI) / 180;
    }
    controls.update();
    composer.render();
  };
  tick();

  return {
    setScene,
    setBoard,
    setGpio(level, enable, pwm, levelHi = 0, enableHi = 0) {
      const bit = (lo: number, hi: number, pin: number) => (pin < 32 ? (lo >>> pin) & 1 : (hi >>> (pin - 32)) & 1);
      // PWM 驱动时 LED 亮度 ≈ 占空比（人眼对 5kHz 闪烁无感，看到的是平均亮度）
      for (const l of leds) {
        const d = pwm?.[l.pin] ?? -1;
        l.target = d >= 0 ? d : bit(enable, enableHi, l.pin) && bit(level, levelHi, l.pin) ? 1 : 0;
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
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
    },
  };
}
