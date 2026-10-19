// 选型引擎：纯函数，输入需求，输出推荐板子、引脚分配、物料清单、功耗估算与风险。
import { BOARDS, CHIPS, PARTS, type Board, type Cap, type Chip, type Template } from './data.ts';

export type Confidence = '仿真验证' | '行为模拟' | '估算' | '必须上真机';

export interface Need {
  caps: Cap[];
  nice: Cap[];
  parts: string[];
  battery: boolean;
  duty?: Template['duty'];
  budget?: number;
  /** 要在试板里先跑通：能仿真的芯片大幅加分（不排除，三板对比里仍列出不能仿真的板，写「用 C3 代替运行」） */
  sim?: boolean;
}

export interface PinAssign {
  label: string;
  pins: number[];
  note?: string;
}

export interface Plan {
  board: Board;
  chip: Chip;
  score: number;
  reasons: string[];
  warnings: string[];
  pins: PinAssign[];
  pinProblems: string[];
  bom: { name: string; qty: number; price: [number, number] }[];
  total: [number, number];
  power?: { avgMA: number; days: number; breakdown: string; confidence: Confidence };
  simCoverage: { part: string; level: Confidence }[];
}

export interface Rejected {
  board: Board;
  why: string;
}

const CAP_NAME: Record<Cap, string> = {
  wifi: 'Wi-Fi',
  wifi6: 'Wi-Fi 6',
  ble: 'BLE',
  bt_classic: '经典蓝牙',
  thread: 'Thread',
  zigbee: 'Zigbee',
  usb_otg: '原生 USB OTG',
  usb_serial: 'USB 串口',
  camera: '摄像头接口',
  audio_in: '数字麦克风（I2S）',
  audio_out: '音频输出（I2S）',
  display_spi: 'SPI 屏',
  display_rgb: 'RGB 并口屏',
  psram: 'PSRAM',
  ai_accel: 'AI 向量指令',
  touch: '电容触摸',
  dac: 'DAC',
  ethernet: '以太网 MAC',
  low_power: '低功耗',
  many_gpio: 'GPIO 充足',
};
export const capName = (c: Cap) => CAP_NAME[c];

function boardCaps(b: Board, c: Chip): Set<Cap> {
  const s = new Set(c.caps);
  if (b.psramMB === 0) s.delete('psram');
  // 摄像头要板上有接口（DVP 16 根线自己飞线不现实）
  if (!b.extras.some((e) => e.includes('摄像头'))) s.delete('camera');
  return s;
}

/** 引脚分配：避开 flash / PSRAM / USB / 串口 0 / 板载占用，strapping 脚最后才用并提示。 */
export function planPins(b: Board, c: Chip, parts: string[], needUsb: boolean) {
  const reserved = new Map<number, string>();
  c.pins.flash.forEach((p) => reserved.set(p, '接 flash'));
  if (b.psramMB > 0) c.pins.psramOctal?.forEach((p) => reserved.set(p, '接八线 PSRAM'));
  if (needUsb) c.pins.usb.forEach((p) => reserved.set(p, 'USB D-/D+'));
  reserved.set(c.pins.uart0[0], '串口 TX（下载和日志用）');
  reserved.set(c.pins.uart0[1], '串口 RX（下载和日志用）');
  for (const [p, why] of Object.entries(b.usedPins)) reserved.set(Number(p), why);

  // S3 编号 0–21、26–48；经典款没有 20、24、28–31
  const exists = (p: number) => {
    if (c.id === 'esp32s3') return p <= 21 || (p >= 26 && p <= 48);
    if (c.id === 'esp32') return p <= 39 && ![20, 24, 28, 29, 30, 31].includes(p);
    return p < c.gpio;
  };
  // 小板只引出部分引脚：按丝印顺序排，I2C 等先拿到板子惯用的位置
  const candidates = b.exposed ?? Array.from({ length: 55 }, (_, i) => i);
  const free = candidates.filter((p) => exists(p) && !reserved.has(p));
  const strap = new Set(c.pins.strapping);
  const usable = [...free.filter((p) => !strap.has(p)), ...free.filter((p) => strap.has(p))];
  const used = new Set<number>();
  const take = (n: number, pool: number[], outputOk = true): number[] | null => {
    const got: number[] = [];
    for (const p of pool) {
      if (got.length === n) break;
      if (used.has(p)) continue;
      if (outputOk && c.pins.inputOnly?.includes(p)) continue;
      got.push(p);
    }
    if (got.length < n) return null;
    got.forEach((p) => used.add(p));
    return got;
  };
  const out: PinAssign[] = [];
  const problems: string[] = [];
  let i2c: number[] | null = null;
  let spi: number[] | null = null;
  let i2s: number[] | null = null;
  for (const id of parts) {
    const part = PARTS[id];
    for (const n of part.needs) {
      if (n.kind === 'camera') {
        if (b.extras.some((e) => e.includes('摄像头'))) out.push({ label: part.name, pins: [], note: '板载摄像头接口' });
        else problems.push(`${part.name}：这块板没有摄像头接口`);
        continue;
      }
      if (n.kind === 'usb') continue;
      if (n.kind === 'i2c') {
        if (!i2c && b.i2cPins && b.i2cPins.every((p) => !used.has(p) && !reserved.has(p))) {
          i2c = [...b.i2cPins];
          i2c.forEach((p) => used.add(p));
        }
        i2c ??= take(2, usable);
        if (!i2c) problems.push(`${n.label}：引脚不够`);
        else out.push({ label: `${n.label}（I2C SDA / SCL，共用总线）`, pins: i2c });
        continue;
      }
      if (n.kind === 'spi') {
        spi ??= take(3, usable);
        if (!spi) problems.push(`${n.label}：引脚不够`);
        else out.push({ label: `${n.label}（SPI SCK / MOSI / CS）`, pins: spi });
        continue;
      }
      if (n.kind === 'i2s') {
        // 麦克风和功放可以共用 BCLK / WS，各自一根数据线
        if (!i2s) {
          i2s = take(2, usable);
          if (!i2s) {
            problems.push(`${n.label}：引脚不够`);
            continue;
          }
        }
        const d = take(1, usable);
        if (!d) problems.push(`${n.label}：引脚不够`);
        else out.push({ label: `${n.label}（I2S BCLK / WS / 数据）`, pins: [...i2s, ...d] });
        continue;
      }
      const pool = n.kind === 'adc' ? c.pins.adc1.filter((p) => !reserved.has(p) && (!b.exposed || b.exposed.includes(p))) : usable;
      const got = take(n.count ?? 1, pool, n.kind !== 'adc');
      if (!got) problems.push(`${n.label}：${n.kind === 'adc' ? '没有空闲的 ADC1 引脚' : '引脚不够'}`);
      else
        out.push({
          label: n.label,
          pins: got,
          note: got.some((p) => strap.has(p)) ? '用到了 strapping 脚：上电时外部电路把它拉错电平，板子就进不了正常启动' : undefined,
        });
    }
  }
  return { pins: out, problems, reserved };
}

function estimatePower(b: Board, c: Chip, parts: string[], duty: NonNullable<Template['duty']>, capacity = 1000) {
  // 工作期：Wi-Fi 连接 + 发送的平均电流约在接收电流与发射峰值之间，取 RX + 15% × (TX - RX)
  const radio = duty.wifi ? c.power.rx + 0.15 * (c.power.txPeak - c.power.rx) : c.power.modemSleep;
  const periph = parts.reduce((s, id) => s + (PARTS[id].activeMA ?? 0), 0);
  const activeMA = radio + Math.min(periph, 200);
  const activeFrac = (duty.wakePerHour * duty.activeSec) / 3600;
  const sleepMA = b.boardSleepUA / 1000;
  const avg = activeFrac * activeMA + (1 - activeFrac) * sleepMA;
  const days = (capacity * 0.85) / avg / 24;
  return {
    avgMA: avg,
    days,
    breakdown: `${(activeFrac * 100).toFixed(2)}% 时间工作，约 ${activeMA.toFixed(0)}mA；其余时间深睡，整板约 ${b.boardSleepUA}µA`,
    confidence: '估算' as Confidence,
  };
}

export function recommend(need: Need): { plans: Plan[]; rejected: Rejected[] } {
  const plans: Plan[] = [];
  const rejected: Rejected[] = [];
  const partCaps = need.parts.flatMap((p) => PARTS[p].caps ?? []);
  const required = Array.from(new Set([...need.caps, ...partCaps]));
  for (const b of BOARDS) {
    const c = CHIPS.find((x) => x.id === b.chip)!;
    const caps = boardCaps(b, c);
    const missing = required.filter((k) => k !== 'low_power' && !caps.has(k));
    if (missing.length) {
      rejected.push({ board: b, why: `缺少${missing.map(capName).join('、')}` });
      continue;
    }
    const reasons: string[] = [];
    const warnings: string[] = [...b.caveats];
    let score = 50;
    const niceHit = need.nice.filter((k) => caps.has(k));
    if (niceHit.length) {
      score += niceHit.length * 8;
      reasons.push(`额外支持${niceHit.map(capName).join('、')}`);
    }
    if (need.battery || need.caps.includes('low_power')) {
      if (b.battery) {
        score += 20;
        reasons.push(`板载锂电池充电，整板深睡约 ${b.boardSleepUA}µA`);
      } else {
        score -= Math.min(30, b.boardSleepUA / 50);
        warnings.push(`整板深睡约 ${b.boardSleepUA >= 1000 ? (b.boardSleepUA / 1000).toFixed(0) + 'mA' : b.boardSleepUA + 'µA'}，电池撑不久`);
      }
    }
    const midPrice = (b.priceCNY[0] + b.priceCNY[1]) / 2;
    score -= midPrice / 6;
    if (c.simulated === 'full') {
      score += 6;
      reasons.push('这颗芯片支持完整仿真，购买前可在线运行');
    } else if (c.simulated === 'partial') {
      score += 3;
    }
    if (need.sim && c.simulated !== 'none') score += 40;
    if (required.includes('usb_otg')) reasons.push('原生 USB OTG：可以冒充键盘、网卡、U 盘');
    if (required.includes('psram')) reasons.push(`${b.psramMB}MB PSRAM，放得下音频和图像缓冲`);
    const { pins, problems } = planPins(b, c, need.parts, required.includes('usb_otg'));
    if (problems.length) score -= 25;
    const bom = [
      { name: b.name, qty: 1, price: b.priceCNY },
      ...need.parts.map((id) => ({ name: PARTS[id].name, qty: 1, price: PARTS[id].priceCNY })),
      // 电池供电时锂电池也要买（模板里的 battery 不进引脚分配，所以 needOf 把它从 parts 拿掉了，这里补回清单）
      ...(need.battery && !need.parts.includes('battery') ? [{ name: PARTS.battery.name, qty: 1, price: PARTS.battery.priceCNY }] : []),
      { name: '面包板和杜邦线', qty: 1, price: [8, 15] as [number, number] },
      { name: '能传数据的 Type-C 线', qty: 1, price: [5, 15] as [number, number] },
    ];
    const total: [number, number] = [bom.reduce((s, x) => s + x.price[0], 0), bom.reduce((s, x) => s + x.price[1], 0)];
    if (need.budget && total[0] > need.budget) score -= 20;
    const power = need.duty ? estimatePower(b, c, need.parts, need.duty) : undefined;
    const simCoverage = need.parts.map((id) => ({
      part: PARTS[id].name,
      level: (c.simulated === 'none' ? '必须上真机' : PARTS[id].simulated === 'full' ? '仿真验证' : PARTS[id].simulated === 'partial' ? '行为模拟' : '必须上真机') as Confidence,
    }));
    for (const n of c.notes) if (required.some((k) => n.includes(capName(k)))) warnings.push(n);
    plans.push({ board: b, chip: c, score, reasons, warnings, pins, pinProblems: problems, bom, total, power, simCoverage });
  }
  plans.sort((a, b) => b.score - a.score);
  return { plans, rejected };
}
