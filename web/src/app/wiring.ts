// 实验台的接线：由场景声明（examples.json / 采购清单摆上来的 scene）推出来，再叠上"改接线"（注入的错误接线）。
// 纯函数，node --test 直接测；id 按 scene-api 约定 'wire:<板上针脚>~<零件>:<丝印>'，与 3D 台面一致。
import type { PartSpec } from '../board3d';
import { I2S_WIRING } from '../i2spins.ts';

const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

export interface PartInfo {
  name: string;
  model: string;
  iface: string;
  power: string;
}

/** 零件类型 → 中文显示名（时间线、提示条、构建树统一用这份，不让英文 type 名漏到界面上） */
export const PART_LABEL: Record<PartSpec['type'], string> = { bme280: 'BME280', oled: 'OLED', servo: '舵机', gc9a01: '圆屏', buzzer: '蜂鸣器', pot: '电位器', led: 'LED', encoder: '编码器', hcsr04: '超声波', mpu6050: 'MPU6050', qmi8658: 'QMI8658', cst816s: '触摸', max98357a: '喇叭', inmp441: '麦克风' };
export const partLabel = (type: string) => PART_LABEL[type as PartSpec['type']] ?? '零件';

export function partId(p: PartSpec) {
  return p.type === 'led' ? `led:${p.pin}` : p.type;
}

export function partInfo(p: PartSpec, ext5v = false): PartInfo {
  switch (p.type) {
    case 'bme280':
      return { name: 'BME280', model: 'Bosch BME280 模块（温度 / 湿度 / 气压）', iface: `I2C ${hex(p.addr)} · SDA GPIO${p.sda} · SCL GPIO${p.scl}`, power: '3V3' };
    case 'oled':
      return { name: 'SSD1306 OLED', model: '0.96″ 128×64 单色 OLED（SSD1306）', iface: `I2C ${hex(p.addr)} · SDA GPIO${p.sda} · SCL GPIO${p.scl}`, power: '3V3' };
    case 'servo':
      return { name: 'SG90 舵机', model: 'SG90 9 g 微型舵机，50 Hz PWM，0.5–2.5 ms → 0–180°', iface: `信号 GPIO${p.pin}`, power: ext5v ? '5V（外接 5 V 2 A）' : '5V（USB 直供）' };
    case 'gc9a01':
      return { name: 'GC9A01 圆屏', model: '1.28″ 240×240 RGB 圆屏（GC9A01）', iface: 'SPI2 · SCLK 12 · MOSI 11 · CS 10 · DC 14 · RST 13 · BL 15', power: '3V3' };
    case 'pot':
      return { name: `电位器（GPIO${p.pin}）`, model: '10 kΩ 旋钮电位器', iface: `滑片 GPIO${p.pin}（ADC）`, power: '3V3' };
    case 'led':
      return { name: `LED（GPIO${p.pin}）`, model: '5 mm LED + 220 Ω 限流电阻', iface: `GPIO${p.pin}，高电平亮`, power: '经 GPIO' };
    case 'buzzer':
      return { name: '无源蜂鸣器', model: '无源蜂鸣器模块（三针，带三极管，LEDC 方波驱动）', iface: `I/O → GPIO${p.pin}`, power: '3V3' };
    case 'encoder':
      return { name: 'EC11 旋转编码器', model: 'EC11 编码器模块（KY-040 类，每圈 20 格，A/B 正交 + 按键，板上 10 kΩ 上拉）', iface: `CLK GPIO${p.a} · DT GPIO${p.b}${p.sw !== undefined ? ` · SW GPIO${p.sw}` : ''}（S3 用 PCNT 计数）`, power: '3V3' };
    case 'hcsr04':
      return { name: 'HC-SR04 超声波', model: 'HC-SR04 超声波测距（2–400 cm，40 kHz，Echo 5 V 输出）', iface: `Trig GPIO${p.trig} · Echo GPIO${p.echo}${p.divider === false ? '（直连，5 V 进 GPIO！）' : '（经 1 kΩ / 2 kΩ 分压到约 3.3 V）'}`, power: '5V（USB 5V 轨，约 15 mA）' };
    case 'mpu6050':
      return { name: 'MPU6050 六轴', model: 'GY-521 模块（InvenSense MPU-6050：三轴加速度 + 三轴陀螺）', iface: `I2C ${hex(p.addr)} · SDA GPIO${p.sda} · SCL GPIO${p.scl}${p.int !== undefined ? ` · INT GPIO${p.int}` : ''}`, power: '3V3' };
    case 'qmi8658':
      return { name: 'QMI8658 六轴', model: 'QST QMI8658 六轴 IMU 小板', iface: `I2C ${hex(p.addr)} · SDA GPIO${p.sda} · SCL GPIO${p.scl}`, power: '3V3' };
    case 'cst816s':
      return { name: 'CST816S 触摸', model: '圆屏上的电容触摸层（海栎创 CST816S，单点 + 手势）', iface: `I2C ${hex(p.addr)} · SDA GPIO${p.sda} · SCL GPIO${p.scl} · INT GPIO${p.int}${p.rst !== undefined ? ` · RST GPIO${p.rst}` : ''}`, power: '3V3（与圆屏共用）' };
    case 'max98357a': {
      const w = I2S_WIRING.esp32s3.spk;
      return { name: 'MAX98357A 功放 + 喇叭', model: 'MAX98357A I2S D 类功放模块（3 W）+ Φ40 4 Ω 喇叭', iface: `I2S · BCLK ${w.bclk} · LRC ${w.lrc} · DIN ${w.din}`, power: '5V' };
    }
    case 'inmp441': {
      const w = I2S_WIRING.esp32s3.mic;
      return { name: 'INMP441 麦克风', model: 'INMP441 I2S 数字 MEMS 麦克风模块（24 位，L/R 接地 = 左声道）', iface: `I2S · SCK ${w.sck} · WS ${w.ws} · SD ${w.sd}`, power: '3V3' };
    }
  }
}

/** 零件针脚在电路里的角色：drive = 这根针自己往外推电平（会和 GPIO 输出打架），load = 由 GPIO 驱动，
 *  bus = 开漏总线，power / gnd = 电源 */
export type PinRole = 'drive' | 'load' | 'bus' | 'power' | 'gnd';

export interface BenchWire {
  id: string;
  /** 开发板一端（网络名：GPIOn / 3V3 / 5V / EXT5V / GND） */
  a: string;
  /** 零件一端 '<零件 id>:<丝印>' */
  b: string;
  part: string;
  pin: string;
  role: string;
  pinRole: PinRole;
  color: string;
  /** 串联限流电阻（Ω），只有 LED 有；0 = 没有电阻 */
  ohm?: number;
  /** 改接线把它拔了（台面上还画着，规则检查当它不存在） */
  missing?: boolean;
  /** 被改接过（原来接在哪） */
  from?: string;
  /** 5 V 输出经分压电阻降到 3.3 V 再进 GPIO（HC-SR04 Echo）；false = 直接接 */
  divider?: boolean;
}

/** 改接线：给规则检查造错误接线用（debug 钩子 / 以后的连线工具），按 3D 里已有导线的 id 改 */
export interface WireMods {
  /** 拔掉的线 */
  drop?: string[];
  /** 改接到另一个网络：线 id → 新网络 */
  retarget?: Record<string, string>;
  /** 去掉限流电阻的 LED（零件 id） */
  noResistor?: string[];
  /** 去掉 Echo 分压电阻的超声波（零件 id）：5 V 直接进 GPIO */
  noDivider?: string[];
}

export function wiresOf(parts: PartSpec[], ext5v = false, mods: WireMods = {}): BenchWire[] {
  const w: BenchWire[] = [];
  // 线的 id 用 3D 台面画的那一端（舵机 VCC 在台面上总是画到 5V 针；外接 5 V 时网络改成 EXT5V，id 不变）
  const add = (a: string, part: string, pin: string, role: string, pinRole: PinRole, color: string, extra: Partial<BenchWire> = {}, drawnA = a) => {
    const b = `${part}:${pin}`;
    let id = `wire:${drawnA}~${b}`;
    for (let k = 2; w.some((x) => x.id === id); k++) id = `wire:${drawnA}~${b}#${k}`;
    w.push({ id, a, b, part, pin, role, pinRole, color, ...extra });
  };
  for (const p of parts) {
    const id = partId(p);
    if (p.type === 'bme280' || p.type === 'oled') {
      add('GND', id, 'GND', '地', 'gnd', '黑');
      add('3V3', id, p.type === 'bme280' ? 'VIN' : 'VCC', '供电', 'power', '红');
      add(`GPIO${p.scl}`, id, 'SCL', 'I2C 时钟', 'bus', '黄');
      add(`GPIO${p.sda}`, id, 'SDA', 'I2C 数据', 'bus', '绿');
    } else if (p.type === 'servo') {
      add(`GPIO${p.pin}`, id, 'PWM', 'PWM 信号', 'load', '橙');
      add(ext5v ? 'EXT5V' : '5V', id, 'VCC', ext5v ? '供电（外接 5 V）' : '供电（USB 5 V）', 'power', '红', {}, '5V');
      add('GND', id, 'GND', '地', 'gnd', '黑');
    } else if (p.type === 'gc9a01') {
      add('GND', id, 'GND', '地', 'gnd', '黑');
      add('3V3', id, 'VCC', '供电', 'power', '红');
      for (const [g, n, r] of [[12, 'SCL', 'SPI SCLK'], [11, 'SDA', 'SPI MOSI'], [13, 'RES', 'LCD RST'], [14, 'DC', 'LCD DC'], [10, 'CS', 'LCD CS'], [15, 'BLK', 'LCD 背光']] as const) add(`GPIO${g}`, id, n, r, 'load', '橙');
    } else if (p.type === 'pot') {
      add('3V3', id, 'VCC', '供电', 'power', '红');
      add(`GPIO${p.pin}`, id, 'OUT', '模拟输入（滑片）', 'drive', '橙');
      add('GND', id, 'GND', '地', 'gnd', '黑');
    } else if (p.type === 'led') {
      add(`GPIO${p.pin}`, id, 'IN', '输出（经 220 Ω）', 'load', '橙', { ohm: 220 });
      add('GND', id, 'GND', '地', 'gnd', '黑');
    } else if (p.type === 'encoder') {
      // KY-040：CLK / DT 板上上拉到 "+"，触点闭合接地 → 这两根是模块往外推电平的线
      add('GND', id, 'GND', '地', 'gnd', '黑');
      add('3V3', id, '+', '供电（上拉）', 'power', '红');
      if (p.sw !== undefined) add(`GPIO${p.sw}`, id, 'SW', '按键（按下接地）', 'drive', '紫');
      add(`GPIO${p.b}`, id, 'DT', 'B 相（DT）', 'drive', '绿');
      add(`GPIO${p.a}`, id, 'CLK', 'A 相（CLK）', 'drive', '黄');
    } else if (p.type === 'hcsr04') {
      add('5V', id, 'VCC', '供电（5 V）', 'power', '红');
      add(`GPIO${p.trig}`, id, 'Trig', '触发（GPIO 输出 10 µs 高脉冲）', 'load', '橙');
      add(`GPIO${p.echo}`, id, 'Echo', p.divider === false ? '回波（5 V，直连）' : '回波（经 1k/2k 分压）', 'drive', '蓝', { divider: p.divider !== false });
      add('GND', id, 'GND', '地', 'gnd', '黑');
    } else if (p.type === 'mpu6050' || p.type === 'qmi8658') {
      add('3V3', id, p.type === 'mpu6050' ? 'VCC' : 'VIN', '供电', 'power', '红');
      add('GND', id, 'GND', '地', 'gnd', '黑');
      add(`GPIO${p.scl}`, id, 'SCL', 'I2C 时钟', 'bus', '黄');
      add(`GPIO${p.sda}`, id, 'SDA', 'I2C 数据', 'bus', '绿');
      if (p.type === 'mpu6050' && p.int !== undefined) add(`GPIO${p.int}`, id, 'INT', '数据就绪中断（模块输出）', 'drive', '青');
    } else if (p.type === 'cst816s') {
      // 触摸层的线在圆屏模组上（同一排针的后 4 针），供电与圆屏共用
      add(`GPIO${p.sda}`, id, 'TP_SDA', '触摸 I2C 数据', 'bus', '绿');
      add(`GPIO${p.scl}`, id, 'TP_SCL', '触摸 I2C 时钟', 'bus', '黄');
      add(`GPIO${p.int}`, id, 'TP_INT', '触摸中断（按着拉低）', 'drive', '青');
      add(p.rst !== undefined ? `GPIO${p.rst}` : '3V3', id, 'TP_RST', '触摸复位', p.rst !== undefined ? 'load' : 'power', '灰');
    } else if (p.type === 'buzzer') {
      // 三针模块：I/O 经模块上的三极管驱动蜂鸣器，GPIO 只推基极
      add('3V3', id, 'VCC', '供电', 'power', '红');
      add(`GPIO${p.pin}`, id, 'I/O', '方波驱动（LEDC）', 'load', '橙');
      add('GND', id, 'GND', '地', 'gnd', '黑');
    } else if (p.type === 'max98357a') {
      const s = I2S_WIRING.esp32s3.spk;
      add('5V', id, 'Vin', '供电（5 V）', 'power', '红');
      add('GND', id, 'GND', '地', 'gnd', '黑');
      add(`GPIO${s.bclk}`, id, 'BCLK', 'I2S 位时钟', 'load', '黄');
      add(`GPIO${s.lrc}`, id, 'LRC', 'I2S 声道时钟', 'load', '绿');
      add(`GPIO${s.din}`, id, 'DIN', 'I2S 数据（发）', 'load', '橙');
    } else if (p.type === 'inmp441') {
      const s = I2S_WIRING.esp32s3.mic;
      add('3V3', id, 'VDD', '供电', 'power', '红');
      add('GND', id, 'GND', '地', 'gnd', '黑');
      add('GND', id, 'L/R', '声道选择（接地 = 左）', 'gnd', '黑');
      add(`GPIO${s.sck}`, id, 'SCK', 'I2S 位时钟', 'load', '黄');
      add(`GPIO${s.ws}`, id, 'WS', 'I2S 声道时钟', 'load', '绿');
      add(`GPIO${s.sd}`, id, 'SD', 'I2S 数据（收）', 'drive', '橙');
    }
  }
  const drop = new Set(mods.drop ?? []);
  const nores = new Set(mods.noResistor ?? []);
  const nodiv = new Set(mods.noDivider ?? []);
  for (const x of w) {
    if (drop.has(x.id)) x.missing = true;
    const to = mods.retarget?.[x.id];
    if (to && to !== x.a) {
      x.from = x.a;
      x.a = to;
    }
    if (x.ohm !== undefined && nores.has(x.part)) x.ohm = 0;
    if (x.divider !== undefined && nodiv.has(x.part)) x.divider = false;
  }
  return w;
}

/** 用到的开发板针脚（构建树"引脚"分组只列这些） */
export function usedPins(wires: BenchWire[]): string[] {
  const seen = new Set<string>();
  for (const w of wires) if (!w.missing) seen.add(w.a);
  return [...seen];
}

export const emptyMods = (m: WireMods | null | undefined) => !m || (!m.drop?.length && !m.noResistor?.length && !m.noDivider?.length && !Object.keys(m.retarget ?? {}).length);
