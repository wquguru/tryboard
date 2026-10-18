// 接线错误走网络求解（P2-14）：wirecheck 给出错接的网表参数，这里交给 wasm 里的 elec 求解器（tb_fault）算电流，
// 再按数据手册门限写后果。主线程单独实例化一份 wasm，只调无状态的 tb_fault：模拟器 worker 没启动也能算，
// 同一个二进制、同样参数，结果与命令行 tools/elec 的同一电路一致。
import type { FaultEstimate, FaultNet, WireFault } from './wirecheck';

/** wasm 导出里用到的两个函数（测试里可以直接传 node 实例化的 exports） */
export interface FaultExports {
  tb_fault(kind: number, s3: number, a: number, b: number, c: number, d: number): number;
  tb_fault_out(k: number): number;
}

/** 一次求解的原始结果 */
export interface FaultRaw {
  i: number;
  vPin: number;
  v5: number;
  v33: number;
  limiter: number;
}

// 门限出处：ESP32-C3 数据手册 v2.4 表 5-4（I_OH 40 mA @ 最强驱动档、VIH 最大 VDD + 0.3 V）；
// LED 额定 20 mA 是常见 3 mm / 5 mm 红灯规格；注入电流 1 mA 是经验值（乐鑫没给钳位注入上限）
const I_OH_MAX = 0.04;
const LED_RATED = 0.02;
const INJECT_MAX = 0.001;
const VIH_MAX = 3.6;
const LIMITER = ['导线和引脚内阻', '电脑 USB 口限流', '外接电源限流', '板载 LDO 限流', '板载 LDO 掉进压差区'];

export function solveRaw(x: FaultExports, kind: number, args: number[], s3: boolean): FaultRaw {
  const [a = 0, b = 0, c = 0, d = 0] = args;
  const i = x.tb_fault(kind, s3 ? 1 : 0, a, b, c, d);
  return { i, vPin: x.tb_fault_out(0), v5: x.tb_fault_out(1), v33: x.tb_fault_out(2), limiter: x.tb_fault_out(3) };
}

const mA = (i: number) => (i >= 1 ? `${i.toFixed(2)} A` : `${(i * 1000).toFixed(i < 0.01 ? 1 : 0)} mA`);

/** 后果文字：电流 + 超了哪条门限 + 谁限住了电流 */
export function consequence(kind: number, r: FaultRaw): string {
  const I = Math.abs(r.i);
  if (kind === 1 || kind === 2) {
    const over = I > I_OH_MAX;
    return `约 ${mA(I)} 灌进引脚输出级${over ? `，超过数据手册 40 mA 上限（${(I / I_OH_MAX).toFixed(1)} 倍），持续几秒就可能烧坏这个 GPIO` : '，没超 40 mA 但两边电平打架，读到的值不可信'}；引脚被拉到 ${r.vPin.toFixed(2)} V。`;
  }
  if (kind === 3) {
    const over = I > LED_RATED;
    return `约 ${mA(I)} 流过 LED（额定约 20 mA）${over ? `，${(I / LED_RATED).toFixed(1)} 倍过流，LED 很快变暗或烧坏` : ''}${I > I_OH_MAX ? '，GPIO 也超过 40 mA 上限' : `，GPIO 输出被拉到 ${r.vPin.toFixed(2)} V、接近驱动极限`}。串 220 Ω 后约 ${mA(Math.max(0, (3.3 - 1.8) / (220 + 33 + 10)))}。`;
  }
  if (kind === 4) {
    const who = LIMITER[r.limiter] ?? '电源';
    return `约 ${mA(I)} 从电源直接流进地，由${who}限住；5V 轨掉到 ${r.v5.toFixed(2)} V、3V3 轨 ${r.v33.toFixed(2)} V，芯片欠压复位，USB 口可能断电保护，跳线和稳压器发烫。`;
  }
  if (kind === 5) {
    const harm = I > INJECT_MAX;
    return `引脚被抬到 ${r.vPin.toFixed(2)} V（上限 ${VIH_MAX} V），约 ${mA(I)} 经钳位二极管灌进 3V3 轨${harm ? '，超过约 1 mA 的经验安全值，长期会损坏引脚（乐鑫未给注入电流上限）' : '，电流不大，但仍超出耐压规格'}。`;
  }
  return '';
}

/** 一条错接的估算：每组参数解一次，取电流最大的（最坏情况） */
export function estimateNet(x: FaultExports, net: FaultNet, s3: boolean): FaultEstimate | undefined {
  let best: { r: FaultRaw; what: string } | undefined;
  for (const c of net.cases) {
    const r = solveRaw(x, net.kind, c.args, s3);
    if (!Number.isFinite(r.i)) continue;
    if (!best || Math.abs(r.i) > Math.abs(best.r.i)) best = { r, what: c.what };
  }
  if (!best) return undefined;
  return { mA: Math.round(Math.abs(best.r.i) * 1e4) / 10, what: best.what, text: consequence(net.kind, best.r) };
}

/** 同一条错接（规则 + 线 + 网表参数）只算一次 */
export const faultKey = (f: WireFault, s3: boolean) => `${s3 ? 's3' : 'c3'}|${f.rule}|${f.wires.join(',')}|${JSON.stringify(f.net ?? null)}`;

let exP: Promise<FaultExports> | null = null;
const cache = new Map<string, FaultEstimate | undefined>();

/** 已经算过的直接补上（同步，重画时不闪）；还有没算的返回 false */
export function applyCached(faults: WireFault[], s3: boolean): { faults: WireFault[]; done: boolean } {
  let done = true;
  const out = faults.map((f) => {
    if (!f.net) return f;
    const k = faultKey(f, s3);
    if (!cache.has(k)) {
      done = false;
      return f;
    }
    const e = cache.get(k);
    return e ? { ...f, estimate: e } : f;
  });
  return { faults: out, done };
}

/** 浏览器里：懒加载一份 wasm（和模拟器同一个文件，已缓存），给带网表的错接补上估算 */
export async function enrichFaults(faults: WireFault[], s3: boolean): Promise<WireFault[]> {
  if (!faults.some((f) => f.net)) return faults;
  exP ??= import('../assets').then(async ({ loadWasm }) => {
    const { instance } = await WebAssembly.instantiate(await loadWasm(), {});
    return instance.exports as unknown as FaultExports;
  });
  const x = await exP;
  for (const f of faults) if (f.net && !cache.has(faultKey(f, s3))) cache.set(faultKey(f, s3), estimateNet(x, f.net, s3));
  return applyCached(faults, s3).faults;
}
