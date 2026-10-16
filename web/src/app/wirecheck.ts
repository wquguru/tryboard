// 实验台接线规则检查（P0-12）：看台面上实际的线（场景推出来的 + 改接线），找出会烧东西 / 不工作的接法。
// 采购规则（catalog/rules.ts）看的是清单 + 模版接线；这里看的是实验台上的每一根线，两者共用电压约定和来源。
// 纯函数：同样的接线永远给同样的结论。
import type { PartSpec } from '../board3d';
import { RULE_BY_ID, netVolt, type Confidence } from '../catalog/rules.ts';
import { i2cBuses, partId, partInfo, type BenchWire } from './wiring.ts';
import { i2cLoad, i2cText } from './harness.ts';

export interface WireFault {
  rule: 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6';
  level: 'block' | 'warn';
  title: string;
  /** 标红的线（3D 台面里的导线 id） */
  wires: string[];
  /** 标在线上的短句 */
  short: string;
  detail: string;
  source: string;
  confidence: Confidence;
}

export const WIRE_RULES: Record<WireFault['rule'], { title: string; source: string; confidence: Confidence }> = {
  W1: { title: '输出接输出', source: 'ESP32-C3 / S3 数据手册 GPIO 驱动能力；两个推挽输出对接会短路', confidence: '数据手册' },
  W2: { title: '5 V 进了 GPIO', source: RULE_BY_ID.R17.source, confidence: RULE_BY_ID.R17.confidence },
  W3: { title: 'LED 没有限流电阻', source: '5 mm LED 规格书（20 mA 额定）；ESP32 数据手册 GPIO 驱动电流', confidence: '数据手册' },
  W4: { title: '缺地', source: '电路常识：器件和开发板不共地，信号没有参考电平', confidence: '我们的规则' },
  W5: { title: 'I2C 地址冲突', source: RULE_BY_ID.R15.source, confidence: RULE_BY_ID.R15.confidence },
  W6: { title: 'I2C 线太长', source: 'I2C 规范 UM10204 §7.1：t_r = 0.8473·R·C，400 kHz 上限 300 ns；线电容 1 pF/cm、模块 10 kΩ 上拉为估算', confidence: '必须上真机' },
};

const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

export function checkWiring(parts: PartSpec[], wires: BenchWire[]): WireFault[] {
  const out: WireFault[] = [];
  const live = wires.filter((w) => !w.missing);
  const name = (pid: string) => {
    const p = parts.find((x) => partId(x) === pid);
    return p ? partInfo(p).name : pid;
  };
  const push = (rule: WireFault['rule'], level: WireFault['level'], ws: string[], short: string, detail: string) =>
    out.push({ rule, level, title: WIRE_RULES[rule].title, wires: ws, short, detail, source: WIRE_RULES[rule].source, confidence: WIRE_RULES[rule].confidence });

  // W1：同一个 GPIO 上，零件自己往外推电平（电位器滑片等）+ 这个 GPIO 还要驱动别的负载（或两个零件都在推）
  const byNet = new Map<string, BenchWire[]>();
  for (const w of live) if (/^GPIO\d+$/.test(w.a)) byNet.set(w.a, [...(byNet.get(w.a) ?? []), w]);
  for (const [net, ws] of byNet) {
    const drivers = ws.filter((w) => w.pinRole === 'drive');
    const loads = ws.filter((w) => w.pinRole === 'load');
    if (drivers.length >= 2 || (drivers.length && loads.length))
      push('W1', 'block', [...drivers, ...loads].map((w) => w.id), `${net} 两边都在输出`, `${net} 上 ${drivers.map((w) => name(w.part)).join('、')} 在往外推电平，${loads.length ? `固件又要用 ${net} 驱动 ${loads.map((w) => name(w.part)).join('、')}` : '两个输出对接'}：一个拉高一个拉低时等于短路，GPIO 可能烧掉。分开到两个 GPIO。`);
  }

  // W2：模块供电接到 5 V，它的上拉 / 输出也跟着到 5 V，再进 GPIO
  for (const pid of new Set(live.map((w) => w.part))) {
    const own = live.filter((w) => w.part === pid);
    const vcc = own.find((w) => w.pinRole === 'power');
    const sig = own.filter((w) => (w.pinRole === 'bus' || w.pinRole === 'drive') && /^GPIO\d+$/.test(w.a));
    const v = netVolt(vcc?.a ?? null);
    if (vcc && v !== null && v > 3.6 && sig.length) push('W2', 'block', [vcc.id, ...sig.map((w) => w.id)], '5 V 进 GPIO', `${name(pid)} 的 ${vcc.pin} 接在 ${vcc.a}（${v} V），它的 ${sig.map((w) => w.pin).join(' / ')} 上拉 / 输出也是 ${v} V，直接进 ${sig.map((w) => w.a).join('、')}；ESP32 引脚不耐 5 V。改接 3V3，或加电平转换。`);
  }
  // 信号线直接插在 5 V 上（GPIO 一端改接到了 5V）
  for (const w of live) {
    if (w.pinRole === 'power' || w.pinRole === 'gnd') continue;
    const v = netVolt(w.a);
    if (v !== null && v > 3.6 && w.from && /^GPIO\d+$/.test(w.from)) push('W2', 'block', [w.id], '5 V 进 GPIO', `${name(w.part)} 的 ${w.pin} 改接到了 ${w.a}，原来是 ${w.from}。`);
  }

  // W3：LED 直接接 GPIO，没有串电阻
  for (const w of live) if (w.ohm === 0) push('W3', 'block', [w.id], '没有限流电阻', `${name(w.part)} 直接接在 ${w.a} 上：3.3 V 减去 LED 压降约 1.2 V 全落在 GPIO 内阻上，电流远超 20 mA（估算），LED 和引脚都可能坏。串一个 220 Ω–1 kΩ 电阻。`);

  // W4：零件没有接地（地线被拔了）
  for (const pid of new Set(wires.map((w) => w.part))) {
    const own = wires.filter((w) => w.part === pid);
    if (!own.some((w) => w.pinRole === 'gnd')) continue;
    if (own.some((w) => w.pinRole === 'gnd' && !w.missing && w.a === 'GND')) continue;
    const g = own.filter((w) => w.pinRole === 'gnd');
    push('W4', 'block', g.map((w) => w.id), '地线没接', `${name(pid)} 的 GND 没接到开发板 GND：没有共同的参考电平，读数乱跳或根本不工作。把地线插好。`);
  }

  // W5：同一条 I2C 总线上两个器件地址相同
  const buses = new Map<string, { pid: string; addr: number }[]>();
  for (const p of parts) if (p.type === 'oled' || p.type === 'bme280') {
    const k = `${p.sda}/${p.scl}`;
    buses.set(k, [...(buses.get(k) ?? []), { pid: partId(p), addr: p.addr }]);
  }
  for (const list of buses.values()) {
    const by = new Map<number, string[]>();
    for (const x of list) by.set(x.addr, [...(by.get(x.addr) ?? []), x.pid]);
    for (const [addr, who] of by) {
      if (who.length < 2) continue;
      const ws = live.filter((w) => who.includes(w.part) && w.pinRole === 'bus' && w.pin === 'SDA').map((w) => w.id);
      push('W5', 'block', ws, `地址 ${hex(addr)} 冲突`, `${who.map(name).join(' 和 ')} 都是 ${hex(addr)}，在同一条 SDA / SCL 上：两个器件同时应答，读数错乱。改其中一个的地址跳线（BME280 0x76 / 0x77，SSD1306 0x3C / 0x3D）。`);
    }
  }
  // W6：线太长，总线电容大，上升时间超过 I2C 规范（P2-11，估算；内核里同一个公式让读数出错 / 器件不应答）
  for (const b of i2cBuses(parts, live)) {
    const l = i2cLoad(b.wireCm, b.parts.length);
    if (l.verdict === 'ok') continue;
    push('W6', l.verdict === 'fail' ? 'block' : 'warn', b.wires, `上升 ${l.rise.toFixed(0)} ns`, `${b.parts.map(name).join('、')} 的 SDA 线一共 ${b.wireCm.toFixed(0)} cm（估算，必须上真机）：${i2cText(l)}。`);
  }
  return out;
}

/** 每根线的第一条问题（3D 标红时一根线只写一句） */
export function faultByWire(faults: WireFault[]): Map<string, WireFault> {
  const m = new Map<string, WireFault>();
  for (const f of faults) for (const w of f.wires) if (!m.has(w)) m.set(w, f);
  return m;
}
