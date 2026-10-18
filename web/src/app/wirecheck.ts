// 实验台接线规则检查（P0-12）：看台面上实际的线（场景推出来的 + 改接线），找出会烧东西 / 不工作的接法。
// 采购规则（catalog/rules.ts）看的是清单 + 模版接线；这里看的是实验台上的每一根线，两者共用电压约定和来源。
// 纯函数：同样的接线永远给同样的结论。
import type { PartSpec } from '../board3d';
import { RULE_BY_ID, netVolt, type Confidence } from '../catalog/rules.ts';
import { i2cBuses, partId, partInfo, type BenchWire } from './wiring.ts';
import { i2cLoad, i2cText } from './harness.ts';

/** 错接的网表（P2-14）：交给 elec 求解器算电流（faultsolve.ts → wasm tb_fault），kind 与 tb_fault 一致 */
export interface FaultNet {
  /** 1 零件输出对 GPIO；2 两个零件对打；3 LED 串电阻（Ω）；4 电源轨接地；5 5 V 经电阻进 GPIO（钳位） */
  kind: 1 | 2 | 3 | 4 | 5;
  /** 每组参数解一次，取电流最大的（最坏情况）；每组与 tb_fault 的 a, b, c, d 对应 */
  cases: { args: number[]; what: string }[];
}

/** 求解器给的估算（mA 与后果），到了才有 */
export interface FaultEstimate {
  mA: number;
  /** 最坏的是哪一种情况（电位器转到头……） */
  what: string;
  text: string;
}

export interface WireFault {
  rule: 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7';
  level: 'block' | 'warn';
  title: string;
  /** 标红的线（3D 台面里的导线 id） */
  wires: string[];
  /** 标在线上的短句 */
  short: string;
  detail: string;
  source: string;
  confidence: Confidence;
  net?: FaultNet;
  estimate?: FaultEstimate;
}

export const WIRE_RULES: Record<WireFault['rule'], { title: string; source: string; confidence: Confidence }> = {
  W1: { title: '输出接输出', source: 'ESP32-C3 / S3 数据手册 GPIO 驱动能力；两个推挽输出对接会短路', confidence: '数据手册' },
  W2: { title: '5 V 进 GPIO', source: RULE_BY_ID.R17.source, confidence: RULE_BY_ID.R17.confidence },
  W3: { title: 'LED 没有限流电阻', source: '5 mm LED 规格书（20 mA 额定）；ESP32 数据手册 GPIO 驱动电流', confidence: '数据手册' },
  W4: { title: '地线没接', source: '电路常识：器件和开发板不共地，信号没有参考电平', confidence: '经验规则' },
  W5: { title: 'I2C 地址冲突', source: RULE_BY_ID.R15.source, confidence: RULE_BY_ID.R15.confidence },
  W7: { title: '电源短路', source: '电路常识：电源轨直接接地；电流由 elec 求解（USB 口 500 mA 限流、板载 LDO，参数见 DECISIONS「电气模型」）', confidence: '估算' },
  W6: { title: 'I2C 线太长', source: 'I2C 规范 UM10204 §7.1：t_r = 0.8473·R·C，400 kHz 上限 300 ns；线电容 1 pF/cm、模块 10 kΩ 上拉为估算', confidence: '必须上真机' },
};

/** 零件那一端的输出能推多大电流（P2-14 求解用，估算）：hi = 推高时 [电压, 内阻 Ω]，lo = 拉低时。
 *  电位器 / 触点按最坏情况（滑片转到头、触点闭合），接触电阻 1 Ω；CMOS 推挽按与 ESP32 默认驱动档同量级 */
export function driverModel(type: string | undefined, pin: string, divider?: boolean): { hi?: [number, number]; lo?: [number, number]; what: string } {
  if (type === 'pot') return { hi: [3.3, 1], lo: [0, 1], what: '电位器滑片转到头（≈ 直接接 3V3 / GND）' };
  if (type === 'encoder') return { hi: [3.3, 10_000], lo: [0, 1], what: `编码器 ${pin} 触点闭合接地` };
  if (type === 'hcsr04') return divider === false ? { hi: [5, 50], lo: [0, 50], what: 'HC-SR04 Echo 直连（5 V 推挽，约 50 Ω）' } : { hi: [3.33, 667], lo: [0, 667], what: 'HC-SR04 Echo 经 1k / 2k 分压' };
  return { hi: [3.3, 33], lo: [0, 35.36], what: `${pin} 推挽输出` };
}

const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

export function checkWiring(parts: PartSpec[], wires: BenchWire[]): WireFault[] {
  const out: WireFault[] = [];
  const live = wires.filter((w) => !w.missing);
  const name = (pid: string) => {
    const p = parts.find((x) => partId(x) === pid);
    return p ? partInfo(p).name : pid;
  };
  const typeOf = (pid: string) => parts.find((x) => partId(x) === pid)?.type;
  const push = (rule: WireFault['rule'], level: WireFault['level'], ws: string[], short: string, detail: string, net?: FaultNet) =>
    out.push({ rule, level, title: WIRE_RULES[rule].title, wires: ws, short, detail, source: WIRE_RULES[rule].source, confidence: WIRE_RULES[rule].confidence, ...(net ? { net } : {}) });

  // W1：同一个 GPIO 上，零件自己往外推电平（电位器滑片等）+ 这个 GPIO 还要驱动别的负载（或两个零件都在推）
  const byNet = new Map<string, BenchWire[]>();
  for (const w of live) if (/^GPIO\d+$/.test(w.a)) byNet.set(w.a, [...(byNet.get(w.a) ?? []), w]);
  for (const [net, ws] of byNet) {
    const drivers = ws.filter((w) => w.pinRole === 'drive');
    const loads = ws.filter((w) => w.pinRole === 'load');
    // 求解：零件输出对 GPIO（每个推高 / 拉低的可能都算），两个零件对打时一个推高一个拉低
    const models = drivers.map((w) => driverModel(typeOf(w.part), w.pin, w.divider));
    const cases: FaultNet['cases'] = [];
    let fnet: FaultNet;
    if (loads.length) {
      for (const m of models) for (const d of [m.hi, m.lo]) if (d) cases.push({ args: d, what: `${m.what}，GPIO 输出相反电平` });
      fnet = { kind: 1, cases };
    } else {
      for (const a of models) for (const b of models) if (a !== b && a.hi && b.lo) cases.push({ args: [...a.hi, ...b.lo], what: `${a.what} 推高、${b.what} 拉低` });
      fnet = { kind: 2, cases };
    }
    if (drivers.length >= 2 || (drivers.length && loads.length))
      push('W1', 'block', [...drivers, ...loads].map((w) => w.id), `${net} 两边都在输出`, `${net} 上 ${drivers.map((w) => name(w.part)).join('、')} 都在输出电平，${loads.length ? `固件又要用 ${net} 驱动 ${loads.map((w) => name(w.part)).join('、')}` : '两个输出对接'}：一个拉高一个拉低时等于短路，GPIO 可能烧掉。分开到两个 GPIO。`, fnet);
  }

  // W2：模块供电接到 5 V，它的上拉 / 输出也跟着到 5 V，再进 GPIO
  for (const pid of new Set(live.map((w) => w.part))) {
    const own = live.filter((w) => w.part === pid);
    const vcc = own.find((w) => w.pinRole === 'power');
    // 经分压电阻降到 3.3 V 的输出不算（HC-SR04 Echo 的 1 kΩ / 2 kΩ）
    const sig = own.filter((w) => (w.pinRole === 'bus' || w.pinRole === 'drive') && /^GPIO\d+$/.test(w.a) && w.divider !== true);
    const v = netVolt(vcc?.a ?? null);
    // 求解：5 V 经模块上拉（I2C 线 10 kΩ，估算，与 W6 同）或推挽输出（同 driverModel 推高内阻）进引脚钳位二极管
    const clamp: FaultNet = {
      kind: 5,
      cases: sig.map((w) => (w.pinRole === 'bus' ? { args: [10_000], what: `${w.pin} 经模块 10 kΩ 上拉到 5 V` } : { args: [driverModel(typeOf(pid), w.pin, w.divider).hi?.[1] ?? 33], what: `${w.pin} 输出 5 V 高电平` })),
    };
    if (vcc && v !== null && v > 3.6 && sig.length) push('W2', 'block', [vcc.id, ...sig.map((w) => w.id)], '5 V 进 GPIO', `${name(pid)} 的 ${vcc.pin} 接在 ${vcc.a}（${v} V），它的 ${sig.map((w) => w.pin).join('、')} 上拉或输出也是 ${v} V，直接进 ${sig.map((w) => w.a).join('、')}；ESP32 引脚不耐 5 V。改接 3V3，或加电平转换。`, clamp);
  }
  // 信号线直接插在 5 V 上（GPIO 一端改接到了 5V）
  for (const w of live) {
    if (w.pinRole === 'power' || w.pinRole === 'gnd') continue;
    const v = netVolt(w.a);
    if (v !== null && v > 3.6 && w.from && /^GPIO\d+$/.test(w.from)) push('W2', 'block', [w.id], '5 V 进 GPIO', `${name(w.part)} 的 ${w.pin} 改接到了 ${w.a}，原来是 ${w.from}。`);
  }

  // W3：LED 直接接 GPIO，没有串电阻
  for (const w of live) if (w.ohm === 0) push('W3', 'block', [w.id], 'LED 没有限流电阻', `${name(w.part)} 直接接在 ${w.a} 上：3.3 V 减去 LED 压降，剩下约 1.2 V 全压在 GPIO 内阻上，电流远超 20 mA（估算），LED 和引脚都可能坏。串一个 220 Ω–1 kΩ 电阻。`, { kind: 3, cases: [{ args: [0], what: `${w.a} 输出高电平直接点红色 LED` }] });

  // W7：电源轨直接接地（跳线把 3V3 / 5V / 外接 5 V 插到 GND 上）
  const RAIL: Record<string, number> = { '3V3': 0, '5V': 1, EXT5V: 2 };
  for (const w of live) {
    if (w.part !== 'jumper') continue;
    const [r, g] = w.a === 'GND' ? [w.b, w.a] : [w.a, w.b];
    if (g !== 'GND' || RAIL[r] === undefined) continue;
    push('W7', 'block', [w.id], `${r} 短路到 GND`, `一根跳线把 ${r} 直接插到了 GND：电源被短路，电流只受电源自己的限流和导线电阻限制，板子会掉电复位、线和稳压器发烫。拔掉这根线。`, { kind: 4, cases: [{ args: [RAIL[r]], what: `${r} 经跳线（约 0.05 Ω）接地` }] });
  }

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
  for (const p of parts) if (p.type === 'oled' || p.type === 'bme280' || p.type === 'mpu6050' || p.type === 'qmi8658' || p.type === 'cst816s') {
    const k = `${p.sda}/${p.scl}`;
    buses.set(k, [...(buses.get(k) ?? []), { pid: partId(p), addr: p.addr }]);
  }
  for (const list of buses.values()) {
    const by = new Map<number, string[]>();
    for (const x of list) by.set(x.addr, [...(by.get(x.addr) ?? []), x.pid]);
    for (const [addr, who] of by) {
      if (who.length < 2) continue;
      const ws = live.filter((w) => who.includes(w.part) && w.pinRole === 'bus' && w.pin === 'SDA').map((w) => w.id);
      push('W5', 'block', ws, `地址 ${hex(addr)} 冲突`, `${who.map(name).join(' 和 ')} 都是 ${hex(addr)}，在同一条 SDA / SCL 上：两个器件同时应答，读数错乱。改其中一个的地址跳线（BME280 0x76 / 0x77，SSD1306 0x3C / 0x3D，MPU6050 AD0 0x68 / 0x69，QMI8658 SA0 0x6B / 0x6A）。`);
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
