// Parametric case (P1-08): pure layout + warnings from template and part sizes; meshes take a passed-in Manifold (no wasm import).
// Units mm, z up (bottom shell on the print bed). Sizes and clearances are estimates, not hardware-calibrated.
import { PART_BY_ID } from '../catalog/parts.ts';
import { t } from '../i18n/index.ts';
import type { ManifoldToplevel, Manifold, CrossSection } from 'manifold-3d';
import { PARAM_RANGE } from './caseparams.ts';

export type V3 = [number, number, number];

export interface CaseParams {
  /** Total height (weather = shell depth; spin / lens = base height) */
  height: number;
  wall: number;
  /** Vertical edge radius (rectangular cases only) */
  radius: number;
}

export { DEFAULT_PARAMS, PARAM_RANGE } from './caseparams.ts';

/** Simple solids for drawing parts (box / cylinder / torus / cap) in case coordinates */
export interface Prim {
  shape: 'box' | 'cyl' | 'torus' | 'cap';
  at: V3;
  /** box: l, w, h; cyl: [d, d, h]; torus: [d, tube d, 0]; cap: [d, d, h] */
  size: V3;
  color: string;
  /** cyl axis, default z */
  axis?: 'z' | 'y';
  /** Rotation about z (degrees), for horn tooth offset */
  rotZ?: number;
  emissive?: boolean;
}
export interface Pose {
  prims: Prim[];
  /** Mesh parts (bottom / lid) have no prims and are tagged by mesh */
  mesh?: 'bottom' | 'lid';
  min: V3;
  max: V3;
  center: V3;
}
export interface SizeInfo {
  part: string;
  name: string;
  size: V3;
  /** Catalog has no size; a common-spec estimate is used */
  est: boolean;
}
export interface CaseLayout {
  template: string;
  params: CaseParams;
  shape: 'rect' | 'round';
  /** Outline: rect [w, l, h]; round [d, d, base h] */
  outer: V3;
  /** Lid outline (front panel / spin body / lens bezel), for print size hints */
  lidSize: V3;
  /** Slots: part id → mounting key ('' when there's only one) → pose */
  slots: Record<string, Record<string, Pose>>;
  /** Chip (module shield top centre), for the ruler */
  chip: V3 | null;
  features: { bottom: string[]; lid: string[] };
  sizes: SizeInfo[];
  warnings: { id: string; text: string }[];
  /** Height: available / needed cavity (mm), and the minimum height with no height warning */
  inner: number;
  need: number;
  minHeight: number;
  /** Geometry parameters for the mesh builder */
  geo: Geo;
}
export type Geo =
  | { t: 'weather'; W: number; D: number; H: number; w: number; r: number; bx: number; by: number; bl: number; bw: number; sx: number; sy: number; vs: V3; ox: number; oy: number; ow: number; A: V3; tl: number; tw: number }
  | { t: 'spin'; R: number; Hb: number; w: number; Rb: number; z0: number; cylH: number; domeH: number; faceZ: number; vs: V3 }
  | { t: 'lens'; R: number; Hb: number; w: number; ledge: number; bez: number; vertical: boolean; bl: number; bw: number }
  | { t: 'usbkey'; W: number; D: number; H: number; w: number; r: number; bx: number; by: number; bl: number; bw: number; kx: number; ky: number[]; cap: number };

/** Common specs when the catalog has no size (l × w × h, mm; estimate) */
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
/** Servo shaft length above the lid; servo height minus this is the depth needed inside */
export const SHAFT_OUT = 4;
const STANDOFF = 3;
const PCB = 1.6;
const MODULE_H = 3.2;

export function partSize(id: string): SizeInfo {
  const p = PART_BY_ID[id];
  const s = p?.sizeMm;
  const fb = FALLBACK[id] ?? [20, 20, 5];
  if (s && s[2] !== null) return { part: id, name: t(p.name), size: [s[0], s[1], s[2]], est: false };
  if (s) return { part: id, name: t(p.name), size: [s[0], s[1], fb[2]], est: true };
  return { part: id, name: p?.name ? t(p.name) : id, size: fb, est: true };
}

export interface CaseSel {
  board: string;
  servo?: string;
  oled?: string;
  sensor?: string;
  lcd?: string;
}
/** Pick the case-relevant parts from the list (template defaults when missing) */
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

/** Flat dev board: PCB + module shield + USB-C + onboard LED, USB facing -y */
function boardPrims(cx: number, cy: number, z0: number, l: number, w: number, vertical = false): { prims: Prim[]; chip: V3 } {
  const long = l > 40;
  if (vertical) {
    // Vertical: long edge along z, PCB face toward -y
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
  // Servo hangs below zTop (lid inner face / base top plate) by its ears; the shaft pokes out SHAFT_OUT at sy
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
  if (template === 'usbkey') return usbkeyLayout(p, sel);
  return weatherLayout(p, sel);
}

// ------------------------------------------------------------------ Weather station: 50 × 70 box, front panel is the lid
function weatherLayout(p: CaseParams, sel: CaseSel): CaseLayout {
  const W = 50, D = 70, H = p.height, w = p.wall;
  const ix = W / 2 - w, iy = D / 2 - w;
  const sizes = [partSize(sel.board), partSize(sel.sensor ?? 'bme280'), partSize(sel.servo ?? 'sg90'), partSize(sel.oled ?? 'ssd1306')];
  const [bs, ss, vs, os] = sizes.map((x) => x.size);
  const warnings: CaseLayout['warnings'] = [];
  const lidZ = H - w;
  // Board against the left wall, USB down (-y); short boards go bottom-left
  const [bl, bw] = [bs[0], bs[1]];
  const bx = -ix + 0.5 + bw / 2;
  const by = bl > 2 * iy - 1 ? 0 : bl > 40 ? 0 : -iy + 0.5 + bl / 2;
  const B = boardPrims(bx, by, w + STANDOFF, bl, bw);
  if (bl > 2 * iy - 0.5 || bw > 2 * ix - 14) warnings.push({ id: 'board-fit', text: t("Board {l}×{w} mm doesn't fit the {il}×{iw} mm cavity (wall {wall} mm)", { l: bl, w: bw, il: r1(2 * ix), iw: r1(2 * iy), wall: w }) });
  // Servo between board and right wall, shaft at the dial centre, hung under the front panel
  const boardRight = bx + bw / 2;
  const sx = (boardRight + ix) / 2;
  const sy = Math.min(19, iy - 5.9 - 5 - 1);
  if (vs[1] + 1 > ix - boardRight) warnings.push({ id: 'servo-side', text: t('Only {room} mm right of the board; the {w} mm servo won\'t fit', { room: r1(ix - boardRight), w: vs[1] }) });
  const inner = H - 2 * w;
  const need = vs[2] - SHAFT_OUT;
  if (inner < need) warnings.push({ id: 'servo-height', text: t('Too short: cavity {inner} mm, the servo needs {need} mm ({h} mm tall, shaft out {out} mm) and will hit the bottom', { inner: r1(inner), need: r1(need), h: vs[2], out: SHAFT_OUT }) });
  const stack = STANDOFF + PCB + MODULE_H + 1;
  // OLED under the front panel, below the servo ears
  const [ol, ow, oh] = os;
  const ox = -2, oy = sy - (vs[0] - vs[1] / 2) - 5 - 0.5 - ow / 2;
  const oz = lidZ - 1 - oh / 2;
  if (oy - ow / 2 < -iy) warnings.push({ id: 'oled-fit', text: t("The {l}×{w} mm OLED module and the servo don't both fit under the front panel", { l: ol, w: ow }) });
  if (inner < stack + oh + 1) warnings.push({ id: 'oled-height', text: t('Too short: the OLED touches the board (cavity {inner} mm)', { inner: r1(inner) }) });
  // Sensor: A by the vents (right wall, on a post); B by the board (on the module shield)
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
      bottom: [t('4 board standoffs ({h} mm tall)', { h: STANDOFF }), t('USB-C cutout (back, under the board USB port)'), t('6 vent slots on the right + 3 BME280 vent holes in the floor'), t('BME280 post (by the vents)')],
      lid: [t('OLED window 22 × 11.5 mm'), t('Dial shaft hole Ø7 mm (aligned with the servo shaft)'), t('Light pipe hole Ø4 mm'), t('Servo clips, OLED pegs'), t('Lip (2 mm into the bottom shell)')],
    },
    sizes,
    warnings,
    inner,
    need: Math.max(need, stack + oh + 1),
    minHeight: r1(Math.max(need, stack + oh + 1) + 2 * w),
    geo: { t: 'weather', W, D, H, w, r: Math.min(p.radius, W / 2 - 1), bx, by, bl, bw, sx, sy, vs, ox, oy, ow, A, tl, tw },
  };
}

// ------------------------------------------------------------------ Spin: Ø60 base (servo bay) + body (lid)
function spinLayout(p: CaseParams, sel: CaseSel): CaseLayout {
  const R = 30, Hb = p.height, w = p.wall, TOTAL = 110;
  const sizes = [partSize(sel.board), partSize(sel.servo ?? 'sg90'), partSize(sel.lcd ?? 'gc9a01')];
  const [bs, vs, ls] = sizes.map((x) => x.size);
  const warnings: CaseLayout['warnings'] = [];
  const inner = Hb - 2 * w;
  const need = vs[2] - SHAFT_OUT;
  if (inner < need) warnings.push({ id: 'servo-height', text: t('Too short: base cavity {inner} mm, the servo needs {need} mm and will hit the bottom', { inner: r1(inner), need: r1(need) }) });
  if (vs[0] + 10 > 2 * (R - w) - 2) warnings.push({ id: 'servo-fit', text: t("The servo ({l} mm with ears) doesn't fit the Ø{d} mm base", { l: vs[0] + 10, d: r1(2 * (R - w)) }) });
  // Body sits above the base, on the horn
  const z0 = Hb + SHAFT_OUT + 1.6;
  const Rb = 27, bodyH = TOTAL - z0;
  // Body = cylinder + squashed dome (0.6 Rb tall); the vertical board must clear the dome
  const domeH = Rb * 0.6, cylH = bodyH - domeH;
  const [bl, bw] = [bs[0], bs[1]];
  const boardTop = z0 + 3.5 + bl, dz = boardTop - (z0 + cylH);
  const a = Rb - w, c = domeH - w;
  const availR = dz <= 0 ? a : dz >= c ? 0 : a * Math.sqrt(1 - (dz / c) ** 2);
  if (Math.hypot(bw / 2, PCB / 2 + MODULE_H) > availR - 0.5) warnings.push({ id: 'board-fit', text: t('Board {l}×{w} mm standing up hits the body dome (base {hb} mm is too tall, or use a shorter board)', { l: bl, w: bw, hb: Hb }) });
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
      bottom: [t('Servo bay (square hole in the top plate, ears rest on it)'), t('USB-C / power cable cutout (back)')],
      lid: [t('Round LCD window Ø34 mm ({d} mm module clips in from inside)', { d: ls[0] }), t('Horn seat + centre cable hole Ø6 mm'), t('Open bottom, fits over the horn')],
    },
    sizes,
    warnings,
    inner,
    need,
    minHeight: r1(need + 2 * w),
    geo: { t: 'spin', R, Hb, w, Rb, z0, cylH, domeH, faceZ, vs },
  };
}

// ------------------------------------------------------------------ Lens: Ø50 base + screen bezel (lid, two click positions)
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
    // Doesn't fit flat: stand it up if the cavity is tall enough
    if (inner - 1 >= bl + 3 && bw <= 2 * (R - w) - 4) vertical = true;
    else warnings.push({ id: 'board-fit', text: t("Board {l}×{w} mm doesn't fit flat in the Ø{d} mm base; standing up needs a base height ≥ {h} mm. Or use a smaller board (XIAO S3 21×17.8 mm).", { l: bl, w: bw, d: r1(2 * (R - w)), h: r1(bl + 3 + 1 + w + 4) }) });
    need = bl + 4;
  }
  if (flat && inner < stack) warnings.push({ id: 'board-height', text: t('Too short: only {inner} mm under the screen, the board needs {need} mm', { inner: r1(inner), need: r1(stack) }) });
  if (ls[0] > 2 * (R - w)) warnings.push({ id: 'lcd-fit', text: t('The Ø{d} mm round LCD module is wider than the base inside', { d: ls[0] }) });
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
      bottom: [vertical ? t('Vertical board slots') : t('4 board standoffs'), t('Round LCD ledge (4 mm below the top)'), t('USB-C cutout (back)')],
      lid: [t('Screen window Ø34 mm'), t('Two click positions: low on the screen / high 8 mm above (turn 45° to switch)')],
    },
    sizes,
    warnings,
    inner,
    need,
    minHeight: r1(need + w + 4),
    geo: { t: 'lens', R, Hb, w, ledge, bez, vertical, bl, bw },
  };
}

// ------------------------------------------------------------------ USB keypad: 44 × 80 box, a row of 4 keys on the plate (lid)
/** Keycap size (mm) and pitch (standard 19.05 mm) */
const KEYCAP = 14;
const KEY_PITCH = 19.05;
function usbkeyLayout(p: CaseParams, sel: CaseSel): CaseLayout {
  const W = 44, D = 80, H = p.height, w = p.wall;
  const ix = W / 2 - w, iy = D / 2 - w;
  const sizes = [partSize(sel.board), partSize('button')];
  const [bs, ks] = sizes.map((x) => x.size);
  const warnings: CaseLayout['warnings'] = [];
  const lidZ = H - w;
  const [bl, bw] = [bs[0], bs[1]];
  // Board flat along the long side against the left wall, USB to the back (-y) cutout; reversed (R) it faces the front wall
  const bx = -ix + 0.5 + bw / 2;
  const by = -iy + 0.5 + bl / 2;
  if (bl > 2 * iy - 1 || bw > 2 * ix - 1) warnings.push({ id: 'board-fit', text: t("Board {l}×{w} mm doesn't fit the {il}×{iw} mm cavity (wall {wall} mm)", { l: bl, w: bw, il: r1(2 * ix), iw: r1(2 * iy), wall: w }) });
  const B = boardPrims(bx, by, w + STANDOFF, bl, bw);
  const flip = (pr: Prim[]): Prim[] => pr.map((x) => ({ ...x, at: [x.at[0], 2 * by - x.at[1], x.at[2]] as V3 }));
  // Keys: a row of 4 hanging under the plate (switch body 3.4 mm), caps above it
  const kx = ix - KEYCAP / 2 - 1.5;
  const ky = [-1.5, -0.5, 0.5, 1.5].map((k) => k * KEY_PITCH);
  const swH = ks[2];
  const inner = H - 2 * w;
  const stack = STANDOFF + PCB + MODULE_H + 1;
  // Keys beside the board need only the switch height; keys above the board add the board stack
  const overBoard = kx - KEYCAP / 2 < bx + bw / 2;
  const need = overBoard ? stack + swH : swH + 1;
  if (inner < need) warnings.push({ id: 'key-height', text: overBoard ? t('Too short: cavity {inner} mm, {sw} mm keys above the board need {need} mm', { inner: r1(inner), sw: swH, need: r1(need) }) : t('Too short: cavity {inner} mm, {sw} mm keys need {need} mm', { inner: r1(inner), sw: swH, need: r1(need) }) });
  const sw = (y: number): Prim => box([kx, y, lidZ - swH / 2], [6, 6, swH], '#1B1D21');
  const capPrim = (y: number, i: number): Prim => box([kx, y, H + 3], [KEYCAP, KEYCAP, 6], i === 3 ? '#0D99FF' : '#F2EFE8');
  return {
    template: 'usbkey',
    params: p,
    shape: 'rect',
    outer: [W, D, H],
    lidSize: [W, D, w + 2],
    slots: {
      base: { '': pose([], 'bottom', { min: [-W / 2, -D / 2, 0], max: [W / 2, D / 2, lidZ] }) },
      board: { U: pose(B.prims), R: pose(flip(B.prims)) },
      keys: { '': pose(ky.map(sw)) },
      plate: { '': pose([], 'lid', { min: [-W / 2, -D / 2, lidZ - 2], max: [W / 2, D / 2, H] }) },
      caps: { '': pose(ky.map(capPrim)) },
    },
    chip: B.chip,
    features: {
      bottom: [t('4 board standoffs ({h} mm tall)', { h: STANDOFF }), t('USB-C cutout (back, aligned with the board USB / OTG port)')],
      lid: [t('4 key holes {s} × {s} mm (pitch {p} mm)', { s: KEYCAP + 0.4, p: KEY_PITCH }), t('Lip (2 mm into the bottom shell)')],
    },
    sizes,
    warnings,
    inner,
    need,
    minHeight: r1(need + 2 * w),
    geo: { t: 'usbkey', W, D, H, w, r: Math.min(p.radius, W / 2 - 1), bx, by, bl, bw, kx, ky, cap: KEYCAP },
  };
}

// ================================================================== Meshes (Manifold)
export interface MeshData {
  pos: Float32Array;
  idx: Uint32Array;
}
export interface CaseMeshes {
  bottom: MeshData;
  lid: MeshData;
  /** Bottom / lid volume (mm³), for print quotes and tests */
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

/** Booleans: every intermediate must be deleted (wasm objects aren't GC'd) */
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
      // Vent slots (right wall) + floor vent holes (under the BME280)
      for (let i = 0; i < 6; i++) holes.push(cube([w * 3, 1.6, Math.max(4, lidZ - w - 8)], [W / 2, A[1] - 6 + i * 2.4, w + (lidZ - w) / 2]));
      for (let i = -1; i <= 1; i++) holes.push(cylZ(2, w * 3, [A[0] + i * 3.5, A[1] + tw / 2 + 2, w / 2], 16));
      // USB-C cutout in the back (floor), under the board USB port
      holes.push(cube([11, 5, w * 3], [bx, by - bl / 2 + 3.5, w / 2]));
      bottom = sub(union([k(outer.subtract(cavity)), ...posts]), holes);
      // Front panel: plate + lip + servo clips + OLED pegs, minus OLED window / shaft hole / light pipe hole
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
    } else if (g.t === 'usbkey') {
      const { W, D, H, w, r, bx, by, bl, bw, kx, ky, cap } = g;
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
      // USB-C cutout in the back wall, aligned with the board USB port
      holes.push(cube([11, w * 3, 6], [bx, -D / 2 + w / 2, w + STANDOFF + PCB + 1.6]));
      bottom = sub(union([k(outer.subtract(cavity)), ...posts]), holes);
      const plate = k(k(rrect(W, D, r).extrude(w)).translate([0, 0, lidZ]));
      const lipO = rrect(W - 2 * w - 0.6, D - 2 * w - 0.6, Math.max(0.5, r - w - 0.3));
      const lipI = rrect(W - 2 * w - 3, D - 2 * w - 3, Math.max(0.3, r - w - 1.5));
      const lip = k(k(k(lipO.subtract(lipI)).extrude(2)).translate([0, 0, lidZ - 2]));
      lid = sub(union([plate, lip]), ky.map((y) => cube([cap + 0.4, cap + 0.4, w * 4], [kx, y, lidZ + w / 2])));
    } else if (g.t === 'spin') {
      const { R, Hb, w, Rb, z0, cylH, domeH, faceZ, vs } = g;
      const outer = cylZ(2 * R, Hb, [0, 0, Hb / 2], 96);
      const inner = cylZ(2 * (R - w), Hb - 2 * w, [0, 0, Hb / 2], 96);
      const servoCy = -(vs[0] / 2 - vs[1] / 2);
      bottom = sub(outer, [inner, cube([vs[1] + 0.6, vs[0] + 0.6, w * 3], [0, servoCy, Hb - w / 2]), cube([12, w * 3, 6], [0, R - w / 2, w + 5]), cylZ(6, w * 3, [0, 12, Hb - w / 2], 24)]);
      // Body: cylinder + squashed dome, wall w, open bottom (inner extends 0.5 mm down to cut through)
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
      // Standoffs only if it fits flat, slots if vertical, nothing if neither (posts would poke out of the shell)
      if (vertical) for (const dx of [-1, 1]) adds.push(cube([2, 6, 6], [dx * (bl.bw / 2 + 1), 6, w + 3]));
      else if (Math.hypot(bl.bl / 2, bl.bw / 2) <= R - w - 0.5) for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) adds.push(cylZ(4.5, STANDOFF, [dx * (bl.bw / 2 - 2.5), dy * (bl.bl / 2 - 2.5), w + STANDOFF / 2], 20));
      bottom = sub(union([k(outer.subtract(inner)), ...adds]), [cube([12, w * 3, 6], [0, R - w / 2, w + 6])]);
      // Bezel: tube + rim (holds the screen) + two click tabs (low on the rim, high at 8 mm, offset 45°)
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
        /* already freed */
      }
    }
  }
}

/** Print layout: bottom as is (floor on the bed), lid flipped onto the bed and moved aside */
export function printLayout(L: CaseLayout, m: CaseMeshes): { name: string; mesh: MeshData }[] {
  const flip = (d: MeshData, dx: number): MeshData => {
    let zmax = -Infinity;
    for (let i = 2; i < d.pos.length; i += 3) zmax = Math.max(zmax, d.pos[i]);
    const pos = new Float32Array(d.pos.length);
    for (let i = 0; i < d.pos.length; i += 3) {
      // 180° about x: (x, y, z) → (x, -y, zmax - z), winding unchanged
      pos[i] = d.pos[i] + dx;
      pos[i + 1] = -d.pos[i + 1];
      pos[i + 2] = zmax - d.pos[i + 2];
    }
    return { pos, idx: d.idx };
  };
  const gap = L.outer[0] / 2 + L.lidSize[0] / 2 + 10;
  const names: Record<string, [string, string]> = { weather: [t('Back shell'), t('Front panel')], spin: [t('Base'), t('Body')], lens: [t('Base'), t('Screen bezel')], usbkey: [t('Bottom shell'), t('Key plate')] };
  const [a, b] = names[L.template] ?? [t('Bottom shell'), t('Lid')];
  // The spin body has a dome that would overhang upside down: print it upright (open end on the bed)
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
