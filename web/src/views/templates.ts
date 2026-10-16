// 装配模板：零件（从下到上）、可选的装法、装配检查（估算）、装法对成品的影响、成品视图。
// "影响"里能进模拟器的（传感器温度）就进模拟器；纯几何 / 光学的（舵盘偏角、透镜放大）只改成品画面，并标明估算。
import type { LiveFrame } from './common';
import { createProductView, type ProductHandlers } from './product';
import { createLensProduct, createSpinProduct } from './lcdproducts';
import { createKeypadView } from './keypad';

export interface Spot {
  key: string;
  /** 选择按钮上的字 */
  label: string;
  /** 在该层局部坐标里的位置（零件左上角）；只有"放的位置不同"的选择才有 */
  at?: [number, number];
  ok: boolean;
  msg: [string, string];
}
export interface Part {
  id: string;
  name: string;
  short: string;
  /** 零件盘里的平面图（100×60） */
  mini: string;
  /** 装好后的样子（该层 180×100 局部坐标；有 at 的选择则以零件左上角为原点） */
  iso: string;
  /** 落位虚线框 [x, y, w, h]（有 at 的选择用 spotSize） */
  ghost?: number[];
  spotSize?: [number, number];
  spots?: Spot[];
  okMsg?: [string, string];
}
export interface Effects {
  sensorOffset?: number;
  hornOffset?: number;
  lensScale?: number;
  /** 线束（P2-11，估算）：I2C 排线总长（只有带 I2C 模块的作品）、天线遮挡（dB）；进模拟器 */
  i2cWireCm?: number;
  antennaDb?: number;
  /** USB 口装反、被外壳挡住（usbkey）：插不了线，虚拟电脑看不到设备 */
  usbBlocked?: boolean;
}
export interface Picked {
  placed: string[];
  choice: Record<string, string>;
}
export interface Template {
  id: string;
  caption: string;
  parts: Part[];
  tray: string[];
  intro: [string, string];
  checks(s: Picked): { label: string; ok: boolean | null; text: string }[];
  effects(s: Picked): Effects;
  product(el: HTMLElement, h: ProductHandlers, opts: { servoPin: number }): { update(f: LiveFrame, room: number, fx: Effects): void };
}

const has = (s: Picked, k: string) => s.placed.includes(k);
const row = (label: string, done: boolean, ok: boolean, good: string, bad = '') => ({ label, ok: done ? ok : null, text: done ? (ok ? '✓ ' + good : '! ' + bad) : '—' });

/** 传感器贴着芯片时比室温高多少（估算：ESP32-S3 满载壳内温升的量级，未经真机标定） */
export const CHIP_HEAT_OFFSET = 2.5;
/** SG90 输出轴 25 齿：舵盘错一个齿就是 14.4° */
export const SPLINE_TOOTH = 360 / 25;

const SHELL_ISO = '<rect width="180" height="100" rx="10" fill="#E9E5DC" stroke="#8A867E" stroke-width="1.5"/><rect x="8" y="8" width="164" height="84" rx="6" fill="#D6D1C6"/><rect y="40" width="10" height="20" fill="#3A3936"/>';
const BOARD_ISO = '<rect x="20" y="20" width="120" height="60" rx="3" fill="#141414"/><rect x="74" y="28" width="56" height="44" rx="2" fill="#BDB9B0"/><rect x="14" y="40" width="10" height="18" fill="#8A867E"/><circle cx="50" cy="32" r="4" fill="#22C55E"/>';
const BOARD_MINI = '<rect x="2" y="10" width="96" height="40" rx="3" fill="#141414"/><rect x="50" y="15" width="42" height="30" rx="2" fill="#BDB9B0"/><rect y="22" width="8" height="14" fill="#8A867E"/><circle cx="22" cy="18" r="3.5" fill="#22C55E"/>';
const SERVO_MINI = '<rect x="20" y="16" width="60" height="30" rx="3" fill="#2B5FD9"/><rect x="12" y="24" width="76" height="6" rx="2" fill="#2B5FD9"/><circle cx="36" cy="16" r="8" fill="#F7F6F3"/><path d="M36 16 L60 6" stroke="#F7F6F3" stroke-width="4" stroke-linecap="round"/>';
const LCD_MINI = '<circle cx="50" cy="30" r="28" fill="#1A1A19"/><circle cx="50" cy="30" r="22" fill="#06070A"/><rect x="38" y="22" width="8" height="14" rx="4" fill="#7CF5FF"/><rect x="54" y="22" width="8" height="14" rx="4" fill="#7CF5FF"/>';
const LCD_ISO = '<circle cx="90" cy="50" r="36" fill="#1A1A19"/><circle cx="90" cy="50" r="28" fill="#06070A"/><rect x="76" y="40" width="9" height="18" rx="4" fill="#7CF5FF"/><rect x="95" y="40" width="9" height="18" rx="4" fill="#7CF5FF"/>';

export const WEATHER: Template = {
  id: 'weather',
  caption: 'weather · 外壳 70×50×32 mm（估算）',
  intro: ['把零件拖进壳里', '从最底下那层开始'],
  tray: ['servo', 'shell', 'oled', 'bme', 'front', 'board'],
  parts: [
    { id: 'shell', name: '后壳', short: '后壳', ghost: [0, 0, 180, 100], okMsg: ['后壳就位', 'USB-C 开孔朝后'],
      mini: '<rect width="100" height="60" rx="8" fill="#E9E5DC" stroke="#8A867E" stroke-width="1.5"/><rect x="6" y="6" width="88" height="48" rx="5" fill="#D6D1C6"/><path d="M86 18 L92 18 M86 26 L92 26 M86 34 L92 34 M86 42 L92 42" stroke="#8A867E" stroke-width="2"/><rect y="24" width="6" height="12" fill="#3A3936"/>',
      iso: SHELL_ISO + '<path d="M160 30 L172 30 M160 40 L172 40 M160 50 L172 50 M160 60 L172 60 M160 70 L172 70" stroke="#8A867E" stroke-width="2.5"/>' },
    { id: 'board', name: 'ESP32-S3 开发板', short: '开发板', ghost: [20, 20, 120, 60], okMsg: ['开发板卡进卡扣', 'GPIO4→舵机 · SDA/SCL→屏和传感器'], mini: BOARD_MINI, iso: BOARD_ISO },
    { id: 'bme', name: 'BME280', short: 'BME280', spotSize: [36, 30],
      mini: '<rect x="32" y="12" width="36" height="34" rx="3" fill="#6A3FA0"/><rect x="44" y="22" width="12" height="12" fill="#C9C6BF"/><path d="M38 46 L38 54 M46 46 L46 54 M54 46 L54 54 M62 46 L62 54" stroke="#E8C547" stroke-width="2"/>',
      iso: '<rect width="36" height="30" rx="2" fill="#6A3FA0"/><rect x="12" y="9" width="12" height="12" fill="#C9C6BF"/>',
      spots: [
        { key: 'A', label: '放通风口旁', at: [128, 40], ok: true, msg: ['传感器靠着通风口', '读到的就是室温'] },
        { key: 'B', label: '放开发板旁', at: [74, 28], ok: false, msg: ['传感器贴着芯片', `芯片发热，读数会偏高约 ${CHIP_HEAT_OFFSET} ℃`] },
      ] },
    { id: 'servo', name: 'SG90 舵机', short: '舵机', ghost: [56, 14, 56, 30], okMsg: ['舵机轴对准表盘中心', '指针从 0 ℃ 扫到 40 ℃'], mini: SERVO_MINI,
      iso: '<rect x="56" y="14" width="56" height="30" rx="3" fill="#2B5FD9"/><rect x="74" y="4" width="10" height="10" fill="#F7F6F3"/>' },
    { id: 'oled', name: 'OLED 0.96″', short: 'OLED', ghost: [50, 52, 80, 40], okMsg: ['屏幕排线 8 cm', '从开发板够得到前面板'],
      mini: '<rect x="12" y="4" width="76" height="52" rx="3" fill="#1C4F86"/><rect x="18" y="12" width="64" height="34" fill="#050608"/><path d="M26 24 L46 24 M26 32 L60 32" stroke="#D7F3FF" stroke-width="3"/>',
      iso: '<rect x="50" y="52" width="80" height="40" rx="3" fill="#1C4F86"/><rect x="56" y="58" width="68" height="28" fill="#050608"/>' },
    { id: 'front', name: '前面板', short: '前面板', ghost: [0, 0, 180, 100], okMsg: ['合上了', '点「开机看成品」'],
      mini: '<rect width="100" height="60" rx="8" fill="#F2EFE8" stroke="#8A867E" stroke-width="1.5"/><path d="M28 28 A22 22 0 0 1 72 28" fill="none" stroke="#141414" stroke-width="2"/><rect x="32" y="34" width="36" height="16" rx="2" fill="none" stroke="#141414" stroke-width="2"/>',
      iso: '<rect width="180" height="100" rx="10" fill="#F2EFE8" stroke="#8A867E" stroke-width="1.5" opacity="0.7"/><path d="M50 46 A40 40 0 0 1 130 46" fill="none" stroke="#141414" stroke-width="2"/><rect x="56" y="58" width="68" height="28" rx="3" fill="none" stroke="#141414" stroke-width="2"/>' },
  ],
  checks: (s) => [
    row('传感器位置', has(s, 'bme'), s.choice.bme === 'A', '通风口旁，读数准', `贴着芯片，偏高约 ${CHIP_HEAT_OFFSET} ℃`),
    row('屏幕排线', has(s, 'oled'), true, '8 cm，需要 ≥ 6 cm'),
    row('舵机轴心', has(s, 'servo'), true, '对准表盘中心'),
    row('内腔高度', has(s, 'front'), true, '用了 27 / 32 mm'),
  ],
  effects: (s) => ({ sensorOffset: s.choice.bme === 'B' ? CHIP_HEAT_OFFSET : 0 }),
  product: (el, h, o) => {
    const p = createProductView(el, h, o);
    return { update: (f, room, fx) => p.update(f, room, fx.sensorOffset ?? 0) };
  },
};

export const SPIN: Template = {
  id: 'spin',
  caption: 'spin · 底座 Ø60 mm，身高 110 mm（估算）',
  intro: ['把小黄装起来', '从底座开始'],
  tray: ['lcd', 'base', 'hair', 'servo', 'body', 'board'],
  parts: [
    { id: 'base', name: '转台底座', short: '底座', ghost: [0, 0, 180, 100], okMsg: ['底座就位', '舵机仓朝上'],
      mini: '<ellipse cx="50" cy="34" rx="46" ry="22" fill="#2A2A28"/><ellipse cx="50" cy="28" rx="46" ry="22" fill="#3A3936"/><rect x="34" y="20" width="32" height="16" rx="2" fill="#141414"/>',
      iso: '<rect width="180" height="100" rx="40" fill="#3A3936" stroke="#141414" stroke-width="1.5"/><rect x="62" y="32" width="56" height="36" rx="3" fill="#141414"/>' },
    { id: 'servo', name: 'SG90 舵机', short: '舵机', ghost: [62, 32, 56, 36], mini: SERVO_MINI,
      iso: '<rect x="62" y="32" width="56" height="36" rx="3" fill="#2B5FD9"/><circle cx="90" cy="50" r="10" fill="#F7F6F3"/>',
      spots: [
        { key: 'C', label: '先回中位再装舵盘', ok: true, msg: ['舵机先转到 90°', '再装舵盘：正面就是正面'] },
        { key: 'X', label: '直接把舵盘按上去', ok: false, msg: ['舵盘错了一个齿', `正面会偏 ${SPLINE_TOOTH.toFixed(1)}°`] },
      ] },
    { id: 'board', name: 'ESP32-S3 开发板', short: '开发板', ghost: [20, 20, 120, 60], okMsg: ['开发板装进身体', 'GPIO4→舵机 · SPI→圆屏'], mini: BOARD_MINI, iso: BOARD_ISO },
    { id: 'lcd', name: '圆屏 GC9A01', short: '圆屏', ghost: [54, 14, 72, 72], okMsg: ['圆屏装在脸的位置', '排线穿过转轴中心孔'], mini: LCD_MINI, iso: LCD_ISO },
    { id: 'body', name: '身体外壳', short: '身体', ghost: [0, 0, 180, 100], okMsg: ['身体扣上了', '腰带盖住螺丝'],
      mini: '<rect x="22" y="2" width="56" height="56" rx="26" fill="#FFC933" stroke="#141414" stroke-width="2"/><rect x="22" y="40" width="56" height="6" fill="#2F2A57"/><circle cx="50" cy="22" r="11" fill="#141414"/>',
      iso: '<rect width="180" height="100" rx="46" fill="#FFC933" stroke="#141414" stroke-width="1.5" opacity="0.75"/><circle cx="90" cy="50" r="36" fill="none" stroke="#141414" stroke-width="2"/>' },
    { id: 'hair', name: '头顶卷毛', short: '卷毛', ghost: [70, 30, 40, 40], okMsg: ['装好了', '点「开机看成品」'],
      mini: '<path d="M44 52 C30 30 44 8 62 14 C76 20 72 40 58 38" fill="none" stroke="#141414" stroke-width="5" stroke-linecap="round"/>',
      iso: '<path d="M80 60 C66 40 80 22 98 28 C112 34 108 52 94 50" fill="none" stroke="#141414" stroke-width="5" stroke-linecap="round"/>' },
  ],
  checks: (s) => [
    row('舵盘中位', has(s, 'servo'), s.choice.servo === 'C', '正面对准', `偏了 ${SPLINE_TOOTH.toFixed(1)}°（一个齿）`),
    row('圆屏排线', has(s, 'lcd'), true, '经转轴中心孔，±60° 有余量'),
    row('重心', has(s, 'body'), true, '在转轴上方，SG90 带得动'),
    row('总高', has(s, 'hair'), true, '110 mm'),
  ],
  effects: (s) => ({ hornOffset: s.choice.servo === 'X' ? SPLINE_TOOTH : 0 }),
  product: (el, h, o) => createSpinProduct(el, h, o),
};

export const LENS: Template = {
  id: 'lens',
  caption: 'lens · 底座 Ø50 mm，透镜 Ø40 mm（估算）',
  intro: ['把透镜小人装起来', '从底座开始'],
  tray: ['dome', 'board', 'bezel', 'base', 'lcd'],
  parts: [
    { id: 'base', name: '底座', short: '底座', ghost: [0, 0, 180, 100], okMsg: ['底座就位', 'USB-C 朝后'],
      mini: '<rect x="4" y="18" width="92" height="30" rx="14" fill="#EDEAE2" stroke="#BDB9B0" stroke-width="1.5"/>',
      iso: '<rect width="180" height="100" rx="30" fill="#EDEAE2" stroke="#BDB9B0" stroke-width="1.5"/>' },
    { id: 'board', name: 'ESP32-S3 开发板', short: '开发板', ghost: [20, 20, 120, 60], okMsg: ['开发板放进底座', 'SPI 排线朝上'], mini: BOARD_MINI, iso: BOARD_ISO },
    { id: 'lcd', name: '圆屏 GC9A01', short: '圆屏', ghost: [54, 14, 72, 72], okMsg: ['圆屏卡进支架', '屏幕朝上'], mini: LCD_MINI, iso: LCD_ISO },
    { id: 'bezel', name: '屏幕外框', short: '外框', ghost: [46, 6, 88, 88], okMsg: ['外框压住屏幕', '框上有两档卡槽'],
      mini: '<circle cx="50" cy="30" r="27" fill="none" stroke="#BDB9B0" stroke-width="7"/>',
      iso: '<circle cx="90" cy="50" r="40" fill="none" stroke="#D6D1C6" stroke-width="8"/>' },
    { id: 'dome', name: '凸透镜罩', short: '透镜罩', ghost: [46, 6, 88, 88],
      mini: '<circle cx="50" cy="30" r="26" fill="#BFD3E6" fill-opacity="0.5" stroke="#8A9BAD" stroke-width="2"/><path d="M34 20 A20 20 0 0 1 48 10" fill="none" stroke="#FFF" stroke-width="3"/>',
      iso: '<circle cx="90" cy="50" r="40" fill="#BFD3E6" fill-opacity="0.45" stroke="#8A9BAD" stroke-width="2"/>',
      spots: [
        { key: 'H', label: '卡在高档（离屏 8 mm）', ok: true, msg: ['透镜离屏幕 8 mm', '放大约 1.35×，像立体的'] },
        { key: 'N', label: '卡在低档（贴着屏）', ok: false, msg: ['透镜贴着屏幕', '几乎不放大，看着是平的'] },
      ] },
  ],
  checks: (s) => [
    row('透镜高度', has(s, 'dome'), s.choice.dome === 'H', '离屏 8 mm，放大约 1.35×', '贴着屏，放大约 1.08×'),
    row('屏幕排线', has(s, 'lcd'), true, '10 cm，够到开发板'),
    row('外框卡扣', has(s, 'bezel'), true, '4 个卡扣到位'),
    row('总高', has(s, 'dome'), true, '62 mm'),
  ],
  effects: (s) => ({ lensScale: s.choice.dome === 'N' ? 1.08 : 1.35 }),
  product: (el, h) => createLensProduct(el, h),
};

const KEYS_ISO = [0, 1, 2, 3].map((i) => `<rect x="${36 + i * 30}" y="38" width="20" height="20" rx="3" fill="#1B1D21"/>`).join('');
const CAPS_ISO = [0, 1, 2, 3].map((i) => `<rect x="${32 + i * 30}" y="34" width="28" height="28" rx="5" fill="${i === 3 ? '#0D99FF' : '#F2EFE8'}" stroke="#141414" stroke-width="1.5"/>`).join('');

export const USBKEY: Template = {
  id: 'usbkey',
  caption: 'usbkey · 外壳 80×44×22 mm（估算）',
  intro: ['把小键盘装起来', '从底壳开始'],
  tray: ['caps', 'board', 'plate', 'base', 'keys'],
  parts: [
    { id: 'base', name: '底壳', short: '底壳', ghost: [0, 0, 180, 100], okMsg: ['底壳就位', '背面有 USB-C 开孔'],
      mini: '<rect width="100" height="60" rx="8" fill="#E9E5DC" stroke="#8A867E" stroke-width="1.5"/><rect x="6" y="6" width="88" height="48" rx="5" fill="#D6D1C6"/><rect x="0" y="22" width="6" height="14" fill="#3A3936"/>',
      iso: SHELL_ISO },
    { id: 'board', name: 'ESP32-S3 开发板', short: '开发板', ghost: [20, 20, 120, 60], mini: BOARD_MINI, iso: BOARD_ISO,
      spots: [
        { key: 'U', label: 'USB / OTG 口朝背面开孔', ok: true, msg: ['USB 口对准开孔', '线插得进去，电脑认得到键盘'] },
        { key: 'R', label: '转了 180° 装（USB 口朝前）', ok: false, msg: ['USB 口顶着前墙', '线插不进去，电脑看不到设备'] },
      ] },
    { id: 'keys', name: '轻触按键 × 4', short: '按键', ghost: [30, 32, 120, 32], okMsg: ['按键卡进定位板下面', 'K1–K4 = GPIO4–7，另一端接地'],
      mini: '<rect x="4" y="18" width="92" height="24" rx="3" fill="#2A2A28"/>' + [0, 1, 2, 3].map((i) => `<rect x="${10 + i * 22}" y="22" width="16" height="16" rx="2" fill="#1B1D21" stroke="#555"/>`).join(''),
      iso: KEYS_ISO },
    { id: 'plate', name: '定位板', short: '定位板', ghost: [0, 0, 180, 100], okMsg: ['定位板盖上', '4 个键孔对准按键'],
      mini: '<rect width="100" height="60" rx="8" fill="#F2EFE8" stroke="#8A867E" stroke-width="1.5"/>' + [0, 1, 2, 3].map((i) => `<rect x="${12 + i * 21}" y="22" width="14" height="14" fill="#8A867E"/>`).join(''),
      iso: '<rect width="180" height="100" rx="10" fill="#F2EFE8" stroke="#8A867E" stroke-width="1.5" opacity="0.7"/>' + [0, 1, 2, 3].map((i) => `<rect x="${34 + i * 30}" y="36" width="24" height="24" fill="#3A3936"/>`).join('') },
    { id: 'caps', name: '键帽 × 4', short: '键帽', ghost: [30, 32, 120, 32], okMsg: ['键帽按上了', '点「开机看成品」'],
      mini: [0, 1, 2, 3].map((i) => `<rect x="${6 + i * 23}" y="16" width="20" height="20" rx="4" fill="${i === 3 ? '#0D99FF' : '#F2EFE8'}" stroke="#141414"/>`).join(''),
      iso: CAPS_ISO },
  ],
  checks: (s) => [
    row('USB 口朝向', has(s, 'board'), s.choice.board === 'U', '对准背面开孔', '朝前，线插不进去'),
    row('按键行程', has(s, 'caps'), true, '键帽离定位板 1.5 mm，按得到底'),
    row('内腔高度', has(s, 'plate'), true, '按键 + 开发板用了 14 / 18 mm'),
  ],
  effects: (s) => ({ usbBlocked: s.choice.board === 'R' }),
  product: (el, h) => {
    const v = createKeypadView(el, { press: (pin, d) => h.press?.(pin, d) });
    return { update: () => {}, setUsb: v.setUsb };
  },
};

export const TEMPLATES: Record<string, Template> = { weather: WEATHER, spin: SPIN, lens: LENS, usbkey: USBKEY };
