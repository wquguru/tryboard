// 采购 / 接线规则引擎（docs/RESEARCH_PROCURE.md §2 的 R01–R27，P1-12 加板子特有的 R28–R32）。
// 全部是确定性纯函数：同样的输入永远给同样的结论，命令行和网页都能重算。
// 分级照 ESPHome 引脚校验（MIT 的 Python 部分，只参考结构）："不能开机 / 不能用" = block，"能用但有坑" = warn。
// 每条结论带来源；电流类数字是估算，页面要标"估算，未经真机标定"。
import { CHIPS, type Cap } from '../advisor/data.ts';
import { BOARDS, PART_BY_ID, getPart, type BoardInfo, type ChipId, type LcdPins, type OnboardKind, type Part, type Pin } from './parts.ts';
import { TEMPLATE_BY_ID, type FirmwareUse, type Pick, type Wire } from './templates.ts';

export type Level = 'block' | 'warn' | 'ok';
export type Confidence = '数据手册' | '估算' | '必须上真机' | '经验规则';

export interface Fix {
  action: 'add' | 'remove' | 'swap';
  partId: string;
  /** swap：被换掉的件（开发板换板时是旧板 id） */
  replaces?: string;
}

export interface Finding {
  id: string;
  level: Level;
  title: string;
  detail: string;
  source: string;
  confidence: Confidence;
  /** 触发位置：零件 key、引脚或 GPIO */
  where?: string;
  fix?: Fix;
}

export interface RuleInput {
  /** 开发板 id（元件库 kind = board） */
  board: string;
  parts: Pick[];
  /** 可选：接线。没有接线时只做清单级检查，引脚类规则判"未提供接线" */
  wiring?: Wire[];
  firmware?: FirmwareUse;
  /** 作品需要的芯片能力（R25） */
  needs?: Extract<Cap, 'usb_otg' | 'camera' | 'bt_classic'>[];
  /** 装配状态（R26） */
  assembly?: { metalCase?: boolean; nearAntenna?: string[] };
  /** 采购模板 id（R27 检查必选项） */
  template?: string;
}

export interface RuleMeta {
  id: string;
  /** 触发时的默认级别（个别规则会按情况给另一级，如 R03 PSRAM 类型未知时降为 warn） */
  level: 'block' | 'warn';
  title: string;
  source: string;
  confidence: Confidence;
}

// ───────── 芯片事实 ─────────
// flash / USB / UART0 / ADC1 / 射频峰值电流沿用 advisor/data.ts；其余来自 ESP-IDF v5.5.1 soc_caps.h 与数据手册
interface ChipFacts {
  name: string;
  gpios: number[];
  flash: number[];
  psramOctal: number[];
  bootPin: number;
  /** 上电采样、外部电平会改变启动方式的脚（R28）；S3 的 GPIO3 只在烧了 JTAG 选择 eFuse 后才起作用，不列 */
  straps: number[];
  usb: number[];
  uart0: number[];
  adc1: number[];
  adc2: number[];
  rmtTx: number;
  ledc: number;
  i2c: number;
  caps: Set<Cap>;
  txPeakMa: number;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const adv = (id: string) => CHIPS.find((c) => c.id === id)!;

export const CHIP_FACTS: Record<ChipId, ChipFacts> = {
  esp32: {
    name: 'ESP32',
    // 经典款没有 GPIO20、24、28–31
    gpios: [...range(0, 19), 21, 22, 23, 25, 26, 27, ...range(32, 39)],
    flash: adv('esp32').pins.flash,
    psramOctal: [],
    bootPin: 0,
    straps: [0, 2, 5, 12, 15],
    usb: [],
    uart0: [...adv('esp32').pins.uart0],
    adc1: range(32, 39),
    adc2: [0, 2, 4, 12, 13, 14, 15, 25, 26, 27],
    rmtTx: 8,
    ledc: 16,
    i2c: 2,
    caps: new Set(adv('esp32').caps),
    txPeakMa: adv('esp32').power.txPeak,
  },
  esp32c3: {
    name: 'ESP32-C3',
    gpios: range(0, 21),
    flash: adv('esp32c3').pins.flash,
    psramOctal: [],
    bootPin: 9,
    straps: [2, 8, 9],
    usb: adv('esp32c3').pins.usb,
    uart0: [...adv('esp32c3').pins.uart0],
    adc1: adv('esp32c3').pins.adc1,
    adc2: [5],
    rmtTx: 2,
    ledc: 6,
    i2c: 1,
    caps: new Set(adv('esp32c3').caps),
    txPeakMa: adv('esp32c3').power.txPeak,
  },
  esp32s3: {
    name: 'ESP32-S3',
    gpios: [...range(0, 21), ...range(26, 48)],
    flash: adv('esp32s3').pins.flash,
    psramOctal: adv('esp32s3').pins.psramOctal ?? [],
    bootPin: 0,
    straps: [0, 45, 46],
    usb: adv('esp32s3').pins.usb,
    uart0: [...adv('esp32s3').pins.uart0],
    adc1: adv('esp32s3').pins.adc1,
    adc2: range(11, 20),
    rmtTx: 4,
    ledc: 8,
    i2c: 2,
    caps: new Set(adv('esp32s3').caps),
    txPeakMa: adv('esp32s3').power.txPeak,
  },
};

/** 不开 Wi-Fi 时整板峰值（估算：CPU 全速 + 板载 USB-UART / 电源灯，未经测量） */
export const BOARD_IDLE_MA = 100;
/** USB 2.0 端口额定 500 mA */
export const USB_LIMIT_MA = 500;
/** LDO 额定未录入时按 500 mA 估 */
export const LDO_DEFAULT_MA = 500;
/** 单个 GPIO 直接驱动负载的建议上限（mA，默认驱动档量级） */
export const GPIO_LOAD_MA = 20;
/** I2C 上拉灌电流上限（NXP UM10204 标准 / 快速模式 3 mA） */
export const I2C_SINK_MA = 3;

// ───────── 规则元数据 ─────────
export const RULES: RuleMeta[] = [
  { id: 'R01', level: 'block', title: 'C3 的 GPIO12–17 接着 flash', source: 'ESP32-C3 数据手册 §2 引脚；ESPHome gpio_esp32_c3.py（MIT）', confidence: '数据手册' },
  { id: 'R02', level: 'block', title: 'S3 的 GPIO26–32 是 flash / PSRAM 的 SPI 脚', source: 'ESP32-S3 数据手册 §2 引脚；ESPHome gpio_esp32_s3.py（MIT）', confidence: '数据手册' },
  { id: 'R03', level: 'block', title: '八线 PSRAM 占用 GPIO33–37', source: 'ESP32-S3-WROOM-1 数据手册（R8 型号）；ESPHome gpio_esp32_s3.py；PlatformIO boards memory_type qio_opi', confidence: '数据手册' },
  { id: 'R04', level: 'block', title: '芯片上没有这个 GPIO，或这块板没引出', source: 'ESP32-S3 / C3 数据手册 IO MUX 表；开发板用户指南引脚表', confidence: '数据手册' },
  { id: 'R05', level: 'warn', title: 'BOOT 脚（C3 GPIO9 / S3 GPIO0）上电被拉低会进下载模式', source: 'ESP32-C3 / S3 数据手册 Strapping 管脚表；ESPHome check_strapping_pin', confidence: '数据手册' },
  { id: 'R06', level: 'warn', title: 'C3 GPIO8 / GPIO2 上电应保持高', source: 'ESP32-C3 数据手册 Strapping 管脚表', confidence: '数据手册' },
  { id: 'R07', level: 'block', title: 'S3 GPIO45 上电被拉高，flash 电压会变成 1.8 V', source: 'ESP32-S3 数据手册 Strapping（VDD_SPI 电压）；乐鑫 esp-techpedia S3 硬件指南', confidence: '数据手册' },
  { id: 'R08', level: 'warn', title: 'S3 GPIO46 上电被拉高可能组成非法启动模式', source: 'ESP32-S3 数据手册 Strapping 管脚表', confidence: '数据手册' },
  { id: 'R09', level: 'warn', title: '占用了 USB D− / D+', source: 'ESP32-C3 / S3 数据手册 USB Serial/JTAG；ESPHome check_usb_jtag_pin', confidence: '数据手册' },
  { id: 'R10', level: 'warn', title: '占用了 UART0（下载和日志串口）', source: '乐鑫开发板用户指南（UART0 接 USB-UART）', confidence: '数据手册' },
  { id: 'R11', level: 'block', title: 'C3 模拟量只能放 ADC1（GPIO0–4）', source: 'ESP-IDF v5.5 ADC Oneshot 文档（ESP32-C3：ADC2 因勘误不再支持）；ESP32-C3 勘误表', confidence: '数据手册' },
  { id: 'R12', level: 'warn', title: 'S3 开 Wi-Fi 时 ADC2 读数可能超时', source: 'ESP-IDF v5.5 ADC Oneshot 文档（ESP32-S3：ADC2 与 Wi-Fi 共用，可能返回 ESP_ERR_TIMEOUT）', confidence: '数据手册' },
  { id: 'R13', level: 'warn', title: 'C3 GPIO11 默认是 VDD_SPI 电源脚', source: 'ESP32-C3 技术参考手册 eFuse（VDD_SPI_AS_GPIO）', confidence: '数据手册' },
  { id: 'R14', level: 'block', title: '外设数量超过片上资源（RMT / LEDC / I2C）', source: 'ESP-IDF v5.5.1 soc_caps.h（C3：RMT TX 2、LEDC 6、I2C 1；S3：RMT TX 4、LEDC 8、I2C 2）', confidence: '数据手册' },
  { id: 'R15', level: 'block', title: '同一条 I2C 总线上地址冲突', source: '各器件数据手册 I2C 地址', confidence: '数据手册' },
  { id: 'R16', level: 'warn', title: 'I2C 模块太多，并联上拉过小', source: 'NXP UM10204 I2C 规范（灌电流 3 mA）；模块上拉按 4.7 kΩ 估', confidence: '估算' },
  { id: 'R17', level: 'block', title: '5 V 信号直接进 GPIO', source: 'ESP32-C3 / S3 数据手册电气特性（输入电压上限 VDD+0.3 V 量级）', confidence: '数据手册' },
  { id: 'R18', level: 'warn', title: '5 V 供电的 WS2812 用 3.3 V 数据线驱动', source: 'WS2812B 数据手册（VIH = 0.7 × VDD ≈ 3.5 V）', confidence: '数据手册' },
  { id: 'R19', level: 'block', title: '供电电压超出器件范围（如舵机接 3V3、3.3 V 模块接 5 V）', source: '各器件数据手册 / 规格书供电范围（SG90 4.8–6 V 等）', confidence: '数据手册' },
  { id: 'R20', level: 'warn', title: '只靠 USB 供电，峰值电流超过 500 mA', source: 'USB 2.0 规范 500 mA；SG90 堵转、WS2812 满白电流为估算', confidence: '估算' },
  { id: 'R21', level: 'warn', title: '3.3 V 稳压器负载过大', source: 'ESP32-C3 / S3 数据手册射频发射峰值电流；板载 LDO 额定（逐板录入，未录入按 500 mA）', confidence: '估算' },
  { id: 'R22', level: 'warn', title: 'GPIO 直接驱动大电流负载', source: 'ESP32-C3 / S3 数据手册 GPIO 驱动能力（默认驱动档）', confidence: '数据手册' },
  { id: 'R23', level: 'warn', title: '板载彩灯引脚与固件不符（DevKitC-1 v1.0 GPIO48 / v1.1 GPIO38）', source: 'ESP32-S3-DevKitC-1 用户指南 v1.1（RGB 改到 GPIO38）', confidence: '数据手册' },
  { id: 'R24', level: 'warn', title: '引脚和板载器件冲突', source: '开发板用户指南 / Seeed Wiki / M5Stack 文档 / 微雪 wiki（逐板录入）', confidence: '数据手册' },
  { id: 'R25', level: 'block', title: '芯片不支持作品需要的能力（USB OTG、摄像头、经典蓝牙）', source: 'ESP-IDF v5.5.1 soc_caps.h（SOC_USB_OTG_SUPPORTED 等）', confidence: '数据手册' },
  { id: 'R26', level: 'warn', title: '天线附近有金属或电池，Wi-Fi 会变差', source: '乐鑫模组硬件设计指南（天线净空区）', confidence: '必须上真机' },
  { id: 'R27', level: 'block', title: '缺必选件（模板必选、舵机电源、充电、杜邦线、数据线、配套件）', source: '试板采购规则', confidence: '经验规则' },
  { id: 'R28', level: 'warn', title: '排针上看着普通的脚其实是 strapping 脚（XIAO C3 的 D0 / D8 / D9 等）', source: 'Seeed Wiki XIAO ESP32C3 引脚表（D0 / D8 / D9 = GPIO2 / 8 / 9 为 strapping）；ESP32-C3 / S3 数据手册 Strapping 管脚表', confidence: '数据手册' },
  { id: 'R29', level: 'warn', title: '板上已经有这个器件，又外接一份（如微雪圆屏板再买 GC9A01）', source: '微雪 wiki ESP32-S3-LCD-1.28 / Touch-LCD-1.28（板载 GC9A01）', confidence: '数据手册' },
  { id: 'R30', level: 'block', title: '固件要 PSRAM，板子没有（XIAO C3、AtomS3 等）', source: 'ESP32-C3 数据手册（无 PSRAM 接口）；ESP32-S3 订购信息（型号带 R 才有 PSRAM）；Seeed Wiki / M5Stack 文档', confidence: '数据手册' },
  { id: 'R31', level: 'block', title: '板子能自由用的 GPIO 不够（AtomS3 只有 8 个）', source: '开发板引脚表（M5Stack AtomS3：排针 G5–G8 / G38 / G39 + Grove G1 / G2）；板载占用逐板录入', confidence: '数据手册' },
  { id: 'R32', level: 'warn', title: '板载屏引脚与固件不符（微雪圆屏触摸版和无触摸版不同）', source: '微雪 wiki：无触摸版屏 RST GPIO12、背光 GPIO40；触摸版 RST GPIO14、背光 GPIO2', confidence: '数据手册' },
];
export const RULE_BY_ID: Record<string, RuleMeta> = Object.fromEntries(RULES.map((r) => [r.id, r]));

// ───────── 上下文 ─────────
interface Inst {
  key: string;
  part: Part;
  qty: number;
  addr?: number;
}
interface GpioUse {
  gpio: number;
  inst: Inst;
  pin: Pin;
  wire: Wire;
}

interface Ctx {
  input: RuleInput;
  board: Part;
  info: BoardInfo;
  chip: ChipFacts;
  insts: Inst[];
  wiring: Wire[] | null;
  uses: GpioUse[];
  has: (partId: string) => boolean;
  hasExt5V: boolean;
  supplyNet: (i: Inst) => string | null;
  pinVolt: (i: Inst, p: Pin) => number | null;
  wired: (i: Inst) => boolean;
  chipLoadMa: number;
}

export const netVolt = (net: string | null): number | null => {
  if (net === null) return null;
  if (net === '3V3' || net === 'EXT3V3' || /^GPIO\d+$/.test(net)) return 3.3;
  if (net === '5V' || net === 'VBUS' || net === 'EXT5V') return 5;
  if (net === 'BAT') return 4.2;
  if (net === 'GND') return 0;
  return null;
};

function makeCtx(input: RuleInput): Ctx {
  const board = getPart(input.board);
  if (board.kind !== 'board' || !board.board) throw new Error(`${input.board} 不是开发板`);
  const info = board.board;
  const chip = CHIP_FACTS[info.chip];
  const insts: Inst[] = input.parts
    .filter((p) => p.partId !== input.board && PART_BY_ID[p.partId]?.kind !== 'board')
    .map((p) => ({ key: p.key ?? p.partId, part: getPart(p.partId), qty: p.qty ?? 1, addr: p.addr }));
  const ids = new Set(input.parts.map((p) => p.partId).concat(input.board));
  const has = (id: string) => ids.has(id);
  const hasExt5V = insts.some((i) => i.part.provides?.net === 'EXT5V');
  const wiring = input.wiring && input.wiring.length ? input.wiring : null;
  const wiresOf = (i: Inst) => (wiring ?? []).filter((w) => w.part === i.key);
  const pinOf = (i: Inst, label: string) => i.part.pins?.find((p) => p.label === label);
  const wired = (i: Inst) => wiresOf(i).length > 0;
  const supplyNet = (i: Inst): string | null => {
    if (!i.part.pins || i.part.provides) return null;
    const w = wiresOf(i).find((w) => pinOf(i, w.pin)?.type === 'power');
    let net = w ? w.net : (i.part.supplyNet ?? null);
    // 外接 5 V 轨没有电源时，实际只能从板子 5V 取电
    if (net === 'EXT5V' && !hasExt5V) net = '5V';
    return net;
  };
  const pinVolt = (i: Inst, p: Pin) => (p.v === 'vcc' ? netVolt(supplyNet(i)) : p.v);
  const uses: GpioUse[] = [];
  for (const w of wiring ?? []) {
    const m = /^GPIO(\d+)$/.exec(w.net);
    if (!m) continue;
    const inst = insts.find((i) => i.key === w.part);
    const pin = inst && pinOf(inst, w.pin);
    if (inst && pin) uses.push({ gpio: Number(m[1]), inst, pin, wire: w });
  }
  const chipLoadMa = input.firmware?.wifi ? chip.txPeakMa : BOARD_IDLE_MA;
  return { input, board, info, chip, insts, wiring, uses, has, hasExt5V, supplyNet, pinVolt, wired, chipLoadMa };
}

const at = (u: GpioUse) => `${u.inst.key}.${u.pin.label} → GPIO${u.gpio}`;
const NO_WIRING = '没有提供接线，引脚类检查跳过';

/** 规则实现：返回触发的结论；返回字符串表示没触发（字符串是给 UI 的说明） */
type RuleFn = (c: Ctx) => Partial<Finding>[] | string;

function f(level: 'block' | 'warn', detail: string, where?: string, fix?: Fix): Partial<Finding> {
  return { level, detail, where, fix };
}

/** 在 uses 里找某些 GPIO */
const usesOn = (c: Ctx, gpios: number[]) => c.uses.filter((u) => gpios.includes(u.gpio));

const isLow = (p: Pin) => p.boot === 'pull-down' || p.boot === 'drive-low';
const isHigh = (p: Pin) => p.boot === 'pull-up' || p.boot === 'drive-high';

const IMPL: Record<string, RuleFn> = {
  R01: (c) => {
    if (c.info.chip !== 'esp32c3') return '只对 ESP32-C3';
    if (!c.wiring) return NO_WIRING;
    return usesOn(c, c.chip.flash).map((u) => f('block', `GPIO${u.gpio} 接着片内 flash，不能当普通 IO；换到 GPIO0–7 / 10。`, at(u)));
  },
  R02: (c) => {
    if (c.info.chip !== 'esp32s3') return '只对 ESP32-S3';
    if (!c.wiring) return NO_WIRING;
    return usesOn(c, c.chip.flash).map((u) => f('block', `GPIO${u.gpio} 是 flash / PSRAM 的 SPI 脚，接外设会开不了机。`, at(u)));
  },
  R03: (c) => {
    if (c.info.chip !== 'esp32s3') return '只对 ESP32-S3';
    if (!c.wiring) return NO_WIRING;
    const hit = usesOn(c, c.chip.psramOctal);
    if (c.info.psram === 'octal') return hit.map((u) => f('block', `${c.board.name} 是八线 PSRAM，GPIO${u.gpio} 被 PSRAM 占用（排针上有，但不能用）。`, at(u)));
    if (c.info.psram === null)
      return hit.map((u) => f('warn', `${c.board.name} 的 PSRAM 类型待核：如果是 R8（八线 PSRAM）版，GPIO${u.gpio} 不能用。`, at(u)));
    return '这块板不是八线 PSRAM';
  },
  R04: (c) => {
    if (!c.wiring) return NO_WIRING;
    const out: Partial<Finding>[] = [];
    for (const u of c.uses) {
      if (!c.chip.gpios.includes(u.gpio)) out.push(f('block', `${c.chip.name} 没有 GPIO${u.gpio}${c.info.chip === 'esp32s3' && u.gpio >= 22 && u.gpio <= 25 ? '（S3 的 GPIO22–25 不存在）' : ''}。`, at(u)));
      else if (c.board.pins && !c.board.pins.some((p) => p.gpio === u.gpio)) out.push(f('block', `${c.board.name} 没有把 GPIO${u.gpio} 引到排针上。`, at(u)));
    }
    return out;
  },
  R05: (c) => {
    if (!c.wiring) return NO_WIRING;
    const g = c.chip.bootPin;
    return usesOn(c, [g])
      .filter((u) => isLow(u.pin))
      .map((u) => f('warn', `GPIO${g} 是 BOOT 脚，${u.inst.part.name} 的 ${u.pin.label} 上电会把它拉低，芯片进下载模式，程序不运行。换个引脚。`, at(u)));
  },
  R06: (c) => {
    if (c.info.chip !== 'esp32c3') return '只对 ESP32-C3';
    if (!c.wiring) return NO_WIRING;
    return usesOn(c, [8, 2])
      .filter((u) => isLow(u.pin))
      .map((u) => f('warn', `GPIO${u.gpio} 是 strapping 脚，上电应为高电平；${u.pin.label} 会把它拉低，芯片可能进下载模式或启动失败。`, at(u)));
  },
  R07: (c) => {
    if (c.info.chip !== 'esp32s3') return '只对 ESP32-S3';
    if (!c.wiring) return NO_WIRING;
    return usesOn(c, [45])
      .filter((u) => isHigh(u.pin))
      .map((u) => f('block', `GPIO45 上电为高会把 flash 供电切到 1.8 V，3.3 V flash 的模组（WROOM-1 等）开不了机。换个引脚。`, at(u)));
  },
  R08: (c) => {
    if (c.info.chip !== 'esp32s3') return '只对 ESP32-S3';
    if (!c.wiring) return NO_WIRING;
    return usesOn(c, [46])
      .filter((u) => isHigh(u.pin))
      .map((u) => f('warn', `GPIO46 上电为高，和 GPIO0 按下（低）组合是非法启动模式，按 BOOT 烧录会失败。`, at(u)));
  },
  R09: (c) => {
    if (!c.wiring) return NO_WIRING;
    return usesOn(c, c.chip.usb).map((u) => f('warn', `GPIO${u.gpio} 是芯片原生 USB 的 D−/D+，接外设后 USB 串口和烧录口会失效，之后只能按 BOOT 烧录。`, at(u)));
  },
  R10: (c) => {
    if (!c.wiring) return NO_WIRING;
    return usesOn(c, c.chip.uart0).map((u) => f('warn', `GPIO${u.gpio} 是 UART0（日志串口），上电时的启动日志会输出到 ${u.inst.part.name}。`, at(u)));
  },
  R11: (c) => {
    if (c.info.chip !== 'esp32c3') return '只对 ESP32-C3';
    if (!c.wiring) return NO_WIRING;
    return c.uses
      .filter((u) => u.pin.type === 'analog' && !c.chip.adc1.includes(u.gpio))
      .map((u) =>
        u.gpio === 5
          ? f('block', 'GPIO5 是 ADC2：C3 的 ADC2 有硬件勘误，ESP-IDF 已经不支持，和 Wi-Fi 无关。改用 GPIO0–4。', at(u))
          : f('block', `GPIO${u.gpio} 不是模拟输入脚；C3 的 ADC1 是 GPIO0–4。`, at(u)),
      );
  },
  R12: (c) => {
    if (c.info.chip !== 'esp32s3') return '只对 ESP32-S3';
    if (!c.wiring) return NO_WIRING;
    const out: Partial<Finding>[] = [];
    for (const u of c.uses.filter((u) => u.pin.type === 'analog')) {
      if (c.chip.adc1.includes(u.gpio)) continue;
      if (c.chip.adc2.includes(u.gpio)) {
        if (c.input.firmware?.wifi) out.push(f('warn', `GPIO${u.gpio} 是 ADC2，S3 开 Wi-Fi 时读数可能超时失败（ESP_ERR_TIMEOUT）；建议放 ADC1（GPIO1–10）。`, at(u)));
      } else out.push(f('block', `GPIO${u.gpio} 不是模拟输入脚；S3 的 ADC1 是 GPIO1–10，ADC2 是 GPIO11–20。`, at(u)));
    }
    return out;
  },
  R13: (c) => {
    if (c.info.chip !== 'esp32c3') return '只对 ESP32-C3';
    if (!c.wiring) return NO_WIRING;
    return usesOn(c, [11]).map((u) => f('warn', 'GPIO11 默认是 VDD_SPI（flash 电源），当 GPIO 用要烧 eFuse VDD_SPI_AS_GPIO，不可逆。', at(u)));
  },
  R14: (c) => {
    const out: Partial<Finding>[] = [];
    const countBy = (type: Pin['type']) => {
      if (c.wiring) return new Set(c.uses.filter((u) => u.pin.type === type).map((u) => u.gpio));
      const s = new Set<string>();
      for (const i of c.insts) if (i.part.pins?.some((p) => p.type === type)) for (let k = 0; k < i.qty; k++) s.add(`${i.key}#${k}`);
      return s;
    };
    const rmt = countBy('ws2812-din');
    const fwRgb = c.input.firmware?.rgbGpio;
    const nRmt = rmt.size + (fwRgb !== undefined && !(rmt as Set<number | string>).has(fwRgb) ? 1 : 0);
    if (nRmt > c.chip.rmtTx) out.push(f('block', `WS2812 数据线 ${nRmt} 路（含板载彩灯），${c.chip.name} 只有 ${c.chip.rmtTx} 个 RMT 发送通道；把灯串成一条。`, 'RMT'));
    const nPwm = countBy('pwm').size;
    if (nPwm > c.chip.ledc) out.push(f('block', `PWM 输出 ${nPwm} 路，${c.chip.name} 的 LEDC 只有 ${c.chip.ledc} 个通道；多路舵机用 PCA9685 扩展。`, 'LEDC'));
    if (c.wiring) {
      const buses = new Set(c.uses.filter((u) => u.pin.type === 'i2c-sda').map((u) => u.gpio));
      if (buses.size > c.chip.i2c) out.push(f('block', `用了 ${buses.size} 条 I2C 总线，${c.chip.name} 只有 ${c.chip.i2c} 个 I2C 控制器；把模块并到同一条 SDA / SCL 上。`, 'I2C'));
    }
    return out;
  },
  R15: (c) => {
    const out: Partial<Finding>[] = [];
    for (const i of c.insts) {
      if (i.addr === undefined || !i.part.i2cAddr) continue;
      const ok = [i.part.i2cAddr.default, ...i.part.i2cAddr.alt];
      if (!ok.includes(i.addr)) out.push(f('block', `${i.part.name} 不支持地址 0x${hex(i.addr)}（可选 ${ok.map((a) => '0x' + hex(a)).join(' / ')}）。`, i.key));
    }
    for (const [bus, list] of i2cBuses(c)) {
      const byAddr = new Map<number, string[]>();
      for (const i of list) {
        const a = i.addr ?? i.part.i2cAddr!.default;
        for (let k = 0; k < i.qty; k++) byAddr.set(a, [...(byAddr.get(a) ?? []), i.qty > 1 ? `${i.key}#${k + 1}` : i.key]);
      }
      for (const [a, who] of byAddr) {
        if (who.length < 2) continue;
        const how = list.map((i) => i.part.i2cAddr?.how).filter(Boolean)[0];
        const second = c.chip.i2c > 1 ? '，或接到第二条 I2C 总线（S3 有两路）' : '';
        out.push(f('block', `${who.join(' 和 ')} 都是 0x${hex(a)}${bus === '' ? '' : `（总线 ${bus}）`}：地址冲突。${how ? how : '改地址跳线'}${second}。`, who.join(',')));
      }
    }
    return out;
  },
  R16: (c) => {
    const out: Partial<Finding>[] = [];
    for (const [bus, list] of i2cBuses(c)) {
      let g = 0;
      let n = 0;
      for (const i of list) {
        const k = i.part.i2cPullupK ?? 4.7;
        if (k > 0) {
          g += i.qty / k;
          n += i.qty;
        }
      }
      if (!g) continue;
      const r = 1 / g;
      const sink = 3.3 / r;
      if (sink > I2C_SINK_MA)
        out.push(f('warn', `${n} 个模块各带上拉，并联约 ${r.toFixed(2)} kΩ，低电平时要灌 ${sink.toFixed(1)} mA（估算），规范上限 3 mA。拆掉多余模块的上拉电阻。`, bus || 'I2C'));
    }
    return out;
  },
  R17: (c) => {
    const out: Partial<Finding>[] = [];
    const mitigation = c.has('level-bss138') || c.has('resistor-kit');
    const fix: Fix | undefined = mitigation ? undefined : { action: 'add', partId: 'resistor-kit' };
    for (const u of c.uses) {
      if (u.pin.dir !== 'out' && u.pin.dir !== 'bi') continue;
      const v = c.pinVolt(u.inst, u.pin);
      if (v === null || v <= 3.6) continue;
      if (u.wire.via === 'divider' || u.wire.via === 'level-shifter') continue;
      const i2c = u.pin.type === 'i2c-sda' || u.pin.type === 'i2c-scl';
      out.push(
        f('block', `${u.inst.part.name} 的 ${u.pin.label} 是 ${v} V，ESP32 引脚不耐 5 V。${i2c ? '模块改接 3V3 供电，或加双向电平转换。' : '加 1 kΩ / 2 kΩ 分压或电平转换。'}`, at(u), i2c && !c.has('level-bss138') ? { action: 'add', partId: 'level-bss138' } : fix),
      );
    }
    // 没接线的件：按默认供电判断
    for (const i of c.insts) {
      // 电平转换 / 阻容件的 5 V 侧本来就不接 GPIO
      if (c.wired(i) || !i.part.pins || i.part.kind === 'passive') continue;
      const hot = i.part.pins.find((p) => (p.dir === 'out' || p.dir === 'bi') && (c.pinVolt(i, p) ?? 0) > 3.6);
      if (hot && !mitigation) out.push(f('block', `${i.part.name} 的 ${hot.label} 输出 ${c.pinVolt(i, hot)} V，ESP32 引脚不耐 5 V，要分压或电平转换。`, i.key, fix));
    }
    return out;
  },
  R18: (c) => {
    const out: Partial<Finding>[] = [];
    const fix: Fix | undefined = c.has('level-ahct125') ? undefined : { action: 'add', partId: 'level-ahct125' };
    for (const i of c.insts) {
      const din = i.part.pins?.find((p) => p.type === 'ws2812-din');
      if (!din) continue;
      const vdd = netVolt(c.supplyNet(i));
      if (vdd === null || vdd < 4.5) continue;
      const msg = `${i.part.name} 用 ${vdd} V 供电，数据高电平门限约 ${(0.7 * vdd).toFixed(1)} V，3.3 V 处在边缘：短线常能亮，长线或部分批次会乱闪。加 74AHCT125 电平转换。`;
      if (c.wired(i)) {
        for (const u of c.uses.filter((u) => u.inst === i && u.pin === din && u.wire.via !== 'level-shifter')) out.push(f('warn', msg, at(u), fix));
      } else if (!c.has('level-ahct125')) out.push(f('warn', msg, i.key, fix));
    }
    return out;
  },
  R19: (c) => {
    const out: Partial<Finding>[] = [];
    for (const i of c.insts) {
      const range = i.part.voltage.supply;
      const net = c.supplyNet(i);
      const v = netVolt(net);
      if (!range || v === null || net === 'GND') continue;
      if (v < range[0] - 0.05)
        out.push(f('block', `${i.part.name} 要 ${range[0]}–${range[1]} V，现在接在 ${net}（${v} V）。${range[0] >= 4.5 ? '从 5V 或外接 5 V 取电。' : ''}`, i.key));
      else if (v > range[1] + 0.05) out.push(f('block', `${i.part.name} 最高 ${range[1]} V，接在 ${net}（${v} V）会损坏，改接 3V3。`, i.key));
    }
    return out;
  },
  R20: (c) => {
    const out: Partial<Finding>[] = [];
    let usb = c.chipLoadMa;
    let ext = 0;
    const heavy: string[] = [];
    for (const i of c.insts) {
      const peak = (i.part.currentMa.peak ?? 0) * i.qty;
      if (!peak) continue;
      const net = c.supplyNet(i);
      if (net === '3V3' || net === '5V') {
        usb += peak;
        if (peak >= 100) heavy.push(`${i.part.name} ${peak} mA`);
      } else if (net === 'EXT5V') ext += peak;
    }
    if (usb > USB_LIMIT_MA)
      out.push(
        f(
          'warn',
          `只靠电脑 USB：峰值估算 ${Math.round(usb)} mA（板子 ${c.chipLoadMa} mA${heavy.length ? '，' + heavy.join('，') : ''}），超过 USB 2.0 的 500 mA，板子可能反复重启。加 5 V 2 A 电源，或别让大电流件同时动作。`,
          'USB',
          c.hasExt5V ? undefined : { action: 'add', partId: 'psu-5v2a' },
        ),
      );
    const cap = c.insts.filter((i) => i.part.provides?.net === 'EXT5V').reduce((s, i) => s + i.part.provides!.maxMa * i.qty, 0);
    if (c.hasExt5V && ext > cap) out.push(f('warn', `外接 5 V 轨峰值估算 ${Math.round(ext)} mA，超过电源 ${cap} mA；在固件里给灯带限亮度，或换更大的电源。`, 'EXT5V'));
    return out;
  },
  R21: (c) => {
    let load = c.chipLoadMa;
    for (const i of c.insts) if (c.supplyNet(i) === '3V3') load += (i.part.currentMa.peak ?? 0) * i.qty;
    const known = c.info.ldo.maxMa;
    const limit = known ?? LDO_DEFAULT_MA;
    if (load <= limit) return `3.3 V 负载峰值约 ${Math.round(load)} mA，未超过 ${limit} mA${known ? '' : '（LDO 额定未录入，按 500 mA 估）'}`;
    return [
      f('warn', `3.3 V 轨峰值约 ${Math.round(load)} mA（估算），其中芯片 ${c.chipLoadMa} mA${c.input.firmware?.wifi ? '，含 Wi-Fi 发射' : ''}，超过板载稳压器 ${limit} mA${known ? '' : '（额定未录入，按 500 mA 算）'}：稳压器会发热、掉压。大电流件改接 5 V，或另加 AMS1117。`, '3V3'),
    ];
  },
  R22: (c) => {
    const out: Partial<Finding>[] = [];
    const fix: Fix | undefined = c.has('npn-s8050') ? undefined : { action: 'add', partId: 'npn-s8050' };
    for (const u of c.uses) {
      if ((u.pin.loadMa ?? 0) > GPIO_LOAD_MA && u.wire.via !== 'transistor')
        out.push(f('warn', `${u.inst.part.name} 约 ${u.pin.loadMa} mA，超过 GPIO 直驱建议的 ${GPIO_LOAD_MA} mA；用三极管或 MOSFET 驱动，感性负载再加续流二极管。`, at(u), fix));
    }
    for (const i of c.insts) {
      if (c.wired(i) || c.has('npn-s8050')) continue;
      const p = i.part.pins?.find((p) => (p.loadMa ?? 0) > GPIO_LOAD_MA);
      if (p) out.push(f('warn', `${i.part.name} 约 ${p.loadMa} mA，不能直接接 GPIO，要配三极管。`, i.key, fix));
    }
    return out;
  },
  R23: (c) => {
    const want = c.input.firmware?.rgbGpio;
    if (want === undefined) return '固件没有用板载彩灯';
    const have = c.info.rgbGpio;
    if (have === want) return `板载彩灯在 GPIO${have}，与固件一致`;
    if (have === null) return [f('warn', `固件把 GPIO${want} 当板载彩灯，但 ${c.board.name} 没有板载 WS2812。`, `GPIO${want}`)];
    const sibling = BOARDS.find((b) => b.board!.family === c.info.family && b.board!.rgbGpio === want && b.id !== c.board.id);
    return [
      f(
        'warn',
        `固件用 GPIO${want} 点板载彩灯，${c.board.name} 的彩灯在 GPIO${have}${c.info.family === 'devkitc1' ? '（DevKitC-1 v1.0 是 GPIO48、v1.1 是 GPIO38，看板背丝印）' : ''}。改固件里的引脚${sibling ? `，或换 ${sibling.name}` : ''}。`,
        `GPIO${want}`,
        sibling ? { action: 'swap', partId: sibling.id, replaces: c.board.id } : undefined,
      ),
    ];
  },
  R24: (c) => {
    if (!c.wiring) return NO_WIRING;
    const out: Partial<Finding>[] = [];
    for (const u of c.uses) {
      const o = c.info.onboard.find((o) => o.gpio === u.gpio && o.kind !== 'boot');
      if (!o) continue;
      if (o.share) {
        // 总线可以挂多个器件：同一角色的引脚接上来只提醒，拿总线脚当普通 IO 会把板载器件的通信打乱
        if (o.share === u.pin.type)
          out.push(f('warn', `${c.board.name} 的 GPIO${u.gpio} 是${o.what}（总线），${u.inst.part.name} 的 ${u.pin.label} 可以共用，但${o.share.startsWith('spi') ? '要单独一根 CS，固件里两个设备共用同一个 SPI 主机' : 'I2C 地址不能和板载器件撞'}。`, at(u)));
        else out.push(f('block', `${c.board.name} 的 GPIO${u.gpio} 是${o.what}，${u.inst.part.name} 的 ${u.pin.label} 接上去会打乱板载器件的通信。换个空闲引脚。`, at(u)));
      } else if (EXCLUSIVE.includes(o.kind))
        out.push(f('block', `${c.board.name} 的 GPIO${u.gpio} 已经接了${o.what}（板载器件独占的控制线），再接 ${u.inst.part.name} 会冲突。换个空闲引脚。`, at(u)));
      else out.push(f('warn', `${c.board.name} 的 GPIO${u.gpio} 已经接了${o.what}，再接 ${u.inst.part.name} 会互相干扰。`, at(u)));
    }
    return out;
  },
  R25: (c) => {
    const needs = c.input.needs ?? [];
    if (!needs.length) return '作品没有特殊能力要求';
    const out: Partial<Finding>[] = [];
    const NAME = { usb_otg: 'USB OTG（冒充键盘、U 盘）', camera: '摄像头接口', bt_classic: '经典蓝牙' } as const;
    for (const n of needs) {
      if (c.chip.caps.has(n)) {
        if (n === 'camera' && !/摄像头/.test(c.board.note)) out.push(f('warn', `${c.chip.name} 支持摄像头，但 ${c.board.name} 没有摄像头排座；选带摄像头的板（如 XIAO ESP32S3 Sense，元件库未收录）。`, c.board.id));
        continue;
      }
      const fix: Fix | undefined = n === 'usb_otg' ? { action: 'swap', partId: 's3-devkitc1-v11', replaces: c.board.id } : undefined;
      out.push(f('block', `${c.chip.name} 没有${NAME[n]}。${n === 'bt_classic' ? '经典蓝牙要原版 ESP32（元件库未收录）。' : '换 ESP32-S3。'}`, c.board.id, fix));
    }
    return out;
  },
  R26: (c) => {
    const a = c.input.assembly;
    if (!a) return '没有装配信息';
    const out: Partial<Finding>[] = [];
    if (a.metalCase) out.push(f('warn', '金属外壳会屏蔽 Wi-Fi 和蓝牙，信号明显变差；天线要露在壳外或换塑料壳（必须上真机确认）。', 'enclosure'));
    for (const key of a.nearAntenna ?? []) {
      const i = c.insts.find((i) => i.key === key);
      if (i && (i.part.rfBlocker || i.part.kind === 'display'))
        out.push(f('warn', `${i.part.name} 放在天线净空区内，Wi-Fi 信号可能衰减 3–10 dB（方向性提示，必须上真机）。`, key));
    }
    return out;
  },
  R27: (c) => {
    const out: Partial<Finding>[] = [];
    const added = new Set<string>();
    const need = (partId: string, detail: string, where: string) => {
      if (c.has(partId) || added.has(partId)) return;
      added.add(partId);
      out.push(f('block', detail, where, { action: 'add', partId }));
    };
    if (c.input.template) {
      const t = TEMPLATE_BY_ID[c.input.template];
      for (const r of t?.required ?? []) {
        if (getPart(r.partId).kind === 'board') continue;
        // 板上已经焊了（微雪圆屏板的 GC9A01）：模板必选也不用再买，R29 负责说
        if (c.info.builtin?.some((b) => b.partId === r.partId)) continue;
        need(r.partId, `「${t.title}」必选：${getPart(r.partId).name}（${r.why}）。`, r.partId);
      }
    }
    for (const i of c.insts) {
      if (i.part.supplyNet === 'EXT5V' && i.part.kind === 'actuator' && !c.hasExt5V)
        need('psu-5v2a', `${i.part.name} 要单独的 5 V 电源：只靠电脑 USB，启动瞬间掉压会让板子复位。`, i.key);
    }
    for (const i of c.insts) {
      for (const r of i.part.requires ?? []) {
        if (r.partId === 'tp4056' && c.info.charger) continue;
        need(r.partId, `${i.part.name} 需要 ${getPart(r.partId).name}：${r.why}。`, i.key);
      }
    }
    need('usb-c-cable', '每个作品都要一根能传数据的 Type-C 线，很多充电线只能充电。', 'usb-c-cable');
    return out;
  },
  R28: (c) => {
    if (!c.wiring) return NO_WIRING;
    return c.uses
      // 已知上电电平的交给 R05–R08；I2C 线有上拉、上电为高，正好满足 strapping 要求
      .filter((u) => c.chip.straps.includes(u.gpio) && u.pin.boot === undefined && (u.pin.dir === 'out' || u.pin.dir === 'bi') && !u.pin.type.startsWith('i2c-'))
      .map((u) => {
        const silk = c.board.pins?.find((p) => p.gpio === u.gpio)?.label;
        const named = silk && silk !== `GPIO${u.gpio}` ? `${silk} 看着是普通引脚，其实` : `GPIO${u.gpio} `;
        const why = c.info.chip === 'esp32c3' ? (u.gpio === 9 ? '上电为低会进下载模式，程序不运行' : '上电为低可能进下载模式或启动失败') : u.gpio === 0 ? '上电为低会进下载模式' : '上电电平会改变 flash 电压或启动方式';
        return f('warn', `${named}是 strapping 脚：${u.inst.part.name} 的 ${u.pin.label} 会往这根线上送电平，${why}。确认它上电时是高电平或高阻，否则换个引脚。`, at(u));
      });
  },
  R29: (c) => {
    const builtin = c.info.builtin ?? [];
    if (!builtin.length) return `${c.board.name} 没有和元件库重复的板载器件`;
    const lcd = c.info.lcd;
    const pins = lcd ? `SCLK ${lcd.sclk} / MOSI ${lcd.mosi} / CS ${lcd.cs} / DC ${lcd.dc} / RST ${lcd.rst} / 背光 ${lcd.bl}` : '';
    return c.insts
      .filter((i) => builtin.some((b) => b.partId === i.part.id))
      .map((i) => {
        const b = builtin.find((b) => b.partId === i.part.id)!;
        return f('warn', `${c.board.name} 已经有${b.what}，清单里又买了 ${i.part.name}：多花钱，外接的线还会抢板载器件的引脚。去掉外接的${pins ? `，固件改用板载屏的引脚（${pins}）` : ''}。`, i.key, { action: 'remove', partId: i.part.id });
      });
  },
  R30: (c) => {
    if (!c.input.firmware?.psram) return '固件不需要 PSRAM';
    const fix: Fix = { action: 'swap', partId: 's3-devkitc1-v10', replaces: c.board.id };
    if (c.info.psram === 'none' || c.info.psramMB === 0)
      return [f('block', `固件要用 PSRAM，${c.board.name} 没有 PSRAM（${c.info.chip === 'esp32c3' ? 'ESP32-C3 没有 PSRAM 接口' : '芯片或模组型号不带 R'}）。换带 PSRAM 的板，如 XIAO ESP32S3 或 DevKitC-1 N16R8。`, c.board.id, fix)];
    if (c.info.psram === null || c.info.psramMB === null) return [f('warn', `固件要用 PSRAM，${c.board.name} 的 PSRAM 配置待核：买前看清型号里的 R2 / R8 字样。`, c.board.id)];
    return `${c.board.name} 有 ${c.info.psramMB} MB PSRAM`;
  },
  R31: (c) => {
    if (!c.board.pins) return `${c.board.name} 的排针表未录入，数不了空闲引脚`;
    // 空闲 = 排针上的 GPIO 去掉板载独占的（总线脚和 BOOT 键还能接）
    const taken = new Set(c.info.onboard.filter((o) => o.kind !== 'boot' && !o.share).map((o) => o.gpio));
    const free = [...new Set(c.board.pins.map((p) => p.gpio).filter((g): g is number => g !== undefined && !taken.has(g)))];
    let need: number;
    if (c.wiring) need = new Set(c.uses.map((u) => u.gpio)).size;
    else {
      // 没接线：按零件的信号脚数估，所有 I2C 件共用一对 SDA / SCL
      need = 0;
      let i2c = false;
      for (const i of c.insts) {
        if (!i.part.pins) continue;
        if (i.part.i2cAddr) {
          i2c = true;
          continue;
        }
        need += i.qty * i.part.pins.filter((p) => !['power', 'gnd', 'nc', 'passive', 'addr'].includes(p.type)).length;
      }
      if (i2c) need += 2;
    }
    if (need <= free.length) return `要 ${need} 根信号线，${c.board.name} 空闲 GPIO ${free.length} 个`;
    const sibling = c.info.chip === 'esp32c3' ? 'c3-devkitm1' : 's3-devkitc1-v10';
    return [
      f('block', `作品要 ${need} 根信号线，${c.board.name} 能自由用的 GPIO 只有 ${free.length} 个（${free.map((g) => 'GPIO' + g).join('、')}）。换引脚多的板，或用 I2C 扩展（PCF8574 / PCA9685）。`, c.board.id, sibling === c.board.id ? undefined : { action: 'swap', partId: sibling, replaces: c.board.id }),
    ];
  },
  R32: (c) => {
    const want = c.input.firmware?.lcdPins;
    if (!want) return '固件没有声明板载屏引脚';
    const have = c.info.lcd;
    if (!have) return `${c.board.name} 没有板载屏，外接屏的引脚由其他引脚检查负责`;
    const keys = (Object.keys(want) as (keyof LcdPins)[]).filter((k) => want[k] !== have[k]);
    if (!keys.length) return '固件里的屏引脚与板载屏一致';
    const NAME: Record<keyof LcdPins, string> = { sclk: 'SCLK', mosi: 'MOSI', cs: 'CS', dc: 'DC', rst: 'RST', bl: '背光' };
    const sibling = BOARDS.find((b) => b.id !== c.board.id && b.board!.family === c.info.family && b.board!.lcd && (Object.keys(want) as (keyof LcdPins)[]).every((k) => b.board!.lcd![k] === want[k]));
    return [
      f(
        'warn',
        `固件按 ${keys.map((k) => `${NAME[k]} GPIO${want[k]}`).join('、')} 驱动板载屏，${c.board.name} 实际是 ${keys.map((k) => `${NAME[k]} GPIO${have[k]}`).join('、')}${c.info.family === 'ws-lcd128' ? '（微雪圆屏无触摸版 RST 12 / 背光 40，触摸版 RST 14 / 背光 2）' : ''}：屏会黑。改固件引脚${sibling ? `，或换 ${sibling.name}` : ''}。`,
        'LCD',
        sibling ? { action: 'swap', partId: sibling.id, replaces: c.board.id } : undefined,
      ),
    ];
  },
};

/** 板载器件独占的控制线：被外接件再用判阻断（R24） */
const EXCLUSIVE: OnboardKind[] = ['lcd', 'imu', 'touch'];

const hex = (a: number) => a.toString(16).toUpperCase().padStart(2, '0');

/** I2C 总线分组：有接线按 SDA 所接 GPIO；没接线时同一条默认总线 */
function i2cBuses(c: Ctx): Map<string, Inst[]> {
  const m = new Map<string, Inst[]>();
  for (const i of c.insts) {
    if (!i.part.i2cAddr) continue;
    let bus = '';
    if (c.wired(i)) {
      const u = c.uses.find((u) => u.inst === i && u.pin.type === 'i2c-sda');
      if (!u) continue;
      bus = `SDA=GPIO${u.gpio}`;
    }
    m.set(bus, [...(m.get(bus) ?? []), i]);
  }
  return m;
}

/** 跑全部规则（R01–R32）：每条至少一项结论，没触发的给 level='ok' */
export function evaluate(input: RuleInput): Finding[] {
  const c = makeCtx(input);
  const out: Finding[] = [];
  for (const meta of RULES) {
    const r = IMPL[meta.id](c);
    const base = { id: meta.id, title: meta.title, source: meta.source, confidence: meta.confidence };
    if (typeof r === 'string' || r.length === 0) out.push({ ...base, level: 'ok', detail: typeof r === 'string' ? r : '未发现问题' });
    else for (const x of r) out.push({ ...base, level: x.level ?? meta.level, detail: x.detail ?? '', ...(x.where ? { where: x.where } : {}), ...(x.fix ? { fix: x.fix } : {}) });
  }
  return out;
}

/** 只要触发的（block 在前） */
export function problems(input: RuleInput): Finding[] {
  const rank = { block: 0, warn: 1, ok: 2 } as const;
  return evaluate(input)
    .filter((f) => f.level !== 'ok')
    .sort((a, b) => rank[a.level] - rank[b.level]);
}

export function summary(findings: Finding[]) {
  return { block: findings.filter((f) => f.level === 'block').length, warn: findings.filter((f) => f.level === 'warn').length, ok: findings.filter((f) => f.level === 'ok').length };
}

/** 一键修：返回新的输入（不改原对象） */
export function applyFix(input: RuleInput, fix: Fix): RuleInput {
  const parts = input.parts.map((p) => ({ ...p }));
  const next: RuleInput = { ...input, parts };
  if (fix.action === 'add') {
    if (!parts.some((p) => p.partId === fix.partId)) parts.push({ partId: fix.partId, qty: 1 });
  } else if (fix.action === 'remove') {
    next.parts = parts.filter((p) => p.partId !== fix.partId && p.key !== fix.partId);
  } else {
    const old = fix.replaces;
    if (getPart(fix.partId).kind === 'board') {
      next.parts = parts.map((p) => (p.partId === (old ?? input.board) ? { ...p, partId: fix.partId } : p));
      next.board = fix.partId;
    } else if (old) {
      next.parts = parts.map((p) => (p.partId === old ? { ...p, partId: fix.partId } : p));
    } else parts.push({ partId: fix.partId, qty: 1 });
  }
  return next;
}
