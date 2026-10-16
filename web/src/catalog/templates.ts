// 采购模版：每个作品要买什么（必选不可去 / 建议可增减）、买完怎么摆上实验台（默认接线）。
// 接线与 firmware/examples.json 里同名示例的 scene 一致（catalog.test.ts 对拍），
// 引脚与 firmware/levels.json 第 06 关 / 第 07 关 spin、lens 的任务书一致。
import { getPart, type LcdPins, type Part } from './parts.ts';

/** 选中的一件：key 区分同型号多件（缺省用 partId） */
export interface Pick {
  partId: string;
  key?: string;
  qty?: number;
  /** 选用的 I2C 地址（改跳线后），缺省用元件库的 default */
  addr?: number;
}

/**
 * 一根线：零件的某个针脚接到哪个网络。
 * 网络名：'GPIOn'（开发板引脚）、'3V3'、'5V'（板上 5V / VBUS）、'GND'、'EXT5V'（外接 5 V 电源轨）、'EXT3V3'。
 * via：中间经过的器件（分压、电平转换、三极管），规则据此放行。
 */
export interface Wire {
  part: string;
  pin: string;
  net: string;
  via?: 'divider' | 'level-shifter' | 'transistor';
}

export interface FirmwareUse {
  /** 固件是否开 Wi-Fi（R12、R20、R21） */
  wifi?: boolean;
  /** 固件把哪个 GPIO 当板载彩灯（R23） */
  rgbGpio?: number;
  /** 固件要用 PSRAM（大帧缓冲、摄像头、音频；R30） */
  psram?: boolean;
  /** 固件按哪套引脚驱动板载屏（R32：微雪圆屏触摸版 / 无触摸版不同） */
  lcdPins?: LcdPins;
}

export interface BuyLine {
  partId: string;
  qty: number;
  why: string;
}

export interface ProcureTemplate {
  id: 'weather' | 'spin' | 'lens' | 'lamp' | 'ruler' | 'tilt' | 'blank';
  title: string;
  /** 对应关卡（firmware/levels.json id，07 关的变体写 07:spin） */
  level: string | null;
  /** 对应示例 / 成品 id（firmware/examples.json、views/templates.ts） */
  product: string | null;
  board: string;
  required: BuyLine[];
  /** checked：默认勾选与否 */
  suggested: (BuyLine & { checked: boolean })[];
  wiring: Wire[];
  firmware: FirmwareUse;
}

const GC9A01_WIRING: Wire[] = [
  { part: 'gc9a01', pin: 'VCC', net: '3V3' },
  { part: 'gc9a01', pin: 'GND', net: 'GND' },
  { part: 'gc9a01', pin: 'SCL', net: 'GPIO12' },
  { part: 'gc9a01', pin: 'SDA', net: 'GPIO11' },
  { part: 'gc9a01', pin: 'CS', net: 'GPIO10' },
  { part: 'gc9a01', pin: 'DC', net: 'GPIO14' },
  { part: 'gc9a01', pin: 'RES', net: 'GPIO13' },
  { part: 'gc9a01', pin: 'BLK', net: 'GPIO15' },
];
const SERVO_EXT_WIRING: Wire[] = [
  { part: 'sg90', pin: '棕 GND', net: 'GND' },
  { part: 'sg90', pin: '红 VCC', net: 'EXT5V' },
  { part: 'sg90', pin: '橙 PWM', net: 'GPIO4' },
  { part: 'dc-jack', pin: '+', net: 'EXT5V' },
  { part: 'dc-jack', pin: '-', net: 'GND' },
];
const SERVO: BuyLine = { partId: 'sg90', qty: 1, why: '表盘 / 转身用的舵机' };
// 舵机电源放建议件（默认勾选）：去掉后由 R27 / R20 当场说后果（只靠 USB 会掉压复位），
// 实验台也照"只有 USB"摆，给欠压演示留口子（docs/DECISIONS.md 2026-10-16 采购页）
const SERVO_SUPPLY: (BuyLine & { checked: boolean })[] = [
  { partId: 'psu-5v2a', qty: 1, checked: true, why: '舵机单独供电：从电脑 USB 取电启动瞬间会掉压复位' },
  { partId: 'dc-jack', qty: 1, checked: true, why: '电源插头转面包板' },
];
const CABLE: BuyLine = { partId: 'usb-c-cable', qty: 1, why: '烧录和看串口，要能传数据的线' };

export const PROCURE_TEMPLATES: ProcureTemplate[] = [
  {
    id: 'weather',
    title: '桌面气象站',
    level: '06',
    product: 'weather',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: '固件和 3D 板都按 v1.0（彩灯 GPIO48）' },
      { partId: 'bme280', qty: 1, why: '温度 / 湿度 / 气压' },
      { partId: 'ssd1306', qty: 1, why: '显示读数' },
      SERVO,
      CABLE,
      { partId: 'dupont-mf', qty: 1, why: '模块排针接面包板' },
      { partId: 'enclosure-weather', qty: 1, why: '装壳关（第 06 关）' },
    ],
    suggested: [
      ...SERVO_SUPPLY,
      { partId: 'breadboard-830', qty: 1, checked: true, why: '先在面包板上搭通再装壳' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: '面包板上跳线' },
      { partId: 'buzzer-module', qty: 1, checked: true, why: '温度超限蜂鸣报警（固件 GPIO5，成品页能听到）' },
      { partId: 'dupont-ff', qty: 1, checked: false, why: '装进外壳时直接连排针' },
      { partId: 'cap-1000uf', qty: 1, checked: false, why: '舵机电源两端稳压' },
    ],
    wiring: [
      { part: 'ssd1306', pin: 'GND', net: 'GND' },
      { part: 'ssd1306', pin: 'VCC', net: '3V3' },
      { part: 'ssd1306', pin: 'SCL', net: 'GPIO9' },
      { part: 'ssd1306', pin: 'SDA', net: 'GPIO8' },
      { part: 'bme280', pin: 'VCC', net: '3V3' },
      { part: 'bme280', pin: 'GND', net: 'GND' },
      { part: 'bme280', pin: 'SCL', net: 'GPIO9' },
      { part: 'bme280', pin: 'SDA', net: 'GPIO8' },
      ...SERVO_EXT_WIRING,
      { part: 'buzzer-module', pin: 'VCC', net: '3V3' },
      { part: 'buzzer-module', pin: 'I/O', net: 'GPIO5' },
      { part: 'buzzer-module', pin: 'GND', net: 'GND' },
    ],
    firmware: { wifi: false, rgbGpio: 48 },
  },
  {
    id: 'spin',
    title: '会转身的小黄',
    level: '07:spin',
    product: 'spin',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: '验收固件按 S3' },
      { partId: 'gc9a01', qty: 1, why: '圆屏脸' },
      SERVO,
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: '圆屏排针直接连开发板' },
      { partId: 'enclosure-spin', qty: 1, why: '身体 + 转台底座' },
    ],
    suggested: [
      ...SERVO_SUPPLY,
      { partId: 'breadboard-830', qty: 1, checked: true, why: '先搭通再装壳' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: '面包板上跳线' },
      { partId: 'cap-1000uf', qty: 1, checked: false, why: '舵机电源两端稳压' },
      { partId: 'mg90s', qty: 1, checked: false, why: '想更耐用可以换金属齿' },
    ],
    wiring: [...GC9A01_WIRING, ...SERVO_EXT_WIRING],
    firmware: { wifi: false },
  },
  {
    id: 'lens',
    title: '透镜里的小人',
    level: '07:lens',
    product: 'lens',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: '验收固件按 S3' },
      { partId: 'gc9a01', qty: 1, why: '圆屏眼睛' },
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: '圆屏排针直接连开发板' },
      { partId: 'enclosure-lens', qty: 1, why: '底座 + 屏幕外框' },
      { partId: 'lens-dome', qty: 1, why: '放大成立体感' },
    ],
    suggested: [
      { partId: 'breadboard-830', qty: 1, checked: false, why: '想先在面包板上试' },
      { partId: 'dupont-mm', qty: 1, checked: false, why: '面包板上跳线' },
    ],
    wiring: [...GC9A01_WIRING],
    firmware: { wifi: false },
  },
  {
    id: 'lamp',
    title: '旋钮台灯',
    level: 'lamp-3',
    product: 'lamp',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: '验收固件按 S3' },
      { partId: 'ws2812-stick8', qty: 1, why: '灯：8 颗 WS2812，DIN 接 GPIO5' },
      { partId: 'encoder', qty: 1, why: '旋钮：转调亮度 / 颜色，按下切换' },
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: '模块排针直接连开发板' },
      { partId: 'enclosure-lamp', qty: 1, why: '灯座 + 乳白灯罩' },
    ],
    suggested: [
      { partId: 'psu-5v2a', qty: 1, checked: true, why: '灯条单独供电：8 颗满白约 480 mA，加上板子超过电脑 USB 的 500 mA' },
      { partId: 'dc-jack', qty: 1, checked: true, why: '电源插头转面包板' },
      { partId: 'level-ahct125', qty: 1, checked: true, why: '5 V 灯条要 ≥ 3.5 V 的数据电平，3.3 V 直推偶尔会乱色' },
      { partId: 'breadboard-830', qty: 1, checked: true, why: '先搭通再装壳' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: '面包板上跳线' },
      { partId: 'cap-1000uf', qty: 1, checked: false, why: '灯条电源两端稳压，长灯条必加' },
    ],
    wiring: [
      { part: 'ws2812-stick8', pin: '5V', net: 'EXT5V' },
      { part: 'ws2812-stick8', pin: 'DIN', net: 'GPIO5', via: 'level-shifter' },
      { part: 'ws2812-stick8', pin: 'GND', net: 'GND' },
      { part: 'encoder', pin: 'GND', net: 'GND' },
      { part: 'encoder', pin: '+', net: '3V3' },
      { part: 'encoder', pin: 'SW', net: 'GPIO15' },
      { part: 'encoder', pin: 'DT', net: 'GPIO7' },
      { part: 'encoder', pin: 'CLK', net: 'GPIO6' },
      { part: 'dc-jack', pin: '+', net: 'EXT5V' },
      { part: 'dc-jack', pin: '-', net: 'GND' },
    ],
    firmware: { wifi: false },
  },
  {
    id: 'ruler',
    title: '超声波尺子',
    level: 'ruler-3',
    product: 'ruler',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: '验收固件按 S3' },
      { partId: 'hc-sr04', qty: 1, why: '测距：Trig GPIO17，Echo 分压后进 GPIO18' },
      { partId: 'resistor-kit', qty: 1, why: 'Echo 是 5 V：1 kΩ / 2 kΩ 分压到约 3.3 V' },
      { partId: 'ssd1306', qty: 1, why: '显示距离' },
      { partId: 'buzzer-module', qty: 1, why: '越近响得越急（GPIO5）' },
      CABLE,
      { partId: 'dupont-mf', qty: 1, why: '模块排针接面包板' },
      { partId: 'enclosure-ruler', qty: 1, why: '手持外壳，前面两个探头孔' },
    ],
    suggested: [
      { partId: 'breadboard-830', qty: 1, checked: true, why: '分压电阻插在面包板上' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: '面包板上跳线' },
      { partId: 'dupont-ff', qty: 1, checked: false, why: '装进外壳时直接连排针' },
    ],
    wiring: [
      { part: 'hc-sr04', pin: 'VCC', net: '5V' },
      { part: 'hc-sr04', pin: 'Trig', net: 'GPIO17' },
      { part: 'hc-sr04', pin: 'Echo', net: 'GPIO18', via: 'divider' },
      { part: 'hc-sr04', pin: 'GND', net: 'GND' },
      { part: 'ssd1306', pin: 'GND', net: 'GND' },
      { part: 'ssd1306', pin: 'VCC', net: '3V3' },
      { part: 'ssd1306', pin: 'SCL', net: 'GPIO9' },
      { part: 'ssd1306', pin: 'SDA', net: 'GPIO8' },
      { part: 'buzzer-module', pin: 'VCC', net: '3V3' },
      { part: 'buzzer-module', pin: 'I/O', net: 'GPIO5' },
      { part: 'buzzer-module', pin: 'GND', net: 'GND' },
    ],
    firmware: { wifi: false },
  },
  {
    id: 'tilt',
    title: '体感小人',
    level: 'tilt-3',
    product: 'tilt',
    board: 's3-devkitc1-v10',
    required: [
      { partId: 's3-devkitc1-v10', qty: 1, why: '验收固件按 S3' },
      { partId: 'qmi8658', qty: 1, why: '感知倾斜（I2C 0x6B）' },
      { partId: 'gc9a01', qty: 1, why: '圆屏：小豆在上面滑' },
      CABLE,
      { partId: 'dupont-ff', qty: 1, why: '模块排针直接连开发板' },
      { partId: 'enclosure-tilt', qty: 1, why: '圆盘外壳，圆屏在顶面' },
    ],
    suggested: [
      { partId: 'breadboard-830', qty: 1, checked: false, why: '想先在面包板上试' },
      { partId: 'dupont-mm', qty: 1, checked: false, why: '面包板上跳线' },
    ],
    wiring: [
      ...GC9A01_WIRING,
      { part: 'qmi8658', pin: 'VIN', net: '3V3' },
      { part: 'qmi8658', pin: 'GND', net: 'GND' },
      { part: 'qmi8658', pin: 'SCL', net: 'GPIO9' },
      { part: 'qmi8658', pin: 'SDA', net: 'GPIO8' },
    ],
    firmware: { wifi: false },
  },
  {
    id: 'blank',
    title: '空白：我自己挑',
    level: null,
    product: null,
    board: 's3-devkitc1-v11',
    required: [CABLE],
    suggested: [
      { partId: 's3-devkitc1-v11', qty: 1, checked: true, why: '现在新买到的多是 v1.1' },
      { partId: 'breadboard-830', qty: 1, checked: true, why: '搭电路' },
      { partId: 'dupont-mm', qty: 1, checked: true, why: '面包板上跳线' },
      { partId: 'dupont-mf', qty: 1, checked: true, why: '模块接面包板' },
      { partId: 'resistor-kit', qty: 1, checked: true, why: '限流、分压、上拉' },
      { partId: 'led-kit', qty: 1, checked: true, why: '第一个实验：点灯' },
      { partId: 'button', qty: 4, checked: true, why: '输入' },
    ],
    wiring: [],
    firmware: {},
  },
];

export const TEMPLATE_BY_ID: Record<string, ProcureTemplate> = Object.fromEntries(PROCURE_TEMPLATES.map((t) => [t.id, t]));

export function getTemplate(id: string): ProcureTemplate {
  const t = TEMPLATE_BY_ID[id];
  if (!t) throw new Error(`没有采购模版 ${id}`);
  return t;
}

/** 模版必选件：采购页上灰勾、不能去掉（去掉时 R27 给阻断） */
export function isRequired(templateId: string, partId: string): boolean {
  return getTemplate(templateId).required.some((l) => l.partId === partId);
}

/** 从清单里去掉一件；必选件不让去，原样返回并给出原因 */
export function removePick(templateId: string, picks: Pick[], partId: string): { picks: Pick[]; refused?: string } {
  if (isRequired(templateId, partId)) {
    const l = getTemplate(templateId).required.find((x) => x.partId === partId)!;
    return { picks, refused: `必选件不能去掉：${getPart(partId).name}（${l.why}）` };
  }
  return { picks: picks.filter((p) => p.partId !== partId && p.key !== partId) };
}

/** 模版 → 默认选中清单（必选 + 默认勾选的建议项；includeAll 时建议项全带上） */
export function templatePicks(id: string, opts: { includeAll?: boolean } = {}): Pick[] {
  const t = getTemplate(id);
  const lines = [...t.required, ...t.suggested.filter((s) => opts.includeAll || s.checked)];
  const out: Pick[] = [];
  for (const l of lines) {
    const had = out.find((p) => p.partId === l.partId);
    if (had) had.qty = Math.max(had.qty ?? 1, l.qty);
    else out.push({ partId: l.partId, qty: l.qty });
  }
  return out;
}

/** 规则引擎输入的一份完整草稿：板子 + 清单 + 接线 + 固件用法 */
export function templateInput(id: string, opts: { includeAll?: boolean } = {}) {
  const t = getTemplate(id);
  return { template: t.id, board: t.board, parts: templatePicks(id, opts), wiring: t.wiring.map((w) => ({ ...w })), firmware: { ...t.firmware } };
}

/** BOM 合计（区间，元）；板子若不在 picks 里也要单独算上 */
export function bomTotal(picks: Pick[], board?: string): { lo: number; hi: number; lines: { part: Part; qty: number; lo: number; hi: number }[] } {
  const all = [...picks];
  if (board && !all.some((p) => p.partId === board)) all.unshift({ partId: board, qty: 1 });
  const lines = all.map((p) => {
    const part = getPart(p.partId);
    const qty = p.qty ?? 1;
    return { part, qty, lo: part.price.lo * qty, hi: part.price.hi * qty };
  });
  const round = (x: number) => Math.round(x * 100) / 100;
  return { lo: round(lines.reduce((s, l) => s + l.lo, 0)), hi: round(lines.reduce((s, l) => s + l.hi, 0)), lines };
}

/** 元件库 → 实验台场景元件类型（与 examples.json scene.parts[].type 同名） */
const SCENE_TYPE: Record<string, string> = { ssd1306: 'oled', bme280: 'bme280', sg90: 'servo', mg90s: 'servo', gc9a01: 'gc9a01', 'gc9a01-touch': 'gc9a01-touch', 'led-kit': 'led', 'buzzer-module': 'buzzer', 'buzzer-passive': 'buzzer', mpu6050: 'mpu6050', qmi8658: 'qmi8658', encoder: 'encoder', 'hc-sr04': 'hcsr04', 'ws2812-stick8': 'ws2812', 'ws2812-strip': 'ws2812' };

/** 接线 → 实验台场景（"买完摆上实验台"用；格式同 firmware/examples.json 的 scene.parts） */
export function toScene(picks: Pick[], wiring: Wire[]): { type: string; [k: string]: unknown }[] {
  const out: { type: string; [k: string]: unknown }[] = [];
  const gpioOf = (key: string, pinType: string) => {
    const part = getPart(picks.find((p) => (p.key ?? p.partId) === key)!.partId);
    for (const w of wiring) {
      if (w.part !== key) continue;
      const pin = part.pins?.find((x) => x.label === w.pin);
      const m = /^GPIO(\d+)$/.exec(w.net);
      if (pin?.type === pinType && m) return Number(m[1]);
    }
    return undefined;
  };
  // 顺序按接线里第一次出现的先后（与 examples.json 的 scene 顺序一致），没接线的件排在后面
  const firstWire = (p: Pick) => {
    const i = wiring.findIndex((w) => w.part === (p.key ?? p.partId));
    return i < 0 ? wiring.length : i;
  };
  const ordered = picks.map((p, i) => ({ p, i })).sort((a, b) => firstWire(a.p) - firstWire(b.p) || a.i - b.i).map((x) => x.p);
  for (const p of ordered) {
    const type = SCENE_TYPE[p.partId];
    if (!type) continue;
    const key = p.key ?? p.partId;
    const part = getPart(p.partId);
    if (type === 'oled' || type === 'bme280') {
      out.push({ type, addr: p.addr ?? part.i2cAddr!.default, sda: gpioOf(key, 'i2c-sda'), scl: gpioOf(key, 'i2c-scl') });
    } else if (type === 'servo') {
      out.push({ type, pin: gpioOf(key, 'pwm') });
    } else if (type === 'mpu6050' || type === 'qmi8658') {
      const int = type === 'mpu6050' ? gpioOf(key, 'digital-out') : undefined;
      out.push({ type, addr: p.addr ?? part.i2cAddr!.default, sda: gpioOf(key, 'i2c-sda'), scl: gpioOf(key, 'i2c-scl'), ...(int !== undefined ? { int } : {}) });
    } else if (type === 'gc9a01') {
      // 模拟器只认 SPI2 上的圆屏；引脚由固件配置
      out.push({ type, spi: 2 });
    } else if (type === 'gc9a01-touch') {
      // 触摸圆屏 = 圆屏 + 屏上的 CST816S（触摸那 4 针按丝印找，TP_RST 与屏的 RES 同为复位类型）
      const byLabel = (label: string) => {
        const w = wiring.find((x) => x.part === key && x.pin === label);
        const m = w && /^GPIO(\d+)$/.exec(w.net);
        return m ? Number(m[1]) : undefined;
      };
      out.push({ type: 'gc9a01', spi: 2 });
      const rst = byLabel('TP_RST');
      out.push({ type: 'cst816s', addr: p.addr ?? part.i2cAddr!.default, sda: byLabel('TP_SDA'), scl: byLabel('TP_SCL'), int: byLabel('TP_INT'), ...(rst !== undefined ? { rst } : {}) });
    } else if (type === 'buzzer') {
      const pin = gpioOf(key, 'pwm');
      if (pin !== undefined) out.push({ type, pin });
    } else if (type === 'led') {
      const pin = gpioOf(key, 'io');
      if (pin !== undefined) out.push({ type, pin });
    } else if (type === 'encoder' || type === 'hcsr04' || type === 'ws2812') {
      // 按丝印找（编码器三根信号线同为 digital-out 类型，按类型分不开）
      const byLabel = (label: string) => {
        const w = wiring.find((x) => x.part === key && x.pin === label);
        const m = w && /^GPIO(\d+)$/.exec(w.net);
        return m ? Number(m[1]) : undefined;
      };
      if (type === 'encoder') {
        const a = byLabel('CLK'), b = byLabel('DT'), sw = byLabel('SW');
        if (a !== undefined && b !== undefined) out.push({ type, a, b, ...(sw !== undefined ? { sw } : {}) });
      } else if (type === 'hcsr04') {
        const trig = byLabel('Trig'), echo = byLabel('Echo');
        const div = wiring.find((x) => x.part === key && x.pin === 'Echo')?.via === 'divider';
        // 障碍物先放在 15 cm（台面上探头、挡板、开发板都在默认机位里）
        if (trig !== undefined && echo !== undefined) out.push({ type, trig, echo, ...(div ? {} : { divider: false }), cm: 15 });
      } else {
        const pin = byLabel('DIN');
        if (pin !== undefined) out.push({ type, pin, ...(p.partId === 'ws2812-strip' ? { n: 60 } : {}) });
      }
    }
  }
  return out;
}
