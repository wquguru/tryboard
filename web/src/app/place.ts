// 台面直接放零件（P2-16）：元件库里的零件 → 逐根接线的步骤 → 场景里的 PartSpec。
// 只收"台面上已有引脚器件模型"的零件：接完线的件真的进模拟器（LED 跟着 GPIO 亮、I2C 器件能被扫到），
// 其余在元件库里灰掉并给原因，不画一个摆设。步骤里的 pin 用 wiring.ts wiresOf 的针名，
// 这样接完生成的线 id 与改接线模式、接线检查是同一套。纯函数，web/test/place.test.ts 直接测。
import type { PartSpec, SceneSpec } from '../board3d.ts';
import { getPart } from '../catalog/parts.ts';
import { partId, wiresOf, type WireMods } from './wiring.ts';

/** 这一步该点哪类开发板针：GPIO / 地 / 电源（3V3 或 5V，选错由接线检查报） */
export type Want = 'gpio' | 'gnd' | 'power';
export interface PlaceStep {
  /** wiresOf 里的针名（线 id 的一部分） */
  pin: string;
  /** 给人看的：零件上的丝印 / 线色 */
  label: string;
  want: Want;
  /** 电源针的本来接法；选了另一路电源就记成改接，接线检查照常判 */
  def?: '3V3' | '5V';
  /** 可以不接（MPU6050 的 INT、编码器的按键） */
  optional?: boolean;
}
export interface PlaceDef {
  partId: string;
  name: string;
  type: PartSpec['type'];
  steps: PlaceStep[];
}

const G = (pin: string, label = pin): PlaceStep => ({ pin, label, want: 'gpio' });
const GND = (label = 'GND'): PlaceStep => ({ pin: 'GND', label, want: 'gnd' });
const P = (pin: string, def: '3V3' | '5V', label = pin): PlaceStep => ({ pin, label, want: 'power', def });
const I2C = (vcc: string, vlabel = vcc): PlaceStep[] => [P(vcc, '3V3', vlabel), GND(), G('SCL'), G('SDA')];

const DEFS: Record<string, { type: PartSpec['type']; steps: PlaceStep[] }> = {
  'led-kit': { type: 'led', steps: [G('IN', '长脚 +（经 220 Ω）'), GND('短脚 −')] },
  button: { type: 'key', steps: [G('IN', 'A 脚'), GND('B 脚')] },
  'buzzer-module': { type: 'buzzer', steps: [P('VCC', '3V3'), G('I/O'), GND()] },
  sg90: { type: 'servo', steps: [G('PWM', '橙 PWM'), P('VCC', '5V', '红 VCC'), GND('棕 GND')] },
  mg90s: { type: 'servo', steps: [G('PWM', '橙 PWM'), P('VCC', '5V', '红 VCC'), GND('棕 GND')] },
  pot: { type: 'pot', steps: [P('VCC', '3V3', '1 脚'), G('OUT', '2 脚（滑片）'), GND('3 脚')] },
  bme280: { type: 'bme280', steps: I2C('VIN', 'VCC') },
  ssd1306: { type: 'oled', steps: I2C('VCC') },
  mpu6050: { type: 'mpu6050', steps: [...I2C('VCC'), { ...G('INT'), optional: true }] },
  qmi8658: { type: 'qmi8658', steps: I2C('VIN') },
  encoder: { type: 'encoder', steps: [GND(), P('+', '3V3'), G('CLK'), G('DT'), { ...G('SW'), optional: true }] },
  'hc-sr04': { type: 'hcsr04', steps: [P('VCC', '5V'), G('Trig'), G('Echo', 'Echo（经 1k/2k 分压）'), GND()] },
  'ws2812-stick8': { type: 'ws2812', steps: [P('5V', '5V'), G('DIN'), GND()] },
  'ws2812-strip': { type: 'ws2812', steps: [P('5V', '5V'), G('DIN'), GND()] },
};

/** 放不了的零件为什么放不了（元件库灰掉时的提示） */
const WHY: Record<string, string> = {
  gc9a01: '圆屏的引脚由固件定在 SPI2，台面上不能改接：从采购清单勾上它摆',
  'gc9a01-touch': '圆屏的引脚由固件定在 SPI2，台面上不能改接：从采购清单勾上它摆',
  max98357a: 'I2S 引脚按芯片固定：从采购清单勾上它摆',
  inmp441: 'I2S 引脚按芯片固定：从采购清单勾上它摆',
  'buzzer-passive': '台面只有三针蜂鸣器模块的模型：换「蜂鸣器模块」',
};

/** 能放：给出逐根接线的步骤；不能放：给出原因 */
export function placeDef(id: string): PlaceDef | { why: string } {
  const d = DEFS[id];
  const part = getPart(id);
  if (d) return { partId: id, name: part.name, ...d };
  if (WHY[id]) return { why: WHY[id] };
  if (part.sim.level === 'none') return { why: '没有模拟模型：放上台面也只是摆设，接线检查和固件都看不到它' };
  return { why: '台面上还没有它的引脚器件模型：先看采购里的可信度说明' };
}

/** 台面上的哪些针能接这一步（listPins 的 id：GPIOn / 3V3 / 5V / GND） */
export function pinOk(want: Want, id: string): boolean {
  if (want === 'gpio') return /^GPIO\d+$/.test(id);
  if (want === 'gnd') return id === 'GND';
  return id === '3V3' || id === '5V';
}

/** 开始放之前的冲突：同类单例件已在台面上、I2C 地址已被占 */
export function placeConflict(def: PlaceDef, scene: SceneSpec): string | null {
  if (def.type === 'led' || def.type === 'key') return null;
  const same = scene.parts.find((p) => p.type === def.type);
  if (same) return `台面上已经有一个${def.name}了（每种模块只能放一个，LED 和按键除外）`;
  const addr = getPart(def.partId).i2cAddr?.default;
  if (addr !== undefined) {
    const hit = scene.parts.find((p) => 'addr' in p && p.addr === addr);
    if (hit) return `I2C 地址 0x${addr.toString(16)} 已被台面上的 ${hit.type} 占了`;
  }
  return null;
}

const gpio = (net: string | undefined) => (net && /^GPIO(\d+)$/.test(net) ? Number(net.slice(4)) : undefined);

/** 接完的针（步骤 pin → 开发板针 id）→ 场景零件 + 电源针改接（选了不是本来那路电源） */
export function buildPlaced(def: PlaceDef, got: Record<string, string>, ext5v = false): { spec: PartSpec; retarget: Record<string, string> } {
  const g = (pin: string) => gpio(got[pin]);
  const addr = getPart(def.partId).i2cAddr?.default ?? 0;
  let spec: PartSpec;
  switch (def.type) {
    case 'led':
    case 'key':
    case 'buzzer':
    case 'servo':
    case 'pot':
      spec = { type: def.type, pin: g(def.steps.find((s) => s.want === 'gpio')!.pin)! };
      break;
    case 'ws2812':
      spec = { type: 'ws2812', pin: g('DIN')!, ...(def.partId === 'ws2812-strip' ? { n: 60 } : {}) };
      break;
    case 'bme280':
    case 'oled':
    case 'qmi8658':
      spec = { type: def.type, addr, sda: g('SDA')!, scl: g('SCL')! };
      break;
    case 'mpu6050': {
      const int = g('INT');
      spec = { type: 'mpu6050', addr, sda: g('SDA')!, scl: g('SCL')!, ...(int !== undefined ? { int } : {}) };
      break;
    }
    case 'encoder': {
      const sw = g('SW');
      spec = { type: 'encoder', a: g('CLK')!, b: g('DT')!, ...(sw !== undefined ? { sw } : {}) };
      break;
    }
    case 'hcsr04':
      // 障碍物先放在 15 cm，与采购摆上来的一致
      spec = { type: 'hcsr04', trig: g('Trig')!, echo: g('Echo')!, cm: 15 };
      break;
    default:
      throw new Error(`放不了 ${def.type}`);
  }
  const retarget: Record<string, string> = {};
  const wires = wiresOf([spec], ext5v);
  for (const s of def.steps) {
    if (s.want !== 'power' || !got[s.pin] || got[s.pin] === s.def) continue;
    const w = wires.find((x) => x.part === partId(spec) && x.pin === s.pin);
    if (w) retarget[w.id] = got[s.pin];
  }
  return { spec, retarget };
}

/** 合进现有的改接线（保留别的件的改接） */
export function mergeMods(mods: WireMods, retarget: Record<string, string>): WireMods {
  return Object.keys(retarget).length ? { ...mods, retarget: { ...mods.retarget, ...retarget } } : mods;
}
