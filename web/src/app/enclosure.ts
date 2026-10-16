// 参数化外壳（P1-08）：按作品模版 + 清单里零件的尺寸算出外壳布局（零件槽位、开孔、定位柱）和警告，
// 再用 Manifold（wasm，懒加载）做布尔运算出底壳 / 顶盖网格。布局是纯函数（node --test 直接测），
// 网格函数吃一个 Manifold 模块实例（浏览器懒加载、node 测试直接 import），本文件不 import wasm。
// 坐标：毫米，z 朝上（打印朝向：底壳的外底面贴打印床）。尺寸、间隙都是估算，未经真机标定。
import { PART_BY_ID } from '../catalog/parts.ts';
import type { ManifoldToplevel, Manifold, CrossSection } from 'manifold-3d';

export type V3 = [number, number, number];

export interface CaseParams {
  /** 总高（气象站 = 壳深；小黄 / 透镜小人 = 底座高） */
  height: number;
  wall: number;
  /** 竖边圆角（只有方壳用） */
  radius: number;
}

export const DEFAULT_PARAMS: Record<string, CaseParams> = {
  weather: { height: 32, wall: 2, radius: 5.5 },
  spin: { height: 32, wall: 2, radius: 0 },
  lens: { height: 30, wall: 2, radius: 0 },
};
export const PARAM_RANGE = { height: [16, 80], wall: [1.2, 4], radius: [0, 12] } as const;

/** 画零件用的简单体（盒子 / 圆柱 / 圆环 / 球冠），在外壳坐标里 */
export interface Prim {
  shape: 'box' | 'cyl' | 'torus' | 'cap';
  at: V3;
  /** box：长宽高；cyl：[直径, 直径, 高]；torus：[直径, 管径, 0]；cap：[直径, 直径, 高] */
  size: V3;
  color: string;
  /** cyl 的轴：默认 z */
  axis?: 'z' | 'y';
  /** 绕 z 转（度），舵盘错齿用 */
  rotZ?: number;
  emissive?: boolean;
}
export interface Pose {
  prims: Prim[];
  /** 网格件（底壳 / 顶盖）没有 prims，用 mesh 标出来 */
  mesh?: 'bottom' | 'lid';
  min: V3;
  max: V3;
  center: V3;
}
export interface SizeInfo {
  part: string;
  name: string;
  size: V3;
  /** 元件库没有尺寸，用的是常见规格的估算 */
  est: boolean;
}
export interface CaseLayout {
  template: string;
  params: CaseParams;
  shape: 'rect' | 'round';
  /** 外形：方壳 [宽, 长, 高]；圆壳 [直径, 直径, 底座高] */
  outer: V3;
  /** 顶盖（方壳前面板 / 小黄身体 / 透镜外框）的外形，打印尺寸提示用 */
  lidSize: V3;
  /** 槽位：零件 id → 装法 key（无装法差别的用 ''）→ 位置 */
  slots: Record<string, Record<string, Pose>>;
  /** 芯片（模组屏蔽罩顶面中心），尺子用 */
  chip: V3 | null;
  features: { bottom: string[]; lid: string[] };
  sizes: SizeInfo[];
  warnings: { id: string; text: string }[];
  /** 高度相关：内腔可用 / 需要（mm），以及不出高度警告的最低高度 */
  inner: number;
  need: number;
  minHeight: number;
  /** 网格函数要的几何参数 */
  geo: Geo;
}
export type Geo =
  | { t: 'weather'; W: number; D: number; H: number; w: number; r: number; bx: number; by: number; bl: number; bw: number; sx: number; sy: number; vs: V3; ox: number; oy: number; ow: number; A: V3; tl: number; tw: number }
  | { t: 'spin'; R: number; Hb: number; w: number; Rb: number; z0: number; cylH: number; domeH: number; faceZ: number; vs: V3 }
  | { t: 'lens'; R: number; Hb: number; w: number; ledge: number; bez: number; vertical: boolean; bl: number; bw: number };

/** 元件库没给尺寸时用的常见规格（长 × 宽 × 高，mm；估算） */
const FALLBACK: Record<string, V3> = {
  's3-devkitc1-v10': [63, 26, 8],
  's3-devkitc1-v11': [63, 26, 8],
  'luat-s3': [55, 22, 8],
  'c3-devkitm1': [54, 26, 8],
  'xiao-s3': [21, 17.8, 4],
  'xiao-c3': [21, 17.8, 4],
  bme280: [13, 10.5, 2.5],
  aht20: [16, 11, 2.5],
  ssd1306: [27.3, 27.8, 4],
  sh1106: [35.4, 33.5, 4],
  gc9a01: [38.6, 38.6, 4],
  sg90: [22.2, 11.8, 31],
  mg90s: [22.8, 12.2, 28.5],
};
/** 舵机轴伸出顶盖的长度：舵机高减去它就是壳里要留的深度 */
export const SHAFT_OUT = 4;
const STANDOFF = 3;
const PCB = 1.6;
const MODULE_H = 3.2;

export function partSize(id: string): SizeInfo {
  const p = PART_BY_ID[id];
  const s = p?.sizeMm;
  const fb = FALLBACK[id] ?? [20, 20, 5];
  if (s && s[2] !== null) return { part: id, name: p.name, size: [s[0], s[1], s[2]], est: false };
  if (s) return { part: id, name: p.name, size: [s[0], s[1], fb[2]], est: true };
  return { part: id, name: p?.name ?? id, size: fb, est: true };
}

export interface CaseSel {
  board: string;
  servo?: string;
  oled?: string;
  sensor?: string;
  lcd?: string;
}
/** 从清单的件里挑出外壳要用的几个（找不到就用模版默认） */
export function caseSel(board: string, picks: string[]): CaseSel {
  const first = (ids: string[], d: string) => ids.find((x) => picks.includes(x)) ?? d;
  return {
    board,
    servo: first(['sg90', 'mg90s'], 'sg90'),
    oled: first(['ssd1306', 'sh1106'], 'ssd1306'),
    sensor: first(['bme280', 'aht20'], 'bme280'),
    lcd: first(['gc9a01'], 'gc9a01'),
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const clampP = (p: CaseParams): CaseParams => ({
  height: Math.min(PARAM_RANGE.height[1], Math.max(PARAM_RANGE.height[0], p.height)),
  wall: Math.min(PARAM_RANGE.wall[1], Math.max(PARAM_RANGE.wall[0], p.wall)),
  radius: Math.min(PARAM_RANGE.radius[1], Math.max(PARAM_RANGE.radius[0], p.radius)),
});

function pose(prims: Prim[], mesh?: 'bottom' | 'lid', box?: { min: V3; max: V3 }): Pose {
  let min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  if (box) [min, max] = [box.min, box.max];
  else
    for (const p of prims) {
      const h: V3 = p.shape === 'torus' ? [p.size[0] / 2 + p.size[1] / 2, p.size[0] / 2 + p.size[1] / 2, p.size[1] / 2] : p.shape === 'cyl' && p.axis === 'y' ? [p.size[0] / 2, p.size[2] / 2, p.size[0] / 2] : [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2];
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], p.at[i] - h[i]);
        max[i] = Math.max(max[i], p.at[i] + h[i]);
      }
    }
  return { prims, mesh, min, max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
}
const box = (at: V3, size: V3, color: string, extra: Partial<Prim> = {}): Prim => ({ shape: 'box', at, size, color, ...extra });
const cyl = (at: V3, d: number, h: number, color: string, extra: Partial<Prim> = {}): Prim => ({ shape: 'cyl', at, size: [d, d, h], color, ...extra });

/** 平放的开发板：PCB + 模组屏蔽罩 + USB-C 口 + 板载灯。USB 口朝 -y */
function boardPrims(cx: number, cy: number, z0: number, l: number, w: number, vertical = false): { prims: Prim[]; chip: V3 } {
  const long = l > 40;
  if (vertical) {
    // 竖放：长边沿 z，PCB 面朝 -y
    const ml = long ? 25.5 : l * 0.7, mw = long ? 18 : w * 0.7;
    const mz = long ? z0 + l - ml / 2 - 0.5 : z0 + l / 2;
    return {
      prims: [box([cx, cy, z0 + l / 2], [w, PCB, l], '#141414'), box([cx, cy - PCB / 2 - MODULE_H / 2, mz], [mw, MODULE_H, ml], '#BDB9B0'), box([cx, cy - PCB / 2 - 1.6, z0 + 3.5], [9, 3.2, 7.5], '#8A867E')],
      chip: [cx, cy - PCB / 2 - MODULE_H, mz],
    };
  }
  const ml = long ? 25.5 : l * 0.7, mw = long ? 18 : w * 0.7;
  const my = long ? cy + l / 2 - ml / 2 - 0.5 : cy;
  const top = z0 + PCB;
  return {
    prims: [
      box([cx, cy, z0 + PCB / 2], [w, l, PCB], '#141414'),
      box([cx, my, top + MODULE_H / 2], [mw, ml, MODULE_H], '#BDB9B0'),
      box([cx, cy - l / 2 + 3.5, top + 1.6], [9, 7.5, 3.2], '#8A867E'),
      cyl([cx + w / 2 - 4, cy - l / 2 + 12, top + 0.6], 2.4, 1.2, '#22C55E', { emissive: true }),
    ],
    chip: [cx, my, top + MODULE_H],
  };
}

function servoPrims(sx: number, sy: number, zTop: number, s: V3, hornDeg: number): Prim[] {
  // 舵机竖着挂在 zTop（顶盖内面 / 底座顶板下面）下面：耳朵贴着，轴从 sy 处穿出去 SHAFT_OUT
  const [sl, sw, sh] = s;
  const bodyH = sh - SHAFT_OUT - 2.5;
  const cy = sy - (sl / 2 - sw / 2);
  return [
    box([sx, cy, zTop - 2.5 - bodyH / 2], [sw, sl, bodyH], '#2B5FD9'),
    box([sx, cy, zTop - 1.25], [sw, sl + 10, 2.5], '#2B5FD9'),
    cyl([sx, sy, zTop + SHAFT_OUT / 2 - 1], 4.8, SHAFT_OUT + 2, '#F7F6F3'),
    box([sx, sy, zTop + SHAFT_OUT + 0.8], [5, 18, 1.6], '#F7F6F3', { rotZ: hornDeg }),
  ];
}

export function caseLayout(template: string, params: CaseParams, sel: CaseSel): CaseLayout {
  const p = clampP(params);
  if (template === 'spin') return spinLayout(p, sel);
  if (template === 'lens') return lensLayout(p, sel);
  return weatherLayout(p, sel);
}

// ------------------------------------------------------------------ 气象站：方壳 50 × 70，前面板是顶盖
function weatherLayout(p: CaseParams, sel: CaseSel): CaseLayout {
  const W = 50, D = 70, H = p.height, w = p.wall;
  const ix = W / 2 - w, iy = D / 2 - w;
  const sizes = [partSize(sel.board), partSize(sel.sensor ?? 'bme280'), partSize(sel.servo ?? 'sg90'), partSize(sel.oled ?? 'ssd1306')];
  const [bs, ss, vs, os] = sizes.map((x) => x.size);
  const warnings: CaseLayout['warnings'] = [];
  const lidZ = H - w;
  // 开发板：贴左墙，USB 口朝下（-y）；短板放左下角
  const [bl, bw] = [bs[0], bs[1]];
  const bx = -ix + 0.5 + bw / 2;
  const by = bl > 2 * iy - 1 ? 0 : bl > 40 ? 0 : -iy + 0.5 + bl / 2;
  const B = boardPrims(bx, by, w + STANDOFF, bl, bw);
  if (bl > 2 * iy - 0.5 || bw > 2 * ix - 14) warnings.push({ id: 'board-fit', text: `开发板 ${bl}×${bw} mm 放不进内腔 ${r1(2 * ix)}×${r1(2 * iy)} mm（壁厚 ${w} mm）` });
  // 舵机：开发板右边与右墙之间，轴对着表盘中心；挂在前面板下面
  const boardRight = bx + bw / 2;
  const sx = (boardRight + ix) / 2;
  const sy = Math.min(19, iy - 5.9 - 5 - 1);
  if (vs[1] + 1 > ix - boardRight) warnings.push({ id: 'servo-side', text: `开发板右边只剩 ${r1(ix - boardRight)} mm，舵机宽 ${vs[1]} mm 塞不下` });
  const inner = H - 2 * w;
  const need = vs[2] - SHAFT_OUT;
  if (inner < need) warnings.push({ id: 'servo-height', text: `太矮：内腔 ${r1(inner)} mm，舵机要 ${r1(need)} mm（${vs[2]} mm 高、轴伸出 ${SHAFT_OUT} mm），会顶住底壳` });
  const stack = STANDOFF + PCB + MODULE_H + 1;
  // OLED：前面板下面、舵机耳朵下方
  const [ol, ow, oh] = os;
  const ox = -2, oy = sy - (vs[0] - vs[1] / 2) - 5 - 0.5 - ow / 2;
  const oz = lidZ - 1 - oh / 2;
  if (oy - ow / 2 < -iy) warnings.push({ id: 'oled-fit', text: `OLED 模块 ${ol}×${ow} mm 和舵机在前面板下面挤不下` });
  if (inner < stack + oh + 1) warnings.push({ id: 'oled-height', text: `太矮：OLED 碰到开发板（内腔 ${r1(inner)} mm）` });
  // 传感器：A 通风口旁（右墙内侧，立柱上）；B 开发板旁（趴在模组屏蔽罩上）
  const [tl, tw, th] = ss;
  const A: V3 = [ix - 1 - tl / 2, -10, w + 4 + th / 2];
  const Bp: V3 = [B.chip[0], B.chip[1] - 4, B.chip[2] + th / 2];
  const sensorPrims = (c: V3): Prim[] => [box(c, [tl, tw, th], '#6A3FA0'), box([c[0], c[1], c[2] + th / 2 + 0.5], [3, 3, 1], '#C9C6BF')];
  const shellPose = pose([], 'bottom', { min: [-W / 2, -D / 2, 0], max: [W / 2, D / 2, lidZ] });
  const lidPose = pose([], 'lid', { min: [-W / 2, -D / 2, lidZ - 2], max: [W / 2, D / 2, H] });
  return {
    template: 'weather',
    params: p,
    shape: 'rect',
    outer: [W, D, H],
    lidSize: [W, D, w + 2],
    slots: {
      shell: { '': shellPose },
      board: { '': pose(B.prims) },
      bme: { A: pose(sensorPrims(A)), B: pose(sensorPrims(Bp)) },
      servo: { '': pose(servoPrims(sx, sy, lidZ, vs, 0)) },
      oled: { '': pose([box([ox, oy, oz], [ol, ow, oh - 1.4], '#1C4F86'), box([ox, oy + 2, lidZ - 1 - 0.7], [ol - 2, ow * 0.55, 1.4], '#050608')]) },
      front: { '': lidPose },
    },
    chip: B.chip,
    features: {
      bottom: [`4 根开发板定位柱（高 ${STANDOFF} mm）`, 'USB-C 开孔（背面，开发板 USB 口下方）', '右侧 6 条通风槽 + 底面 3 个 BME280 通气孔', 'BME280 立柱（通风口旁）'],
      lid: [`OLED 窗 22 × 11.5 mm`, `表盘轴孔 Ø7 mm（对准舵机轴）`, '导光柱孔 Ø4 mm', '舵机卡槽、OLED 定位柱', '止口（插进底壳 2 mm）'],
    },
    sizes,
    warnings,
    inner,
    need: Math.max(need, stack + oh + 1),
    minHeight: r1(Math.max(need, stack + oh + 1) + 2 * w),
    geo: { t: 'weather', W, D, H, w, r: Math.min(p.radius, W / 2 - 1), bx, by, bl, bw, sx, sy, vs, ox, oy, ow, A, tl, tw },
  };
}

// ------------------------------------------------------------------ 小黄：Ø60 底座（舵机仓）+ 身体（顶盖）
function spinLayout(p: CaseParams, sel: CaseSel): CaseLayout {
  const R = 30, Hb = p.height, w = p.wall, TOTAL = 110;
  const sizes = [partSize(sel.board), partSize(sel.servo ?? 'sg90'), partSize(sel.lcd ?? 'gc9a01')];
  const [bs, vs, ls] = sizes.map((x) => x.size);
  const warnings: CaseLayout['warnings'] = [];
  const inner = Hb - 2 * w;
  const need = vs[2] - SHAFT_OUT;
  if (inner < need) warnings.push({ id: 'servo-height', text: `太矮：底座内腔 ${r1(inner)} mm，舵机要 ${r1(need)} mm，会顶住底` });
  if (vs[0] + 10 > 2 * (R - w) - 2) warnings.push({ id: 'servo-fit', text: `舵机（含耳朵 ${vs[0] + 10} mm）放不进底座 Ø${r1(2 * (R - w))} mm` });
  // 身体：底座上方，舵盘上面
  const z0 = Hb + SHAFT_OUT + 1.6;
  const Rb = 27, bodyH = TOTAL - z0;
  // 身体 = 圆柱 + 压扁的半球顶（高 0.6 Rb）；开发板竖放在中间，顶端要躲开球顶
  const domeH = Rb * 0.6, cylH = bodyH - domeH;
  const [bl, bw] = [bs[0], bs[1]];
  const boardTop = z0 + 3.5 + bl, dz = boardTop - (z0 + cylH);
  const a = Rb - w, c = domeH - w;
  const availR = dz <= 0 ? a : dz >= c ? 0 : a * Math.sqrt(1 - (dz / c) ** 2);
  if (Math.hypot(bw / 2, PCB / 2 + MODULE_H) > availR - 0.5) warnings.push({ id: 'board-fit', text: `开发板 ${bl}×${bw} mm 竖放顶到身体的球顶了（底座 ${Hb} mm 太高，或换短一点的板）` });
  const Bd = boardPrims(0, 0, z0 + 3.5, bl, bw, true);
  const faceZ = z0 + bodyH * 0.58;
  const lcdPose = pose([cyl([0, -(Rb - w - ls[2] / 2 - 1), faceZ], ls[0], ls[2], '#1A1A19', { axis: 'y' }), cyl([0, -(Rb - w - 0.4), faceZ], 32.4, 0.6, '#06070A', { axis: 'y' })]);
  const servo = (deg: number) => pose(servoPrims(0, 0, Hb - w, vs, deg));
  return {
    template: 'spin',
    params: p,
    shape: 'round',
    outer: [2 * R, 2 * R, Hb],
    lidSize: [2 * Rb, 2 * Rb, bodyH],
    slots: {
      base: { '': pose([], 'bottom', { min: [-R, -R, 0], max: [R, R, Hb] }) },
      servo: { C: servo(0), X: servo(360 / 25) },
      board: { '': pose(Bd.prims) },
      lcd: { '': lcdPose },
      body: { '': pose([], 'lid', { min: [-Rb, -Rb, z0], max: [Rb, Rb, TOTAL] }) },
      hair: { '': pose([{ shape: 'torus', at: [3, 0, TOTAL + 2], size: [12, 3, 0], color: '#141414' }]) },
    },
    chip: Bd.chip,
    features: {
      bottom: ['舵机仓（顶板开方孔，耳朵搭在顶板上）', 'USB-C / 电源线开孔（背面）'],
      lid: [`圆屏窗 Ø34 mm（${ls[0]} mm 模块从里面卡住）`, '舵盘座 + 中心排线孔 Ø6 mm', '底部敞口，套在舵盘上'],
    },
    sizes,
    warnings,
    inner,
    need,
    minHeight: r1(need + 2 * w),
    geo: { t: 'spin', R, Hb, w, Rb, z0, cylH, domeH, faceZ, vs },
  };
}

// ------------------------------------------------------------------ 透镜小人：Ø50 底座 + 屏幕外框（顶盖，两档卡槽）
function lensLayout(p: CaseParams, sel: CaseSel): CaseLayout {
  const R = 25, Hb = p.height, w = p.wall;
  const sizes = [partSize(sel.board), partSize(sel.lcd ?? 'gc9a01')];
  const [bs, ls] = sizes.map((x) => x.size);
  const warnings: CaseLayout['warnings'] = [];
  const ledge = Hb - 4;
  const inner = ledge - w;
  const [bl, bw, bh] = bs;
  const flat = Math.hypot(bl / 2, bw / 2) <= R - w - 0.5;
  const stack = STANDOFF + PCB + MODULE_H + 1;
  let need = stack;
  let vertical = false;
  if (!flat) {
    // 平放放不下：内腔够高就竖放
    if (inner - 1 >= bl + 3 && bw <= 2 * (R - w) - 4) vertical = true;
    else warnings.push({ id: 'board-fit', text: `开发板 ${bl}×${bw} mm 平放进不了底座内径 Ø${r1(2 * (R - w))} mm；竖放要底座高 ≥ ${r1(bl + 3 + 1 + w + 4)} mm。可以换小板（XIAO S3 21×17.8 mm）` });
    need = bl + 4;
  }
  if (flat && inner < stack) warnings.push({ id: 'board-height', text: `太矮：屏幕下面只有 ${r1(inner)} mm，开发板要 ${r1(stack)} mm` });
  if (ls[0] > 2 * (R - w)) warnings.push({ id: 'lcd-fit', text: `圆屏模块 Ø${ls[0]} mm 比底座内径大` });
  const Bd = vertical ? boardPrims(0, 6, w + 1, bl, bw, true) : boardPrims(0, 0, w + STANDOFF, bl, bw);
  const bez = 12;
  const domeAt = (lift: number): Pose => pose([cyl([0, 0, Hb + 1.2 + lift + 0.75], 40, 1.5, '#BFD3E6'), { shape: 'cap', at: [0, 0, Hb + 1.2 + lift + 1.5 + 3.5], size: [40, 40, 7], color: '#BFD3E6' }]);
  void bh;
  return {
    template: 'lens',
    params: p,
    shape: 'round',
    outer: [2 * R, 2 * R, Hb],
    lidSize: [2 * R, 2 * R, bez],
    slots: {
      base: { '': pose([], 'bottom', { min: [-R, -R, 0], max: [R, R, Hb] }) },
      board: { '': pose(Bd.prims) },
      lcd: { '': pose([cyl([0, 0, ledge + ls[2] / 2], ls[0], ls[2], '#1A1A19'), cyl([0, 0, ledge + ls[2] + 0.3], 32.4, 0.6, '#06070A')]) },
      bezel: { '': pose([], 'lid', { min: [-R, -R, Hb], max: [R, R, Hb + bez] }) },
      dome: { H: domeAt(8), N: domeAt(0) },
    },
    chip: Bd.chip,
    features: {
      bottom: [vertical ? '开发板竖放卡槽' : '4 根开发板定位柱', `圆屏台阶（离顶 4 mm）`, 'USB-C 开孔（背面）'],
      lid: ['屏幕窗 Ø34 mm', '两档卡槽：低档贴屏 / 高档离屏 8 mm（转 45° 换档）'],
    },
    sizes,
    warnings,
    inner,
    need,
    minHeight: r1(need + w + 4),
    geo: { t: 'lens', R, Hb, w, ledge, bez, vertical, bl, bw },
  };
}

// ================================================================== 网格（Manifold）
export interface MeshData {
  pos: Float32Array;
  idx: Uint32Array;
}
export interface CaseMeshes {
  bottom: MeshData;
  lid: MeshData;
  /** 底壳、顶盖的体积（mm³），打印报价 / 测试用 */
  volume: { bottom: number; lid: number };
}

function toData(m: Manifold): MeshData {
  const mesh = m.getMesh();
  const n = mesh.numProp;
  const nv = mesh.vertProperties.length / n;
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = mesh.vertProperties[i * n + k];
  return { pos, idx: new Uint32Array(mesh.triVerts) };
}

/** 布尔运算：用完的中间体都要 delete（wasm 不进 GC） */
export function buildCaseMeshes(M: ManifoldToplevel, L: CaseLayout): CaseMeshes {
  const trash: { delete(): void }[] = [];
  const k = <T extends { delete(): void }>(x: T) => (trash.push(x), x);
  const { Manifold: Mf, CrossSection: CS } = M;
  const cube = (size: V3, at: V3) => k(k(Mf.cube(size, true)).translate(at));
  const cylZ = (d: number, h: number, at: V3, seg = 48) => k(k(Mf.cylinder(h, d / 2, d / 2, seg, true)).translate(at));
  const cylY = (d: number, h: number, at: V3, seg = 48) => k(k(k(Mf.cylinder(h, d / 2, d / 2, seg, true)).rotate([90, 0, 0])).translate(at));
  const union = (xs: Manifold[]) => k(Mf.union(xs));
  const sub = (a: Manifold, xs: Manifold[]) => (xs.length ? k(a.subtract(union(xs))) : a);
  const rrect = (w: number, d: number, r: number): CrossSection => {
    if (r < 0.2) return k(CS.square([w, d], true));
    return k(k(CS.square([Math.max(0.1, w - 2 * r), Math.max(0.1, d - 2 * r)], true)).offset(r, 'Round', 2, 32));
  };
  try {
    let bottom: Manifold, lid: Manifold;
    const g = L.geo;
    if (g.t === 'weather') {
      const { W, D, H, w, r, bx, by, bl, bw, sx, sy, ox, oy, ow, tl, tw, vs, A } = g;
      const lidZ = H - w;
      const outer = k(rrect(W, D, r).extrude(lidZ));
      const cavity = k(k(rrect(W - 2 * w, D - 2 * w, Math.max(0.5, r - w)).extrude(lidZ)).translate([0, 0, w]));
      const posts: Manifold[] = [];
      const holes: Manifold[] = [];
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const px = bx + dx * (bw / 2 - 2.5), py = by + dy * (bl / 2 - 2.5);
        posts.push(cylZ(5, STANDOFF, [px, py, w + STANDOFF / 2], 24));
        holes.push(cylZ(2, STANDOFF + 1, [px, py, w + STANDOFF / 2 + 0.5], 16));
      }
      for (const dx of [-tl / 2 + 2, tl / 2 - 2]) posts.push(cylZ(2.6, 4, [A[0] + dx, A[1], w + 2], 16));
      // 通风槽（右墙）+ 底面通气孔（BME280 下面）
      for (let i = 0; i < 6; i++) holes.push(cube([w * 3, 1.6, Math.max(4, lidZ - w - 8)], [W / 2, A[1] - 6 + i * 2.4, w + (lidZ - w) / 2]));
      for (let i = -1; i <= 1; i++) holes.push(cylZ(2, w * 3, [A[0] + i * 3.5, A[1] + tw / 2 + 2, w / 2], 16));
      // USB-C：背面（底面）开孔，开发板 USB 口下方
      holes.push(cube([11, 5, w * 3], [bx, by - bl / 2 + 3.5, w / 2]));
      bottom = sub(union([k(outer.subtract(cavity)), ...posts]), holes);
      // 前面板：板 + 止口 + 舵机卡槽 + OLED 定位柱，减 OLED 窗 / 轴孔 / 导光柱孔
      const plate = k(k(rrect(W, D, r).extrude(w)).translate([0, 0, lidZ]));
      const lipO = rrect(W - 2 * w - 0.6, D - 2 * w - 0.6, Math.max(0.5, r - w - 0.3));
      const lipI = rrect(W - 2 * w - 3, D - 2 * w - 3, Math.max(0.3, r - w - 1.5));
      const lip = k(k(k(lipO.subtract(lipI)).extrude(2)).translate([0, 0, lidZ - 2]));
      const add: Manifold[] = [plate, lip];
      const servoCy = sy - (vs[0] / 2 - vs[1] / 2);
      for (const dx of [-1, 1]) add.push(cube([1.2, vs[0] - 2, 4], [sx + dx * (vs[1] / 2 + 0.6), servoCy, lidZ - 2]));
      for (const dx of [-1, 1]) for (const dy of [-1, 1]) add.push(cylZ(2, 1, [ox + dx * (ow / 2 - 2), oy + dy * (ow / 2 - 2), lidZ - 0.5], 12));
      const lidHoles = [cube([22, 11.5, w * 4], [ox, oy + 2, lidZ + w / 2]), cylZ(7, w * 4, [sx, sy, lidZ + w / 2]), cylZ(4, w * 4, [W / 2 - w - 5, -D / 2 + w + 5, lidZ + w / 2], 24)];
      lid = sub(union(add), lidHoles);
    } else if (g.t === 'spin') {
      const { R, Hb, w, Rb, z0, cylH, domeH, faceZ, vs } = g;
      const outer = cylZ(2 * R, Hb, [0, 0, Hb / 2], 96);
      const inner = cylZ(2 * (R - w), Hb - 2 * w, [0, 0, Hb / 2], 96);
      const servoCy = -(vs[0] / 2 - vs[1] / 2);
      bottom = sub(outer, [inner, cube([vs[1] + 0.6, vs[0] + 0.6, w * 3], [0, servoCy, Hb - w / 2]), cube([12, w * 3, 6], [0, R - w / 2, w + 5]), cylZ(6, w * 3, [0, 12, Hb - w / 2], 24)]);
      // 身体：圆柱 + 压扁的半球顶，壁厚 w，底敞口（内胆往下多伸 0.5 mm 把底面打穿）
      const shellOf = (rr: number, hz: number, dz: number) => union([cylZ(2 * rr, cylH, [0, 0, z0 + cylH / 2 + dz], 96), k(k(k(Mf.sphere(rr, 96)).scale([1, 1, hz / rr])).translate([0, 0, z0 + cylH + dz]))]);
      const outerB = shellOf(Rb, domeH, 0);
      const innerB = shellOf(Rb - w, domeH - w, -0.5);
      const seat = sub(cylZ(24, 3, [0, 0, z0 + 1.5], 48), [cylZ(6, 4, [0, 0, z0 + 1.5], 24)]);
      const ribs = [cube([1.6, 2 * (Rb - w) - 1, 3], [0, 0, z0 + 1.5])];
      lid = sub(union([k(outerB.subtract(innerB)), seat, ...ribs]), [cylY(34, Rb * 2, [0, -Rb, faceZ], 64), cylZ(6, 8, [0, 0, z0 + 1.5], 24)]);
    } else {
      const { R, Hb, w, ledge, bez, vertical } = g;
      const outer = cylZ(2 * R, Hb, [0, 0, Hb / 2], 96);
      const inner = cylZ(2 * (R - w), Hb, [0, 0, w + Hb / 2], 96);
      const step = sub(cylZ(2 * (R - w), 2, [0, 0, ledge - 1], 96), [cylZ(2 * (R - w) - 4, 3, [0, 0, ledge - 1], 96)]);
      const bl = g;
      const adds: Manifold[] = [step];
      // 平放放得下才打定位柱；竖放打两条卡槽；都放不下（有警告）就不打，免得柱子戳到壳外
      if (vertical) for (const dx of [-1, 1]) adds.push(cube([2, 6, 6], [dx * (bl.bw / 2 + 1), 6, w + 3]));
      else if (Math.hypot(bl.bl / 2, bl.bw / 2) <= R - w - 0.5) for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) adds.push(cylZ(4.5, STANDOFF, [dx * (bl.bw / 2 - 2.5), dy * (bl.bl / 2 - 2.5), w + STANDOFF / 2], 20));
      bottom = sub(union([k(outer.subtract(inner)), ...adds]), [cube([12, w * 3, 6], [0, R - w / 2, w + 6])]);
      // 外框：管 + 底沿（压住屏）+ 两档卡扣（低档在底沿上，高档 8 mm 处，与低档错开 45°）
      const tube = sub(cylZ(2 * R, bez, [0, 0, Hb + bez / 2], 96), [cylZ(41.2, bez + 1, [0, 0, Hb + bez / 2], 96)]);
      const rim = sub(cylZ(41.4, 1.2, [0, 0, Hb + 0.6], 96), [cylZ(34, 2, [0, 0, Hb + 0.6], 64)]);
      const tabs: Manifold[] = [];
      for (let i = 0; i < 4; i++) {
        const a = (Math.PI / 2) * i + Math.PI / 4;
        tabs.push(k(k(k(Mf.cube([2.4, 3, 1.2], true)).rotate([0, 0, (a * 180) / Math.PI])).translate([Math.cos(a) * 19.8, Math.sin(a) * 19.8, Hb + 1.2 + 8 - 0.6])));
      }
      lid = union([tube, rim, ...tabs]);
    }
    return { bottom: toData(bottom), lid: toData(lid), volume: { bottom: bottom.volume(), lid: lid.volume() } };
  } finally {
    for (const t of trash) {
      try {
        t.delete();
      } catch {
        /* 已经释放过 */
      }
    }
  }
}

/** 导出用的摆放：底壳原样（外底面贴床），顶盖翻过来贴床、挪到旁边 */
export function printLayout(L: CaseLayout, m: CaseMeshes): { name: string; mesh: MeshData }[] {
  const flip = (d: MeshData, dx: number): MeshData => {
    let zmax = -Infinity;
    for (let i = 2; i < d.pos.length; i += 3) zmax = Math.max(zmax, d.pos[i]);
    const pos = new Float32Array(d.pos.length);
    for (let i = 0; i < d.pos.length; i += 3) {
      // 绕 x 轴转 180°：(x, y, z) → (x, -y, zmax - z)，绕向不变
      pos[i] = d.pos[i] + dx;
      pos[i + 1] = -d.pos[i + 1];
      pos[i + 2] = zmax - d.pos[i + 2];
    }
    return { pos, idx: d.idx };
  };
  const gap = L.outer[0] / 2 + L.lidSize[0] / 2 + 10;
  const names: Record<string, [string, string]> = { weather: ['后壳', '前面板'], spin: ['底座', '身体'], lens: ['底座', '屏幕外框'] };
  const [a, b] = names[L.template] ?? ['底壳', '顶盖'];
  // 小黄身体是半球顶，倒过来打会悬空：正着放（敞口贴床），只平移
  const lid = L.template === 'spin' ? shiftToBed(m.lid, gap) : flip(m.lid, gap);
  return [
    { name: a, mesh: m.bottom },
    { name: b, mesh: lid },
  ];
}
function shiftToBed(d: MeshData, dx: number): MeshData {
  let zmin = Infinity;
  for (let i = 2; i < d.pos.length; i += 3) zmin = Math.min(zmin, d.pos[i]);
  const pos = new Float32Array(d.pos.length);
  for (let i = 0; i < d.pos.length; i += 3) {
    pos[i] = d.pos[i] + dx;
    pos[i + 1] = d.pos[i + 1];
    pos[i + 2] = d.pos[i + 2] - zmin;
  }
  return { pos, idx: d.idx };
}
